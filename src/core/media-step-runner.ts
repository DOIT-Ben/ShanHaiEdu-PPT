import { CONTRACT_VERSION, type AgentEvent } from '../contracts'
import {
  type AgentRepository,
  BudgetReservationError,
  type BudgetPort,
  type ClockPort,
  type ImageGenerationPort,
  MediaSubmissionError,
  type RunRecord,
  type StepRecord,
} from './ports'
import { hashInput } from './hash'
import { releaseBudget, reserveBudget, transitionRun } from './policy'

export type SubmitSlideImageInput = Readonly<{
  runId: string
  stepId: string
  idempotencyKey: string
  slideId: string
  versionId: string
  prompt: string
  negativePrompt?: string
  model: string
  budgetUnits: number
  aspectRatio?: '16:9' | '4:3' | '1:1' | '3:4'
  backgroundMode?: 'OPAQUE' | 'TRANSPARENT'
  elementId?: string
  assetReuseKey?: string
}>

export type SubmitSlideImageResult = Readonly<{
  step: StepRecord
  replayed: boolean
}>

export type RefreshSlideImageResult = Readonly<{
  step: StepRecord
  changed: boolean
}>

function mergePolicy(run: RunRecord, policy: ReturnType<typeof reserveBudget>, updatedAt: string): RunRecord {
  return { ...run, ...policy, updatedAt }
}

export class MediaStepRunner {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    budget: BudgetPort
    images: ImageGenerationPort
    clock: ClockPort
  }>) {}

  async submitSlideImage(input: SubmitSlideImageInput): Promise<SubmitSlideImageResult> {
    const prepared = await this.prepare(input)
    if (prepared.replayed) return prepared

    if (prepared.step.status === 'RELEASING') {
      if (prepared.step.budgetReservationId) {
        await this.dependencies.budget.release({
          host: prepared.run.host,
          reservationId: prepared.step.budgetReservationId,
          idempotencyKey: `release:${input.idempotencyKey}`,
        })
      }
      const step = await this.markDefiniteFailure(
        input,
        prepared.step.budgetReservationId,
        prepared.step.errorCode ?? 'MEDIA_NOT_SUBMITTED',
      )
      return { step, replayed: false }
    }

    let reservationId = prepared.step.budgetReservationId
    if (!reservationId) {
      try {
        const reservation = await this.dependencies.budget.reserve({
          host: prepared.run.host,
          units: input.budgetUnits,
          idempotencyKey: input.idempotencyKey,
        })
        reservationId = reservation.reservationId
      } catch (error) {
        const errorCode = error instanceof BudgetReservationError ? error.code : 'BUDGET_RESERVATION_UNKNOWN'
        if (error instanceof BudgetReservationError && error.reservationState === 'NOT_RESERVED') {
          const step = await this.markDefiniteFailure(input, null, errorCode)
          return { step, replayed: false }
        }
        const step = await this.markUnknown(input, null, errorCode, 'BUDGET')
        return { step, replayed: false }
      }
    }

    try {
      await this.markSubmitting(input, reservationId)
      const submitted = await this.dependencies.images.submit({
        tenantId: prepared.run.host.tenantId,
        prompt: input.prompt,
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
        model: input.model,
        aspectRatio: input.aspectRatio ?? '16:9',
        ...(input.backgroundMode ? { backgroundMode: input.backgroundMode } : {}),
        idempotencyKey: input.idempotencyKey,
      })
      const step = await this.markWaiting(input, reservationId, submitted.operationId)
      return { step, replayed: false }
    } catch (error) {
      const submissionState = error instanceof MediaSubmissionError ? error.submissionState : 'UNKNOWN'
      const errorCode = error instanceof MediaSubmissionError ? error.code : 'MEDIA_SUBMISSION_UNKNOWN'
      if (submissionState === 'NOT_SUBMITTED' && reservationId) {
        await this.markReleasing(input, reservationId, errorCode)
        await this.dependencies.budget.release({
          host: prepared.run.host,
          reservationId,
          idempotencyKey: `release:${input.idempotencyKey}`,
        })
        const step = await this.markDefiniteFailure(input, reservationId, errorCode)
        return { step, replayed: false }
      }

      const step = await this.markUnknown(input, reservationId, errorCode, 'MEDIA')
      return { step, replayed: false }
    }
  }

  async refreshSlideImage(runId: string, idempotencyKey: string): Promise<RefreshSlideImageResult> {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    const step = (await this.dependencies.repository.listSteps(runId))
      .find((candidate) => candidate.idempotencyKey === idempotencyKey)
    if (!step || step.tool !== 'generate_slide_image') throw new Error('STEP_NOT_FOUND')
    if (step.status !== 'WAITING') return { step, changed: false }
    if (!step.externalOperationId) throw new Error('MEDIA_OPERATION_ID_MISSING')

    const status = await this.dependencies.images.inspect({
      tenantId: run.host.tenantId,
      operationId: step.externalOperationId,
    })
    if (status.state === 'QUEUED' || status.state === 'PROCESSING') return { step, changed: false }
    if (status.state === 'COMPLETED') {
      return { step: await this.markCompleted(runId, idempotencyKey, status.artifactId), changed: true }
    }
    if (status.state !== 'FAILED') return { step, changed: false }
    if (status.billingState === 'NOT_CHARGED' && step.budgetReservationId) {
      const input = this.reconstructInput(step)
      await this.markReleasing(input, step.budgetReservationId, status.errorCode)
      await this.dependencies.budget.release({
        host: run.host,
        reservationId: step.budgetReservationId,
        idempotencyKey: `release:${idempotencyKey}`,
      })
      return {
        step: await this.markDefiniteFailure(input, step.budgetReservationId, status.errorCode),
        changed: true,
      }
    }
    return {
      step: await this.markResultFailure(runId, idempotencyKey, status.errorCode, status.billingState),
      changed: true,
    }
  }

  async reconcilePendingRun(runId: string) {
    const pending = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && step.status === 'WAITING')
    let changed = 0
    for (const step of pending) {
      if ((await this.refreshSlideImage(runId, step.idempotencyKey)).changed) changed += 1
    }
    return { inspected: pending.length, changed }
  }

  private async prepare(input: SubmitSlideImageInput): Promise<{
    run: RunRecord
    step: StepRecord
    replayed: boolean
  }> {
    const inputHash = hashInput({
      tool: 'generate_slide_image',
      slideId: input.slideId,
      versionId: input.versionId,
      prompt: input.prompt,
      model: input.model,
      aspectRatio: input.aspectRatio ?? '16:9',
      ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
      ...(input.backgroundMode ? { backgroundMode: input.backgroundMode } : {}),
      ...(input.elementId ? { elementId: input.elementId } : {}),
      ...(input.assetReuseKey ? { assetReuseKey: input.assetReuseKey } : {}),
      budgetUnits: input.budgetUnits,
    })
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(input.idempotencyKey)
      if (existing) {
        if (existing.id !== input.stepId || existing.inputHash !== inputHash || existing.tool !== 'generate_slide_image') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        if (['WAITING', 'COMPLETED', 'FAILED', 'RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN',
          'COMPLETED_AFTER_CANCEL', 'FAILED_NOT_CHARGED', 'FAILED_CHARGED', 'BILLING_UNKNOWN'].includes(existing.status)) {
          return { run: transaction.run, step: existing, replayed: true as const }
        }
        return { run: transaction.run, step: existing, replayed: false as const }
      }

      const now = this.dependencies.clock.now().toISOString()
      const policy = reserveBudget(transaction.run, input.budgetUnits)
      const run = mergePolicy(transaction.run, policy, now)
      const step: StepRecord = {
        id: input.stepId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        inputHash,
        tool: 'generate_slide_image',
        status: 'RESERVED',
        budgetUnits: input.budgetUnits,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: {
          slideId: input.slideId,
          versionId: input.versionId,
          ...(input.elementId ? { elementId: input.elementId } : {}),
          ...(input.assetReuseKey ? { assetReuseKey: input.assetReuseKey } : {}),
        },
        createdAt: now,
        updatedAt: now,
      }
      transaction.putRun(run)
      transaction.putStep(step)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.started',
        payload: { stepId: input.stepId, tool: step.tool, label: '生成页面视觉素材' },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'budget.updated',
        payload: { budgetUnits: run.budgetUnits, committedBudgetUnits: run.committedBudgetUnits },
      })
      return { run, step, replayed: false as const }
    })
  }

  private async markSubmitting(input: SubmitSlideImageInput, reservationId: string) {
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (['WAITING', 'COMPLETED'].includes(step.status)) return
      transaction.putStep({
        ...step,
        status: 'SUBMITTING',
        budgetReservationId: reservationId,
        updatedAt: this.dependencies.clock.now().toISOString(),
      })
    })
  }

  private async markWaiting(input: SubmitSlideImageInput, reservationId: string, operationId: string) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'WAITING' && step.externalOperationId === operationId) return step
      const updated: StepRecord = {
        ...step,
        status: 'WAITING',
        budgetReservationId: reservationId,
        externalOperationId: operationId,
        errorCode: null,
        output: {
          slideId: input.slideId,
          versionId: input.versionId,
          ...(input.elementId ? { elementId: input.elementId } : {}),
          ...(input.assetReuseKey ? { assetReuseKey: input.assetReuseKey } : {}),
        },
        updatedAt: this.dependencies.clock.now().toISOString(),
      }
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.progress',
        payload: { stepId: step.id, completed: 0, total: 1, summary: '页面图片任务已安全提交，等待生成完成' },
      })
      return updated
    })
  }

  private reconstructInput(step: StepRecord): SubmitSlideImageInput {
    const output = step.output as { slideId?: unknown; versionId?: unknown } | null
    if (!output || typeof output.slideId !== 'string' || typeof output.versionId !== 'string') {
      throw new Error('MEDIA_STEP_OUTPUT_INVALID')
    }
    return {
      runId: step.runId,
      stepId: step.id,
      idempotencyKey: step.idempotencyKey,
      slideId: output.slideId,
      versionId: output.versionId,
      prompt: '',
      model: '',
      budgetUnits: step.budgetUnits,
    }
  }

  private async markCompleted(runId: string, idempotencyKey: string, artifactId: string) {
    return this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED' || step.status === 'COMPLETED_AFTER_CANCEL') return step
      const output = step.output && typeof step.output === 'object' ? step.output : {}
      const completedAfterCancel = transaction.run.status === 'CANCELLED'
      const updated: StepRecord = {
        ...step,
        status: completedAfterCancel ? 'COMPLETED_AFTER_CANCEL' : 'COMPLETED',
        output: { ...output, artifactId },
        errorCode: null,
        updatedAt: this.dependencies.clock.now().toISOString(),
      }
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: {
          stepId: step.id,
          summary: completedAfterCancel
            ? '任务取消后 Provider 仍完成，产物已保留并进入最终对账'
            : '页面图片生成完成并已保存受控产物',
        },
      })
      return updated
    })
  }

  private async markResultFailure(
    runId: string,
    idempotencyKey: string,
    errorCode: string,
    billingState: 'NOT_CHARGED' | 'CHARGED' | 'UNKNOWN',
  ) {
    return this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const cancelled = transaction.run.status === 'CANCELLED'
      const policy = cancelled || transaction.run.status === 'NEEDS_HUMAN'
        ? transaction.run
        : transitionRun(transaction.run, 'NEEDS_HUMAN')
      const run: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updated: StepRecord = {
        ...step,
        status: cancelled
          ? billingState === 'CHARGED' ? 'FAILED_CHARGED'
            : billingState === 'NOT_CHARGED' ? 'FAILED_NOT_CHARGED' : 'BILLING_UNKNOWN'
          : 'FAILED',
        errorCode,
        updatedAt: now,
      }
      transaction.putRun(run)
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: {
          stepId: step.id,
          errorCode: (updated.status === 'FAILED_CHARGED' ? `FAILED_CHARGED:${errorCode}`
            : updated.status === 'FAILED_NOT_CHARGED' ? `FAILED_NOT_CHARGED:${errorCode}`
              : updated.status === 'BILLING_UNKNOWN' ? `BILLING_UNKNOWN:${errorCode}` : errorCode).slice(0, 100),
          retryable: false,
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: `${step.id}:provider-result`,
          category: 'PROVIDER_RESULT_FAILED',
          severity: 'CRITICAL',
          summary: billingState === 'CHARGED'
            ? '图片任务失败但 Provider 已计费，需要人工核对产物和费用归属。'
            : billingState === 'NOT_CHARGED'
              ? '图片任务失败且 Provider 明确未计费，但本地没有可释放的预留记录，需要人工核对。'
              : '图片任务失败且费用状态未知，需要人工核对。',
          slideIds: [],
          sourceChunkIds: [],
          status: 'OPEN',
        },
      })
      return updated
    })
  }

  private async markReleasing(input: SubmitSlideImageInput, reservationId: string, errorCode: string) {
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      transaction.putStep({
        ...step,
        status: 'RELEASING',
        budgetReservationId: reservationId,
        errorCode,
        updatedAt: this.dependencies.clock.now().toISOString(),
      })
    })
  }

  private async markDefiniteFailure(input: SubmitSlideImageInput, reservationId: string | null, errorCode: string) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const policy = releaseBudget(transaction.run, input.budgetUnits)
      const run = mergePolicy(transaction.run, policy, now)
      const updated: StepRecord = {
        ...step,
        status: transaction.run.status === 'CANCELLED' ? 'FAILED_NOT_CHARGED' : 'FAILED',
        budgetReservationId: reservationId,
        errorCode,
        updatedAt: now,
      }
      transaction.putRun(run)
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: {
          stepId: step.id,
          errorCode: (updated.status === 'FAILED_NOT_CHARGED' ? `FAILED_NOT_CHARGED:${errorCode}` : errorCode).slice(0, 100),
          retryable: false,
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'budget.updated',
        payload: { budgetUnits: run.budgetUnits, committedBudgetUnits: run.committedBudgetUnits },
      })
      return updated
    })
  }

  private async markUnknown(
    input: SubmitSlideImageInput,
    reservationId: string | null,
    errorCode: string,
    kind: 'BUDGET' | 'MEDIA',
  ) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const policy = transaction.run.status === 'NEEDS_HUMAN'
        ? transaction.run
        : transitionRun(transaction.run, 'NEEDS_HUMAN')
      const run: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updated: StepRecord = {
        ...step,
        status: kind === 'BUDGET' ? 'RESERVATION_UNKNOWN' : 'SUBMISSION_UNKNOWN',
        budgetReservationId: reservationId,
        errorCode,
        updatedAt: now,
      }
      transaction.putRun(run)
      transaction.putStep(updated)
      const issueId = `${input.stepId}:submission-unknown`
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: issueId,
          category: kind === 'BUDGET' ? 'BUDGET_RESERVATION_UNKNOWN' : 'PROVIDER_SUBMISSION_UNKNOWN',
          severity: 'CRITICAL',
          summary: kind === 'BUDGET'
            ? '宿主额度预留状态未知，已停止媒体提交并保留 Agent 预算占用。'
            : '图片任务提交状态未知，已停止自动重试并保留预算占用。',
          slideIds: [],
          sourceChunkIds: [],
          status: 'OPEN',
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: transaction.run.status, to: 'NEEDS_HUMAN', reason: errorCode },
      })
      return updated
    })
  }
}

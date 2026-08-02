import { CONTRACT_VERSION } from '../contracts'
import { mapWithConcurrency } from './concurrency'
import {
  type AgentRepository,
  BudgetReservationError,
  type BudgetPort,
  type ClockPort,
  type ImageGenerationPort,
  MediaSubmissionError,
  type RunRecord,
  type StepRecord,
  type StepStatus,
} from './ports'
import { hashInput } from './hash'
import { isPendingMediaReconciliationStep } from './media-reconciliation'
import { releaseBudget, reserveBudget, transitionRun } from './policy'
import { appendFixedIssueResolutions } from './v4-lifecycle'
import { recoverV4AfterMediaRecovery } from './v4-media-recovery'
import { beginTechnicalRecovery, isTechnicalFailureCode } from './technical-recovery'

const MEDIA_FAILURE_STEP_STATUSES = new Set<StepStatus>([
  'FAILED',
  'RESERVATION_UNKNOWN',
  'SUBMISSION_UNKNOWN',
  'FAILED_NOT_CHARGED',
  'FAILED_CHARGED',
  'BILLING_UNKNOWN',
])

function submissionLookupRetryDelayMs(attempt: number) {
  return [2_000, 10_000, 30_000, 60_000, 60_000][Math.max(0, Math.min(4, attempt - 1))]!
}

export function isMediaFailureStepStatus(status: StepStatus) {
  return MEDIA_FAILURE_STEP_STATUSES.has(status)
}

export type SubmitSlideImageInput = Readonly<{
  runId: string
  stepId: string
  idempotencyKey: string
  /** Internal accounting key. Provider submission always uses idempotencyKey above. */
  budgetReservationKey?: string
  /** V4 initial generation uses one reservation owned by GenerationBatch. */
  batchReservation?: Readonly<{ batchId: string; reservationId: string }>
  slideId: string
  versionId: string
  prompt: string
  negativePrompt?: string
  model: string
  budgetUnits: number
  aspectRatio?: '16:9' | '4:3' | '1:1' | '3:4'
  backgroundMode?: 'OPAQUE' | 'TRANSPARENT'
  referenceImage?: Readonly<{
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
    bytes: Uint8Array
    sha256: string
  }>
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

function budgetReservationKey(input: Pick<SubmitSlideImageInput, 'idempotencyKey' | 'budgetReservationKey'>) {
  return input.budgetReservationKey ?? input.idempotencyKey
}

function isBatchReserved(input: SubmitSlideImageInput) {
  return input.batchReservation !== undefined
}

function mergePolicy(run: RunRecord, policy: ReturnType<typeof reserveBudget>, updatedAt: string): RunRecord {
  return { ...run, ...policy, updatedAt }
}

export class MediaStepRunner {
  private readonly inspectionConcurrency: number

  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    budget: BudgetPort
    images: ImageGenerationPort
    clock: ClockPort
    inspectionConcurrency?: number
  }>) {
    this.inspectionConcurrency = dependencies.inspectionConcurrency ?? 1
    if (!Number.isSafeInteger(this.inspectionConcurrency) || this.inspectionConcurrency < 1 || this.inspectionConcurrency > 50) {
      throw new Error('IMAGE_CONCURRENCY_INVALID')
    }
  }

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
    if (!reservationId && !isBatchReserved(input)) {
      try {
        const reservation = await this.dependencies.budget.reserve({
          host: prepared.run.host,
          model: input.model,
          units: input.budgetUnits,
          idempotencyKey: budgetReservationKey(input),
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
    if (!reservationId) throw new Error('BATCH_BUDGET_RESERVATION_MISSING')

    try {
      await this.markSubmitting(input, reservationId)
      const submitted = await this.dependencies.images.submit({
        tenantId: prepared.run.host.tenantId,
        prompt: input.prompt,
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
        model: input.model,
        aspectRatio: input.aspectRatio ?? '16:9',
        ...(input.backgroundMode ? { backgroundMode: input.backgroundMode } : {}),
        ...(input.referenceImage ? { referenceImage: input.referenceImage } : {}),
        idempotencyKey: input.idempotencyKey,
      })
      const step = await this.markWaiting(input, reservationId, submitted.operationId)
      return { step, replayed: false }
    } catch (error) {
      const submissionState = error instanceof MediaSubmissionError ? error.submissionState : 'UNKNOWN'
      const errorCode = error instanceof MediaSubmissionError ? error.code : 'MEDIA_SUBMISSION_UNKNOWN'
      if (submissionState === 'NOT_SUBMITTED' && reservationId && !isBatchReserved(input)) {
        await this.markReleasing(input, reservationId, errorCode)
        await this.dependencies.budget.release({
          host: prepared.run.host,
          reservationId,
          idempotencyKey: `release:${budgetReservationKey(input)}`,
        })
        const step = await this.markDefiniteFailure(input, reservationId, errorCode)
        return { step, replayed: false }
      }

      if (submissionState === 'NOT_SUBMITTED' && reservationId) {
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
    if (step.status === 'RELEASING') {
      if (!step.budgetReservationId) throw new Error('BUDGET_RESERVATION_ID_MISSING')
      await this.dependencies.budget.release({
          host: run.host,
          reservationId: step.budgetReservationId,
          idempotencyKey: `release:${budgetReservationKey(this.reconstructInput(step, run.imageModel))}`,
      })
      return {
        step: await this.markDefiniteFailure(
          this.reconstructInput(step, run.imageModel),
          step.budgetReservationId,
          step.errorCode ?? 'MEDIA_NOT_SUBMITTED',
        ),
        changed: true,
      }
    }
    if (['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(step.status) && !step.externalOperationId) {
      return this.recoverUnacknowledgedSubmission(run, step)
    }
    if (!['WAITING', 'BILLING_UNKNOWN'].includes(step.status)) return { step, changed: false }
    if (!step.externalOperationId) throw new Error('MEDIA_OPERATION_ID_MISSING')
    if (this.nextInspectionAt(step) > this.dependencies.clock.now().getTime()) return { step, changed: false }

    const mediaInput = this.reconstructInput(step, run.imageModel)
    const status = await this.dependencies.images.inspect({
      tenantId: run.host.tenantId,
      operationId: step.externalOperationId,
      idempotencyKey,
      ...(mediaInput.backgroundMode ? { backgroundMode: mediaInput.backgroundMode } : {}),
    })
    if (status.state === 'QUEUED' || status.state === 'PROCESSING') {
      if (!status.retryAfterMs) return { step, changed: false }
      return { step: await this.deferInspection(runId, idempotencyKey, status.retryAfterMs), changed: true }
    }
    if (status.state === 'COMPLETED') {
      if (!step.budgetReservationId) throw new Error('BUDGET_RESERVATION_ID_MISSING')
      if (!isBatchReserved(mediaInput)) {
        await this.dependencies.budget.settle({
          host: run.host,
          reservationId: step.budgetReservationId,
          idempotencyKey: `settle:${budgetReservationKey(mediaInput)}`,
        })
      }
      return { step: await this.markCompleted(runId, idempotencyKey, status.artifactId), changed: true }
    }
    if (status.state !== 'FAILED') return { step, changed: false }
    if (status.billingState === 'NOT_CHARGED' && step.budgetReservationId && !isBatchReserved(mediaInput)) {
      const input = this.reconstructInput(step, run.imageModel)
      await this.markReleasing(input, step.budgetReservationId, status.errorCode)
      await this.dependencies.budget.release({
        host: run.host,
        reservationId: step.budgetReservationId,
        idempotencyKey: `release:${budgetReservationKey(input)}`,
      })
      return {
        step: await this.markDefiniteFailure(input, step.budgetReservationId, status.errorCode),
        changed: true,
      }
    }
    if (status.billingState === 'NOT_CHARGED') {
      return {
        step: await this.markDefiniteFailure(mediaInput, step.budgetReservationId, status.errorCode),
        changed: true,
      }
    }
    if (status.billingState === 'CHARGED') {
      if (!step.budgetReservationId) throw new Error('BUDGET_RESERVATION_ID_MISSING')
      if (!isBatchReserved(mediaInput)) {
        await this.dependencies.budget.settle({
          host: run.host,
          reservationId: step.budgetReservationId,
          idempotencyKey: `settle:${budgetReservationKey(mediaInput)}`,
        })
      }
    }
    return {
      step: await this.markResultFailure(runId, idempotencyKey, status.errorCode, status.billingState),
      changed: true,
    }
  }

  async reconcilePendingRun(runId: string) {
    const pending = (await this.dependencies.repository.listSteps(runId))
      .filter(isPendingMediaReconciliationStep)
    const results = await mapWithConcurrency(pending, this.inspectionConcurrency, (step) =>
      this.refreshSlideImage(runId, step.idempotencyKey))
    const changed = results.filter((result) => result.changed).length
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
      ...(input.referenceImage ? { referenceImageSha256: input.referenceImage.sha256 } : {}),
      budgetUnits: input.budgetUnits,
    })
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(input.idempotencyKey)
      if (existing) {
        if (existing.id !== input.stepId || existing.inputHash !== inputHash || existing.tool !== 'generate_slide_image') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        const canRetryReleasedV4Submission = existing.status === 'FAILED'
          && transaction.run.presentationMode === 'VISUAL_DECK_V4'
          && ['EXECUTING', 'REVISING'].includes(transaction.run.status)
          && transaction.run.technicalRecovery?.active === false
          && isTechnicalFailureCode(existing.errorCode ?? '')
          && typeof input.budgetReservationKey === 'string'
        if (canRetryReleasedV4Submission) {
          const output = existing.output && typeof existing.output === 'object'
            ? existing.output as Record<string, unknown>
            : {}
          const retriedRun = isBatchReserved(input)
            ? transaction.run
            : mergePolicy(transaction.run, reserveBudget(transaction.run, input.budgetUnits), this.dependencies.clock.now().toISOString())
          const retrying: StepRecord = {
            ...existing,
            status: 'RESERVED',
            budgetReservationId: input.batchReservation?.reservationId ?? null,
            errorCode: null,
            output: {
              ...output,
              budgetReservationKey: input.budgetReservationKey,
              ...(input.batchReservation ? { batchId: input.batchReservation.batchId } : {}),
            },
            updatedAt: this.dependencies.clock.now().toISOString(),
          }
          if (!isBatchReserved(input)) transaction.putRun(retriedRun)
          transaction.putStep(retrying)
          transaction.appendEvent({
            schemaVersion: CONTRACT_VERSION,
            type: 'tool.started',
            payload: { stepId: retrying.id, tool: retrying.tool, label: '自动恢复并重新提交页面图片任务' },
          })
          if (!isBatchReserved(input)) {
            transaction.appendEvent({
              schemaVersion: CONTRACT_VERSION,
              type: 'budget.updated',
              payload: { budgetUnits: retriedRun.budgetUnits, committedBudgetUnits: retriedRun.committedBudgetUnits },
            })
          }
          return { run: retriedRun, step: retrying, replayed: false as const }
        }
        if (['WAITING', 'COMPLETED', 'FAILED',
          'COMPLETED_AFTER_CANCEL', 'FAILED_NOT_CHARGED', 'FAILED_CHARGED', 'BILLING_UNKNOWN'].includes(existing.status)) {
          return { run: transaction.run, step: existing, replayed: true as const }
        }
        return { run: transaction.run, step: existing, replayed: false as const }
      }

      const now = this.dependencies.clock.now().toISOString()
      const run = isBatchReserved(input)
        ? transaction.run
        : mergePolicy(transaction.run, reserveBudget(transaction.run, input.budgetUnits), now)
      const step: StepRecord = {
        id: input.stepId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        inputHash,
        tool: 'generate_slide_image',
        status: 'RESERVED',
        budgetUnits: input.budgetUnits,
        budgetReservationId: input.batchReservation?.reservationId ?? null,
        externalOperationId: null,
        errorCode: null,
        output: {
          slideId: input.slideId,
          versionId: input.versionId,
          backgroundMode: input.backgroundMode ?? 'OPAQUE',
          ...(input.budgetReservationKey ? { budgetReservationKey: input.budgetReservationKey } : {}),
          ...(input.batchReservation ? { batchId: input.batchReservation.batchId } : {}),
          ...(input.elementId ? { elementId: input.elementId } : {}),
          ...(input.assetReuseKey ? { assetReuseKey: input.assetReuseKey } : {}),
        },
        createdAt: now,
        updatedAt: now,
      }
      if (!isBatchReserved(input)) transaction.putRun(run)
      transaction.putStep(step)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.started',
        payload: { stepId: input.stepId, tool: step.tool, label: '生成页面视觉素材' },
      })
      if (!isBatchReserved(input)) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'budget.updated',
          payload: { budgetUnits: run.budgetUnits, committedBudgetUnits: run.committedBudgetUnits },
        })
      }
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
          backgroundMode: input.backgroundMode ?? 'OPAQUE',
          ...(input.budgetReservationKey ? { budgetReservationKey: input.budgetReservationKey } : {}),
          ...(input.batchReservation ? { batchId: input.batchReservation.batchId } : {}),
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

  /**
   * A process may stop after durable SUBMITTING and before it receives the
   * Provider operation id. Reconcile only through the original idempotency
   * key; never submit a second image task to answer this uncertainty.
   */
  private async recoverUnacknowledgedSubmission(run: RunRecord, step: StepRecord): Promise<RefreshSlideImageResult> {
    if (step.status === 'SUBMISSION_UNKNOWN' && this.nextInspectionAt(step) > this.dependencies.clock.now().getTime()) {
      return { step, changed: false }
    }
    const input = this.reconstructInput(step, run.imageModel)
    const lookup = await this.lookupSubmission(run.host.tenantId, step.idempotencyKey)
    if (lookup.state === 'SUBMITTED') {
      if (!step.budgetReservationId) throw new Error('BUDGET_RESERVATION_ID_MISSING')
      await this.markWaiting(input, step.budgetReservationId, lookup.operationId)
      const refreshed = await this.refreshSlideImage(run.id, step.idempotencyKey)
      return { ...refreshed, changed: true }
    }
    if (lookup.state === 'NOT_SUBMITTED') {
      if (!step.budgetReservationId) throw new Error('BUDGET_RESERVATION_ID_MISSING')
      if (isBatchReserved(input)) {
        return {
          step: await this.markDefiniteFailure(input, step.budgetReservationId, 'PROVIDER_SUBMISSION_NOT_FOUND'),
          changed: true,
        }
      }
      await this.markReleasing(input, step.budgetReservationId, 'PROVIDER_SUBMISSION_NOT_FOUND')
      await this.dependencies.budget.release({
        host: run.host,
        reservationId: step.budgetReservationId,
        idempotencyKey: `release:${budgetReservationKey(input)}`,
      })
      return {
        step: await this.markDefiniteFailure(input, step.budgetReservationId, 'PROVIDER_SUBMISSION_NOT_FOUND'),
        changed: true,
      }
    }
    return {
      step: await this.markUnknown(input, step.budgetReservationId, 'PROVIDER_SUBMISSION_UNKNOWN', 'MEDIA'),
      changed: true,
    }
  }

  private async lookupSubmission(tenantId: string, idempotencyKey: string) {
    if (!this.dependencies.images.lookupByIdempotency) return { state: 'UNKNOWN' as const }
    try {
      return await this.dependencies.images.lookupByIdempotency({ tenantId, idempotencyKey })
    } catch {
      return { state: 'UNKNOWN' as const }
    }
  }

  private reconstructInput(step: StepRecord, model: string): SubmitSlideImageInput {
    const output = step.output as {
      slideId?: unknown
      versionId?: unknown
      backgroundMode?: unknown
      budgetReservationKey?: unknown
      batchId?: unknown
    } | null
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
      model,
      budgetUnits: step.budgetUnits,
      ...(typeof output.budgetReservationKey === 'string' ? { budgetReservationKey: output.budgetReservationKey } : {}),
      ...(typeof output.batchId === 'string' && typeof step.budgetReservationId === 'string'
        ? { batchReservation: { batchId: output.batchId, reservationId: step.budgetReservationId } }
        : {}),
      ...(output.backgroundMode === 'TRANSPARENT' || output.backgroundMode === 'OPAQUE'
        ? { backgroundMode: output.backgroundMode }
        : {}),
    }
  }

  private nextInspectionAt(step: StepRecord) {
    const output = step.output as { nextInspectionAt?: unknown } | null
    if (!output || typeof output.nextInspectionAt !== 'string') return 0
    const value = Date.parse(output.nextInspectionAt)
    return Number.isFinite(value) ? value : 0
  }

  private async deferInspection(runId: string, idempotencyKey: string, retryAfterMs: number) {
    return this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const delay = Math.max(1_000, Math.min(60_000, Math.ceil(retryAfterMs)))
      const output = step.output && typeof step.output === 'object' ? step.output : {}
      const updated: StepRecord = {
        ...step,
        output: { ...output, nextInspectionAt: new Date(this.dependencies.clock.now().getTime() + delay).toISOString() },
        updatedAt: this.dependencies.clock.now().toISOString(),
      }
      transaction.putStep(updated)
      return updated
    })
  }

  private async markCompleted(runId: string, idempotencyKey: string, artifactId: string) {
    return this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED' || step.status === 'COMPLETED_AFTER_CANCEL') return step
      const rawOutput = step.output && typeof step.output === 'object' ? step.output as Record<string, unknown> : {}
      const { nextInspectionAt: _nextInspectionAt, ...output } = rawOutput
      const completedAfterCancel = transaction.run.status === 'CANCELLED'
      const updated: StepRecord = {
        ...step,
        status: completedAfterCancel ? 'COMPLETED_AFTER_CANCEL' : 'COMPLETED',
        output: { ...output, artifactId },
        errorCode: null,
        updatedAt: this.dependencies.clock.now().toISOString(),
      }
      transaction.putStep(updated)
      appendFixedIssueResolutions(transaction, [
        `${step.id}:provider-result`,
        `${step.id}:submission-unknown`,
      ])
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
      recoverV4AfterMediaRecovery(transaction, this.dependencies.clock)
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
      const fromStatus = transaction.run.status
      const transitionRequired = !cancelled && fromStatus !== 'NEEDS_HUMAN'
      const v4TechnicalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4' && isTechnicalFailureCode(errorCode)
      const policy = !transitionRequired || v4TechnicalFailure
        ? transaction.run
        : transitionRun(transaction.run, 'NEEDS_HUMAN')
      const run: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updated: StepRecord = {
        ...step,
        status: billingState === 'CHARGED'
          ? 'FAILED_CHARGED'
          : billingState === 'NOT_CHARGED' ? 'FAILED_NOT_CHARGED' : 'BILLING_UNKNOWN',
        errorCode,
        updatedAt: now,
      }
      transaction.putRun(run)
      transaction.putStep(updated)
      const technicalRecovery = beginTechnicalRecovery(transaction, this.dependencies.clock, errorCode)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: {
          stepId: step.id,
          errorCode: (updated.status === 'FAILED_CHARGED' ? `FAILED_CHARGED:${errorCode}`
            : updated.status === 'FAILED_NOT_CHARGED' ? `FAILED_NOT_CHARGED:${errorCode}`
              : updated.status === 'BILLING_UNKNOWN' ? `BILLING_UNKNOWN:${errorCode}` : errorCode).slice(0, 100),
          retryable: technicalRecovery?.technicalRecovery?.retryable ?? false,
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
      if (transitionRequired && !technicalRecovery) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: fromStatus, to: 'NEEDS_HUMAN', reason: errorCode },
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'HUMAN_REVIEW', summary: 'Provider 结果或费用状态需要人工核对。' },
        })
      }
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
      const run = isBatchReserved(input)
        ? transaction.run
        : mergePolicy(transaction.run, releaseBudget(transaction.run, input.budgetUnits), now)
      const updated: StepRecord = {
        ...step,
        status: transaction.run.status === 'CANCELLED' ? 'FAILED_NOT_CHARGED' : 'FAILED',
        budgetReservationId: input.batchReservation?.reservationId ?? null,
        errorCode,
        updatedAt: now,
      }
      if (!isBatchReserved(input)) transaction.putRun(run)
      transaction.putStep(updated)
      const technicalRecovery = beginTechnicalRecovery(transaction, this.dependencies.clock, errorCode)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: {
          stepId: step.id,
          errorCode: (updated.status === 'FAILED_NOT_CHARGED' ? `FAILED_NOT_CHARGED:${errorCode}` : errorCode).slice(0, 100),
          retryable: technicalRecovery?.technicalRecovery?.retryable ?? false,
        },
      })
      if (!isBatchReserved(input)) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'budget.updated',
          payload: { budgetUnits: run.budgetUnits, committedBudgetUnits: run.committedBudgetUnits },
        })
      }
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
      const fromStatus = transaction.run.status
      const transitionRequired = !['NEEDS_HUMAN', 'CANCELLED'].includes(fromStatus)
      const v4TechnicalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4' && isTechnicalFailureCode(errorCode)
      const policy = transitionRequired && !v4TechnicalFailure ? transitionRun(transaction.run, 'NEEDS_HUMAN') : transaction.run
      const run: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const repeatedUnknown = kind === 'MEDIA'
        && step.status === 'SUBMISSION_UNKNOWN'
        && step.errorCode === errorCode
      const rawOutput = step.output && typeof step.output === 'object' ? step.output as Record<string, unknown> : {}
      const previousAttempt = typeof rawOutput.submissionLookupAttempt === 'number'
        && Number.isSafeInteger(rawOutput.submissionLookupAttempt)
        ? rawOutput.submissionLookupAttempt
        : 0
      const submissionLookupAttempt = kind === 'MEDIA' && !step.externalOperationId
        ? Math.min(5, previousAttempt + 1)
        : null
      const output = submissionLookupAttempt === null
        ? step.output
        : {
            ...rawOutput,
            submissionLookupAttempt,
            nextInspectionAt: new Date(this.dependencies.clock.now().getTime()
              + submissionLookupRetryDelayMs(submissionLookupAttempt)).toISOString(),
          }
      const updated: StepRecord = {
        ...step,
        status: kind === 'BUDGET' ? 'RESERVATION_UNKNOWN' : 'SUBMISSION_UNKNOWN',
        budgetReservationId: reservationId,
        errorCode,
        output,
        updatedAt: now,
      }
      if (transitionRequired) transaction.putRun(run)
      transaction.putStep(updated)
      const technicalRecovery = beginTechnicalRecovery(transaction, this.dependencies.clock, errorCode)
      const issueId = `${input.stepId}:submission-unknown`
      if (!repeatedUnknown) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'tool.failed',
          payload: {
            stepId: step.id,
            errorCode: (kind === 'BUDGET' ? `RESERVATION_UNKNOWN:${errorCode}` : `SUBMISSION_UNKNOWN:${errorCode}`).slice(0, 100),
            retryable: technicalRecovery?.technicalRecovery?.retryable ?? false,
          },
        })
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
      }
      if (transitionRequired && !technicalRecovery) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: fromStatus, to: 'NEEDS_HUMAN', reason: errorCode },
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'HUMAN_REVIEW', summary: '媒体提交或宿主额度状态未知，需要人工核对。' },
        })
      }
      return updated
    })
  }
}

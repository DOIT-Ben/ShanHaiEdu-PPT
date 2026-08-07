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
  type TechnicalFailure,
} from './ports'
import { hashInput } from './hash'
import { isPendingMediaReconciliationStep } from './media-reconciliation'
import { releaseBudget, reserveBudget, transitionRun } from './policy'
import { allPageNumbers, appendFixedIssueResolutions, isVisualDeckV4, v4LifecyclePayload } from './v4-lifecycle'
import { recoverV4AfterMediaRecovery } from './v4-media-recovery'
import {
  beginTechnicalRecovery,
  hostTechnicalFailure,
  isTechnicalFailureCode,
  providerTechnicalFailure,
  technicalFailureFromStep,
  usageV2TechnicalFailure,
} from './technical-recovery'
import type { V4RepairContract } from './v4-repair-contract'
import { UsageAccountingRequestError } from '../usage-accounting-contracts'
import { accountingProtocolFor, UsageV2Coordinator } from './usage-v2-coordinator'

const MEDIA_FAILURE_STEP_STATUSES = new Set<StepStatus>([
  'FAILED',
  'RESERVATION_UNKNOWN',
  'SUBMISSION_UNKNOWN',
  'FAILED_NOT_CHARGED',
  'FAILED_CHARGED',
  'BILLING_UNKNOWN',
])

const POST_PROVIDER_USAGE_V2_CONSISTENCY_CODES = new Set([
  'USAGE_V2_RUN_REQUIRED',
  'USAGE_V2_MEDIA_METADATA_MISSING',
  'USAGE_V2_MEDIA_METADATA_INVALID',
  'USAGE_V2_MEDIA_IDENTITY_CONFLICT',
  'USAGE_V2_PERMIT_REQUIRED',
  'USAGE_V2_PROVIDER_OPERATION_CONFLICT',
  'MEDIA_OPERATION_ID_MISSING',
  'USAGE_V2_OBSERVED_REQUIRED',
  'USAGE_V2_EVENT_IDENTITY_CONFLICT',
  'USAGE_V2_EVENT_CONTRACT_INVALID',
  'USAGE_V2_OUTBOX_INVALID',
  'USAGE_V2_OUTBOX_NOT_FOUND',
])

type UsageV2RecoveryCheckpoint = Readonly<
  | {
      stage: 'PROVIDER_SUBMISSION'
      providerOperationId: string
      submissionState: 'QUEUED' | 'PROCESSING' | 'COMPLETED'
    }
  | {
      stage: 'PROVIDER_RESULT'
      providerOperationId: string
      providerStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED'
      billingState: 'CHARGED' | 'NOT_CHARGED' | 'UNKNOWN'
    }
>

function postProviderUsageV2TechnicalFailure(error: unknown) {
  if (!(error instanceof Error) || !POST_PROVIDER_USAGE_V2_CONSISTENCY_CODES.has(error.message)) return null
  return usageV2TechnicalFailure(error.message, 'REJECTED')
}

function submissionLookupRetryDelayMs(attempt: number) {
  return [2_000, 10_000, 30_000, 60_000, 60_000][Math.max(0, Math.min(4, attempt - 1))]!
}

export function isMediaFailureStepStatus(status: StepStatus) {
  return MEDIA_FAILURE_STEP_STATUSES.has(status)
}

export function isUsageAuthorizationCapFailureStep(
  step: Pick<StepRecord, 'status' | 'errorCode' | 'externalOperationId'>,
) {
  return step.status === 'FAILED'
    && step.errorCode === 'AUTHORIZATION_CAP_REACHED'
    && step.externalOperationId === null
}

export type SubmitSlideImageInput = Readonly<{
  runId: string
  stepId: string
  idempotencyKey: string
  /** Internal accounting key. Provider submission always uses idempotencyKey above. */
  budgetReservationKey?: string
  /** V4 initial generation uses one reservation owned by GenerationBatch. */
  batchReservation?: Readonly<{ batchId: string; reservationId: string }>
  /** Usage V2 operation identity. Required for a V2 Run. */
  pageNumber?: number
  revisionRound?: number
  slideId: string
  versionId: string
  prompt: string
  negativePrompt?: string
  model: string
  budgetUnits: number
  aspectRatio?: '16:9' | '4:3' | '1:1' | '3:4'
  exactAspectRatio?: boolean
  backgroundMode?: 'OPAQUE' | 'TRANSPARENT'
  operationMode?: 'TEXT_TO_IMAGE' | 'IMAGE_EDIT'
  repairContract?: V4RepairContract
  repairContractHash?: string
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

function outputWithTechnicalFailure(output: unknown, technicalFailure: TechnicalFailure) {
  const persisted = output && typeof output === 'object' ? output as Record<string, unknown> : {}
  return { ...persisted, technicalFailure }
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
    usageV2?: UsageV2Coordinator
    inspectionConcurrency?: number
  }>) {
    this.inspectionConcurrency = dependencies.inspectionConcurrency ?? 1
    if (!Number.isSafeInteger(this.inspectionConcurrency) || this.inspectionConcurrency < 1 || this.inspectionConcurrency > 50) {
      throw new Error('IMAGE_CONCURRENCY_INVALID')
    }
  }

  async submitSlideImage(input: SubmitSlideImageInput): Promise<SubmitSlideImageResult> {
    const prepared = await this.prepare(input)
    if (['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(prepared.step.status)) {
      const reconciled = await this.refreshSlideImage(input.runId, input.idempotencyKey)
      return { step: reconciled.step, replayed: true }
    }
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
        technicalFailureFromStep(prepared.step) ?? undefined,
      )
      return { step, replayed: false }
    }

    let reservationId = prepared.step.budgetReservationId
    const usesUsageV2 = accountingProtocolFor(prepared.run) === 'FRAMEFLOW_USAGE_V2'
    if (usesUsageV2) {
      if (!this.dependencies.usageV2) throw new Error('USAGE_V2_COORDINATOR_REQUIRED')
      if (!input.batchReservation || input.pageNumber === undefined || input.revisionRound === undefined) {
        throw new Error('USAGE_V2_MEDIA_IDENTITY_REQUIRED')
      }
      try {
        const permit = await this.dependencies.usageV2.authorizeMediaOperation({
          runId: input.runId,
          mediaStepKey: input.idempotencyKey,
          batchId: input.batchReservation.batchId,
          pageNumber: input.pageNumber,
          revisionRound: input.revisionRound,
          model: input.model,
          operationMode: input.operationMode ?? 'TEXT_TO_IMAGE',
          resolution: '1K',
          aspectRatio: input.aspectRatio ?? '16:9',
        })
        if (!permit.allowed) {
          if (permit.stopReason === 'AUTHORIZATION_CAP_REACHED' && isVisualDeckV4(prepared.run)) {
            const step = await this.pauseForUsageAuthorizationCap(input)
            return { step, replayed: false }
          }
          const step = await this.markDefiniteFailure(input, reservationId, permit.stopReason)
          return { step, replayed: false }
        }
      } catch (error) {
        const errorCode = error instanceof UsageAccountingRequestError ? error.code : 'HOST_USAGE_V2_PERMIT_UNKNOWN'
        const technicalFailure = usageV2TechnicalFailure(
          errorCode,
          error instanceof UsageAccountingRequestError ? error.outcome : 'UNKNOWN',
        )
        if (error instanceof UsageAccountingRequestError && error.outcome === 'REJECTED') {
          const step = await this.markDefiniteFailure(input, reservationId, errorCode, technicalFailure)
          return { step, replayed: false }
        }
        const step = await this.markUnknown(input, reservationId, errorCode, 'BUDGET', technicalFailure)
        return { step, replayed: false }
      }
    }
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
        const step = await this.markUnknown(
          input,
          null,
          errorCode,
          'BUDGET',
          hostTechnicalFailure(errorCode, 'RETRYABLE'),
        )
        return { step, replayed: false }
      }
    }
    if (!reservationId) throw new Error('BATCH_BUDGET_RESERVATION_MISSING')

    let submitted: Awaited<ReturnType<ImageGenerationPort['submit']>>
    try {
      await this.markSubmitting(input, reservationId)
      submitted = await this.dependencies.images.submit({
        tenantId: prepared.run.host.tenantId,
        prompt: input.prompt,
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
        model: input.model,
        aspectRatio: input.aspectRatio ?? '16:9',
        ...(input.exactAspectRatio ? { exactAspectRatio: true } : {}),
        ...(input.backgroundMode ? { backgroundMode: input.backgroundMode } : {}),
        ...(input.referenceImage ? { referenceImage: input.referenceImage } : {}),
        idempotencyKey: input.idempotencyKey,
      })
    } catch (error) {
      const submissionState = error instanceof MediaSubmissionError ? error.submissionState : 'UNKNOWN'
      const errorCode = error instanceof MediaSubmissionError ? error.code : 'MEDIA_SUBMISSION_UNKNOWN'
      const technicalFailure = error instanceof MediaSubmissionError
        ? error.technicalFailure
        : providerTechnicalFailure(errorCode, { disposition: 'RETRYABLE' })
      if (submissionState === 'NOT_SUBMITTED' && reservationId && !isBatchReserved(input)) {
        await this.markReleasing(input, reservationId, errorCode, technicalFailure)
        await this.dependencies.budget.release({
          host: prepared.run.host,
          reservationId,
          idempotencyKey: `release:${budgetReservationKey(input)}`,
        })
        const step = await this.markDefiniteFailure(input, reservationId, errorCode, technicalFailure)
        return { step, replayed: false }
      }

      if (submissionState === 'NOT_SUBMITTED' && reservationId) {
        const step = await this.markDefiniteFailure(input, reservationId, errorCode, technicalFailure)
        return { step, replayed: false }
      }

      const step = await this.markUnknown(input, reservationId, errorCode, 'MEDIA', technicalFailure)
      return { step, replayed: false }
    }
    const step = await this.markWaiting(input, reservationId, submitted.operationId)
    if (usesUsageV2) {
      const failed = await this.recordUsageV2ProviderSubmission(
        input.runId,
        input.idempotencyKey,
        submitted.operationId,
        submitted.state,
      )
      if (failed) return { step: failed, replayed: false }
    }
    return { step, replayed: false }
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
          idempotencyKey: `release:${budgetReservationKey(this.reconstructInput(step, run))}`,
      })
      return {
        step: await this.markDefiniteFailure(
          this.reconstructInput(step, run),
          step.budgetReservationId,
          step.errorCode ?? 'MEDIA_NOT_SUBMITTED',
          technicalFailureFromStep(step) ?? undefined,
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

    const mediaInput = this.reconstructInput(step, run)
    const usesUsageV2 = accountingProtocolFor(run) === 'FRAMEFLOW_USAGE_V2'
    if (usesUsageV2) {
      if (!this.dependencies.usageV2) throw new Error('USAGE_V2_COORDINATOR_REQUIRED')
      const failed = await this.recordUsageV2ProviderSubmission(
        runId,
        idempotencyKey,
        step.externalOperationId,
        'PROCESSING',
      )
      if (failed) return { step: failed, changed: true }
    }
    const status = await this.dependencies.images.inspect({
      tenantId: run.host.tenantId,
      operationId: step.externalOperationId,
      idempotencyKey,
      aspectRatio: mediaInput.aspectRatio ?? '16:9',
      ...(mediaInput.exactAspectRatio ? { exactAspectRatio: true } : {}),
      ...(mediaInput.backgroundMode ? { backgroundMode: mediaInput.backgroundMode } : {}),
    })
    if (status.state === 'QUEUED' || status.state === 'PROCESSING') {
      if (!status.retryAfterMs) return { step, changed: false }
      return { step: await this.deferInspection(runId, idempotencyKey, status.retryAfterMs), changed: true }
    }
    if (status.state === 'COMPLETED') {
      if (!step.budgetReservationId) throw new Error('BUDGET_RESERVATION_ID_MISSING')
      if (usesUsageV2) {
        const failed = await this.recordUsageV2ProviderResult(
          runId,
          idempotencyKey,
          step.externalOperationId,
          'COMPLETED',
          'CHARGED',
        )
        if (failed) return { step: failed, changed: true }
      }
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
    if (usesUsageV2) {
      const failed = await this.recordUsageV2ProviderResult(
        runId,
        idempotencyKey,
        step.externalOperationId,
        'FAILED',
        status.billingState,
      )
      if (failed) return { step: failed, changed: true }
    }
    if (status.billingState === 'NOT_CHARGED' && step.budgetReservationId && !isBatchReserved(mediaInput)) {
      const input = this.reconstructInput(step, run)
      await this.markReleasing(input, step.budgetReservationId, status.errorCode, status.technicalFailure)
      await this.dependencies.budget.release({
        host: run.host,
        reservationId: step.budgetReservationId,
        idempotencyKey: `release:${budgetReservationKey(input)}`,
      })
      return {
        step: await this.markDefiniteFailure(input, step.budgetReservationId, status.errorCode, status.technicalFailure),
        changed: true,
      }
    }
    if (status.billingState === 'NOT_CHARGED') {
      return {
        step: await this.markDefiniteFailure(mediaInput, step.budgetReservationId, status.errorCode, status.technicalFailure),
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
      step: await this.markResultFailure(
        runId,
        idempotencyKey,
        status.errorCode,
        status.billingState,
        status.technicalFailure,
      ),
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
      ...(input.exactAspectRatio ? { exactAspectRatio: true } : {}),
      ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
      ...(input.backgroundMode ? { backgroundMode: input.backgroundMode } : {}),
      ...(input.operationMode ? { operationMode: input.operationMode } : {}),
      ...(input.repairContractHash ? { repairContractHash: input.repairContractHash } : {}),
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
        const retryingAuthorizationCap = isBatchReserved(input)
          && isUsageAuthorizationCapFailureStep(existing)
        const retryingTechnicalFailure = transaction.run.technicalRecovery?.active === false
          && technicalFailureFromStep(existing) !== null
          && typeof input.budgetReservationKey === 'string'
        const canRetryReleasedV4Submission = existing.status === 'FAILED'
          && transaction.run.presentationMode === 'VISUAL_DECK_V4'
          && ['EXECUTING', 'REVISING'].includes(transaction.run.status)
          && (retryingAuthorizationCap || retryingTechnicalFailure)
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
              aspectRatio: input.aspectRatio ?? '16:9',
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
          aspectRatio: input.aspectRatio ?? '16:9',
          ...(input.exactAspectRatio ? { exactAspectRatio: true } : {}),
          backgroundMode: input.backgroundMode ?? 'OPAQUE',
          model: input.model,
          operationMode: input.operationMode ?? 'TEXT_TO_IMAGE',
          ...(input.referenceImage ? { referenceImageSha256: input.referenceImage.sha256 } : {}),
          ...(input.repairContractHash ? { repairContractHash: input.repairContractHash } : {}),
          ...(input.repairContract ? { repairContract: input.repairContract } : {}),
          ...(input.budgetReservationKey ? { budgetReservationKey: input.budgetReservationKey } : {}),
          ...(input.batchReservation ? { batchId: input.batchReservation.batchId } : {}),
          ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }),
          ...(input.revisionRound === undefined ? {} : { revisionRound: input.revisionRound }),
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
      const persistedOutput = step.output && typeof step.output === 'object'
        ? step.output as Record<string, unknown>
        : {}
      const updated: StepRecord = {
        ...step,
        status: 'WAITING',
        budgetReservationId: reservationId,
        externalOperationId: operationId,
        errorCode: null,
        output: {
          ...persistedOutput,
          slideId: input.slideId,
          versionId: input.versionId,
          aspectRatio: input.aspectRatio ?? '16:9',
          ...(input.exactAspectRatio ? { exactAspectRatio: true } : {}),
          backgroundMode: input.backgroundMode ?? 'OPAQUE',
          model: input.model,
          operationMode: input.operationMode ?? 'TEXT_TO_IMAGE',
          ...(input.referenceImage ? { referenceImageSha256: input.referenceImage.sha256 } : {}),
          ...(input.repairContractHash ? { repairContractHash: input.repairContractHash } : {}),
          ...(input.repairContract ? { repairContract: input.repairContract } : {}),
          ...(input.budgetReservationKey ? { budgetReservationKey: input.budgetReservationKey } : {}),
          ...(input.batchReservation ? { batchId: input.batchReservation.batchId } : {}),
          ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }),
          ...(input.revisionRound === undefined ? {} : { revisionRound: input.revisionRound }),
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
    const input = this.reconstructInput(step, run)
    const lookup = await this.lookupSubmission(
      run.host.tenantId,
      step.idempotencyKey,
      input.operationMode ?? 'TEXT_TO_IMAGE',
    )
    if (lookup.state === 'SUBMITTED') {
      if (!step.budgetReservationId) throw new Error('BUDGET_RESERVATION_ID_MISSING')
      await this.markWaiting(input, step.budgetReservationId, lookup.operationId)
      const refreshed = await this.refreshSlideImage(run.id, step.idempotencyKey)
      return { ...refreshed, changed: true }
    }
    if (lookup.state === 'NOT_SUBMITTED') {
      if (!step.budgetReservationId) throw new Error('BUDGET_RESERVATION_ID_MISSING')
      const technicalFailure = providerTechnicalFailure('PROVIDER_SUBMISSION_NOT_FOUND')
      if (isBatchReserved(input)) {
        return {
          step: await this.markDefiniteFailure(
            input,
            step.budgetReservationId,
            'PROVIDER_SUBMISSION_NOT_FOUND',
            technicalFailure,
          ),
          changed: true,
        }
      }
      await this.markReleasing(input, step.budgetReservationId, 'PROVIDER_SUBMISSION_NOT_FOUND', technicalFailure)
      await this.dependencies.budget.release({
        host: run.host,
        reservationId: step.budgetReservationId,
        idempotencyKey: `release:${budgetReservationKey(input)}`,
      })
      return {
        step: await this.markDefiniteFailure(
          input,
          step.budgetReservationId,
          'PROVIDER_SUBMISSION_NOT_FOUND',
          technicalFailure,
        ),
        changed: true,
      }
    }
    return {
      step: await this.markUnknown(
        input,
        step.budgetReservationId,
        'PROVIDER_SUBMISSION_UNKNOWN',
        'MEDIA',
        providerTechnicalFailure('PROVIDER_SUBMISSION_UNKNOWN', { disposition: 'RETRYABLE' }),
      ),
      changed: true,
    }
  }

  private async lookupSubmission(
    tenantId: string,
    idempotencyKey: string,
    operationMode: 'TEXT_TO_IMAGE' | 'IMAGE_EDIT',
  ) {
    if (!this.dependencies.images.lookupByIdempotency) return { state: 'UNKNOWN' as const }
    try {
      return await this.dependencies.images.lookupByIdempotency({ tenantId, idempotencyKey, operationMode })
    } catch {
      return { state: 'UNKNOWN' as const }
    }
  }

  private reconstructInput(step: StepRecord, run: RunRecord): SubmitSlideImageInput {
    const output = step.output as {
      slideId?: unknown
      versionId?: unknown
      aspectRatio?: unknown
      exactAspectRatio?: unknown
      backgroundMode?: unknown
      model?: unknown
      operationMode?: unknown
      repairContractHash?: unknown
      budgetReservationKey?: unknown
      batchId?: unknown
      pageNumber?: unknown
      revisionRound?: unknown
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
      model: persistedMediaStepModel(step, run.imageModel),
      budgetUnits: step.budgetUnits,
      ...(output.aspectRatio === '16:9' || output.aspectRatio === '4:3'
        || output.aspectRatio === '1:1' || output.aspectRatio === '3:4'
        ? { aspectRatio: output.aspectRatio }
        : {}),
      ...(output.exactAspectRatio === true || run.presentationMode === 'VISUAL_DECK_V4'
        ? { exactAspectRatio: true }
        : {}),
      ...(typeof output.budgetReservationKey === 'string' ? { budgetReservationKey: output.budgetReservationKey } : {}),
      ...(typeof output.batchId === 'string' && typeof step.budgetReservationId === 'string'
        ? { batchReservation: { batchId: output.batchId, reservationId: step.budgetReservationId } }
        : {}),
      ...(typeof output.pageNumber === 'number' && Number.isSafeInteger(output.pageNumber)
        ? { pageNumber: output.pageNumber }
        : {}),
      ...(typeof output.revisionRound === 'number' && Number.isSafeInteger(output.revisionRound)
        ? { revisionRound: output.revisionRound }
        : {}),
      ...(output.backgroundMode === 'TRANSPARENT' || output.backgroundMode === 'OPAQUE'
        ? { backgroundMode: output.backgroundMode }
        : {}),
      ...(output.operationMode === 'TEXT_TO_IMAGE' || output.operationMode === 'IMAGE_EDIT'
        ? { operationMode: output.operationMode }
        : {}),
      ...(typeof output.repairContractHash === 'string' ? { repairContractHash: output.repairContractHash } : {}),
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

  private async recordUsageV2ProviderSubmission(
    runId: string,
    idempotencyKey: string,
    providerOperationId: string,
    submissionState: 'QUEUED' | 'PROCESSING' | 'COMPLETED',
  ) {
    try {
      await this.dependencies.usageV2!.recordProviderSubmission({
        runId,
        mediaStepKey: idempotencyKey,
        operationId: providerOperationId,
        state: submissionState,
      })
      return null
    } catch (error) {
      const technicalFailure = postProviderUsageV2TechnicalFailure(error)
      if (!technicalFailure) throw error
      return this.markPostProviderUsageV2Failure(runId, idempotencyKey, technicalFailure, {
        stage: 'PROVIDER_SUBMISSION',
        providerOperationId,
        submissionState,
      })
    }
  }

  private async recordUsageV2ProviderResult(
    runId: string,
    idempotencyKey: string,
    providerOperationId: string,
    providerStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    billingState: 'CHARGED' | 'NOT_CHARGED' | 'UNKNOWN',
  ) {
    try {
      await this.dependencies.usageV2!.recordProviderResult({
        runId,
        mediaStepKey: idempotencyKey,
        status: providerStatus,
        billingState,
      })
      return null
    } catch (error) {
      const technicalFailure = postProviderUsageV2TechnicalFailure(error)
      if (!technicalFailure) throw error
      return this.markPostProviderUsageV2Failure(runId, idempotencyKey, technicalFailure, {
        stage: 'PROVIDER_RESULT',
        providerOperationId,
        providerStatus,
        billingState,
      })
    }
  }

  private async pauseForUsageAuthorizationCap(input: SubmitSlideImageInput) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const cancelled = transaction.run.status === 'CANCELLED'
      const updatedStep: StepRecord = {
        ...step,
        status: cancelled ? 'FAILED_NOT_CHARGED' : 'FAILED',
        errorCode: 'AUTHORIZATION_CAP_REACHED',
        updatedAt: now,
      }
      transaction.putStep(updatedStep)
      if (cancelled || transaction.run.status === 'PAUSED'
        || !['EXECUTING', 'REVISING'].includes(transaction.run.status)) {
        return updatedStep
      }

      const policy = transitionRun(transaction.run, 'PAUSED')
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      transaction.putRun(updatedRun)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.paused',
        payload: {
          ...v4LifecyclePayload(updatedRun, 'RUN', {
            completed: 0,
            total: updatedRun.slideCount,
            pageNumbers: allPageNumbers(updatedRun),
            reason: 'BUDGET_INSUFFICIENT',
            retryable: true,
            requiresUserAction: true,
            nextAction: 'ADD_BUDGET',
          }),
          resumeState: updatedRun.resumeState!,
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'BUDGET', summary: '当前授权额度已用完，请追加预算后继续。' },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode: 'AUTHORIZATION_CAP_REACHED', retryable: true },
      })
      return updatedStep
    })
  }

  private async markPostProviderUsageV2Failure(
    runId: string,
    idempotencyKey: string,
    technicalFailure: TechnicalFailure,
    checkpoint: UsageV2RecoveryCheckpoint,
  ) {
    return this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const output = step.output && typeof step.output === 'object'
        ? step.output as Record<string, unknown>
        : {}
      const previousCheckpoint = output.usageV2Recovery
      const repeated = step.errorCode === technicalFailure.diagnosticCode
        && previousCheckpoint !== null
        && typeof previousCheckpoint === 'object'
        && (previousCheckpoint as Record<string, unknown>).stage === checkpoint.stage
        && (previousCheckpoint as Record<string, unknown>).diagnosticCode === technicalFailure.diagnosticCode
      const updated: StepRecord = {
        ...step,
        externalOperationId: checkpoint.providerOperationId,
        errorCode: technicalFailure.diagnosticCode,
        output: outputWithTechnicalFailure({
          ...output,
          usageV2Recovery: {
            ...checkpoint,
            operationIdempotencyKey: idempotencyKey,
            diagnosticCode: technicalFailure.diagnosticCode,
          },
        }, technicalFailure),
        updatedAt: this.dependencies.clock.now().toISOString(),
      }
      transaction.putStep(updated)
      beginTechnicalRecovery(transaction, this.dependencies.clock, technicalFailure)
      if (!repeated) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'tool.failed',
          payload: {
            stepId: step.id,
            errorCode: technicalFailure.diagnosticCode,
            retryable: technicalFailure.disposition === 'RETRYABLE',
          },
        })
      }
      return updated
    })
  }

  private async markResultFailure(
    runId: string,
    idempotencyKey: string,
    errorCode: string,
    billingState: 'NOT_CHARGED' | 'CHARGED' | 'UNKNOWN',
    technicalFailure: TechnicalFailure,
  ) {
    return this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const cancelled = transaction.run.status === 'CANCELLED'
      const fromStatus = transaction.run.status
      const transitionRequired = !cancelled && fromStatus !== 'NEEDS_HUMAN'
      const v4TechnicalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4'
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
        output: outputWithTechnicalFailure(step.output, technicalFailure),
        updatedAt: now,
      }
      transaction.putRun(run)
      transaction.putStep(updated)
      const technicalRecovery = beginTechnicalRecovery(transaction, this.dependencies.clock, technicalFailure)
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
      if (transitionRequired && !technicalRecovery && !v4TechnicalFailure) {
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

  private async markReleasing(
    input: SubmitSlideImageInput,
    reservationId: string,
    errorCode: string,
    technicalFailure?: TechnicalFailure,
  ) {
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      transaction.putStep({
        ...step,
        status: 'RELEASING',
        budgetReservationId: reservationId,
        errorCode,
        ...(technicalFailure ? { output: outputWithTechnicalFailure(step.output, technicalFailure) } : {}),
        updatedAt: this.dependencies.clock.now().toISOString(),
      })
    })
  }

  private async markDefiniteFailure(
    input: SubmitSlideImageInput,
    reservationId: string | null,
    errorCode: string,
    technicalFailure?: TechnicalFailure,
  ) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const resolvedTechnicalFailure = technicalFailure ?? technicalFailureFromStep(step)
      const run = isBatchReserved(input)
        ? transaction.run
        : mergePolicy(transaction.run, releaseBudget(transaction.run, input.budgetUnits), now)
      const updated: StepRecord = {
        ...step,
        status: transaction.run.status === 'CANCELLED' ? 'FAILED_NOT_CHARGED' : 'FAILED',
        budgetReservationId: input.batchReservation?.reservationId ?? null,
        errorCode,
        ...(resolvedTechnicalFailure ? {
          output: outputWithTechnicalFailure(step.output, resolvedTechnicalFailure),
        } : {}),
        updatedAt: now,
      }
      if (!isBatchReserved(input)) transaction.putRun(run)
      transaction.putStep(updated)
      const technicalRecovery = beginTechnicalRecovery(
        transaction,
        this.dependencies.clock,
        resolvedTechnicalFailure ?? errorCode,
      )
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
    technicalFailure?: TechnicalFailure,
  ) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const fromStatus = transaction.run.status
      const transitionRequired = !['NEEDS_HUMAN', 'CANCELLED'].includes(fromStatus)
      const resolvedTechnicalFailure = technicalFailure ?? technicalFailureFromStep(step)
      const v4TechnicalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4'
        && (resolvedTechnicalFailure !== null || isTechnicalFailureCode(errorCode))
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
      const persistedOutput = resolvedTechnicalFailure
        ? outputWithTechnicalFailure(output, resolvedTechnicalFailure)
        : output
      const updated: StepRecord = {
        ...step,
        status: kind === 'BUDGET' ? 'RESERVATION_UNKNOWN' : 'SUBMISSION_UNKNOWN',
        budgetReservationId: reservationId,
        errorCode,
        output: persistedOutput,
        updatedAt: now,
      }
      if (transitionRequired) transaction.putRun(run)
      transaction.putStep(updated)
      const technicalRecovery = beginTechnicalRecovery(
        transaction,
        this.dependencies.clock,
        resolvedTechnicalFailure ?? errorCode,
      )
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
      if (transitionRequired && !technicalRecovery && !v4TechnicalFailure) {
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

export function persistedMediaStepModel(step: StepRecord, legacyModel: string) {
  const output = step.output && typeof step.output === 'object'
    ? step.output as { model?: unknown; operationMode?: unknown }
    : null
  if (typeof output?.model === 'string' && output.model.trim()) {
    if (step.idempotencyKey.includes(':edit:') && output.operationMode !== 'IMAGE_EDIT') {
      throw new Error('MEDIA_STEP_ROUTING_METADATA_MISSING')
    }
    return output.model
  }
  if (step.idempotencyKey.includes(':edit:')) throw new Error('MEDIA_STEP_ROUTING_METADATA_MISSING')
  return legacyModel
}

import { CONTRACT_VERSION } from '../contracts'
import { ZodError } from 'zod'
import { slideVisualReviewSchema, type SlideVisualReview } from '../presentation-contracts'
import { hashInput } from './hash'
import { StructuredModelError } from './ports'
import type { AgentRepository, ClockPort, ContractRepairIssue, RunRecord, StepRecord, VisualReviewPort } from './ports'
import { revisionContractRepairIssues } from './revision-contract-repair'
import { requireV4StructuredGenerationProtocol, v4ModelOverride } from './v4-model-policy'
import { VISUAL_DECK_V4_COMPILER_VERSION } from '../release-identity'

const MAX_VISUAL_REVIEW_PROVIDER_ATTEMPTS = 5
const MAX_VISUAL_REVIEW_CONTRACT_ATTEMPTS = 2
const VISUAL_REVIEW_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000] as const

type VisualReviewFailure = Readonly<{
  errorCode: string
  providerAttempt: number
  maxProviderAttempts: number
  contractAttempt: number
  maxContractAttempts: number
  model: string | null
  requestId: string | null
}>

class VisualReviewExecutionError extends Error {
  constructor(readonly diagnostic: VisualReviewFailure) {
    super(diagnostic.errorCode)
    this.name = 'VisualReviewExecutionError'
  }
}

export type ReviewSlideInput = Readonly<{
  runId: string
  stepId: string
  idempotencyKey: string
  slideId: string
  versionId: string
  artifactId: string
  visualIntent: string
  layout: string
  visualDirection: string
  v4CompilerVersion?: string
  structuredGenerationProtocol?: import('./ports').StructuredGenerationProtocol
}>

export type ReviewSlideResult = Readonly<{
  step: StepRecord
  review: SlideVisualReview | null
  replayed: boolean
}>

export class VisualReviewRunner {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    reviewer: VisualReviewPort
    clock: ClockPort
    sleep?: (milliseconds: number) => Promise<void>
  }>) {}

  async review(input: ReviewSlideInput): Promise<ReviewSlideResult> {
    const prepared = await this.prepare(input)
    if (prepared.replayed) return prepared

    try {
      const modelOverride = v4ModelOverride(prepared.run, 'VISION', input.v4CompilerVersion)
      const structuredGenerationProtocol = requireV4StructuredGenerationProtocol(
        prepared.run,
        input.v4CompilerVersion,
      )
      const review = await this.reviewWithProviderRetry({
        tenantId: prepared.run.host.tenantId,
        artifactId: input.artifactId,
        visualIntent: input.visualIntent,
        layout: input.layout,
        visualDirection: input.visualDirection,
        idempotencyKey: input.idempotencyKey,
        ...(modelOverride ? { modelOverride } : {}),
        ...(input.v4CompilerVersion ? { v4CompilerVersion: input.v4CompilerVersion } : {}),
        ...(structuredGenerationProtocol ? { structuredGenerationProtocol } : {}),
      })
      return this.complete(input, review)
    } catch (error) {
      const diagnostic = error instanceof VisualReviewExecutionError
        ? error.diagnostic
        : visualReviewFailure(error, 1, 1)
      return this.fail(input, diagnostic)
    }
  }

  private async reviewWithProviderRetry(input: Parameters<VisualReviewPort['review']>[0]) {
    let contractRepairIssues: readonly ContractRepairIssue[] | undefined
    let contentSlotCompletion = false
    const chain4 = input.v4CompilerVersion === VISUAL_DECK_V4_COMPILER_VERSION
    let lastError: unknown = new Error('VISUAL_REVIEW_FAILED')
    for (let contractAttempt = 0;
      contractAttempt < MAX_VISUAL_REVIEW_CONTRACT_ATTEMPTS;
      contractAttempt += 1) {
      const idempotencyKey = visualReviewContractAttemptKey(input.idempotencyKey, contractAttempt)
      for (let providerAttempt = 1;
        providerAttempt <= MAX_VISUAL_REVIEW_PROVIDER_ATTEMPTS;
        providerAttempt += 1) {
        try {
          const raw = await this.dependencies.reviewer.review({
            ...input,
            idempotencyKey,
            ...(chain4
              ? (contentSlotCompletion ? { contentSlotCompletion: true } : {})
              : (contractRepairIssues ? { contractRepairIssues } : {})),
          })
          return slideVisualReviewSchema.parse(raw)
        } catch (error) {
          lastError = error
          const providerRetryable = error instanceof StructuredModelError
            && error.retryable
            && error.code !== 'MODEL_JSON_INVALID'
          if (providerRetryable) {
            if (providerAttempt === MAX_VISUAL_REVIEW_PROVIDER_ATTEMPTS) {
              throw new VisualReviewExecutionError(
                visualReviewFailure(error, providerAttempt, contractAttempt + 1),
              )
            }
            await (this.dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
              VISUAL_REVIEW_RETRY_DELAYS_MS[providerAttempt - 1]
                ?? VISUAL_REVIEW_RETRY_DELAYS_MS.at(-1)!,
            )
            continue
          }
          const issues = revisionContractRepairIssues(error)
          if (!issues || contractAttempt + 1 >= MAX_VISUAL_REVIEW_CONTRACT_ATTEMPTS) {
            throw new VisualReviewExecutionError(
              visualReviewFailure(error, providerAttempt, contractAttempt + 1),
            )
          }
          if (chain4) contentSlotCompletion = true
          else contractRepairIssues = issues
          break
        }
      }
    }
    throw new VisualReviewExecutionError(
      visualReviewFailure(lastError, 1, MAX_VISUAL_REVIEW_CONTRACT_ATTEMPTS),
    )
  }

  private async prepare(input: ReviewSlideInput): Promise<ReviewSlideResult & { run: RunRecord }> {
    const inputHash = hashInput({
      tool: 'review_slide_image',
      slideId: input.slideId,
      versionId: input.versionId,
      artifactId: input.artifactId,
      visualIntent: input.visualIntent,
      layout: input.layout,
      visualDirection: input.visualDirection,
    })
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(input.idempotencyKey)
      if (existing) {
        if (existing.id !== input.stepId || existing.inputHash !== inputHash || existing.tool !== 'review_slide_image') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        if (existing.status === 'COMPLETED') {
          return {
            run: transaction.run,
            step: existing,
            review: slideVisualReviewSchema.parse(existing.output),
            replayed: true,
          }
        }
        if (existing.status === 'FAILED') {
          return { run: transaction.run, step: existing, review: null, replayed: true }
        }
        if (existing.status === 'RESERVED') {
          const retrying: StepRecord = {
            ...existing,
            status: 'RUNNING',
            errorCode: null,
            output: null,
            updatedAt: this.dependencies.clock.now().toISOString(),
          }
          transaction.putStep(retrying)
          transaction.appendEvent({
            schemaVersion: CONTRACT_VERSION,
            type: 'tool.started',
            payload: { stepId: retrying.id, tool: retrying.tool, label: '恢复页面视觉质检' },
          })
          return { run: transaction.run, step: retrying, review: null, replayed: false }
        }
        return { run: transaction.run, step: existing, review: null, replayed: false }
      }
      if (!['EXECUTING', 'PAGE_REVIEW', 'REVISING'].includes(transaction.run.status)) {
        throw new Error('RUN_NOT_REVIEWABLE')
      }
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: input.stepId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        inputHash,
        tool: 'review_slide_image',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: now,
        updatedAt: now,
      }
      transaction.putStep(step)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.started',
        payload: { stepId: step.id, tool: step.tool, label: '审查页面视觉素材' },
      })
      return { run: transaction.run, step, review: null, replayed: false }
    })
  }

  private async complete(input: ReviewSlideInput, review: SlideVisualReview): Promise<ReviewSlideResult> {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') {
        return { step, review: slideVisualReviewSchema.parse(step.output), replayed: true }
      }
      if (step.status === 'FAILED') return { step, review: null, replayed: true }
      if (step.status !== 'RUNNING') throw new Error('VISUAL_REVIEW_STEP_STATE_INVALID')
      const now = this.dependencies.clock.now().toISOString()
      const updated: StepRecord = { ...step, status: 'COMPLETED', output: review, errorCode: null, updatedAt: now }
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: {
          stepId: step.id,
          summary: review.approved ? `页面视觉质检通过（${review.visualScore} 分）` : `页面视觉质检未通过（${review.visualScore} 分）`,
        },
      })
      if (!review.approved) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'issue.detected',
          payload: {
            id: `${step.id}:visual-review`,
            category: 'IMAGE_QUALITY',
            severity: (review.qualityImpact ?? 'HARD_BLOCKER') === 'HARD_BLOCKER' ? 'CRITICAL' : 'WARNING',
            summary: review.reasons.join('；').slice(0, 500) || '页面视觉素材未通过质检。',
            slideIds: [input.slideId],
            sourceChunkIds: [],
            status: 'OPEN',
          },
        })
      }
      return { step: updated, review, replayed: false }
    })
  }

  private async fail(input: ReviewSlideInput, diagnostic: VisualReviewFailure): Promise<ReviewSlideResult> {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') {
        return { step, review: slideVisualReviewSchema.parse(step.output), replayed: true }
      }
      if (step.status === 'FAILED') return { step, review: null, replayed: true }
      if (step.status !== 'RUNNING') throw new Error('VISUAL_REVIEW_STEP_STATE_INVALID')
      const now = this.dependencies.clock.now().toISOString()
      const updated: StepRecord = {
        ...step,
        status: 'FAILED',
        errorCode: diagnostic.errorCode,
        output: { diagnostic },
        updatedAt: now,
      }
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode: diagnostic.errorCode, retryable: false },
      })
      return { step: updated, review: null, replayed: false }
    })
  }
}

function visualReviewContractAttemptKey(idempotencyKey: string, contractAttempt: number) {
  return contractAttempt === 0
    ? idempotencyKey
    : `visual-review-contract-repair-${hashInput({ idempotencyKey, contractAttempt })}`
}

function visualReviewFailure(
  error: unknown,
  providerAttempt: number,
  contractAttempt: number,
): VisualReviewFailure {
  if (error instanceof StructuredModelError) {
    return {
      errorCode: error.code,
      providerAttempt,
      maxProviderAttempts: MAX_VISUAL_REVIEW_PROVIDER_ATTEMPTS,
      contractAttempt,
      maxContractAttempts: MAX_VISUAL_REVIEW_CONTRACT_ATTEMPTS,
      model: error.model,
      requestId: error.requestId,
    }
  }
  return {
    errorCode: error instanceof ZodError
      ? 'MODEL_JSON_INVALID'
      : error instanceof Error && /^[A-Z][A-Z0-9_]{2,99}$/.test(error.message)
        ? error.message
        : 'VISUAL_REVIEW_FAILED',
    providerAttempt,
    maxProviderAttempts: MAX_VISUAL_REVIEW_PROVIDER_ATTEMPTS,
    contractAttempt,
    maxContractAttempts: MAX_VISUAL_REVIEW_CONTRACT_ATTEMPTS,
    model: null,
    requestId: null,
  }
}

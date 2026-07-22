import { CONTRACT_VERSION } from '../contracts'
import { slideVisualReviewSchema, type SlideVisualReview } from '../presentation-contracts'
import { hashInput } from './hash'
import type { AgentRepository, ClockPort, RunRecord, StepRecord, VisualReviewPort } from './ports'
import { transitionRun } from './policy'

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
  }>) {}

  async review(input: ReviewSlideInput): Promise<ReviewSlideResult> {
    const prepared = await this.prepare(input)
    if (prepared.replayed) return prepared

    try {
      const raw = await this.dependencies.reviewer.review({
        tenantId: prepared.run.host.tenantId,
        artifactId: input.artifactId,
        visualIntent: input.visualIntent,
        layout: input.layout,
        visualDirection: input.visualDirection,
        idempotencyKey: input.idempotencyKey,
      })
      const review = slideVisualReviewSchema.parse(raw)
      const step = await this.complete(input, review)
      return { step, review, replayed: false }
    } catch {
      const step = await this.fail(input, 'VISUAL_REVIEW_FAILED')
      return { step, review: null, replayed: false }
    }
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

  private async complete(input: ReviewSlideInput, review: SlideVisualReview) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') return step
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
            severity: review.textDetected ? 'CRITICAL' : 'WARNING',
            summary: review.reasons.join('；').slice(0, 500) || '页面视觉素材未通过质检。',
            slideIds: [input.slideId],
            sourceChunkIds: [],
            status: 'OPEN',
          },
        })
      }
      return updated
    })
  }

  private async fail(input: ReviewSlideInput, errorCode: string) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const fromStatus = transaction.run.status
      const transitionRequired = ['EXECUTING', 'PAGE_REVIEW', 'REVISING'].includes(fromStatus)
      const run: RunRecord = transitionRequired
        ? { ...transaction.run, ...transitionRun(transaction.run, 'NEEDS_HUMAN'), updatedAt: now }
        : transaction.run
      const updated: StepRecord = { ...step, status: 'FAILED', errorCode, updatedAt: now }
      if (transitionRequired) transaction.putRun(run)
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode, retryable: false },
      })
      if (transitionRequired) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: fromStatus, to: 'NEEDS_HUMAN', reason: errorCode },
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'HUMAN_REVIEW', summary: '视觉审查执行失败，需要人工处理后重试。' },
        })
      }
      return updated
    })
  }
}

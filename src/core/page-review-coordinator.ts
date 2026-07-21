import { CONTRACT_VERSION } from '../contracts'
import { getActiveBlueprint } from './active-blueprint'
import type { AgentRepository, ClockPort, RunRecord, StepRecord } from './ports'
import { transitionRun } from './policy'
import { VisualReviewRunner, type ReviewSlideResult } from './visual-review-runner'

export type ReviewAllPagesResult = Readonly<{
  status: RunRecord['status']
  approved: number
  rejected: number
  total: number
  reviews: readonly ReviewSlideResult[]
}>

export class PageReviewCoordinator {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    reviewer: VisualReviewRunner
    clock: ClockPort
  }>) {}

  async reviewAll(runId: string): Promise<ReviewAllPagesResult> {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    if (run.status === 'DECK_REVIEW') return this.summary(run)
    if (run.status !== 'PAGE_REVIEW') throw new Error('RUN_NOT_IN_PAGE_REVIEW')
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    const completedImageSteps = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && step.status === 'COMPLETED')
    const imageSteps = blueprint.slides.map((slide) => completedImageSteps
      .map((step) => ({ step, output: this.imageOutput(step) }))
      .filter((candidate) => candidate.output?.slideId === `${runId}:slide:${slide.pageNumber}`
        && candidate.output.round <= run.revisionRound)
      .sort((left, right) => right.output!.round - left.output!.round)[0]?.step ?? null)
    if (imageSteps.some((step) => step === null)) throw new Error('PAGE_ARTIFACTS_INCOMPLETE')

    const reviews: ReviewSlideResult[] = []
    for (const slide of blueprint.slides) {
      const slideId = `${runId}:slide:${slide.pageNumber}`
      const imageStep = imageSteps[slide.pageNumber - 1]
      const output = imageStep ? this.imageOutput(imageStep) : null
      if (!imageStep || !output) throw new Error('PAGE_ARTIFACT_NOT_FOUND')
      const result = await this.dependencies.reviewer.review({
        runId,
        stepId: `step-${runId}-slide-${slide.pageNumber}-review-r${output.round}`,
        idempotencyKey: `${imageStep.idempotencyKey}:review`,
        slideId: output.slideId,
        versionId: output.versionId,
        artifactId: output.artifactId,
        visualIntent: slide.visualIntent,
        layout: slide.layout,
        visualDirection: blueprint.visualDirection,
      })
      reviews.push(result)
      const latest = await this.dependencies.repository.getRun(runId)
      if (!latest || latest.status === 'NEEDS_HUMAN') break
    }

    const rejected = reviews.filter((result) => result.review && !result.review.approved).length
    const approved = reviews.filter((result) => result.review?.approved).length
    if (reviews.some((result) => result.review === null) || rejected > 0) {
      await this.moveToHuman(runId, rejected > 0 ? 'PAGE_REVIEW_REJECTED' : 'PAGE_REVIEW_FAILED')
    } else if (approved === blueprint.slides.length) {
      await this.moveToDeckReview(runId)
    }
    const latest = await this.dependencies.repository.getRun(runId)
    return { status: latest?.status ?? 'FAILED', approved, rejected, total: blueprint.slides.length, reviews }
  }

  private imageOutput(step: StepRecord) {
    const output = step.output as { slideId?: unknown; versionId?: unknown; artifactId?: unknown } | null
    if (!output || typeof output.slideId !== 'string' || typeof output.versionId !== 'string' || typeof output.artifactId !== 'string') return null
    const round = /:r(\d+):/.exec(output.versionId)?.[1]
    return round === undefined ? null : {
      slideId: output.slideId,
      versionId: output.versionId,
      artifactId: output.artifactId,
      round: Number(round),
    }
  }

  private async moveToDeckReview(runId: string) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      if (transaction.run.status === 'DECK_REVIEW') return
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'DECK_REVIEW')
      transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PAGE_REVIEW', to: 'DECK_REVIEW' },
      })
    })
  }

  private async moveToHuman(runId: string, reason: string) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      if (transaction.run.status === 'NEEDS_HUMAN') return
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: transaction.run.status, to: 'NEEDS_HUMAN', reason },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'HUMAN_REVIEW', summary: '至少一页视觉质检未通过，请确认后续局部修订。' },
      })
    })
  }

  private async summary(run: RunRecord): Promise<ReviewAllPagesResult> {
    const candidates = (await this.dependencies.repository.listSteps(run.id))
      .filter((step) => step.tool === 'review_slide_image' && step.status === 'COMPLETED')
      .map((step) => ({ step, revision: this.reviewRevision(step) }))
      .filter((candidate): candidate is { step: StepRecord; revision: { pageNumber: number; round: number } } =>
        candidate.revision !== null && candidate.revision.round <= run.revisionRound)
    const reviews = Array.from({ length: run.slideCount }, (_, index) => candidates
      .filter((candidate) => candidate.revision.pageNumber === index + 1)
      .sort((left, right) => right.revision.round - left.revision.round)[0])
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
      .map(({ step }) => ({ step, review: step.output as ReviewSlideResult['review'], replayed: true }))
    return {
      status: run.status,
      approved: reviews.filter((result) => result.review?.approved).length,
      rejected: reviews.filter((result) => result.review && !result.review.approved).length,
      total: reviews.length,
      reviews,
    }
  }

  private reviewRevision(step: StepRecord) {
    const match = /:slide:(\d+):image:r(\d+):v1:review$/.exec(step.idempotencyKey)
    return match ? { pageNumber: Number(match[1]), round: Number(match[2]) } : null
  }
}

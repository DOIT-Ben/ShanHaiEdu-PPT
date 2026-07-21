import { CONTRACT_VERSION } from '../contracts'
import { getActiveBlueprint } from './active-blueprint'
import { blueprintImageRequirements, latestCompletedAssetStep } from './blueprint-assets'
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
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    if (run.status === 'DECK_REVIEW') return this.summary(run, blueprint)
    if (run.status !== 'PAGE_REVIEW') throw new Error('RUN_NOT_IN_PAGE_REVIEW')
    const requirements = blueprintImageRequirements(run, blueprint)
    const completedImageSteps = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && step.status === 'COMPLETED')
    const imageSteps = requirements.map((requirement) =>
      latestCompletedAssetStep(completedImageSteps, requirement, run.revisionRound))
    if (imageSteps.some((step) => step === null)) throw new Error('PAGE_ARTIFACTS_INCOMPLETE')

    const reviews: ReviewSlideResult[] = []
    for (const [index, requirement] of requirements.entries()) {
      const slide = blueprint.slides.find((candidate) => candidate.pageNumber === requirement.pageNumber)
      if (!slide) throw new Error('BLUEPRINT_SLIDE_NOT_FOUND')
      const imageStep = imageSteps[index]
      const output = imageStep ? this.imageOutput(imageStep) : null
      if (!imageStep || !output) throw new Error('PAGE_ARTIFACT_NOT_FOUND')
      const result = await this.dependencies.reviewer.review({
        runId,
        stepId: `${imageStep.id}:review`,
        idempotencyKey: `${imageStep.idempotencyKey}:review`,
        slideId: output.slideId,
        versionId: output.versionId,
        artifactId: output.artifactId,
        visualIntent: requirement.elementId ? `${slide.visualIntent}；审查独立素材 ${requirement.elementId}` : slide.visualIntent,
        layout: requirement.elementId ? `LAYERED:${requirement.elementId}` : slide.layout,
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
    } else if (approved === requirements.length) {
      await this.moveToDeckReview(runId)
    }
    const latest = await this.dependencies.repository.getRun(runId)
    return { status: latest?.status ?? 'FAILED', approved, rejected, total: requirements.length, reviews }
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

  private async summary(run: RunRecord, blueprint: Awaited<ReturnType<typeof getActiveBlueprint>>): Promise<ReviewAllPagesResult> {
    const imageSteps = await this.dependencies.repository.listSteps(run.id)
    const reviewKeys = new Set(blueprintImageRequirements(run, blueprint).map((requirement) => {
      const imageStep = latestCompletedAssetStep(imageSteps, requirement, run.revisionRound)
      return imageStep ? `${imageStep.idempotencyKey}:review` : ''
    }))
    const reviews = (await this.dependencies.repository.listSteps(run.id))
      .filter((step) => step.tool === 'review_slide_image' && step.status === 'COMPLETED' && reviewKeys.has(step.idempotencyKey))
      .map((step) => ({ step, review: step.output as ReviewSlideResult['review'], replayed: true }))
    return {
      status: run.status,
      approved: reviews.filter((result) => result.review?.approved).length,
      rejected: reviews.filter((result) => result.review && !result.review.approved).length,
      total: reviews.length,
      reviews,
    }
  }

}

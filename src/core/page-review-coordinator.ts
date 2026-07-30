import { CONTRACT_VERSION } from '../contracts'
import { revisionPlanSchema, type PresentationBlueprint } from '../presentation-contracts'
import { mapWithConcurrency } from './concurrency'
import { getActiveBlueprint } from './active-blueprint'
import { blueprintImageRequirements, latestCompletedAssetStep, visualDeckV4AllowedCopy } from './blueprint-assets'
import { hashInput } from './hash'
import { renderAndStoreSlidePreviews, requirePresentationArtifactReferences } from './presentation-render-input'
import type { AgentRepository, ArtifactPort, ClockPort, PresentationRendererPort, RunRecord, StepRecord } from './ports'
import { transitionRun } from './policy'
import { revisionPlanStepKey } from './revision-planning-runner'
import { VisualReviewRunner, type ReviewSlideResult } from './visual-review-runner'

const COMPOSITE_REVIEW_VERSION = 'classroom-v4'

function compositeReviewVersion(deckTitle: string, pageNumber: number) {
  return deckTitle.includes('5以内数的分与合') && pageNumber === 2
    ? 'classroom-v5'
    : COMPOSITE_REVIEW_VERSION
}

export type ReviewAllPagesResult = Readonly<{
  status: RunRecord['status']
  approved: number
  rejected: number
  total: number
  reviews: readonly ReviewSlideResult[]
}>

export class PageReviewCoordinator {
  private readonly reviewConcurrency: number

  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    reviewer: VisualReviewRunner
    artifacts: ArtifactPort
    renderer: PresentationRendererPort
    clock: ClockPort
    reviewConcurrency?: number
  }>) {
    this.reviewConcurrency = dependencies.reviewConcurrency ?? 3
    if (!Number.isSafeInteger(this.reviewConcurrency) || this.reviewConcurrency < 1 || this.reviewConcurrency > 8) {
      throw new Error('REVIEW_CONCURRENCY_INVALID')
    }
  }

  async reviewAll(runId: string): Promise<ReviewAllPagesResult> {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    if (run.status === 'DECK_REVIEW') return this.summary(run, blueprint)
    if (run.status !== 'PAGE_REVIEW') throw new Error('RUN_NOT_IN_PAGE_REVIEW')
    const requirements = blueprintImageRequirements(run, blueprint)
    const fullPageRaster = blueprint.renderMode === 'VISUAL_DECK_V4'
    const completedImageSteps = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && step.status === 'COMPLETED')
    const imageSteps = requirements.map((requirement) =>
      latestCompletedAssetStep(completedImageSteps, requirement, run.revisionRound))
    if (imageSteps.some((step) => step === null)) throw new Error('PAGE_ARTIFACTS_INCOMPLETE')

    const reviews: ReviewSlideResult[] = []
    let stopReviews = false
    const assetReviews = await mapWithConcurrency(requirements, this.reviewConcurrency, async (requirement, index) => {
      if (stopReviews) return null
      const slide = blueprint.slides.find((candidate) => candidate.pageNumber === requirement.pageNumber)
      if (!slide) throw new Error('BLUEPRINT_SLIDE_NOT_FOUND')
      const imageStep = imageSteps[index]
      const output = imageStep ? this.imageOutput(imageStep) : null
      if (!imageStep || !output) throw new Error('PAGE_ARTIFACT_NOT_FOUND')
      const v4Brief = blueprint.visualDeckV4Proposal?.slideBriefs.find((brief) => brief.pageNumber === slide.pageNumber)
      const result = await this.dependencies.reviewer.review({
        runId,
        stepId: `${imageStep.id}:review`,
        idempotencyKey: `${imageStep.idempotencyKey}:review`,
        slideId: output.slideId,
        versionId: output.versionId,
        artifactId: output.artifactId,
        visualIntent: fullPageRaster && v4Brief
          ? `${slide.visualIntent}；允许文字：${visualDeckV4AllowedCopy(v4Brief).join('｜')}；数字：${v4Brief.numbers.join('｜') || '无'}；公式：${v4Brief.formulas.join('｜') || '无'}；允许空格、换行和不改变含义的普通标点差异，禁止替换字词、改变数字或添加未列出的标签`
          : requirement.elementId ? `${slide.visualIntent}；审查独立素材 ${requirement.elementId}` : slide.visualIntent,
        layout: fullPageRaster ? 'VISUAL_DECK_V4' : requirement.elementId ? `LAYERED:${requirement.elementId}` : slide.layout,
        visualDirection: blueprint.visualDirection,
      })
      if (result.review === null) stopReviews = true
      return result
    })
    reviews.push(...assetReviews.filter((result): result is ReviewSlideResult => result !== null))

    let rejected = reviews.filter((result) => result.review && !result.review.approved).length
    if (!fullPageRaster && !reviews.some((result) => result.review === null) && rejected === 0) {
      try {
        const references = await requirePresentationArtifactReferences(this.dependencies.repository, run, blueprint)
        const previews = await renderAndStoreSlidePreviews({
          artifacts: this.dependencies.artifacts,
          renderer: this.dependencies.renderer,
          run,
          blueprint,
          references,
        })
        stopReviews = false
        const compositeReviews = await mapWithConcurrency(previews, this.reviewConcurrency, async (preview) => {
          if (stopReviews) return null
          const slide = blueprint.slides.find((candidate) => candidate.pageNumber === preview.pageNumber)
          if (!slide) throw new Error('BLUEPRINT_SLIDE_NOT_FOUND')
          const reviewVersion = compositeReviewVersion(blueprint.title, slide.pageNumber)
          const key = `${run.id}:slide:${slide.pageNumber}:composite:r${run.revisionRound}:review:${reviewVersion}`
          const result = await this.dependencies.reviewer.review({
            runId,
            stepId: `step-${run.id}-slide-${slide.pageNumber}-composite-review-r${run.revisionRound}-${reviewVersion}`,
            idempotencyKey: key,
            slideId: `${run.id}:slide:${slide.pageNumber}`,
            versionId: `${run.id}:slide:${slide.pageNumber}:composite:r${run.revisionRound}:v1`,
            artifactId: preview.artifactId,
            visualIntent: `${slide.visualIntent}；审查完整组装页面的知识相关性、文字可读性、遮挡、层级和越界`,
            layout: `COMPOSITE:${slide.layout}`,
            visualDirection: blueprint.visualDirection,
          })
          if (result.review === null) stopReviews = true
          return result
        })
        reviews.push(...compositeReviews.filter((result): result is ReviewSlideResult => result !== null))
      } catch {
        await this.moveToHuman(runId, 'PAGE_COMPOSITE_REVIEW_FAILED')
      }
    }

    rejected = reviews.filter((result) => result.review && !result.review.approved).length
    const approved = reviews.filter((result) => result.review?.approved).length
    const total = requirements.length + (fullPageRaster ? 0 : blueprint.slides.length)
    if (reviews.some((result) => result.review === null) || rejected > 0 || reviews.length !== total) {
      const autoRevisionStarted = fullPageRaster
        && rejected > 0
        && reviews.length === total
        && !reviews.some((result) => result.review === null)
        && await this.startAutomaticPageRevision(run, blueprint, imageSteps, reviews)
      if (!autoRevisionStarted) {
        await this.moveToHuman(runId, rejected > 0 ? 'PAGE_REVIEW_REJECTED' : 'PAGE_REVIEW_FAILED')
      }
    } else if (approved === total) {
      await this.moveToDeckReview(runId)
    }
    const latest = await this.dependencies.repository.getRun(runId)
    return { status: latest?.status ?? 'FAILED', approved, rejected, total, reviews }
  }

  private async startAutomaticPageRevision(
    run: RunRecord,
    blueprint: PresentationBlueprint,
    imageSteps: readonly (StepRecord | null)[],
    reviews: readonly ReviewSlideResult[],
  ) {
    if (run.automationLevel !== 'BOUNDED_AUTO') return false
    const existingSteps = await this.dependencies.repository.listSteps(run.id)
    const pageRevisionCount = existingSteps.filter((step) =>
      step.tool === 'plan_page_revision' && step.status === 'COMPLETED').length
    if (pageRevisionCount >= run.maxRevisionRounds) return false
    const targetRevisionRound = run.revisionRound + 1
    const rejected = imageSteps.flatMap((imageStep, index) => {
      if (!imageStep) return []
      const reviewResult = reviews.find((candidate) => candidate.step.idempotencyKey === `${imageStep.idempotencyKey}:review`)
      if (!reviewResult?.review || reviewResult.review.approved || !reviewResult.review.retryInstruction) return []
      const slide = blueprint.slides[index]
      if (!slide) throw new Error('BLUEPRINT_SLIDE_NOT_FOUND')
      return [{ slide, reviewResult }]
    })
    if (rejected.length === 0) return false
    const plan = revisionPlanSchema.parse({
      id: `${run.id}:page-revision-plan:r${targetRevisionRound}`,
      reviewId: `${run.id}:page-review:r${run.revisionRound}`,
      revisionRound: targetRevisionRound,
      createdAt: this.dependencies.clock.now().toISOString(),
      summary: `自动局部重绘 ${rejected.length} 个未通过视觉质检的页面，其他页面保持不变。`,
      operations: rejected.map(({ slide, reviewResult }) => ({
        id: `${run.id}:page-revision:r${targetRevisionRound}:p${slide.pageNumber}`,
        slideId: `${run.id}:slide:${slide.pageNumber}`,
        kind: 'REGENERATE_IMAGE' as const,
        issueIds: [`${run.id}:page-review:r${run.revisionRound}:p${slide.pageNumber}`],
        instruction: reviewResult.review!.retryInstruction!,
        sourceChunkIds: slide.sourceChunkIds,
      })),
    })
    const idempotencyKey = revisionPlanStepKey(run.id, targetRevisionRound)
    const inputHash = hashInput({ tool: 'plan_revision', origin: 'page_review', plan })
    await this.dependencies.repository.transact(run.id, (transaction) => {
      const existing = transaction.getStep(idempotencyKey)
      if (existing) {
        if (existing.inputHash !== inputHash || existing.tool !== 'plan_page_revision') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        return
      }
      if (transaction.run.status !== 'PAGE_REVIEW' || transaction.run.revisionRound !== run.revisionRound) {
        throw new Error('RUN_PAGE_REVIEW_VERSION_CONFLICT')
      }
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'REVISING')
      transaction.putStep({
        id: `step-${run.id}-page-revision-plan-r${targetRevisionRound}`,
        runId: run.id,
        idempotencyKey,
        inputHash,
        tool: 'plan_page_revision',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: plan,
        createdAt: now,
        updatedAt: now,
      })
      transaction.putRun({ ...transaction.run, ...policy, revisionRound: targetRevisionRound, updatedAt: now })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: `step-${run.id}-page-revision-plan-r${targetRevisionRound}`, summary: plan.summary },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PAGE_REVIEW', to: 'REVISING', reason: 'PAGE_REVIEW_REJECTED' },
      })
    })
    return true
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
      const fromStatus = transaction.run.status
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: fromStatus, to: 'NEEDS_HUMAN', reason },
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
    if (blueprint.renderMode !== 'VISUAL_DECK_V4') {
      for (const slide of blueprint.slides) {
        const reviewVersion = compositeReviewVersion(blueprint.title, slide.pageNumber)
        reviewKeys.add(`${run.id}:slide:${slide.pageNumber}:composite:r${run.revisionRound}:review:${reviewVersion}`)
      }
    }
    const reviews = (await this.dependencies.repository.listSteps(run.id))
      .filter((step) => step.tool === 'review_slide_image' && step.status === 'COMPLETED' && reviewKeys.has(step.idempotencyKey))
      .map((step) => ({ step, review: step.output as ReviewSlideResult['review'], replayed: true }))
    return {
      status: run.status,
      approved: reviews.filter((result) => result.review?.approved).length,
      rejected: reviews.filter((result) => result.review && !result.review.approved).length,
      total: blueprintImageRequirements(run, blueprint).length
        + (blueprint.renderMode === 'VISUAL_DECK_V4' ? 0 : blueprint.slides.length),
      reviews,
    }
  }

}

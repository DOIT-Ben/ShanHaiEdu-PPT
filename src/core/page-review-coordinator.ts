import { CONTRACT_VERSION } from '../contracts'
import sharp from 'sharp'
import { revisionPlanSchema, type PresentationBlueprint } from '../presentation-contracts'
import { mapWithConcurrency } from './concurrency'
import { beginTechnicalRecovery } from './technical-recovery'
import { getActiveBlueprint } from './active-blueprint'
import {
  blueprintImageRequirements,
  hasVisualDeckV4AspectRatio,
  latestCompletedAssetStep,
  visualDeckV4AllowedCopy,
} from './blueprint-assets'
import { hashInput } from './hash'
import { renderAndStoreSlidePreviews, requirePresentationArtifactReferences } from './presentation-render-input'
import type { AgentRepository, ArtifactPort, ClockPort, PresentationRendererPort, RunRecord, StepRecord } from './ports'
import { transitionRun } from './policy'
import { revisionPlanStepKey } from './revision-planning-runner'
import { visualDeckV4RevisionInstructions } from './revision-instruction-memory'
import { VisualReviewRunner, type ReviewSlideResult } from './visual-review-runner'
import {
  allPageNumbers,
  appendFixedIssueResolutions,
  appendV4LifecycleEvent,
  classifyOpenQualityIssuesForAcceptance,
  failVisualDeckV4Transaction,
  revisionDetails,
} from './v4-lifecycle'

const COMPOSITE_REVIEW_VERSION = 'classroom-v4'

type AutomaticPageRevisionOutcome = 'STARTED' | 'EXHAUSTED' | 'NOT_ALLOWED'

type V4AspectRatioViolation = Readonly<{
  pageNumber: number
  width: number
  height: number
  issueId: string
}>

const V4_ASPECT_RATIO_REPAIR_INSTRUCTION = '重新生成当前整页幻灯片，严格使用横向 16:9 输出；实际像素宽高与 16:9 的相对误差不得超过 3%。保留已批准的页面施工单、可见文字、数字、公式和教学事实，不得裁切源图。'

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
    onReviewCompleted?: () => void
  }>) {
    this.reviewConcurrency = dependencies.reviewConcurrency ?? 1
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
    await this.dependencies.repository.transact(runId, (transaction) => {
      appendV4LifecycleEvent(transaction, 'page_review.started', {
        completed: 0,
        total: transaction.run.slideCount,
        pageNumbers: allPageNumbers(transaction.run),
      })
    })
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
          ? `${slide.visualIntent}；允许文字：${visualDeckV4AllowedCopy(v4Brief).join('｜')}；数字：${v4Brief.numbers.join('｜') || '无'}；公式：${v4Brief.formulas.join('｜') || '无'}；非展示事实核对项（只用于核对对象、关系、数量和结论，不得要求画面显示这些句子）：${v4Brief.facts.join('｜') || '无'}；允许空格、换行和不改变含义的普通标点差异，禁止替换字词、改变数字或添加未列出的标签`
          : requirement.elementId ? `${slide.visualIntent}；审查独立素材 ${requirement.elementId}` : slide.visualIntent,
        layout: fullPageRaster ? 'VISUAL_DECK_V4' : requirement.elementId ? `LAYERED:${requirement.elementId}` : slide.layout,
        visualDirection: blueprint.visualDirection,
        ...(run.v4StructuredGenerationProtocol ? { structuredGenerationProtocol: run.v4StructuredGenerationProtocol } : {}),
      })
      this.dependencies.onReviewCompleted?.()
      if (result.review === null) stopReviews = true
      return result
    })
    reviews.push(...assetReviews.filter((result): result is ReviewSlideResult => result !== null))

    const aspectRatioViolations = fullPageRaster
      ? await this.v4AspectRatioViolations(run, imageSteps)
      : []
    await this.recordV4AspectRatioViolations(run.id, aspectRatioViolations)
    const aspectRatioInvalidPageNumbers = new Set(aspectRatioViolations.map((violation) => violation.pageNumber))
    let rejected = reviews.filter((result) => result.review && !result.review.approved).length
      + aspectRatioViolations.length
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
            ...(run.v4StructuredGenerationProtocol ? { structuredGenerationProtocol: run.v4StructuredGenerationProtocol } : {}),
          })
          this.dependencies.onReviewCompleted?.()
          if (result.review === null) stopReviews = true
          return result
        })
        reviews.push(...compositeReviews.filter((result): result is ReviewSlideResult => result !== null))
      } catch {}
    }

    rejected = reviews.filter((result) => result.review && !result.review.approved).length
      + aspectRatioViolations.length
    const approved = reviews.filter((result) => result.review?.approved
      && !aspectRatioInvalidPageNumbers.has(this.reviewPageNumber(run.id, result.step) ?? -1)).length
    const total = requirements.length + (fullPageRaster ? 0 : blueprint.slides.length)
    const executionFailed = reviews.some((result) => result.review === null) || reviews.length !== total
    if (!executionFailed) {
      await this.resolveSupersededPageIssues(run, reviews)
    }
    if (executionFailed || rejected > 0) {
      const automaticRevision = fullPageRaster
        && !executionFailed
        && rejected > 0
        && reviews.length === total
        ? await this.startAutomaticPageRevision(run, blueprint, imageSteps, reviews, aspectRatioViolations)
        : 'NOT_ALLOWED'
      if (automaticRevision !== 'STARTED') {
        const problemPageNumbers = this.problemPageNumbers(
          blueprint,
          imageSteps,
          reviews,
          aspectRatioInvalidPageNumbers,
        )
        if (fullPageRaster && !executionFailed && rejected > 0 && automaticRevision === 'EXHAUSTED') {
          await this.moveToDeckReview(runId, total, {
            reason: 'PAGE_REVIEW_REJECTED',
            pageNumbers: problemPageNumbers,
            acceptedIssueIds: [
              ...reviews
                .filter((result) => result.review && !result.review.approved)
                .map((result) => `${result.step.id}:visual-review`),
              ...aspectRatioViolations.map((violation) => violation.issueId),
            ],
          })
        } else {
          await this.moveToHuman(runId, executionFailed ? 'PAGE_REVIEW_FAILED' : 'PAGE_REVIEW_REJECTED', {
            completed: reviews.filter((result) => result.review !== null).length,
            total,
            pageNumbers: problemPageNumbers,
          })
        }
      }
    } else if (approved === total) {
      await this.moveToDeckReview(runId, total)
    }
    const latest = await this.dependencies.repository.getRun(runId)
    return { status: latest?.status ?? 'FAILED', approved, rejected, total, reviews }
  }

  private async startAutomaticPageRevision(
    run: RunRecord,
    blueprint: PresentationBlueprint,
    imageSteps: readonly (StepRecord | null)[],
    reviews: readonly ReviewSlideResult[],
    aspectRatioViolations: readonly V4AspectRatioViolation[],
  ): Promise<AutomaticPageRevisionOutcome> {
    if (run.automationLevel !== 'BOUNDED_AUTO') return 'NOT_ALLOWED'
    if (run.revisionRound >= run.maxRevisionRounds) return 'EXHAUSTED'
    const targetRevisionRound = run.revisionRound + 1
    const rejected = imageSteps.flatMap((imageStep, index) => {
      if (!imageStep) return []
      const reviewResult = reviews.find((candidate) => candidate.step.idempotencyKey === `${imageStep.idempotencyKey}:review`)
      if (!reviewResult?.review || reviewResult.review.approved || !reviewResult.review.retryInstruction) return []
      const slide = blueprint.slides[index]
      if (!slide) throw new Error('BLUEPRINT_SLIDE_NOT_FOUND')
      return [{ slide, reviewResult }]
    })
    const aspectRatioRepair = aspectRatioViolations.length > 0
    const targets = aspectRatioRepair
      ? blueprint.slides.map((slide) => ({
          slide,
          reviewResult: rejected.find((candidate) => candidate.slide.pageNumber === slide.pageNumber)?.reviewResult,
        }))
      : rejected
    if (targets.length === 0) return 'EXHAUSTED'
    const aspectRatioIssueIds = aspectRatioViolations.map((violation) => violation.issueId)
    const steps = await this.dependencies.repository.listSteps(run.id)
    try {
      for (const { slide, reviewResult } of targets) {
        const instruction = [
          reviewResult?.review?.retryInstruction,
          aspectRatioRepair ? V4_ASPECT_RATIO_REPAIR_INSTRUCTION : '',
        ].filter(Boolean).join(' ')
        visualDeckV4RevisionInstructions({
          runId: run.id,
          pageNumber: slide.pageNumber,
          revisionRound: targetRevisionRound,
          steps,
          currentInstructions: [instruction],
        })
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'V4_REVISION_INSTRUCTION_BUDGET_EXCEEDED') return 'EXHAUSTED'
      throw error
    }
    const plan = revisionPlanSchema.parse({
      id: `${run.id}:page-revision-plan:r${targetRevisionRound}`,
      reviewId: `${run.id}:page-review:r${run.revisionRound}`,
      revisionRound: targetRevisionRound,
      createdAt: this.dependencies.clock.now().toISOString(),
      summary: aspectRatioRepair
        ? `检测到页面比例超出 16:9 的 3% 容差，自动整套重绘 ${targets.length} 个页面。`
        : `自动局部重绘 ${targets.length} 个未通过视觉质检的页面，其他页面保持不变。`,
      operations: targets.map(({ slide, reviewResult }) => ({
        id: `${run.id}:page-revision:r${targetRevisionRound}:p${slide.pageNumber}`,
        slideId: `${run.id}:slide:${slide.pageNumber}`,
        kind: 'REGENERATE_IMAGE' as const,
        issueIds: [...new Set([
          ...(reviewResult ? [`${reviewResult.step.id}:visual-review`] : []),
          ...aspectRatioIssueIds,
        ])],
        instruction: [
          reviewResult?.review?.retryInstruction,
          aspectRatioRepair ? V4_ASPECT_RATIO_REPAIR_INSTRUCTION : '',
        ].filter(Boolean).join(' '),
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
      appendV4LifecycleEvent(transaction, 'page_review.completed', {
        completed: reviews.length,
        total: reviews.length,
        pageNumbers: targets.map(({ slide }) => slide.pageNumber),
        revisionRound: run.revisionRound,
        reason: 'PAGE_REVIEW_REJECTED',
        retryable: true,
      })
      appendV4LifecycleEvent(transaction, 'revision.started', {
        completed: 0,
        total: targets.length,
        reason: 'PAGE_REVIEW_REJECTED',
        retryable: true,
        ...revisionDetails(plan, true),
      })
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
    return 'STARTED'
  }

  private async resolveSupersededPageIssues(run: RunRecord, reviews: readonly ReviewSlideResult[]) {
    if (run.revisionRound === 0) return
    const planSteps = (await this.dependencies.repository.listSteps(run.id))
      .filter((step) => ['plan_revision', 'plan_page_revision'].includes(step.tool) && step.status === 'COMPLETED')
    const planStep = planSteps
      .find((step) => step.idempotencyKey === revisionPlanStepKey(run.id, run.revisionRound)
      )
    if (!planStep) return
    const plan = revisionPlanSchema.parse(planStep.output)
    const approvedSlideIds = new Set(reviews
      .filter((result) => result.review?.approved)
      .map((result) => this.reviewSlideId(run.id, result.step)))
    const repairedSlideIds = new Set(plan.operations
      .map((operation) => operation.slideId)
      .filter((slideId) => approvedSlideIds.has(slideId)))
    if (repairedSlideIds.size === 0) return
    await this.dependencies.repository.transact(run.id, (transaction) => {
      const repairedIssueIds = planSteps.flatMap((candidate) => {
        const candidatePlan = revisionPlanSchema.parse(candidate.output)
        return candidatePlan.operations
          .filter((operation) => repairedSlideIds.has(operation.slideId))
          .flatMap((operation) => operation.issueIds)
      })
      appendFixedIssueResolutions(transaction, repairedIssueIds)
    })
  }

  private reviewSlideId(runId: string, step: StepRecord) {
    const pageNumber = this.reviewPageNumber(runId, step)
    return pageNumber === null ? null : `${runId}:slide:${pageNumber}`
  }

  private reviewPageNumber(runId: string, step: StepRecord) {
    const prefix = `${runId}:slide:`
    if (!step.idempotencyKey.startsWith(prefix)) return null
    const pageNumber = Number(step.idempotencyKey.slice(prefix.length).split(':')[0])
    return Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber : null
  }

  private async v4AspectRatioViolations(
    run: RunRecord,
    imageSteps: readonly (StepRecord | null)[],
  ): Promise<readonly V4AspectRatioViolation[]> {
    const results = await mapWithConcurrency(imageSteps, this.reviewConcurrency, async (imageStep, index) => {
      if (!imageStep) return null
      const output = this.imageOutput(imageStep)
      if (!output) return null
      const artifact = await this.dependencies.artifacts.get({
        tenantId: run.host.tenantId,
        artifactId: output.artifactId,
      })
      if (!artifact || !artifact.mimeType.startsWith('image/') || artifact.bytes.length === 0) return null
      const metadata = await sharp(artifact.bytes).metadata().catch(() => null)
      if (!metadata?.width || !metadata.height || hasVisualDeckV4AspectRatio(metadata.width, metadata.height)) return null
      const pageNumber = index + 1
      return {
        pageNumber,
        width: metadata.width,
        height: metadata.height,
        issueId: `${imageStep.id}:aspect-ratio`,
      }
    })
    return results.filter((result): result is V4AspectRatioViolation => result !== null)
  }

  private async recordV4AspectRatioViolations(
    runId: string,
    violations: readonly V4AspectRatioViolation[],
  ) {
    if (violations.length === 0) return
    await this.dependencies.repository.transact(runId, (transaction) => {
      for (const violation of violations) {
        if (transaction.listEvents().some((event) => event.type === 'issue.detected' && event.payload.id === violation.issueId)) continue
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'issue.detected',
          payload: {
            id: violation.issueId,
            category: 'IMAGE_QUALITY',
            severity: 'CRITICAL',
            summary: `第 ${violation.pageNumber} 页实际像素 ${violation.width}×${violation.height} 与 16:9 的相对误差超过 3%。`,
            slideIds: [`${transaction.run.id}:slide:${violation.pageNumber}`],
            sourceChunkIds: [],
            status: 'OPEN',
            repairDomain: 'ASSET',
          },
        })
      }
    })
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

  private async moveToDeckReview(
    runId: string,
    total: number,
    accepted?: Readonly<{
      reason: 'PAGE_REVIEW_REJECTED'
      pageNumbers: readonly number[]
      acceptedIssueIds: readonly string[]
    }>,
  ) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      if (transaction.run.status === 'DECK_REVIEW') return
      if (accepted && transaction.run.automationLevel !== 'BOUNDED_AUTO') {
        throw new Error('SYSTEM_QUALITY_POLICY_NOT_ALLOWED')
      }
      const now = this.dependencies.clock.now().toISOString()
      const disposition = accepted
        ? classifyOpenQualityIssuesForAcceptance(transaction, accepted.acceptedIssueIds)
        : { acceptedIssueIds: [] as string[], blockingIssueIds: [] as string[] }
      if (disposition.blockingIssueIds.length > 0) {
        appendV4LifecycleEvent(transaction, 'page_review.completed', {
          completed: total,
          total,
          pageNumbers: accepted?.pageNumbers ?? allPageNumbers(transaction.run),
          reason: accepted?.reason ?? 'PAGE_REVIEW_REJECTED',
          retryable: false,
        })
        failVisualDeckV4Transaction({
          transaction,
          clock: this.dependencies.clock,
          errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT',
          reason: 'PAGE_REVIEW_REJECTED',
        })
        return
      }
      const policy = transitionRun(transaction.run, 'DECK_REVIEW')
      const next = {
        ...transaction.run,
        ...policy,
        qualityDisposition: 'PENDING' as const,
        qualityPolicyAudit: null,
      }
      transaction.putRun({ ...next, updatedAt: now })
      appendV4LifecycleEvent(transaction, 'page_review.completed', {
        completed: total,
        total,
        pageNumbers: accepted?.pageNumbers ?? allPageNumbers(transaction.run),
        reason: accepted?.reason ?? null,
        retryable: accepted ? false : null,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PAGE_REVIEW', to: 'DECK_REVIEW' },
      })
      appendV4LifecycleEvent(transaction, 'deck_review.started', {
        completed: 0,
        total: 1,
        pageNumbers: allPageNumbers(transaction.run),
      })
    })
  }

  private async moveToHuman(
    runId: string,
    reason: string,
    progress?: Readonly<{ completed: number; total: number; pageNumbers?: readonly number[] }>,
  ) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      const now = this.dependencies.clock.now().toISOString()
      const fromStatus = transaction.run.status
      const technical = transaction.run.presentationMode === 'VISUAL_DECK_V4' && !reason.includes('REJECTED')
        ? beginTechnicalRecovery(transaction, this.dependencies.clock, reason)
        : null
      if (technical || fromStatus === 'RECOVERING') {
        for (const step of transaction.listSteps()) {
          if (step.tool !== 'review_slide_image' || step.status !== 'FAILED') continue
          transaction.putStep({ ...step, status: 'RESERVED', errorCode: null, output: null, updatedAt: now })
        }
        appendV4LifecycleEvent(transaction, 'page_review.completed', {
          completed: progress?.completed ?? 0,
          total: progress?.total ?? transaction.run.slideCount,
          pageNumbers: progress?.pageNumbers ?? allPageNumbers(transaction.run),
          reason: 'PAGE_REVIEW_FAILED',
          retryable: technical?.technicalRecovery?.retryable ?? false,
        })
        return
      }
      if (transaction.run.presentationMode === 'VISUAL_DECK_V4'
        && transaction.run.automationLevel === 'BOUNDED_AUTO'
        && reason.includes('REJECTED')) {
        appendV4LifecycleEvent(transaction, 'page_review.completed', {
          completed: progress?.completed ?? 0,
          total: progress?.total ?? transaction.run.slideCount,
          pageNumbers: progress?.pageNumbers ?? allPageNumbers(transaction.run),
          reason: 'PAGE_REVIEW_REJECTED',
          retryable: false,
        })
        failVisualDeckV4Transaction({
          transaction,
          clock: this.dependencies.clock,
          errorCode: 'QUALITY_REMEDIATION_EXHAUSTED',
          reason: 'REVISION_LIMIT_REACHED',
        })
        return
      }
      if (fromStatus !== 'NEEDS_HUMAN') {
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
      }
      appendV4LifecycleEvent(transaction, 'page_review.completed', {
        completed: progress?.completed ?? 0,
        total: progress?.total ?? transaction.run.slideCount,
        pageNumbers: progress?.pageNumbers ?? allPageNumbers(transaction.run),
        reason: reason.includes('REJECTED') ? 'PAGE_REVIEW_REJECTED' : 'PAGE_REVIEW_FAILED',
        retryable: reason.includes('REJECTED'),
        requiresUserAction: true,
        nextAction: 'REVIEW_RESULT',
      })
    })
  }

  private problemPageNumbers(
    blueprint: PresentationBlueprint,
    imageSteps: readonly (StepRecord | null)[],
    reviews: readonly ReviewSlideResult[],
    aspectRatioInvalidPageNumbers: ReadonlySet<number> = new Set(),
  ) {
    return imageSteps.flatMap((imageStep, index) => {
      const pageNumber = blueprint.slides[index]?.pageNumber
      if (!pageNumber) return []
      if (!imageStep) return [pageNumber]
      if (aspectRatioInvalidPageNumbers.has(pageNumber)) return [pageNumber]
      const result = reviews.find((candidate) => candidate.step.idempotencyKey === `${imageStep.idempotencyKey}:review`)
      return result?.review?.approved ? [] : [pageNumber]
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

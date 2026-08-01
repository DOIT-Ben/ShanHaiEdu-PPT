import { CONTRACT_VERSION } from '../contracts'
import { revisionPlanSchema } from '../presentation-contracts'
import { getActiveBlueprint } from './active-blueprint'
import {
  blueprintElementAssetKey,
  blueprintImageRequirements,
  completeVisualDeckV4RevisionPrompt,
  VISUAL_DECK_V4_NEGATIVE_PROMPT,
} from './blueprint-assets'
import { hashInput } from './hash'
import { isMediaFailureStepStatus, MediaStepRunner } from './media-step-runner'
import type { AgentRepository, ClockPort, RunRecord, StepRecord } from './ports'
import { visualDeckV4RevisionInstructions } from './revision-instruction-memory'
import { evaluateBudget, transitionRun } from './policy'
import { revisionPlanStepKey } from './revision-planning-runner'
import {
  allPageNumbers,
  appendV4LifecycleEvent,
  isVisualDeckV4,
  revisionDetails,
  v4LifecyclePayload,
} from './v4-lifecycle'

export type RevisionMediaResult = Readonly<{
  status: RunRecord['status']
  completed: number
  submitted: number
  total: number
}>

export class RevisionMediaCoordinator {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    media: MediaStepRunner
    clock: ClockPort
  }>) {}

  async submit(runId: string, unitBudgetUnits: number): Promise<RevisionMediaResult> {
    if (!Number.isSafeInteger(unitBudgetUnits) || unitBudgetUnits <= 0) throw new Error('INVALID_UNIT_BUDGET')
    const run = await this.requireRun(runId)
    if (run.status === 'PAUSED' || run.status === 'NEEDS_HUMAN') return this.summary(run)
    if (run.status !== 'REVISING') throw new Error('RUN_NOT_REVISING')
    const targets = await this.targets(run)
    if (targets.length === 0) throw new Error('REVISION_MEDIA_NOT_REQUIRED')
    const steps = await this.currentSteps(run, targets)
    const stepsByKey = new Map(steps.map((step) => [step.idempotencyKey, step]))
    const pending = targets.filter((target) => {
      const existing = stepsByKey.get(target.idempotencyKey)
      return !existing || ['RESERVED', 'SUBMITTING'].includes(existing.status)
    })
    const newTargetCount = pending.filter((target) => !stepsByKey.has(target.idempotencyKey)).length
    const decision = evaluateBudget(run, newTargetCount * unitBudgetUnits)
    if (newTargetCount > 0 && !decision.allowed && decision.reason === 'BUDGET_EXCEEDED') {
      await this.pauseForBudget(run, newTargetCount * unitBudgetUnits)
      return { status: 'PAUSED', completed: 0, submitted: steps.length, total: targets.length }
    }
    if (newTargetCount > 0 && !decision.allowed) throw new Error(decision.reason)

    for (const target of pending) {
      const key = target.idempotencyKey
      const result = await this.dependencies.media.submitSlideImage({
        runId,
        stepId: target.stepId,
        idempotencyKey: key,
        slideId: target.slideId,
        versionId: target.versionId,
        prompt: target.prompt,
        ...(target.negativePrompt ? { negativePrompt: target.negativePrompt } : {}),
        model: run.imageModel,
        budgetUnits: unitBudgetUnits,
        aspectRatio: target.aspectRatio,
        backgroundMode: target.backgroundMode,
        ...(target.elementId ? { elementId: target.elementId } : {}),
        ...(target.assetReuseKey ? { assetReuseKey: target.assetReuseKey } : {}),
      })
      if (isMediaFailureStepStatus(result.step.status)) {
        await this.failV4Revision(run, result.step, targets.length)
        break
      }
      const latest = await this.dependencies.repository.getRun(runId)
      if (!latest || latest.status === 'NEEDS_HUMAN' || latest.status === 'PAUSED') break
    }
    const latest = await this.requireRun(runId)
    return {
      status: latest.status,
      completed: 0,
      submitted: (await this.currentSteps(latest, targets)).length,
      total: targets.length,
    }
  }

  async refresh(runId: string): Promise<RevisionMediaResult> {
    const run = await this.requireRun(runId)
    const targets = await this.targets(run)
    const initialSteps = await this.currentSteps(run, targets)
    const initialFailure = initialSteps.find((step) => isMediaFailureStepStatus(step.status))
    if (initialFailure) {
      await this.failV4Revision(run, initialFailure, targets.length)
      return this.summary(await this.requireRun(runId))
    }
    if (run.status === 'PAGE_REVIEW') return this.summary(run)
    if (run.status !== 'REVISING') return this.summary(run)
    for (const step of initialSteps.filter((candidate) => ['WAITING', 'RELEASING'].includes(candidate.status))) {
      await this.dependencies.media.refreshSlideImage(runId, step.idempotencyKey)
      const latest = await this.requireRun(runId)
      if (latest.status === 'NEEDS_HUMAN') break
    }
    const refreshed = await this.currentSteps(run, targets)
    const failed = refreshed.find((step) => isMediaFailureStepStatus(step.status))
    const completed = refreshed.filter((step) => step.status === 'COMPLETED' && this.artifactId(step)).length
    const latest = await this.requireRun(runId)
    const details = await this.details(run)
    if (!failed && completed === targets.length && latest.status === 'REVISING') {
      await this.dependencies.repository.transact(runId, (transaction) => {
        const now = this.dependencies.clock.now().toISOString()
        const policy = transitionRun(transaction.run, 'PAGE_REVIEW')
        transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
        appendV4LifecycleEvent(transaction, 'revision.progress', {
          completed,
          total: targets.length,
          ...details,
        })
        appendV4LifecycleEvent(transaction, 'revision.completed', {
          completed,
          total: targets.length,
          ...details,
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'REVISING', to: 'PAGE_REVIEW' },
        })
        appendV4LifecycleEvent(transaction, 'page_review.started', {
          completed: 0,
          total: transaction.run.slideCount,
          pageNumbers: allPageNumbers(transaction.run),
        })
      })
    } else if (failed) {
      await this.failV4Revision(latest, failed, targets.length)
    } else if (isVisualDeckV4(latest)) {
      await this.dependencies.repository.transact(runId, (transaction) => {
        appendV4LifecycleEvent(transaction, 'revision.progress', {
          completed,
          total: targets.length,
          ...details,
        })
      })
    }
    const finalRun = await this.requireRun(runId)
    return { status: finalRun.status, completed, submitted: refreshed.length, total: targets.length }
  }

  private async targets(run: RunRecord) {
    const blueprint = await getActiveBlueprint(this.dependencies.repository, run.id, run.revisionRound)
    const steps = await this.dependencies.repository.listSteps(run.id)
    const step = steps
      .find((candidate) => candidate.idempotencyKey === revisionPlanStepKey(run.id, run.revisionRound)
        && candidate.status === 'COMPLETED')
    if (!step) throw new Error('REVISION_PLAN_NOT_READY')
    const plan = revisionPlanSchema.parse(step.output)
    if (blueprint.renderMode === 'LAYERED_COURSEWARE_V3') {
      const requirements = blueprintImageRequirements(run, blueprint)
      const targets = plan.operations.filter((operation) => operation.kind === 'REGENERATE_IMAGE').map((operation) => {
        const pageNumber = Number(operation.slideId.split(':').at(-1))
        const slide = blueprint.slides[pageNumber - 1]
        if (!slide?.layeredDesign || !operation.targetElementId) throw new Error('REVISION_TARGET_ELEMENT_REQUIRED')
        const element = slide.layeredDesign.elements.find((candidate) => candidate.kind === 'IMAGE'
          && candidate.elementId === operation.targetElementId)
        if (!element || element.kind !== 'IMAGE') throw new Error('REVISION_TARGET_ELEMENT_INVALID')
        const assetKey = blueprintElementAssetKey(slide, element)
        const requirement = requirements.find((candidate) => candidate.assetKey === assetKey)
        if (!requirement) throw new Error('REVISION_ASSET_REQUIREMENT_NOT_FOUND')
        return {
          pageNumber,
          elementId: element.elementId,
          assetReuseKey: element.reuseKey ?? null,
          idempotencyKey: requirement.idempotencyKey,
          stepId: `step-${run.id}-asset-${hashInput(assetKey).slice(0, 20)}-r${run.revisionRound}`,
          slideId: `${run.id}:slide:${pageNumber}`,
          versionId: `${run.id}:slide:${pageNumber}:element:${element.elementId}:r${run.revisionRound}:v1`,
          prompt: `${element.prompt} Quality correction: ${operation.instruction}`.slice(0, 3_000),
          negativePrompt: element.negativePrompt,
          aspectRatio: element.aspectRatio,
          backgroundMode: element.backgroundMode,
        }
      })
      return [...new Map(targets.map((target) => [target.idempotencyKey, target])).values()]
    }
    const byPage = new Map<number, string[]>()
    const rasterOperations = blueprint.renderMode === 'VISUAL_DECK_V4'
      ? plan.operations
      : plan.operations.filter((item) => item.kind === 'REGENERATE_IMAGE' || item.kind === 'RELAYOUT')
    for (const operation of rasterOperations) {
      const pageNumber = Number(operation.slideId.split(':').at(-1))
      byPage.set(pageNumber, [
        ...(byPage.get(pageNumber) ?? []),
        operation.instruction,
      ])
    }
    return [...byPage].map(([pageNumber, instructions]) => {
      const slide = blueprint.slides[pageNumber - 1]
      if (!slide) throw new Error('REVISION_PLAN_SLIDE_REFERENCE_INVALID')
      const revisionInstructions = blueprint.renderMode === 'VISUAL_DECK_V4'
        ? visualDeckV4RevisionInstructions({
            runId: run.id,
            pageNumber,
            revisionRound: run.revisionRound,
            steps,
            currentInstructions: instructions,
          })
        : instructions
      return {
        pageNumber,
        elementId: null,
        assetReuseKey: null,
        idempotencyKey: this.imageKey(run, pageNumber),
        stepId: `step-${run.id}-slide-${pageNumber}-image-r${run.revisionRound}`,
        slideId: `${run.id}:slide:${pageNumber}`,
        versionId: `${run.id}:slide:${pageNumber}:r${run.revisionRound}:v1`,
        prompt: blueprint.renderMode === 'VISUAL_DECK_V4'
          ? completeVisualDeckV4RevisionPrompt(blueprint, slide, revisionInstructions)
          : `Quality correction for this page only: ${instructions.join(' ')} Preserve the approved page brief and all allowed copy exactly. ${slide.visualPrompt}`.slice(0, 3_000),
        negativePrompt: blueprint.renderMode === 'VISUAL_DECK_V4' ? VISUAL_DECK_V4_NEGATIVE_PROMPT : null,
        aspectRatio: '16:9' as const,
        backgroundMode: 'OPAQUE' as const,
      }
    })
  }

  private async currentSteps(run: RunRecord, targets: readonly Readonly<{ idempotencyKey: string }>[]) {
    const keys = new Set(targets.map((target) => target.idempotencyKey))
    return (await this.dependencies.repository.listSteps(run.id))
      .filter((step) => step.tool === 'generate_slide_image' && keys.has(step.idempotencyKey))
  }

  private async details(run: RunRecord) {
    const step = (await this.dependencies.repository.listSteps(run.id))
      .find((candidate) => candidate.idempotencyKey === revisionPlanStepKey(run.id, run.revisionRound)
        && candidate.status === 'COMPLETED')
    if (!step) throw new Error('REVISION_PLAN_NOT_READY')
    return revisionDetails(revisionPlanSchema.parse(step.output), step.tool === 'plan_page_revision')
  }

  private async failV4Revision(run: RunRecord, failed: StepRecord, total: number) {
    if (!isVisualDeckV4(run)) return
    const details = await this.details(run)
    const completed = (await this.currentSteps(run, await this.targets(run)))
      .filter((step) => step.status === 'COMPLETED' && this.artifactId(step)).length
    await this.dependencies.repository.transact(run.id, (transaction) => {
      const fromStatus = transaction.run.status
      if (fromStatus === 'REVISING') {
        const now = this.dependencies.clock.now().toISOString()
        const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
        transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'REVISING', to: 'NEEDS_HUMAN', reason: failed.errorCode ?? 'REVISION_MEDIA_FAILED' },
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'HUMAN_REVIEW', summary: '局部重绘失败，需要人工核对后重试。' },
        })
      }
      appendV4LifecycleEvent(transaction, 'revision.completed', {
        completed,
        total,
        ...details,
        reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
        retryable: false,
        requiresUserAction: true,
        nextAction: 'REVIEW_RESULT',
      })
    })
  }

  private imageKey(run: RunRecord, pageNumber: number) {
    return `${run.id}:slide:${pageNumber}:image:r${run.revisionRound}:v1`
  }

  private artifactId(step: StepRecord) {
    const output = step.output as { artifactId?: unknown } | null
    return output && typeof output.artifactId === 'string' ? output.artifactId : null
  }

  private async summary(run: RunRecord): Promise<RevisionMediaResult> {
    const targets = await this.targets(run)
    const steps = await this.currentSteps(run, targets)
    return {
      status: run.status,
      completed: steps.filter((step) => step.status === 'COMPLETED' && this.artifactId(step)).length,
      submitted: steps.length,
      total: targets.length,
    }
  }

  private async pauseForBudget(run: RunRecord, required: number) {
    await this.dependencies.repository.transact(run.id, (transaction) => {
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'PAUSED')
      const updated = { ...transaction.run, ...policy, updatedAt: now }
      transaction.putRun(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.paused',
        payload: isVisualDeckV4(updated)
          ? {
              ...v4LifecyclePayload(updated, 'RUN', {
                completed: 0,
                total: 1,
                reason: 'BUDGET_INSUFFICIENT',
                retryable: true,
                requiresUserAction: true,
                nextAction: 'ADD_BUDGET',
              }),
              resumeState: 'REVISING',
            }
          : { reason: `BUDGET_REQUIRED:${required}`, resumeState: 'REVISING' },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'BUDGET', summary: `局部重绘预计需要 ${required} 预算单位，请追加预算或取消。` },
      })
    })
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }
}

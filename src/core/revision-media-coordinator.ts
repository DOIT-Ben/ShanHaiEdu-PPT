import { CONTRACT_VERSION } from '../contracts'
import { revisionPlanSchema } from '../presentation-contracts'
import { getActiveBlueprint } from './active-blueprint'
import {
  blueprintElementAssetKey,
  blueprintImageRequirements,
  completeVisualDeckV4RevisionPrompt,
  latestCompletedAssetStep,
  VISUAL_DECK_V4_NEGATIVE_PROMPT,
} from './blueprint-assets'
import { mapWithConcurrency } from './concurrency'
import {
  ensureGenerationBatch,
  finalizeGenerationBatch,
  generationBatchStepKeyFor,
  preflightGenerationBatchFinalization,
  refreshGenerationBatch,
  reserveGenerationBatch,
  type GenerationBatchReservation,
} from './generation-batch'
import { hashInput } from './hash'
import { isMediaFailureStepStatus, MediaStepRunner } from './media-step-runner'
import type { AgentRepository, BatchBudgetPort, ClockPort, RunRecord, StepRecord } from './ports'
import { visualDeckV4RevisionInstructions } from './revision-instruction-memory'
import { evaluateBudget, transitionRun } from './policy'
import { beginTechnicalRecovery, isTechnicalFailureCode } from './technical-recovery'
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

type RevisionTarget = Readonly<{
  pageNumber: number
  elementId: string | null
  assetReuseKey: string | null
  idempotencyKey: string
  stepId: string
  slideId: string
  versionId: string
  prompt: string
  negativePrompt: string | null
  aspectRatio: '16:9' | '4:3' | '1:1' | '3:4'
  backgroundMode: 'OPAQUE' | 'TRANSPARENT'
}>

export class RevisionMediaCoordinator {
  private readonly imageConcurrency: number

  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    media: MediaStepRunner
    batchBudget: BatchBudgetPort
    clock: ClockPort
    imageConcurrency?: number
  }>) {
    this.imageConcurrency = dependencies.imageConcurrency ?? 50
    if (!Number.isSafeInteger(this.imageConcurrency) || this.imageConcurrency < 1 || this.imageConcurrency > 50) {
      throw new Error('IMAGE_CONCURRENCY_INVALID')
    }
  }

  async submit(runId: string, unitBudgetUnits: number): Promise<RevisionMediaResult> {
    if (!Number.isSafeInteger(unitBudgetUnits) || unitBudgetUnits <= 0) throw new Error('INVALID_UNIT_BUDGET')
    const run = await this.requireRun(runId)
    if (run.status === 'PAUSED' || run.status === 'NEEDS_HUMAN' || run.status === 'RECOVERING') return this.summary(run)
    if (run.status !== 'REVISING') throw new Error('RUN_NOT_REVISING')
    const targets = await this.targets(run)
    if (targets.length === 0) throw new Error('REVISION_MEDIA_NOT_REQUIRED')
    const steps = await this.currentSteps(run, targets)
    const stepsByKey = new Map(steps.map((step) => [step.idempotencyKey, step]))
    const canRetryReleasedSubmission = (step: StepRecord | undefined) => isVisualDeckV4(run)
      && step?.status === 'FAILED'
      && isTechnicalFailureCode(step.errorCode ?? '')
    const pending = targets.filter((target) => {
      const existing = stepsByKey.get(target.idempotencyKey)
      return !existing || ['RESERVED', 'SUBMITTING'].includes(existing.status) || canRetryReleasedSubmission(existing)
    })
    const newTargetCount = pending.filter((target) =>
      !stepsByKey.has(target.idempotencyKey) || canRetryReleasedSubmission(stepsByKey.get(target.idempotencyKey))).length
    let batchReservation: GenerationBatchReservation | undefined
    if (isVisualDeckV4(run)) {
      const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
      await ensureGenerationBatch({
        repository: this.dependencies.repository,
        clock: this.dependencies.clock,
        run,
        blueprint,
        requirements: this.batchRequirements(targets),
        unitBudgetUnits,
        identity: { revisionRound: run.revisionRound, scope: 'REVISION' },
      })
      const batchKey = generationBatchStepKeyFor(runId, { revisionRound: run.revisionRound, scope: 'REVISION' })
      const batchStep = (await this.dependencies.repository.listSteps(runId))
        .find((step) => step.idempotencyKey === batchKey)
      if (!batchStep) throw new Error('REVISION_GENERATION_BATCH_STEP_NOT_FOUND')
      if (!batchStep.budgetReservationId) {
        const supported = await preflightGenerationBatchFinalization({
          repository: this.dependencies.repository,
          budget: this.dependencies.batchBudget,
          clock: this.dependencies.clock,
          runId,
          revisionRound: run.revisionRound,
          scope: 'REVISION',
        })
        if (!supported) return this.summary(await this.requireRun(runId))
      }
      const latestBatchStep = (await this.dependencies.repository.listSteps(runId))
        .find((step) => step.idempotencyKey === batchKey)
      if (!latestBatchStep) throw new Error('REVISION_GENERATION_BATCH_STEP_NOT_FOUND')
      const needsInitialBudgetCheck = !latestBatchStep.budgetReservationId
        && !['RESERVED', 'RESERVATION_UNKNOWN'].includes(latestBatchStep.status)
      if (needsInitialBudgetCheck) {
        const decision = evaluateBudget(run, latestBatchStep.budgetUnits)
        if (!decision.allowed && decision.reason === 'BUDGET_EXCEEDED') {
          await this.pauseForBudget(run, latestBatchStep.budgetUnits)
          return { status: 'PAUSED', completed: 0, submitted: steps.length, total: targets.length }
        }
        if (!decision.allowed) throw new Error(decision.reason)
      }
      const reservation = await reserveGenerationBatch({
        repository: this.dependencies.repository,
        budget: this.dependencies.batchBudget,
        clock: this.dependencies.clock,
        runId,
        revisionRound: run.revisionRound,
        model: run.imageModel,
        scope: 'REVISION',
      })
      if (!reservation) return this.summary(await this.requireRun(runId))
      batchReservation = reservation
    } else {
      const decision = evaluateBudget(run, newTargetCount * unitBudgetUnits)
      if (newTargetCount > 0 && !decision.allowed && decision.reason === 'BUDGET_EXCEEDED') {
        await this.pauseForBudget(run, newTargetCount * unitBudgetUnits)
        return { status: 'PAUSED', completed: 0, submitted: steps.length, total: targets.length }
      }
      if (newTargetCount > 0 && !decision.allowed) throw new Error(decision.reason)
    }

    if (isVisualDeckV4(run)) {
      const outcomes = await mapWithConcurrency(pending, this.imageConcurrency, async (target) => {
        const existing = stepsByKey.get(target.idempotencyKey)
        try {
          return { step: (await this.submitTarget(run, target, unitBudgetUnits, existing, batchReservation)).step }
        } catch (error) {
          return { error }
        }
      })
      const unexpected = outcomes.find((outcome): outcome is { error: unknown } => 'error' in outcome)
      if (unexpected) throw unexpected.error
      const failed = outcomes.find((outcome): outcome is { step: StepRecord } =>
        'step' in outcome && isMediaFailureStepStatus(outcome.step.status))
      if (failed) await this.failV4Revision(run, failed.step, targets.length)
      await refreshGenerationBatch({
        repository: this.dependencies.repository,
        clock: this.dependencies.clock,
        runId,
        revisionRound: run.revisionRound,
        scope: 'REVISION',
      })
      const latest = await this.requireRun(runId)
      return {
        status: latest.status,
        completed: 0,
        submitted: (await this.currentSteps(latest, targets)).length,
        total: targets.length,
      }
    }

    for (const target of pending) {
      const key = target.idempotencyKey
      const existing = stepsByKey.get(key)
      const result = await this.submitTarget(run, target, unitBudgetUnits, existing)
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
    const pendingRefreshes = initialSteps.filter((candidate) => ['WAITING', 'RELEASING'].includes(candidate.status))
    if (isVisualDeckV4(run)) {
      await mapWithConcurrency(pendingRefreshes, this.imageConcurrency, (step) =>
        this.dependencies.media.refreshSlideImage(runId, step.idempotencyKey))
    } else {
      for (const step of pendingRefreshes) {
        await this.dependencies.media.refreshSlideImage(runId, step.idempotencyKey)
        const latest = await this.requireRun(runId)
        if (latest.status === 'NEEDS_HUMAN') break
      }
    }
    const refreshed = await this.currentSteps(run, targets)
    const failed = refreshed.find((step) => isMediaFailureStepStatus(step.status))
    const completed = refreshed.filter((step) => step.status === 'COMPLETED' && this.artifactId(step)).length
    const latest = await this.requireRun(runId)
    const details = await this.details(run)
    let batchFinalized = !isVisualDeckV4(run)
    if (isVisualDeckV4(run)) {
      await refreshGenerationBatch({
        repository: this.dependencies.repository,
        clock: this.dependencies.clock,
        runId,
        revisionRound: run.revisionRound,
        scope: 'REVISION',
      })
      batchFinalized = await finalizeGenerationBatch({
        repository: this.dependencies.repository,
        budget: this.dependencies.batchBudget,
        clock: this.dependencies.clock,
        runId,
        revisionRound: run.revisionRound,
        scope: 'REVISION',
      })
    }
    if (!failed && batchFinalized && completed === targets.length && latest.status === 'REVISING') {
      const deckArtifactsComplete = !isVisualDeckV4(latest) || await this.hasCompleteDeckArtifacts(latest)
      await this.dependencies.repository.transact(runId, (transaction) => {
        const now = this.dependencies.clock.now().toISOString()
        const nextStatus = deckArtifactsComplete ? 'PAGE_REVIEW' : 'NEEDS_HUMAN'
        const policy = transitionRun(transaction.run, nextStatus)
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
          payload: {
            from: 'REVISING',
            to: nextStatus,
            ...(deckArtifactsComplete ? {} : { reason: 'PAGE_ARTIFACTS_INCOMPLETE' }),
          },
        })
        if (deckArtifactsComplete) {
          appendV4LifecycleEvent(transaction, 'page_review.started', {
            completed: 0,
            total: transaction.run.slideCount,
            pageNumbers: allPageNumbers(transaction.run),
          })
        } else {
          transaction.appendEvent({
            schemaVersion: CONTRACT_VERSION,
            type: 'approval.required',
            payload: { kind: 'HUMAN_REVIEW', summary: '仍有页面缺少有效产物，请仅修订缺失页后继续。' },
          })
        }
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

  private async targets(run: RunRecord): Promise<readonly RevisionTarget[]> {
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

  private async hasCompleteDeckArtifacts(run: RunRecord) {
    const blueprint = await getActiveBlueprint(this.dependencies.repository, run.id, run.revisionRound)
    const completedSteps = (await this.dependencies.repository.listSteps(run.id))
      .filter((step) => step.tool === 'generate_slide_image' && step.status === 'COMPLETED')
    return blueprintImageRequirements(run, blueprint).every((requirement) =>
      latestCompletedAssetStep(completedSteps, requirement, run.revisionRound) !== null)
  }

  private async currentSteps(run: RunRecord, targets: readonly Readonly<{ idempotencyKey: string }>[]) {
    const keys = new Set(targets.map((target) => target.idempotencyKey))
    return (await this.dependencies.repository.listSteps(run.id))
      .filter((step) => step.tool === 'generate_slide_image' && keys.has(step.idempotencyKey))
  }

  private batchRequirements(targets: readonly RevisionTarget[]) {
    // Revision batches are internal-only. Keep the public batch schema unchanged
    // while preserving the real page identities in stable image idempotency keys.
    return targets.map((target, index) => ({
      pageNumber: index + 1,
      idempotencyKey: target.idempotencyKey,
      prompt: target.prompt,
    }))
  }

  private submitTarget(
    run: RunRecord,
    target: RevisionTarget,
    unitBudgetUnits: number,
    existing?: StepRecord,
    batchReservation?: GenerationBatchReservation,
  ) {
    const key = target.idempotencyKey
    return this.dependencies.media.submitSlideImage({
      runId: run.id,
      stepId: target.stepId,
      idempotencyKey: key,
      ...(batchReservation ? { batchReservation } : {}),
      ...(isVisualDeckV4(run) && existing?.status === 'FAILED' && isTechnicalFailureCode(existing.errorCode ?? '') ? {
        budgetReservationKey: `${key}:budget-recovery:${run.technicalRecovery?.attempt ?? 1}`,
      } : {}),
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
        const recovery = beginTechnicalRecovery(transaction, this.dependencies.clock, failed.errorCode ?? 'REVISION_MEDIA_FAILED')
        if (!recovery) {
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
      }
      appendV4LifecycleEvent(transaction, 'revision.completed', {
        completed,
        total,
        ...details,
        reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
        retryable: transaction.run.technicalRecovery?.retryable ?? false,
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

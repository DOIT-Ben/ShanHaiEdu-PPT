import { CONTRACT_VERSION } from '../contracts'
import { storedGenerationBatchSchema } from '../generation-batch-contracts'
import { slideVisualReviewSchema, type PresentationBlueprint, type SlideVisualReview } from '../presentation-contracts'
import { getActiveBlueprint } from './active-blueprint'
import { blueprintImageRequirements, hasVisualDeckV4AspectRatio } from './blueprint-assets'
import { mapWithConcurrency } from './concurrency'
import {
  ensureGenerationBatch,
  finalizeGenerationBatch,
  generationBatchIdentityFromStepKey,
  preflightGenerationBatchFinalization,
  refreshGenerationBatch,
  reserveGenerationBatch,
  type GenerationBatchReservation,
} from './generation-batch'
import {
  beginTechnicalRecovery,
  technicalFailureFromStep,
} from './technical-recovery'
import { controlledRasterFailureCodeFor, persistControlledRasterFailure } from './controlled-raster-failure'
import { hashInput } from './hash'
import {
  isMediaFailureStepStatus,
  isUsageAuthorizationCapFailureStep,
  MediaStepRunner,
} from './media-step-runner'
import type {
  AcquiredWebAsset,
  AgentRepository,
  ArtifactPort,
  AssetCandidateReviewPort,
  BatchBudgetPort,
  AssetDiscoveryPort,
  ClockPort,
  ControlledRasterPort,
  DocumentPort,
  RunRecord,
  SourceAsset,
  StepRecord,
} from './ports'
import { evaluateBudget, transitionRun } from './policy'
import {
  allPageNumbers,
  appendV4LifecycleEvent,
  isVisualDeckV4,
  reconcileVisualDeckV4TerminalState,
  v4LifecyclePayload,
} from './v4-lifecycle'
import { resolveV4RenderStrategy, type V4RenderStrategy } from './v4-render-strategy'
import { v4ModelOverride } from './v4-model-policy'

export type SubmitBlueprintImagesResult = Readonly<{
  status: RunRecord['status']
  submitted: number
  total: number
  steps: readonly StepRecord[]
}>

export type RefreshBlueprintImagesResult = Readonly<{
  status: RunRecord['status']
  completed: number
  total: number
  artifactIds: readonly string[]
}>

function canRetryReleasedV4Submission(run: RunRecord, step: StepRecord | undefined) {
  return isVisualDeckV4(run)
    && step?.status === 'FAILED'
    && (technicalFailureFromStep(step) !== null || isUsageAuthorizationCapFailureStep(step))
}

export const ASSET_CANDIDATE_QUALITY_THRESHOLD = 80

export class SlideGenerationCoordinator {
  private readonly imageConcurrency: number

  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    media: MediaStepRunner
    batchBudget: BatchBudgetPort
    documents: DocumentPort
    artifacts: ArtifactPort
    controlledRaster?: ControlledRasterPort
    discovery?: AssetDiscoveryPort
    candidateReviewer?: AssetCandidateReviewPort
    clock: ClockPort
    imageConcurrency?: number
  }>) {
    this.imageConcurrency = dependencies.imageConcurrency ?? 50
    if (!Number.isSafeInteger(this.imageConcurrency) || this.imageConcurrency < 1 || this.imageConcurrency > 50) {
      throw new Error('IMAGE_CONCURRENCY_INVALID')
    }
  }

  private v4RenderStrategies(
    blueprint: PresentationBlueprint,
    requirements: ReturnType<typeof blueprintImageRequirements>,
    existingBatchStep?: StepRecord,
  ) {
    const fullGenerative = new Map<string, V4RenderStrategy>(requirements.map((requirement) => [
      requirement.idempotencyKey,
      { kind: 'FULL_GENERATIVE' },
    ]))
    if (blueprint.renderMode !== 'VISUAL_DECK_V4') return fullGenerative

    const persisted = existingBatchStep?.tool === 'generate_image_batch'
      ? storedGenerationBatchSchema.parse(existingBatchStep.output)
      : null
    // The optional field deliberately marks old batches. Do not migrate an
    // in-flight provider batch into a different rendering/accounting route.
    if (persisted?.pages.some((page) => page.renderStrategy === undefined)) return fullGenerative
    const persistedByKey = new Map((persisted?.pages ?? []).map((page) => [page.idempotencyKey, page.renderStrategy]))
    const strategies = new Map<string, V4RenderStrategy>()
    for (const requirement of requirements) {
      const stored = persistedByKey.get(requirement.idempotencyKey)
      if (stored === 'FULL_GENERATIVE') {
        strategies.set(requirement.idempotencyKey, { kind: 'FULL_GENERATIVE' })
        continue
      }
      const resolved = resolveV4RenderStrategy(blueprint, requirement.pageNumber)
      if (stored === 'CONTROLLED_RASTER' && resolved.kind !== 'CONTROLLED_RASTER') {
        throw new Error('CONTROLLED_RASTER_CONTRACT_MISSING')
      }
      if (resolved.kind === 'CONTROLLED_RASTER' && !this.dependencies.controlledRaster) {
        throw new Error('CONTROLLED_RASTER_PORT_REQUIRED')
      }
      strategies.set(requirement.idempotencyKey, resolved)
    }
    return strategies
  }

  async submitBlueprintImages(runId: string, unitBudgetUnits: number): Promise<SubmitBlueprintImagesResult> {
    if (!Number.isSafeInteger(unitBudgetUnits) || unitBudgetUnits <= 0) throw new Error('INVALID_UNIT_BUDGET')
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    if (run.status === 'PAUSED' || run.status === 'NEEDS_HUMAN' || run.status === 'RECOVERING') {
      return { status: run.status, submitted: 0, total: run.slideCount, steps: [] }
    }
    if (run.status !== 'EXECUTING') throw new Error('RUN_NOT_EXECUTING')
    await this.dependencies.repository.transact(runId, (transaction) => {
      appendV4LifecycleEvent(transaction, 'generation.started', {
        completed: 0,
        total: transaction.run.slideCount,
        pageNumbers: allPageNumbers(transaction.run),
      })
    })
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    const requirements = blueprintImageRequirements(run, blueprint)
    const existingV4BatchStep = isVisualDeckV4(run)
      ? (await this.dependencies.repository.listSteps(runId))
        .find((step) => step.idempotencyKey === `${runId}:generation-batch:r${run.revisionRound}`)
      : undefined
    const renderStrategies = this.v4RenderStrategies(blueprint, requirements, existingV4BatchStep)
    const batchRequirements = requirements.map((requirement) => {
      const strategy = renderStrategies.get(requirement.idempotencyKey) ?? { kind: 'FULL_GENERATIVE' as const }
      return {
        ...requirement,
        budgetUnits: strategy.kind === 'CONTROLLED_RASTER' ? 0 : unitBudgetUnits,
        renderStrategy: strategy.kind,
      }
    })
    const requirementKeys = new Set(requirements.map((requirement) => requirement.idempotencyKey))
    const existingSteps = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && requirementKeys.has(step.idempotencyKey))
    const blockingStep = existingSteps.find((step) => isMediaFailureStepStatus(step.status)
      && !(isVisualDeckV4(run) && ['RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(step.status))
      && !canRetryReleasedV4Submission(run, step))
    if (blockingStep) {
      await this.requireHuman(runId, blockingStep)
      const latest = await this.dependencies.repository.getRun(runId)
      return {
        status: latest?.status ?? 'FAILED',
        submitted: 0,
        total: blueprint.slides.length,
        steps: existingSteps,
      }
    }
    const existingByKey = new Map(existingSteps.map((step) => [step.idempotencyKey, step]))
    const pendingRequirements = requirements.filter((requirement) => {
      const existing = existingByKey.get(requirement.idempotencyKey)
      return !existing
        || ['RESERVED', 'SUBMITTING', 'RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(existing.status)
        || canRetryReleasedV4Submission(run, existing)
    })

    if (pendingRequirements.length === 0) {
      if (isVisualDeckV4(run)) {
        await refreshGenerationBatch({
          repository: this.dependencies.repository,
          clock: this.dependencies.clock,
          runId,
          revisionRound: run.revisionRound,
        })
      }
      return {
        status: run.status,
        submitted: existingSteps.filter((step) => ['WAITING', 'COMPLETED'].includes(step.status)).length,
        total: requirements.length,
        steps: existingSteps,
      }
    }
    const requiresProviderSubmission = pendingRequirements.some((requirement) => {
      const strategy = renderStrategies.get(requirement.idempotencyKey)
      return strategy?.kind !== 'CONTROLLED_RASTER' && requirement.sourceAssetStrategy !== 'REUSE_ORIGINAL'
    })
    const imageModel = isVisualDeckV4(run) && requiresProviderSubmission
      ? v4ModelOverride(run, 'IMAGE', blueprint.visualDeckV4Proposal?.compilerVersion)!
      : run.imageModel
    if (isVisualDeckV4(run)) {
      await ensureGenerationBatch({
        repository: this.dependencies.repository,
        clock: this.dependencies.clock,
        run,
        blueprint,
        requirements: batchRequirements,
        unitBudgetUnits,
        accountingModel: imageModel,
        operationMode: 'TEXT_TO_IMAGE',
      })
      const batchStep = (await this.dependencies.repository.listSteps(runId))
        .find((step) => step.idempotencyKey === `${runId}:generation-batch:r${run.revisionRound}`)
      if (!batchStep) throw new Error('GENERATION_BATCH_STEP_NOT_FOUND')
      if (!batchStep.budgetReservationId && batchStep.budgetUnits > 0) {
        const supported = await preflightGenerationBatchFinalization({
          repository: this.dependencies.repository,
          budget: this.dependencies.batchBudget,
          clock: this.dependencies.clock,
          runId,
          revisionRound: run.revisionRound,
        })
        if (!supported) {
          const latest = await this.dependencies.repository.getRun(runId)
          return { status: latest?.status ?? 'FAILED', submitted: 0, total: requirements.length, steps: [] }
        }
      }
    }

    let batchReservation: GenerationBatchReservation | undefined
    if (isVisualDeckV4(run)) {
      const batchStep = (await this.dependencies.repository.listSteps(runId))
        .find((step) => step.idempotencyKey === `${runId}:generation-batch:r${run.revisionRound}`)
      if (!batchStep) throw new Error('GENERATION_BATCH_STEP_NOT_FOUND')
      const decision = evaluateBudget(run, batchStep.budgetUnits)
      const needsInitialBudgetCheck = !batchStep.budgetReservationId
        && !['RESERVED', 'RESERVATION_UNKNOWN'].includes(batchStep.status)
      if (needsInitialBudgetCheck && batchStep.budgetUnits > 0 && !decision.allowed) {
        if (decision.reason === 'BUDGET_EXCEEDED') {
          const paused = await this.pauseForBudget(run, batchStep.budgetUnits)
          return { status: paused.status, submitted: 0, total: requirements.length, steps: [] }
        }
        throw new Error(decision.reason)
      }
      const reservation = await reserveGenerationBatch({
        repository: this.dependencies.repository,
        budget: this.dependencies.batchBudget,
        clock: this.dependencies.clock,
        runId,
        revisionRound: run.revisionRound,
      })
      if (!reservation) {
        const latest = await this.dependencies.repository.getRun(runId)
        const latestBatchStep = (await this.dependencies.repository.listSteps(runId))
          .find((step) => step.idempotencyKey === `${runId}:generation-batch:r${run.revisionRound}`)
        if (latest?.status === 'EXECUTING' && latestBatchStep?.status === 'FAILED') {
          const paused = await this.pauseForBudget(latest, latestBatchStep.budgetUnits)
          return { status: paused.status, submitted: 0, total: requirements.length, steps: [] }
        }
        return { status: latest?.status ?? 'FAILED', submitted: 0, total: requirements.length, steps: [] }
      }
      batchReservation = reservation
    }
    const concurrentPageExecution = isVisualDeckV4(run) || run.source.kind === 'APPROVED_PAGE_DESIGN'
    const steps = [...existingSteps]
    const unresolvedRequirements = []
    const currentRequirements = pendingRequirements
    for (const requirement of currentRequirements) {
      if (requirement.sourceAssetStrategy !== 'SEARCH_WEB') {
        unresolvedRequirements.push(requirement)
        continue
      }
      const completed = !existingByKey.has(requirement.idempotencyKey)
        && run.assetAcquisitionPolicy === 'SEARCH_FIRST'
        ? await this.tryCompleteWebAsset(run, requirement)
        : null
      if (!completed) {
        unresolvedRequirements.push(requirement)
        continue
      }
      steps.push(completed)
      await this.appendProgress(runId, completed.id, steps.length, requirements.length, '已获取网络素材')
    }

    const chargeableCount = unresolvedRequirements.filter((requirement) =>
      (!existingByKey.has(requirement.idempotencyKey)
        || canRetryReleasedV4Submission(run, existingByKey.get(requirement.idempotencyKey)))
      && requirement.sourceAssetStrategy !== 'REUSE_ORIGINAL').length
    if (!isVisualDeckV4(run) && chargeableCount > 0) {
      const decision = evaluateBudget(run, chargeableCount * unitBudgetUnits)
      if (!decision.allowed && decision.reason === 'BUDGET_EXCEEDED') {
        const paused = await this.pauseForBudget(run, chargeableCount * unitBudgetUnits)
        return { status: paused.status, submitted: steps.length, total: requirements.length, steps }
      }
      if (!decision.allowed) throw new Error(decision.reason)
    }

    if (concurrentPageExecution) {
      const outcomes = await mapWithConcurrency(unresolvedRequirements, this.imageConcurrency, async (requirement) => {
        try {
          const strategy = renderStrategies.get(requirement.idempotencyKey)
          return { step: strategy?.kind === 'CONTROLLED_RASTER'
            ? await this.completeControlledRaster(run, blueprint, requirement, strategy)
            : await this.submitGeneratedImage(
                run,
                requirement,
                imageModel,
                unitBudgetUnits,
                undefined,
                existingByKey.get(requirement.idempotencyKey),
                batchReservation,
              ) }
        } catch (error) {
          // Keep dispatching the approved batch; a later recovery pass can reconcile already submitted operations.
          return { error }
        }
      })
      const unexpected = outcomes.find((outcome): outcome is { error: unknown } => 'error' in outcome)
      if (unexpected) throw unexpected.error
      const submittedOutcomes = outcomes.filter((outcome): outcome is { step: StepRecord } => 'step' in outcome)
      for (const outcome of submittedOutcomes) {
        const step = outcome.step
        const existingIndex = steps.findIndex((candidate) => candidate.idempotencyKey === step.idempotencyKey)
        if (existingIndex === -1) steps.push(step)
        else steps[existingIndex] = step
      }
      const failed = submittedOutcomes.find((outcome) => isMediaFailureStepStatus(outcome.step.status))
      const runAfterSubmissions = await this.dependencies.repository.getRun(runId)
      if (!runAfterSubmissions || !['PAUSED', 'CANCELLED'].includes(runAfterSubmissions.status)) {
        if (failed) await this.requireHuman(runId, failed.step)
        else {
          for (const [index, outcome] of submittedOutcomes.entries()) {
            await this.appendProgress(runId, outcome.step.id, index + 1, requirements.length)
          }
        }
      }
      const latest = await this.dependencies.repository.getRun(runId)
      if (isVisualDeckV4(run)) {
        await refreshGenerationBatch({
          repository: this.dependencies.repository,
          clock: this.dependencies.clock,
          runId,
          revisionRound: run.revisionRound,
        })
      }
      return {
        status: latest?.status ?? 'FAILED',
        submitted: steps.filter((step) => ['WAITING', 'COMPLETED'].includes(step.status)).length,
        total: requirements.length,
        steps,
      }
    }

    const needsSourceAssets = unresolvedRequirements.some((requirement) =>
      requirement.sourceAssetStrategy === 'REUSE_ORIGINAL' || requirement.sourceAssetStrategy === 'REFERENCE_GENERATION')
    const document = needsSourceAssets
      ? await this.dependencies.documents.resolve({ host: run.host, source: run.source })
      : null
    const sourceAssets = new Map((document?.assets ?? []).map((asset) => [asset.id, asset]))
    for (const requirement of unresolvedRequirements) {
      const versionId = requirement.elementId === null
        ? `${runId}:slide:${requirement.pageNumber}:r${run.revisionRound}:v1`
        : `${runId}:slide:${requirement.pageNumber}:element:${requirement.elementId}:r${run.revisionRound}:v1`
      const sourceAsset = ['REGENERATE', 'SEARCH_WEB'].includes(requirement.sourceAssetStrategy)
        ? null
        : sourceAssets.get(requirement.sourceAssetIds[0]!) ?? null
      if (!['REGENERATE', 'SEARCH_WEB'].includes(requirement.sourceAssetStrategy) && !sourceAsset) {
        const failed = await this.recordSourceAssetFailure(run, requirement, versionId)
        steps.push(failed)
        await this.requireHuman(runId, failed)
        break
      }
      if (requirement.sourceAssetStrategy === 'REUSE_ORIGINAL') {
        const completed = await this.completeSourceAssetReuse(run, requirement, versionId, sourceAsset!)
        steps.push(completed)
        await this.appendProgress(runId, completed.id, steps.length, requirements.length)
        continue
      }
      const result = { step: await this.submitGeneratedImage(run, requirement, imageModel, unitBudgetUnits, sourceAsset) }
      const existingIndex = steps.findIndex((step) => step.idempotencyKey === result.step.idempotencyKey)
      if (existingIndex === -1) steps.push(result.step)
      else steps[existingIndex] = result.step
      if (isMediaFailureStepStatus(result.step.status)) {
        await this.requireHuman(runId, result.step)
        break
      }
      const latestRun = await this.dependencies.repository.getRun(runId)
      if (!latestRun || latestRun.status === 'NEEDS_HUMAN' || latestRun.status === 'PAUSED') break
      await this.appendProgress(runId, result.step.id, steps.length, requirements.length, requirement.sourceAssetStrategy === 'SEARCH_WEB'
        ? '网络素材未命中，已回退 AI 生成'
        : '已安全提交图片任务')
    }
    const latest = await this.dependencies.repository.getRun(runId)
    return {
      status: latest?.status ?? 'FAILED',
      submitted: steps.filter((step) => ['WAITING', 'COMPLETED'].includes(step.status)).length,
      total: requirements.length,
      steps,
    }
  }

  async refreshBlueprintImages(runId: string): Promise<RefreshBlueprintImagesResult> {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    const requirements = blueprintImageRequirements(run, blueprint)
    if (run.status === 'PAGE_REVIEW') return this.completedSummary(runId, requirements, run.status)
    if (run.status !== 'EXECUTING') return this.completedSummary(runId, requirements, run.status)

    const requirementKeys = new Set(requirements.map((requirement) => requirement.idempotencyKey))
    const steps = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && requirementKeys.has(step.idempotencyKey))
    const pendingRefreshes = steps.filter((candidate) => ['WAITING', 'RELEASING'].includes(candidate.status))
    if (isVisualDeckV4(run) || run.source.kind === 'APPROVED_PAGE_DESIGN') {
      await mapWithConcurrency(pendingRefreshes, this.imageConcurrency, (step) =>
        this.dependencies.media.refreshSlideImage(runId, step.idempotencyKey))
    } else {
      for (const step of pendingRefreshes) {
        await this.dependencies.media.refreshSlideImage(runId, step.idempotencyKey)
        const latest = await this.dependencies.repository.getRun(runId)
        if (!latest || latest.status === 'NEEDS_HUMAN') break
      }
    }

    const refreshed = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && requirementKeys.has(step.idempotencyKey))
    const failed = refreshed.find((step) => isMediaFailureStepStatus(step.status))
    const completed = refreshed.filter((step) => step.status === 'COMPLETED' && this.artifactId(step) !== null)
    let batchFinalized = !isVisualDeckV4(run)
    if (isVisualDeckV4(run)) {
      await refreshGenerationBatch({
        repository: this.dependencies.repository,
        clock: this.dependencies.clock,
        runId,
        revisionRound: run.revisionRound,
      })
      batchFinalized = await finalizeGenerationBatch({
        repository: this.dependencies.repository,
        budget: this.dependencies.batchBudget,
        clock: this.dependencies.clock,
        runId,
        revisionRound: run.revisionRound,
      })
    }
    if (failed) await this.requireHuman(runId, failed)
    else await this.appendCompletedPageProgress(runId, completed.length, requirements.length)
    const latest = await this.dependencies.repository.getRun(runId)
    if (!failed && !batchFinalized) {
      return {
        status: latest?.status ?? 'FAILED',
        completed: completed.length,
        total: requirements.length,
        artifactIds: completed.map((step) => this.artifactId(step)!),
      }
    }
    if (!failed && completed.length === requirements.length && latest?.status === 'EXECUTING') {
      await this.dependencies.repository.transact(runId, (transaction) => {
        if (transaction.run.status !== 'EXECUTING') return
        const now = this.dependencies.clock.now().toISOString()
        const policy = transitionRun(transaction.run, 'PAGE_REVIEW')
        transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
        appendV4LifecycleEvent(transaction, 'generation.completed', {
          completed: requirements.length,
          total: requirements.length,
          pageNumbers: allPageNumbers(transaction.run),
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'EXECUTING', to: 'PAGE_REVIEW' },
        })
        appendV4LifecycleEvent(transaction, 'page_review.started', {
          completed: 0,
          total: transaction.run.slideCount,
          pageNumbers: allPageNumbers(transaction.run),
        })
      })
    }
    const finalRun = await this.dependencies.repository.getRun(runId)
    return {
      status: finalRun?.status ?? 'FAILED',
      completed: completed.length,
      total: requirements.length,
      artifactIds: completed.map((step) => this.artifactId(step)!),
    }
  }

  /**
   * A cancelled Run no longer advances presentation phases, but Provider image
   * tasks can still complete. Reconcile the durable V4 batch without reviving
   * the cancelled Run or resubmitting any page.
   */
  async reconcileTerminalGenerationBatch(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run || !isVisualDeckV4(run)
      || (!['CANCELLED', 'FAILED'].includes(run.status)
        && !(run.status === 'RECOVERING' && run.pendingTerminalFailure))) return false
    const identities = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_image_batch')
      .flatMap((step) => {
        const identity = generationBatchIdentityFromStepKey(runId, step.idempotencyKey)
        return identity ? [identity] : []
      })
    let finalized = identities.length > 0
    for (const identity of identities) {
      await refreshGenerationBatch({
        repository: this.dependencies.repository,
        clock: this.dependencies.clock,
        runId,
        revisionRound: identity.revisionRound,
        scope: identity.scope,
      })
      finalized = (await finalizeGenerationBatch({
        repository: this.dependencies.repository,
        budget: this.dependencies.batchBudget,
        clock: this.dependencies.clock,
        runId,
        revisionRound: identity.revisionRound,
        scope: identity.scope,
      })) && finalized
    }
    const terminalStateChanged = await this.dependencies.repository.transact(runId, (transaction) =>
      reconcileVisualDeckV4TerminalState(transaction, this.dependencies.clock))
    if (identities.length === 0) return terminalStateChanged
    return finalized
  }

  private artifactId(step: StepRecord) {
    const output = step.output as { artifactId?: unknown } | null
    return output && typeof output.artifactId === 'string' ? output.artifactId : null
  }

  private async submitGeneratedImage(
    run: RunRecord,
    requirement: ReturnType<typeof blueprintImageRequirements>[number],
    model: string,
    unitBudgetUnits: number,
    sourceAsset?: SourceAsset | null,
    existingStep?: StepRecord,
    batchReservation?: GenerationBatchReservation,
  ) {
    const versionId = requirement.elementId === null
      ? `${run.id}:slide:${requirement.pageNumber}:r${run.revisionRound}:v1`
      : `${run.id}:slide:${requirement.pageNumber}:element:${requirement.elementId}:r${run.revisionRound}:v1`
    const result = await this.dependencies.media.submitSlideImage({
      runId: run.id,
      stepId: `step-${run.id}-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r${run.revisionRound}`,
      idempotencyKey: requirement.idempotencyKey,
      ...(batchReservation ? { batchReservation } : {}),
      ...(batchReservation ? { pageNumber: requirement.pageNumber, revisionRound: run.revisionRound } : {}),
      ...(canRetryReleasedV4Submission(run, existingStep) ? {
        budgetReservationKey: `${requirement.idempotencyKey}:budget-recovery:${run.technicalRecovery?.attempt ?? 1}`,
      } : {}),
      slideId: requirement.slideId,
      versionId,
      prompt: requirement.prompt,
      ...(requirement.negativePrompt ? { negativePrompt: requirement.negativePrompt } : {}),
      model,
      budgetUnits: unitBudgetUnits,
      aspectRatio: requirement.aspectRatio,
      ...(run.presentationMode === 'VISUAL_DECK_V4' ? { exactAspectRatio: true } : {}),
      backgroundMode: requirement.backgroundMode,
      ...(requirement.elementId ? { elementId: requirement.elementId } : {}),
      ...(requirement.reuseKey ? { assetReuseKey: requirement.reuseKey } : {}),
      ...(sourceAsset ? { referenceImage: {
        mimeType: sourceAsset.mimeType,
        bytes: sourceAsset.bytes,
        sha256: sourceAsset.sha256,
      } } : {}),
    })
    return result.step
  }

  private async completeControlledRaster(
    run: RunRecord,
    blueprint: PresentationBlueprint,
    requirement: ReturnType<typeof blueprintImageRequirements>[number],
    strategy: Extract<V4RenderStrategy, { kind: 'CONTROLLED_RASTER' }>,
  ) {
    const renderer = this.dependencies.controlledRaster
    if (!renderer) throw new Error('CONTROLLED_RASTER_PORT_REQUIRED')
    const brief = blueprint.visualDeckV4Proposal?.slideBriefs.find((candidate) => candidate.pageNumber === requirement.pageNumber)
    if (!brief) throw new Error('CONTROLLED_RASTER_BRIEF_MISSING')
    const versionId = `${run.id}:slide:${requirement.pageNumber}:r${run.revisionRound}:v1`
    const inputHash = hashInput({
      tool: 'render_controlled_raster',
      slideId: requirement.slideId,
      versionId,
      title: brief.title,
      visibleCopy: brief.lockedCopy,
      diagram: strategy.diagram,
    })
    const failed = (errorCode: 'CONTROLLED_RASTER_ASPECT_RATIO_INVALID' | 'CONTROLLED_RASTER_VISIBLE_TEXT_TOO_LARGE' | 'CONTROLLED_RASTER_RENDER_FAILED',
      observedDimensions?: Readonly<{ width: number; height: number }>) => persistControlledRasterFailure({
      repository: this.dependencies.repository,
      clock: this.dependencies.clock,
      run,
      step: {
        id: `step-${run.id}-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r${run.revisionRound}`,
        idempotencyKey: requirement.idempotencyKey,
        slideId: requirement.slideId,
        versionId,
      },
      inputHash,
      diagram: strategy.diagram,
      errorCode,
      ...(observedDimensions ? { observedDimensions } : {}),
    })
    let artifact: Awaited<ReturnType<ControlledRasterPort['render']>>
    try {
      artifact = await renderer.render({
        tenantId: run.host.tenantId,
        runId: run.id,
        pageNumber: requirement.pageNumber,
        title: brief.title,
        visibleCopy: brief.lockedCopy,
        diagram: strategy.diagram,
        idempotencyKey: requirement.idempotencyKey,
      })
    } catch (error) {
      return failed(controlledRasterFailureCodeFor(error))
    }
    if (!hasVisualDeckV4AspectRatio(artifact.width, artifact.height)) {
      return failed('CONTROLLED_RASTER_ASPECT_RATIO_INVALID', { width: artifact.width, height: artifact.height })
    }
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const existing = transaction.getStep(requirement.idempotencyKey)
      if (existing) {
        if (existing.inputHash !== inputHash || existing.tool !== 'generate_slide_image') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        if (existing.status === 'COMPLETED') return existing
        if (existing.status !== 'RESERVED' || existing.externalOperationId) {
          throw new Error('CONTROLLED_RASTER_STEP_NOT_REPLACEABLE')
        }
      }
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: `step-${run.id}-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r${run.revisionRound}`,
        runId: run.id,
        idempotencyKey: requirement.idempotencyKey,
        inputHash,
        tool: 'generate_slide_image',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: {
          slideId: requirement.slideId,
          versionId,
          artifactId: artifact.artifactId,
          aspectRatio: '16:9',
          renderStrategy: 'CONTROLLED_RASTER',
          diagramHash: hashInput(strategy.diagram),
          imageWidth: artifact.width,
          imageHeight: artifact.height,
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      transaction.putStep(step)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: step.id, summary: '已用受控图示完成精确数量页面' },
      })
      return step
    })
  }

  private async completeSourceAssetReuse(
    run: RunRecord,
    requirement: ReturnType<typeof blueprintImageRequirements>[number],
    versionId: string,
    sourceAsset: SourceAsset,
  ) {
    const artifact = await this.dependencies.artifacts.put({
      tenantId: run.host.tenantId,
      runId: run.id,
      name: `source-${sourceAsset.id}.${sourceAsset.mimeType.split('/')[1]}`,
      mimeType: sourceAsset.mimeType,
      bytes: sourceAsset.bytes,
      idempotencyKey: `${requirement.idempotencyKey}:source-reuse:${sourceAsset.sha256}`,
    })
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: `step-${run.id}-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r${run.revisionRound}`,
        runId: run.id,
        idempotencyKey: requirement.idempotencyKey,
        inputHash: hashInput({ tool: 'reuse_source_asset', assetKey: requirement.assetKey, sha256: sourceAsset.sha256 }),
        tool: 'generate_slide_image',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: {
          slideId: requirement.slideId,
          versionId,
          artifactId: artifact.artifactId,
          sourceAssetId: sourceAsset.id,
        },
        createdAt: now,
        updatedAt: now,
      }
      transaction.putStep(step)
      return step
    })
  }

  private async tryCompleteWebAsset(
    run: RunRecord,
    requirement: ReturnType<typeof blueprintImageRequirements>[number],
  ): Promise<StepRecord | null> {
    const discovery = this.dependencies.discovery
    const reviewer = this.dependencies.candidateReviewer
    if (!discovery || !reviewer || !requirement.assetIntent) return null
    const stepId = `search-${hashInput(requirement.assetKey).slice(0, 24)}`
    await this.appendSearchEvent(run.id, {
      type: 'tool.started',
      payload: { stepId, tool: 'search_web_asset', label: `正在查找：${requirement.assetIntent.searchQueries[0]}` },
    })
    try {
      const candidates = await discovery.search({
        tenantId: run.host.tenantId,
        intent: requirement.assetIntent,
        aspectRatio: requirement.aspectRatio,
        idempotencyKey: `${requirement.idempotencyKey}:search`,
      })
      for (const [candidateIndex, candidate] of candidates.slice(0, 5).entries()) {
        try {
          const acquired = await discovery.acquire({
            tenantId: run.host.tenantId,
            candidate,
            idempotencyKey: `${requirement.idempotencyKey}:acquire:${candidate.provider}:${candidate.providerAssetId}`,
          })
          const rawReview = await reviewer.reviewCandidate({
            tenantId: run.host.tenantId,
            candidate,
            bytes: acquired.bytes,
            intent: requirement.assetIntent,
            knowledgePoint: requirement.knowledgePoint,
            role: requirement.role,
            visualDirection: run.visualDirection,
            idempotencyKey: `${requirement.idempotencyKey}:candidate-review:${hashInput({
              provider: candidate.provider,
              providerAssetId: candidate.providerAssetId,
              sha256: acquired.sha256,
            }).slice(0, 28)}`,
          })
          const review = slideVisualReviewSchema.parse(rawReview)
          if (!review.approved || review.textDetected || review.visualScore < ASSET_CANDIDATE_QUALITY_THRESHOLD) {
            await this.appendSearchEvent(run.id, {
              type: 'tool.progress',
              payload: {
                stepId,
                completed: candidateIndex + 1,
                total: Math.min(candidates.length, 5),
                summary: '候选素材未通过视觉门禁，继续筛选',
              },
            })
            continue
          }
          const step = await this.completeWebAsset(run, requirement, acquired, review)
          await this.appendSearchEvent(run.id, {
            type: 'tool.completed',
            payload: { stepId, summary: `已选用 ${candidate.provider} 素材：${candidate.title}` },
          })
          return step
        } catch {
          continue
        }
      }
      await this.appendSearchEvent(run.id, {
        type: 'tool.completed',
        payload: { stepId, summary: '没有找到许可与质量均合格的素材，改用 AI 补缺' },
      })
      return null
    } catch {
      await this.appendSearchEvent(run.id, {
        type: 'tool.failed',
        payload: { stepId, errorCode: 'ASSET_SEARCH_UNAVAILABLE', retryable: true },
      })
      return null
    }
  }

  private async completeWebAsset(
    run: RunRecord,
    requirement: ReturnType<typeof blueprintImageRequirements>[number],
    acquired: AcquiredWebAsset,
    review: SlideVisualReview,
  ) {
    const extension = acquired.candidate.mimeType.split('/')[1]
    const artifact = await this.dependencies.artifacts.put({
      tenantId: run.host.tenantId,
      runId: run.id,
      name: `web-${acquired.candidate.provider.toLowerCase()}-${acquired.candidate.providerAssetId}.${extension}`,
      mimeType: acquired.candidate.mimeType,
      bytes: acquired.bytes,
      idempotencyKey: `${requirement.idempotencyKey}:web:${acquired.sha256}`,
    })
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const now = this.dependencies.clock.now().toISOString()
      const versionId = `${run.id}:slide:${requirement.pageNumber}:element:${requirement.elementId}:r${run.revisionRound}:v1`
      const step: StepRecord = {
        id: `step-${run.id}-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r${run.revisionRound}`,
        runId: run.id,
        idempotencyKey: requirement.idempotencyKey,
        inputHash: hashInput({ tool: 'search_web_asset', assetKey: requirement.assetKey, sha256: acquired.sha256 }),
        tool: 'generate_slide_image',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: {
          slideId: requirement.slideId,
          versionId,
          artifactId: artifact.artifactId,
          acquisition: 'SEARCH_WEB',
          provenance: {
            provider: acquired.candidate.provider,
            providerAssetId: acquired.candidate.providerAssetId,
            title: acquired.candidate.title,
            sourceUrl: acquired.candidate.sourceUrl,
            creator: acquired.candidate.creator,
            license: acquired.candidate.license,
            licenseUrl: acquired.candidate.licenseUrl,
            attribution: acquired.candidate.attribution,
            sha256: acquired.sha256,
            selectionReview: {
              visualScore: review.visualScore,
              reasons: review.reasons,
            },
          },
        },
        createdAt: now,
        updatedAt: now,
      }
      transaction.putStep(step)
      return step
    })
  }

  private async appendSearchEvent(
    runId: string,
    event: Readonly<
      | { type: 'tool.started'; payload: { stepId: string; tool: string; label: string } }
      | { type: 'tool.progress'; payload: { stepId: string; completed: number; total: number; summary: string } }
      | { type: 'tool.completed'; payload: { stepId: string; summary: string } }
      | { type: 'tool.failed'; payload: { stepId: string; errorCode: string; retryable: boolean } }
    >,
  ) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, ...event })
    })
  }

  private async recordSourceAssetFailure(
    run: RunRecord,
    requirement: ReturnType<typeof blueprintImageRequirements>[number],
    versionId: string,
  ) {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: `step-${run.id}-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r${run.revisionRound}`,
        runId: run.id,
        idempotencyKey: requirement.idempotencyKey,
        inputHash: hashInput({ tool: 'source_asset_lookup', assetKey: requirement.assetKey }),
        tool: 'generate_slide_image',
        status: 'FAILED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: 'SOURCE_ASSET_NOT_FOUND',
        output: { slideId: requirement.slideId, versionId },
        createdAt: now,
        updatedAt: now,
      }
      transaction.putStep(step)
      return step
    })
  }

  private async completedSummary(
    runId: string,
    requirements: ReturnType<typeof blueprintImageRequirements>,
    status: RunRecord['status'],
  ) {
    const requirementKeys = new Set(requirements.map((requirement) => requirement.idempotencyKey))
    const completed = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image'
        && requirementKeys.has(step.idempotencyKey)
        && step.status === 'COMPLETED'
        && this.artifactId(step))
    return {
      status,
      completed: completed.length,
      total: requirements.length,
      artifactIds: completed.map((step) => this.artifactId(step)!),
    }
  }

  private async pauseForBudget(run: RunRecord, requiredBudgetUnits: number) {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      if (transaction.run.status === 'PAUSED') return transaction.run
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'PAUSED')
      const updated: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      transaction.putRun(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.paused',
        payload: isVisualDeckV4(updated)
          ? {
              ...v4LifecyclePayload(updated, 'RUN', {
                completed: 0,
                total: updated.slideCount,
                pageNumbers: allPageNumbers(updated),
                reason: 'BUDGET_INSUFFICIENT',
                retryable: true,
                requiresUserAction: true,
                nextAction: 'ADD_BUDGET',
              }),
              resumeState: 'EXECUTING',
            }
          : {
              reason: `BUDGET_REQUIRED:${requiredBudgetUnits}`,
              resumeState: 'EXECUTING',
            },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'BUDGET', summary: `剩余页面预计需要 ${requiredBudgetUnits} 预算单位，请追加预算或取消。` },
      })
      return updated
    })
  }

  private async requireHuman(runId: string, step: StepRecord) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      const now = this.dependencies.clock.now().toISOString()
      const fromStatus = transaction.run.status
      const technicalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4'
        && step.errorCode !== 'SOURCE_ASSET_NOT_FOUND'
        ? technicalFailureFromStep(step)
        : null
      const technical = technicalFailure && !['RECOVERING', 'FAILED'].includes(fromStatus)
        ? beginTechnicalRecovery(transaction, this.dependencies.clock, technicalFailure)
        : null
      if (transaction.run.presentationMode === 'VISUAL_DECK_V4' && technicalFailure) {
        const events = transaction.listEvents()
        const started = [...events].reverse().find((event) => event.type === 'generation.started')
        const completedEvent = [...events].reverse().find((event) => event.type === 'generation.completed')
        const stageAlreadyClosed = completedEvent && (!started || completedEvent.sequence > started.sequence)
        if (!stageAlreadyClosed && transaction.run.status !== 'FAILED') {
          const completed = transaction.listSteps().filter((candidate) =>
            candidate.tool === 'generate_slide_image' && candidate.status === 'COMPLETED').length
          appendV4LifecycleEvent(transaction, 'generation.completed', {
            completed: Math.min(completed, transaction.run.slideCount),
            total: transaction.run.slideCount,
            pageNumbers: allPageNumbers(transaction.run),
            reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
            retryable: technicalFailure.disposition === 'RETRYABLE'
              && !transaction.run.pendingTerminalFailure
              && (technical?.technicalRecovery?.retryable
                ?? transaction.run.technicalRecovery?.retryable
                ?? false),
          })
        }
        if (transaction.run.pendingTerminalFailure) {
          reconcileVisualDeckV4TerminalState(transaction, this.dependencies.clock)
        }
        return
      }
      if (fromStatus !== 'NEEDS_HUMAN') {
        const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
        transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: fromStatus, to: 'NEEDS_HUMAN', reason: step.errorCode ?? 'IMAGE_SUBMISSION_FAILED' },
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'HUMAN_REVIEW', summary: '图片任务需要人工核对后才能继续。' },
        })
      }
      const completed = transaction.listSteps().filter((candidate) =>
        candidate.tool === 'generate_slide_image' && candidate.status === 'COMPLETED').length
      appendV4LifecycleEvent(transaction, 'generation.completed', {
        completed: Math.min(completed, transaction.run.slideCount),
        total: transaction.run.slideCount,
        pageNumbers: allPageNumbers(transaction.run),
        reason: step.errorCode === 'SOURCE_ASSET_NOT_FOUND'
          ? 'PAGE_REVIEW_FAILED'
          : 'PROVIDER_TEMPORARILY_UNAVAILABLE',
        retryable: false,
        requiresUserAction: true,
        nextAction: 'REVIEW_RESULT',
      })
    })
  }

  private async appendProgress(runId: string, stepId: string, completed: number, total: number, summary = '已安全提交图片任务') {
    await this.dependencies.repository.transact(runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.progress',
        payload: { stepId, completed, total, summary: `${summary}（${completed}/${total}）` },
      })
    })
  }

  private async appendCompletedPageProgress(runId: string, completed: number, total: number) {
    if (completed === 0) return
    const stepId = `${runId}:completed-pages`
    const current = (await this.dependencies.repository.getRunEventSnapshot(runId)).progress
      .find((item) => item.stepId === stepId)
    if (current?.completed === completed && current.total === total) return
    await this.dependencies.repository.transact(runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.progress',
        payload: { stepId, completed, total, summary: `已完成 ${completed}/${total} 页` },
      })
      appendV4LifecycleEvent(transaction, 'generation.progress', {
        completed,
        total,
        pageNumbers: allPageNumbers(transaction.run),
      })
    })
  }
}

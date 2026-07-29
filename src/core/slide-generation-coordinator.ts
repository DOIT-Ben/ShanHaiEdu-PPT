import { CONTRACT_VERSION } from '../contracts'
import { slideVisualReviewSchema, type PresentationBlueprint, type SlideVisualReview } from '../presentation-contracts'
import { getActiveBlueprint } from './active-blueprint'
import { blueprintImageRequirements } from './blueprint-assets'
import { hashInput } from './hash'
import { MediaStepRunner } from './media-step-runner'
import type {
  AcquiredWebAsset,
  AgentRepository,
  ArtifactPort,
  AssetCandidateReviewPort,
  AssetDiscoveryPort,
  ClockPort,
  DocumentPort,
  RunRecord,
  SourceAsset,
  StepRecord,
} from './ports'
import { evaluateBudget, transitionRun } from './policy'

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

export const ASSET_CANDIDATE_QUALITY_THRESHOLD = 80

export class SlideGenerationCoordinator {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    media: MediaStepRunner
    documents: DocumentPort
    artifacts: ArtifactPort
    discovery?: AssetDiscoveryPort
    candidateReviewer?: AssetCandidateReviewPort
    clock: ClockPort
  }>) {}

  async submitBlueprintImages(runId: string, unitBudgetUnits: number): Promise<SubmitBlueprintImagesResult> {
    if (!Number.isSafeInteger(unitBudgetUnits) || unitBudgetUnits <= 0) throw new Error('INVALID_UNIT_BUDGET')
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    if (run.status === 'PAUSED' || run.status === 'NEEDS_HUMAN') {
      return { status: run.status, submitted: 0, total: run.slideCount, steps: [] }
    }
    if (run.status !== 'EXECUTING') throw new Error('RUN_NOT_EXECUTING')
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    const requirements = blueprintImageRequirements(run, blueprint)
    const requirementKeys = new Set(requirements.map((requirement) => requirement.idempotencyKey))
    const existingSteps = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && requirementKeys.has(step.idempotencyKey))
    const sequentialPageExecution = run.source.kind === 'APPROVED_PAGE_DESIGN'
    const blockingStep = existingSteps.find((step) => ['FAILED', 'RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(step.status))
    if (blockingStep) {
      await this.requireHuman(runId, blockingStep)
      return { status: 'NEEDS_HUMAN', submitted: 0, total: blueprint.slides.length, steps: existingSteps }
    }
    if (sequentialPageExecution && existingSteps.some((step) =>
      ['WAITING', 'RELEASING'].includes(step.status))) {
      return {
        status: run.status,
        submitted: existingSteps.filter((step) => ['WAITING', 'COMPLETED'].includes(step.status)).length,
        total: requirements.length,
        steps: existingSteps,
      }
    }
    const existingByKey = new Map(existingSteps.map((step) => [step.idempotencyKey, step]))
    const pendingRequirements = requirements.filter((requirement) => {
      const existing = existingByKey.get(requirement.idempotencyKey)
      return !existing || ['RESERVED', 'SUBMITTING'].includes(existing.status)
    })

    if (pendingRequirements.length === 0) {
      return {
        status: run.status,
        submitted: existingSteps.filter((step) => ['WAITING', 'COMPLETED'].includes(step.status)).length,
        total: requirements.length,
        steps: existingSteps,
      }
    }

    const steps = [...existingSteps]
    const unresolvedRequirements = []
    const currentRequirements = sequentialPageExecution ? pendingRequirements.slice(0, 1) : pendingRequirements
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
      !existingByKey.has(requirement.idempotencyKey)
      && requirement.sourceAssetStrategy !== 'REUSE_ORIGINAL').length
    if (chargeableCount > 0) {
      const decision = evaluateBudget(run, chargeableCount * unitBudgetUnits)
      if (!decision.allowed && decision.reason === 'BUDGET_EXCEEDED') {
        const paused = await this.pauseForBudget(run, chargeableCount * unitBudgetUnits)
        return { status: paused.status, submitted: steps.length, total: requirements.length, steps }
      }
      if (!decision.allowed) throw new Error(decision.reason)
    }

    const needsSourceAssets = unresolvedRequirements.some((requirement) =>
      requirement.sourceAssetStrategy === 'REUSE_ORIGINAL' || requirement.sourceAssetStrategy === 'REFERENCE_GENERATION')
    const document = needsSourceAssets
      ? await this.dependencies.documents.resolve({ host: run.host, source: run.source })
      : null
    const sourceAssets = new Map((document?.assets ?? []).map((asset) => [asset.id, asset]))
    for (const requirement of unresolvedRequirements) {
      const key = requirement.idempotencyKey
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
      const result = await this.dependencies.media.submitSlideImage({
        runId,
        stepId: `step-${runId}-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r${run.revisionRound}`,
        idempotencyKey: key,
        slideId: requirement.slideId,
        versionId,
        prompt: requirement.prompt,
        ...(requirement.negativePrompt ? { negativePrompt: requirement.negativePrompt } : {}),
        model: run.imageModel,
        budgetUnits: unitBudgetUnits,
        aspectRatio: requirement.aspectRatio,
        backgroundMode: requirement.backgroundMode,
        ...(requirement.elementId ? { elementId: requirement.elementId } : {}),
        ...(requirement.reuseKey ? { assetReuseKey: requirement.reuseKey } : {}),
        ...(sourceAsset ? { referenceImage: {
          mimeType: sourceAsset.mimeType,
          bytes: sourceAsset.bytes,
          sha256: sourceAsset.sha256,
        } } : {}),
      })
      const existingIndex = steps.findIndex((step) => step.idempotencyKey === result.step.idempotencyKey)
      if (existingIndex === -1) steps.push(result.step)
      else steps[existingIndex] = result.step
      const latestRun = await this.dependencies.repository.getRun(runId)
      if (!latestRun || latestRun.status === 'NEEDS_HUMAN' || latestRun.status === 'PAUSED') break
      if (result.step.status === 'FAILED') {
        await this.requireHuman(runId, result.step)
        break
      }
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
    for (const step of steps.filter((candidate) => ['WAITING', 'RELEASING'].includes(candidate.status))) {
      await this.dependencies.media.refreshSlideImage(runId, step.idempotencyKey)
      const latest = await this.dependencies.repository.getRun(runId)
      if (!latest || latest.status === 'NEEDS_HUMAN') break
    }

    const refreshed = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && requirementKeys.has(step.idempotencyKey))
    const failed = refreshed.find((step) => ['FAILED', 'RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(step.status))
    if (failed) await this.requireHuman(runId, failed)
    const completed = refreshed.filter((step) => step.status === 'COMPLETED' && this.artifactId(step) !== null)
    await this.appendCompletedPageProgress(runId, completed.length, requirements.length)
    const latest = await this.dependencies.repository.getRun(runId)
    if (!failed && completed.length === requirements.length && latest?.status === 'EXECUTING') {
      await this.dependencies.repository.transact(runId, (transaction) => {
        if (transaction.run.status !== 'EXECUTING') return
        const now = this.dependencies.clock.now().toISOString()
        const policy = transitionRun(transaction.run, 'PAGE_REVIEW')
        transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'EXECUTING', to: 'PAGE_REVIEW' },
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

  private artifactId(step: StepRecord) {
    const output = step.output as { artifactId?: unknown } | null
    return output && typeof output.artifactId === 'string' ? output.artifactId : null
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
        payload: {
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
      if (transaction.run.status === 'NEEDS_HUMAN') return
      const now = this.dependencies.clock.now().toISOString()
      const fromStatus = transaction.run.status
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
    })
  }
}

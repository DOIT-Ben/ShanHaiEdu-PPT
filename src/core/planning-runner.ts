import type { CreateRunRequest, PlanningFailure } from '../contracts'
import { CONTRACT_VERSION } from '../contracts'
import { ZodError } from 'zod'
import {
  blueprintDraftSchema,
  blueprintReflectionSchema,
  presentationBlueprintSchema,
  type PresentationBlueprint,
} from '../presentation-contracts'
import { hashInput } from './hash'
import { StructuredModelError } from './ports'
import type {
  AgentRepository,
  AgentTransaction,
  ClockPort,
  DocumentPort,
  DocumentResult,
  RunRecord,
  StepRecord,
  StructuredModelPort,
} from './ports'
import { transitionRun } from './policy'
import { getPresentationModeStrategy } from './presentation-mode-strategy'
import {
  createVisualDeckV4BlueprintFromProposal,
  type VisualDeckV4PlanningStage,
  visualDeckV4PlanningStageStepKey,
} from './visual-deck-v4-planner'
import {
  visualDeckV4DeckVisualStageSchema,
  visualDeckV4FinalCoherenceReviewSchema,
  visualDeckV4ProposalDraftSchema,
  visualDeckV4SlideBriefsStageSchema,
  visualDeckV4SourceSpecStageSchema,
} from '../visual-deck-v4-contracts'
import type { StructuredGenerationPreflightPort, StructuredGenerationProtocol } from './ports'
import { allPageNumbers, appendV4LifecycleEvent } from './v4-lifecycle'

const MAX_BLUEPRINT_CONTRACT_ATTEMPTS = 5
const MAX_PROVIDER_ATTEMPTS = 5
const PROVIDER_RETRY_DELAYS_MS = [5_000, 30_000, 60_000, 120_000] as const

export function approvedPageLayout(layoutIntent: string, pageIndex: number) {
  const visual = '(图|图片|插图|视觉|主视觉|场景|情境|照片)'
  const copy = '(文|文字|标题|要点|文案|内容)'
  if (new RegExp(`(右.{0,8}${copy}.{0,12}左.{0,8}${visual}|左.{0,8}${visual}.{0,12}右.{0,8}${copy})`, 'i').test(layoutIntent)) return 'EDITORIAL' as const
  if (new RegExp(`(左.{0,8}${copy}.{0,12}右.{0,8}${visual}|右.{0,8}${visual}.{0,12}左.{0,8}${copy}|左右|split|双栏|两栏)`, 'i').test(layoutIntent)) return 'SPLIT' as const
  if (/(封面|hero)/i.test(layoutIntent)) return 'HERO' as const
  if (/(全屏|满版|沉浸|大图|full[ -]?bleed|image[ -]?full)/i.test(layoutIntent)) return 'IMAGE_FULL' as const
  if (/(结论|金句|核心观点|强调|statement)/i.test(layoutIntent)) return 'STATEMENT' as const
  if (pageIndex === 0) return 'HERO' as const
  return 'EDITORIAL' as const
}

type ApprovedPageDesignSource = Extract<CreateRunRequest['source'], { kind: 'APPROVED_PAGE_DESIGN' }>

export function approvedPageVisualDirection(source: ApprovedPageDesignSource) {
  return [
    `适合${source.gradeBand}${source.subject}课堂投影的统一儿童友好教育插画风格`,
    '明亮自然色，清晰主体，简洁背景，稳定材质与光线，不绘制任何文字或界面。',
  ].join('；')
}

function approvedPageVisualRequirements(requirements: readonly string[]) {
  const excluded = /(可编辑|标题|副标题|教材信息|文案|文字|数字|公式|算式|题面|句式|空格|任务卡|文本卡|问题卡|语言卡|提示)/i
  const visual = requirements
    .flatMap((requirement) => requirement.split(/[；;，,。]/))
    .map((requirement) => requirement.trim())
    .filter((requirement) => requirement && !excluded.test(requirement))
  return visual.join('；') || '使用与本页视觉要求直接相关的单一课堂主视觉'
}

function approvedPageComposition(layout: ReturnType<typeof approvedPageLayout>) {
  if (layout === 'HERO' || layout === 'IMAGE_FULL') return '使用沉浸式满版场景，保持一个明确主视觉焦点。'
  if (layout === 'SPLIT') return '将主要视觉放在画面右侧，左侧保留自然、无边框的排版留白。'
  if (layout === 'STATEMENT') return '将主要视觉放在右下区域，左上保留自然、无边框的排版留白。'
  return '将主要视觉放在画面左侧，右侧保留自然、无边框的排版留白。'
}

export function approvedPageVisualPrompt(
  source: ApprovedPageDesignSource,
  page: ApprovedPageDesignSource['pages'][number],
  pageIndex: number,
) {
  const layout = approvedPageLayout(page.layoutIntent, pageIndex)
  const visualDirection = approvedPageVisualDirection(source)
  const visualRequirements = approvedPageVisualRequirements(page.visualRequirements)
  return [
    `只为当前第 ${page.pageNumber} 页创作一张连续、无边框的 16:9 教育场景图片。`,
    `统一视觉风格：${visualDirection}`,
    `本页视觉要求：${visualRequirements}。`,
    `构图与空间关系：${approvedPageComposition(layout)}`,
    '只呈现一个完整画面和一个主要视觉焦点，不得绘制多格分镜、课件缩略图拼贴、其他页面内容或整套课程流程。',
    '设计稿中提到的标题、文案、数字、公式、任务卡和可编辑区域只表示后续排版位置；图片中必须保持自然留白，不得绘制这些内容、占位框或界面组件。',
    '不得绘制任何文字、字母、数字、公式、标志、水印或 logo。',
  ].join(' ')
}

function visualDeckV4SourceReferences(source: CreateRunRequest['source']) {
  if (source.kind === 'SOURCE_PACKAGE') {
    return source.sources.map((item) => ({
      sourceId: item.sourceId,
      name: item.kind === 'TEXT' ? item.name ?? item.sourceId : item.sourceId,
      kind: item.kind,
      roleHint: item.roleHint ?? 'AUTO',
    }))
  }
  if (source.kind === 'APPROVED_PAGE_DESIGN') {
    return [{
      sourceId: source.artifactVersionId,
      name: source.title,
      kind: source.kind,
      roleHint: 'DESIGN_REFERENCE' as const,
    }]
  }
  return [{
    sourceId: source.kind === 'TEXT' ? 'inline-source' : source.attachmentId,
    name: source.kind === 'TEXT' ? source.name ?? 'inline-material.txt' : source.attachmentId,
    kind: source.kind,
    roleHint: source.roleHint ?? 'AUTO',
  }]
}

class PlanningFailureError extends Error {
  constructor(readonly failure: PlanningFailure) {
    super(failure.errorCode)
    this.name = 'PlanningFailureError'
  }
}

export type PlanPresentationInput = Readonly<{
  runId: string
  stepId: string
  idempotencyKey: string
  source: CreateRunRequest['source']
  slideCount: number
  visualDirection: string
  targetAudience?: string
  presentationGoal?: string
  presentationMode?: CreateRunRequest['presentationMode']
  coverDesignMode?: CreateRunRequest['coverDesignMode']
  assetAcquisitionPolicy?: CreateRunRequest['assetAcquisitionPolicy']
  maxVisualAssetsPerSlide?: CreateRunRequest['maxVisualAssetsPerSlide']
  visualDeckV4?: CreateRunRequest['visualDeckV4']
  attempt?: number
}>

export type PlanPresentationResult = Readonly<{
  step: StepRecord
  blueprint: PresentationBlueprint | null
  replayed: boolean
}>

export function planningStepKey(runId: string, attempt = 0) {
  return attempt === 0 ? `${runId}:blueprint:v1` : `${runId}:blueprint:retry:${attempt}`
}

export class PlanningRunner {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    documents: DocumentPort
    model: StructuredModelPort
    clock: ClockPort
    sleep?: (milliseconds: number) => Promise<void>
  }>) {}

  async plan(input: PlanPresentationInput): Promise<PlanPresentationResult> {
    const run = await this.requireRun(input.runId)
    const presentationMode = run.presentationMode ?? 'SLIDE_IMAGE_V2'
    if (input.presentationMode && input.presentationMode !== presentationMode) {
      throw new Error('RUN_PRESENTATION_MODE_MISMATCH')
    }
    if (input.visualDeckV4 && hashInput(input.visualDeckV4) !== hashInput(run.visualDeckV4 ?? null)) {
      throw new Error('RUN_VISUAL_DECK_V4_CONFIG_MISMATCH')
    }
    const strategy = getPresentationModeStrategy(presentationMode)
    const visualDeckV4 = run.visualDeckV4
    if (strategy.planningKind === 'VISUAL_DECK_COMPILER' && !visualDeckV4) throw new Error('VISUAL_DECK_V4_CONFIG_REQUIRED')
    const { visualDeckV4: _requestedVisualDeckV4, ...baseInput } = input
    const effectiveInput: PlanPresentationInput = {
      ...baseInput,
      presentationMode,
      ...(visualDeckV4 ? { visualDeckV4 } : {}),
    }
    const document = await this.dependencies.documents.resolve({ host: run.host, source: effectiveInput.source })
    const prepared = await this.prepare(effectiveInput, document)
    if (prepared.replayed) return prepared

    if (!document.isComplete || document.chunks.length === 0) {
      const step = await this.fail(effectiveInput, this.sourceFailure(effectiveInput), 'SOURCE_INCOMPLETE', document)
      return { step, blueprint: null, replayed: false }
    }

    try {
      const blueprint = strategy.planningKind === 'VISUAL_DECK_COMPILER'
        ? await this.createVisualDeckV4Blueprint(
            effectiveInput,
            document,
            prepared.step.inputHash,
            run.host.tenantId,
            visualDeckV4!,
          )
        : effectiveInput.source.kind === 'APPROVED_PAGE_DESIGN'
          ? this.createApprovedBlueprint(effectiveInput, document, prepared.step.inputHash)
          : await this.createBlueprint(effectiveInput, document, prepared.step.inputHash, run.host.tenantId)
      const step = await this.complete(effectiveInput, blueprint)
      return { step, blueprint, replayed: false }
    } catch (error) {
      const failure = error instanceof PlanningFailureError
        ? error.failure
        : this.contractFailure(effectiveInput, error, 1, 1, false)
      const step = await this.fail(effectiveInput, failure, 'PLANNING_FAILED', document)
      return { step, blueprint: null, replayed: false }
    }
  }

  private async createVisualDeckV4Blueprint(
    input: PlanPresentationInput,
    document: DocumentResult,
    inputHash: string,
    tenantId: string,
    config: NonNullable<CreateRunRequest['visualDeckV4']>,
  ) {
    const basePayload = {
      presentationMode: 'VISUAL_DECK_V4' as const,
      instruction: config.instruction,
      deckOptions: config.deckOptions,
      sourceMode: config.sourceMode,
      sourceReferences: visualDeckV4SourceReferences(input.source),
      slideCount: input.slideCount,
      visualDirection: input.visualDirection,
      ...(input.targetAudience ? { targetAudience: input.targetAudience } : {}),
      ...(input.presentationGoal ? { presentationGoal: input.presentationGoal } : {}),
      document: {
        name: document.name,
        sources: document.sources ?? [],
        chunks: document.chunks.map((chunk) => ({
          id: chunk.id,
          sourceId: chunk.sourceId,
          sha256: chunk.sha256,
          text: chunk.text,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          region: chunk.region,
        })),
        assets: (document.assets ?? []).map(({ bytes: _bytes, ...asset }) => asset),
        missingRanges: document.missingRanges,
      },
    }
    const compilerInput = {
      runId: input.runId,
      inputHash,
      source: input.source,
      document,
      config,
      slideCount: input.slideCount,
      visualDirection: input.visualDirection,
      ...(input.targetAudience ? { targetAudience: input.targetAudience } : {}),
      ...(input.presentationGoal ? { presentationGoal: input.presentationGoal } : {}),
      createdAt: this.dependencies.clock.now().toISOString(),
    }
    const protocol = await this.resolveV4StructuredGenerationProtocol(input, tenantId)
    const sourceSpec = visualDeckV4SourceSpecStageSchema.parse(await this.runV4PlanningStage(input, {
      stage: 'source-spec',
      tool: 'compile_v4_source_spec',
      operation: 'create_visual_deck_v4_source_spec',
      schemaName: 'ppt_agent_v4_source_spec_v1',
      payload: basePayload,
      sourceAssets: document.assets ?? [],
      protocol,
      parse: visualDeckV4SourceSpecStageSchema.parse,
    }))
    const deckVisual = visualDeckV4DeckVisualStageSchema.parse(await this.runV4PlanningStage(input, {
      stage: 'deck-visual',
      tool: 'compile_v4_deck_visual',
      operation: 'create_visual_deck_v4_deck_visual',
      schemaName: 'ppt_agent_v4_deck_visual_v1',
      payload: { ...basePayload, ...sourceSpec },
      protocol,
      parse: visualDeckV4DeckVisualStageSchema.parse,
    }))
    const slideBriefs = visualDeckV4SlideBriefsStageSchema.parse(await this.runV4PlanningStage(input, {
      stage: 'slide-briefs',
      tool: 'compile_v4_slide_briefs',
      operation: 'create_visual_deck_v4_slide_briefs',
      schemaName: 'ppt_agent_v4_slide_briefs_v1',
      payload: { ...basePayload, ...sourceSpec, ...deckVisual },
      protocol,
      parse: visualDeckV4SlideBriefsStageSchema.parse,
    }))
    const proposalDraft = visualDeckV4ProposalDraftSchema.parse({ ...sourceSpec, ...deckVisual, ...slideBriefs })
    await this.runV4PlanningStage(input, {
      stage: 'final-coherence',
      tool: 'review_v4_final_coherence',
      operation: 'review_visual_deck_v4_coherence',
      schemaName: 'ppt_agent_v4_final_coherence_v1',
      payload: proposalDraft,
      protocol,
      parse: visualDeckV4FinalCoherenceReviewSchema.parse,
    })
    return createVisualDeckV4BlueprintFromProposal(compilerInput, proposalDraft)
  }

  private async resolveV4StructuredGenerationProtocol(input: PlanPresentationInput, tenantId: string) {
    const key = `${input.runId}:v4:structured-generation-preflight:planning:${input.attempt ?? 0}`
    const inputHash = hashInput({ tool: 'preflight_v4_structured_generation', model: this.dependencies.model.modelName ?? null })
    const existing = await this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(key)
      if (!step) return null
      if (step.inputHash !== inputHash || step.tool !== 'preflight_v4_structured_generation') {
        throw new Error('STEP_IDEMPOTENCY_CONFLICT')
      }
      if (step.status === 'COMPLETED') return step.output
      if (step.status === 'FAILED') {
        const now = this.dependencies.clock.now().toISOString()
        transaction.putStep({ ...step, status: 'RUNNING', errorCode: null, updatedAt: now })
      }
      return null
    })
    if (existing) {
      const persisted = this.parseV4StructuredGenerationProtocol(existing)
      await this.dependencies.repository.transact(input.runId, (transaction) => {
        if (transaction.run.v4StructuredGenerationProtocol === persisted.protocol) return
        transaction.putRun({ ...transaction.run, v4StructuredGenerationProtocol: persisted.protocol, updatedAt: this.dependencies.clock.now().toISOString() })
      })
      return persisted.protocol
    }
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      if (transaction.getStep(key)) return
      const now = this.dependencies.clock.now().toISOString()
      transaction.putStep({
        id: `step-${hashInput({ key }).slice(0, 28)}`,
        runId: input.runId,
        idempotencyKey: key,
        inputHash,
        tool: 'preflight_v4_structured_generation',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: now,
        updatedAt: now,
      })
    })
    try {
      const candidate = this.dependencies.model as StructuredModelPort & Partial<StructuredGenerationPreflightPort>
      if (!candidate.preflightStructuredGeneration) throw new Error('STRUCTURED_GENERATION_PREFLIGHT_UNAVAILABLE')
      const result = this.parseV4StructuredGenerationProtocol(await candidate.preflightStructuredGeneration({
        tenantId,
        idempotencyKey: key,
      }))
      await this.dependencies.repository.transact(input.runId, (transaction) => {
        const step = transaction.getStep(key)
        if (!step) throw new Error('STEP_NOT_FOUND')
        const now = this.dependencies.clock.now().toISOString()
        transaction.putStep({ ...step, status: 'COMPLETED', output: result, errorCode: null, updatedAt: now })
        transaction.putRun({ ...transaction.run, v4StructuredGenerationProtocol: result.protocol, updatedAt: now })
      })
      return result.protocol
    } catch (error) {
      const failure = this.providerFailure(input, error, 1) ?? this.contractFailure(input, error, 1, 1, false)
      await this.dependencies.repository.transact(input.runId, (transaction) => {
        const step = transaction.getStep(key)
        if (!step || step.status === 'FAILED') return
        transaction.putStep({ ...step, status: 'FAILED', errorCode: failure.errorCode, updatedAt: this.dependencies.clock.now().toISOString() })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'tool.failed',
          payload: { stepId: step.id, errorCode: failure.errorCode, retryable: failure.retryable },
        })
      })
      throw new PlanningFailureError(failure)
    }
  }

  private parseV4StructuredGenerationProtocol(value: unknown): Readonly<{ protocol: StructuredGenerationProtocol }> {
    if (!value || typeof value !== 'object' || !('protocol' in value)) throw new Error('STRUCTURED_GENERATION_PROTOCOL_INVALID')
    const protocol = value.protocol
    if (protocol !== 'RESPONSES_JSON_SCHEMA' && protocol !== 'RESPONSES_FUNCTION' && protocol !== 'CHAT_LEGACY') {
      throw new Error('STRUCTURED_GENERATION_PROTOCOL_INVALID')
    }
    return { protocol }
  }

  private async runV4PlanningStage(input: PlanPresentationInput, request: Readonly<{
    stage: VisualDeckV4PlanningStage
    tool: string
    operation: string
    schemaName: string
    payload: unknown
    sourceAssets?: Parameters<StructuredModelPort['execute']>[0]['sourceAssets']
    protocol: StructuredGenerationProtocol
    parse: (value: unknown) => unknown
  }>) {
    const key = visualDeckV4PlanningStageStepKey(input.runId, request.stage, input.attempt ?? 0)
    const inputHash = hashInput({ tool: request.tool, operation: request.operation, schemaName: request.schemaName, payload: request.payload, protocol: request.protocol })
    const existing = await this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(key)
      if (!step) return null
      if (step.inputHash !== inputHash || step.tool !== request.tool) throw new Error('STEP_IDEMPOTENCY_CONFLICT')
      if (step.status === 'COMPLETED') return step.output
      if (step.status === 'FAILED') {
        const now = this.dependencies.clock.now().toISOString()
        transaction.putStep({ ...step, status: 'RUNNING', errorCode: null, updatedAt: now })
      }
      return null
    })
    if (existing) return existing
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      if (transaction.getStep(key)) return
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: `step-${hashInput({ key }).slice(0, 28)}`,
        runId: input.runId,
        idempotencyKey: key,
        inputHash,
        tool: request.tool,
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
        payload: { stepId: step.id, tool: step.tool, label: `V4 规划阶段：${request.stage}` },
      })
    })
    try {
      const raw = await this.executeWithProviderRetry(input, {
        tenantId: (await this.requireRun(input.runId)).host.tenantId,
        operation: request.operation,
        schemaName: request.schemaName,
        payload: request.payload,
        ...(request.sourceAssets ? { sourceAssets: request.sourceAssets } : {}),
        idempotencyKey: key,
        structuredGenerationProtocol: request.protocol,
      })
      const output = request.parse(raw)
      return await this.dependencies.repository.transact(input.runId, (transaction) => {
        const step = transaction.getStep(key)
        if (!step) throw new Error('STEP_NOT_FOUND')
        const completed: StepRecord = { ...step, status: 'COMPLETED', output, errorCode: null, updatedAt: this.dependencies.clock.now().toISOString() }
        transaction.putStep(completed)
        transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'tool.completed', payload: { stepId: step.id, summary: `V4 规划阶段已完成：${request.stage}` } })
        return output
      })
    } catch (error) {
      const failure = error instanceof PlanningFailureError
        ? error.failure
        : this.contractFailure(input, error, 1, 1, false)
      await this.dependencies.repository.transact(input.runId, (transaction) => {
        const step = transaction.getStep(key)
        if (!step || step.status === 'FAILED') return
        transaction.putStep({ ...step, status: 'FAILED', errorCode: failure.errorCode, updatedAt: this.dependencies.clock.now().toISOString() })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'tool.failed',
          payload: { stepId: step.id, errorCode: failure.errorCode, retryable: failure.retryable },
        })
      })
      throw new PlanningFailureError(failure)
    }
  }

  private createApprovedBlueprint(
    input: PlanPresentationInput,
    document: DocumentResult,
    inputHash: string,
  ) {
    if (input.source.kind !== 'APPROVED_PAGE_DESIGN') throw new Error('APPROVED_PAGE_DESIGN_REQUIRED')
    const source = input.source
    if (source.pages.length !== input.slideCount) throw new Error('BLUEPRINT_SLIDE_COUNT_MISMATCH')
    const chunksByPage = new Map(document.chunks.map((chunk) => [chunk.pageStart, chunk]))
    const sourceChunkIds = document.chunks.map((chunk) => chunk.id)
    const visualDirection = approvedPageVisualDirection(source)
    const slides = source.pages.map((page, index) => {
      const chunk = chunksByPage.get(page.pageNumber)
      if (!chunk || chunk.pageEnd !== page.pageNumber) throw new Error('BLUEPRINT_SOURCE_REFERENCE_INVALID')
      const layout = approvedPageLayout(page.layoutIntent, index)
      return {
        pageNumber: page.pageNumber,
        title: page.title,
        body: page.editableCopy,
        layout,
        visualIntent: `本页教学目标：${page.teachingPurpose}`,
        visualPrompt: approvedPageVisualPrompt(source, page, index),
        sourceChunkIds: [chunk.id],
        sourceAssetIds: [],
      }
    })
    const sourceSummary = [
      `${source.gradeBand}${source.subject}《${source.title}》`,
      `面向${source.audience}，课时 ${source.lessonDurationMinutes} 分钟。`,
      `已由教师审核 ${source.pages.length} 页逐页设计稿，执行时不得重新规划或扩展审核范围。`,
    ].join(' ')
    return presentationBlueprintSchema.parse({
      id: `blueprint-${hashInput({ runId: input.runId, inputHash }).slice(0, 28)}`,
      title: source.title,
      curriculum: {
        subject: source.subject,
        grade: source.gradeBand,
        lessonTitle: source.title,
        sourceSummary,
        learningObjectives: source.objectives,
        scopeBoundaries: ['以每一页已审核的教学目的、文案和视觉要求为唯一执行范围'],
        prohibitedExtensions: ['不得扩展到教师已审核逐页设计稿之外的教学内容'],
        sourceChunkIds,
        sourceAssetIds: [],
      },
      slides,
      visualDirection,
      renderMode: 'SLIDE_IMAGE_V2',
      coverDesignMode: input.coverDesignMode ?? 'INDEPENDENT',
      sourceManifest: document.sources ?? [],
      sourceAssets: [],
      createdAt: this.dependencies.clock.now().toISOString(),
    })
  }

  private async createBlueprint(input: PlanPresentationInput, document: DocumentResult, inputHash: string, tenantId: string) {
    const strategy = getPresentationModeStrategy(input.presentationMode ?? 'SLIDE_IMAGE_V2')
    const basePayload = {
      slideCount: input.slideCount,
      visualDirection: input.visualDirection,
      ...(input.targetAudience ? { targetAudience: input.targetAudience } : {}),
      ...(input.presentationGoal ? { presentationGoal: input.presentationGoal } : {}),
      presentationMode: input.presentationMode ?? 'SLIDE_IMAGE_V2',
      coverDesignMode: input.coverDesignMode ?? 'INDEPENDENT',
      assetAcquisitionPolicy: input.assetAcquisitionPolicy ?? 'AI_FIRST',
      maxVisualAssetsPerSlide: input.maxVisualAssetsPerSlide ?? 4,
      visualDeckV4: input.visualDeckV4 ?? null,
      document: {
        name: document.name,
        sources: document.sources ?? [],
        chunks: document.chunks.map((chunk) => ({
          id: chunk.id,
          sourceId: chunk.sourceId,
          sha256: chunk.sha256,
          text: chunk.text,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          region: chunk.region,
        })),
        assets: (document.assets ?? []).map(({ bytes: _bytes, ...asset }) => asset),
      },
    }
    let repairIssues: { path: string; message: string }[] = []
    let initialDraft: ReturnType<typeof blueprintDraftSchema.parse> | null = null
    for (let attempt = 0; attempt < MAX_BLUEPRINT_CONTRACT_ATTEMPTS; attempt++) {
      try {
        const modelKey = attempt === 0
          ? input.idempotencyKey
          : `blueprint-repair-${hashInput({ idempotencyKey: input.idempotencyKey, attempt })}`
        const raw = await this.executeWithProviderRetry(input, {
          tenantId,
          operation: 'create_blueprint',
          schemaName: 'ppt_agent_blueprint_v1',
          idempotencyKey: modelKey,
          payload: { ...basePayload, ...(repairIssues.length > 0 ? { contractRepairIssues: repairIssues } : {}) },
          sourceAssets: document.assets ?? [],
        })
        const draft = blueprintDraftSchema.parse(raw)
        this.assertBlueprintCoverage(
          draft,
          document,
          input.slideCount,
          input.presentationMode ?? 'SLIDE_IMAGE_V2',
          input.maxVisualAssetsPerSlide ?? 4,
        )
        initialDraft = draft
        break
      } catch (error) {
        if (error instanceof PlanningFailureError) throw error
        const issues = this.contractIssues(error)
        if (!issues) throw new PlanningFailureError(this.contractFailure(input, error, attempt + 1, MAX_BLUEPRINT_CONTRACT_ATTEMPTS, false))
        if (attempt === MAX_BLUEPRINT_CONTRACT_ATTEMPTS - 1) {
          throw new PlanningFailureError(this.contractFailure(
            input,
            error,
            attempt + 1,
            MAX_BLUEPRINT_CONTRACT_ATTEMPTS,
            true,
          ))
        }
        repairIssues = issues
      }
    }
    if (!initialDraft) throw new Error('BLUEPRINT_CONTRACT_REPAIR_EXHAUSTED')
    const draft = strategy.planningKind === 'BLUEPRINT_WITH_REFLECTION'
      ? await this.reflectBlueprint(input, initialDraft, tenantId)
      : initialDraft
    this.assertBlueprintCoverage(
      draft,
      document,
      input.slideCount,
      input.presentationMode ?? 'SLIDE_IMAGE_V2',
      input.maxVisualAssetsPerSlide ?? 4,
    )
    return presentationBlueprintSchema.parse({
      ...draft,
      id: `blueprint-${hashInput({ runId: input.runId, inputHash }).slice(0, 28)}`,
      visualDirection: input.visualDirection,
      renderMode: input.presentationMode ?? 'SLIDE_IMAGE_V2',
      coverDesignMode: input.coverDesignMode ?? 'INDEPENDENT',
      sourceManifest: document.sources ?? [],
      sourceAssets: (document.assets ?? []).map(({ bytes: _bytes, ...asset }) => asset),
      createdAt: this.dependencies.clock.now().toISOString(),
    })
  }

  private async reflectBlueprint(
    input: PlanPresentationInput,
    initialDraft: ReturnType<typeof blueprintDraftSchema.parse>,
    tenantId: string,
  ) {
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.progress',
        payload: {
          stepId: input.stepId,
          completed: 1,
          total: 2,
          summary: '蓝图初稿已完成，正在按受众、叙事与视觉标准反思修订',
        },
      })
    })
    const raw = await this.executeWithProviderRetry(input, {
      tenantId,
      operation: 'reflect_blueprint',
      schemaName: 'ppt_agent_blueprint_reflection_v1',
      idempotencyKey: `blueprint-reflection-${hashInput({
        idempotencyKey: input.idempotencyKey,
        initialDraft,
      })}`,
      payload: {
        presentationMode: 'SLIDE_IMAGE_V2_1',
        slideCount: input.slideCount,
        visualDirection: input.visualDirection,
        ...(input.targetAudience ? { targetAudience: input.targetAudience } : {}),
        ...(input.presentationGoal ? { presentationGoal: input.presentationGoal } : {}),
        originalBlueprint: initialDraft,
      },
    })
    return blueprintReflectionSchema.parse(raw).revisedBlueprint
  }

  private async executeWithProviderRetry(
    input: PlanPresentationInput,
    request: Parameters<StructuredModelPort['execute']>[0],
  ) {
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
      try {
        return await this.dependencies.model.execute(request)
      } catch (error) {
        const failure = this.providerFailure(input, error, attempt)
        if (!failure) throw error
        if (!failure.retryable || attempt === MAX_PROVIDER_ATTEMPTS) throw new PlanningFailureError(failure)
        await this.recordProviderRetry(input, failure, attempt + 1)
        await (this.dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
          PROVIDER_RETRY_DELAYS_MS[attempt - 1] ?? PROVIDER_RETRY_DELAYS_MS.at(-1)!,
        )
      }
    }
    throw new Error('PROVIDER_RETRY_LOOP_INVALID')
  }

  private providerFailure(input: PlanPresentationInput, error: unknown, attempt: number): PlanningFailure | null {
    if (!(error instanceof StructuredModelError) || error.code === 'MODEL_JSON_INVALID') return null
    return {
      errorCode: error.code,
      retryable: error.retryable,
      attempt,
      maxAttempts: MAX_PROVIDER_ATTEMPTS,
      suggestedAction: error.retryable ? 'RETRY' : 'CONTACT_ADMIN',
      diagnosticCode: error.code,
      fieldPaths: [],
      correlationId: this.correlationId(input),
      requestId: error.requestId ?? this.traceRequestId(input),
      model: error.model,
      contractVersion: CONTRACT_VERSION,
    }
  }

  private sourceFailure(input: PlanPresentationInput): PlanningFailure {
    return {
      errorCode: 'SOURCE_INCOMPLETE',
      retryable: false,
      attempt: 0,
      maxAttempts: 0,
      suggestedAction: 'MODIFY_SOURCE',
      diagnosticCode: 'SOURCE_INCOMPLETE',
      fieldPaths: ['source'],
      correlationId: this.correlationId(input),
      requestId: this.traceRequestId(input),
      model: this.dependencies.model.modelName ?? null,
      contractVersion: CONTRACT_VERSION,
    }
  }

  private contractFailure(
    input: PlanPresentationInput,
    error: unknown,
    attempt: number,
    maxAttempts: number,
    exhausted: boolean,
  ): PlanningFailure {
    const fieldPaths = error instanceof ZodError
      ? [...new Set(error.issues.map((issue) => issue.path.join('.') || 'blueprint'))].slice(0, 20)
      : error instanceof StructuredModelError && error.code === 'MODEL_JSON_INVALID'
        ? ['blueprint']
        : []
    const message = error instanceof Error ? error.message : ''
    const errorCode: PlanningFailure['errorCode'] = error instanceof ZodError
      ? input.presentationMode === 'LAYERED_COURSEWARE_V3' && error.issues.some((issue) =>
        issue.path.includes('layeredDesign') || issue.path.includes('elements'))
        ? 'V3_LAYER_CONTRACT_INVALID'
        : 'BLUEPRINT_SCHEMA_INVALID'
      : message === 'BLUEPRINT_SLIDE_COUNT_MISMATCH'
        ? 'BLUEPRINT_SLIDE_COUNT_MISMATCH'
        : message === 'BLUEPRINT_SOURCE_REFERENCE_INVALID'
          ? 'BLUEPRINT_SOURCE_REFERENCE_INVALID'
          : message === 'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID'
            ? 'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID'
            : message === 'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE'
              ? 'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE'
          : message === 'BLUEPRINT_VISUAL_ASSET_LIMIT_EXCEEDED'
            ? 'VISUAL_ASSET_LIMIT_EXCEEDED'
            : message === 'LAYERED_BLUEPRINT_SCHEMA_INVALID'
              ? 'V3_LAYER_CONTRACT_INVALID'
              : message === 'MODEL_JSON_INVALID' || error instanceof SyntaxError
                ? 'MODEL_JSON_INVALID'
                : 'BLUEPRINT_SCHEMA_INVALID'
    const retryable = [
      'MODEL_JSON_INVALID',
      'BLUEPRINT_SLIDE_COUNT_MISMATCH',
      'BLUEPRINT_SOURCE_REFERENCE_INVALID',
      'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID',
      'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE',
    ]
      .includes(errorCode)
    return {
      errorCode,
      ...(exhausted ? { terminalCode: 'CONTRACT_REPAIR_EXHAUSTED' as const } : {}),
      retryable,
      attempt,
      maxAttempts,
      suggestedAction: retryable ? 'RETRY' : 'CONTACT_ADMIN',
      diagnosticCode: errorCode,
      fieldPaths,
      correlationId: this.correlationId(input),
      requestId: error instanceof StructuredModelError
        ? error.requestId ?? this.traceRequestId(input)
        : this.traceRequestId(input),
      model: error instanceof StructuredModelError
        ? error.model
        : this.dependencies.model.modelName ?? null,
      contractVersion: CONTRACT_VERSION,
    }
  }

  private correlationId(input: PlanPresentationInput) {
    return `plan-${hashInput({ runId: input.runId, stepId: input.stepId, idempotencyKey: input.idempotencyKey }).slice(0, 28)}`
  }

  private traceRequestId(input: PlanPresentationInput) {
    return `plan-request-${hashInput({ runId: input.runId, idempotencyKey: input.idempotencyKey }).slice(0, 24)}`
  }

  private async recordProviderRetry(input: PlanPresentationInput, failure: PlanningFailure, nextAttempt: number) {
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.progress',
        payload: {
          stepId: input.stepId,
          completed: failure.attempt,
          total: failure.maxAttempts,
          summary: `规划模型暂时不可用，准备自动重试 ${nextAttempt}/${failure.maxAttempts}`,
        },
      })
    })
  }

  private contractIssues(error: unknown) {
    if (error instanceof ZodError) {
      return error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }))
    }
    if (error instanceof Error && (error.message.startsWith('BLUEPRINT_')
      || error.message.startsWith('VISUAL_DECK_V4_')
      || error.message === 'LAYERED_BLUEPRINT_SCHEMA_INVALID')) {
      return [{ path: 'blueprint', message: error.message }]
    }
    if (error instanceof StructuredModelError && error.code === 'MODEL_JSON_INVALID') {
      return [{ path: 'blueprint', message: error.code }]
    }
    return null
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }

  private async prepare(input: PlanPresentationInput, document: DocumentResult): Promise<PlanPresentationResult & { run: RunRecord }> {
    const inputHash = hashInput({
      tool: 'create_blueprint',
      slideCount: input.slideCount,
      visualDirection: input.visualDirection,
      targetAudience: input.targetAudience ?? null,
      presentationGoal: input.presentationGoal ?? null,
      presentationMode: input.presentationMode ?? 'SLIDE_IMAGE_V2',
      coverDesignMode: input.coverDesignMode ?? 'INDEPENDENT',
      assetAcquisitionPolicy: input.assetAcquisitionPolicy ?? 'AI_FIRST',
      maxVisualAssetsPerSlide: input.maxVisualAssetsPerSlide ?? 4,
      sourceIdentity: input.source.kind === 'APPROVED_PAGE_DESIGN' ? {
        kind: input.source.kind,
        artifactVersionId: input.source.artifactVersionId,
        artifactContentHash: input.source.artifactContentHash,
        title: input.source.title,
        subject: input.source.subject,
        gradeBand: input.source.gradeBand,
        lessonDurationMinutes: input.source.lessonDurationMinutes,
        audience: input.source.audience,
        objectives: input.source.objectives,
      } : null,
      document: {
        name: document.name,
        isComplete: document.isComplete,
        missingRanges: document.missingRanges,
        chunks: document.chunks.map((chunk) => ({ id: chunk.id, sha256: chunk.sha256 })),
      },
    })

    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(input.idempotencyKey)
      if (existing) {
        if (existing.id !== input.stepId || existing.inputHash !== inputHash || existing.tool !== 'create_blueprint') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        if (existing.status === 'COMPLETED') {
          const blueprint = presentationBlueprintSchema.parse(existing.output)
          return { run: transaction.run, step: existing, blueprint, replayed: true }
        }
        if (existing.status === 'FAILED') {
          if (transaction.run.presentationMode === 'VISUAL_DECK_V4' && transaction.run.status === 'PLANNING') {
            const now = this.dependencies.clock.now().toISOString()
            transaction.putStep({ ...existing, status: 'RUNNING', errorCode: null, updatedAt: now })
            return { run: transaction.run, step: { ...existing, status: 'RUNNING', errorCode: null, updatedAt: now }, blueprint: null, replayed: false }
          }
          return { run: transaction.run, step: existing, blueprint: null, replayed: true }
        }
        return { run: transaction.run, step: existing, blueprint: null, replayed: false }
      }
      if (transaction.run.status !== 'PLANNING') throw new Error('RUN_NOT_PLANNING')

      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: input.stepId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        inputHash,
        tool: 'create_blueprint',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: now,
        updatedAt: now,
      }
      const updatedRun = { ...transaction.run, updatedAt: now }
      transaction.putRun(updatedRun)
      transaction.putStep(step)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.started',
        payload: {
          stepId: step.id,
          tool: step.tool,
          label: input.source.kind === 'APPROVED_PAGE_DESIGN'
            ? '读取已审核逐页设计稿'
            : '分析教材并规划逐页蓝图',
        },
      })
      appendV4LifecycleEvent(transaction, 'planning.started', {
        completed: 0,
        total: transaction.run.presentationMode === 'VISUAL_DECK_V4' ? 4 : 1,
        pageNumbers: allPageNumbers(transaction.run),
      })
      return { run: updatedRun, step, blueprint: null, replayed: false }
    })
  }

  private assertBlueprintCoverage(
    draft: ReturnType<typeof blueprintDraftSchema.parse>,
    document: DocumentResult,
    slideCount: number,
    presentationMode: CreateRunRequest['presentationMode'],
    maxVisualAssetsPerSlide: number,
  ) {
    if (draft.slides.length !== slideCount) throw new Error('BLUEPRINT_SLIDE_COUNT_MISMATCH')
    const available = new Set(document.chunks.map((chunk) => chunk.id))
    const cited = new Set([...draft.curriculum.sourceChunkIds, ...draft.slides.flatMap((slide) => slide.sourceChunkIds)])
    if ([...cited].some((id) => !available.has(id))) throw new Error('BLUEPRINT_SOURCE_REFERENCE_INVALID')
    if (document.chunks.some((chunk) => !draft.curriculum.sourceChunkIds.includes(chunk.id))) {
      throw new Error('BLUEPRINT_SOURCE_REFERENCE_INVALID')
    }
    const availableAssets = new Set((document.assets ?? []).map((asset) => asset.id))
    const curriculumAssets = draft.curriculum.sourceAssetIds ?? []
    const mappedAssets = new Set([
      ...draft.slides.flatMap((slide) => slide.sourceAssetIds ?? []),
      ...draft.slides.flatMap((slide) => slide.layeredDesign?.elements.flatMap((element) =>
        element.kind === 'IMAGE' || element.kind === 'TEXT' ? element.sourceAssetIds ?? [] : []) ?? []),
    ])
    const citedAssets = new Set([...curriculumAssets, ...mappedAssets])
    if ([...citedAssets].some((id) => !availableAssets.has(id))) throw new Error('BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID')
    if ([...availableAssets].some((id) => !curriculumAssets.includes(id) || !mappedAssets.has(id))) {
      throw new Error('BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE')
    }
    const strategy = getPresentationModeStrategy(presentationMode)
    if (strategy.assetModel === 'LAYERED_ELEMENTS' && draft.slides.some((slide) => !slide.layeredDesign)) {
      throw new Error('LAYERED_BLUEPRINT_SCHEMA_INVALID')
    }
    if (strategy.assetModel === 'LAYERED_ELEMENTS' && draft.slides.some((slide) =>
      slide.layeredDesign!.elements.filter((element) =>
        element.kind === 'IMAGE' && element.role !== 'BASE_LAYER').length > maxVisualAssetsPerSlide)) {
      throw new Error('BLUEPRINT_VISUAL_ASSET_LIMIT_EXCEEDED')
    }
  }

  private async complete(input: PlanPresentationInput, blueprint: PresentationBlueprint) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') return step
      const now = this.dependencies.clock.now().toISOString()
      const approvedPageDesign = input.source.kind === 'APPROVED_PAGE_DESIGN'
      const targetStatus = approvedPageDesign ? 'EXECUTING' as const : 'AWAITING_BLUEPRINT_APPROVAL' as const
      const policy = transitionRun(transaction.run, targetStatus)
      const run: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updated: StepRecord = { ...step, status: 'COMPLETED', output: blueprint, errorCode: null, updatedAt: now }
      transaction.putRun(run)
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: {
          stepId: step.id,
          summary: approvedPageDesign
            ? `已载入教师审核的 ${blueprint.slides.length} 页设计稿，开始逐页生成`
            : getPresentationModeStrategy(input.presentationMode ?? 'SLIDE_IMAGE_V2').planningKind === 'BLUEPRINT_WITH_REFLECTION'
            ? `已反思并修订 ${blueprint.slides.length} 页教学蓝图`
            : `已生成 ${blueprint.slides.length} 页教学蓝图`,
        },
      })
      appendV4LifecycleEvent(transaction, 'planning.completed', {
        completed: blueprint.visualDeckV4Proposal ? 4 : 1,
        total: blueprint.visualDeckV4Proposal ? 4 : 1,
        pageNumbers: allPageNumbers(transaction.run),
        reason: approvedPageDesign ? null : 'USER_CONFIRMATION_REQUIRED',
        requiresUserAction: !approvedPageDesign,
        nextAction: approvedPageDesign ? null : 'APPROVE_BLUEPRINT',
      })
      const attempt = input.attempt ?? 0
      if (attempt > 0) {
        const previous = transaction.getStep(planningStepKey(input.runId, attempt - 1))
        if (previous?.status === 'FAILED') {
          transaction.appendEvent({
            schemaVersion: CONTRACT_VERSION,
            type: 'issue.resolved',
            payload: { issueId: `${previous.id}:planning-failed`, resolution: 'FIXED' },
          })
        }
      }
      if (blueprint.visualDeckV4Proposal) {
        const issueId = `${step.id}:planning-failed`
        const issueOpen = transaction.listEvents().reduce((open, event) => {
          if (event.type === 'issue.detected' && event.payload.id === issueId) return true
          if (event.type === 'issue.resolved' && event.payload.issueId === issueId) return false
          return open
        }, false)
        if (issueOpen) {
          transaction.appendEvent({
            schemaVersion: CONTRACT_VERSION,
            type: 'issue.resolved',
            payload: { issueId, resolution: 'FIXED' },
          })
        }
      }
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PLANNING', to: targetStatus },
      })
      transaction.appendEvent(approvedPageDesign
        ? {
            schemaVersion: CONTRACT_VERSION,
            type: 'approval.resolved',
            payload: { kind: 'BLUEPRINT', actionType: 'APPROVED_PAGE_DESIGN' },
          }
        : {
            schemaVersion: CONTRACT_VERSION,
            type: 'approval.required',
            payload: { kind: 'BLUEPRINT', summary: `请确认《${blueprint.title}》的 ${blueprint.slides.length} 页蓝图` },
          })
      if (approvedPageDesign) {
        appendV4LifecycleEvent(transaction, 'generation.started', {
          completed: 0,
          total: transaction.run.slideCount,
          pageNumbers: allPageNumbers(transaction.run),
        })
      }
      return updated
    })
  }

  private async fail(
    input: PlanPresentationInput,
    failure: PlanningFailure,
    issueCategory: 'SOURCE_INCOMPLETE' | 'PLANNING_FAILED',
    document: DocumentResult,
  ) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'FAILED') return step
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      const run: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updated: StepRecord = { ...step, status: 'FAILED', errorCode: failure.errorCode, updatedAt: now }
      transaction.putRun(run)
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode: failure.errorCode, retryable: failure.retryable },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: `${step.id}:planning-failed`,
          category: issueCategory,
          severity: 'CRITICAL',
          summary: issueCategory === 'SOURCE_INCOMPLETE'
            ? `教材内容不完整：${document.missingRanges.join('；') || '没有可用内容'}`
            : this.failureSummary(failure),
          slideIds: [],
          sourceChunkIds: document.chunks.map((chunk) => chunk.id),
          status: 'OPEN',
          planningFailure: failure,
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PLANNING', to: 'NEEDS_HUMAN', reason: failure.errorCode },
      })
      appendV4LifecycleEvent(transaction, 'planning.completed', {
        completed: 0,
        total: 1,
        reason: ['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE'].includes(failure.errorCode)
          ? 'PROVIDER_TEMPORARILY_UNAVAILABLE'
          : 'PLANNING_FAILED',
        retryable: failure.retryable,
        requiresUserAction: true,
        nextAction: failure.retryable ? 'RETRY' : 'REVIEW_RESULT',
      })
      return updated
    })
  }

  private failureSummary(failure: PlanningFailure) {
    if (failure.suggestedAction === 'RETRY') {
      return `规划暂时失败（${failure.errorCode}），系统已尝试 ${failure.attempt}/${failure.maxAttempts} 次，可以按原参数重试。`
    }
    if (failure.suggestedAction === 'MODIFY_SOURCE') {
      return '教材内容不完整，请补充或替换教材后重新规划。'
    }
    return `蓝图合同校验失败（${failure.errorCode}），系统已尝试修复 ${failure.attempt}/${failure.maxAttempts} 次，请联系管理员检查模型或合同版本。`
  }
}

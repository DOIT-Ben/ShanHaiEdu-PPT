import type { CreateRunRequest, PlanningFailure } from '../contracts'
import { CONTRACT_VERSION } from '../contracts'
import { z, ZodError } from 'zod'
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
  StructuredModelExecutionMetrics,
  StructuredGenerationRequestContract,
  StructuredGenerationRequestContractPort,
  StructuredModelMetricsPort,
  StructuredModelPort,
} from './ports'
import { transitionRun } from './policy'
import { getPresentationModeStrategy } from './presentation-mode-strategy'
import { beginTechnicalRecovery, isTechnicalFailureCode, technicalFailureDisposition } from './technical-recovery'
import {
  createVisualDeckV4BlueprintFromProposal,
  normalizeVisualDeckV4SourceSpecRequestBinding,
  V4_ALL_PLANNING_STAGES,
  V4_PLANNING_STAGES,
  type VisualDeckV4CompilerInput,
  type VisualDeckV4PlanningStage,
  visualDeckV4PlanningStagesForCompiler,
  visualDeckV4PlanningStageStepKey,
} from './visual-deck-v4-planner'
import {
  createVisualDeckV4DeckVisualReflectionInput,
  createVisualDeckV4SlideBriefsReflectionInput,
  resolveVisualDeckV4DeckVisualReflection,
  resolveVisualDeckV4SlideBriefsReflection,
} from './visual-deck-v4-reflection'
import {
  normalizeVisualDeckV4RequestFocus,
  normalizeVisualDeckV4VisibleReferences,
  VISUAL_DECK_V4_REFLECTION_RUBRIC_VERSION,
  visualDeckV4DeckVisualReflectionStageOutputSchema,
  visualDeckV4DeckVisualStageSchema,
  visualDeckV4CreativeManuscriptSchema,
  visualDeckV4FinalCoherenceReviewSchema,
  isV4ManuscriptContextTooLargeError,
  visualDeckV4ProposalDraftSchema,
  visualDeckV4ReviewManuscriptSchema,
  visualDeckV4SlideBriefsReflectionStageOutputSchema,
  visualDeckV4SlideBriefsStageSchema,
  visualDeckV4SourceSpecStageSchema,
  V4_MANUSCRIPT_CONTEXT_TOO_LARGE,
} from '../visual-deck-v4-contracts'
import type { StructuredGenerationPreflightPort, StructuredGenerationProtocol } from './ports'
import { allPageNumbers, appendV4LifecycleEvent } from './v4-lifecycle'
import {
  CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION,
  CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION,
  isSupportedVisualDeckV4CompilerVersion,
  LEGACY_VISUAL_DECK_V4_COMPILER_VERSION,
  VISUAL_DECK_V4_COMPILER_VERSION,
} from '../release-identity'
import { V4ReflectionCoordinator } from './v4-reflection/coordinator'
import { ManuscriptCompiler, V4ManuscriptCompilationError } from './v4-manuscript-compiler'
import {
  V4EvidenceWindowCompiler,
  v4EvidenceWindowStepKey,
  type V4EvidenceWindow,
} from './v4-evidence-window-compiler'
import { v4ModelOverride, v4StructuredGenerationProtocolOverride } from './v4-model-policy'

const MAX_BLUEPRINT_CONTRACT_ATTEMPTS = 5
const MAX_PROVIDER_ATTEMPTS = 5
const MAX_V4_SLIDE_BRIEF_CONTRACT_ATTEMPTS = 2
const PROVIDER_RETRY_DELAYS_MS = [5_000, 30_000, 60_000, 120_000] as const
const V4_REFLECTION_DIAGNOSTIC_PATHS: Readonly<Record<string, readonly string[]>> = {
  V4_REFLECTION_APPLIED_FINDING_NO_CHANGE: ['findings', 'revisedSlides'],
  V4_REFLECTION_BASE_HASH_MISMATCH: ['baseArtifactHash'],
  V4_REFLECTION_CHANGE_OUT_OF_SCOPE: ['findings.fieldPaths', 'revisedSlides'],
  V4_REFLECTION_CONTEXT_HASH_MISMATCH: ['reviewContextHash'],
  V4_REFLECTION_FINDING_PAGE_OUT_OF_RANGE: ['findings.pageNumbers'],
  V4_REFLECTION_FINDING_PAGE_SCOPE_MISMATCH: ['findings.pageNumbers'],
  V4_REFLECTION_FROZEN_FIELD_MUTATION: ['revisedArtifact'],
  V4_REFLECTION_GOVERNANCE_CONTEXT_REQUIRED: ['governanceContext'],
  V4_REFLECTION_PERSISTED_ARTIFACT_MISMATCH: ['artifact'],
  V4_REFLECTION_UNCHANGED_ARTIFACT_MUTATED: ['revisedArtifact'],
  V4_REFLECTION_UNREPORTED_PAGE_MUTATION: ['revisedSlides.pageNumber'],
}

const v4PlanningStageAttemptSchema = z.object({
  attempt: z.number().int().min(1).max(MAX_PROVIDER_ATTEMPTS),
  outcome: z.enum(['STARTED', 'SUCCEEDED', 'FAILED']),
  requestKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
  durationMs: z.number().int().nonnegative(),
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/).nullable(),
  errorCode: z.string().regex(/^[A-Z0-9_]{1,160}$/).nullable(),
  status: z.number().int().min(100).max(599).nullable(),
  responseAccepted: z.boolean(),
  sseEventCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().datetime().nullable(),
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  outputTokens: z.number().int().nonnegative().nullable().default(null),
  totalTokens: z.number().int().nonnegative().nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.outcome === 'STARTED' && (value.durationMs !== 0 || value.requestId !== null
    || value.errorCode !== null || value.status !== null || value.responseAccepted
    || value.sseEventCount !== 0 || value.lastActivityAt !== null
    || value.inputTokens !== null || value.outputTokens !== null || value.totalTokens !== null)) {
    context.addIssue({ code: 'custom', message: 'started planning attempt cannot contain response evidence' })
  }
  if (value.outcome === 'SUCCEEDED' && value.errorCode !== null) {
    context.addIssue({ code: 'custom', path: ['errorCode'], message: 'successful planning attempt cannot contain an error' })
  }
  if (value.outcome === 'FAILED' && value.errorCode === null) {
    context.addIssue({ code: 'custom', path: ['errorCode'], message: 'failed planning attempt requires an error' })
  }
})

const v4PlanningStageAuditSchema = z.object({
  schemaVersion: z.literal('1'),
  stage: z.enum(V4_ALL_PLANNING_STAGES),
  stageKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
  totalDurationMs: z.number().int().nonnegative(),
  attempts: z.array(v4PlanningStageAttemptSchema).max(MAX_PROVIDER_ATTEMPTS),
}).strict()

type V4PlanningStageAttempt = z.infer<typeof v4PlanningStageAttemptSchema>

const V4_PLANNING_REQUEST_EVIDENCE_TOOL = 'audit_v4_planning_request'
const V4_PLANNING_REQUEST_REPLAY_MISMATCH = 'V4_PLANNING_REQUEST_REPLAY_MISMATCH'
const V4_MANUSCRIPT_SEMANTIC_INVALID = 'V4_MANUSCRIPT_SEMANTIC_INVALID'

const structuredGenerationRequestContractSchema = z.object({
  protocol: z.literal('RESPONSES_JSON_SCHEMA'),
  transport: z.literal('RESPONSES'),
  responseFormat: z.literal('JSON_SCHEMA'),
  stream: z.literal(true),
  promptContractHash: z.string().regex(/^[a-f0-9]{64}$/),
  responseSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

const v4PlanningRequestEvidenceSchema = z.object({
  schemaVersion: z.literal('1'),
  requestKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
  stage: z.enum(['creative-manuscript', 'review-manuscript']),
  tool: z.enum(['compile_v4_creative_manuscript', 'review_v4_manuscript']),
  operation: z.enum(['create_visual_deck_v4_creative_manuscript', 'review_visual_deck_v4_manuscript']),
  schemaName: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  compilerVersion: z.literal(VISUAL_DECK_V4_COMPILER_VERSION),
  model: z.string().trim().min(1).max(120),
  protocol: z.literal('RESPONSES_JSON_SCHEMA'),
  transport: z.literal('RESPONSES'),
  responseFormat: z.literal('JSON_SCHEMA'),
  stream: z.literal(true),
  promptContractHash: z.string().regex(/^[a-f0-9]{64}$/),
  responseSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  payloadCharacterCount: z.number().int().nonnegative().max(240_000),
  evidenceWindow: z.object({
    version: z.string().min(1).max(80),
    selectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    chunks: z.array(z.object({
      id: z.string().min(1).max(160),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      includedCharacterCount: z.number().int().positive().max(12_000),
    }).strict()).min(1).max(200),
    omittedChunkCount: z.number().int().nonnegative(),
    characterCount: z.number().int().nonnegative(),
    serializedByteCount: z.number().int().nonnegative(),
  }).strict(),
  sourceAssetInputs: z.array(z.object({
    id: z.string().min(1).max(160),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    byteLength: z.number().int().positive(),
  }).strict()),
}).strict()

type V4PlanningRequestEvidence = z.infer<typeof v4PlanningRequestEvidenceSchema>

type V4ManuscriptStageRequest = Readonly<{
  stage: Extract<VisualDeckV4PlanningStage, 'creative-manuscript' | 'review-manuscript'>
  tool: string
  operation: string
  schemaName: string
  payload: Record<string, unknown>
  evidenceWindow: V4EvidenceWindow
  sourceAssets?: Parameters<StructuredModelPort['execute']>[0]['sourceAssets']
  protocol: StructuredGenerationProtocol
  compilerVersion: string
  repairAttempt?: number
  parse: (value: unknown) => unknown
}>

function v4PlanningRequestEvidenceKey(requestKey: string) {
  return `${requestKey}:request-evidence`
}

function isV4ManuscriptStage(
  stage: VisualDeckV4PlanningStage,
): stage is V4ManuscriptStageRequest['stage'] {
  return stage === 'creative-manuscript' || stage === 'review-manuscript'
}

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
    '不得绘制任何文字、字母、数字、公式、标志、水印或徽标。',
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
    let compilerVersion: string | null = null
    let compilerIdentityError: unknown = null
    if (strategy.planningKind === 'VISUAL_DECK_COMPILER') {
      try {
        compilerVersion = await this.v4CompilerVersion(run)
      } catch (error) {
        compilerIdentityError = error
      }
    }
    let document: DocumentResult
    try {
      document = await this.dependencies.documents.resolve({ host: run.host, source: effectiveInput.source })
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : 'SOURCE_RESOLUTION_FAILED'
      if (presentationMode === 'VISUAL_DECK_V4' && isTechnicalFailureCode(errorCode)) {
        const step = await this.failTechnicalSourceResolution(effectiveInput, errorCode, compilerVersion)
        return { step, blueprint: null, replayed: false }
      }
      throw error
    }
    await this.completeTechnicalSourceResolution(effectiveInput, document)
    const planningStageCount = compilerVersion
      ? visualDeckV4PlanningStagesForCompiler(compilerVersion).length
      : strategy.planningKind === 'VISUAL_DECK_COMPILER'
        ? visualDeckV4PlanningStagesForCompiler(LEGACY_VISUAL_DECK_V4_COMPILER_VERSION).length
        : 1
    const prepared = await this.prepare(effectiveInput, document, planningStageCount)
    if (prepared.replayed) return prepared

    if (!document.isComplete || document.chunks.length === 0) {
      const step = await this.fail(
        effectiveInput,
        this.sourceFailure(effectiveInput),
        'SOURCE_INCOMPLETE',
        document,
        compilerVersion,
      )
      return { step, blueprint: null, replayed: false }
    }

    try {
      if (compilerIdentityError) throw compilerIdentityError
      const blueprint = strategy.planningKind === 'VISUAL_DECK_COMPILER'
        ? await this.createVisualDeckV4Blueprint(
            effectiveInput,
            document,
            prepared.step.inputHash,
            run.host.tenantId,
            visualDeckV4!,
            compilerVersion!,
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
      const step = await this.fail(effectiveInput, failure, 'PLANNING_FAILED', document, compilerVersion)
      return { step, blueprint: null, replayed: false }
    }
  }

  private async createVisualDeckV4Blueprint(
    input: PlanPresentationInput,
    document: DocumentResult,
    inputHash: string,
    tenantId: string,
    config: NonNullable<CreateRunRequest['visualDeckV4']>,
    compilerVersion: string,
  ) {
    const run = await this.requireRun(input.runId)
    const modelOverride = v4ModelOverride(run, 'TEXT', compilerVersion)
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
      compilerVersion,
      createdAt: this.dependencies.clock.now().toISOString(),
    }
    const protocol = await this.resolveV4StructuredGenerationProtocol(input, tenantId, compilerVersion)
    if (compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION) {
      if (protocol !== 'RESPONSES_JSON_SCHEMA') throw new Error('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
      return this.createVisualDeckV4Chain4Blueprint({
        input,
        document,
        compilerInput,
        basePayload,
        protocol,
        compilerVersion,
      })
    }
    const sourceSpec = visualDeckV4SourceSpecStageSchema.parse(await this.runV4PlanningStage(input, {
        stage: 'source-spec',
        tool: 'compile_v4_source_spec',
        operation: 'create_visual_deck_v4_source_spec',
        schemaName: 'ppt_agent_v4_source_spec_v1',
        payload: basePayload,
        sourceAssets: document.assets ?? [],
        protocol,
        compilerVersion,
        parse: (value) => normalizeVisualDeckV4RequestFocus(
          normalizeVisualDeckV4SourceSpecRequestBinding(
            compilerInput,
            visualDeckV4SourceSpecStageSchema.parse(value),
          ),
          config.deckOptions.focus,
        ),
      }))
    const deckVisualDraft = visualDeckV4DeckVisualStageSchema.parse(await this.runV4PlanningStage(input, {
      stage: 'deck-visual',
      tool: 'compile_v4_deck_visual',
      operation: 'create_visual_deck_v4_deck_visual',
      schemaName: 'ppt_agent_v4_deck_visual_v1',
      payload: { ...basePayload, ...sourceSpec },
      protocol,
      compilerVersion,
      parse: visualDeckV4DeckVisualStageSchema.parse,
    }))
    const reflectionContext = {
      config,
      sourceSpec,
      document,
      visualDirection: input.visualDirection,
      ...(input.targetAudience ? { targetAudience: input.targetAudience } : {}),
      ...(input.presentationGoal ? { presentationGoal: input.presentationGoal } : {}),
    }
    const reflectionCoordinator = new V4ReflectionCoordinator({
      repository: this.dependencies.repository,
      model: this.dependencies.model,
      clock: this.dependencies.clock,
    })
    const reflectionCommon = {
      runId: input.runId,
      tenantId,
      planningAttempt: input.attempt ?? 0,
      compilerVersion,
      protocol,
      ...(modelOverride ? { modelOverride } : {}),
      sourceSummary: document.chunks.map((chunk) => chunk.text).join('\n').slice(0, 16_000),
    }
    let deckVisual
    if (compilerVersion === CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION) {
      const enhanced = await reflectionCoordinator.enhanceDeck({
        ...reflectionCommon,
        presentationSpec: sourceSpec.presentationSpec,
        candidate: deckVisualDraft,
      })
      deckVisual = enhanced.artifact
      await this.recordV4ReflectionProgress(input, 'reflect-deck-visual', enhanced.disposition.status)
    } else if (compilerVersion === CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION) {
      deckVisual = await this.legacyDeckReflection(input, protocol, reflectionContext, deckVisualDraft, sourceSpec)
    } else {
      deckVisual = deckVisualDraft
    }
    const createSlideBriefs = async (
      repairAttempt: number,
      contractRepairIssues: readonly { path: string; message: string }[] = [],
    ) => normalizeVisualDeckV4VisibleReferences(
      visualDeckV4SlideBriefsStageSchema.parse(await this.runV4PlanningStage(input, {
        stage: 'slide-briefs',
        tool: 'compile_v4_slide_briefs',
        operation: 'create_visual_deck_v4_slide_briefs',
        schemaName: 'ppt_agent_v4_slide_briefs_v1',
        payload: {
          ...basePayload,
          ...sourceSpec,
          ...deckVisual,
          ...(contractRepairIssues.length > 0 ? { contractRepairIssues } : {}),
        },
        protocol,
        compilerVersion,
        repairAttempt,
        parse: visualDeckV4SlideBriefsStageSchema.parse,
      })),
    )
    let slideBriefs = await createSlideBriefs(0)
    let candidateValidated = false
    for (let repairAttempt = 0; repairAttempt < MAX_V4_SLIDE_BRIEF_CONTRACT_ATTEMPTS; repairAttempt += 1) {
      try {
        visualDeckV4ProposalDraftSchema.parse({ ...sourceSpec, ...deckVisual, ...slideBriefs })
        candidateValidated = true
        break
      } catch (error) {
        const repairIssues = this.v4SlideBriefContractIssues(error)
        if (!repairIssues || repairAttempt === MAX_V4_SLIDE_BRIEF_CONTRACT_ATTEMPTS - 1) {
          throw new PlanningFailureError(this.contractFailure(
            input, error, repairAttempt + 1, MAX_V4_SLIDE_BRIEF_CONTRACT_ATTEMPTS, true,
          ))
        }
        slideBriefs = await createSlideBriefs(repairAttempt + 1, repairIssues)
      }
    }
    if (!candidateValidated) throw new Error('V4_SLIDE_BRIEF_CONTRACT_REPAIR_EXHAUSTED')
    let reflectedSlides
    if (compilerVersion === CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION) {
      const enhanced = await reflectionCoordinator.enhanceSlides({
        ...reflectionCommon,
        sourceSpec,
        deckVisual,
        candidate: slideBriefs,
      })
      reflectedSlides = enhanced.artifact
      await this.recordV4ReflectionProgress(input, 'reflect-slide-briefs', enhanced.disposition.status)
    } else if (compilerVersion === CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION) {
      reflectedSlides = await this.legacySlideReflection(
        input, protocol, reflectionContext, deckVisual, slideBriefs, sourceSpec,
      )
    } else {
      reflectedSlides = slideBriefs
    }
    const proposalDraft = visualDeckV4ProposalDraftSchema.parse({
      ...sourceSpec,
      ...deckVisual,
      ...reflectedSlides,
    })
    if (compilerVersion === LEGACY_VISUAL_DECK_V4_COMPILER_VERSION) {
      await this.runV4PlanningStage(input, {
        stage: 'final-coherence',
        tool: 'review_v4_final_coherence',
        operation: 'review_visual_deck_v4_coherence',
        schemaName: 'ppt_agent_v4_final_coherence_v1',
        payload: proposalDraft,
        protocol,
        compilerVersion,
        parse: visualDeckV4FinalCoherenceReviewSchema.parse,
      })
    }
    return createVisualDeckV4BlueprintFromProposal(compilerInput, proposalDraft)
  }

  private async createVisualDeckV4Chain4Blueprint(input: Readonly<{
    input: PlanPresentationInput
    document: DocumentResult
    compilerInput: VisualDeckV4CompilerInput
    basePayload: Record<string, unknown>
    protocol: StructuredGenerationProtocol
    compilerVersion: string
  }>) {
    const evidenceWindow = new V4EvidenceWindowCompiler().compile({
      document: input.document,
      instruction: input.compilerInput.config.instruction,
      ...(input.compilerInput.config.deckOptions.focus
        ? { focus: input.compilerInput.config.deckOptions.focus }
        : {}),
      ...(input.compilerInput.presentationGoal ? { goal: input.compilerInput.presentationGoal } : {}),
    })
    await this.persistV4EvidenceWindow(input.input, evidenceWindow.audit)
    const sourceMode = input.compilerInput.config.sourceMode === 'AUTO'
      ? 'SOURCE_GROUNDED' as const
      : input.compilerInput.config.sourceMode
    const { document: _duplicateDocument, ...chain4BasePayload } = input.basePayload
    const manuscriptContext: Record<string, unknown> = {
      ...chain4BasePayload,
      originalRequest: {
        instruction: input.compilerInput.config.instruction,
        targetAudience: input.compilerInput.targetAudience ?? null,
        presentationGoal: input.compilerInput.presentationGoal ?? null,
        visualDirection: input.compilerInput.visualDirection,
      },
      frozenConstraints: {
        presentationMode: 'VISUAL_DECK_V4',
        sourceMode,
        slideCount: input.compilerInput.slideCount,
        deckType: input.compilerInput.config.deckOptions.deckType,
        language: input.compilerInput.config.deckOptions.language,
        aspectRatio: input.compilerInput.config.deckOptions.aspectRatio,
        audience: input.compilerInput.config.deckOptions.audience
          ?? input.compilerInput.targetAudience
          ?? '需要理解本主题的学习者',
        goal: input.compilerInput.presentationGoal ?? input.compilerInput.config.instruction,
      },
      trustedEvidence: {
        sources: (input.document.sources ?? []).map((source) => ({
          name: source.name,
          kind: source.kind,
          status: source.status,
        })),
        sourceChunks: evidenceWindow.chunks.map((chunk) => ({
          id: chunk.id,
          sourceId: chunk.sourceId ?? null,
          text: chunk.text,
          pageStart: chunk.pageStart ?? null,
          pageEnd: chunk.pageEnd ?? null,
        })),
        missingRanges: input.document.missingRanges,
      },
    }
    const creative = visualDeckV4CreativeManuscriptSchema.parse(await this.runV4ManuscriptStage(input.input, {
      stage: 'creative-manuscript',
      tool: 'compile_v4_creative_manuscript',
      operation: 'create_visual_deck_v4_creative_manuscript',
      schemaName: 'ppt_agent_v4_creative_manuscript_v1',
      payload: manuscriptContext,
      evidenceWindow,
      sourceAssets: input.document.assets ?? [],
      protocol: input.protocol,
      compilerVersion: input.compilerVersion,
      parse: visualDeckV4CreativeManuscriptSchema.parse,
    }))
    const reviewRequest: V4ManuscriptStageRequest = {
      stage: 'review-manuscript',
      tool: 'review_v4_manuscript',
      operation: 'review_visual_deck_v4_manuscript',
      schemaName: 'ppt_agent_v4_review_manuscript_v1',
      payload: this.boundedV4ReviewPayload(manuscriptContext, creative),
      evidenceWindow,
      sourceAssets: input.document.assets ?? [],
      protocol: input.protocol,
      compilerVersion: input.compilerVersion,
      parse: visualDeckV4ReviewManuscriptSchema.parse,
    }
    let review = visualDeckV4ReviewManuscriptSchema.parse(await this.runV4ManuscriptStage(input.input, reviewRequest))
    const compilerInput = {
      ...input.compilerInput,
      document: { ...input.compilerInput.document, chunks: evidenceWindow.chunks },
    }
    const compiler = new ManuscriptCompiler()
    let draft
    try {
      draft = compiler.compilePlan(compilerInput, creative, review)
    } catch (error) {
      if (!(error instanceof V4ManuscriptCompilationError)
        || error.code !== 'V4_MANUSCRIPT_SOURCE_EVIDENCE_AMBIGUOUS') throw error
      const repairKey = visualDeckV4PlanningStageStepKey(
        input.input.runId, 'review-manuscript', input.input.attempt ?? 0, 1,
      )
      const repairUsed = await this.dependencies.repository.transact(
        input.input.runId,
        (transaction) => Boolean(transaction.getStep(repairKey)),
      )
      if (repairUsed) throw error
      review = visualDeckV4ReviewManuscriptSchema.parse(await this.runV4PlanningStage(input.input, {
        ...reviewRequest,
        repairAttempt: 1,
        payload: {
          ...reviewRequest.payload,
          contentSlotCompletion: true,
          sourceEvidenceDisambiguation: '每条来源摘录必须足够长，并且只能在一个受信 chunk 中出现。',
        },
      }))
      draft = compiler.compilePlan(compilerInput, creative, review)
    }
    return createVisualDeckV4BlueprintFromProposal(compilerInput, draft)
  }

  private boundedV4ReviewPayload(
    manuscriptContext: Record<string, unknown>,
    creativeManuscript: unknown,
  ): Record<string, unknown> {
    const maximumManuscriptCharacters = 80_000
    const maximumPayloadCharacters = 220_000
    let projected = structuredClone(creativeManuscript)
    const serializedCharacters = (value: unknown) => JSON.stringify(value).length
    const truncateStrings = (value: unknown, maximum: number): unknown => {
      if (typeof value === 'string') return value.slice(0, maximum)
      if (Array.isArray(value)) return value.map((item) => truncateStrings(item, maximum))
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateStrings(item, maximum)]))
      }
      return value
    }
    for (const maximum of [1_500, 1_000, 500, 250, 120, 60]) {
      if (serializedCharacters(projected) <= maximumManuscriptCharacters) break
      projected = truncateStrings(projected, maximum)
    }
    if (serializedCharacters(projected) > maximumManuscriptCharacters) {
      throw new Error('V4_MANUSCRIPT_CONTEXT_TOO_LARGE')
    }
    const payload = { ...manuscriptContext, creativeManuscript: projected }
    if (serializedCharacters(payload) > maximumPayloadCharacters) throw new Error('V4_MODEL_PAYLOAD_TOO_LARGE')
    return payload
  }

  private async persistV4EvidenceWindow(
    input: PlanPresentationInput,
    audit: V4EvidenceWindow['audit'],
  ) {
    const idempotencyKey = v4EvidenceWindowStepKey(input.runId)
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(idempotencyKey)
      if (existing) {
        if (hashInput(existing.output) !== hashInput(audit)) throw new Error('V4_EVIDENCE_WINDOW_REPLAY_MISMATCH')
        return
      }
      const now = this.dependencies.clock.now().toISOString()
      transaction.putStep({
        id: `step-${hashInput({ idempotencyKey }).slice(0, 28)}`,
        runId: input.runId,
        idempotencyKey,
        inputHash: hashInput({
          instruction: input.visualDeckV4?.instruction,
          focus: input.visualDeckV4?.deckOptions.focus,
          presentationGoal: input.presentationGoal,
        }),
        tool: 'compile_v4_evidence_window',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: audit,
        createdAt: now,
        updatedAt: now,
      })
    })
  }

  private async legacyDeckReflection(
    input: PlanPresentationInput,
    protocol: StructuredGenerationProtocol | undefined,
    reflectionContext: Parameters<typeof createVisualDeckV4DeckVisualReflectionInput>[0],
    deckVisualDraft: Parameters<typeof createVisualDeckV4DeckVisualReflectionInput>[1],
    sourceSpec: ReturnType<typeof visualDeckV4SourceSpecStageSchema.parse>,
  ) {
    const deckReflectionInput = createVisualDeckV4DeckVisualReflectionInput(reflectionContext, deckVisualDraft)
    return resolveVisualDeckV4DeckVisualReflection(
      deckVisualDraft,
      await this.runV4PlanningStage(input, {
        stage: 'reflect-deck-visual', tool: 'reflect_v4_deck_visual',
        operation: 'reflect_and_revise_deck_visual', schemaName: 'ppt_agent_v4_deck_visual_reflection_v1',
        payload: deckReflectionInput, protocol,
        compilerVersion: CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION,
        parse: (value) => {
          const resolved = resolveVisualDeckV4DeckVisualReflection(
            deckVisualDraft, value, deckReflectionInput.reviewContextHash,
          )
          if (resolved.artifact.deckPlan.slideCount !== sourceSpec.presentationSpec.slideCount) {
            throw new Error('VISUAL_DECK_V4_REQUEST_MISMATCH')
          }
          return resolved
        },
      }),
      deckReflectionInput.reviewContextHash,
    ).artifact
  }

  private async legacySlideReflection(
    input: PlanPresentationInput,
    protocol: StructuredGenerationProtocol | undefined,
    reflectionContext: Parameters<typeof createVisualDeckV4SlideBriefsReflectionInput>[0],
    deckVisual: Parameters<typeof createVisualDeckV4SlideBriefsReflectionInput>[0]['deckVisual'] & {},
    slideBriefs: Parameters<typeof createVisualDeckV4SlideBriefsReflectionInput>[1],
    sourceSpec: ReturnType<typeof visualDeckV4SourceSpecStageSchema.parse>,
  ) {
    const slideReflectionInput = createVisualDeckV4SlideBriefsReflectionInput(
      { ...reflectionContext, deckVisual }, slideBriefs,
    )
    return resolveVisualDeckV4SlideBriefsReflection(
      slideBriefs,
      await this.runV4PlanningStage(input, {
        stage: 'reflect-slide-briefs', tool: 'reflect_v4_slide_briefs',
        operation: 'reflect_and_revise_slide_briefs', schemaName: 'ppt_agent_v4_slide_briefs_reflection_v1',
        payload: slideReflectionInput, protocol,
        compilerVersion: CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION,
        parse: (value) => {
          const resolved = resolveVisualDeckV4SlideBriefsReflection(
            slideBriefs, value, slideReflectionInput.reviewContextHash,
          )
          visualDeckV4ProposalDraftSchema.parse({ ...sourceSpec, ...deckVisual, ...resolved.artifact })
          return resolved
        },
      }),
      slideReflectionInput.reviewContextHash,
    ).artifact
  }

  private async v4CompilerVersion(run: RunRecord) {
    const evidence = new Set<string>()
    const addEvidence = (version: string) => {
      if (!isSupportedVisualDeckV4CompilerVersion(version)) {
        throw new Error('VISUAL_DECK_V4_COMPILER_UNSUPPORTED')
      }
      evidence.add(version)
    }

    if (run.release?.compilerVersion) addEvidence(run.release.compilerVersion)
    for (const step of await this.dependencies.repository.listSteps(run.id)) {
      const output = step.output && typeof step.output === 'object'
        ? step.output as { visualDeckV4Proposal?: { compilerVersion?: unknown } }
        : null
      const proposalVersion = output?.visualDeckV4Proposal?.compilerVersion
      if (typeof proposalVersion === 'string') addEvidence(proposalVersion)

      if (step.tool === 'review_v4_final_coherence'
        || step.idempotencyKey.includes(':v4:final-coherence:planning:')) {
        addEvidence(LEGACY_VISUAL_DECK_V4_COMPILER_VERSION)
      }
      if ((step.tool === 'reflect_v4_deck_visual' || step.tool === 'reflect_v4_slide_briefs'
        || step.idempotencyKey.includes(':v4:reflect:deck-visual:')
        || step.idempotencyKey.includes(':v4:reflect:slide-briefs:'))
        && !step.idempotencyKey.includes(':v4:chain-3:')) {
        addEvidence(CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION)
      }
      if (step.idempotencyKey.includes(':v4:chain-3:')) {
        addEvidence(CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION)
      }
      if (step.tool === 'compile_v4_creative_manuscript' || step.tool === 'review_v4_manuscript'
        || step.idempotencyKey.includes(':v4:creative-manuscript:')
        || step.idempotencyKey.includes(':v4:review-manuscript:')) {
        addEvidence(VISUAL_DECK_V4_COMPILER_VERSION)
      }
    }
    if (evidence.size > 1) throw new Error('V4_COMPILER_IDENTITY_CONFLICT')
    return evidence.values().next().value ?? LEGACY_VISUAL_DECK_V4_COMPILER_VERSION
  }

  private async recordV4ReflectionProgress(
    input: PlanPresentationInput,
    stage: Extract<VisualDeckV4PlanningStage, 'reflect-deck-visual' | 'reflect-slide-briefs'>,
    status: 'NO_ISSUES' | 'APPLIED' | 'REFLECTION_SKIPPED',
  ) {
    const completed = V4_PLANNING_STAGES.indexOf(stage) + 1
    const label = stage === 'reflect-deck-visual' ? '整套叙事与视觉方案' : '逐页视觉施工单'
    const summary = status === 'REFLECTION_SKIPPED'
      ? `${label}已检查，沿用已验证方案继续`
      : `${label}质量检查已完成`
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.progress',
        payload: { stepId: input.stepId, completed, total: V4_PLANNING_STAGES.length, summary },
      })
    })
  }

  private async resolveV4StructuredGenerationProtocol(
    input: PlanPresentationInput,
    tenantId: string,
    compilerVersion: string,
  ) {
    const run = await this.requireRun(input.runId)
    const modelOverride = v4ModelOverride(run, 'TEXT', compilerVersion)
    const persistedProtocol = v4StructuredGenerationProtocolOverride(run, compilerVersion)
    if (persistedProtocol) return persistedProtocol
    const key = `${input.runId}:v4:structured-generation-preflight:planning:${input.attempt ?? 0}`
    const chain4 = compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION
    if (!chain4) {
      const existing = (await this.dependencies.repository.listSteps(input.runId))
        .find((step) => step.idempotencyKey === key && step.tool === 'preflight_v4_structured_generation')
      return existing?.status === 'COMPLETED'
        ? this.parseV4StructuredGenerationProtocol(existing.output).protocol
        : undefined
    }
    const inputHash = hashInput({ tool: 'preflight_v4_structured_generation', model: modelOverride })
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
      const persisted = this.parseV4StructuredGenerationProtocol(existing, chain4)
      await this.dependencies.repository.transact(input.runId, (transaction) => {
        if (transaction.run.v4StructuredGenerationProtocol !== persisted.protocol) {
          transaction.putRun({ ...transaction.run, v4StructuredGenerationProtocol: persisted.protocol, updatedAt: this.dependencies.clock.now().toISOString() })
        }
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
        ...(modelOverride ? { modelOverride } : {}),
        ...(chain4 ? { requiredProtocol: 'RESPONSES_JSON_SCHEMA' as const } : {}),
      }), chain4)
      await this.dependencies.repository.transact(input.runId, (transaction) => {
        const step = transaction.getStep(key)
        if (!step) throw new Error('STEP_NOT_FOUND')
        const now = this.dependencies.clock.now().toISOString()
        transaction.putStep({ ...step, status: 'COMPLETED', output: result, errorCode: null, updatedAt: now })
        transaction.putRun({ ...transaction.run, v4StructuredGenerationProtocol: result.protocol, updatedAt: now })
        this.clearCompletedPlanningRecovery(transaction)
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

  private parseV4StructuredGenerationProtocol(value: unknown, chain4 = false): Readonly<{ protocol: StructuredGenerationProtocol }> {
    if (!value || typeof value !== 'object' || !('protocol' in value)) throw new Error('STRUCTURED_GENERATION_PROTOCOL_INVALID')
    const protocol = value.protocol
    if (protocol !== 'RESPONSES_JSON_SCHEMA' && protocol !== 'RESPONSES_FUNCTION' && protocol !== 'CHAT_LEGACY') {
      throw new Error('STRUCTURED_GENERATION_PROTOCOL_INVALID')
    }
    if (chain4 && protocol !== 'RESPONSES_JSON_SCHEMA') throw new Error('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
    return { protocol }
  }

  private async runV4ManuscriptStage(
    input: PlanPresentationInput,
    request: V4ManuscriptStageRequest,
  ) {
    try {
      return await this.runV4PlanningStage(input, request)
    } catch (error) {
      // A semantic slot may be completed once, but a full business contract
      // must never be sent back to the model for repeated repair.
      if (!(error instanceof PlanningFailureError)
        || error.failure.errorCode !== 'MODEL_JSON_INVALID') throw error
      try {
        return await this.runV4PlanningStage(input, {
          ...request,
          repairAttempt: 1,
          payload: { ...request.payload, contentSlotCompletion: true },
        })
      } catch (repairError) {
        if (!(repairError instanceof PlanningFailureError)
          || repairError.failure.errorCode !== 'MODEL_JSON_INVALID') throw repairError
        throw new PlanningFailureError({
          ...repairError.failure,
          terminalCode: 'CONTRACT_REPAIR_EXHAUSTED',
          retryable: false,
          attempt: 2,
          maxAttempts: 2,
          suggestedAction: 'CONTACT_ADMIN',
          diagnosticCode: V4_MANUSCRIPT_SEMANTIC_INVALID,
        })
      }
    }
  }

  private async runV4PlanningStage(input: PlanPresentationInput, request: Readonly<{
    stage: VisualDeckV4PlanningStage
    tool: string
    operation: string
    schemaName: string
    payload: unknown
    evidenceWindow?: V4EvidenceWindow
    sourceAssets?: Parameters<StructuredModelPort['execute']>[0]['sourceAssets']
    protocol: StructuredGenerationProtocol | undefined
    compilerVersion: string
    repairAttempt?: number
    parse: (value: unknown) => unknown
  }>) {
    const key = visualDeckV4PlanningStageStepKey(
      input.runId, request.stage, input.attempt ?? 0, request.repairAttempt ?? 0,
    )
    const auditStageKey = visualDeckV4PlanningStageStepKey(
      input.runId, request.stage, input.attempt ?? 0,
    )
    const inputHash = hashInput({ tool: request.tool, operation: request.operation, schemaName: request.schemaName, payload: request.payload, protocol: request.protocol })
    const existing = await this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(key)
      if (!step) return null
      if (step.inputHash !== inputHash || step.tool !== request.tool) {
        throw new Error(request.compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION
          ? V4_PLANNING_REQUEST_REPLAY_MISMATCH
          : 'STEP_IDEMPOTENCY_CONFLICT')
      }
      if (step.status === 'COMPLETED') return step.output
      if (step.status === 'FAILED') {
        const now = this.dependencies.clock.now().toISOString()
        transaction.putStep({ ...step, status: 'RUNNING', errorCode: null, updatedAt: now })
      }
      return null
    })
    if (existing) return request.parse(existing)
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
    const run = await this.requireRun(input.runId)
    const modelOverride = v4ModelOverride(run, 'TEXT', request.compilerVersion)
    const modelInput: Parameters<StructuredModelPort['execute']>[0] = {
      tenantId: run.host.tenantId,
      operation: request.operation,
      schemaName: request.schemaName,
      payload: request.payload,
      ...(request.sourceAssets ? { sourceAssets: request.sourceAssets } : {}),
      idempotencyKey: key,
      ...(modelOverride ? { modelOverride } : {}),
      ...(request.protocol ? { structuredGenerationProtocol: request.protocol } : {}),
    }
    if (request.compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION) {
      if (!isV4ManuscriptStage(request.stage) || !request.evidenceWindow
        || request.protocol !== 'RESPONSES_JSON_SCHEMA' || !modelOverride) {
        throw new Error('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
      }
      try {
        const requestContract = await this.describeV4PlanningRequestContract(modelInput)
        await this.persistV4PlanningRequestEvidence({
          runId: input.runId,
          auditStageKey,
          requestKey: key,
          stage: request.stage,
          tool: request.tool,
          operation: request.operation,
          schemaName: request.schemaName,
          payload: request.payload,
          evidenceWindow: request.evidenceWindow,
          sourceAssets: request.sourceAssets ?? [],
          model: modelOverride,
          requestContract,
        })
      } catch (error) {
        const failure = this.contractFailure(input, error, 1, 1, false)
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
    const providerAttempt = await this.beginV4PlanningStageAttempt(
      input.runId, auditStageKey, key, request.stage,
    )
    const startedAt = Date.now()
    let executionMetrics: StructuredModelExecutionMetrics | null = null
    let executionMetricsConsumed = false
    const consumeExecutionMetrics = () => {
      if (!executionMetricsConsumed) {
        executionMetricsConsumed = true
        executionMetrics = this.takeStructuredModelExecutionMetrics(key)
      }
      return executionMetrics
    }
    try {
      const raw = await this.dependencies.model.execute(modelInput)
      executionMetrics = consumeExecutionMetrics()
      const parsed = request.parse(raw)
      const output = this.withV4ReflectionAudit(
        request.stage,
        parsed,
        executionMetrics,
        Math.max(0, Date.now() - startedAt),
      )
      const attemptRecord = this.v4PlanningStageAttemptRecord({
        attempt: providerAttempt,
        outcome: 'SUCCEEDED',
        requestKey: key,
        metrics: executionMetrics,
        durationMs: Math.max(0, Date.now() - startedAt),
      })
      return await this.dependencies.repository.transact(input.runId, (transaction) => {
        const step = transaction.getStep(key)
        if (!step) throw new Error('STEP_NOT_FOUND')
        const completed: StepRecord = { ...step, status: 'COMPLETED', output, errorCode: null, updatedAt: this.dependencies.clock.now().toISOString() }
        transaction.putStep(completed)
        this.recordV4PlanningStageAttempt(transaction, auditStageKey, key, request.stage, attemptRecord, true)
        this.clearCompletedPlanningRecovery(transaction)
        transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'tool.completed', payload: { stepId: step.id, summary: `V4 规划阶段已完成：${request.stage}` } })
        const stages = visualDeckV4PlanningStagesForCompiler(request.compilerVersion)
        const progressCompleted = stages.indexOf(request.stage) + 1
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'tool.progress',
          payload: {
            stepId: input.stepId,
            completed: progressCompleted,
            total: stages.length,
            summary: `V4 规划已完成 ${progressCompleted}/${stages.length} 阶段`,
          },
        })
        return output
      })
    } catch (error) {
      executionMetrics = consumeExecutionMetrics()
      const reflectionStage = request.stage === 'reflect-deck-visual' || request.stage === 'reflect-slide-briefs'
      const exhausted = providerAttempt === MAX_PROVIDER_ATTEMPTS
      const reflectionFailure = reflectionStage
        ? this.reflectionContractFailure(input, error, providerAttempt, exhausted)
        : null
      const failure = reflectionFailure
        ?? (error instanceof PlanningFailureError
          ? error.failure
          : this.providerFailure(input, error, providerAttempt)
          ?? this.contractFailure(
            input,
            error,
            providerAttempt,
            MAX_PROVIDER_ATTEMPTS,
            exhausted,
            request.compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION && isV4ManuscriptStage(request.stage),
          ))
      const attemptRecord = this.v4PlanningStageAttemptRecord({
        attempt: providerAttempt,
        outcome: 'FAILED',
        requestKey: key,
        metrics: executionMetrics,
        error,
        errorCode: failure.errorCode,
        durationMs: Math.max(0, Date.now() - startedAt),
      })
      await this.dependencies.repository.transact(input.runId, (transaction) => {
        const step = transaction.getStep(key)
        if (!step) throw new Error('STEP_NOT_FOUND')
        if (step.status !== 'FAILED') {
          transaction.putStep({ ...step, status: 'FAILED', errorCode: failure.errorCode, updatedAt: this.dependencies.clock.now().toISOString() })
          transaction.appendEvent({
            schemaVersion: CONTRACT_VERSION,
            type: 'tool.failed',
            payload: { stepId: step.id, errorCode: failure.errorCode, retryable: failure.retryable },
          })
        }
        const terminalAudit = providerAttempt === MAX_PROVIDER_ATTEMPTS
          || technicalFailureDisposition(failure.errorCode) === 'NON_RETRYABLE'
        this.recordV4PlanningStageAttempt(
          transaction, auditStageKey, key, request.stage, attemptRecord, terminalAudit,
        )
      })
      throw new PlanningFailureError(failure)
    }
  }

  private async persistV4PlanningRequestEvidence(input: Readonly<{
    runId: string
    auditStageKey: string
    requestKey: string
    stage: V4ManuscriptStageRequest['stage']
    tool: string
    operation: string
    schemaName: string
    payload: unknown
    evidenceWindow: V4EvidenceWindow
    sourceAssets: NonNullable<Parameters<StructuredModelPort['execute']>[0]['sourceAssets']>
    model: string
    requestContract: StructuredGenerationRequestContract
  }>) {
    const serializedPayload = JSON.stringify(input.payload)
    if (typeof serializedPayload !== 'string') throw new Error(V4_PLANNING_REQUEST_REPLAY_MISMATCH)
    const evidence: V4PlanningRequestEvidence = v4PlanningRequestEvidenceSchema.parse({
      schemaVersion: '1',
      requestKeyHash: hashInput(input.requestKey),
      stage: input.stage,
      tool: input.tool,
      operation: input.operation,
      schemaName: input.schemaName,
      compilerVersion: VISUAL_DECK_V4_COMPILER_VERSION,
      model: input.model,
      protocol: 'RESPONSES_JSON_SCHEMA',
      transport: 'RESPONSES',
      responseFormat: 'JSON_SCHEMA',
      stream: true,
      promptContractHash: input.requestContract.promptContractHash,
      responseSchemaHash: input.requestContract.responseSchemaHash,
      payloadHash: hashInput(input.payload),
      payloadCharacterCount: serializedPayload.length,
      evidenceWindow: {
        version: input.evidenceWindow.audit.version,
        selectedContentHash: input.evidenceWindow.audit.selectedContentHash,
        chunks: input.evidenceWindow.chunks.map((chunk) => ({
          id: chunk.id,
          sha256: chunk.sha256,
          includedCharacterCount: chunk.text.length,
        })),
        omittedChunkCount: input.evidenceWindow.audit.omittedChunkCount,
        characterCount: input.evidenceWindow.audit.characterCount,
        serializedByteCount: input.evidenceWindow.audit.serializedByteCount,
      },
      sourceAssetInputs: input.sourceAssets.map((asset) => ({
        id: asset.id,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        byteLength: asset.byteLength,
      })),
    })
    const idempotencyKey = v4PlanningRequestEvidenceKey(input.requestKey)
    const inputHash = hashInput(evidence)
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(idempotencyKey)
      if (existing) {
        const persisted = v4PlanningRequestEvidenceSchema.safeParse(existing.output)
        if (existing.tool !== V4_PLANNING_REQUEST_EVIDENCE_TOOL
          || existing.status !== 'COMPLETED'
          || existing.inputHash !== inputHash
          || !persisted.success
          || hashInput(persisted.data) !== hashInput(evidence)) {
          throw new Error(V4_PLANNING_REQUEST_REPLAY_MISMATCH)
        }
        return
      }
      const audit = transaction.getStep(`${input.auditStageKey}:attempt-audit`)
      const parsedAudit = audit ? v4PlanningStageAuditSchema.safeParse(audit.output) : null
      const inFlight = parsedAudit?.success ? parsedAudit.data.attempts.at(-1) : null
      if (audit && (!parsedAudit?.success
        || (inFlight?.outcome === 'STARTED' && inFlight.requestKeyHash === evidence.requestKeyHash))) {
        throw new Error(V4_PLANNING_REQUEST_REPLAY_MISMATCH)
      }
      const now = this.dependencies.clock.now().toISOString()
      transaction.putStep({
        id: `step-${hashInput({ idempotencyKey }).slice(0, 28)}`,
        runId: input.runId,
        idempotencyKey,
        inputHash,
        tool: V4_PLANNING_REQUEST_EVIDENCE_TOOL,
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: evidence,
        createdAt: now,
        updatedAt: now,
      })
    })
  }

  private async describeV4PlanningRequestContract(
    input: Parameters<StructuredModelPort['execute']>[0],
  ): Promise<StructuredGenerationRequestContract> {
    const candidate = this.dependencies.model as StructuredModelPort & Partial<StructuredGenerationRequestContractPort>
    if (!candidate.describeStructuredGenerationRequest) throw new Error('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
    const parsed = structuredGenerationRequestContractSchema.safeParse(
      await candidate.describeStructuredGenerationRequest(input),
    )
    if (!parsed.success) throw new Error('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
    return parsed.data
  }

  private async beginV4PlanningStageAttempt(
    runId: string,
    auditStageKey: string,
    requestKey: string,
    stage: VisualDeckV4PlanningStage,
  ) {
    return this.dependencies.repository.transact(runId, (transaction) => {
      const auditKey = `${auditStageKey}:attempt-audit`
      const stageKeyHash = hashInput(auditStageKey)
      const requestKeyHash = hashInput(requestKey)
      const inputHash = hashInput({ tool: 'audit_v4_planning_stage', stage, stageKeyHash })
      const existing = transaction.getStep(auditKey)
      if (existing && (existing.inputHash !== inputHash || existing.tool !== 'audit_v4_planning_stage')) {
        throw new Error('STEP_IDEMPOTENCY_CONFLICT')
      }
      const output = existing
        ? v4PlanningStageAuditSchema.parse(existing.output)
        : v4PlanningStageAuditSchema.parse({
            schemaVersion: '1', stage, stageKeyHash, totalDurationMs: 0, attempts: [],
          })
      if (output.stage !== stage || output.stageKeyHash !== stageKeyHash) {
        throw new Error('STEP_IDEMPOTENCY_CONFLICT')
      }
      const inFlight = output.attempts.at(-1)
      if (inFlight?.outcome === 'STARTED') {
        if (inFlight.requestKeyHash !== requestKeyHash) throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        return inFlight.attempt
      }
      if (output.attempts.length >= MAX_PROVIDER_ATTEMPTS) {
        throw new Error('V4_PLANNING_STAGE_ATTEMPTS_EXHAUSTED')
      }
      const attempt = v4PlanningStageAttemptSchema.parse({
        attempt: output.attempts.length + 1,
        outcome: 'STARTED',
        requestKeyHash,
        durationMs: 0,
        requestId: null,
        errorCode: null,
        status: null,
        responseAccepted: false,
        sseEventCount: 0,
        lastActivityAt: null,
      })
      const now = this.dependencies.clock.now().toISOString()
      const updatedOutput = v4PlanningStageAuditSchema.parse({
        ...output,
        attempts: [...output.attempts, attempt],
      })
      transaction.putStep(existing
        ? {
            ...existing,
            status: 'RUNNING',
            errorCode: null,
            output: updatedOutput,
            updatedAt: now,
          }
        : {
          id: `step-${hashInput({ auditKey }).slice(0, 28)}`,
          runId,
          idempotencyKey: auditKey,
          inputHash,
          tool: 'audit_v4_planning_stage',
          status: 'RUNNING',
          budgetUnits: 0,
          budgetReservationId: null,
          externalOperationId: null,
          errorCode: null,
          output: updatedOutput,
          createdAt: now,
          updatedAt: now,
        })
      return attempt.attempt
    })
  }

  private recordV4PlanningStageAttempt(
    transaction: AgentTransaction,
    auditStageKey: string,
    requestKey: string,
    stage: VisualDeckV4PlanningStage,
    attempt: V4PlanningStageAttempt,
    completed: boolean,
  ) {
    const auditKey = `${auditStageKey}:attempt-audit`
    const audit = transaction.getStep(auditKey)
    if (!audit || audit.tool !== 'audit_v4_planning_stage') throw new Error('STEP_NOT_FOUND')
    const output = v4PlanningStageAuditSchema.parse(audit.output)
    const started = output.attempts.at(-1)
    if (output.stage !== stage || output.stageKeyHash !== hashInput(auditStageKey)
      || started?.outcome !== 'STARTED' || started.attempt !== attempt.attempt
      || started.requestKeyHash !== hashInput(requestKey)
      || attempt.requestKeyHash !== started.requestKeyHash) {
      throw new Error('STEP_IDEMPOTENCY_CONFLICT')
    }
    const updatedOutput = v4PlanningStageAuditSchema.parse({
      ...output,
      totalDurationMs: output.totalDurationMs + attempt.durationMs,
      attempts: [...output.attempts.slice(0, -1), attempt],
    })
    transaction.putStep({
      ...audit,
      status: completed ? 'COMPLETED' : 'RUNNING',
      errorCode: completed && attempt.outcome === 'FAILED' ? attempt.errorCode : null,
      output: updatedOutput,
      updatedAt: this.dependencies.clock.now().toISOString(),
    })
  }

  private v4PlanningStageAttemptRecord(input: Readonly<{
    attempt: number
    outcome: V4PlanningStageAttempt['outcome']
    requestKey: string
    metrics: StructuredModelExecutionMetrics | null
    error?: unknown
    errorCode?: string
    durationMs: number
  }>): V4PlanningStageAttempt {
    const requestIdCandidate = input.metrics?.requestId
      ?? (input.error instanceof StructuredModelError ? input.error.requestId : null)
    const requestId = requestIdCandidate && /^[A-Za-z0-9._:-]{1,160}$/.test(requestIdCandidate)
      ? requestIdCandidate
      : null
    const statusCandidate = input.metrics?.status
      ?? (input.error instanceof StructuredModelError ? input.error.status : null)
    const status = Number.isSafeInteger(statusCandidate) && statusCandidate! >= 100 && statusCandidate! <= 599
      ? statusCandidate as number
      : null
    const lastActivityCandidate = input.metrics?.lastActivityAt
    const lastActivityAt = lastActivityCandidate && !Number.isNaN(Date.parse(lastActivityCandidate))
      ? new Date(lastActivityCandidate).toISOString()
      : null
    return v4PlanningStageAttemptSchema.parse({
      attempt: input.attempt,
      outcome: input.outcome,
      requestKeyHash: hashInput(input.requestKey),
      durationMs: Math.max(0, Math.floor(input.metrics?.durationMs ?? input.durationMs)),
      requestId,
      errorCode: input.outcome === 'FAILED' ? input.errorCode ?? 'PROVIDER_UNAVAILABLE' : null,
      status,
      responseAccepted: input.metrics?.responseAccepted ?? input.outcome === 'SUCCEEDED',
      sseEventCount: Number.isSafeInteger(input.metrics?.sseEventCount) && input.metrics!.sseEventCount >= 0
        ? input.metrics!.sseEventCount
        : 0,
      lastActivityAt,
      inputTokens: input.metrics?.inputTokens ?? null,
      outputTokens: input.metrics?.outputTokens ?? null,
      totalTokens: input.metrics?.totalTokens ?? null,
    })
  }

  private clearCompletedPlanningRecovery(transaction: AgentTransaction) {
    const recovery = transaction.run.technicalRecovery
    if (transaction.run.status !== 'PLANNING' || !recovery
      || recovery.resumeState !== 'PLANNING' || recovery.active) return
    const { technicalRecovery: _technicalRecovery, ...run } = transaction.run
    transaction.putRun({ ...run, updatedAt: this.dependencies.clock.now().toISOString() })
  }

  private takeStructuredModelExecutionMetrics(idempotencyKey: string) {
    const model = this.dependencies.model as StructuredModelPort & Partial<StructuredModelMetricsPort>
    return model.takeExecutionMetrics?.(idempotencyKey) ?? null
  }

  private withV4ReflectionAudit(
    stage: VisualDeckV4PlanningStage,
    value: unknown,
    metrics: StructuredModelExecutionMetrics | null,
    durationMs: number,
  ) {
    if (stage !== 'reflect-deck-visual' && stage !== 'reflect-slide-briefs') return value
    const output = stage === 'reflect-deck-visual'
      ? visualDeckV4DeckVisualReflectionStageOutputSchema.parse(value)
      : visualDeckV4SlideBriefsReflectionStageOutputSchema.parse(value)
    const token = (candidate: number | null | undefined) => Number.isSafeInteger(candidate) && candidate! >= 0
      ? candidate as number
      : null
    const inputTokens = token(metrics?.inputTokens)
    const outputTokens = token(metrics?.outputTokens)
    const totalTokens = token(metrics?.totalTokens)
      ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
    const requestId = metrics?.requestId && /^[A-Za-z0-9._:-]{1,160}$/.test(metrics.requestId)
      ? metrics.requestId
      : null
    const audit = {
      rubricVersion: VISUAL_DECK_V4_REFLECTION_RUBRIC_VERSION,
      decision: output.reflection.decision,
      findingCount: output.reflection.findings.length,
      modelCallCount: 1,
      durationMs: Math.max(0, Math.floor(metrics?.durationMs ?? durationMs)),
      inputTokens,
      outputTokens,
      totalTokens,
      requestId,
      promptBeforeHash: output.reflection.baseArtifactHash,
      promptAfterHash: hashInput(output.artifact),
      highRiskEscalation: false as const,
    }
    return stage === 'reflect-deck-visual'
      ? visualDeckV4DeckVisualReflectionStageOutputSchema.parse({ ...output, audit })
      : visualDeckV4SlideBriefsReflectionStageOutputSchema.parse({ ...output, audit })
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
    onAttempt?: () => void,
  ) {
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
      try {
        onAttempt?.()
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

  private reflectionContractFailure(
    input: PlanPresentationInput,
    error: unknown,
    attempt: number,
    exhausted: boolean,
  ): PlanningFailure | null {
    let diagnosticCode: string
    let fieldPaths: string[]
    if (error instanceof ZodError) {
      diagnosticCode = 'V4_REFLECTION_SCHEMA_INVALID'
      fieldPaths = [...new Set(error.issues.map((issue) => issue.path.join('.') || 'reflection'))].slice(0, 20)
    } else if (error instanceof StructuredModelError && error.code === 'MODEL_JSON_INVALID') {
      diagnosticCode = 'MODEL_JSON_INVALID'
      fieldPaths = ['reflection']
    } else {
      const message = error instanceof Error ? error.message : ''
      const mapped = V4_REFLECTION_DIAGNOSTIC_PATHS[message]
      if (!mapped) return null
      diagnosticCode = message
      fieldPaths = [...mapped]
    }
    const retryable = !exhausted
    return {
      errorCode: 'MODEL_JSON_INVALID',
      ...(exhausted ? { terminalCode: 'CONTRACT_REPAIR_EXHAUSTED' as const } : {}),
      retryable,
      attempt,
      maxAttempts: MAX_PROVIDER_ATTEMPTS,
      suggestedAction: retryable ? 'RETRY' : 'CONTACT_ADMIN',
      diagnosticCode,
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

  private contractFailure(
    input: PlanPresentationInput,
    error: unknown,
    attempt: number,
    maxAttempts: number,
    exhausted: boolean,
    semanticManuscript = false,
  ): PlanningFailure {
    const semanticContractFailure = semanticManuscript && !isV4ManuscriptContextTooLargeError(error)
    const fieldPaths = semanticContractFailure && error instanceof ZodError
      ? [...new Set(error.issues.map((issue) => issue.path.join('.') || 'manuscript'))].slice(0, 20)
      : semanticContractFailure
        ? ['manuscript']
        : error instanceof ZodError
      ? [...new Set(error.issues.map((issue) => issue.path.join('.') || 'blueprint'))].slice(0, 20)
      : error instanceof StructuredModelError && error.code === 'MODEL_JSON_INVALID'
        ? ['blueprint']
        : []
    const message = error instanceof Error ? error.message : ''
    const errorCode: PlanningFailure['errorCode'] = isV4ManuscriptContextTooLargeError(error)
      ? V4_MANUSCRIPT_CONTEXT_TOO_LARGE
      : semanticContractFailure
        ? 'MODEL_JSON_INVALID'
      : error instanceof ZodError
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
              : message === 'V4_CHAIN4_PROTOCOL_UNSUPPORTED'
                ? 'V4_CHAIN4_PROTOCOL_UNSUPPORTED'
                : message === 'V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE'
                  ? 'V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE'
                  : message === V4_PLANNING_REQUEST_REPLAY_MISMATCH
                    ? V4_PLANNING_REQUEST_REPLAY_MISMATCH
                    : message === 'V4_MANUSCRIPT_SOURCE_EVIDENCE_UNRESOLVED'
                      ? 'V4_MANUSCRIPT_SOURCE_EVIDENCE_UNRESOLVED'
                      : message === 'V4_MANUSCRIPT_SOURCE_EVIDENCE_AMBIGUOUS'
                        ? 'V4_MANUSCRIPT_SOURCE_EVIDENCE_AMBIGUOUS'
                        : message === 'MODEL_JSON_INVALID' || error instanceof SyntaxError
                          ? 'MODEL_JSON_INVALID'
                          : 'BLUEPRINT_SCHEMA_INVALID'
    const retryable = semanticContractFailure || [
      'MODEL_JSON_INVALID',
      'BLUEPRINT_SLIDE_COUNT_MISMATCH',
      'BLUEPRINT_SOURCE_REFERENCE_INVALID',
      'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID',
      'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE',
    ]
      .includes(errorCode)
    const effectiveRetryable = retryable && !exhausted
    return {
      errorCode,
      ...(exhausted ? { terminalCode: 'CONTRACT_REPAIR_EXHAUSTED' as const } : {}),
      retryable: effectiveRetryable,
      attempt,
      maxAttempts,
      suggestedAction: effectiveRetryable ? 'RETRY' : 'CONTACT_ADMIN',
      diagnosticCode: semanticContractFailure ? V4_MANUSCRIPT_SEMANTIC_INVALID : errorCode,
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

  private v4SlideBriefContractIssues(error: unknown) {
    const issues = this.contractIssues(error)
    if (!issues || issues.length === 0 || !issues.every((issue) =>
      issue.path === 'slideBriefs' || issue.path.startsWith('slideBriefs.'))) {
      return null
    }
    return issues
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }

  private async prepare(
    input: PlanPresentationInput,
    document: DocumentResult,
    planningStageCount: number,
  ): Promise<PlanPresentationResult & { run: RunRecord }> {
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
        total: transaction.run.presentationMode === 'VISUAL_DECK_V4' ? planningStageCount : 1,
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
      // V4 owns the complete source-to-PPT workflow. Its persisted plan is an
      // internal production artifact, not a second user approval boundary.
      const startsExecution = approvedPageDesign || transaction.run.presentationMode === 'VISUAL_DECK_V4'
      const targetStatus = startsExecution ? 'EXECUTING' as const : 'AWAITING_BLUEPRINT_APPROVAL' as const
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
            : startsExecution
            ? `已完成 ${blueprint.slides.length} 页视觉规划，开始逐页生成`
            : getPresentationModeStrategy(input.presentationMode ?? 'SLIDE_IMAGE_V2').planningKind === 'BLUEPRINT_WITH_REFLECTION'
            ? `已反思并修订 ${blueprint.slides.length} 页教学蓝图`
            : `已生成 ${blueprint.slides.length} 页教学蓝图`,
        },
      })
      const completedPlanningStageCount = blueprint.visualDeckV4Proposal
        ? visualDeckV4PlanningStagesForCompiler(blueprint.visualDeckV4Proposal.compilerVersion).length
        : 1
      appendV4LifecycleEvent(transaction, 'planning.completed', {
        completed: completedPlanningStageCount,
        total: completedPlanningStageCount,
        pageNumbers: allPageNumbers(transaction.run),
        reason: startsExecution ? null : 'USER_CONFIRMATION_REQUIRED',
        requiresUserAction: !startsExecution,
        nextAction: startsExecution ? null : 'APPROVE_BLUEPRINT',
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
      if (approvedPageDesign) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.resolved',
          payload: { kind: 'BLUEPRINT', actionType: 'APPROVED_PAGE_DESIGN' },
        })
      } else if (!startsExecution) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'BLUEPRINT', summary: `请确认《${blueprint.title}》的 ${blueprint.slides.length} 页蓝图` },
        })
      }
      if (startsExecution) {
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
    compilerVersion: string | null = null,
  ) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'FAILED') return step
      const now = this.dependencies.clock.now().toISOString()
      const terminalSemanticManuscriptFailure = failure.errorCode === 'MODEL_JSON_INVALID'
        && failure.terminalCode === 'CONTRACT_REPAIR_EXHAUSTED'
        && failure.diagnosticCode === V4_MANUSCRIPT_SEMANTIC_INVALID
      const v4InternalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4'
        && issueCategory === 'PLANNING_FAILED'
        && !terminalSemanticManuscriptFailure
        && !isTechnicalFailureCode(failure.errorCode)
      const recoveryReason = v4InternalFailure ? 'V4_PLANNING_STAGE_FAILED' : failure.errorCode
      const technicalRecovery = transaction.run.presentationMode === 'VISUAL_DECK_V4'
        && !terminalSemanticManuscriptFailure
        && isTechnicalFailureCode(recoveryReason)
        ? beginTechnicalRecovery(transaction, this.dependencies.clock, recoveryReason)
        : null
      const policy = technicalRecovery ? null : transitionRun(transaction.run, 'NEEDS_HUMAN')
      const run: RunRecord = policy
        ? { ...transaction.run, ...policy, updatedAt: now }
        : transaction.run
      const updated: StepRecord = { ...step, status: 'FAILED', errorCode: failure.errorCode, updatedAt: now }
      if (!technicalRecovery) transaction.putRun(run)
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
      if (!technicalRecovery) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'PLANNING', to: 'NEEDS_HUMAN', reason: failure.errorCode },
        })
      }
      const planningStages = compilerVersion
        ? visualDeckV4PlanningStagesForCompiler(compilerVersion)
        : V4_PLANNING_STAGES
      const completedStages = transaction.run.presentationMode === 'VISUAL_DECK_V4'
        ? planningStages.filter((stage) => transaction.getStep(visualDeckV4PlanningStageStepKey(
            input.runId, stage, input.attempt ?? 0,
          ))?.status === 'COMPLETED').length
        : 0
      if (!technicalRecovery) {
        appendV4LifecycleEvent(transaction, 'planning.completed', {
          completed: completedStages,
          total: transaction.run.presentationMode === 'VISUAL_DECK_V4' ? planningStages.length : 1,
          reason: ['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE'].includes(failure.errorCode)
            ? 'PROVIDER_TEMPORARILY_UNAVAILABLE'
            : 'PLANNING_FAILED',
          retryable: failure.retryable,
          requiresUserAction: true,
          nextAction: failure.retryable ? 'RETRY' : 'REVIEW_RESULT',
        })
      }
      return updated
    })
  }

  /** Records a source-port outage before a planning step exists, preserving the original planning key. */
  private async failTechnicalSourceResolution(
    input: PlanPresentationInput,
    errorCode: string,
    compilerVersion: string | null,
  ) {
    const idempotencyKey = `${input.idempotencyKey}:source-resolution`
    const inputHash = hashInput({ tool: 'resolve_source', source: input.source })
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(idempotencyKey)
      if (existing && (existing.inputHash !== inputHash || existing.tool !== 'resolve_source')) {
        throw new Error('STEP_IDEMPOTENCY_CONFLICT')
      }
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = existing
        ? { ...existing, status: 'FAILED', errorCode, updatedAt: now }
        : {
            id: `step-${hashInput({ idempotencyKey }).slice(0, 28)}`,
            runId: input.runId,
            idempotencyKey,
            inputHash,
            tool: 'resolve_source',
            status: 'FAILED',
            budgetUnits: 0,
            budgetReservationId: null,
            externalOperationId: null,
            errorCode,
            output: null,
            createdAt: now,
            updatedAt: now,
          }
      transaction.putStep(step)
      appendV4LifecycleEvent(transaction, 'planning.started', {
        completed: 0,
        total: visualDeckV4PlanningStagesForCompiler(
          compilerVersion ?? LEGACY_VISUAL_DECK_V4_COMPILER_VERSION,
        ).length,
        pageNumbers: allPageNumbers(transaction.run),
      })
      const recovery = beginTechnicalRecovery(transaction, this.dependencies.clock, errorCode)
      if (!recovery) throw new Error('TECHNICAL_SOURCE_RECOVERY_NOT_ALLOWED')
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode, retryable: recovery.technicalRecovery?.retryable ?? false },
      })
      return step
    })
  }

  /** Closes the prior durable source outage before the original planning key resumes. */
  private async completeTechnicalSourceResolution(input: PlanPresentationInput, document: DocumentResult) {
    const idempotencyKey = `${input.idempotencyKey}:source-resolution`
    const inputHash = hashInput({ tool: 'resolve_source', source: input.source })
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(idempotencyKey)
      if (!existing) return
      if (existing.inputHash !== inputHash || existing.tool !== 'resolve_source') {
        throw new Error('STEP_IDEMPOTENCY_CONFLICT')
      }
      if (existing.status === 'COMPLETED') return
      const updated: StepRecord = {
        ...existing,
        status: 'COMPLETED',
        errorCode: null,
        output: {
          name: document.name,
          chunkCount: document.chunks.length,
          isComplete: document.isComplete,
        },
        updatedAt: this.dependencies.clock.now().toISOString(),
      }
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: updated.id, summary: '来源资料已恢复可访问，继续执行原规划任务' },
      })
      this.clearCompletedPlanningRecovery(transaction)
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

import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { HostContext } from '../contracts'
import type { BlueprintDraft } from '../presentation-contracts'
import type { HostAuthenticationPort } from '../http/handler'
import { createHttpHandler } from '../http/handler'
import type { PresentationJobV2AuthenticationPort } from '../http/presentation-job-v2-handler'
import { InMemoryPrincipalRateLimiter, type PrincipalRateLimiterPort } from '../http/principal-rate-limiter'
import { SharedTokenAuthentication } from '../http/service-token-authentication'
export { ServiceTokenAuthentication, SharedTokenAuthentication } from '../http/service-token-authentication'
import { FrameFlowHostAdapter, type FrameFlowBackendClient } from '../adapters/frameflow-host'
import type { ProviderBillingCatalog } from '../adapters/provider-billing-catalog'
import { SharpPptxPresentationRenderer } from '../adapters/presentation-renderer'
import { SharpControlledRasterPort } from '../adapters/v4-controlled-raster'
import { DeckReviewRunner } from '../core/deck-review-runner'
import { AdminOperationsService } from '../core/admin-operations'
import { AdminRevisionRoundsSettingsService } from '../core/admin-revision-rounds-settings'
import { DeliveryRunner } from '../core/delivery-runner'
import { MediaStepRunner } from '../core/media-step-runner'
import { providerTechnicalFailure } from '../core/technical-recovery'
import { PageReviewCoordinator } from '../core/page-review-coordinator'
import { PlanningRunner, planningStepKey } from '../core/planning-runner'
import { hashInput } from '../core/hash'
import { compileVisualDeckV4Proposal } from '../core/visual-deck-v4-planner'
import { VISUAL_DECK_V4_REFLECTION_DIMENSIONS } from '../visual-deck-v4-contracts'
import {
  acquireMediaReconciliationLease,
  acquireRunLease,
  releaseRunLease,
  renewRunLease,
  type RunLease,
} from '../core/lease'
import { RevisionApplicationRunner } from '../core/revision-application-runner'
import { RevisionMediaCoordinator } from '../core/revision-media-coordinator'
import { RevisionPlanningRunner } from '../core/revision-planning-runner'
import type {
  AgentRepository,
  ArtifactPort,
  AssetCandidateReviewPort,
  AssetDiscoveryPort,
  BatchBudgetPort,
  BudgetPort,
  ClockPort,
  ControlledRasterPort,
  DeckReviewPort,
  DocumentPort,
  ImageGenerationPort,
  PresentationRendererPort,
  RevisionApplicationPort,
  RevisionPlanningPort,
  RunRecord,
  StructuredModelPort,
  StructuredModelMetricsPort,
  StructuredGenerationPreflightPort,
  UsageAccountingPort,
  VisualReviewPort,
} from '../core/ports'
import { PresentationJobV2Service } from '../core/presentation-job-v2-service'
import type {
  PresentationJobV2BudgetPolicy,
  PresentationJobV2ProviderPort,
  PresentationJobV2Repository,
} from '../core/presentation-job-v2-ports'
import { RunService } from '../core/run-service'
import { SlideGenerationCoordinator } from '../core/slide-generation-coordinator'
import { VisualReviewRunner } from '../core/visual-review-runner'
import { failVisualDeckV4Run } from '../core/v4-lifecycle'
import { resumeTechnicalRecovery } from '../core/technical-recovery'
import { UsageV2Coordinator } from '../core/usage-v2-coordinator'
import { RuntimeHealthMonitor, safeWorkerErrorCode, WorkerTickError } from '../observability/runtime-health'
import { buildIdentity, type BuildIdentity } from '../release-identity'
import type { UsageAccountingProtocol } from '../usage-accounting-contracts'

export class SystemClock implements ClockPort {
  now() { return new Date() }
}

class MockFrameFlowBackend implements FrameFlowBackendClient {
  async getDocumentAttachment(): Promise<never> { throw new Error('MOCK_RUNTIME_TEXT_SOURCE_ONLY') }
  async reserveCredits(input: Parameters<FrameFlowBackendClient['reserveCredits']>[0]) {
    return { reservationId: `mock-budget:${input.idempotencyKey}` }
  }
  async settleCredits() {}
  async releaseCredits() {}
  async finalizeCredits() {}
  async preflightBatchFinalization() {}
}

class DisabledV1Ports implements DocumentPort, BudgetPort, BatchBudgetPort {
  async resolve(): Promise<never> { throw new Error('V1_EXECUTION_DISABLED') }
  async reserve(): Promise<never> { throw new Error('V1_EXECUTION_DISABLED') }
  async settle(): Promise<never> { throw new Error('V1_EXECUTION_DISABLED') }
  async release(): Promise<never> { throw new Error('V1_EXECUTION_DISABLED') }
  async preflightBatchFinalization(): Promise<never> { throw new Error('V1_EXECUTION_DISABLED') }
  async reserveBatch(): Promise<never> { throw new Error('V1_EXECUTION_DISABLED') }
  async finalizeBatch(): Promise<never> { throw new Error('V1_EXECUTION_DISABLED') }
}

type MockReflectionFailureMode = 'NONE' | 'INVALID_SLIDE_CRITIC'

class DeterministicPlanningModel implements StructuredModelPort, StructuredGenerationPreflightPort {
  constructor(private readonly reflectionFailureMode: MockReflectionFailureMode = 'NONE') {}

  async preflightStructuredGeneration() {
    return { protocol: 'RESPONSES_JSON_SCHEMA' as const }
  }

  async execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    const visualDeckV4Stage = [
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'reflect_and_revise_deck_visual',
      'create_visual_deck_v4_slide_briefs',
      'reflect_and_revise_slide_briefs',
      'review_visual_deck_v4_coherence',
      'critique_v4_deck_consistency',
      'optimize_v4_deck_consistency',
      'critique_v4_slide_briefs',
      'optimize_v4_slide_briefs',
    ].includes(input.operation)
    if (visualDeckV4Stage) {
      if (input.operation === 'critique_v4_deck_consistency') return { issues: [] }
      if (input.operation === 'critique_v4_slide_briefs') {
        return this.reflectionFailureMode === 'INVALID_SLIDE_CRITIC'
          ? { decision: 'APPROVED' }
          : { issues: [] }
      }
      if (input.operation === 'optimize_v4_deck_consistency') {
        return {
          titleChanges: [], narrativeArcChanges: [], artDirectionChanges: [], paletteChanges: [],
          typographyChanges: [], mediumChanges: [], visualDensityChanges: [], compositionRuleChanges: [],
          continuityRuleChanges: [], forbiddenChanges: [],
        }
      }
      if (input.operation === 'optimize_v4_slide_briefs') {
        return {
          roleChanges: [], visualMetaphorChanges: [], compositionChanges: [], informationHierarchyChanges: [],
          previousSlideRelationChanges: [], nextSlideRelationChanges: [],
        }
      }
      if (input.operation === 'review_visual_deck_v4_coherence') {
        return {
          decision: 'APPROVED',
          summary: '请求、来源、叙事、页面覆盖和视觉系统保持一致。',
          checks: [
            'REQUEST_BINDING',
            'SOURCE_GROUNDING',
            'NARRATIVE_COHERENCE',
            'SLIDE_COVERAGE',
            'VISUAL_COHERENCE',
          ].map((dimension) => ({ dimension, passed: true, evidence: `${dimension} 已通过。` })),
        }
      }
      if (input.operation === 'reflect_and_revise_deck_visual') {
        const payload = input.payload as { candidateArtifact: unknown; reviewContextHash: string }
        const candidate = payload.candidateArtifact
        return {
          decision: 'UNCHANGED',
          checks: VISUAL_DECK_V4_REFLECTION_DIMENSIONS.map((dimension) => ({
            dimension, passed: true, evidence: `${dimension} 已通过。`,
          })),
          findings: [],
          baseArtifactHash: hashInput(candidate),
          reviewContextHash: payload.reviewContextHash,
          appliedFindingIds: [],
          revisedArtifact: candidate,
        }
      }
      if (input.operation === 'reflect_and_revise_slide_briefs') {
        const payload = input.payload as { candidateArtifact: unknown; reviewContextHash: string }
        const candidate = payload.candidateArtifact
        return {
          decision: 'UNCHANGED',
          checks: VISUAL_DECK_V4_REFLECTION_DIMENSIONS.map((dimension) => ({
            dimension, passed: true, evidence: `${dimension} 已通过。`,
          })),
          findings: [],
          baseArtifactHash: hashInput(candidate),
          reviewContextHash: payload.reviewContextHash,
          appliedFindingIds: [],
          revisedSlides: [],
        }
      }
      const payload = input.payload as {
        instruction: string
        sourceMode: 'AUTO' | 'SOURCE_GROUNDED' | 'OPEN_KNOWLEDGE'
        sourceReferences: readonly Readonly<{
          sourceId: string
          name: string
          roleHint: 'AUTO' | 'CONTENT_SOURCE' | 'TEACHING_GUIDE' | 'STRUCTURE_REFERENCE' | 'DESIGN_REFERENCE' | 'BRAND_GUIDE' | 'ASSET'
        }>[]
        deckOptions: {
          deckType: 'DETAILED_DECK' | 'PRESENTER_SLIDES'
          language: string
          length: 'SHORT' | 'DEFAULT' | 'LONG' | { slideCount: number }
          aspectRatio: '16:9'
          audience?: string
          focus?: string
          styleHint?: string
        }
        slideCount: number
        visualDirection: string
        targetAudience?: string
        presentationGoal?: string
        document: {
          name: string
          sources: { id: string; name: string; kind: 'TEXT' | 'IMAGE' | 'PDF' | 'MARKDOWN'; status: 'READY' | 'FAILED'; failureCode?: string }[]
          chunks: { id: string; sourceId?: string; text: string; sha256: string }[]
          missingRanges: string[]
        }
      }
      const source = {
        kind: 'SOURCE_PACKAGE' as const,
        name: payload.document.name,
        sources: payload.sourceReferences.map((reference) => ({
          kind: 'TEXT' as const,
          sourceId: reference.sourceId,
          name: reference.name,
          roleHint: reference.roleHint,
          text: payload.document.chunks
            .filter((chunk) => chunk.sourceId === reference.sourceId || payload.sourceReferences.length === 1)
            .map((chunk) => chunk.text)
            .join('\n') || '当前资料只提供视觉参考，规划时不得将其作为新的事实来源。',
        })),
      }
      const proposal = compileVisualDeckV4Proposal({
        runId: 'mock-v4-run',
        inputHash: input.idempotencyKey,
        source,
        document: { ...payload.document, isComplete: payload.document.missingRanges.length === 0 },
        config: {
          instruction: payload.instruction,
          sourceMode: payload.sourceMode,
          deckOptions: payload.deckOptions,
        },
        slideCount: payload.slideCount,
        visualDirection: payload.visualDirection,
        ...(payload.targetAudience ? { targetAudience: payload.targetAudience } : {}),
        ...(payload.presentationGoal ? { presentationGoal: payload.presentationGoal } : {}),
        createdAt: new Date(0).toISOString(),
      })
      const { compilerVersion: _compilerVersion, ...draft } = proposal
      if (input.operation === 'create_visual_deck_v4_source_spec') {
        return { sourceUnderstanding: draft.sourceUnderstanding, presentationSpec: draft.presentationSpec }
      }
      if (input.operation === 'create_visual_deck_v4_deck_visual') {
        return { deckPlan: draft.deckPlan, visualContract: draft.visualContract }
      }
      if (input.operation === 'create_visual_deck_v4_slide_briefs') return { slideBriefs: draft.slideBriefs }
      throw new Error(`MOCK_V4_OPERATION_UNSUPPORTED:${input.operation}`)
    }
    if (input.operation === 'reflect_blueprint') {
      const payload = input.payload as {
        targetAudience?: string
        presentationGoal?: string
        originalBlueprint: BlueprintDraft
      }
      const dimensions = [
        'AUDIENCE_FIT',
        'GOAL_ALIGNMENT',
        'NARRATIVE',
        'INFORMATION_HIERARCHY',
        'COMPOSITION',
        'VISUAL_COHERENCE',
        'PROMPT_EXECUTABILITY',
      ] as const
      return {
        deckBrief: {
          targetAudience: payload.targetAudience ?? '使用当前教材的课堂学习者',
          presentationGoal: payload.presentationGoal ?? '帮助学习者理解并记住教材核心知识',
          useContext: '教师在课堂上配合讲解使用',
          audienceNeeds: ['用清晰叙事和直观视觉降低理解负担'],
          narrativeArc: ['建立主题情境并提出核心问题', '逐步展开知识并形成总结'],
          visualSystem: {
            artDirection: '清晰、统一且适合课堂投影的教育编辑插画',
            palette: '明亮主色、克制强调色和高对比中性色',
            compositionRules: ['每页只保留一个视觉焦点', '文字区域使用自然留白'],
            continuityRules: ['统一材质、光线和色彩逻辑', '相邻页面改变主体位置和镜位'],
          },
        },
        findings: dimensions.map((dimension) => ({
          dimension,
          score: 4,
          diagnosis: '初稿已经满足基础要求，仍需用统一规则强化该维度的执行一致性。',
          revisionInstruction: '保持教材引用不变，并在最终蓝图中落实清晰、具体、可生成的页面约束。',
        })),
        revisedBlueprint: payload.originalBlueprint,
      }
    }
    if (input.operation !== 'create_blueprint') throw new Error('MODEL_OPERATION_UNSUPPORTED')
    const payload = input.payload as {
      slideCount: number
      presentationMode?: 'SLIDE_IMAGE_V2' | 'SLIDE_IMAGE_V2_1' | 'LAYERED_COURSEWARE_V3'
      coverDesignMode?: 'INDEPENDENT' | 'FOLLOW_TEMPLATE'
      assetAcquisitionPolicy?: 'AI_FIRST' | 'SEARCH_FIRST'
      maxVisualAssetsPerSlide?: number
      document: { name: string; chunks: { id: string; text: string }[] }
    }
    const chunks = payload.document.chunks
    const title = payload.document.name.replace(/\.[^.]+$/, '').slice(0, 160) || '教学课件'
    const draft: BlueprintDraft = {
      title,
      curriculum: {
        subject: null,
        grade: null,
        lessonTitle: title,
        sourceSummary: chunks.map((chunk) => chunk.text).join(' ').slice(0, 4_000).padEnd(20, '。'),
        learningObjectives: ['理解教材中的核心知识与内容顺序'],
        scopeBoundaries: ['仅使用当前教材提供的内容'],
        prohibitedExtensions: ['不扩展教材以外的事实'],
        sourceChunkIds: chunks.map((chunk) => chunk.id),
      },
      slides: Array.from({ length: payload.slideCount }, (_, index) => {
        const chunk = chunks[index % chunks.length]!
        const pageNumber = index + 1
        const slide = {
          pageNumber,
          title: pageNumber === 1 ? title : `知识要点 ${pageNumber}`,
          body: [chunk.text.replace(/\s+/g, ' ').slice(0, 300) || `教材要点 ${pageNumber}`],
          layout: pageNumber === 1 ? 'HERO' as const : pageNumber % 2 === 0 ? 'SPLIT' as const : 'EDITORIAL' as const,
          visualIntent: `以课堂信息图呈现第 ${pageNumber} 页教材要点`,
          visualPrompt: `A clean educational classroom illustration for lesson page ${pageNumber}, generous text-safe space, no text or symbols`,
          sourceChunkIds: [chunk.id],
        }
        if (payload.presentationMode !== 'LAYERED_COURSEWARE_V3') return slide
        const knowledgeText = slide.body[0]!
        const independentCover = pageNumber === 1 && payload.coverDesignMode !== 'FOLLOW_TEMPLATE'
        const visualCount = independentCover ? 1 : Math.min(4, Math.max(1, payload.maxVisualAssetsPerSlide ?? 4))
        const knowledgeVisuals = Array.from({ length: visualCount }, (_, visualIndex) => {
          const roles = ['KNOWLEDGE_VISUAL', 'DIAGRAM', 'CHARACTER', 'KNOWLEDGE_VISUAL'] as const
          const purposes = [
            '用准确的具体对象直接呈现知识点',
            '用无文字关系图帮助儿童比较和理解',
            '用课堂引导角色与知识对象互动',
            '用新的具体情境巩固同一知识点',
          ]
          const columns = visualCount === 1 ? 1 : 2
          const column = visualIndex % columns
          const row = Math.floor(visualIndex / columns)
          return {
            kind: 'IMAGE' as const,
            elementId: `knowledge-${pageNumber}-${visualIndex + 1}`,
            role: roles[visualIndex]!,
            knowledgePoint: `${purposes[visualIndex]}：${knowledgeText}`.slice(0, 500),
            prompt: `Transparent educational cutout. ${purposes[visualIndex]}. Exact lesson knowledge: ${knowledgeText}. No text, labels or numbers.`,
            negativePrompt: 'text, numbers, formulas, logo, watermark, unrelated objects',
            sourceChunkIds: [chunk.id],
            placement: visualCount === 1
              ? { x: 0.62, y: 0.22, width: 0.31, height: 0.52 }
              : { x: 0.56 + column * 0.21, y: 0.18 + row * 0.32, width: 0.19, height: 0.27 },
            zIndex: 10 + visualIndex,
            fit: 'CONTAIN' as const,
            aspectRatio: '1:1' as const,
            backgroundMode: 'TRANSPARENT' as const,
            reuseKey: `${pageNumber === 1 ? 'cover' : 'knowledge'}:${chunk.id}:${visualIndex + 1}`,
          }
        })
        return {
          ...slide,
          layeredDesign: {
            designKind: pageNumber === 1 ? 'COVER' as const : 'CONTENT' as const,
            backgroundColor: pageNumber === 1 ? '#DDF3EC' : '#F7FBFA',
            elements: [
              {
                kind: 'IMAGE' as const,
                elementId: `base-${pageNumber}`,
                role: 'BASE_LAYER' as const,
                knowledgePoint: `建立第 ${pageNumber} 页教材知识情境`,
                prompt: `Text-free wide classroom scene directly supporting this lesson knowledge: ${knowledgeText}. Spacious composition, no letters or symbols.`,
                negativePrompt: 'text, numbers, formulas, logo, watermark',
                sourceChunkIds: [chunk.id],
                placement: { x: 0, y: 0, width: 1, height: 1 },
                zIndex: 0,
                fit: 'COVER' as const,
                aspectRatio: '16:9' as const,
                backgroundMode: 'OPAQUE' as const,
              },
              ...knowledgeVisuals,
              ...(independentCover ? [{
                kind: 'TEXT' as const,
                elementId: `title-${pageNumber}`,
                role: 'TITLE' as const,
                text: slide.title,
                sourceChunkIds: [chunk.id],
                placement: { x: 0.07, y: 0.25, width: 0.46, height: 0.25 },
                zIndex: 20,
                style: { fontSize: 44, bold: true, color: '#17202A', align: 'CENTER' as const },
              }] : [{
                kind: 'SHAPE' as const,
                elementId: `panel-${pageNumber}`,
                role: 'CONTENT_PANEL' as const,
                shape: 'ROUNDED_RECTANGLE' as const,
                placement: { x: 0.05, y: 0.10, width: 0.48, height: 0.78 },
                zIndex: 15,
                fillColor: '#FFFFFF',
                transparency: 8,
              }, {
                kind: 'TEXT' as const,
                elementId: `title-${pageNumber}`,
                role: 'TITLE' as const,
                text: slide.title,
                sourceChunkIds: [chunk.id],
                placement: { x: 0.09, y: 0.20, width: 0.39, height: 0.17 },
                zIndex: 20,
                style: { fontSize: 28, bold: true, color: '#17202A', align: 'LEFT' as const },
              }, {
                kind: 'TEXT' as const,
                elementId: `body-${pageNumber}`,
                role: 'BODY' as const,
                text: knowledgeText,
                sourceChunkIds: [chunk.id],
                placement: { x: 0.09, y: 0.43, width: 0.39, height: 0.30 },
                zIndex: 20,
                style: { fontSize: 18, bold: false, color: '#29343D', align: 'LEFT' as const },
              }]),
            ],
          },
        }
      }),
    }
    return draft
  }
}

class LocalMockImageGeneration implements ImageGenerationPort {
  private readonly results = new Map<string, string>()

  constructor(private readonly artifacts: ArtifactPort) {}

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    const operationId = `mock-image:${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 32)}`
    if (!this.results.has(operationId)) {
      const digest = createHash('sha256').update(input.prompt).digest()
      const bytes = await sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 3,
          background: { r: 70 + digest[0]! % 120, g: 90 + digest[1]! % 100, b: 110 + digest[2]! % 90 },
        },
      }).png().toBuffer()
      const runId = input.idempotencyKey.split(':slide:')[0] || 'mock-run'
      const artifact = await this.artifacts.put({
        tenantId: input.tenantId,
        runId,
        name: `${operationId}.png`,
        mimeType: 'image/png',
        bytes,
        idempotencyKey: `${input.idempotencyKey}:mock-artifact`,
      })
      this.results.set(operationId, artifact.artifactId)
    }
    return { operationId, state: 'COMPLETED' as const }
  }

  async lookupByIdempotency(
    input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0],
  ): ReturnType<NonNullable<ImageGenerationPort['lookupByIdempotency']>> {
    const operationId = `mock-image:${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 32)}`
    return this.results.has(operationId)
      ? { state: 'SUBMITTED' as const, operationId }
      : { state: 'NOT_SUBMITTED' as const }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    const artifactId = this.results.get(input.operationId)
    return artifactId
      ? { state: 'COMPLETED' as const, artifactId }
      : {
          state: 'FAILED' as const,
          errorCode: 'MOCK_IMAGE_NOT_FOUND',
          billingState: 'NOT_CHARGED' as const,
          technicalFailure: providerTechnicalFailure('MOCK_IMAGE_NOT_FOUND'),
        }
  }
}

class PassingVisualReview implements VisualReviewPort {
  async review() {
    return { approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null }
  }
}

class PassingDeckReview implements DeckReviewPort {
  async evaluate(input: Parameters<DeckReviewPort['evaluate']>[0]) {
    return {
      qualityScore: 90,
      curriculumCoverageScore: 92,
      narrativeCoherenceScore: 90,
      visualConsistencyScore: 88,
      compositionScore: 90,
      summary: 'Mock Runtime 整套审查通过，课件覆盖教材内容并满足交付门禁。',
      reviewedSourceChunkIds: input.sourceChunks.map((chunk) => chunk.id),
      issues: [],
    }
  }
}

class UnsupportedRevisionPlanning implements RevisionPlanningPort {
  async plan(): Promise<never> { throw new Error('MOCK_REVISION_PLANNING_NOT_CONFIGURED') }
}

class UnsupportedRevisionApplication implements RevisionApplicationPort {
  async apply(): Promise<never> { throw new Error('MOCK_REVISION_APPLICATION_NOT_CONFIGURED') }
}

type RuntimeInput = Readonly<{
  repository: AgentRepository
  artifacts: ArtifactPort
  discovery?: AssetDiscoveryPort
  candidateReviewer?: AssetCandidateReviewPort
  apiToken: string
  authentication?: HostAuthenticationPort
  model: StructuredModelPort & Partial<StructuredGenerationPreflightPort> & Partial<StructuredModelMetricsPort>
  visualReviewer: VisualReviewPort
  deckReviewer: DeckReviewPort
  revisionPlanner: RevisionPlanningPort
  revisionApplication: RevisionApplicationPort
  renderer?: PresentationRendererPort
  controlledRaster?: ControlledRasterPort
  images?: ImageGenerationPort
  clock?: ClockPort
  frameFlowBackend?: FrameFlowBackendClient
  appVersion?: string
  buildIdentity?: BuildIdentity
  heartbeatStaleMs?: number
  tickStaleMs?: number
  waitingSlaMs?: number
  stepSlaMs?: number
  workerId?: string
  workerConcurrency?: number
  imageConcurrency?: number
  revisionImageModel?: string
  reviewConcurrency?: number
  runLeaseTtlMs?: number
  createRunRateLimitPerMinute?: number
  runActionRateLimitPerMinute?: number
  rateLimiter?: PrincipalRateLimiterPort
  budget?: BudgetPort & BatchBudgetPort
  defaultAccountingProtocol?: UsageAccountingProtocol
  usageAccounting?: UsageAccountingPort
  providerBillingCatalog?: ProviderBillingCatalog
  v1ExecutionEnabled?: boolean
  presentationJobV2?: Readonly<{
    repository: PresentationJobV2Repository
    provider: PresentationJobV2ProviderPort
    budget: PresentationJobV2BudgetPolicy
  }>
}>

export function createAgentRuntime(input: RuntimeInput) {
  const clock = input.clock ?? new SystemClock()
  const workerId = input.workerId?.trim() || `worker-${randomUUID()}`
  const workerConcurrency = input.workerConcurrency ?? 2
  const imageConcurrency = input.imageConcurrency ?? 50
  const revisionImageModel = input.revisionImageModel?.trim() || 'gpt-image-2'
  const runLeaseTtlMs = input.runLeaseTtlMs ?? 60_000
  const v1ExecutionEnabled = input.v1ExecutionEnabled ?? true
  if (!Number.isSafeInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 8) {
    throw new Error('WORKER_CONCURRENCY_INVALID')
  }
  if (!Number.isSafeInteger(imageConcurrency) || imageConcurrency < 1 || imageConcurrency > 50) {
    throw new Error('IMAGE_CONCURRENCY_INVALID')
  }
  if (!Number.isSafeInteger(runLeaseTtlMs) || runLeaseTtlMs < 5_000 || runLeaseTtlMs > 15 * 60_000) {
    throw new Error('RUN_LEASE_TTL_INVALID')
  }
  const runtimeBuildIdentity = buildIdentity({
    ...(input.appVersion ? { softwareVersion: input.appVersion } : {}),
    ...input.buildIdentity,
  })
  const health = new RuntimeHealthMonitor(clock, {
    version: runtimeBuildIdentity.softwareVersion,
    buildIdentity: runtimeBuildIdentity,
    ...(input.heartbeatStaleMs === undefined ? {} : { heartbeatStaleMs: input.heartbeatStaleMs }),
    ...(input.tickStaleMs === undefined ? {} : { tickStaleMs: input.tickStaleMs }),
  })
  const trackedCall = <Input, Output>(operation: (input: Input) => Promise<Output>) => async (value: Input) => {
    health.tickActivity()
    try {
      return await operation(value)
    } finally {
      health.tickActivity()
    }
  }
  const model: StructuredModelPort
    & Partial<StructuredGenerationPreflightPort>
    & Partial<StructuredModelMetricsPort> = {
    ...(input.model.modelName === undefined ? {} : { modelName: input.model.modelName }),
    execute: trackedCall(input.model.execute.bind(input.model)),
    ...('preflightStructuredGeneration' in input.model
      && typeof input.model.preflightStructuredGeneration === 'function'
      ? { preflightStructuredGeneration: trackedCall(input.model.preflightStructuredGeneration.bind(input.model)) }
      : {}),
    ...('takeExecutionMetrics' in input.model
      && typeof input.model.takeExecutionMetrics === 'function'
      ? { takeExecutionMetrics: input.model.takeExecutionMetrics.bind(input.model) }
      : {}),
  }
  const visualReviewer: VisualReviewPort = {
    review: trackedCall(input.visualReviewer.review.bind(input.visualReviewer)),
  }
  const deckReviewer: DeckReviewPort = {
    evaluate: trackedCall(input.deckReviewer.evaluate.bind(input.deckReviewer)),
  }
  const revisionPlanner: RevisionPlanningPort = {
    plan: trackedCall(input.revisionPlanner.plan.bind(input.revisionPlanner)),
  }
  const trackedRevisionApplication: RevisionApplicationPort = {
    apply: trackedCall(input.revisionApplication.apply.bind(input.revisionApplication)),
  }
  const candidateReviewer: AssetCandidateReviewPort | undefined = input.candidateReviewer
    ? { reviewCandidate: trackedCall(input.candidateReviewer.reviewCandidate.bind(input.candidateReviewer)) }
    : undefined
  const disabledV1Ports = new DisabledV1Ports()
  const v1Ports = v1ExecutionEnabled
    ? new FrameFlowHostAdapter(input.frameFlowBackend ?? new MockFrameFlowBackend())
    : disabledV1Ports
  const documents: DocumentPort = v1Ports
  const budget: BudgetPort & BatchBudgetPort = v1ExecutionEnabled
    ? input.budget ?? v1Ports
    : disabledV1Ports
  const images = input.images ?? new LocalMockImageGeneration(input.artifacts)
  const renderer = input.renderer ?? new SharpPptxPresentationRenderer()
  const controlledRaster = input.controlledRaster ?? new SharpControlledRasterPort({ artifacts: input.artifacts })
  if (Boolean(input.usageAccounting) !== Boolean(input.providerBillingCatalog)) {
    throw new Error('USAGE_V2_RUNTIME_DEPENDENCIES_INCOMPLETE')
  }
  if (input.defaultAccountingProtocol === 'FRAMEFLOW_USAGE_V2'
    && (!input.usageAccounting || !input.providerBillingCatalog)) {
    throw new Error('USAGE_V2_RUNTIME_DEPENDENCIES_REQUIRED')
  }
  const usageV2 = input.usageAccounting && input.providerBillingCatalog
    ? new UsageV2Coordinator({
        repository: input.repository,
        usage: input.usageAccounting,
        billingCatalog: input.providerBillingCatalog,
        clock,
      })
    : undefined
  const runs = new RunService({
    repository: input.repository,
    clock,
    artifacts: input.artifacts,
    buildIdentity: runtimeBuildIdentity,
    ...(input.defaultAccountingProtocol ? { defaultAccountingProtocol: input.defaultAccountingProtocol } : {}),
    ...(input.providerBillingCatalog ? { providerBillingCatalog: input.providerBillingCatalog } : {}),
  })
  const rateLimiter = input.rateLimiter ?? new InMemoryPrincipalRateLimiter({
    createRun: { limit: input.createRunRateLimitPerMinute ?? 10, windowMs: 60_000 },
    runAction: { limit: input.runActionRateLimitPerMinute ?? 60, windowMs: 60_000 },
    now: () => clock.now().getTime(),
  })
  const presentationJobs = input.presentationJobV2
    ? new PresentationJobV2Service({
        repository: input.presentationJobV2.repository,
        artifacts: input.artifacts,
        provider: input.presentationJobV2.provider,
        budget: input.presentationJobV2.budget,
        clock,
      })
    : null
  const planning = new PlanningRunner({
    repository: input.repository,
    documents,
    model,
    clock,
  })
  const media = new MediaStepRunner({
    repository: input.repository,
    budget,
    images,
    clock,
    ...(usageV2 ? { usageV2 } : {}),
    inspectionConcurrency: imageConcurrency,
  })
  const operations = new AdminOperationsService({
    repository: input.repository,
    budget,
    media,
    clock,
    ...(usageV2 ? { usageV2 } : {}),
  })
  const revisionRoundsSettings = new AdminRevisionRoundsSettingsService({ repository: input.repository, clock })
  const generation = new SlideGenerationCoordinator({
    repository: input.repository,
    media,
    batchBudget: budget,
    documents,
    artifacts: input.artifacts,
    controlledRaster,
    ...(input.discovery ? { discovery: input.discovery } : {}),
    ...(candidateReviewer ? { candidateReviewer } : {}),
    clock,
    imageConcurrency,
  })
  const visual = new VisualReviewRunner({
    repository: input.repository,
    reviewer: visualReviewer,
    clock,
  })
  const pages = new PageReviewCoordinator({
    repository: input.repository,
    reviewer: visual,
    artifacts: input.artifacts,
    renderer,
    clock,
    onReviewCompleted: () => health.tickActivity(),
    ...(input.reviewConcurrency === undefined ? {} : { reviewConcurrency: input.reviewConcurrency }),
  })
  const deck = new DeckReviewRunner({
    repository: input.repository,
    documents,
    reviewer: deckReviewer,
    artifacts: input.artifacts,
    renderer,
    clock,
  })
  const delivery = new DeliveryRunner({
    repository: input.repository,
    artifacts: input.artifacts,
    renderer,
    clock,
  })
  const revisionPlanning = new RevisionPlanningRunner({
    repository: input.repository,
    documents,
    planner: revisionPlanner,
    clock,
  })
  const revisionApplication = new RevisionApplicationRunner({
    repository: input.repository,
    documents,
    application: trackedRevisionApplication,
    clock,
  })
  const revisionMedia = new RevisionMediaCoordinator({
    repository: input.repository,
    media,
    batchBudget: budget,
    artifacts: input.artifacts,
    clock,
    revisionImageModel,
    imageConcurrency,
  })

  const advanceRun = async (candidate: RunRecord) => {
    let phase = candidate.status
    try {
      await media.reconcilePendingRun(candidate.id)
      if (usageV2) await usageV2.flushEvents(candidate.id)
      let run = await input.repository.getRun(candidate.id)
      if (!run) return
      if (run.status === 'RECOVERING') {
        if (run.pendingTerminalFailure) {
          await generation.reconcileTerminalGenerationBatch(run.id)
          run = await input.repository.getRun(run.id)
          if (!run || run.status !== 'RECOVERING') return
        }
        const resumed = await input.repository.transact(run.id, (transaction) =>
          resumeTechnicalRecovery(transaction, clock))
        if (!resumed) return
        // Resume is its own durable worker operation. The restored phase is
        // picked up on the next tick with the original idempotency keys.
        return
      }
      phase = run.status
      if (run.status === 'PLANNING') {
        const planningAttempt = run.planningAttempt ?? 0
        await planning.plan({
          runId: run.id,
          stepId: planningAttempt === 0 ? `step-${run.id}-plan` : `step-${run.id}-plan-retry-${planningAttempt}`,
          idempotencyKey: planningStepKey(run.id, planningAttempt),
          source: run.source,
          slideCount: run.slideCount,
          visualDirection: run.visualDirection,
          ...(run.targetAudience ? { targetAudience: run.targetAudience } : {}),
          ...(run.presentationGoal ? { presentationGoal: run.presentationGoal } : {}),
          presentationMode: run.presentationMode ?? 'SLIDE_IMAGE_V2',
          coverDesignMode: run.coverDesignMode ?? 'INDEPENDENT',
          assetAcquisitionPolicy: run.assetAcquisitionPolicy ?? 'AI_FIRST',
          maxVisualAssetsPerSlide: run.maxVisualAssetsPerSlide ?? 4,
          ...(run.visualDeckV4 ? { visualDeckV4: run.visualDeckV4 } : {}),
          attempt: planningAttempt,
        })
      } else if (run.status === 'EXECUTING') {
        await generation.submitBlueprintImages(run.id, 1)
        await generation.refreshBlueprintImages(run.id)
      } else if (run.status === 'PAGE_REVIEW') {
        await pages.reviewAll(run.id)
      } else if (run.status === 'DECK_REVIEW') {
        const reviewed = await deck.review(run.id)
        const latest = await input.repository.getRun(run.id)
        if (latest?.status === 'DECK_REVIEW' && reviewed.review && !reviewed.passed) {
          await revisionPlanning.plan(run.id)
        }
      } else if (run.status === 'REVISING') {
        const applied = await revisionApplication.apply(run.id)
        if (applied.status === 'REVISING' && applied.requiresMedia) {
          await revisionMedia.submit(run.id, 1)
          await revisionMedia.refresh(run.id)
        }
      } else if (run.status === 'DELIVERING') {
        await delivery.deliver(run.id)
      }
    } catch (error) {
      await failVisualDeckV4Run({
        repository: input.repository,
        clock,
        runId: candidate.id,
        errorCode: 'WORKER_FATAL',
      }).catch(() => false)
      throw new WorkerTickError({
        runId: candidate.id,
        phase,
        errorCode: safeWorkerErrorCode(error),
      }, error)
    }
  }

  const withRenewedLease = async <T>(runId: string, lease: RunLease, operation: () => Promise<T>) => {
    let currentLease = lease
    let renewalFailure: unknown = null
    let renewal: Promise<void> | null = null
    const timer = setInterval(() => {
      if (renewal || renewalFailure) return
      renewal = renewRunLease({ repository: input.repository, clock, runId, lease: currentLease, ttlMs: runLeaseTtlMs })
        .then((renewed) => { currentLease = renewed })
        .catch((error) => { renewalFailure = error })
        .finally(() => { renewal = null })
    }, Math.max(1_000, Math.floor(runLeaseTtlMs / 3)))
    timer.unref?.()
    try {
      const result = await operation()
      if (renewalFailure) throw renewalFailure
      return result
    } finally {
      clearInterval(timer)
      if (renewal) await renewal
      await releaseRunLease({ repository: input.repository, clock, runId, lease: currentLease })
    }
  }

  const tickPresentationJobs = async () => {
    if (!presentationJobs) return { scannedJobs: 0 }
    return await health.trackTickOperation('presentation-jobs-v2', () =>
      presentationJobs.tick({ limit: workerConcurrency }))
  }

  const tick = () => health.runTick(async () => {
    if (!v1ExecutionEnabled) {
      const v2 = await tickPresentationJobs()
      return { scannedRuns: v2.scannedJobs, activeRuns: v2.scannedJobs }
    }
    const candidates = await input.repository.listRunnableRuns({
      now: clock.now().toISOString(),
      limit: workerConcurrency,
    })
    const runnableIds = new Set(candidates.map((candidate) => candidate.id))
    const pendingMediaIds = (await input.repository.listRunsWithPendingMedia(workerConcurrency))
      .filter((runId) => !runnableIds.has(runId))

    const runnableResults = await Promise.allSettled(candidates.map(async (candidate) => {
      const lease = await acquireRunLease({
        repository: input.repository,
        clock,
        runId: candidate.id,
        token: `${workerId}:${candidate.id}:${randomUUID()}`,
        ttlMs: runLeaseTtlMs,
      })
      if (!lease) return false
      await health.trackTickOperation(`run:${candidate.id}`, () =>
        withRenewedLease(candidate.id, lease, () => advanceRun(candidate)))
      return true
    }))
    const reconciliationResults = await Promise.allSettled(pendingMediaIds.map(async (runId) => {
      const lease = await acquireMediaReconciliationLease({
        repository: input.repository,
        clock,
        runId,
        token: `${workerId}:${runId}:reconcile:${randomUUID()}`,
        ttlMs: runLeaseTtlMs,
      })
      if (!lease) return false
      await health.trackTickOperation(`reconcile:${runId}`, () =>
        withRenewedLease(runId, lease, async () => {
          await media.reconcilePendingRun(runId)
          await generation.reconcileTerminalGenerationBatch(runId)
          if (usageV2) {
            await usageV2.flushEvents(runId)
            await usageV2.reconcileTerminalRun(runId)
          }
        }))
      return true
    }))
    const failure = [...runnableResults, ...reconciliationResults]
      .find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
    const v2 = await tickPresentationJobs()
    return {
      scannedRuns: candidates.length + pendingMediaIds.length + v2.scannedJobs,
      activeRuns: runnableResults.filter((result) => result.status === 'fulfilled' && result.value).length + v2.scannedJobs,
    }
  })

  const authentication = input.authentication ?? new SharedTokenAuthentication(input.apiToken)
  const presentationJobAuthentication = typeof (authentication as Partial<PresentationJobV2AuthenticationPort>).authenticateService === 'function'
    ? authentication as HostAuthenticationPort & PresentationJobV2AuthenticationPort
    : null

  return {
    handler: createHttpHandler({
      runs,
      repository: input.repository,
      artifacts: input.artifacts,
      authentication,
      health,
      operations,
      revisionRoundsSettings,
      rateLimiter,
      ...(input.waitingSlaMs === undefined ? {} : { waitingSlaMs: input.waitingSlaMs }),
      ...(input.stepSlaMs === undefined ? {} : { stepSlaMs: input.stepSlaMs }),
      ...(presentationJobs && presentationJobAuthentication ? {
        presentationJobV2: {
          service: presentationJobs,
          artifacts: input.artifacts,
          authentication: presentationJobAuthentication,
        },
      } : {}),
    }),
    tick,
    health,
  }
}

export function createMockRuntime(input: Omit<RuntimeInput,
  'model' | 'visualReviewer' | 'deckReviewer' | 'revisionPlanner' | 'revisionApplication'> & Readonly<{
    reflectionFailureMode?: MockReflectionFailureMode
    visualReviewer?: VisualReviewPort
    deckReviewer?: DeckReviewPort
    revisionPlanner?: RevisionPlanningPort
    revisionApplication?: RevisionApplicationPort
  }>) {
  const {
    reflectionFailureMode = 'NONE',
    visualReviewer = new PassingVisualReview(),
    deckReviewer = new PassingDeckReview(),
    revisionPlanner = new UnsupportedRevisionPlanning(),
    revisionApplication = new UnsupportedRevisionApplication(),
    ...runtimeInput
  } = input
  return createAgentRuntime({
    ...runtimeInput,
    model: new DeterministicPlanningModel(reflectionFailureMode),
    visualReviewer,
    deckReviewer,
    revisionPlanner,
    revisionApplication,
  })
}

import { createHash, timingSafeEqual } from 'node:crypto'
import sharp from 'sharp'
import type { HostContext } from '../contracts'
import type { BlueprintDraft } from '../presentation-contracts'
import type { HostAuthenticationPort } from '../http/handler'
import { createHttpHandler } from '../http/handler'
import { FrameFlowHostAdapter, type FrameFlowBackendClient } from '../adapters/frameflow-host'
import { SharpPptxPresentationRenderer } from '../adapters/presentation-renderer'
import { DeckReviewRunner } from '../core/deck-review-runner'
import { AdminOperationsService } from '../core/admin-operations'
import { DeliveryRunner } from '../core/delivery-runner'
import { MediaStepRunner } from '../core/media-step-runner'
import { PageReviewCoordinator } from '../core/page-review-coordinator'
import { PlanningRunner, planningStepKey } from '../core/planning-runner'
import { RevisionApplicationRunner } from '../core/revision-application-runner'
import { RevisionMediaCoordinator } from '../core/revision-media-coordinator'
import { RevisionPlanningRunner } from '../core/revision-planning-runner'
import type {
  AgentRepository,
  ArtifactPort,
  AssetDiscoveryPort,
  BudgetPort,
  ClockPort,
  DeckReviewPort,
  ImageGenerationPort,
  PresentationRendererPort,
  RevisionApplicationPort,
  RevisionPlanningPort,
  StructuredModelPort,
  VisualReviewPort,
} from '../core/ports'
import { RunService } from '../core/run-service'
import { SlideGenerationCoordinator } from '../core/slide-generation-coordinator'
import { VisualReviewRunner } from '../core/visual-review-runner'
import { RuntimeHealthMonitor, safeWorkerErrorCode, WorkerTickError } from '../observability/runtime-health'

export class SystemClock implements ClockPort {
  now() { return new Date() }
}

export class SharedTokenAuthentication implements HostAuthenticationPort {
  constructor(private readonly token: string) {
    if (token.length < 16) throw new Error('PPT_AGENT_API_TOKEN_TOO_SHORT')
  }

  async authenticate(request: Request): Promise<HostContext | null> {
    const authorization = request.headers.get('Authorization')
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    const expectedBytes = Buffer.from(this.token)
    const providedBytes = Buffer.from(provided)
    if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) return null
    const tenantId = request.headers.get('X-PPT-Agent-Tenant')?.trim()
    const externalUserId = request.headers.get('X-PPT-Agent-User')?.trim()
    const externalProjectId = request.headers.get('X-PPT-Agent-Project')?.trim()
    const role = request.headers.get('X-PPT-Agent-Role')?.trim() ?? 'USER'
    if (tenantId !== 'frameflow' || !externalUserId || externalUserId.length > 160) return null
    if (externalProjectId && externalProjectId.length > 160) return null
    if (role !== 'USER' && role !== 'ADMIN') return null
    return { tenantId, externalUserId, role, ...(externalProjectId ? { externalProjectId } : {}) }
  }
}

class MockFrameFlowBackend implements FrameFlowBackendClient {
  async getDocumentAttachment(): Promise<never> { throw new Error('MOCK_RUNTIME_TEXT_SOURCE_ONLY') }
  async reserveCredits(input: Parameters<FrameFlowBackendClient['reserveCredits']>[0]) {
    return { reservationId: `mock-budget:${input.idempotencyKey}` }
  }
  async releaseCredits() {}
}

class DeterministicPlanningModel implements StructuredModelPort {
  async execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    const payload = input.payload as {
      slideCount: number
      presentationMode?: 'SLIDE_IMAGE_V2' | 'LAYERED_COURSEWARE_V3'
      coverDesignMode?: 'INDEPENDENT' | 'FOLLOW_TEMPLATE'
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

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    const artifactId = this.results.get(input.operationId)
    return artifactId
      ? { state: 'COMPLETED' as const, artifactId }
      : { state: 'FAILED' as const, errorCode: 'MOCK_IMAGE_NOT_FOUND', billingState: 'NOT_CHARGED' as const }
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
  apiToken: string
  model: StructuredModelPort
  visualReviewer: VisualReviewPort
  deckReviewer: DeckReviewPort
  revisionPlanner: RevisionPlanningPort
  revisionApplication: RevisionApplicationPort
  renderer?: PresentationRendererPort
  images?: ImageGenerationPort
  clock?: ClockPort
  frameFlowBackend?: FrameFlowBackendClient
  appVersion?: string
  heartbeatStaleMs?: number
  tickStaleMs?: number
  waitingSlaMs?: number
  stepSlaMs?: number
}>

export function createAgentRuntime(input: RuntimeInput) {
  const clock = input.clock ?? new SystemClock()
  const health = new RuntimeHealthMonitor(clock, {
    version: input.appVersion ?? '0.1.0',
    ...(input.heartbeatStaleMs === undefined ? {} : { heartbeatStaleMs: input.heartbeatStaleMs }),
    ...(input.tickStaleMs === undefined ? {} : { tickStaleMs: input.tickStaleMs }),
  })
  const documents = new FrameFlowHostAdapter(input.frameFlowBackend ?? new MockFrameFlowBackend())
  const budget: BudgetPort = documents
  const images = input.images ?? new LocalMockImageGeneration(input.artifacts)
  const renderer = input.renderer ?? new SharpPptxPresentationRenderer()
  const runs = new RunService({ repository: input.repository, clock })
  const planning = new PlanningRunner({
    repository: input.repository,
    documents,
    model: input.model,
    clock,
  })
  const media = new MediaStepRunner({ repository: input.repository, budget, images, clock })
  const operations = new AdminOperationsService({ repository: input.repository, budget, media, clock })
  const generation = new SlideGenerationCoordinator({
    repository: input.repository,
    media,
    documents,
    artifacts: input.artifacts,
    ...(input.discovery ? { discovery: input.discovery } : {}),
    clock,
  })
  const visual = new VisualReviewRunner({
    repository: input.repository,
    reviewer: input.visualReviewer,
    clock,
  })
  const pages = new PageReviewCoordinator({
    repository: input.repository,
    reviewer: visual,
    artifacts: input.artifacts,
    renderer,
    clock,
  })
  const deck = new DeckReviewRunner({
    repository: input.repository,
    documents,
    reviewer: input.deckReviewer,
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
    planner: input.revisionPlanner,
    clock,
  })
  const revisionApplication = new RevisionApplicationRunner({
    repository: input.repository,
    documents,
    application: input.revisionApplication,
    clock,
  })
  const revisionMedia = new RevisionMediaCoordinator({ repository: input.repository, media, clock })

  const tick = () => health.runTick(async () => {
    const candidates = await input.repository.listRuns()
    let activeRuns = 0
    for (const candidate of candidates) {
      let phase = candidate.status
      try {
        await media.reconcilePendingRun(candidate.id)
        const run = await input.repository.getRun(candidate.id)
        if (!run) continue
        phase = run.status
        if (!['AWAITING_BLUEPRINT_APPROVAL', 'AWAITING_REVISION_APPROVAL', 'PAUSED', 'NEEDS_HUMAN', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
          activeRuns += 1
        }
        if (run.status === 'PLANNING') {
        const planningAttempt = run.planningAttempt ?? 0
        await planning.plan({
          runId: run.id,
          stepId: planningAttempt === 0 ? `step-${run.id}-plan` : `step-${run.id}-plan-retry-${planningAttempt}`,
          idempotencyKey: planningStepKey(run.id, planningAttempt),
          source: run.source,
          slideCount: run.slideCount,
          visualDirection: run.visualDirection,
          presentationMode: run.presentationMode ?? 'SLIDE_IMAGE_V2',
          coverDesignMode: run.coverDesignMode ?? 'INDEPENDENT',
          maxVisualAssetsPerSlide: run.maxVisualAssetsPerSlide ?? 4,
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
        throw new WorkerTickError({
          runId: candidate.id,
          phase,
          errorCode: safeWorkerErrorCode(error),
        }, error)
      }
    }
    return { scannedRuns: candidates.length, activeRuns }
  })

  return {
    handler: createHttpHandler({
      runs,
      repository: input.repository,
      artifacts: input.artifacts,
      authentication: new SharedTokenAuthentication(input.apiToken),
      health,
      operations,
      ...(input.waitingSlaMs === undefined ? {} : { waitingSlaMs: input.waitingSlaMs }),
      ...(input.stepSlaMs === undefined ? {} : { stepSlaMs: input.stepSlaMs }),
    }),
    tick,
    health,
  }
}

export function createMockRuntime(input: Omit<RuntimeInput,
  'model' | 'visualReviewer' | 'deckReviewer' | 'revisionPlanner' | 'revisionApplication'>) {
  return createAgentRuntime({
    ...input,
    model: new DeterministicPlanningModel(),
    visualReviewer: new PassingVisualReview(),
    deckReviewer: new PassingDeckReview(),
    revisionPlanner: new UnsupportedRevisionPlanning(),
    revisionApplication: new UnsupportedRevisionApplication(),
  })
}

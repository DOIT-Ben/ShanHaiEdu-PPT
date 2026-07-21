import { createHash, timingSafeEqual } from 'node:crypto'
import sharp from 'sharp'
import type { HostContext } from '../contracts'
import type { BlueprintDraft } from '../presentation-contracts'
import type { HostAuthenticationPort } from '../http/handler'
import { createHttpHandler } from '../http/handler'
import { FrameFlowHostAdapter, type FrameFlowBackendClient } from '../adapters/frameflow-host'
import { SharpPptxPresentationRenderer } from '../adapters/presentation-renderer'
import { DeckReviewRunner } from '../core/deck-review-runner'
import { DeliveryRunner } from '../core/delivery-runner'
import { MediaStepRunner } from '../core/media-step-runner'
import { PageReviewCoordinator } from '../core/page-review-coordinator'
import { PlanningRunner, planningStepKey } from '../core/planning-runner'
import type {
  AgentRepository,
  ArtifactPort,
  BudgetPort,
  ClockPort,
  DeckReviewPort,
  ImageGenerationPort,
  PresentationRendererPort,
  StructuredModelPort,
  VisualReviewPort,
} from '../core/ports'
import { RunService } from '../core/run-service'
import { SlideGenerationCoordinator } from '../core/slide-generation-coordinator'
import { VisualReviewRunner } from '../core/visual-review-runner'

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
    if (tenantId !== 'frameflow' || !externalUserId || externalUserId.length > 160) return null
    if (externalProjectId && externalProjectId.length > 160) return null
    return { tenantId, externalUserId, ...(externalProjectId ? { externalProjectId } : {}) }
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
        return {
          pageNumber,
          title: pageNumber === 1 ? title : `知识要点 ${pageNumber}`,
          body: [chunk.text.replace(/\s+/g, ' ').slice(0, 300) || `教材要点 ${pageNumber}`],
          layout: pageNumber === 1 ? 'HERO' : pageNumber % 2 === 0 ? 'SPLIT' : 'EDITORIAL',
          visualIntent: `以课堂信息图呈现第 ${pageNumber} 页教材要点`,
          visualPrompt: `A clean educational classroom illustration for lesson page ${pageNumber}, generous text-safe space, no text or symbols`,
          sourceChunkIds: [chunk.id],
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

export function createMockRuntime(input: Readonly<{
  repository: AgentRepository
  artifacts: ArtifactPort
  apiToken: string
  renderer?: PresentationRendererPort
  clock?: ClockPort
}>) {
  const clock = input.clock ?? new SystemClock()
  const documents = new FrameFlowHostAdapter(new MockFrameFlowBackend())
  const budget: BudgetPort = documents
  const images = new LocalMockImageGeneration(input.artifacts)
  const runs = new RunService({ repository: input.repository, clock })
  const planning = new PlanningRunner({
    repository: input.repository,
    documents,
    model: new DeterministicPlanningModel(),
    clock,
  })
  const media = new MediaStepRunner({ repository: input.repository, budget, images, clock })
  const generation = new SlideGenerationCoordinator({ repository: input.repository, media, clock })
  const visual = new VisualReviewRunner({
    repository: input.repository,
    reviewer: new PassingVisualReview(),
    clock,
  })
  const pages = new PageReviewCoordinator({ repository: input.repository, reviewer: visual, clock })
  const deck = new DeckReviewRunner({
    repository: input.repository,
    documents,
    reviewer: new PassingDeckReview(),
    clock,
  })
  const delivery = new DeliveryRunner({
    repository: input.repository,
    artifacts: input.artifacts,
    renderer: input.renderer ?? new SharpPptxPresentationRenderer(),
    clock,
  })

  const tick = async () => {
    for (const run of await input.repository.listRuns()) {
      if (run.status === 'PLANNING') {
        await planning.plan({
          runId: run.id,
          stepId: `step-${run.id}-plan`,
          idempotencyKey: planningStepKey(run.id),
          source: run.source,
          slideCount: run.slideCount,
          visualDirection: run.visualDirection,
        })
      } else if (run.status === 'EXECUTING') {
        await generation.submitBlueprintImages(run.id, 1)
        await generation.refreshBlueprintImages(run.id)
      } else if (run.status === 'PAGE_REVIEW') {
        await pages.reviewAll(run.id)
      } else if (run.status === 'DECK_REVIEW') {
        await deck.review(run.id)
      } else if (run.status === 'DELIVERING') {
        await delivery.deliver(run.id)
      }
    }
  }

  return {
    handler: createHttpHandler({
      runs,
      repository: input.repository,
      artifacts: input.artifacts,
      authentication: new SharedTokenAuthentication(input.apiToken),
    }),
    tick,
  }
}

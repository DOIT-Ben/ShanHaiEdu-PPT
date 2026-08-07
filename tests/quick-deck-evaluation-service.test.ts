import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { LocalArtifactPort } from '../src/adapters/local-artifact-port'
import { SharpPptxPresentationRenderer } from '../src/adapters/presentation-renderer'
import { LocalQuickDeckEvaluationArtifactCleanupPort } from '../src/adapters/quick-deck-evaluation-local-artifact-cleanup'
import { InMemoryQuickDeckEvaluationRepository } from '../src/adapters/quick-deck-evaluation-in-memory-repository'
import type { ImageGenerationPort, StructuredModelPort } from '../src/core/ports'
import { QuickDeckEvaluationError, QuickDeckEvaluationService } from '../src/core/quick-deck-evaluation-service'

const sourceText = '太阳加热水面形成水汽，水汽凝结成云，降水回到地表，构成持续循环。'.repeat(4)

class ControlledClock {
  constructor(private value = new Date('2026-08-07T00:00:00.000Z')) {}
  now() { return new Date(this.value) }
  advance(milliseconds: number) { this.value = new Date(this.value.getTime() + milliseconds) }
}

class CreativeModel implements StructuredModelPort {
  readonly calls: Parameters<StructuredModelPort['execute']>[0][] = []

  async execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    this.calls.push(structuredClone(input))
    const payload = input.payload as {
      frozenConstraints: { slideCount: number }
      trustedEvidence: { sourceChunks: { text: string }[] }
    }
    const excerpt = payload.trustedEvidence.sourceChunks[0]!.text.slice(0, 80)
    return {
      title: '水循环快速评测',
      narrative: ['建立水循环主题', '通过连续视觉解释水循环'],
      slides: Array.from({ length: payload.frozenConstraints.slideCount }, (_, index) => ({
        title: `水循环视觉页 ${index + 1}`,
        narrative: '水在自然环境中持续变化并形成循环。',
        userVisibleCopy: ['水在自然环境中持续变化并形成循环。'],
        factualStatements: [excerpt],
        visualDescription: '以清晰的自然科学场景和箭头展示水循环关系。',
        sourceEvidence: [{ excerpt }],
      })),
    }
  }
}

class AsyncImages implements ImageGenerationPort {
  readonly submissions: Parameters<ImageGenerationPort['submit']>[0][] = []
  readonly inspections: Parameters<ImageGenerationPort['inspect']>[0][] = []
  readonly operations = new Map<string, string>()

  constructor(
    private readonly artifacts: LocalArtifactPort,
    private readonly width = 1600,
    private readonly height = 900,
  ) {}

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    this.submissions.push(structuredClone(input))
    const existing = this.operations.get(input.idempotencyKey)
    if (existing) return { operationId: existing, state: 'QUEUED' as const }
    const bytes = await sharp({
      create: { width: this.width, height: this.height, channels: 3, background: '#2F7D8C' },
    }).png().toBuffer()
    const stored = await this.artifacts.put({
      tenantId: input.tenantId,
      runId: 'quick-deck-evaluation-test',
      name: 'generated.png',
      mimeType: 'image/png',
      bytes,
      idempotencyKey: `${input.idempotencyKey}:test-image`,
    })
    const operationId = `image-operation-${this.operations.size + 1}`
    this.operations.set(input.idempotencyKey, operationId)
    this.operations.set(operationId, stored.artifactId)
    return { operationId, state: 'QUEUED' as const }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    this.inspections.push(structuredClone(input))
    const artifactId = this.operations.get(input.operationId)
    if (!artifactId) throw new Error('TEST_IMAGE_OPERATION_NOT_FOUND')
    return { state: 'COMPLETED' as const, artifactId }
  }
}

class PartialImages extends AsyncImages {
  override async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    if (input.idempotencyKey.includes(':slide:2:')) throw new Error('TEST_SUBMISSION_UNKNOWN')
    return super.submit(input)
  }
}

async function fixture(
  imageSize: Readonly<{ width: number; height: number }> = { width: 1600, height: 900 },
  removeExpiredArtifacts = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-service-'))
  const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
  const repository = new InMemoryQuickDeckEvaluationRepository()
  const clock = new ControlledClock()
  const model = new CreativeModel()
  const images = new AsyncImages(artifacts, imageSize.width, imageSize.height)
  const service = new QuickDeckEvaluationService({
    repository,
    artifacts,
    model,
    images,
    renderer: new SharpPptxPresentationRenderer(),
    clock,
    ...(removeExpiredArtifacts ? {
      artifactCleanup: new LocalQuickDeckEvaluationArtifactCleanupPort(join(directory, 'artifacts')),
    } : {}),
    textModel: 'gpt-5.6-terra',
    allowedImageModels: ['gemini-3-pro-image-preview'],
    maxActiveJobs: 2,
    maxDailyJobs: 3,
    ttlMs: 60_000,
  })
  return { directory, artifacts, repository, clock, model, images, service }
}

function request(slideCount = 2) {
  return {
    schemaVersion: '1',
    source: { kind: 'TEXT', name: 'water-cycle.txt', text: sourceText },
    slideCount,
    visualDirection: '清晰的自然科学信息图',
    imageModel: 'gemini-3-pro-image-preview',
    audience: '小学高年级学生',
  }
}

describe('quick-deck evaluation service', () => {
  test('runs one Responses manuscript call, submits images in parallel, validates pixels, and packages a PPTX', async () => {
    const { directory, artifacts, model, images, service } = await fixture()
    try {
      const first = await service.create('evaluation-tenant', request())
      const second = await service.create('evaluation-tenant', request())
      expect(first.jobId).not.toBe(second.jobId)
      expect(first.status).toBe('QUEUED')

      await service.tick({ limit: 10 })
      expect(model.calls).toHaveLength(2)
      expect(model.calls.every((call) => call.operation === 'create_visual_deck_v4_creative_manuscript'
        && call.structuredGenerationProtocol === 'RESPONSES_JSON_SCHEMA')).toBe(true)
      expect(model.calls.every((call) => !(call.payload as Record<string, unknown>).document)).toBe(true)
      expect(images.submissions).toHaveLength(4)
      expect(images.submissions.every((input) => input.idempotencyKey.startsWith('quick-deck-evaluation:'))).toBe(true)

      await service.tick({ limit: 10 })
      const completed = await service.getOwned('evaluation-tenant', first.jobId)
      expect(completed).toMatchObject({
        status: 'COMPLETED',
        phase: 'COMPLETE',
        models: { text: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        progress: { planned: true, submittedPages: 2, completedPages: 2, totalPages: 2 },
        quality: { state: 'NOT_ASSESSED', score: null, rubric: null },
      })
      expect(completed.pages).toEqual(expect.arrayContaining([
        expect.objectContaining({ width: 1600, height: 900, aspectRatioValidated: true }),
      ]))
      expect(completed.artifacts.pptx?.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(completed.artifacts.preview?.sha256).toMatch(/^[a-f0-9]{64}$/)
      const pptx = await service.getContentOwned('evaluation-tenant', first.jobId, 'pptx')
      expect((await artifacts.get({ tenantId: 'evaluation-tenant', artifactId: pptx.artifactId }))?.bytes.length).toBeGreaterThan(1_000)
      const events = await service.readEventsOwned('evaluation-tenant', first.jobId, 0, 20)
      expect(events.events.map((event) => event.type)).toEqual([
        'evaluation.accepted', 'planning.started', 'planning.completed', 'images.submitted',
        'packaging.started', 'packaging.completed',
      ])
      expect(events.terminalSequence).toBe(6)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('bounds a valid 200,000-character input before the Responses call', async () => {
    const { directory, model, service } = await fixture()
    try {
      const created = await service.create('evaluation-tenant', {
        ...request(1),
        source: { kind: 'TEXT', name: 'large.txt', text: '资料'.repeat(100_000) },
      })
      await service.tick({ limit: 10 })

      expect(created.status).toBe('QUEUED')
      expect(JSON.stringify(model.calls[0]!.payload).length).toBeLessThanOrEqual(220_000)
      expect((model.calls[0]!.payload as Record<string, unknown>).document).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails a quick evaluation when actual image pixels are not 16:9', async () => {
    const { directory, service } = await fixture({ width: 1000, height: 1000 })
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      await expect(service.getContentOwned('evaluation-tenant', created.jobId, 'pptx'))
        .rejects.toMatchObject({ code: 'EVALUATION_CONTENT_NOT_READY' })
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED', phase: 'FAILED', failure: { code: 'EVALUATION_IMAGE_RATIO_INVALID' },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists successful and unknown page submissions before failing a partial batch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-partial-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new InMemoryQuickDeckEvaluationRepository()
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images: new PartialImages(artifacts),
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(2))
      await service.tick({ limit: 10 })
      const stored = await repository.get(created.jobId)

      expect(stored).toMatchObject({ status: 'FAILED', errorCode: 'EVALUATION_IMAGE_SUBMISSION_PARTIAL' })
      expect(stored?.pages).toEqual([
        expect.objectContaining({ submissionState: 'SUBMITTED', operationId: expect.any(String) }),
        expect.objectContaining({ submissionState: 'UNKNOWN', errorCode: 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN' }),
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('expires completed content and rejects image models outside the server whitelist', async () => {
    const { directory, clock, service } = await fixture()
    try {
      await expect(service.create('evaluation-tenant', { ...request(), imageModel: 'gpt-image-2' }))
        .rejects.toEqual(new QuickDeckEvaluationError(422, 'EVALUATION_MODEL_NOT_ALLOWED'))
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      clock.advance(60_001)
      await expect(service.getContentOwned('evaluation-tenant', created.jobId, 'pptx'))
        .rejects.toMatchObject({ status: 410, code: 'EVALUATION_CONTENT_EXPIRED' })
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({ status: 'EXPIRED', phase: 'EXPIRED' })
      await expect(service.getContentOwned('evaluation-tenant', created.jobId, 'pptx'))
        .rejects.toMatchObject({ code: 'EVALUATION_CONTENT_EXPIRED' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('physically removes dedicated page, preview and PPTX artifacts before publishing expiry', async () => {
    const { directory, artifacts, repository, clock, service } = await fixture(undefined, true)
    try {
      const created = await service.create('evaluation-tenant', request(2))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      const stored = await repository.get(created.jobId)
      const artifactIds = [
        ...stored!.pages.flatMap((page) => page.artifactId ? [page.artifactId] : []),
        stored!.pptx!.artifactId,
        stored!.preview!.artifactId,
      ]
      clock.advance(60_001)
      await service.tick({ limit: 10 })

      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({ status: 'EXPIRED' })
      for (const artifactId of artifactIds) {
        expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId })).toBeNull()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { InMemoryQuickDeckEvaluationRepository } from '../src/adapters/quick-deck-evaluation-in-memory-repository'
import { MockArtifactPort } from '../src/adapters/mock-ports'
import type { ImageGenerationPort } from '../src/core/ports'
import type { QuickDeckEvaluationModelEligibilityPort } from '../src/core/quick-deck-evaluation-service'
import { createMockRuntime } from '../src/runtime/mock-runtime'
import { ServiceTokenAuthentication } from '../src/http/service-token-authentication'

const evaluationToken = 'quick-deck-runtime-evaluation-token-0001'
const userToken = 'quick-deck-runtime-v1-token-0001'

class FixedClock {
  now() { return new Date('2026-08-07T00:00:00.000Z') }
}

class CompletedImages implements ImageGenerationPort {
  readonly #operations = new Map<string, string>()

  constructor(private readonly artifacts: MockArtifactPort) {}

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    const existing = this.#operations.get(input.idempotencyKey)
    if (existing) return { operationId: existing, state: 'QUEUED' as const }
    const image = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: '#245f73' },
    }).png().toBuffer()
    const stored = await this.artifacts.put({
      tenantId: input.tenantId,
      runId: 'quick-deck-runtime-test',
      name: 'generated.png',
      mimeType: 'image/png',
      bytes: image,
      idempotencyKey: `${input.idempotencyKey}:generated`,
    })
    const operationId = `quick-runtime-image-${this.#operations.size + 1}`
    this.#operations.set(input.idempotencyKey, operationId)
    this.#operations.set(operationId, stored.artifactId)
    return { operationId, state: 'QUEUED' as const }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    const artifactId = this.#operations.get(input.operationId)
    if (!artifactId) throw new Error('QUICK_DECK_RUNTIME_IMAGE_NOT_FOUND')
    return { state: 'COMPLETED' as const, artifactId }
  }
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${evaluationToken}`)
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

describe('quick-deck evaluation runtime integration', () => {
  test('initializes and advances an isolated evaluation without entering the V1 Run state machine', async () => {
    const ordinaryArtifacts = new MockArtifactPort()
    const evaluationArtifacts = new MockArtifactPort()
    const evaluationRepository = new InMemoryQuickDeckEvaluationRepository()
    const authentication = new ServiceTokenAuthentication([{
      tenantId: 'evaluation-runtime',
      userToken,
      evaluationToken,
    }])
    const runtime = createMockRuntime({
      repository: new InMemoryAgentRepository(),
      artifacts: ordinaryArtifacts,
      apiToken: userToken,
      authentication,
      clock: new FixedClock(),
      quickDeckEvaluation: {
        repository: evaluationRepository,
        artifacts: evaluationArtifacts,
        images: new CompletedImages(evaluationArtifacts),
        authentication,
        textModel: 'gpt-5.6-terra',
        allowedImageModels: ['gemini-3-pro-image-preview'],
        maxActiveJobs: 2,
        maxDailyJobs: 5,
        ttlMs: 60_000,
        tickBatchSize: 10,
      },
    })
    expect(await runtime.initialize()).toEqual({ interruptedQuickDeckEvaluations: 0 })

    const created = await runtime.handler(request('/v1/evaluations/quick-decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: '1',
        source: { kind: 'TEXT', name: 'water-cycle.txt', text: '水汽凝结形成云，降水回到地表，水循环因此持续发生。'.repeat(4) },
        slideCount: 1,
        visualDirection: '清晰的自然科学信息图',
        imageModel: 'gemini-3-pro-image-preview',
      }),
    }))
    const jobId = (await created.json() as { data: { jobId: string } }).data.jobId
    expect(created.status).toBe(201)

    expect(await runtime.tick()).toMatchObject({ scannedRuns: 1, activeRuns: 1 })
    expect(await runtime.tick()).toMatchObject({ scannedRuns: 1, activeRuns: 1 })
    const completed = await runtime.handler(request(`/v1/evaluations/quick-decks/${jobId}`))
    expect(await completed.json()).toMatchObject({
      data: {
        status: 'COMPLETED',
        models: { text: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        pages: [expect.objectContaining({ aspectRatioValidated: true, width: 1600, height: 900 })],
      },
    })
    expect((await evaluationRepository.get(jobId))?.status).toBe('COMPLETED')
  })

  test('does not advertise an evaluator after its current model eligibility has failed', async () => {
    const ordinaryArtifacts = new MockArtifactPort()
    const evaluationArtifacts = new MockArtifactPort()
    const authentication = new ServiceTokenAuthentication([{
      tenantId: 'evaluation-runtime',
      userToken,
      evaluationToken,
    }])
    const modelEligibility: QuickDeckEvaluationModelEligibilityPort = {
      async check() { return 'NOT_READY' },
    }
    const runtime = createMockRuntime({
      repository: new InMemoryAgentRepository(),
      artifacts: ordinaryArtifacts,
      apiToken: userToken,
      authentication,
      clock: new FixedClock(),
      quickDeckEvaluation: {
        repository: new InMemoryQuickDeckEvaluationRepository(),
        artifacts: evaluationArtifacts,
        images: new CompletedImages(evaluationArtifacts),
        authentication,
        textModel: 'gpt-5.6-terra',
        allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility,
        maxActiveJobs: 2,
        maxDailyJobs: 5,
        ttlMs: 60_000,
        tickBatchSize: 10,
      },
    })

    const capabilities = await runtime.handler(new Request('http://ppt-agent.test/v1/capabilities', {
      headers: {
        Authorization: `Bearer ${userToken}`,
        'X-PPT-Agent-Tenant': 'evaluation-runtime',
        'X-PPT-Agent-User': 'evaluation-user',
      },
    }))
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toMatchObject({
      data: { quickDeckEvaluation: { available: false } },
    })
    const created = await runtime.handler(request('/v1/evaluations/quick-decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: '1',
        source: { kind: 'TEXT', name: 'water-cycle.txt', text: '水汽凝结形成云，降水回到地表，水循环因此持续发生。'.repeat(4) },
        slideCount: 1,
        visualDirection: '清晰的自然科学信息图',
        imageModel: 'gemini-3-pro-image-preview',
      }),
    }))
    expect(created.status).toBe(422)
    expect(await created.json()).toMatchObject({ error: { code: 'EVALUATION_MODEL_NOT_ALLOWED' } })
  })
})

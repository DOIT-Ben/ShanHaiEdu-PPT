import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { InMemoryQuickDeckEvaluationRepository } from '../src/adapters/quick-deck-evaluation-in-memory-repository'
import { MockArtifactPort } from '../src/adapters/mock-ports'
import { SharpPptxPresentationRenderer } from '../src/adapters/presentation-renderer'
import type { ImageGenerationPort, StructuredModelPort } from '../src/core/ports'
import { QuickDeckEvaluationService } from '../src/core/quick-deck-evaluation-service'
import { RunService } from '../src/core/run-service'
import { createHttpHandler, type HostAuthenticationPort } from '../src/http/handler'
import {
  createQuickDeckEvaluationHttpHandler,
  type QuickDeckEvaluationEventBrokerPort,
} from '../src/http/quick-deck-evaluation-handler'
import { ServiceTokenAuthentication } from '../src/http/service-token-authentication'
import { RuntimeHealthMonitor } from '../src/observability/runtime-health'

const evaluationToken = 'quick-deck-evaluation-token-0001'
const secondEvaluationToken = 'quick-deck-evaluation-token-0002'
const userToken = 'ordinary-v1-token-must-not-access-0001'
const v2Token = 'presentation-job-v2-token-must-not-access-0001'
const sourceText = '水汽凝结形成云，降水回到地表，水循环因此持续发生。'.repeat(4)

class FixedClock {
  now() { return new Date('2026-08-07T00:00:00.000Z') }
}

class CreativeModel implements StructuredModelPort {
  async execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    const payload = input.payload as {
      frozenConstraints: { slideCount: number }
      trustedEvidence: { sourceChunks: { text: string }[] }
    }
    const excerpt = payload.trustedEvidence.sourceChunks[0]!.text.slice(0, 80)
    return {
      title: '水循环快速评测',
      narrative: ['建立主题', '解释循环'],
      slides: Array.from({ length: payload.frozenConstraints.slideCount }, (_, index) => ({
        title: `水循环 ${index + 1}`,
        narrative: '水在自然环境中持续变化并形成循环。',
        userVisibleCopy: ['水在自然环境中持续变化并形成循环。'],
        factualStatements: [excerpt],
        visualDescription: '以简洁的自然科学关系图说明水循环。',
        sourceEvidence: [{ excerpt }],
      })),
    }
  }
}

class AsyncImages implements ImageGenerationPort {
  readonly #operations = new Map<string, string>()

  constructor(private readonly artifacts: MockArtifactPort) {}

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    const existing = this.#operations.get(input.idempotencyKey)
    if (existing) return { operationId: existing, state: 'QUEUED' as const }
    const image = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: '#2f7d8c' },
    }).png().toBuffer()
    const stored = await this.artifacts.put({
      tenantId: input.tenantId,
      runId: 'quick-deck-evaluation-test',
      name: 'generated.png',
      mimeType: 'image/png',
      bytes: image,
      idempotencyKey: `${input.idempotencyKey}:test-image`,
    })
    const operationId = `quick-image-operation-${this.#operations.size + 1}`
    this.#operations.set(input.idempotencyKey, operationId)
    this.#operations.set(operationId, stored.artifactId)
    return { operationId, state: 'QUEUED' as const }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    const artifactId = this.#operations.get(input.operationId)
    if (!artifactId) throw new Error('QUICK_DECK_TEST_OPERATION_NOT_FOUND')
    return { state: 'COMPLETED' as const, artifactId }
  }
}

function fixture(input: Readonly<{ eventBroker?: QuickDeckEvaluationEventBrokerPort }> = {}) {
  const artifacts = new MockArtifactPort()
  const repository = new InMemoryQuickDeckEvaluationRepository()
  const service = new QuickDeckEvaluationService({
    repository,
    artifacts,
    model: new CreativeModel(),
    images: new AsyncImages(artifacts),
    renderer: new SharpPptxPresentationRenderer(),
    clock: new FixedClock(),
    textModel: 'gpt-5.6-terra',
    allowedImageModels: ['gemini-3-pro-image-preview'],
    maxActiveJobs: 5,
    maxDailyJobs: 10,
    ttlMs: 60_000,
  })
  const authentication = new ServiceTokenAuthentication([
    {
      tenantId: 'evaluation-a',
      userToken,
      v2Token,
      evaluationToken,
    },
    {
      tenantId: 'evaluation-b',
      userToken: 'ordinary-v1-token-for-second-tenant-0001',
      evaluationToken: secondEvaluationToken,
    },
  ])
  return {
    service,
    repository,
    artifacts,
    authentication,
    handle: createQuickDeckEvaluationHttpHandler({
      service, artifacts, repository, authentication, eventPollMs: 5,
      ...(input.eventBroker ? { eventBroker: input.eventBroker } : {}),
    }),
  }
}

function body(slideCount = 1) {
  return {
    schemaVersion: '1',
    source: { kind: 'TEXT', name: 'water-cycle.txt', text: sourceText },
    slideCount,
    visualDirection: '清晰的自然科学信息图',
    imageModel: 'gemini-3-pro-image-preview',
    audience: '小学高年级学生',
  }
}

function request(path: string, init: RequestInit = {}, token = evaluationToken) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

describe('quick-deck evaluation HTTP facade', () => {
  test('is dispatched before ordinary V1 host authentication and preserves the supplied request id', async () => {
    const { service, repository, artifacts, authentication } = fixture()
    const ordinaryRepository = new InMemoryAgentRepository()
    const ordinaryArtifacts = new MockArtifactPort()
    const ordinaryAuthentication: HostAuthenticationPort = {
      async authenticate(): Promise<never> { throw new Error('ORDINARY_V1_AUTHENTICATION_MUST_NOT_RUN') },
    }
    const handle = createHttpHandler({
      runs: new RunService({ repository: ordinaryRepository, artifacts: ordinaryArtifacts, clock: new FixedClock() }),
      repository: ordinaryRepository,
      artifacts: ordinaryArtifacts,
      authentication: ordinaryAuthentication,
      health: new RuntimeHealthMonitor(new FixedClock(), { version: 'test' }),
      quickDeckEvaluation: { service, artifacts, repository, authentication, eventPollMs: 5 },
    })

    const response = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'quick-deck-router-test' },
      body: JSON.stringify(body()),
    }))
    const payload = await response.json() as { requestId: string }
    expect(response.status).toBe(201)
    expect(payload.requestId).toBe('quick-deck-router-test')
    expect(response.headers.get('X-Request-ID')).toBe('quick-deck-router-test')
  })

  test('sets X-Request-ID on direct facade success and authentication failures', async () => {
    const { handle } = fixture()
    const rejected = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'quick-direct-unauthenticated' },
      body: JSON.stringify(body()),
    }, userToken))
    expect(rejected.status).toBe(401)
    expect(rejected.headers.get('X-Request-ID')).toBe('quick-direct-unauthenticated')

    const accepted = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'quick-direct-created' },
      body: JSON.stringify(body()),
    }))
    expect(accepted.status).toBe(201)
    expect(accepted.headers.get('X-Request-ID')).toBe('quick-direct-created')
  })

  test('uses a dedicated evaluator credential and treats every create as a separate experiment', async () => {
    const { handle } = fixture()
    const create = (token = evaluationToken) => handle(request('/v1/evaluations/quick-decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'caller-retry-key' },
      body: JSON.stringify(body()),
    }, token))

    expect((await create(userToken)).status).toBe(401)
    expect((await create(v2Token)).status).toBe(401)
    expect((await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PPT-Agent-Tenant': 'evaluation-b' },
      body: JSON.stringify(body()),
    }))).status).toBe(400)

    const first = await create()
    const second = await create()
    const firstBody = await first.json() as { requestId: string; data: { jobId: string; status: string } }
    const secondBody = await second.json() as { data: { jobId: string } }
    expect(first.status).toBe(201)
    expect(firstBody).toMatchObject({ data: { status: 'QUEUED' } })
    expect(firstBody.data.jobId).not.toBe(secondBody.data.jobId)
    expect(firstBody.requestId).toHaveLength(36)
    expect((await handle(request(`/v1/evaluations/quick-decks/${firstBody.data.jobId}`, {}, secondEvaluationToken))).status).toBe(404)
  })

  test('rejects an oversized streaming evaluation request before JSON parsing', async () => {
    const { handle } = fixture()
    const response = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { text: 'x'.repeat(1_048_577) } }),
    }))

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: 'EVALUATION_REQUEST_TOO_LARGE', category: 'REQUEST', retryable: false, action: 'NONE' },
    })

    const nullBody = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null',
    }))
    expect(nullBody.status).toBe(400)
  })

  test('streams ordered events and serves a verified completed PPTX without buffering', async () => {
    const { handle, service } = fixture()
    const created = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'quick-deck-http-test' },
      body: JSON.stringify(body(2)),
    }))
    const jobId = (await created.json() as { data: { jobId: string } }).data.jobId

    const events = await handle(request(`/v1/evaluations/quick-decks/${jobId}/events`))
    expect(events.status).toBe(200)
    expect(events.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
    const reader = events.body!.getReader()
    const firstEvent = await reader.read()
    expect(new TextDecoder().decode(firstEvent.value)).toContain('event: evaluation.accepted')
    await reader.cancel()
    expect((await handle(request(`/v1/evaluations/quick-decks/${jobId}/events?after=-1`))).status).toBe(422)

    await service.tick({ limit: 10 })
    await service.tick({ limit: 10 })
    const completed = await handle(request(`/v1/evaluations/quick-decks/${jobId}`))
    expect(await completed.json()).toMatchObject({
      requestId: expect.any(String),
      data: { status: 'COMPLETED', progress: { completedPages: 2, totalPages: 2 } },
    })

    const content = await handle(request(`/v1/evaluations/quick-decks/${jobId}/content`))
    const ranged = await handle(request(`/v1/evaluations/quick-decks/${jobId}/content`, { headers: { Range: 'bytes=0-1' } }))
    expect(content.status).toBe(200)
    expect(content.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(content.headers.get('Content-Length')).toMatch(/^\d+$/)
    expect(content.headers.get('ETag')).toMatch(/^"[a-f0-9]{64}"$/)
    expect(content.headers.get('X-PPT-Agent-Content-SHA256')).toMatch(/^[a-f0-9]{64}$/)
    expect((await content.arrayBuffer()).byteLength).toBe(Number(content.headers.get('Content-Length')))
    expect(ranged.status).toBe(416)
    expect(ranged.headers.get('Content-Range')).toContain('bytes */')
  })

  test('returns evaluator-scoped, redacted page evidence without exposing source or provider configuration', async () => {
    const { handle, service, repository } = fixture()
    const created = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(1)),
    }))
    const jobId = (await created.json() as { data: { jobId: string } }).data.jobId
    await service.tick({ limit: 10 })
    await service.tick({ limit: 10 })
    const persisted = await repository.get(jobId)
    expect(persisted).not.toBeNull()
    expect(persisted?.evidenceContext).toMatchObject({ runtimeMode: 'MOCK' })
    await repository.save({
      record: {
        ...persisted!,
        evidenceContext: {
          runtimeMode: 'GATEWAY',
          softwareVersion: '4.4.0-test',
          gitSha: 'test-git-sha',
          releaseId: 'test-release',
          startedAt: '2026-08-07T00:00:00.000Z',
        },
        pages: persisted!.pages.map((page) => ({
          ...page,
          aspectDiagnostics: null,
          errorCode: 'UPSTREAM_PRIVATE_DETAIL',
        })),
      },
    })

    const job = await handle(request(`/v1/evaluations/quick-decks/${jobId}`))
    expect(job.status).toBe(200)
    const jobPayload = await job.json() as { data: { pages: { errorCode: string | null }[] } }
    expect(jobPayload.data.pages[0]?.errorCode).toBe('EVALUATION_PROVIDER_ERROR')

    const evidence = await handle(request(`/v1/evaluations/quick-decks/${jobId}/evidence`))
    expect(evidence.status).toBe(200)
    const payload = await evidence.json() as { data: Record<string, unknown> }
    expect(payload.data).toMatchObject({
      jobId,
      runtime: { runtimeMode: 'GATEWAY', softwareVersion: '4.4.0-test', gitSha: 'test-git-sha', releaseId: 'test-release' },
      models: { text: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
    })
    const pages = payload.data.pages as Record<string, unknown>[]
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({
      pageNumber: 1,
      providerRequestId: null,
      errorCode: 'EVALUATION_PROVIDER_ERROR',
      aspect: {
        normalization: 'UNKNOWN',
        normalizedWidth: null,
        normalizedHeight: null,
      },
      evidenceCompleteness: 'PARTIAL',
    })
    expect(pages[0]?.agentRequestId).toMatch(/^[a-f0-9]{64}$/)
    expect(pages[0]?.gatewayOperationId).toMatch(/^[a-f0-9]{64}$/)
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(sourceText)
    expect(serialized).not.toContain('visualPrompt')
    expect(serialized).not.toContain('gateway-image')
    expect((await handle(request(`/v1/evaluations/quick-decks/${jobId}/evidence`, {}, secondEvaluationToken))).status).toBe(404)
  })

  test('disposes a delayed SSE subscription when the request is aborted during subscribe', async () => {
    const { handle, repository } = fixture()
    const created = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
    }))
    const jobId = (await created.json() as { data: { jobId: string } }).data.jobId
    const originalRead = repository.readEvents.bind(repository)
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const blocker = new Promise<void>((resolve) => { release = resolve })
    let reads = 0
    repository.readEvents = async (input) => {
      reads += 1
      started()
      await blocker
      return originalRead(input)
    }
    const abort = new AbortController()
    const responsePromise = handle(request(`/v1/evaluations/quick-decks/${jobId}/events`, { signal: abort.signal }))
    await startedPromise
    abort.abort()
    release()
    const response = await responsePromise
    await response.body?.cancel()
    await Bun.sleep(20)

    expect(reads).toBe(1)
  })

  test('drains a disposer returned after SSE abort closes the stream', async () => {
    let release!: () => void
    let subscribed!: () => void
    const subscribedPromise = new Promise<void>((resolve) => { subscribed = resolve })
    const blocker = new Promise<void>((resolve) => { release = resolve })
    let disposeCalls = 0
    const broker: QuickDeckEvaluationEventBrokerPort = {
      async subscribe() {
        subscribed()
        await blocker
        return () => { disposeCalls += 1 }
      },
    }
    const { handle } = fixture({ eventBroker: broker })
    const created = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
    }))
    const jobId = (await created.json() as { data: { jobId: string } }).data.jobId
    const abort = new AbortController()
    const responsePromise = handle(request(`/v1/evaluations/quick-decks/${jobId}/events`, { signal: abort.signal }))

    await subscribedPromise
    abort.abort()
    release()
    const response = await responsePromise
    await response.body?.cancel()

    expect(disposeCalls).toBe(1)
  })

  test('releases the SSE heartbeat and abort listener when initial subscription fails', async () => {
    const { handle, repository } = fixture()
    const created = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
    }))
    const jobId = (await created.json() as { data: { jobId: string } }).data.jobId
    const originalRead = repository.readEvents.bind(repository)
    repository.readEvents = async () => {
      throw new Error('QUICK_DECK_EVENT_SUBSCRIPTION_FAILED')
    }
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const timer = {} as ReturnType<typeof setInterval>
    let clearCalls = 0
    globalThis.setInterval = ((callback: () => void) => {
      void callback
      return timer
    }) as typeof setInterval
    globalThis.clearInterval = ((value: ReturnType<typeof setInterval>) => {
      if (value === timer) clearCalls += 1
    }) as typeof clearInterval
    try {
      const abort = new AbortController()
      const response = await handle(request(`/v1/evaluations/quick-decks/${jobId}/events`, { signal: abort.signal }))
      const reader = response.body!.getReader()

      await reader.read().catch(() => undefined)
      expect(clearCalls).toBe(1)

      abort.abort()
      expect(clearCalls).toBe(1)
    } finally {
      repository.readEvents = originalRead
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })

  test('does not enqueue a heartbeat while the Quick-deck SSE queue is full', async () => {
    const { handle, repository } = fixture()
    const created = await handle(request('/v1/evaluations/quick-decks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
    }))
    const jobId = (await created.json() as { data: { jobId: string } }).data.jobId
    const record = await repository.get(jobId)
    if (!record) throw new Error('QUICK_DECK_TEST_RECORD_MISSING')
    for (let index = 2; index <= 100; index += 1) {
      await repository.save({
        record,
        event: {
          schemaVersion: '1', jobId, eventId: `quick-deck-sse-buffer-${index}`,
          type: 'planning.started', payload: {}, occurredAt: '2026-08-07T00:00:00.000Z',
        },
      })
    }
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const timer = {} as ReturnType<typeof setInterval>
    const heartbeat = { callback: null as (() => void) | null }
    globalThis.setInterval = ((callback: () => void) => {
      heartbeat.callback = callback
      return timer
    }) as typeof setInterval
    globalThis.clearInterval = ((value: ReturnType<typeof setInterval>) => {
      void value
    }) as typeof clearInterval
    try {
      const response = await handle(request(`/v1/evaluations/quick-decks/${jobId}/events`))
      const reader = response.body!.getReader()
      await Bun.sleep(25)
      if (!heartbeat.callback) throw new Error('QUICK_DECK_SSE_HEARTBEAT_NOT_STARTED')
      heartbeat.callback()

      for (let index = 0; index < 100; index += 1) {
        expect((await reader.read()).done).toBe(false)
      }
      const next = reader.read()
      try {
        expect(await Promise.race([
          next.then(() => 'chunk' as const, () => 'error' as const),
          Bun.sleep(25).then(() => 'timeout' as const),
        ])).toBe('timeout')
      } finally {
        await reader.cancel()
        await next.catch(() => undefined)
      }
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })
})

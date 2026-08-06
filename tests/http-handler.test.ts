import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION, type HostContext } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockArtifactPort, MockBudgetPort, MockImageGenerationPort } from '../src/adapters/mock-ports'
import { AdminOperationsService } from '../src/core/admin-operations'
import { AdminRevisionRoundsSettingsService } from '../src/core/admin-revision-rounds-settings'
import { MediaStepRunner } from '../src/core/media-step-runner'
import { RunService } from '../src/core/run-service'
import { planningStepKey } from '../src/core/planning-runner'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { enqueueUsageV2RunFinalization } from '../src/core/usage-v2-coordinator'
import { createHttpHandler, type HostAuthenticationPort } from '../src/http/handler'
import { InMemoryPrincipalRateLimiter } from '../src/http/principal-rate-limiter'
import { RuntimeHealthMonitor } from '../src/observability/runtime-health'

const host = { tenantId: 'frameflow', externalUserId: 'user-1' }
const createBody = {
  schemaVersion: CONTRACT_VERSION,
  host,
  source: { kind: 'TEXT', name: '教材.txt', text: '这是用于 HTTP 合同测试的完整教材内容。'.repeat(5) },
  slideCount: 2,
  visualDirection: '清晰的课堂信息图风格',
  imageModel: 'gpt-image-2',
  automationLevel: 'SUPERVISED',
  budgetUnits: 100,
} as const

class HeaderAuthentication implements HostAuthenticationPort {
  async authenticate(request: Request): Promise<HostContext | null> {
    const tenantId = request.headers.get('X-Test-Tenant')
    const externalUserId = request.headers.get('X-Test-User')
    const externalProjectId = request.headers.get('X-Test-Project')
    const role = request.headers.get('X-Test-Role')
    return tenantId && externalUserId
      ? {
          tenantId,
          externalUserId,
          ...(externalProjectId ? { externalProjectId } : {}),
          ...(role === 'ADMIN' ? { role } : {}),
        }
      : null
  }
}

function fixture(rateLimits?: Readonly<{ createRun: number; runAction: number }>) {
  const repository = new InMemoryAgentRepository()
  const clock = new FixedClock()
  const runs = new RunService({ repository, clock })
  const artifacts = new MockArtifactPort()
  const budget = new MockBudgetPort()
  const images = new MockImageGenerationPort()
  const media = new MediaStepRunner({ repository, budget, images, clock })
  const operations = new AdminOperationsService({ repository, budget, media, clock })
  const revisionRoundsSettings = new AdminRevisionRoundsSettingsService({ repository, clock })
  const health = new RuntimeHealthMonitor(clock, { version: 'test' })
  const rateLimiter = rateLimits ? new InMemoryPrincipalRateLimiter({
    createRun: { limit: rateLimits.createRun, windowMs: 60_000 },
    runAction: { limit: rateLimits.runAction, windowMs: 60_000 },
    now: () => clock.now().getTime(),
  }) : undefined
  const handle = createHttpHandler({
    repository,
    artifacts,
    runs,
    authentication: new HeaderAuthentication(),
    health,
    operations,
    revisionRoundsSettings,
    eventPollMs: 10,
    ...(rateLimiter ? { rateLimiter } : {}),
  })
  return { repository, runs, artifacts, budget, images, health, clock, handle }
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('X-Test-Tenant', 'frameflow')
  headers.set('X-Test-User', 'user-1')
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

async function createRun(handle: (request: Request) => Promise<Response>, key = 'http-create-0001') {
  return handle(request('/v1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(createBody),
  }))
}

describe('HTTP v1 handler', () => {
  test('lets administrators configure the default automatic revision rounds for new Runs', async () => {
    const { handle } = fixture()
    const path = '/v1/admin/settings/revision-rounds'
    expect((await handle(request(path))).status).toBe(403)

    const adminHeaders = { 'X-Test-Role': 'ADMIN' }
    const initial = await handle(request(path, { headers: adminHeaders }))
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({
      data: { maxRevisionRounds: 2, version: 0, isConfigured: false, updatedAt: null },
    })

    const updated = await handle(request(path, {
      method: 'PATCH',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxRevisionRounds: 4, expectedVersion: 0 }),
    }))
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ data: { maxRevisionRounds: 4, version: 1, isConfigured: true } })

    const conflict = await handle(request(path, {
      method: 'PATCH',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxRevisionRounds: 1, expectedVersion: 0 }),
    }))
    expect(conflict.status).toBe(409)
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe('SETTINGS_VERSION_CONFLICT')

    const invalid = await handle(request(path, {
      method: 'PATCH',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxRevisionRounds: 5, expectedVersion: 1 }),
    }))
    expect(invalid.status).toBe(422)

    const created = await createRun(handle, 'http-create-settings-default')
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ data: { maxRevisionRounds: 4 } })

    const explicit = await handle(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-create-settings-explicit' },
      body: JSON.stringify({ ...createBody, maxRevisionRounds: 1 }),
    }))
    expect(explicit.status).toBe(201)
    expect(await explicit.json()).toMatchObject({ data: { maxRevisionRounds: 4 } })
  })

  test('exposes liveness, readiness, release identity and OpenAPI discovery without authentication', async () => {
    const { handle, health } = fixture()
    const live = await handle(new Request('http://ppt-agent.test/health/live'))
    const beforeTick = await handle(new Request('http://ppt-agent.test/health/ready'))
    const openapiRequestId = 'openapi-discovery-request'
    const openapi = await handle(new Request('http://ppt-agent.test/openapi/v1.json', {
      headers: { 'X-Request-ID': openapiRequestId },
    }))
    await health.runTick(async () => ({ scannedRuns: 0, activeRuns: 0 }))
    const ready = await handle(new Request('http://ppt-agent.test/health/ready'))

    expect(live.status).toBe(200)
    expect(live.headers.get('X-PPT-Agent-Contract-Version')).toBe(CONTRACT_VERSION)
    expect(live.headers.get('Link')).toContain('</openapi/v1.json>; rel="service-desc"')
    expect(await live.json()).toMatchObject({
      service: 'ppt-agent', status: 'UP', version: 'test',
      release: { softwareVersion: 'test', contractVersion: CONTRACT_VERSION },
    })
    expect(beforeTick.status).toBe(503)
    expect(beforeTick.headers.get('X-PPT-Agent-Contract-Version')).toBe(CONTRACT_VERSION)
    expect(beforeTick.headers.get('Link')).toContain('</openapi/v1.json>; rel="service-desc"')
    expect(await beforeTick.json()).toMatchObject({ status: 'NOT_READY', reason: 'WORKER_NOT_STARTED' })
    expect(ready.status).toBe(200)
    expect(ready.headers.get('X-PPT-Agent-Contract-Version')).toBe(CONTRACT_VERSION)
    expect(await ready.json()).toMatchObject({
      status: 'READY',
      release: { softwareVersion: 'test', contractVersion: CONTRACT_VERSION },
      worker: { tickCount: 1, activeOperationCount: 0 },
    })
    expect(openapi.status).toBe(200)
    expect(openapi.headers.get('Content-Type')).toContain('application/vnd.oai.openapi+json')
    expect(openapi.headers.get('X-PPT-Agent-Contract-Version')).toBe(CONTRACT_VERSION)
    expect(openapi.headers.get('X-Request-ID')).toBe(openapiRequestId)
    expect(await openapi.json()).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'PPT Agent API', version: '4.4.0' },
      paths: {
        '/health/live': { get: { operationId: 'getLiveness' } },
        '/v1/runs/{runId}': { get: { operationId: 'getRun' } },
      },
    })
  })

  test('creates and replays a Run without exposing private source or lease data', async () => {
    const { handle } = fixture()
    const first = await createRun(handle)
    const firstBody = await first.json() as { data: Record<string, unknown>; replayed: boolean }
    const replay = await createRun(handle)

    expect(first.status).toBe(201)
    expect(firstBody.replayed).toBe(false)
    expect(firstBody.data.schemaVersion).toBe(CONTRACT_VERSION)
    expect(firstBody.data.source).toBeUndefined()
    expect(firstBody.data.requestHash).toBeUndefined()
    expect(firstBody.data.leaseToken).toBeUndefined()
    expect(replay.status).toBe(200)
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true)
  })

  test('publishes authenticated capabilities, read-only plan and source states, and server-derived actions', async () => {
    const { handle } = fixture()
    const unauthenticated = await handle(new Request('http://ppt-agent.test/v1/capabilities'))
    const capabilities = await handle(request('/v1/capabilities'))
    const created = await createRun(handle, 'http-query-contracts-0001')
    const runId = (await created.json() as { data: { id: string } }).data.id
    const detail = await handle(request(`/v1/runs/${runId}`))
    const plan = await handle(request(`/v1/runs/${runId}/plan`))
    const sources = await handle(request(`/v1/runs/${runId}/sources`))

    expect(unauthenticated.status).toBe(401)
    expect(capabilities.status).toBe(200)
    expect(capabilities.headers.get('X-PPT-Agent-Contract-Version')).toBe(CONTRACT_VERSION)
    expect(await capabilities.json()).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      requestId: expect.any(String),
      data: {
        visualDeckV4: {
          slideCount: { minimum: 1, maximum: 50 },
          imageGeneration: { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true },
        },
        quickDeckEvaluation: { available: false, isolatedFromRuns: true },
      },
    })
    expect(await detail.json()).toMatchObject({
      data: { blueprint: null, allowedActions: [{ type: 'CANCEL', expectedVersion: 0 }, { type: 'ADD_BUDGET', expectedVersion: 0 }] },
    })
    expect(await plan.json()).toMatchObject({ data: { state: 'NOT_READY', reason: 'V4_REQUIRED' } })
    expect(await sources.json()).toMatchObject({ data: { state: 'NOT_READY', reason: 'BLUEPRINT_NOT_READY' } })
  })

  test('projects a ready one-page V4 plan and sources without exposing its worker prompt', async () => {
    const { handle, repository } = fixture()
    const source = {
      kind: 'TEXT' as const,
      name: '水循环教材.txt',
      text: '太阳加热水面形成水汽，水汽凝结成云，降水回到地表，构成持续循环。'.repeat(4),
    }
    const visualDeckV4 = {
      instruction: '制作一张解释水循环核心关系的视觉演示页',
      sourceMode: 'SOURCE_GROUNDED' as const,
      deckOptions: {
        deckType: 'PRESENTER_SLIDES' as const, language: 'zh-CN', length: { slideCount: 1 }, aspectRatio: '16:9' as const,
        audience: '小学高年级学生', focus: '水循环的核心关系', styleHint: '清晰的自然科学信息图',
      },
    }
    const created = await handle(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-v4-query-contracts-0001' },
      body: JSON.stringify({
        ...createBody,
        source,
        slideCount: 1,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4,
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id
    const blueprint = createVisualDeckV4Blueprint({
      runId,
      inputHash: 'v4-query-contracts',
      source,
      document: {
        name: source.name,
        sources: [{ id: 'source-water-cycle', name: source.name, kind: 'TEXT', status: 'READY' }],
        chunks: [{ id: 'chunk-water-cycle', sourceId: 'source-water-cycle', text: source.text, sha256: 'a'.repeat(64) }],
        isComplete: true,
        missingRanges: [],
      },
      config: visualDeckV4,
      slideCount: 1,
      visualDirection: createBody.visualDirection,
      createdAt: '2026-08-07T00:00:00.000Z',
    })
    await repository.transact(runId, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'AWAITING_BLUEPRINT_APPROVAL' })
      transaction.putStep({
        id: 'step-v4-query-blueprint', runId, idempotencyKey: planningStepKey(runId), inputHash: 'v4-query-contracts',
        tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null, output: blueprint,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    const detail = await handle(request(`/v1/runs/${runId}`))
    const plan = await handle(request(`/v1/runs/${runId}/plan`))
    const sources = await handle(request(`/v1/runs/${runId}/sources`))
    const detailBody = await detail.json() as { data: { blueprint: unknown; allowedActions: { type: string }[] } }

    expect(detail.status).toBe(200)
    expect(detailBody.data.allowedActions.map((action) => action.type)).toEqual(expect.arrayContaining([
      'APPROVE_BLUEPRINT', 'REQUEST_BLUEPRINT_REVISION', 'CANCEL', 'ADD_BUDGET',
    ]))
    expect(JSON.stringify(detailBody.data.blueprint)).not.toContain('visualPrompt')
    expect(JSON.stringify(detailBody.data.blueprint)).not.toContain('negativePrompt')
    expect(await plan.json()).toMatchObject({
      data: { state: 'AVAILABLE', plan: { slideCount: 1, aspectRatio: '16:9', pages: [{ pageNumber: 1 }] } },
    })
    expect(await sources.json()).toMatchObject({
      data: {
        state: 'AVAILABLE',
        sources: [{ id: 'source-water-cycle', name: '水循环教材.txt' }],
        pageReferences: [{ pageNumber: 1, sourceChunkIds: ['chunk-water-cycle'] }],
      },
    })

    await repository.transact(runId, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: 7 })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'issue-v4-knowledge', category: 'FACTUAL_RISK', severity: 'CRITICAL',
          summary: '知识事实需要管理员确认。', slideIds: [`${runId}:slide:1`], sourceChunkIds: ['chunk-water-cycle'],
          status: 'OPEN', repairDomain: 'KNOWLEDGE',
        },
      })
    })
    const userDetail = await handle(request(`/v1/runs/${runId}`))
    const administratorDetail = await handle(request(`/v1/runs/${runId}`, { headers: { 'X-Test-Role': 'ADMIN' } }))
    const userActions = (await userDetail.json() as { data: { allowedActions: { type: string }[] } }).data.allowedActions
    const administratorActions = (await administratorDetail.json() as {
      data: { allowedActions: { type: string; expectedVersion: number }[] }
    }).data.allowedActions

    expect(userActions.map((action) => action.type)).not.toContain('ACCEPT_WITH_OVERRIDE')
    expect(administratorActions).toContainEqual({ type: 'ACCEPT_WITH_OVERRIDE', expectedVersion: 7 })
  })

  test('normalizes pending quality provenance until review finishes', async () => {
    const { handle, repository } = fixture()
    const created = await createRun(handle, 'http-create-pending-quality-policy')
    const runId = (await created.json() as { data: { id: string } }).data.id
    await repository.transact(runId, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        status: 'DECK_REVIEW',
        presentationMode: 'VISUAL_DECK_V4',
        release: {
          ...transaction.run.release!,
          presentationMode: 'VISUAL_DECK_V4',
          compilerVersion: 'visual-deck-v4-chain-3',
        },
        automationLevel: 'BOUNDED_AUTO',
        qualityOverride: true,
        qualityDisposition: 'PENDING',
        qualityPolicyAudit: {
          provenance: 'SYSTEM_POLICY',
          policyId: 'v4-non-blocking-quality-v1',
          reason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
          issueIds: ['legacy-quality-issue'],
          acceptedAt: '2026-07-21T00:00:00.000Z',
        },
      })
    })

    const response = await handle(request(`/v1/runs/${runId}`))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: {
        qualityOverride: false,
        qualityDisposition: 'PENDING',
        qualityPolicyAudit: null,
        qualityOverrideAudit: null,
      },
    })
  })

  test('projects an ambiguous legacy quality actor as an internal override without rewriting its audit', async () => {
    const { handle, repository } = fixture()
    const created = await createRun(handle, 'http-create-legacy-quality-actor')
    const runId = (await created.json() as { data: { id: string } }).data.id
    await repository.transact(runId, (transaction) => {
      const {
        qualityDisposition: _qualityDisposition,
        qualityPolicyAudit: _qualityPolicyAudit,
        ...legacyRun
      } = transaction.run
      transaction.putRun({
        ...legacyRun,
        status: 'DELIVERING',
        presentationMode: 'VISUAL_DECK_V4',
        release: {
          ...transaction.run.release!,
          presentationMode: 'VISUAL_DECK_V4',
          compilerVersion: 'visual-deck-v4-chain-3',
        },
        automationLevel: 'BOUNDED_AUTO',
        qualityOverride: true,
        qualityOverrideBy: 'ppt-agent-quality-policy',
        qualityOverrideRole: 'ADMIN',
        qualityOverrideReason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
        qualityOverrideIssueIds: ['legacy-quality-issue'],
        qualityOverrideAt: '2026-07-21T00:00:00.000Z',
      })
    })

    const response = await handle(request(`/v1/runs/${runId}`))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: {
        qualityOverride: true,
        qualityDisposition: 'ADMIN_OVERRIDE',
        qualityPolicyAudit: null,
        qualityOverrideAudit: {
          actorId: 'ppt-agent-quality-policy',
          actorRole: 'ADMIN',
          reason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
          issueIds: ['legacy-quality-issue'],
          acceptedAt: '2026-07-21T00:00:00.000Z',
        },
      },
    })
  })

  test('rejects body host spoofing and unauthenticated access', async () => {
    const { handle } = fixture()
    const spoofed = await handle(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-create-0001' },
      body: JSON.stringify({ ...createBody, host: { tenantId: 'frameflow', externalUserId: 'user-2' } }),
    }))
    const unauthenticated = await handle(new Request('http://ppt-agent.test/v1/runs'))
    const roleSpoofed = await handle(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-role-spoof-0001' },
      body: JSON.stringify({ ...createBody, host: { ...host, role: 'ADMIN' } }),
    }))
    const projectSpoofed = await handle(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-project-spoof-0001' },
      body: JSON.stringify({ ...createBody, host: { ...host, externalProjectId: 'project-spoofed' } }),
    }))

    expect(spoofed.status).toBe(403)
    expect((await spoofed.json() as { error: { code: string } }).error.code).toBe('HOST_CONTEXT_MISMATCH')
    expect(roleSpoofed.status).toBe(403)
    expect(projectSpoofed.status).toBe(403)
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      error: { code: 'UNAUTHENTICATED', requestId: expect.any(String) },
    })
  })

  test('persists the authenticated project and role instead of body-supplied identity', async () => {
    const { repository, handle } = fixture()
    const response = await handle(request('/v1/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-authenticated-host-0001',
        'X-Test-Project': 'project-1',
        'X-Test-Role': 'ADMIN',
      },
      body: JSON.stringify(createBody),
    }))
    const runId = (await response.json() as { data: { id: string } }).data.id

    expect(response.status).toBe(201)
    expect((await repository.getRun(runId))?.host).toEqual({
      tenantId: 'frameflow', externalUserId: 'user-1', externalProjectId: 'project-1', role: 'ADMIN',
    })
  })

  test('lists only authenticated host runs with cursor pagination', async () => {
    const { handle } = fixture()
    await createRun(handle, 'http-create-0001')
    await createRun(handle, 'http-create-0002')
    const firstPage = await handle(request('/v1/runs?pageSize=1'))
    const body = await firstPage.json() as { data: unknown[]; pagination: { nextCursor: string | null } }
    const nextCursor = body.pagination.nextCursor

    expect(firstPage.status).toBe(200)
    expect(firstPage.headers.get('X-PPT-Agent-Contract-Version')).toBe(CONTRACT_VERSION)
    expect(firstPage.headers.get('X-Request-ID')).toBeTruthy()
    expect(firstPage.headers.get('Link')).toContain('</openapi/v1.json>; rel="service-desc"')
    expect(body).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      requestId: expect.any(String),
      pagination: { pageSize: 1, nextCursor: expect.any(String) },
    })
    expect(body.data).toHaveLength(1)
    expect(nextCursor).not.toBeNull()
    const secondPage = await handle(request(`/v1/runs?pageSize=1&cursor=${nextCursor}`))
    expect(secondPage.status).toBe(200)
    expect((await secondPage.json() as { data: unknown[] }).data).toHaveLength(1)
  })

  test('requires action idempotency and applies an authenticated action', async () => {
    const { repository, handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    await repository.transact(runId, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'EXECUTING', version: 1 })
    })
    const body = JSON.stringify({ schemaVersion: CONTRACT_VERSION, type: 'PAUSE', expectedVersion: 1 })
    const missingKey = await handle(request(`/v1/runs/${runId}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }))
    const applied = await handle(request(`/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'pause-http-0001' },
      body,
    }))

    expect(missingKey.status).toBe(400)
    expect(applied.status).toBe(200)
    expect(applied.headers.get('X-PPT-Agent-Contract-Version')).toBe(CONTRACT_VERSION)
    expect(applied.headers.get('X-Request-ID')).toBeTruthy()
    expect(applied.headers.get('Link')).toContain('</openapi/v1.json>; rel="service-desc"')
    expect(await applied.json()).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      requestId: expect.any(String),
      data: { status: 'PAUSED' },
    })
  })

  test('does not tell clients to retry an idempotency key bound to another request', async () => {
    const { handle } = fixture()
    expect((await createRun(handle, 'http-idempotency-conflict')).status).toBe(201)
    const conflict = await handle(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-idempotency-conflict' },
      body: JSON.stringify({ ...createBody, visualDirection: '另一套明确不同的课堂视觉方向' }),
    }))

    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: {
        code: 'IDEMPOTENCY_CONFLICT', category: 'CONTRACT', retryable: false,
        action: 'MODIFY_REQUEST',
      },
    })
  })

  test('rate limits run creation and actions with a retry deadline', async () => {
    const { repository, clock, handle } = fixture({ createRun: 1, runAction: 1 })
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    const blockedCreate = await createRun(handle, 'http-create-rate-limited')

    expect(blockedCreate.status).toBe(429)
    expect(blockedCreate.headers.get('Retry-After')).toBe('60')
    expect(await blockedCreate.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 } },
    })

    clock.advance(60_000)
    expect((await createRun(handle, 'http-create-after-window')).status).toBe(201)
    await repository.transact(runId, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'EXECUTING', version: 1 })
    })
    const paused = await handle(request(`/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'pause-rate-limit-0001' },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, type: 'PAUSE', expectedVersion: 1 }),
    }))
    const blockedAction = await handle(request(`/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'resume-rate-limit-0001' },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, type: 'RESUME', expectedVersion: 2 }),
    }))

    expect(paused.status).toBe(200)
    expect(blockedAction.status).toBe(429)
    expect(blockedAction.headers.get('Retry-After')).toBe('60')
  })

  test('replays persisted events as SSE without private Run input', async () => {
    const { handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    const controller = new AbortController()
    const response = await handle(request(`/v1/runs/${runId}/events?after=0`, { signal: controller.signal }))
    const reader = response.body!.getReader()
    const firstChunk = await reader.read()
    const text = new TextDecoder().decode(firstChunk.value)
    await reader.cancel()
    controller.abort()

    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(text).toContain('id: 1')
    expect(text).toContain('event: run.started')
    expect(text).not.toContain(createBody.source.text)
  })

  test('returns bounded persisted event history for reconnect recovery', async () => {
    const { repository, handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    await repository.transact(runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.started',
        payload: { stepId: 'step-history-1', tool: 'source-loader', label: '解析教材' },
      })
    })

    const response = await handle(request(`/v1/runs/${runId}/events/history?after=1`))
    const body = await response.json() as {
      data: Array<{ sequence: number; type: string }>
      pagination: { nextAfter: number; hasMore: boolean }
    }

    expect(response.status).toBe(200)
    expect(body.data).toEqual([expect.objectContaining({ sequence: 2, type: 'tool.started' })])
    expect(body.pagination).toEqual({ nextAfter: 2, hasMore: false })
  })

  test('does not reveal another user event history', async () => {
    const { handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    const response = await handle(new Request(
      `http://ppt-agent.test/v1/runs/${runId}/events/history`,
      { headers: { 'X-Test-Tenant': 'frameflow', 'X-Test-User': 'user-2' } },
    ))

    expect(response.status).toBe(404)
  })

  test('returns 404 instead of revealing another user Run', async () => {
    const { handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    const otherHeaders = { 'X-Test-Tenant': 'frameflow', 'X-Test-User': 'user-2' }
    const response = await handle(new Request(`http://ppt-agent.test/v1/runs/${runId}`, { headers: otherHeaders }))

    expect(response.status).toBe(404)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('RUN_NOT_FOUND')
  })

  test('returns unresolved quality issues in the owned run detail', async () => {
    const { repository, handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    await repository.transact(runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'issue-layout-2', category: 'COMPOSITION_CONFLICT', severity: 'WARNING',
          summary: '第二页素材遮挡了可编辑文字。', slideIds: [`${runId}:slide:2`],
          sourceChunkIds: [], status: 'OPEN', repairDomain: 'LAYOUT',
        },
      })
    })

    const response = await handle(request(`/v1/runs/${runId}`))
    const body = await response.json() as { data: { issues: { id: string; repairDomain?: string }[] } }
    expect(body.data.issues).toEqual([expect.objectContaining({ id: 'issue-layout-2', repairDomain: 'LAYOUT' })])
  })

  test('lets only tenant administrators aggregate redacted planning failures', async () => {
    const { repository, handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    await repository.transact(runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'issue-planning-1', category: 'PLANNING_FAILED', severity: 'CRITICAL',
          summary: '规划模型限流，已完成自动重试。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
          planningFailure: {
            errorCode: 'PROVIDER_RATE_LIMIT', retryable: true, attempt: 3, maxAttempts: 3,
            suggestedAction: 'RETRY', diagnosticCode: 'PROVIDER_RATE_LIMIT', fieldPaths: [],
            correlationId: 'plan-correlation-1', requestId: 'request-safe-1', model: 'gpt-5.6-terra', contractVersion: '1',
          },
        },
      })
    })

    const forbidden = await handle(request('/v1/admin/planning-failures'))
    expect(forbidden.status).toBe(403)
    const invalidFilter = await handle(request('/v1/admin/planning-failures?model=', {
      headers: { 'X-Test-Role': 'ADMIN' },
    }))
    expect(invalidFilter.status).toBe(422)
    const admin = await handle(request('/v1/admin/planning-failures?errorCode=PROVIDER_RATE_LIMIT&model=gpt-5.6-terra', {
      headers: { 'X-Test-Role': 'ADMIN' },
    }))
    const body = await admin.json() as { data: unknown[]; totalFailures: number }
    expect(admin.status).toBe(200)
    expect(body).toEqual({
      data: [{
        errorCode: 'PROVIDER_RATE_LIMIT', model: 'gpt-5.6-terra', contractVersion: '1',
        count: 1, lastOccurredAt: '2026-07-21T00:00:00.000Z',
      }],
      totalFailures: 1,
    })
    expect(JSON.stringify(body)).not.toContain(createBody.source.text)
    expect(JSON.stringify(body)).not.toContain('request-safe-1')
  })

  test('lets only tenant administrators query filtered operations without private Run input', async () => {
    const { repository, handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    await repository.transact(runId, (transaction) => {
      transaction.putStep({
        id: 'step-timeout', runId, idempotencyKey: 'step-timeout-key', inputHash: 'safe-hash',
        tool: 'generate_slide_image', status: 'FAILED', budgetUnits: 1, budgetReservationId: null,
        externalOperationId: null, errorCode: 'PROVIDER_TIMEOUT', output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    expect((await handle(request('/v1/admin/operations'))).status).toBe(403)
    const invalid = await handle(request('/v1/admin/operations?status=UNKNOWN', { headers: { 'X-Test-Role': 'ADMIN' } }))
    expect(invalid.status).toBe(422)
    const response = await handle(request('/v1/admin/operations?externalUserId=user-1&errorCode=PROVIDER_TIMEOUT', {
      headers: { 'X-Test-Role': 'ADMIN' },
    }))
    const body = await response.json() as { data: { runs: Array<Record<string, unknown>>; totalRuns: number } }
    expect(response.status).toBe(200)
    expect(body.data.totalRuns).toBe(1)
    expect(body.data.runs[0]).toMatchObject({ id: runId, externalUserId: 'user-1', lastErrorCode: 'PROVIDER_TIMEOUT' })
    expect(JSON.stringify(body)).not.toContain(createBody.source.text)
  })

  test('applies and replays an audited administrator accounting action', async () => {
    const { repository, budget, handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    await repository.transact(runId, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: 1, committedBudgetUnits: 1 })
      transaction.putStep({
        id: 'step-unknown', runId, idempotencyKey: 'step-unknown-key', inputHash: 'safe-hash',
        tool: 'generate_slide_image', status: 'SUBMISSION_UNKNOWN', budgetUnits: 1,
        budgetReservationId: 'reservation-1', externalOperationId: null,
        errorCode: 'PROVIDER_SUBMISSION_UNKNOWN', output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })
    const action = JSON.stringify({
      stepId: 'step-unknown', action: 'MARK_NOT_CHARGED', expectedVersion: 1,
      reason: '已核对供应商后台，确认没有产生费用。',
    })
    const send = () => handle(request(`/v1/admin/operations/${runId}/actions`, {
      method: 'POST',
      headers: { 'X-Test-Role': 'ADMIN', 'Content-Type': 'application/json', 'Idempotency-Key': 'admin-http-1' },
      body: action,
    }))
    const first = await send()
    const replay = await send()

    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ data: { step: { status: 'FAILED_NOT_CHARGED' } }, replayed: false })
    expect(await replay.json()).toMatchObject({ data: { step: { status: 'FAILED_NOT_CHARGED' } }, replayed: true })
    expect(budget.released).toEqual(new Set(['reservation-1']))
  })

  test('never exposes a non-terminal or unverified delivery as generated content', async () => {
    const { repository, artifacts, handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    const previewBytes = new TextEncoder().encode('preview-bytes')
    const pptxBytes = new TextEncoder().encode('pptx-bytes')
    const sourcesBytes = new TextEncoder().encode('{"assets":[]}')
    const preview = await artifacts.put({
      tenantId: 'frameflow', runId, name: 'preview.png', mimeType: 'image/png',
      bytes: previewBytes, idempotencyKey: `${runId}:preview`,
    })
    const pptx = await artifacts.put({
      tenantId: 'frameflow', runId, name: 'lesson.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: pptxBytes, idempotencyKey: `${runId}:pptx`,
    })
    const sources = await artifacts.put({
      tenantId: 'frameflow', runId, name: 'asset-sources.json', mimeType: 'application/json',
      bytes: sourcesBytes, idempotencyKey: `${runId}:sources`,
    })
    const deliveryId = `${runId}:delivery:r0`
    const contentPath = `/v1/runs/${runId}/deliveries/${encodeURIComponent(deliveryId)}/content?format=pptx`
    const expectPptxUnavailable = async (reason: string) => {
      const response = await handle(request(contentPath))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        schemaVersion: CONTRACT_VERSION,
        error: { code: 'DELIVERY_NOT_AVAILABLE', details: { reason } },
      })
    }
    await repository.transact(runId, (transaction) => {
      transaction.putDelivery({
        id: deliveryId,
        runId,
        revisionRound: 0,
        qualityScore: 88,
        qualityOverride: false,
        preview: {
          artifactId: preview.artifactId, name: 'preview.png', mimeType: 'image/png',
          sha256: preview.sha256, byteLength: previewBytes.length,
        },
        pptx: {
          artifactId: pptx.artifactId, name: 'lesson.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          sha256: pptx.sha256, byteLength: pptxBytes.length,
        },
        sources: {
          artifactId: sources.artifactId, name: 'asset-sources.json', mimeType: 'application/json',
          sha256: sources.sha256, byteLength: sourcesBytes.length,
        },
        createdAt: transaction.run.createdAt,
      })
    })

    const pendingDetail = await handle(request(`/v1/runs/${runId}`))
    expect(await pendingDetail.json()).toMatchObject({
      data: {
        schemaVersion: CONTRACT_VERSION,
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_NOT_COMPLETED' },
      },
    })
    for (const format of ['preview', 'pptx', 'sources']) {
      const unavailable = await handle(request(
        `/v1/runs/${runId}/deliveries/${encodeURIComponent(deliveryId)}/content?format=${format}`,
      ))
      expect(unavailable.status).toBe(409)
      expect(await unavailable.json()).toMatchObject({
        schemaVersion: CONTRACT_VERSION,
        error: {
          code: 'DELIVERY_NOT_AVAILABLE',
          details: { reason: 'RUN_NOT_COMPLETED' },
        },
      })
    }

    await repository.transact(runId, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        status: 'RECOVERING',
        pendingTerminalFailure: {
          errorCode: 'QUALITY_REMEDIATION_EXHAUSTED',
          reason: 'PAGE_REVIEW_REJECTED',
          requestedAt: transaction.run.updatedAt,
        },
        technicalRecovery: {
          resumeState: 'DECK_REVIEW',
          reason: 'QUALITY_ACCOUNTING_PENDING',
          retryable: true,
          attempt: 1,
          maxAttempts: 5,
          nextAttemptAt: transaction.run.updatedAt,
          active: true,
        },
      })
    })
    expect(await (await handle(request(`/v1/runs/${runId}`))).json()).toMatchObject({
      data: {
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'QUALITY_RECOVERY' },
      },
    })
    await expectPptxUnavailable('QUALITY_RECOVERY')

    await repository.transact(runId, (transaction) => {
      const {
        pendingTerminalFailure: _pendingTerminalFailure,
        technicalRecovery: _technicalRecovery,
        ...withoutRecovery
      } = transaction.run
      transaction.putRun({ ...withoutRecovery, status: 'FAILED' })
    })
    expect(await (await handle(request(`/v1/runs/${runId}`))).json()).toMatchObject({
      data: {
        status: 'FAILED',
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_FAILED' },
      },
    })
    await expectPptxUnavailable('RUN_FAILED')

    await repository.transact(runId, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
    })
    expect(await (await handle(request(`/v1/runs/${runId}`))).json()).toMatchObject({
      data: {
        status: 'CANCELLED',
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_CANCELLED' },
      },
    })
    await expectPptxUnavailable('RUN_CANCELLED')

    await repository.transact(runId, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        status: 'COMPLETED',
        qualityDisposition: 'REVIEW_PASSED',
      })
    })
    const completedDetail = await handle(request(`/v1/runs/${runId}`))
    expect(await completedDetail.json()).toMatchObject({
      data: {
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'VERIFIED_FINAL_DELIVERY_MISSING' },
      },
    })
    await expectPptxUnavailable('VERIFIED_FINAL_DELIVERY_MISSING')

    const legacyDelivery = (await repository.listDeliveries(runId))[0]!
    await repository.transact(runId, (transaction) => {
      transaction.putDelivery({
        ...legacyDelivery,
        disposition: 'FINAL',
        identity: {
          status: 'VERIFIED',
          slideCount: 2,
          pageNumbers: [1, 2],
          blueprintHash: 'a'.repeat(64),
        },
      })
    })
    expect(await (await handle(request(`/v1/runs/${runId}`))).json()).toMatchObject({
      data: {
        status: 'COMPLETED',
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'DELIVERY_CONTRACT_INVALID' },
      },
    })
    await expectPptxUnavailable('DELIVERY_CONTRACT_INVALID')

    const otherHeaders = { 'X-Test-Tenant': 'frameflow', 'X-Test-User': 'user-2' }
    const hidden = await handle(new Request(
      `http://ppt-agent.test/v1/runs/${runId}/deliveries/${encodeURIComponent(deliveryId)}/content`,
      { headers: otherHeaders },
    ))
    expect(hidden.status).toBe(404)
  })

  test('publishes WAIT for a completed Usage V2 delivery only with a persisted retry deadline', async () => {
    const { repository, artifacts, clock, handle } = fixture()
    const created = await createRun(handle, 'http-create-accounting-pending-delivery')
    const runId = (await created.json() as { data: { id: string } }).data.id
    const previewBytes = new TextEncoder().encode('verified-preview-bytes')
    const pptxBytes = new TextEncoder().encode('verified-pptx-bytes')
    const preview = await artifacts.put({
      tenantId: 'frameflow', runId, name: 'preview.png', mimeType: 'image/png',
      bytes: previewBytes, idempotencyKey: `${runId}:pending-preview`,
    })
    const pptx = await artifacts.put({
      tenantId: 'frameflow', runId, name: 'lesson.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: pptxBytes, idempotencyKey: `${runId}:pending-pptx`,
    })
    const deliveryId = `${runId}:delivery:r0`
    await repository.transact(runId, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        status: 'COMPLETED',
        accountingProtocol: 'FRAMEFLOW_USAGE_V2',
        presentationMode: 'VISUAL_DECK_V4',
        release: {
          ...transaction.run.release!,
          presentationMode: 'VISUAL_DECK_V4',
          compilerVersion: 'visual-deck-v4-chain-3',
        },
        qualityDisposition: 'REVIEW_PASSED',
      })
      transaction.putDelivery({
        id: deliveryId,
        runId,
        revisionRound: 0,
        qualityScore: 90,
        qualityOverride: false,
        identity: {
          status: 'VERIFIED',
          slideCount: 2,
          pageNumbers: [1, 2],
          blueprintHash: 'a'.repeat(64),
        },
        preview: {
          artifactId: preview.artifactId, name: 'preview.png', mimeType: 'image/png',
          sha256: preview.sha256, byteLength: previewBytes.length,
        },
        pptx: {
          artifactId: pptx.artifactId, name: 'lesson.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          sha256: pptx.sha256, byteLength: pptxBytes.length,
        },
        createdAt: transaction.run.createdAt,
      })
    })

    const unscheduledDetail = await handle(request(`/v1/runs/${runId}`))
    expect(await unscheduledDetail.json()).toMatchObject({
      data: {
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'ACCOUNTING_FAILED' },
      },
    })
    const unscheduledContent = await handle(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(deliveryId)}/content?format=pptx`,
    ))
    expect(unscheduledContent.status).toBe(409)
    expect(await unscheduledContent.json()).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      error: {
        code: 'DELIVERY_NOT_AVAILABLE', retryable: false, action: 'CONTACT_SUPPORT',
        details: { reason: 'ACCOUNTING_FAILED' },
      },
    })

    await repository.transact(runId, (transaction) => {
      const queued = enqueueUsageV2RunFinalization(transaction, clock)!
      transaction.putStep({
        ...queued,
        output: { ...(queued.output as object), nextAttemptAt: clock.now().toISOString() },
      })
    })
    const scheduledDetail = await handle(request(`/v1/runs/${runId}`))
    expect(await scheduledDetail.json()).toMatchObject({
      data: {
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'ACCOUNTING_PENDING' },
      },
    })
    const scheduledContent = await handle(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(deliveryId)}/content?format=pptx`,
    ))
    expect(scheduledContent.status).toBe(409)
    expect(await scheduledContent.json()).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      error: {
        code: 'DELIVERY_NOT_AVAILABLE', retryable: true, action: 'WAIT',
        details: { reason: 'ACCOUNTING_PENDING' },
      },
    })
  })
})

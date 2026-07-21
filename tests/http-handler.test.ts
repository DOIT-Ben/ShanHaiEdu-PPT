import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION, type HostContext } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockArtifactPort } from '../src/adapters/mock-ports'
import { RunService } from '../src/core/run-service'
import { createHttpHandler, type HostAuthenticationPort } from '../src/http/handler'
import { RuntimeHealthMonitor } from '../src/observability/runtime-health'

const host = { tenantId: 'frameflow', externalUserId: 'user-1' }
const createBody = {
  schemaVersion: CONTRACT_VERSION,
  host,
  source: { kind: 'TEXT', name: '教材.txt', text: '这是用于 HTTP 合同测试的完整教材内容。'.repeat(5) },
  slideCount: 2,
  visualDirection: '清晰的课堂信息图风格',
  imageModel: 'image-2',
  automationLevel: 'SUPERVISED',
  budgetUnits: 100,
} as const

class HeaderAuthentication implements HostAuthenticationPort {
  async authenticate(request: Request): Promise<HostContext | null> {
    const tenantId = request.headers.get('X-Test-Tenant')
    const externalUserId = request.headers.get('X-Test-User')
    const role = request.headers.get('X-Test-Role')
    return tenantId && externalUserId
      ? { tenantId, externalUserId, ...(role === 'ADMIN' ? { role } : {}) }
      : null
  }
}

function fixture() {
  const repository = new InMemoryAgentRepository()
  const clock = new FixedClock()
  const runs = new RunService({ repository, clock })
  const artifacts = new MockArtifactPort()
  const health = new RuntimeHealthMonitor(clock, { version: 'test' })
  const handle = createHttpHandler({
    repository,
    artifacts,
    runs,
    authentication: new HeaderAuthentication(),
    health,
    eventPollMs: 10,
  })
  return { repository, runs, artifacts, health, handle }
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
  test('distinguishes HTTP liveness from worker readiness without authentication', async () => {
    const { handle, health } = fixture()
    const live = await handle(new Request('http://ppt-agent.test/health/live'))
    const beforeTick = await handle(new Request('http://ppt-agent.test/health/ready'))
    await health.runTick(async () => ({ scannedRuns: 0, activeRuns: 0 }))
    const ready = await handle(new Request('http://ppt-agent.test/health/ready'))

    expect(live.status).toBe(200)
    expect(await live.json()).toMatchObject({ service: 'ppt-agent', status: 'UP', version: 'test' })
    expect(beforeTick.status).toBe(503)
    expect(await beforeTick.json()).toMatchObject({ status: 'NOT_READY', reason: 'WORKER_NOT_STARTED' })
    expect(ready.status).toBe(200)
    expect(await ready.json()).toMatchObject({ status: 'READY', worker: { tickCount: 1 } })
  })

  test('creates and replays a Run without exposing private source or lease data', async () => {
    const { handle } = fixture()
    const first = await createRun(handle)
    const firstBody = await first.json() as { data: Record<string, unknown>; replayed: boolean }
    const replay = await createRun(handle)

    expect(first.status).toBe(201)
    expect(firstBody.replayed).toBe(false)
    expect(firstBody.data.source).toBeUndefined()
    expect(firstBody.data.requestHash).toBeUndefined()
    expect(firstBody.data.leaseToken).toBeUndefined()
    expect(replay.status).toBe(200)
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true)
  })

  test('rejects body host spoofing and unauthenticated access', async () => {
    const { handle } = fixture()
    const spoofed = await handle(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-create-0001' },
      body: JSON.stringify({ ...createBody, host: { tenantId: 'frameflow', externalUserId: 'user-2' } }),
    }))
    const unauthenticated = await handle(new Request('http://ppt-agent.test/v1/runs'))

    expect(spoofed.status).toBe(403)
    expect((await spoofed.json() as { error: { code: string } }).error.code).toBe('HOST_CONTEXT_MISMATCH')
    expect(unauthenticated.status).toBe(401)
  })

  test('lists only authenticated host runs with cursor pagination', async () => {
    const { handle } = fixture()
    await createRun(handle, 'http-create-0001')
    await createRun(handle, 'http-create-0002')
    const firstPage = await handle(request('/v1/runs?pageSize=1'))
    const body = await firstPage.json() as { data: unknown[]; pagination: { nextCursor: string | null } }

    expect(body.data).toHaveLength(1)
    expect(body.pagination.nextCursor).not.toBeNull()
    const secondPage = await handle(request(`/v1/runs?pageSize=1&cursor=${body.pagination.nextCursor}`))
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
    expect((await applied.json() as { data: { status: string } }).data.status).toBe('PAUSED')
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
            correlationId: 'plan-correlation-1', requestId: 'request-safe-1', model: 'gpt-5.6', contractVersion: '1',
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
    const admin = await handle(request('/v1/admin/planning-failures?errorCode=PROVIDER_RATE_LIMIT&model=gpt-5.6', {
      headers: { 'X-Test-Role': 'ADMIN' },
    }))
    const body = await admin.json() as { data: unknown[]; totalFailures: number }
    expect(admin.status).toBe(200)
    expect(body).toEqual({
      data: [{
        errorCode: 'PROVIDER_RATE_LIMIT', model: 'gpt-5.6', contractVersion: '1',
        count: 1, lastOccurredAt: '2026-07-21T00:00:00.000Z',
      }],
      totalFailures: 1,
    })
    expect(JSON.stringify(body)).not.toContain(createBody.source.text)
    expect(JSON.stringify(body)).not.toContain('request-safe-1')
  })

  test('returns owned delivery metadata and streams only the selected controlled artifact', async () => {
    const { repository, artifacts, handle } = fixture()
    const created = await createRun(handle)
    const runId = (await created.json() as { data: { id: string } }).data.id
    const previewBytes = new TextEncoder().encode('preview-bytes')
    const pptxBytes = new TextEncoder().encode('pptx-bytes')
    const preview = await artifacts.put({
      tenantId: 'frameflow', runId, name: 'preview.png', mimeType: 'image/png',
      bytes: previewBytes, idempotencyKey: `${runId}:preview`,
    })
    const pptx = await artifacts.put({
      tenantId: 'frameflow', runId, name: 'lesson.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: pptxBytes, idempotencyKey: `${runId}:pptx`,
    })
    const deliveryId = `${runId}:delivery:r0`
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
        createdAt: transaction.run.createdAt,
      })
    })

    const detail = await handle(request(`/v1/runs/${runId}`))
    expect((await detail.json() as { data: { deliveries: unknown[] } }).data.deliveries).toHaveLength(1)
    const previewResponse = await handle(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(deliveryId)}/content?format=preview`,
    ))
    expect(previewResponse.status).toBe(200)
    expect(previewResponse.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await previewResponse.arrayBuffer())).toEqual(previewBytes)

    const otherHeaders = { 'X-Test-Tenant': 'frameflow', 'X-Test-User': 'user-2' }
    const hidden = await handle(new Request(
      `http://ppt-agent.test/v1/runs/${runId}/deliveries/${encodeURIComponent(deliveryId)}/content`,
      { headers: otherHeaders },
    ))
    expect(hidden.status).toBe(404)
  })
})

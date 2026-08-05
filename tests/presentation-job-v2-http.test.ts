import { describe, expect, test } from 'bun:test'
import { InMemoryPresentationJobV2Repository } from '../src/adapters/presentation-job-v2-in-memory-repository'
import {
  FixedServicePresentationJobBudgetPolicy,
  MockPresentationJobV2Provider,
} from '../src/adapters/presentation-job-v2-ports'
import { FixedClock, MockArtifactPort } from '../src/adapters/mock-ports'
import { PresentationJobV2Service } from '../src/core/presentation-job-v2-service'
import { createPresentationJobV2HttpHandler } from '../src/http/presentation-job-v2-handler'
import { ServiceTokenAuthentication } from '../src/http/service-token-authentication'
import { approvedPageDesignSnapshotHash } from '../src/presentation-job-v2-contracts'

const tokenA = 'presentation-job-v2-token-host-a-0001'
const tokenB = 'presentation-job-v2-token-host-b-0001'
const snapshot = {
  schemaVersion: '1',
  title: '水的三种状态', subject: '科学', gradeBand: '小学三年级', lessonDurationMinutes: 40,
  audience: '小学三年级学生', objectives: ['区分固态、液态和气态'],
  pages: [
    {
      pageNumber: 1, title: '冰和水', teachingPurpose: '观察固态和液态。', editableCopy: ['冰', '水'],
      layoutIntent: '左右对比。', visualRequirements: ['显示冰块和水滴'], teacherNotes: '提醒学生注意安全。',
      teacherScript: '冰和水有什么不同？', studentActivity: '分类图片。', animationSequence: ['显示冰块', '显示水滴'],
      boardPlan: '板书固态和液态。', evidence: [{ type: 'FACT', text: '冰是固态的水。', source: '科学教材' }],
    },
    {
      pageNumber: 2, title: '水蒸气', teachingPurpose: '认识气态水。', editableCopy: ['水蒸气'],
      layoutIntent: '上升箭头表现蒸发。', visualRequirements: ['显示上升箭头'], teacherNotes: '联系生活现象。',
      teacherScript: '水加热后会变成什么？', studentActivity: '说出一个蒸发现象。', animationSequence: ['显示水面', '显示上升箭头'],
      boardPlan: '画蒸发箭头。', evidence: [{ type: 'FACT', text: '水蒸气是气态的水。', source: '科学教材' }],
    },
  ],
} as const

function createBody() {
  return {
    source: {
      kind: 'APPROVED_PAGE_DESIGN',
      artifactVersionId: 'water-state-v9',
      sha256: approvedPageDesignSnapshotHash(snapshot),
      snapshot,
    },
  }
}

function fixture() {
  const repository = new InMemoryPresentationJobV2Repository()
  const artifacts = new MockArtifactPort()
  const provider = new MockPresentationJobV2Provider()
  const service = new PresentationJobV2Service({
    repository,
    artifacts,
    provider,
    budget: new FixedServicePresentationJobBudgetPolicy(1),
    clock: new FixedClock(),
  })
  return {
    service,
    artifacts,
    provider,
    handle: createPresentationJobV2HttpHandler({
      service,
      artifacts,
      authentication: new ServiceTokenAuthentication([
        { tenantId: 'host-a', userToken: tokenA },
        { tenantId: 'host-b', userToken: tokenB },
      ]),
    }),
  }
}

function request(path: string, init: RequestInit = {}, identity = { user: 'user-a', project: 'project-a', token: tokenA }) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${identity.token}`)
  headers.set('X-PPT-Agent-User', identity.user)
  if (identity.project) headers.set('X-PPT-Agent-Project', identity.project)
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

describe('Presentation Job V2 HTTP facade', () => {
  test('enforces service-bound tenant identity, strict idempotency and owner-scoped reads', async () => {
    const { handle } = fixture()
    const create = () => handle(request('/v2/presentation-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-v2-job-key' },
      body: JSON.stringify(createBody()),
    }))
    const first = await create()
    const firstBody = await first.json() as { data: { jobId: string; source?: unknown }; replayed: boolean }
    const replay = await create()
    const jobId = firstBody.data.jobId

    expect(first.status).toBe(201)
    expect(firstBody).toMatchObject({ replayed: false, data: { status: 'QUEUED', contractVersion: '2.0' } })
    expect(firstBody.data.source).toBeUndefined()
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ replayed: true, data: { jobId } })

    const initialBody = createBody()
    const conflictSnapshot = { ...initialBody.source.snapshot, title: '冲突的规范化请求' }
    const conflictBody = {
      source: {
        ...initialBody.source,
        snapshot: conflictSnapshot,
        sha256: approvedPageDesignSnapshotHash(conflictSnapshot),
      },
    }
    const conflict = await handle(request('/v2/presentation-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-v2-job-key' },
      body: JSON.stringify(conflictBody),
    }))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'PRESENTATION_JOB_IDEMPOTENCY_CONFLICT', retryable: false } })

    const invalidBody = structuredClone(createBody())
    invalidBody.source.sha256 = '0'.repeat(64)
    const invalid = await handle(request('/v2/presentation-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-v2-invalid-hash' },
      body: JSON.stringify(invalidBody),
    }))
    expect(invalid.status).toBe(422)

    const otherOwner = await handle(request('/v2/presentation-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-v2-job-key' },
      body: JSON.stringify(createBody()),
    }, { user: 'user-b', project: 'project-a', token: tokenA }))
    expect(otherOwner.status).toBe(201)

    const override = await handle(request(`/v2/presentation-jobs/${jobId}`, {
      headers: { 'X-PPT-Agent-Tenant': 'host-b' },
    }))
    expect(override.status).toBe(400)
    expect((await handle(request(`/v2/presentation-jobs/${jobId}`, {}, { user: 'user-b', project: 'project-a', token: tokenA }))).status).toBe(404)
    expect((await handle(request(`/v2/presentation-jobs/${jobId}`, {}, { user: 'user-a', project: 'project-b', token: tokenA }))).status).toBe(404)
    expect((await handle(request(`/v2/presentation-jobs/${jobId}`, {}, { user: 'user-a', project: 'project-a', token: tokenB }))).status).toBe(404)
  })

  test('returns a validated streamed PPTX with immutable headers and rejects Range', async () => {
    const { service, artifacts, handle } = fixture()
    const created = await handle(request('/v2/presentation-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-v2-download-key' },
      body: JSON.stringify(createBody()),
    }))
    const jobId = (await created.json() as { data: { jobId: string } }).data.jobId
    await service.tick({ limit: 10 })
    await service.tick({ limit: 10 })
    const job = await handle(request(`/v2/presentation-jobs/${jobId}`))
    const artifactId = (await job.json() as { data: { artifact: { artifactId: string; sha256: string; byteLength: number } } }).data.artifact.artifactId
    artifacts.get = async () => { throw new Error('DOWNLOAD_MUST_NOT_BUFFER_ARTIFACT') }
    const content = await handle(request(`/v2/presentation-jobs/${jobId}/artifacts/${artifactId}`))
    const range = await handle(request(`/v2/presentation-jobs/${jobId}/artifacts/${artifactId}`, { headers: { Range: 'bytes=0-1' } }))

    expect(content.status).toBe(200)
    expect(content.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(content.headers.get('Content-Length')).toMatch(/^\d+$/)
    expect(content.headers.get('Content-Disposition')).toContain('attachment; filename=')
    expect(content.headers.get('ETag')).toMatch(/^"[a-f0-9]{64}"$/)
    expect(content.headers.get('X-PPT-Agent-Artifact-ID')).toBe(artifactId)
    expect(content.headers.get('X-PPT-Agent-Content-SHA256')).toMatch(/^[a-f0-9]{64}$/)
    expect(content.headers.get('X-PPT-Agent-Contract-Version')).toBe('2.0')
    expect((await content.arrayBuffer()).byteLength).toBe(Number(content.headers.get('Content-Length')))
    expect(range.status).toBe(416)
    expect(range.headers.get('Content-Range')).toContain('bytes */')
  })

  test('projects explicit BEST_EFFORT and blocking failure states without leaking artifacts', async () => {
    const { service, provider, handle } = fixture()
    const create = async (key: string) => {
      const response = await handle(request('/v2/presentation-jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(createBody()),
      }))
      return (await response.json() as { data: { jobId: string } }).data.jobId
    }
    const bestEffortId = await create('http-v2-best-effort')
    await service.tick({ limit: 10 })
    await provider.complete(`${bestEffortId}:provider:1`, 'BEST_EFFORT')
    await service.tick({ limit: 10 })
    const bestEffort = await handle(request(`/v2/presentation-jobs/${bestEffortId}`))
    expect(await bestEffort.json()).toMatchObject({ data: {
      status: 'COMPLETED', quality: 'BEST_EFFORT', artifact: expect.any(Object),
    } })

    const failedId = await create('http-v2-blocking-failure')
    await service.tick({ limit: 10 })
    await provider.complete(`${failedId}:provider:1`, 'BLOCKING_FAILURE')
    await service.tick({ limit: 10 })
    const failed = await handle(request(`/v2/presentation-jobs/${failedId}`))
    expect(await failed.json()).toMatchObject({ data: {
      status: 'FAILED', quality: null, artifact: null,
    } })
    expect((await handle(request(`/v2/presentation-jobs/${failedId}/artifacts/not-an-artifact`))).status).toBe(404)
  })

  test('keeps an artifact readable while Usage waits, then finalizes without changing Job delivery', async () => {
    const { service, provider, handle } = fixture()
    const created = await handle(request('/v2/presentation-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-v2-reconcile-key' },
      body: JSON.stringify(createBody()),
    }))
    const jobId = (await created.json() as { data: { jobId: string } }).data.jobId
    await service.tick({ limit: 10 })
    await provider.complete(`${jobId}:provider:1`, 'PASSED', 'UNKNOWN')
    await service.tick({ limit: 10 })

    const delivered = await handle(request(`/v2/presentation-jobs/${jobId}`))
    const deliveredBody = await delivered.json() as { data: { status: string; artifact: { artifactId: string } } }
    const waiting = await handle(request(`/v2/presentation-jobs/${jobId}/usage`))
    const download = await handle(request(`/v2/presentation-jobs/${jobId}/artifacts/${deliveredBody.data.artifact.artifactId}`))
    expect(deliveredBody.data.status).toBe('COMPLETED')
    expect(await waiting.json()).toMatchObject({ data: { status: 'RECONCILING', action: 'WAIT' } })
    expect(download.status).toBe(200)

    await provider.resolveBilling(`${jobId}:provider:1`)
    await service.tick({ limit: 10 })
    expect(await (await handle(request(`/v2/presentation-jobs/${jobId}`))).json()).toMatchObject({
      data: { status: 'COMPLETED', artifact: deliveredBody.data.artifact },
    })
    expect(await (await handle(request(`/v2/presentation-jobs/${jobId}/usage`))).json()).toMatchObject({
      data: { status: 'FINALIZED', action: 'NONE', unknownImageOperations: 0 },
    })
    expect(provider.submitCalls).toBe(1)
  })
})

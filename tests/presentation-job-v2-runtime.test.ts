import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, test } from 'bun:test'
import { InMemoryPresentationJobV2Repository } from '../src/adapters/presentation-job-v2-in-memory-repository'
import {
  FixedServicePresentationJobBudgetPolicy,
  MockPresentationJobV2Provider,
} from '../src/adapters/presentation-job-v2-ports'
import { MockArtifactPort } from '../src/adapters/mock-ports'
import { PresentationJobV2ServiceTokenAuthentication } from '../src/http/presentation-job-v2-service-authentication'
import { approvedPageDesignSnapshotHash } from '../src/presentation-job-v2-contracts'
import { createPresentationJobV2Runtime } from '../src/runtime/presentation-job-v2-runtime'

const token = 'presentation-job-v2-runtime-token-0001'
const snapshot = {
  schemaVersion: '1', title: '植物的生长', subject: '科学', gradeBand: '小学二年级', lessonDurationMinutes: 40,
  audience: '小学二年级学生', objectives: ['说出植物生长需要的基本条件'],
  pages: [
    {
      pageNumber: 1, title: '种子发芽', teachingPurpose: '认识发芽过程。', editableCopy: ['种子', '水'],
      layoutIntent: '按时间顺序展示。', visualRequirements: ['展示种子和幼苗'], teacherNotes: '提示学生观察变化。',
      teacherScript: '种子为什么会发芽？', studentActivity: '排序发芽图片。', animationSequence: ['种子出现', '幼苗出现'],
      boardPlan: '画发芽过程。', evidence: [{ type: 'FACT', text: '种子在适宜条件下能够发芽。', source: '科学教材' }],
    },
    {
      pageNumber: 2, title: '植物需要什么', teachingPurpose: '归纳生长条件。', editableCopy: ['阳光', '水', '空气'],
      layoutIntent: '中心植物，周围条件。', visualRequirements: ['使用三个条件图标'], teacherNotes: '联系校园植物。',
      teacherScript: '植物生长需要什么？', studentActivity: '为植物选择条件。', animationSequence: ['阳光出现', '水出现', '空气出现'],
      boardPlan: '写出三个条件。', evidence: [{ type: 'FACT', text: '植物生长需要水、空气和适宜光照。', source: '科学教材' }],
    },
  ],
} as const

const originalFetch = globalThis.fetch

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-PPT-Agent-User', 'runtime-user')
  headers.set('X-PPT-Agent-Project', 'runtime-project')
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

afterEach(() => { globalThis.fetch = originalFetch })

describe('Presentation Job V2 runtime boundary', () => {
  test('executes V2 end-to-end without constructing V1 or making host callbacks', async () => {
    let outboundHttpCalls = 0
    globalThis.fetch = (async () => {
      outboundHttpCalls += 1
      throw new Error('V2_RUNTIME_UNEXPECTED_HTTP_CALLBACK')
    }) as unknown as typeof fetch
    const provider = new MockPresentationJobV2Provider()
    const runtime = createPresentationJobV2Runtime({
      repository: new InMemoryPresentationJobV2Repository(),
      artifacts: new MockArtifactPort(),
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      authentication: new PresentationJobV2ServiceTokenAuthentication([{ tenantId: 'host-a', token }]),
    })
    const response = await runtime.handler(request('/v2/presentation-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-v2-job-key' },
      body: JSON.stringify({
        source: {
          kind: 'APPROVED_PAGE_DESIGN', artifactVersionId: 'plant-v3',
          sha256: approvedPageDesignSnapshotHash(snapshot), snapshot,
        },
      }),
    }))
    const jobId = (await response.json() as { data: { jobId: string } }).data.jobId

    await runtime.tick()
    await runtime.tick()
    const openapi = await runtime.handler(new Request('http://ppt-agent.test/openapi/v2.json'))
    const health = await runtime.handler(new Request('http://ppt-agent.test/health/ready'))
    const job = await runtime.handler(request(`/v2/presentation-jobs/${jobId}`))
    const jobBody = await job.json() as { data: { artifact: { artifactId: string } } }
    const usage = await runtime.handler(request(`/v2/presentation-jobs/${jobId}/usage`))
    const artifact = await runtime.handler(request(
      `/v2/presentation-jobs/${jobId}/artifacts/${jobBody.data.artifact.artifactId}`,
    ))
    const v1 = await runtime.handler(request('/v1/runs'))

    expect(response.status).toBe(201)
    expect(openapi.status).toBe(200)
    expect(openapi.headers.get('X-PPT-Agent-Contract-Version')).toBe('2.0')
    expect(await openapi.json()).toMatchObject({ info: { version: '2.0' } })
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ service: 'ppt-agent-presentation-job-v2', status: 'READY' })
    expect(jobBody).toMatchObject({ data: { status: 'COMPLETED', quality: 'PASSED' } })
    expect(await usage.json()).toMatchObject({ data: { status: 'FINALIZED', unknownOperationCount: 0 } })
    expect(artifact.status).toBe(200)
    expect(artifact.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(new Uint8Array(await artifact.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))
    expect(v1.status).toBe(404)
    expect(outboundHttpCalls).toBe(0)
    expect(provider.submitCalls).toBe(1)
  })

  test('keeps the V2 runtime and facade free of host-specific and V1 runtime imports', async () => {
    const sources = await Promise.all([
      readFile(new URL('../src/runtime/presentation-job-v2-runtime.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/runtime/presentation-job-v2-server-config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/http/presentation-job-v2-service-authentication.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/presentation-job-v2-server.ts', import.meta.url), 'utf8'),
    ])
    for (const source of sources) {
      for (const forbidden of [
        'FrameFlow', 'frameflow', 'createAgentRuntime', 'createMockRuntime', 'RunService',
        'credit', 'reserveCredits', 'settleCredits', 'releaseCredits', 'finalizeCredits',
        'generationPlan', 'blueprint', 'FRAMEFLOW_INTERNAL_TOKEN',
      ]) expect(source).not.toContain(forbidden)
    }
  })
})

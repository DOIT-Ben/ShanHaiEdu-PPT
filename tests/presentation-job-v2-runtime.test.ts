import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { InMemoryPresentationJobV2Repository } from '../src/adapters/presentation-job-v2-in-memory-repository'
import {
  FixedServicePresentationJobBudgetPolicy,
  MockPresentationJobV2Provider,
} from '../src/adapters/presentation-job-v2-ports'
import { MockArtifactPort } from '../src/adapters/mock-ports'
import type { FrameFlowBackendClient } from '../src/adapters/frameflow-host'
import { approvedPageDesignSnapshotHash } from '../src/presentation-job-v2-contracts'
import { createMockRuntime } from '../src/runtime/mock-runtime'

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

class CallbackSpy implements FrameFlowBackendClient {
  readonly calls = { document: 0, reserve: 0, settle: 0, release: 0, finalize: 0, preflight: 0 }

  async getDocumentAttachment(): Promise<never> {
    this.calls.document += 1
    throw new Error('V2_MUST_NOT_READ_HOST_DOCUMENTS')
  }

  async reserveCredits(): Promise<never> {
    this.calls.reserve += 1
    throw new Error('V2_MUST_NOT_RESERVE_HOST_CREDITS')
  }

  async settleCredits() {
    this.calls.settle += 1
    throw new Error('V2_MUST_NOT_SETTLE_HOST_CREDITS')
  }

  async releaseCredits() {
    this.calls.release += 1
    throw new Error('V2_MUST_NOT_RELEASE_HOST_CREDITS')
  }

  async finalizeCredits() {
    this.calls.finalize += 1
    throw new Error('V2_MUST_NOT_FINALIZE_HOST_CREDITS')
  }

  async preflightBatchFinalization() {
    this.calls.preflight += 1
    throw new Error('V2_MUST_NOT_PREFLIGHT_HOST_CREDITS')
  }
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-PPT-Agent-User', 'runtime-user')
  headers.set('X-PPT-Agent-Project', 'runtime-project')
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

describe('Presentation Job V2 runtime boundary', () => {
  test('executes V2 end-to-end with zero host document or credit callbacks', async () => {
    const callbacks = new CallbackSpy()
    const provider = new MockPresentationJobV2Provider()
    const v1Repository = new InMemoryAgentRepository()
    const runtime = createMockRuntime({
      repository: v1Repository,
      artifacts: new MockArtifactPort(),
      apiToken: token,
      frameFlowBackend: callbacks,
      v1ExecutionEnabled: false,
      presentationJobV2: {
        repository: new InMemoryPresentationJobV2Repository(),
        provider,
        budget: new FixedServicePresentationJobBudgetPolicy(1),
      },
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
    const job = await runtime.handler(request(`/v2/presentation-jobs/${jobId}`))
    const usage = await runtime.handler(request(`/v2/presentation-jobs/${jobId}/usage`))

    expect(response.status).toBe(201)
    expect(openapi.status).toBe(200)
    expect(openapi.headers.get('X-PPT-Agent-Contract-Version')).toBe('2.0')
    expect(await openapi.json()).toMatchObject({ info: { version: '2.0' } })
    expect(await job.json()).toMatchObject({ data: { status: 'COMPLETED', quality: 'PASSED' } })
    expect(await usage.json()).toMatchObject({ data: { status: 'FINALIZED', unknownOperationCount: 0 } })
    expect(callbacks.calls).toEqual({ document: 0, reserve: 0, settle: 0, release: 0, finalize: 0, preflight: 0 })
    expect(await v1Repository.listRuns()).toEqual([])
    expect(provider.submitCalls).toBe(1)
  })
})

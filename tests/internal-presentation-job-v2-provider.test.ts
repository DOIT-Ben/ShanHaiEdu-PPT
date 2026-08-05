import { describe, expect, test } from 'bun:test'
import { ExternallyAuthorizedBudgetPort } from '../src/adapters/external-budget'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  InternalPresentationJobV2Provider,
  presentationJobV2InternalTenantId,
} from '../src/adapters/internal-presentation-job-v2-provider'
import { InMemoryPresentationJobV2Repository } from '../src/adapters/presentation-job-v2-in-memory-repository'
import { FixedServicePresentationJobBudgetPolicy } from '../src/adapters/presentation-job-v2-ports'
import { FixedClock, MockArtifactPort, MockBudgetPort } from '../src/adapters/mock-ports'
import { TenantRoutingBudgetPort } from '../src/adapters/tenant-routing-budget'
import { RunService } from '../src/core/run-service'
import { approvedPageDesignSnapshotHash } from '../src/presentation-job-v2-contracts'
import { createMockRuntime } from '../src/runtime/mock-runtime'

const apiToken = 'internal-presentation-job-v2-test-token'
const snapshot = {
  schemaVersion: '1',
  title: '植物生长条件',
  subject: '科学',
  gradeBand: '小学二年级',
  lessonDurationMinutes: 40,
  audience: '小学二年级学生',
  objectives: ['说出植物生长需要水、空气和适宜光照'],
  pages: [1, 2].map((pageNumber) => ({
    pageNumber,
    title: `第 ${pageNumber} 页`,
    teachingPurpose: '建立植物生长条件的科学认识。',
    editableCopy: ['阳光', '水', '空气'],
    layoutIntent: '中心植物与周围条件形成清晰关系。',
    visualRequirements: ['完整课堂页面', '不生成文字'],
    teacherNotes: '引导学生观察并归纳。',
    teacherScript: '请说出植物生长需要什么。',
    studentActivity: '选择正确的生长条件。',
    animationSequence: ['植物出现', '条件依次出现'],
    boardPlan: '写出三个生长条件。',
    evidence: [{ type: 'FACT' as const, text: '植物生长需要水、空气和适宜光照。', source: '科学教材' }],
  })),
} as const

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${apiToken}`)
  headers.set('X-PPT-Agent-User', 'frameflow-user')
  headers.set('X-PPT-Agent-Project', 'frameflow-project')
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

describe('internal Presentation Job V2 provider', () => {
  test('runs the frozen V2 source through the existing intelligent-agent pipeline', async () => {
    const repository = new InMemoryAgentRepository()
    const presentationJobs = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock()
    const internalTenantId = presentationJobV2InternalTenantId('frameflow')
    const provider = new InternalPresentationJobV2Provider({
      runs: new RunService({ repository, artifacts, clock }),
      repository,
      artifacts,
      internalTenantId,
    })
    const runtime = createMockRuntime({
      repository,
      artifacts,
      clock,
      apiToken,
      budget: new TenantRoutingBudgetPort({
        routedTenantId: internalTenantId,
        routed: new ExternallyAuthorizedBudgetPort(internalTenantId),
        fallback: new MockBudgetPort(),
      }),
      presentationJobV2: {
        repository: presentationJobs,
        provider,
        budget: new FixedServicePresentationJobBudgetPolicy(1),
      },
    })
    const created = await runtime.handler(request('/v2/presentation-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'internal-v2-provider-job' },
      body: JSON.stringify({
        source: {
          kind: 'APPROVED_PAGE_DESIGN',
          artifactVersionId: 'approved-page-design-v1',
          sha256: approvedPageDesignSnapshotHash(snapshot),
          snapshot,
        },
      }),
    }))
    const createdBody = await created.json() as { data: { jobId: string } }

    type JobEnvelope = { data: { status: string; artifact: null | { artifactId: string } } }
    let job: JobEnvelope | null = null
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await runtime.tick()
      const response = await runtime.handler(request(`/v2/presentation-jobs/${createdBody.data.jobId}`))
      job = await response.json() as JobEnvelope
      if (job?.data.status === 'COMPLETED' || job?.data.status === 'FAILED') break
      clock.advance(1_000)
    }

    expect(created.status).toBe(201)
    expect(job?.data.status).toBe('COMPLETED')
    if (!job?.data.artifact) throw new Error('completed Presentation Job V2 did not expose an Artifact')
    const artifactId = job.data.artifact.artifactId
    expect(job).toMatchObject({
      data: {
        status: 'COMPLETED',
        usagePolicy: { maximumBillableImageOperationsPerPage: 5 },
        artifact: { artifactId },
      },
    })
    const [run] = await repository.listRuns()
    expect(run).toMatchObject({
      host: { tenantId: internalTenantId },
      source: { kind: 'APPROVED_PAGE_DESIGN', artifactVersionId: 'approved-page-design-v1' },
      presentationMode: 'VISUAL_DECK_V4',
      automationLevel: 'BOUNDED_AUTO',
      maxRevisionRounds: 4,
      budgetUnits: 10,
    })
    const usage = await runtime.handler(request(`/v2/presentation-jobs/${createdBody.data.jobId}/usage`))
    expect(await usage.json()).toMatchObject({
      data: {
        status: 'FINALIZED',
        usagePolicy: { maximumBillableImageOperationsPerPage: 5 },
        billableImageOperations: 2,
        unknownImageOperations: 0,
      },
    })
    const artifact = await runtime.handler(request(
      `/v2/presentation-jobs/${createdBody.data.jobId}/artifacts/${artifactId}`,
    ))
    expect(artifact.status).toBe(200)
    expect(new Uint8Array(await artifact.arrayBuffer()).slice(0, 2))
      .toEqual(new Uint8Array([0x50, 0x4b]))
  })
})

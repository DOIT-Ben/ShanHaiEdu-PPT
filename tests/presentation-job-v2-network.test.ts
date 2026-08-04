import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { LocalArtifactPort } from '../src/adapters/local-artifact-port'
import {
  FixedServicePresentationJobBudgetPolicy,
  MockPresentationJobV2Provider,
} from '../src/adapters/presentation-job-v2-ports'
import { SqlitePresentationJobV2Repository } from '../src/adapters/presentation-job-v2-sqlite-repository'
import { PresentationJobV2ServiceTokenAuthentication } from '../src/http/presentation-job-v2-service-authentication'
import { approvedPageDesignSnapshotHash } from '../src/presentation-job-v2-contracts'
import { createPresentationJobV2Runtime } from '../src/runtime/presentation-job-v2-runtime'

const token = 'presentation-job-v2-network-token-0001'
const snapshot = {
  schemaVersion: '1', title: '植物的生长', subject: '科学', gradeBand: '小学二年级', lessonDurationMinutes: 40,
  audience: '小学二年级学生', objectives: ['说出植物生长需要的基本条件'],
  pages: [1, 2].map((pageNumber) => ({
    pageNumber, title: `第${pageNumber}页`, teachingPurpose: '建立可验证的科学概念。',
    editableCopy: ['阳光', '水', '空气'], layoutIntent: '中心主体配合三个条件。',
    visualRequirements: ['主体清晰'], teacherNotes: '引导学生观察。',
    teacherScript: '植物生长需要什么？', studentActivity: '选择正确条件。',
    animationSequence: ['主体出现', '条件出现'], boardPlan: '写出三个条件。',
    evidence: [{ type: 'FACT', text: '植物生长需要水。', source: '科学教材' }],
  })),
} as const

describe('Presentation Job V2 network Artifact contract', () => {
  test('preserves immutable length and integrity headers over Bun HTTP without buffering the PPTX', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ppt-agent-v2-network-'))
    const repository = new SqlitePresentationJobV2Repository(path.join(root, 'jobs.sqlite'))
    const runtime = createPresentationJobV2Runtime({
      repository,
      artifacts: new LocalArtifactPort(path.join(root, 'artifacts')),
      provider: new MockPresentationJobV2Provider(),
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      authentication: new PresentationJobV2ServiceTokenAuthentication([{ tenantId: 'host-a', token }]),
    })
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: runtime.handler })
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-PPT-Agent-User': 'network-user',
      'X-PPT-Agent-Project': 'network-project',
    }
    try {
      const created = await fetch(new URL('/v2/presentation-jobs', server.url), {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'network-v2-job-key',
        },
        body: JSON.stringify({ source: {
          kind: 'APPROVED_PAGE_DESIGN', artifactVersionId: 'network-design-v1',
          sha256: approvedPageDesignSnapshotHash(snapshot), snapshot,
        } }),
      })
      const createdBody = await created.json() as { data: { jobId: string } }
      await runtime.tick()
      await runtime.tick()
      const jobResponse = await fetch(new URL(`/v2/presentation-jobs/${createdBody.data.jobId}`, server.url), { headers })
      const job = await jobResponse.json() as {
        data: { artifact: { artifactId: string; byteLength: number; sha256: string } }
      }
      const artifact = await fetch(new URL(
        `/v2/presentation-jobs/${createdBody.data.jobId}/artifacts/${job.data.artifact.artifactId}`,
        server.url,
      ), { headers })

      expect(artifact.status).toBe(200)
      expect(artifact.headers.get('Content-Length')).toBe(String(job.data.artifact.byteLength))
      expect(artifact.headers.get('Transfer-Encoding')).toBeNull()
      expect(artifact.headers.get('ETag')).toBe(`"${job.data.artifact.sha256}"`)
      expect(artifact.headers.get('X-PPT-Agent-Content-SHA256')).toBe(job.data.artifact.sha256)
      const bytes = new Uint8Array(await artifact.arrayBuffer())
      expect(bytes.byteLength).toBe(job.data.artifact.byteLength)
      expect(bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))
    } finally {
      server.stop(true)
      repository.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from 'bun:test'
import { InMemoryPresentationJobV2Repository } from '../src/adapters/presentation-job-v2-in-memory-repository'
import {
  FixedServicePresentationJobBudgetPolicy,
  MockPresentationJobV2Provider,
} from '../src/adapters/presentation-job-v2-ports'
import { MockArtifactPort, FixedClock } from '../src/adapters/mock-ports'
import { PresentationJobV2Service } from '../src/core/presentation-job-v2-service'
import { approvedPageDesignSnapshotHash } from '../src/presentation-job-v2-contracts'

const owner = { tenantId: 'host-a', externalUserId: 'user-a', externalProjectId: 'project-a' }
const snapshot = {
  schemaVersion: '1',
  title: '认识三角形',
  subject: '数学',
  gradeBand: '小学一年级',
  lessonDurationMinutes: 40,
  audience: '小学一年级学生',
  objectives: ['辨认三角形的基本特征'],
  pages: [
    {
      pageNumber: 1,
      title: '三角形在哪里',
      teachingPurpose: '从熟悉物体中建立三角形的直观印象。',
      editableCopy: ['观察屋顶和路标。'],
      layoutIntent: '左侧物体，右侧图形。',
      visualRequirements: ['展示日常物体'],
      teacherNotes: '引导学生描述看到的边和角。',
      teacherScript: '请找一找三角形。',
      studentActivity: '圈出图片中的三角形。',
      animationSequence: ['高亮物体', '描出轮廓'],
      boardPlan: '板书三条线段。',
      evidence: [{ type: 'FACT', text: '三角形由三条线段首尾相连围成。', source: '课程标准材料' }],
    },
    {
      pageNumber: 2,
      title: '三角形的特征',
      teachingPurpose: '归纳三条边和三个角。',
      editableCopy: ['三条边', '三个角'],
      layoutIntent: '中心大三角形。',
      visualRequirements: ['高对比标注'],
      teacherNotes: '让学生跟读结构名称。',
      teacherScript: '数一数边和角。',
      studentActivity: '用手指沿边比划。',
      animationSequence: ['出现三条边', '出现三个角'],
      boardPlan: '画一个三角形。',
      evidence: [{ type: 'FACT', text: '三角形有三条边和三个角。', source: '课程标准材料' }],
    },
  ],
} as const

function request() {
  return {
    source: {
      kind: 'APPROVED_PAGE_DESIGN' as const,
      artifactVersionId: 'approved-design-v17',
      sha256: approvedPageDesignSnapshotHash(snapshot),
      snapshot,
    },
  }
}

describe('Presentation Job V2 service', () => {
  test('creates, executes and delivers a host-neutral PPTX Job without a V1 Run', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    const clock = new FixedClock()
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })

    const created = await service.create(owner, request(), 'presentation-job-key-1')
    const replay = await service.create(owner, request(), 'presentation-job-key-1')

    expect(created.replayed).toBe(false)
    expect(created.job).toMatchObject({ status: 'QUEUED', phase: 'ACCEPTED', progress: { percent: 0 } })
    expect(replay).toMatchObject({ replayed: true, job: { jobId: created.job.jobId } })

    await service.tick({ limit: 10 })
    expect((await service.getOwned(owner, created.job.jobId)).status).toBe('RUNNING')
    await service.tick({ limit: 10 })

    const completed = await service.getOwned(owner, created.job.jobId)
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      phase: 'COMPLETE',
      progress: { percent: 100 },
      quality: 'PASSED',
      artifact: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    })
    expect((await service.getUsageOwned(owner, created.job.jobId))).toMatchObject({
      status: 'FINALIZED', action: 'NONE',
      billableImageOperations: snapshot.pages.length,
      notChargedImageOperations: 0,
      unknownImageOperations: 0,
      byModel: [{ model: 'nanobanana', billableImageOperations: snapshot.pages.length }],
    })
    expect(provider.submitCalls).toBe(1)
  })

  test('keeps BEST_EFFORT explicit, rejects blocking quality, and never publishes an Artifact for failure', async () => {
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

    const bestEffort = await service.create(owner, request(), 'presentation-job-best-effort')
    await service.tick({ limit: 10 })
    await provider.complete(`${bestEffort.job.jobId}:provider:1`, 'BEST_EFFORT')
    await service.tick({ limit: 10 })
    expect(await service.getOwned(owner, bestEffort.job.jobId)).toMatchObject({
      status: 'COMPLETED', quality: 'BEST_EFFORT', artifact: expect.any(Object),
    })

    const blocked = await service.create(owner, request(), 'presentation-job-blocked-quality')
    await service.tick({ limit: 10 })
    await provider.complete(`${blocked.job.jobId}:provider:1`, 'BLOCKING_FAILURE')
    await service.tick({ limit: 10 })
    expect(await service.getOwned(owner, blocked.job.jobId)).toMatchObject({
      status: 'FAILED', quality: null, artifact: null,
    })
    await expect(service.getArtifactOwned(owner, blocked.job.jobId, 'artifact-does-not-exist'))
      .rejects.toMatchObject({ status: 404 })
  })

  test('preserves a delivered Job while unknown usage reconciles without a second Provider submission', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    const clock = new FixedClock()
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })
    const created = await service.create(owner, request(), 'presentation-job-reconcile')
    const jobId = created.job.jobId

    await service.tick({ limit: 10 })
    await provider.complete(`${jobId}:provider:1`, 'PASSED', 'UNKNOWN')
    await service.tick({ limit: 10 })

    const delivered = await service.getOwned(owner, jobId)
    const usageBefore = await service.getUsageOwned(owner, jobId)
    const storedBeforeReads = await repository.getPresentationJob(jobId)
    await service.getOwned(owner, jobId)
    await service.getUsageOwned(owner, jobId)
    await service.getArtifactOwned(owner, jobId, delivered.artifact!.artifactId)
    expect(await repository.getPresentationJob(jobId)).toEqual(storedBeforeReads)
    expect(delivered).toMatchObject({ status: 'COMPLETED', quality: 'PASSED', artifact: expect.any(Object) })
    expect(usageBefore).toMatchObject({
      status: 'RECONCILING', action: 'WAIT',
      billableImageOperations: 0, notChargedImageOperations: 0,
      unknownImageOperations: snapshot.pages.length,
    })

    await provider.resolveBilling(`${jobId}:provider:1`)
    clock.advance(1_000)
    await service.tick({ limit: 10 })

    expect(await service.getOwned(owner, jobId)).toMatchObject({
      status: 'COMPLETED', quality: 'PASSED', artifact: delivered.artifact,
    })
    expect(await service.getUsageOwned(owner, jobId)).toMatchObject({
      status: 'FINALIZED', action: 'NONE',
      billableImageOperations: snapshot.pages.length,
      notChargedImageOperations: 0,
      unknownImageOperations: 0,
    })
    expect(provider.submitCalls).toBe(1)
  })

  test('preserves a delivered Artifact but does not finalize reconciled usage above the authorization cap', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    const inspect = provider.inspect.bind(provider)
    let returnOverCapUsage = false
    provider.inspect = async (input) => {
      const result = await inspect(input)
      if (!returnOverCapUsage || result.state !== 'COMPLETED') return result
      const billableImageOperations = snapshot.pages.length * 5 + 1
      return {
        ...result,
        usage: {
          billableImageOperations,
          notChargedImageOperations: 0,
          unknownImageOperations: 0,
          byModel: [{
            model: 'nanobanana',
            billableImageOperations,
            notChargedImageOperations: 0,
            unknownImageOperations: 0,
          }],
        },
      }
    }
    const clock = new FixedClock()
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })
    const created = await service.create(owner, request(), 'presentation-job-delivered-cap-exceeded')
    const jobId = created.job.jobId

    await service.tick({ limit: 10 })
    await provider.complete(`${jobId}:provider:1`, 'PASSED', 'UNKNOWN')
    await service.tick({ limit: 10 })
    const delivered = await service.getOwned(owner, jobId)
    const deliveredArtifact = structuredClone(delivered.artifact!)
    expect(delivered).toMatchObject({ status: 'COMPLETED', artifact: expect.any(Object) })

    returnOverCapUsage = true
    clock.advance(1_000)
    await service.tick({ limit: 10 })

    expect(await service.getOwned(owner, jobId)).toMatchObject({
      status: 'COMPLETED',
      quality: 'PASSED',
      artifact: deliveredArtifact,
    })
    expect(await service.getUsageOwned(owner, jobId)).toMatchObject({
      status: 'RECONCILING',
      action: 'WAIT',
      billableImageOperations: 0,
      unknownImageOperations: snapshot.pages.length,
    })
    expect(await repository.getPresentationJob(jobId)).toMatchObject({
      status: 'COMPLETED',
      artifact: { artifactId: deliveredArtifact.artifactId },
      usage: { status: 'RECONCILING' },
      errorCode: 'PROVIDER_USAGE_CAP_EXCEEDED',
    })
    expect(await service.getArtifactOwned(owner, jobId, deliveredArtifact.artifactId))
      .toEqual(expect.objectContaining({ artifactId: deliveredArtifact.artifactId }))
  })

  test('continues after one Job fails and backs it off before processing the next Job', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    const inspect = provider.inspect.bind(provider)
    let failingJobId: string | null = null
    provider.inspect = async (input) => {
      if (input.jobId === failingJobId) throw new Error('PRESENTATION_PROVIDER_TEMPORARY_FAILURE')
      return inspect(input)
    }
    const clock = new FixedClock()
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })
    const first = await service.create(owner, request(), 'presentation-job-worker-failure-a')
    const second = await service.create(owner, request(), 'presentation-job-worker-failure-b')
    await service.tick({ limit: 10 })
    failingJobId = (await repository.listRunnablePresentationJobs({
      limit: 1,
      now: clock.now().toISOString(),
    }))[0]!.id
    const otherJobId = failingJobId === first.job.jobId ? second.job.jobId : first.job.jobId

    await expect(service.tick({ limit: 1 })).resolves.toMatchObject({ scannedJobs: 1, failedJobs: 1 })
    await expect(service.tick({ limit: 1 })).resolves.toMatchObject({ scannedJobs: 1, failedJobs: 0 })

    expect(await service.getOwned(owner, otherJobId)).toMatchObject({ status: 'COMPLETED' })
    expect(await service.getOwned(owner, failingJobId)).toMatchObject({ status: 'RUNNING' })
  })

  test('honors the Provider inspection backoff before polling the same Job again', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    provider.inspect = async () => ({ state: 'RUNNING', retryAfterMs: 30_000 })
    const clock = new FixedClock()
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })
    const created = await service.create(owner, request(), 'presentation-job-provider-backoff')

    await service.tick({ limit: 10 })
    await service.tick({ limit: 10 })
    clock.advance(1_000)

    expect(await repository.listRunnablePresentationJobs({
      limit: 10,
      now: clock.now().toISOString(),
    })).toEqual([])

    clock.advance(29_000)
    expect(await repository.listRunnablePresentationJobs({
      limit: 10,
      now: clock.now().toISOString(),
    })).toEqual([expect.objectContaining({ id: created.job.jobId })])
  })

  test('honors the Provider inspection backoff while terminal usage reconciles', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    const clock = new FixedClock()
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })
    const created = await service.create(owner, request(), 'presentation-job-reconciliation-backoff')

    await service.tick({ limit: 10 })
    await provider.complete(`${created.job.jobId}:provider:1`, 'PASSED', 'UNKNOWN')
    await service.tick({ limit: 10 })
    provider.inspect = async () => ({ state: 'RUNNING', retryAfterMs: 30_000 })
    clock.advance(1_000)
    await service.tick({ limit: 10 })
    clock.advance(1_000)

    expect(await repository.listRunnablePresentationJobs({
      limit: 10,
      now: clock.now().toISOString(),
    })).toEqual([])

    clock.advance(29_000)
    expect(await repository.listRunnablePresentationJobs({
      limit: 10,
      now: clock.now().toISOString(),
    })).toEqual([expect.objectContaining({ id: created.job.jobId })])
  })

  test('does not let a reconciling Job starve a newer queued Job', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    const clock = new FixedClock()
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })
    const waiting = await service.create(owner, request(), 'presentation-job-worker-waiting')
    await service.tick({ limit: 10 })
    await provider.complete(`${waiting.job.jobId}:provider:1`, 'PASSED', 'UNKNOWN')
    await service.tick({ limit: 10 })
    expect(await service.getUsageOwned(owner, waiting.job.jobId)).toMatchObject({ status: 'RECONCILING' })

    clock.advance(1)
    const queued = await service.create(owner, request(), 'presentation-job-worker-queued')
    await service.tick({ limit: 1 })

    expect(await service.getOwned(owner, queued.job.jobId)).toMatchObject({ status: 'RUNNING' })
    expect(await service.getUsageOwned(owner, waiting.job.jobId)).toMatchObject({ status: 'RECONCILING' })
  })

  test('finalizes reconciled usage without changing a failed Job outcome', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    const inspect = provider.inspect.bind(provider)
    let billingResolved = false
    const clock = new FixedClock()
    provider.inspect = async (input) => {
      const result = await inspect(input)
      if (!billingResolved || result.state !== 'FAILED') return result
      const notChargedImageOperations = snapshot.pages.length
      return {
        ...result,
        usage: {
          billableImageOperations: 0,
          notChargedImageOperations,
          unknownImageOperations: 0,
          byModel: [{
            model: 'nanobanana',
            billableImageOperations: 0,
            notChargedImageOperations,
            unknownImageOperations: 0,
          }],
        },
      }
    }
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })
    const created = await service.create(owner, request(), 'presentation-job-failed-usage-reconciliation')
    const jobId = created.job.jobId

    await service.tick({ limit: 10 })
    await provider.fail(`${jobId}:provider:1`, 'PROVIDER_OPERATION_FAILED', 'UNKNOWN')
    await service.tick({ limit: 10 })
    expect(await service.getOwned(owner, jobId)).toMatchObject({ status: 'FAILED', artifact: null })
    expect(await service.getUsageOwned(owner, jobId)).toMatchObject({
      status: 'RECONCILING',
      unknownImageOperations: snapshot.pages.length,
    })

    billingResolved = true
    clock.advance(1_000)
    await service.tick({ limit: 10 })

    expect(await service.getOwned(owner, jobId)).toMatchObject({ status: 'FAILED', artifact: null })
    expect(await service.getUsageOwned(owner, jobId)).toMatchObject({
      status: 'FINALIZED',
      action: 'NONE',
      billableImageOperations: 0,
      notChargedImageOperations: snapshot.pages.length,
      unknownImageOperations: 0,
    })
    expect(provider.submitCalls).toBe(1)
  })

  test('rejects Provider usage above the public per-page operation cap', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    const inspect = provider.inspect.bind(provider)
    provider.inspect = async (input) => {
      const result = await inspect(input)
      if (result.state !== 'COMPLETED') return result
      const billableImageOperations = snapshot.pages.length * 5 + 1
      return {
        ...result,
        usage: {
          billableImageOperations,
          notChargedImageOperations: 0,
          unknownImageOperations: 0,
          byModel: [{
            model: 'nanobanana',
            billableImageOperations,
            notChargedImageOperations: 0,
            unknownImageOperations: 0,
          }],
        },
      }
    }
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock: new FixedClock(),
    })
    const created = await service.create(owner, request(), 'presentation-job-cap-exceeded')

    await service.tick({ limit: 10 })
    await service.tick({ limit: 10 })

    expect(await repository.getPresentationJob(created.job.jobId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'PROVIDER_USAGE_CAP_EXCEEDED',
      artifact: null,
    })
  })

  test('rejects a ZIP-shaped artifact that is not a readable PPTX package', async () => {
    const repository = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const provider = new MockPresentationJobV2Provider()
    provider.inspect = async () => ({
      state: 'COMPLETED',
      quality: 'PASSED',
      usage: {
        billableImageOperations: 0,
        notChargedImageOperations: 0,
        unknownImageOperations: 0,
        byModel: [],
      },
      artifact: {
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]),
        name: 'invalid.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    })
    const service = new PresentationJobV2Service({
      repository,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock: new FixedClock(),
    })
    const created = await service.create(owner, request(), 'presentation-job-invalid-pptx')

    await service.tick({ limit: 10 })
    await service.tick({ limit: 10 })

    expect(await repository.getPresentationJob(created.job.jobId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'PPTX_ARTIFACT_INVALID',
      artifact: null,
    })
  })
})

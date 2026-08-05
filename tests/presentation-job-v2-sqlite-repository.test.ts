import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqlitePresentationJobV2Repository } from '../src/adapters/presentation-job-v2-sqlite-repository'
import { FixedClock, MockArtifactPort } from '../src/adapters/mock-ports'
import {
  FixedServicePresentationJobBudgetPolicy,
  MockPresentationJobV2Provider,
} from '../src/adapters/presentation-job-v2-ports'
import { PresentationJobV2Service } from '../src/core/presentation-job-v2-service'
import { approvedPageDesignSnapshotHash } from '../src/presentation-job-v2-contracts'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const owner = { tenantId: 'host-a', externalUserId: 'user-a', externalProjectId: null }
const snapshot = {
  schemaVersion: '1',
  title: '天气观察',
  subject: '科学',
  gradeBand: '小学二年级',
  lessonDurationMinutes: 35,
  audience: '小学二年级学生',
  objectives: ['说出晴天和雨天的常见特征'],
  pages: [
    {
      pageNumber: 1, title: '观察天空', teachingPurpose: '观察天气现象。', editableCopy: ['云朵和阳光'],
      layoutIntent: '用左右对比展示天空。', visualRequirements: ['高对比天气符号'],
      teacherNotes: '提醒学生先观察再描述。', teacherScript: '请描述今天的天空。',
      studentActivity: '记录看到的云。', animationSequence: ['出现太阳', '出现云朵'],
      boardPlan: '板书晴天特征。', evidence: [{ type: 'FACT', text: '晴天通常可见阳光。', source: '课堂观察记录' }],
    },
    {
      pageNumber: 2, title: '记录天气', teachingPurpose: '把观察结果整理成记录。', editableCopy: ['日期', '天气'],
      layoutIntent: '中心放天气记录卡。', visualRequirements: ['使用记录表格'],
      teacherNotes: '引导学生完整填写日期。', teacherScript: '把今天的天气写下来。',
      studentActivity: '填写一张天气卡。', animationSequence: ['显示日期', '显示天气'],
      boardPlan: '画天气记录卡。', evidence: [{ type: 'FACT', text: '天气记录应包含日期和现象。', source: '课堂观察记录' }],
    },
  ],
} as const

async function databasePath() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ppt-agent-presentation-job-v2-'))
  cleanupPaths.push(directory)
  return path.join(directory, 'agent.sqlite')
}

describe('SQLite Presentation Job V2 repository', () => {
  test('persists a delivered Job and reconciled Usage independently of V1 Run storage', async () => {
    const filename = await databasePath()
    const first = new SqlitePresentationJobV2Repository(filename)
    const provider = new MockPresentationJobV2Provider()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock()
    const service = new PresentationJobV2Service({
      repository: first,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })
    const created = await service.create(owner, {
      source: {
        kind: 'APPROVED_PAGE_DESIGN', artifactVersionId: 'weather-v1',
        sha256: approvedPageDesignSnapshotHash(snapshot), snapshot,
      },
    }, 'sqlite-v2-job-key')
    await service.tick({ limit: 10 })
    expect(await first.getPresentationJob(created.job.jobId)).toMatchObject({ status: 'RUNNING' })
    first.close()

    const reopened = new SqlitePresentationJobV2Repository(filename)
    expect(await reopened.getPresentationJob(created.job.jobId)).toMatchObject({ status: 'RUNNING', owner })
    const resumed = new PresentationJobV2Service({
      repository: reopened,
      artifacts,
      provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
      clock,
    })
    await resumed.tick({ limit: 10 })
    const stored = await reopened.getPresentationJob(created.job.jobId)
    expect(stored).toMatchObject({
      id: created.job.jobId,
      status: 'COMPLETED',
      owner,
      usage: {
        status: 'FINALIZED', billableImageOperations: snapshot.pages.length,
        notChargedImageOperations: 0, unknownImageOperations: 0,
      },
    })

    const bestEffort = await resumed.create(owner, {
      source: {
        kind: 'APPROVED_PAGE_DESIGN', artifactVersionId: 'weather-best-effort-v1',
        sha256: approvedPageDesignSnapshotHash(snapshot), snapshot,
      },
    }, 'sqlite-v2-best-effort')
    await resumed.tick({ limit: 10 })
    await provider.complete(`${bestEffort.job.jobId}:provider:1`, 'BEST_EFFORT')
    await resumed.tick({ limit: 10 })
    expect(await reopened.getPresentationJob(bestEffort.job.jobId)).toMatchObject({
      status: 'COMPLETED', quality: 'BEST_EFFORT', artifact: expect.any(Object),
    })

    const blocked = await resumed.create(owner, {
      source: {
        kind: 'APPROVED_PAGE_DESIGN', artifactVersionId: 'weather-blocked-v1',
        sha256: approvedPageDesignSnapshotHash(snapshot), snapshot,
      },
    }, 'sqlite-v2-blocked')
    await resumed.tick({ limit: 10 })
    await provider.complete(`${blocked.job.jobId}:provider:1`, 'BLOCKING_FAILURE')
    await resumed.tick({ limit: 10 })
    expect(await reopened.getPresentationJob(blocked.job.jobId)).toMatchObject({
      status: 'FAILED', quality: null, artifact: null,
    })

    const reconciling = await resumed.create(owner, {
      source: {
        kind: 'APPROVED_PAGE_DESIGN', artifactVersionId: 'weather-reconciling-v1',
        sha256: approvedPageDesignSnapshotHash(snapshot), snapshot,
      },
    }, 'sqlite-v2-failed-reconciling')
    await resumed.tick({ limit: 10 })
    await provider.fail(`${reconciling.job.jobId}:provider:1`, 'PROVIDER_OPERATION_FAILED', 'UNKNOWN')
    await resumed.tick({ limit: 10 })
    expect(await reopened.listRunnablePresentationJobs({
      limit: 10,
      now: clock.now().toISOString(),
    })).toEqual([])
    clock.advance(1_000)
    expect(await reopened.listRunnablePresentationJobs({
      limit: 10,
      now: clock.now().toISOString(),
    })).toEqual([
      expect.objectContaining({
        id: reconciling.job.jobId,
        status: 'FAILED',
        usage: expect.objectContaining({ status: 'RECONCILING' }),
      }),
    ])
    reopened.close()
  })
})

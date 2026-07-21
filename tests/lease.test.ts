import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { SqliteAgentRepository } from '../src/adapters/sqlite-repository'
import {
  acquireRunLease,
  listRecoverableRunIds,
  releaseRunLease,
  renewRunLease,
} from '../src/core/lease'
import type { AgentRepository, RunRecord } from '../src/core/ports'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function run(id: string, status: RunRecord['status'] = 'PLANNING'): RunRecord {
  return {
    id,
    creationKey: `create-${id}`,
    requestHash: `hash-${id}`,
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于 Lease 测试的完整教材内容。' },
    slideCount: 2,
    visualDirection: '课堂信息图',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status,
    resumeState: status === 'PAUSED' ? 'EXECUTING' : null,
    version: 0,
    budgetUnits: 100,
    committedBudgetUnits: 0,
    qualityOverride: false,
    qualityOverrideReason: null,
    qualityOverrideBy: null,
    leaseToken: null,
    leaseUntil: null,
    leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

async function seed(repository: AgentRepository, ...runs: RunRecord[]) {
  for (const item of runs) await repository.createRun(item)
}

describe('run lease', () => {
  test('allows only one concurrent owner and rejects stale tokens', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    await seed(repository, run('run-1'))

    const [first, second] = await Promise.all([
      acquireRunLease({ repository, clock, runId: 'run-1', token: 'worker-a', ttlMs: 5_000 }),
      acquireRunLease({ repository, clock, runId: 'run-1', token: 'worker-b', ttlMs: 5_000 }),
    ])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    const lease = first ?? second!
    const staleToken = lease.token === 'worker-a' ? 'worker-b' : 'worker-a'
    await expect(renewRunLease({
      repository,
      clock,
      runId: 'run-1',
      lease: { ...lease, token: staleToken },
      ttlMs: 5_000,
    })).rejects.toThrow('run lease is stale')
  })

  test('recovers an expired lease and prevents the old owner from releasing it', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    await seed(repository, run('run-1'))
    const first = await acquireRunLease({ repository, clock, runId: 'run-1', token: 'worker-a', ttlMs: 1_000 })
    expect(first).not.toBeNull()
    clock.advance(1_001)
    const recovered = await acquireRunLease({ repository, clock, runId: 'run-1', token: 'worker-b', ttlMs: 5_000 })

    expect(recovered).toMatchObject({ token: 'worker-b', version: 2 })
    await expect(releaseRunLease({ repository, clock, runId: 'run-1', lease: first! })).rejects.toThrow('run lease is stale')
    await releaseRunLease({ repository, clock, runId: 'run-1', lease: recovered! })
    expect(await repository.getRun('run-1')).toMatchObject({ leaseToken: null, leaseUntil: null, leaseVersion: 2 })
  })

  test('recovery scan excludes approval, paused, human and terminal states', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    await seed(
      repository,
      run('planning', 'PLANNING'),
      run('executing', 'EXECUTING'),
      run('approval', 'AWAITING_BLUEPRINT_APPROVAL'),
      run('paused', 'PAUSED'),
      run('human', 'NEEDS_HUMAN'),
      run('done', 'COMPLETED'),
    )

    expect(await listRecoverableRunIds({ repository, clock })).toEqual(['planning', 'executing'])
  })

  test('persists lease ownership across SQLite reopen', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ppt-agent-lease-'))
    cleanupPaths.push(directory)
    const filename = path.join(directory, 'agent.sqlite')
    const clock = new FixedClock()
    const firstRepository = new SqliteAgentRepository(filename)
    await seed(firstRepository, run('run-1'))
    const lease = await acquireRunLease({
      repository: firstRepository,
      clock,
      runId: 'run-1',
      token: 'worker-a',
      ttlMs: 5_000,
    })
    firstRepository.close()

    const reopened = new SqliteAgentRepository(filename)
    expect(await acquireRunLease({
      repository: reopened,
      clock,
      runId: 'run-1',
      token: 'worker-b',
      ttlMs: 5_000,
    })).toBeNull()
    expect(await renewRunLease({ repository: reopened, clock, runId: 'run-1', lease: lease!, ttlMs: 5_000 }))
      .toMatchObject({ token: 'worker-a', version: 1 })
    reopened.close()
  })
})

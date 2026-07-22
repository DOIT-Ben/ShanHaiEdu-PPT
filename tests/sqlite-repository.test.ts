import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CONTRACT_VERSION } from '../src/contracts'
import { SqliteAgentRepository } from '../src/adapters/sqlite-repository'
import type { RunRecord } from '../src/core/ports'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function run(): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于 SQLite 测试的完整教材内容。' },
    slideCount: 2,
    visualDirection: '课堂信息图',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'PLANNING',
    resumeState: null,
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

async function databasePath() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ppt-agent-sqlite-'))
  cleanupPaths.push(directory)
  return path.join(directory, 'agent.sqlite')
}

describe('SQLite repository', () => {
  test('persists runs, steps and event sequence across process reopen', async () => {
    const filename = await databasePath()
    const first = new SqliteAgentRepository(filename)
    await first.createRun(run())
    await first.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
      transaction.putStep({
        id: 'step-1',
        runId: 'run-1',
        idempotencyKey: 'run-1:plan:v1',
        inputHash: 'input-hash',
        tool: 'create_blueprint',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: { blueprintId: 'blueprint-1' },
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
      transaction.putDelivery({
        id: 'delivery-1',
        runId: 'run-1',
        revisionRound: 0,
        qualityScore: 90,
        qualityOverride: false,
        preview: { artifactId: 'preview-1', name: 'preview.png', mimeType: 'image/png', sha256: 'a'.repeat(64), byteLength: 10 },
        pptx: {
          artifactId: 'pptx-1',
          name: 'lesson.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          sha256: 'b'.repeat(64),
          byteLength: 20,
        },
        createdAt: transaction.run.createdAt,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PLANNING', to: 'AWAITING_BLUEPRINT_APPROVAL' },
      })
    })
    first.close()

    const reopened = new SqliteAgentRepository(filename)
    expect(await reopened.getRun('run-1')).toMatchObject({ status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
    expect(await reopened.listSteps('run-1')).toHaveLength(1)
    expect(await reopened.listDeliveries('run-1')).toHaveLength(1)
    expect((await reopened.listEvents('run-1')).map((event) => event.sequence)).toEqual([1])
    await reopened.transact('run-1', (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'BLUEPRINT', summary: '请确认蓝图' },
      })
    })
    expect((await reopened.listEvents('run-1')).map((event) => event.sequence)).toEqual([1, 2])
    reopened.close()
  })

  test('rolls back run, step and event writes together', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun(run())

    await expect(repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'FAILED', version: 1 })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.failed',
        payload: { errorCode: 'INJECTED_FAILURE' },
      })
      transaction.putDelivery({
        id: 'delivery-rollback',
        runId: 'run-1',
        revisionRound: 0,
        qualityScore: null,
        qualityOverride: true,
        preview: { artifactId: 'preview-1', name: 'preview.png', mimeType: 'image/png', sha256: 'a'.repeat(64), byteLength: 10 },
        pptx: {
          artifactId: 'pptx-1',
          name: 'lesson.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          sha256: 'b'.repeat(64),
          byteLength: 20,
        },
        createdAt: transaction.run.createdAt,
      })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    expect(await repository.getRun('run-1')).toMatchObject({ status: 'PLANNING', version: 0 })
    expect(await repository.listEvents('run-1')).toEqual([])
    expect(await repository.listDeliveries('run-1')).toEqual([])
    repository.close()
  })

  test('enforces one Step per Run idempotency key', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun(run())
    const put = (id: string, inputHash: string) => repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id,
        runId: 'run-1',
        idempotencyKey: 'stable-key',
        inputHash,
        tool: 'test_tool',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })

    await put('step-1', 'hash-1')
    await put('step-1', 'hash-1')
    expect(await repository.listSteps('run-1')).toHaveLength(1)
    repository.close()
  })

  test('aggregates planning failures in SQLite without crossing tenant boundaries', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun(run())
    await repository.createRun({
      ...run(),
      id: 'run-other-tenant',
      creationKey: 'create-run-other-tenant',
      host: { tenantId: 'other-tenant', externalUserId: 'user-2' },
    })
    const appendFailure = (runId: string) => repository.transact(runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: `${runId}:planning-failed`, category: 'PLANNING_FAILED', severity: 'CRITICAL',
          summary: '规划模型限流。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
          planningFailure: {
            errorCode: 'PROVIDER_RATE_LIMIT', retryable: true, attempt: 3, maxAttempts: 3,
            suggestedAction: 'RETRY', diagnosticCode: 'PROVIDER_RATE_LIMIT', fieldPaths: [],
            correlationId: `${runId}:correlation`, requestId: `${runId}:request`, model: 'gpt-5.6', contractVersion: '1',
          },
        },
      })
    })
    await appendFailure('run-1')
    await appendFailure('run-other-tenant')

    expect(await repository.aggregatePlanningFailures({
      tenantId: 'frameflow', errorCode: 'PROVIDER_RATE_LIMIT', model: 'gpt-5.6', contractVersion: '1',
    })).toEqual({
      groups: [{
        errorCode: 'PROVIDER_RATE_LIMIT', model: 'gpt-5.6', contractVersion: '1',
        count: 1, lastOccurredAt: '2026-07-21T00:00:00.000Z',
      }],
      totalFailures: 1,
    })
    repository.close()
  })

  test('pages events with bounded batches and materializes open issue and progress state', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun(run())
    await repository.transact('run-1', (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION, type: 'issue.detected',
        payload: {
          id: 'issue-1', category: 'PROVIDER_RESULT_FAILED', severity: 'WARNING', summary: '等待时间超过 SLA',
          slideIds: [], sourceChunkIds: [], status: 'OPEN', repairDomain: 'ASSET',
        },
      })
      for (let index = 0; index < 250; index++) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION, type: 'tool.progress',
          payload: { stepId: 'step-1', completed: index, total: 250, summary: `progress-${index}` },
        })
      }
    })

    const first = await repository.readEvents('run-1', { afterSequence: 0, limit: 100, maxBytes: 256 * 1024 })
    const second = await repository.readEvents('run-1', { afterSequence: first.nextAfter, limit: 100, maxBytes: 256 * 1024 })
    expect(first).toMatchObject({ hasMore: true })
    expect(first.events).toHaveLength(100)
    expect(first.byteLength).toBeLessThanOrEqual(256 * 1024)
    expect(second.events[0]!.sequence).toBe(first.nextAfter + 1)
    expect(await repository.getRunEventSnapshot('run-1')).toMatchObject({
      openIssues: [{ id: 'issue-1' }],
      progress: [{ stepId: 'step-1', completed: 249, total: 250 }],
    })
    repository.close()
  })

  test('replays 10,000 events without gaps, duplicates, or unbounded pages', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun(run())
    await repository.transact('run-1', (transaction) => {
      for (let index = 0; index < 10_000; index++) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION, type: 'tool.progress',
          payload: { stepId: 'step-1', completed: index + 1, total: 10_000 },
        })
      }
    })

    const sequences: number[] = []
    let afterSequence = 0
    do {
      const page = await repository.readEvents('run-1', {
        afterSequence, limit: 100, maxBytes: 256 * 1024,
      })
      expect(page.events.length).toBeLessThanOrEqual(100)
      expect(page.byteLength).toBeLessThanOrEqual(256 * 1024)
      sequences.push(...page.events.map((event) => event.sequence))
      afterSequence = page.nextAfter
      if (!page.hasMore) break
    } while (true)

    expect(sequences).toEqual(Array.from({ length: 10_000 }, (_, index) => index + 1))
    expect(await repository.getRunEventSnapshot('run-1')).toMatchObject({
      openIssues: [], progress: [{ stepId: 'step-1', completed: 10_000, total: 10_000 }],
    })
    repository.close()
  })

  test('queries a bounded runnable set without returning 10,000 terminal runs', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    for (let index = 0; index < 10_000; index += 1) {
      await repository.createRun({
        ...run(),
        id: `terminal-${index.toString().padStart(5, '0')}`,
        creationKey: `terminal-create-${index}`,
        status: 'COMPLETED',
      })
    }
    for (const id of ['runnable-a', 'runnable-b', 'runnable-c']) {
      await repository.createRun({ ...run(), id, creationKey: `create-${id}` })
    }

    const candidates = await repository.listRunnableRuns({
      now: '2026-07-22T00:00:00.000Z',
      limit: 2,
    })
    expect(candidates.map((candidate) => candidate.id)).toEqual(['runnable-a', 'runnable-b'])
    repository.close()
  })

  test('keeps terminal runs with pending media visible to reconciliation', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun({ ...run(), status: 'CANCELLED' })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'waiting-step', runId: 'run-1', idempotencyKey: 'waiting-step-key', inputHash: 'waiting-input',
        tool: 'generate_slide_image', status: 'WAITING', budgetUnits: 1, budgetReservationId: 'reservation-1',
        externalOperationId: 'operation-1', errorCode: null, output: {},
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    expect(await repository.listRunnableRuns({ now: '2026-07-22T00:00:00.000Z', limit: 10 })).toEqual([])
    expect(await repository.listRunsWithPendingMedia(10)).toEqual(['run-1'])
    repository.close()
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CONTRACT_VERSION } from '../src/contracts'
import { SqliteAgentRepository } from '../src/adapters/sqlite-repository'
import type { RunRecord, StepRecord } from '../src/core/ports'

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

function waitingStep(): StepRecord {
  return {
    id: 'waiting-step',
    runId: 'run-1',
    idempotencyKey: 'waiting-step-key',
    inputHash: 'waiting-input',
    tool: 'generate_slide_image',
    status: 'WAITING',
    budgetUnits: 1,
    budgetReservationId: 'reservation-1',
    externalOperationId: 'operation-1',
    errorCode: null,
    output: {},
    createdAt: run().createdAt,
    updatedAt: run().updatedAt,
  }
}

async function databasePath() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ppt-agent-sqlite-'))
  cleanupPaths.push(directory)
  return path.join(directory, 'agent.sqlite')
}

describe('SQLite repository', () => {
  test('persists tenant revision-round settings with optimistic versioning', async () => {
    const filename = await databasePath()
    const first = new SqliteAgentRepository(filename)
    expect(await first.getTenantRevisionRoundsSettings('frameflow')).toMatchObject({ maxRevisionRounds: 2, version: 0, isConfigured: false })
    expect(await first.updateTenantRevisionRoundsSettings({
      tenantId: 'frameflow', maxRevisionRounds: 4, expectedVersion: 0,
      updatedBy: 'admin-1', updatedAt: '2026-08-02T00:00:00.000Z',
    })).toMatchObject({ maxRevisionRounds: 4, version: 1, isConfigured: true })
    first.close()

    const reopened = new SqliteAgentRepository(filename)
    expect(await reopened.getTenantRevisionRoundsSettings('frameflow')).toMatchObject({ maxRevisionRounds: 4, version: 1, isConfigured: true })
    expect(await reopened.updateTenantRevisionRoundsSettings({
      tenantId: 'frameflow', maxRevisionRounds: 1, expectedVersion: 0,
      updatedBy: 'admin-2', updatedAt: '2026-08-02T00:00:01.000Z',
    })).toBeNull()
    reopened.close()
  })
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
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PLANNING', to: 'AWAITING_BLUEPRINT_APPROVAL' },
      })
    })
    first.close()

    const legacy = new Database(filename)
    const stored = legacy.query<{ data: string }, []>('SELECT data FROM agent_events WHERE sequence = 1').get()!
    const legacyEvent = JSON.parse(stored.data) as Record<string, unknown>
    delete legacyEvent.eventId
    legacy.query('UPDATE agent_events SET data = ? WHERE sequence = 1').run(JSON.stringify(legacyEvent))
    legacy.close(true)

    const reopened = new SqliteAgentRepository(filename)
    expect(await reopened.getRun('run-1')).toMatchObject({ status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
    expect(await reopened.listSteps('run-1')).toHaveLength(1)
    expect(await reopened.listDeliveries('run-1')).toEqual([expect.objectContaining({
      id: 'delivery-1',
      disposition: 'FINAL',
      qualityStatus: 'OVERRIDDEN_INTERNAL',
      openIssueIds: [],
      identity: { status: 'LEGACY_UNVERIFIED' },
    })])
    expect((await reopened.listEvents('run-1')).map((event) => ({ sequence: event.sequence, eventId: event.eventId })))
      .toEqual([{ sequence: 1, eventId: 'run-1:event:1' }])
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

  test('finds the first terminal event without confusing later reconciliation events', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun(run())
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED', version: 1 })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.cancelled',
        payload: { reason: null, mode: 'STOP_NEW_SUBMISSIONS' },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: 'step-1', summary: 'late provider reconciliation completed' },
      })
    })

    expect(await repository.getTerminalEvent('run-1')).toMatchObject({
      sequence: 1, type: 'run.cancelled', eventId: 'run-1:event:1',
    })
    repository.close()
  })

  test('ignores an old terminal event after a persisted run resume', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun(run())
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'DECK_REVIEW', version: 2 })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.failed',
        payload: { errorCode: 'QUALITY_REMEDIATION_EXHAUSTED' },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.resumed',
        payload: { status: 'DECK_REVIEW' },
      })
    })

    expect(await repository.getTerminalEvent('run-1')).toBeNull()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'COMPLETED', version: 3 })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.completed',
        payload: { deliveryId: 'delivery-1', qualityOverride: false },
      })
    })
    expect(await repository.getTerminalEvent('run-1')).toMatchObject({ sequence: 3, type: 'run.completed' })
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

  test('selects only due technical recoveries without starving active runs', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun({
      ...run(), id: 'future-recovery', creationKey: 'future-recovery-create', status: 'RECOVERING',
      technicalRecovery: {
        resumeState: 'EXECUTING', reason: 'PROVIDER_TIMEOUT', retryable: true,
        attempt: 1, maxAttempts: 5, nextAttemptAt: '2026-07-22T00:01:00.000Z', active: true,
      },
    })
    await repository.createRun({ ...run(), id: 'executing', creationKey: 'executing-create' })

    expect((await repository.listRunnableRuns({ now: '2026-07-22T00:00:00.000Z', limit: 2 }))
      .map((candidate) => candidate.id)).toEqual(['executing'])
    expect((await repository.listRunnableRuns({ now: '2026-07-22T00:01:00.000Z', limit: 2 }))
      .map((candidate) => candidate.id)).toEqual(['executing', 'future-recovery'])
    repository.close()
  })

  test('uses the owner index for stable keyset pages', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun({ ...run(), id: 'run-a', creationKey: 'create-a' })
    await repository.createRun({ ...run(), id: 'run-b', creationKey: 'create-b' })
    await repository.createRun({
      ...run(), id: 'run-c', creationKey: 'create-c', updatedAt: '2026-07-22T00:00:00.000Z',
    })
    await repository.createRun({
      ...run(), id: 'other-user', creationKey: 'create-other', host: { ...run().host, externalUserId: 'user-2' },
    })

    const first = await repository.listOwnedRuns({ host: run().host, after: null, limit: 2 })
    expect(first.runs.map((item) => item.id)).toEqual(['run-c', 'run-b'])
    expect(first.hasMore).toBe(true)
    const second = await repository.listOwnedRuns({
      host: run().host,
      after: { id: first.runs[1]!.id, updatedAt: first.runs[1]!.updatedAt },
      limit: 2,
    })
    expect(second.runs.map((item) => item.id)).toEqual(['run-a'])
    expect(second.hasMore).toBe(false)
    repository.close()

    const database = new Database(filename, { readonly: true, strict: true })
    const plan = database.query<{ detail: string }, [string, string, number]>(`
      EXPLAIN QUERY PLAN
      SELECT data FROM agent_runs
      WHERE tenant_id = ? AND external_user_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all('frameflow', 'user-1', 3)
    expect(plan.map((row) => row.detail).join('\n')).toContain('agent_runs_owner_page_idx')
    database.close(true)
  })

  test('backfills legacy query columns once without rewriting complete rows on reopen', async () => {
    const filename = await databasePath()
    const legacy = new Database(filename, { create: true, readwrite: true, strict: true })
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE agent_runs (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE agent_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
        UNIQUE (run_id, idempotency_key)
      ) STRICT;
    `)
    const legacyRun = run()
    const legacyStep = waitingStep()
    legacy.query<unknown, [string, string]>('INSERT INTO agent_runs (id, data) VALUES (?, ?)')
      .run(legacyRun.id, JSON.stringify(legacyRun))
    legacy.query<unknown, [string, string, string, string]>(
      'INSERT INTO agent_steps (id, run_id, idempotency_key, data) VALUES (?, ?, ?, ?)',
    ).run(legacyStep.id, legacyStep.runId, legacyStep.idempotencyKey, JSON.stringify(legacyStep))
    legacy.close(true)

    const migrated = new SqliteAgentRepository(filename)
    expect(await migrated.listOwnedRuns({ host: legacyRun.host, after: null, limit: 10 }))
      .toMatchObject({ runs: [{ id: 'run-1' }], hasMore: false })
    expect(await migrated.listRunsWithPendingMedia(10)).toEqual(['run-1'])
    migrated.close()

    const audit = new Database(filename, { readwrite: true, strict: true })
    audit.exec(`
      CREATE TABLE migration_update_audit (
        table_name TEXT PRIMARY KEY,
        update_count INTEGER NOT NULL
      ) STRICT;
      INSERT INTO migration_update_audit VALUES ('agent_runs', 0), ('agent_steps', 0);
      CREATE TRIGGER audit_agent_runs_update AFTER UPDATE ON agent_runs BEGIN
        UPDATE migration_update_audit SET update_count = update_count + 1 WHERE table_name = 'agent_runs';
      END;
      CREATE TRIGGER audit_agent_steps_update AFTER UPDATE ON agent_steps BEGIN
        UPDATE migration_update_audit SET update_count = update_count + 1 WHERE table_name = 'agent_steps';
      END;
    `)
    audit.close(true)

    const reopened = new SqliteAgentRepository(filename)
    reopened.close()
    const verified = new Database(filename, { readonly: true, strict: true })
    const updates = verified.query<{ table_name: string; update_count: number }, []>(
      'SELECT table_name, update_count FROM migration_update_audit ORDER BY table_name',
    ).all()
    expect(updates).toEqual([
      { table_name: 'agent_runs', update_count: 0 },
      { table_name: 'agent_steps', update_count: 0 },
    ])
    verified.close(true)
  })

  test('keeps terminal runs with pending media visible to reconciliation', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun({ ...run(), status: 'CANCELLED' })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep(waitingStep())
    })

    expect(await repository.listRunnableRuns({ now: '2026-07-22T00:00:00.000Z', limit: 10 })).toEqual([])
    expect(await repository.listRunsWithPendingMedia(10)).toEqual(['run-1'])
    repository.close()
  })

  test('keeps an interrupted image submission visible to terminal reconciliation', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun({ ...run(), status: 'CANCELLED' })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({ ...waitingStep(), status: 'SUBMITTING', externalOperationId: null })
    })

    expect(await repository.listRunsWithPendingMedia(10)).toEqual(['run-1'])
    repository.close()
  })

  test('keeps billing-unknown media with a known Provider operation visible to reconciliation', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun({ ...run(), status: 'NEEDS_HUMAN' })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({ ...waitingStep(), status: 'BILLING_UNKNOWN', errorCode: 'RATE_LIMITED' })
    })

    expect(await repository.listRunsWithPendingMedia(10)).toEqual(['run-1'])
    repository.close()
  })

  test('keeps a billing-unknown V4 batch finalization visible without a pending page media operation', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun({ ...run(), status: 'CANCELLED' })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        ...waitingStep(), tool: 'generate_image_batch', status: 'BILLING_UNKNOWN',
        idempotencyKey: 'run-1:generation-batch:r0', externalOperationId: null,
      })
    })

    expect(await repository.listRunsWithPendingMedia(10)).toEqual(['run-1'])
    repository.close()
  })

  test('keeps terminal runs with interrupted host releases visible to reconciliation', async () => {
    const filename = await databasePath()
    const repository = new SqliteAgentRepository(filename)
    await repository.createRun({ ...run(), status: 'CANCELLED' })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        ...waitingStep(),
        status: 'RELEASING',
        errorCode: 'PROVIDER_REJECTED',
      })
    })

    expect(await repository.listRunnableRuns({ now: '2026-07-22T00:00:00.000Z', limit: 10 })).toEqual([])
    expect(await repository.listRunsWithPendingMedia(10)).toEqual(['run-1'])
    repository.close()
  })
})

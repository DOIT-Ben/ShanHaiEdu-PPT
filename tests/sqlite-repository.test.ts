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
})

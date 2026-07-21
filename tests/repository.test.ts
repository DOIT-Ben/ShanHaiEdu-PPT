import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import type { RunRecord } from '../src/core/ports'

function run(): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于 Repository 测试的完整教材内容。' },
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

describe('in-memory repository contract', () => {
  test('commits run, step and monotonic events together', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())

    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, version: 1, status: 'AWAITING_BLUEPRINT_APPROVAL' })
      transaction.putStep({
        id: 'step-1',
        runId: 'run-1',
        idempotencyKey: 'plan:run-1',
        inputHash: 'planning-input-hash',
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
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'BLUEPRINT', summary: '请确认逐页教学蓝图' },
      })
    })

    expect(await repository.getRun('run-1')).toMatchObject({ version: 1, status: 'AWAITING_BLUEPRINT_APPROVAL' })
    expect(await repository.listSteps('run-1')).toHaveLength(1)
    expect(await repository.listDeliveries('run-1')).toHaveLength(1)
    expect((await repository.listEvents('run-1')).map((event) => event.sequence)).toEqual([1, 2])
    expect((await repository.listEvents('run-1', 1)).map((event) => event.sequence)).toEqual([2])
  })

  test('rolls back all mutations when an operation fails', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())

    await expect(repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, version: 1, status: 'FAILED' })
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

    expect(await repository.getRun('run-1')).toMatchObject({ version: 0, status: 'PLANNING' })
    expect(await repository.listEvents('run-1')).toEqual([])
    expect(await repository.listDeliveries('run-1')).toEqual([])
  })
})

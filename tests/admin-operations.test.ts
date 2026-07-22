import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockBudgetPort, MockImageGenerationPort } from '../src/adapters/mock-ports'
import { AdminOperationsService } from '../src/core/admin-operations'
import { MediaStepRunner } from '../src/core/media-step-runner'
import type { RunRecord, StepRecord } from '../src/core/ports'

function run(): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-run-1', requestHash: 'hash',
    host: { tenantId: 'frameflow', externalUserId: 'teacher-1' },
    source: { kind: 'TEXT', text: '管理员对账测试教材内容'.repeat(3) }, slideCount: 2,
    visualDirection: '课堂视觉', imageModel: 'image-2', automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2, revisionRound: 0, qualityScore: null, status: 'NEEDS_HUMAN',
    resumeState: null, version: 1, budgetUnits: 10, committedBudgetUnits: 4,
    qualityOverride: false, qualityOverrideReason: null, qualityOverrideBy: null,
    leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function target(status: StepRecord['status']): StepRecord {
  return {
    id: 'step-image-1', runId: 'run-1', idempotencyKey: 'run-1:image-1', inputHash: 'image-hash',
    tool: 'generate_slide_image', status, budgetUnits: 4, budgetReservationId: 'reservation-1',
    externalOperationId: 'operation-1', errorCode: 'PROVIDER_STATE_UNKNOWN',
    output: { slideId: 'slide-1', versionId: 'slide-1:v1' },
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

async function fixture(status: StepRecord['status']) {
  const repository = new InMemoryAgentRepository()
  const budget = new MockBudgetPort()
  const images = new MockImageGenerationPort()
  const clock = new FixedClock()
  await repository.createRun(run())
  await repository.transact('run-1', (transaction) => transaction.putStep(target(status)))
  const media = new MediaStepRunner({ repository, budget, images, clock })
  const service = new AdminOperationsService({ repository, budget, media, clock })
  const base = {
    host: { tenantId: 'frameflow', externalUserId: 'admin-1', role: 'ADMIN' as const },
    runId: 'run-1', stepId: 'step-image-1', expectedVersion: 1,
    idempotencyKey: 'admin-action-1', reason: '已核对供应商后台工单 20260721。',
  }
  return { repository, budget, images, service, base }
}

describe('admin operations service', () => {
  test('marks an unknown submission not charged exactly once and releases both budgets', async () => {
    const { repository, budget, service, base } = await fixture('SUBMISSION_UNKNOWN')
    const first = await service.act({ ...base, action: 'MARK_NOT_CHARGED' })
    const replay = await service.act({ ...base, action: 'MARK_NOT_CHARGED' })

    expect(first).toMatchObject({ replayed: false, step: { status: 'FAILED_NOT_CHARGED' } })
    expect(replay).toMatchObject({ replayed: true, step: { status: 'FAILED_NOT_CHARGED' } })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0, version: 2 })
    expect(budget.released).toEqual(new Set(['reservation-1']))
    expect((await repository.listEvents('run-1')).filter((event) => event.type === 'approval.resolved')).toHaveLength(1)
    expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'admin_reconciliation')).toHaveLength(1)
  })

  test('marks unknown billing charged without releasing reserved budget', async () => {
    const { repository, budget, service, base } = await fixture('BILLING_UNKNOWN')
    const result = await service.act({ ...base, action: 'MARK_CHARGED' })

    expect(result.step.status).toBe('FAILED_CHARGED')
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 4, version: 2 })
    expect(budget.settled).toEqual(new Set(['reservation-1']))
    expect(budget.released.size).toBe(0)
  })

  test('reinspects a late Provider result and records an audited completion', async () => {
    const { repository, budget, images, service, base } = await fixture('WAITING')
    images.statuses.set('operation-1', { state: 'COMPLETED', artifactId: 'artifact-1' })
    const result = await service.act({ ...base, action: 'REINSPECT' })

    expect(result.step).toMatchObject({ status: 'COMPLETED', output: { artifactId: 'artifact-1' } })
    expect(budget.settled).toEqual(new Set(['reservation-1']))
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.resolved')).toBe(true)
  })

  test('allows only one concurrent accounting decision for a Run', async () => {
    const { service, base } = await fixture('BILLING_UNKNOWN')
    const results = await Promise.allSettled([
      service.act({ ...base, idempotencyKey: 'admin-charged', action: 'MARK_CHARGED' }),
      service.act({ ...base, idempotencyKey: 'admin-not-charged', action: 'MARK_NOT_CHARGED' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected').map((result) =>
      result.status === 'rejected' ? result.reason.code : null)).toEqual(['ADMIN_ACTION_IN_PROGRESS'])
  })
})

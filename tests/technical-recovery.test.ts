import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import type { RunRecord } from '../src/core/ports'
import { beginTechnicalRecovery, isTechnicalFailureCode, resumeTechnicalRecovery } from '../src/core/technical-recovery'

function run(): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '用于验证技术恢复上限的完整教材内容。' },
    slideCount: 2,
    visualDirection: '清晰课堂信息图',
    imageModel: 'gpt-image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'EXECUTING',
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
    presentationMode: 'VISUAL_DECK_V4',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

describe('technical recovery', () => {
  test('stops retrying after the fifth transient failure without requesting user approval', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    await repository.createRun(run())

    const errorCodes = ['PROVIDER_TIMEOUT', 'GATEWAY_HTTP_500', 'RATE_LIMITED', 'NETWORK_TIMEOUT', 'PROVIDER_TIMEOUT']
    for (const [index, errorCode] of errorCodes.entries()) {
      const attempt = index + 1
      await repository.transact('run-1', (transaction) => beginTechnicalRecovery(transaction, clock, errorCode))
      if (attempt === 5) break
      expect(await repository.getRun('run-1')).toMatchObject({ status: 'RECOVERING', technicalRecovery: { attempt, active: true } })
      clock.advance(60_000)
      await repository.transact('run-1', (transaction) => resumeTechnicalRecovery(transaction, clock))
    }

    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'FAILED',
      technicalRecovery: { attempt: 5, reason: 'PROVIDER_TIMEOUT', retryable: false, active: false, nextAttemptAt: null },
    })
    const events = await repository.listEvents('run-1')
    expect(events).toContainEqual(expect.objectContaining({
      type: 'technical.recovery.completed', payload: expect.objectContaining({ attempt: 5, active: false }),
    }))
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'TECHNICAL_RECOVERY_EXHAUSTED' },
    })
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('routes model authorization failures to administrator technical handling without user approval', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    await repository.createRun(run())

    await repository.transact('run-1', (transaction) => beginTechnicalRecovery(transaction, clock, 'MODEL_FORBIDDEN'))

    expect(isTechnicalFailureCode('MODEL_FORBIDDEN')).toBe(true)
    expect(isTechnicalFailureCode('AUTHORIZATION_CAP_REACHED')).toBe(false)
    expect(isTechnicalFailureCode('PROVIDER_SAFETY_CAP_REACHED')).toBe(false)
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'FAILED',
      technicalRecovery: {
        reason: 'MODEL_FORBIDDEN', retryable: false, active: false, nextAttemptAt: null,
      },
    })
    const events = await repository.listEvents('run-1')
    expect(events).toContainEqual(expect.objectContaining({
      type: 'phase.changed',
      payload: expect.objectContaining({ to: 'FAILED', reason: 'TECHNICAL_CONFIGURATION_REQUIRED' }),
    }))
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
    })
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('treats an oversized Chain-4 manuscript as a non-retryable contract failure', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    await repository.createRun(run())

    await repository.transact('run-1', (transaction) => beginTechnicalRecovery(
      transaction,
      clock,
      'V4_MANUSCRIPT_CONTEXT_TOO_LARGE',
    ))

    expect(isTechnicalFailureCode('V4_MANUSCRIPT_CONTEXT_TOO_LARGE')).toBe(true)
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'FAILED',
      technicalRecovery: { reason: 'V4_MANUSCRIPT_CONTEXT_TOO_LARGE', retryable: false, active: false },
    })
    expect((await repository.listEvents('run-1')).at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'V4_MANUSCRIPT_CONTEXT_TOO_LARGE' },
    })
  })

  test('defers a non-retryable technical failure while provider accounting is unknown', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    await repository.createRun({ ...run(), committedBudgetUnits: 1 })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-image-1', runId: 'run-1', idempotencyKey: 'run-1:slide:1:image:r0:v1',
        inputHash: 'image-1', tool: 'generate_slide_image', status: 'WAITING', budgetUnits: 1,
        budgetReservationId: 'reservation-1', externalOperationId: 'provider-operation-1',
        errorCode: null, output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      beginTechnicalRecovery(transaction, clock, 'MODEL_FORBIDDEN')
    })

    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING',
      pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
      terminalAccounting: { accountingStatus: 'RECONCILIATION_REQUIRED' },
      technicalRecovery: { reason: 'TERMINAL_ACCOUNTING_PENDING', active: true },
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })
})

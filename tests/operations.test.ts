import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION, type KnownAgentEvent as AgentEvent } from '../src/contracts'
import { buildOperationsReport } from '../src/core/operations'
import type { OperationsFilters, RunRecord, StepRecord } from '../src/core/ports'

function run(id: string, status: RunRecord['status'], user: string): RunRecord {
  return {
    id, creationKey: `create-${id}`, requestHash: `hash-${id}`,
    host: { tenantId: 'frameflow', externalUserId: user }, source: { kind: 'TEXT', text: '测试教材内容'.repeat(5) },
    slideCount: 2, visualDirection: '课堂视觉', imageModel: 'image-2', automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2, revisionRound: 0, qualityScore: null, status, resumeState: null, version: 2,
    budgetUnits: 10, committedBudgetUnits: status === 'COMPLETED' ? 0 : 2,
    qualityOverride: false, qualityOverrideReason: null, qualityOverrideBy: null,
    leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:20:00.000Z',
  }
}

function step(input: Partial<StepRecord> & Pick<StepRecord, 'id' | 'runId' | 'status'>): StepRecord {
  return {
    idempotencyKey: `key-${input.id}`, inputHash: `hash-${input.id}`, tool: 'generate_slide_image',
    budgetUnits: 1, budgetReservationId: `reservation-${input.id}`, externalOperationId: `operation-${input.id}`,
    errorCode: null, output: null, createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:05:00.000Z', ...input,
  }
}

const filters: OperationsFilters = {
  tenantId: 'frameflow', status: null, externalUserId: null, errorCode: null,
  createdFrom: null, createdTo: null, offset: 0, limit: 50,
  now: '2026-07-22T01:00:00.000Z', waitingSlaMs: 15 * 60_000, stepSlaMs: 30 * 60_000,
}

function phaseEvent(runId: string, sequence: number, createdAt: string, from: RunRecord['status'], to: RunRecord['status']): AgentEvent {
  return {
    schemaVersion: CONTRACT_VERSION, id: `${runId}:event:${sequence}`, eventId: `${runId}:event:${sequence}`, runId, sequence, createdAt,
    type: 'phase.changed', payload: { from, to },
  }
}

function startedEvent(runId: string): AgentEvent {
  return {
    schemaVersion: CONTRACT_VERSION, id: `${runId}:event:1`, eventId: `${runId}:event:1`, runId, sequence: 1,
    createdAt: '2026-07-22T00:00:00.000Z', type: 'run.started', payload: { status: 'PLANNING' },
  }
}

describe('operations report', () => {
  test('builds filtered Runs, SLA queue, reconciliation queue, and service metrics', () => {
    const report = buildOperationsReport({
      runs: [run('run-success', 'COMPLETED', 'teacher-1'), run('run-failed', 'FAILED', 'teacher-2')],
      steps: [
        step({ id: 'step-complete', runId: 'run-success', status: 'COMPLETED', updatedAt: '2026-07-22T00:01:00.000Z' }),
        step({ id: 'step-timeout', runId: 'run-failed', status: 'FAILED', errorCode: 'PROVIDER_TIMEOUT' }),
        step({ id: 'step-waiting', runId: 'run-failed', status: 'WAITING' }),
        step({ id: 'step-billing', runId: 'run-failed', status: 'BILLING_UNKNOWN', errorCode: 'PROVIDER_FAILED' }),
      ],
      events: [
        startedEvent('run-success'),
        phaseEvent('run-success', 2, '2026-07-22T00:01:00.000Z', 'PLANNING', 'EXECUTING'),
        phaseEvent('run-success', 3, '2026-07-22T00:03:00.000Z', 'EXECUTING', 'COMPLETED'),
      ],
      filters,
    })

    expect(report.totalRuns).toBe(2)
    expect(report.metrics.successRate).toBe(0.5)
    expect(report.metrics.providerFailureRate).toBe(2 / 3)
    expect(report.metrics.unknownBillingCount).toBe(1)
    expect(report.metrics.phaseLatencyMs.PLANNING?.p50).toBe(60_000)
    expect(report.metrics.phaseLatencyMs.EXECUTING?.p50).toBe(120_000)
    expect(report.reconciliation).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'run-failed:step-waiting:WAITING_TOO_LONG', allowedActions: ['REINSPECT'] }),
      expect.objectContaining({ id: 'run-failed:step-billing:PROVIDER_FAILED', allowedActions: ['REINSPECT', 'MARK_NOT_CHARGED', 'MARK_CHARGED'] }),
    ]))
  })

  test('filters by user, status, error, and time without crossing tenants', () => {
    const otherTenant = { ...run('run-other', 'FAILED', 'teacher-2'), host: { tenantId: 'other', externalUserId: 'teacher-2' } }
    const report = buildOperationsReport({
      runs: [run('run-success', 'COMPLETED', 'teacher-1'), run('run-failed', 'FAILED', 'teacher-2'), otherTenant],
      steps: [step({ id: 'step-timeout', runId: 'run-failed', status: 'FAILED', errorCode: 'PROVIDER_TIMEOUT' })],
      events: [],
      filters: {
        ...filters, externalUserId: 'teacher-2', status: 'FAILED', errorCode: 'PROVIDER_TIMEOUT',
        createdFrom: '2026-07-22T00:00:00.000Z', createdTo: '2026-07-22T23:59:59.999Z',
      },
    })

    expect(report.totalRuns).toBe(1)
    expect(report.runs).toEqual([expect.objectContaining({ id: 'run-failed', lastErrorCode: 'PROVIDER_TIMEOUT' })])
  })

  test('offers only a no-charge resolution when host reservation is unknown', () => {
    const report = buildOperationsReport({
      runs: [run('run-reservation', 'NEEDS_HUMAN', 'teacher-1')],
      steps: [step({
        id: 'step-reservation', runId: 'run-reservation', status: 'RESERVATION_UNKNOWN',
        budgetReservationId: null, externalOperationId: null, errorCode: 'HOST_BUDGET_RESERVATION_UNKNOWN',
      })],
      events: [],
      filters,
    })

    expect(report.reconciliation).toEqual([
      expect.objectContaining({ status: 'RESERVATION_UNKNOWN', allowedActions: ['MARK_NOT_CHARGED'] }),
    ])
  })
})

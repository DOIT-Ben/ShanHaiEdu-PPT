import { describe, expect, test } from 'bun:test'
import { FrameFlowUsageAccountingAdapter } from '../src/adapters/frameflow-usage-accounting'
import type { UsageOperationEventV2, UsageRunBill } from '../src/usage-accounting-contracts'

const host = { tenantId: 'frameflow', externalUserId: 'teacher-1' }

function bill(status: UsageRunBill['status'] = 'ACTIVE'): UsageRunBill {
  return {
    pptRunId: 'run-1', authorizationReservationId: 'authorization-1', accountingMode: 'USAGE_V2', status,
    authorizationCapMilli: 300_000, authorizedModel: 'gpt-image-2', authorizedUnits: 30,
    pricingVersion: 'ppt-image-v1', unitPriceMilli: 10_000, providerSpendSafetyCapOperations: 30,
    generatedOperations: 1, chargedOperations: 0, notChargedOperations: 0, unknownOperations: 1,
    chargeableMilli: 0, settledMilli: 0, releasedMilli: 0, providerCosts: [], lastEventSequence: 1,
    lastEventAt: '2026-08-03T07:00:00.000Z', settledAt: null,
    firstUnknownAt: '2026-08-03T07:00:00.000Z', reconciliationAttempts: 0,
    nextReconcileAt: null, reconciliationDeadlineAt: null, reconciliationLastError: null,
  }
}

const observed: UsageOperationEventV2 = {
  schemaVersion: '2', eventId: 'event-1', sequence: 1, eventType: 'OPERATION_OBSERVED',
  pptRunId: 'run-1', batchId: 'batch-1', pageNumber: 1, revisionRound: 0,
  idempotencyKey: 'operation-1', providerOperationId: 'provider-1', model: 'gpt-image-2', status: 'PROCESSING',
  providerBilling: {
    result: 'UNKNOWN', estimatedCostAmountMicros: 40_000, currency: 'USD', pricingVersion: 'provider-v1',
  },
  operationCreatedAt: '2026-08-03T07:00:00.000Z', operationCompletedAt: null,
  eventAt: '2026-08-03T07:00:00.000Z',
}

describe('FrameFlow Usage V2 accounting adapter', () => {
  test('maps the host-neutral Usage port to the FrameFlow backend without changing identities', async () => {
    const calls: { method: string; input: unknown }[] = []
    const adapter = new FrameFlowUsageAccountingAdapter({
      async authorizeUsageOperation(input) {
        calls.push({ method: 'permit', input: structuredClone(input) })
        return { allowed: true, permitId: 'permit-1', pricingVersion: 'ppt-image-v1', userPriceMilli: 10_000 }
      },
      async ingestUsageEvent(input) {
        calls.push({ method: 'event', input: structuredClone(input) })
        return { replayed: false, bill: bill() }
      },
      async getUsageRunBill(input) {
        calls.push({ method: 'bill', input: structuredClone(input) })
        return bill()
      },
      async finalizeUsageRun(input) {
        calls.push({ method: 'finalize', input: structuredClone(input) })
        return bill('SETTLED')
      },
    })

    await adapter.authorizeOperation({
      host, runId: 'run-1', operationIdempotencyKey: 'operation-1', pageNumber: 1, revisionRound: 0, model: 'gpt-image-2',
    })
    await adapter.ingestEvent({ host, event: observed })
    await adapter.getRunBill({ host, runId: 'run-1' })
    await adapter.finalizeRun({ host, runId: 'run-1', idempotencyKey: 'finalize:run-1' })

    expect(calls).toEqual([
      { method: 'permit', input: {
        externalUserId: 'teacher-1', runId: 'run-1', operationIdempotencyKey: 'operation-1',
        pageNumber: 1, revisionRound: 0, model: 'gpt-image-2',
      } },
      { method: 'event', input: { externalUserId: 'teacher-1', event: observed } },
      { method: 'bill', input: { externalUserId: 'teacher-1', runId: 'run-1' } },
      { method: 'finalize', input: {
        externalUserId: 'teacher-1', runId: 'run-1', idempotencyKey: 'finalize:run-1',
      } },
    ])
  })

  test('rejects a non-FrameFlow host before any backend call', async () => {
    let calls = 0
    const adapter = new FrameFlowUsageAccountingAdapter({
      async authorizeUsageOperation() { calls += 1; throw new Error('unexpected') },
      async ingestUsageEvent() { calls += 1; throw new Error('unexpected') },
      async getUsageRunBill() { calls += 1; throw new Error('unexpected') },
      async finalizeUsageRun() { calls += 1; throw new Error('unexpected') },
    })

    await expect(adapter.getRunBill({
      host: { tenantId: 'shanhai', externalUserId: 'teacher-1' }, runId: 'run-1',
    })).rejects.toThrow('FRAMEFLOW_TENANT_REQUIRED')
    expect(calls).toBe(0)
  })
})

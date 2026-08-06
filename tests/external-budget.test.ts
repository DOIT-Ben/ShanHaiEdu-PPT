import { describe, expect, test } from 'bun:test'
import { ExternallyAuthorizedBudgetPort } from '../src/adapters/external-budget'

const host = { tenantId: 'shanhai', externalUserId: 'task-123' }

describe('externally authorized budget port', () => {
  test('returns a deterministic reservation for an explicitly configured tenant', async () => {
    const budget = new ExternallyAuthorizedBudgetPort('shanhai')
    const input = { host, model: 'gemini-3-pro-image-preview', units: 2, idempotencyKey: 'run-1:slide-1' }
    const first = await budget.reserve(input)
    const replay = await budget.reserve(input)

    expect(replay).toEqual(first)
    expect(first.reservationId).toMatch(/^external-budget:[a-f0-9]{64}$/)
    await budget.settle({ host, reservationId: first.reservationId, idempotencyKey: 'settle-1' })
    await budget.release({ host, reservationId: first.reservationId, idempotencyKey: 'release-1' })
  })

  test('rejects cross-tenant use and unknown reservations', async () => {
    const budget = new ExternallyAuthorizedBudgetPort('shanhai')
    await expect(budget.reserve({
      host: { tenantId: 'frameflow', externalUserId: 'user-1' },
      model: 'gemini-3-pro-image-preview',
      units: 1,
      idempotencyKey: 'cross-tenant',
    })).rejects.toThrow('EXTERNAL_BUDGET_TENANT_MISMATCH')
    await expect(budget.settle({
      host,
      reservationId: 'frameflow-credit-1',
      idempotencyKey: 'settle-invalid',
    })).rejects.toThrow('EXTERNAL_BUDGET_RESERVATION_INVALID')
  })
})

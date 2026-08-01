import { createHash } from 'node:crypto'
import type { BatchBudgetPort, BudgetPort } from '../core/ports'

const TENANT_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/

export class ExternallyAuthorizedBudgetPort implements BudgetPort, BatchBudgetPort {
  constructor(private readonly tenantId: string) {
    if (!TENANT_PATTERN.test(tenantId)) throw new Error('EXTERNAL_BUDGET_TENANT_INVALID')
  }

  async reserve(input: Parameters<BudgetPort['reserve']>[0]) {
    this.requireTenant(input.host.tenantId)
    const digest = createHash('sha256')
      .update([input.host.tenantId, input.host.externalUserId, input.model, String(input.units), input.idempotencyKey].join('\0'))
      .digest('hex')
    return { reservationId: `external-budget:${digest}` }
  }

  async preflightBatchFinalization(input: Parameters<BatchBudgetPort['preflightBatchFinalization']>[0]) {
    this.requireTenant(input.host.tenantId)
  }

  async settle(input: Parameters<BudgetPort['settle']>[0]) {
    this.requireReservation(input.host.tenantId, input.reservationId)
  }

  async release(input: Parameters<BudgetPort['release']>[0]) {
    this.requireReservation(input.host.tenantId, input.reservationId)
  }

  async reserveBatch(input: Parameters<BatchBudgetPort['reserveBatch']>[0]) {
    return this.reserve(input)
  }

  async finalizeBatch(input: Parameters<BatchBudgetPort['finalizeBatch']>[0]) {
    this.requireReservation(input.host.tenantId, input.reservationId)
    if (input.settledUnits < 0 || input.releasedUnits < 0) throw new Error('EXTERNAL_BATCH_FINALIZATION_UNITS_INVALID')
  }

  private requireTenant(tenantId: string) {
    if (tenantId !== this.tenantId) throw new Error('EXTERNAL_BUDGET_TENANT_MISMATCH')
  }

  private requireReservation(tenantId: string, reservationId: string) {
    this.requireTenant(tenantId)
    if (!/^external-budget:[a-f0-9]{64}$/.test(reservationId)) {
      throw new Error('EXTERNAL_BUDGET_RESERVATION_INVALID')
    }
  }
}

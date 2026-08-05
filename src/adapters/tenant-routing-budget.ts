import type { HostContext } from '../contracts'
import type { BatchBudgetPort, BudgetPort } from '../core/ports'

type Budget = BudgetPort & BatchBudgetPort

export class TenantRoutingBudgetPort implements BudgetPort, BatchBudgetPort {
  constructor(private readonly dependencies: Readonly<{
    routedTenantId: string
    routed: Budget
    fallback: Budget
  }>) {}

  reserve(input: Parameters<BudgetPort['reserve']>[0]) {
    return this.port(input.host).reserve(input)
  }

  settle(input: Parameters<BudgetPort['settle']>[0]) {
    return this.port(input.host).settle(input)
  }

  release(input: Parameters<BudgetPort['release']>[0]) {
    return this.port(input.host).release(input)
  }

  preflightBatchFinalization(input: Parameters<BatchBudgetPort['preflightBatchFinalization']>[0]) {
    return this.port(input.host).preflightBatchFinalization(input)
  }

  reserveBatch(input: Parameters<BatchBudgetPort['reserveBatch']>[0]) {
    return this.port(input.host).reserveBatch(input)
  }

  finalizeBatch(input: Parameters<BatchBudgetPort['finalizeBatch']>[0]) {
    return this.port(input.host).finalizeBatch(input)
  }

  private port(host: HostContext) {
    return host.tenantId === this.dependencies.routedTenantId
      ? this.dependencies.routed
      : this.dependencies.fallback
  }
}

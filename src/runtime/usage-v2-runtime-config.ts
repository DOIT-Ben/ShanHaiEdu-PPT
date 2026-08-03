import { parseProviderBillingCatalog } from '../adapters/provider-billing-catalog'
import type { RunRecord } from '../core/ports'
import {
  usageAccountingProtocolSchema,
  type UsageAccountingProtocol,
} from '../usage-accounting-contracts'

type Environment = Readonly<Record<string, string | undefined>>

export function resolveUsageV2RuntimeConfig(
  environment: Environment,
  persistedRuns: readonly Pick<RunRecord, 'id' | 'accountingProtocol'>[],
) {
  const rawProtocol = environment.PPT_AGENT_FRAMEFLOW_ACCOUNTING_PROTOCOL?.trim()
    || 'LEGACY_RESERVATION_V1'
  const parsedProtocol = usageAccountingProtocolSchema.safeParse(rawProtocol)
  if (!parsedProtocol.success) throw new Error('PPT_AGENT_FRAMEFLOW_ACCOUNTING_PROTOCOL_INVALID')
  const defaultAccountingProtocol: UsageAccountingProtocol = parsedProtocol.data
  const requiresUsageV2Runtime = defaultAccountingProtocol === 'FRAMEFLOW_USAGE_V2'
    || persistedRuns.some((run) => run.accountingProtocol === 'FRAMEFLOW_USAGE_V2')
  const providerBillingCatalog = requiresUsageV2Runtime
    ? parseProviderBillingCatalog(environment.PPT_AGENT_PROVIDER_BILLING_CATALOG_JSON)
    : null
  return { defaultAccountingProtocol, requiresUsageV2Runtime, providerBillingCatalog }
}

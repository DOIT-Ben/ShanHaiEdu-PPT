import { describe, expect, test } from 'bun:test'
import { resolveUsageV2RuntimeConfig } from '../src/runtime/usage-v2-runtime-config'

const catalog = JSON.stringify({ schemaVersion: '1', entries: [{
  model: 'gpt-image-2', operationMode: 'IMAGE_EDIT', resolution: '1K', costBasis: 'FIXED_PER_OPERATION',
  costAmountMicros: 40_000, currency: 'USD', providerPricingVersion: 'gpt-image-2-2026-08',
}] })

describe('Usage V2 runtime configuration', () => {
  test('defaults new Runs to V1 without requiring a Usage dependency', () => {
    expect(resolveUsageV2RuntimeConfig({}, [])).toEqual({
      defaultAccountingProtocol: 'LEGACY_RESERVATION_V1',
      requiresUsageV2Runtime: false,
      providerBillingCatalog: null,
    })
  })

  test('requires and parses a fixed Provider billing catalog when V2 is enabled', () => {
    const resolved = resolveUsageV2RuntimeConfig({
      PPT_AGENT_FRAMEFLOW_ACCOUNTING_PROTOCOL: 'FRAMEFLOW_USAGE_V2',
      PPT_AGENT_PROVIDER_BILLING_CATALOG_JSON: catalog,
    }, [])

    expect(resolved.providerBillingCatalog?.snapshot({
      model: 'gpt-image-2', operationMode: 'IMAGE_EDIT', resolution: '1K', aspectRatio: '16:9',
    })).toMatchObject({ costAmountMicros: 40_000, providerPricingVersion: 'gpt-image-2-2026-08' })
    expect(resolved).toMatchObject({
      defaultAccountingProtocol: 'FRAMEFLOW_USAGE_V2', requiresUsageV2Runtime: true,
      providerBillingCatalog: expect.any(Object),
    })
  })

  test('keeps V2 recovery dependencies required after the default is switched back to V1', () => {
    const persisted = [{ id: 'run-1', accountingProtocol: 'FRAMEFLOW_USAGE_V2' as const }]
    expect(resolveUsageV2RuntimeConfig({ PPT_AGENT_PROVIDER_BILLING_CATALOG_JSON: catalog }, persisted))
      .toMatchObject({
        defaultAccountingProtocol: 'LEGACY_RESERVATION_V1', requiresUsageV2Runtime: true,
        providerBillingCatalog: expect.any(Object),
      })
  })

  test('fails closed for an invalid protocol or a missing recovery catalog', () => {
    expect(() => resolveUsageV2RuntimeConfig({
      PPT_AGENT_FRAMEFLOW_ACCOUNTING_PROTOCOL: 'AUTO',
    }, [])).toThrow('PPT_AGENT_FRAMEFLOW_ACCOUNTING_PROTOCOL_INVALID')
    expect(() => resolveUsageV2RuntimeConfig({
      PPT_AGENT_FRAMEFLOW_ACCOUNTING_PROTOCOL: 'FRAMEFLOW_USAGE_V2',
    }, [])).toThrow('PROVIDER_BILLING_CATALOG_INVALID')
    expect(() => resolveUsageV2RuntimeConfig({}, [
      { id: 'run-1', accountingProtocol: 'FRAMEFLOW_USAGE_V2' },
    ])).toThrow('PROVIDER_BILLING_CATALOG_INVALID')
  })
})

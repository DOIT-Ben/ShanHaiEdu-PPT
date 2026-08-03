import { describe, expect, test } from 'bun:test'
import { parseProviderBillingCatalog } from '../src/adapters/provider-billing-catalog'

const catalogJson = JSON.stringify({
  schemaVersion: '1',
  entries: [
    {
      model: 'nanobanana',
      operationMode: 'TEXT_TO_IMAGE',
      resolution: '1K',
      costBasis: 'FIXED_PER_OPERATION',
      costAmountMicros: 25_000,
      currency: 'USD',
      providerPricingVersion: 'nano-2026-08',
    },
    {
      model: 'image-2',
      operationMode: 'IMAGE_EDIT',
      resolution: '1K',
      costBasis: 'FIXED_PER_OPERATION',
      costAmountMicros: 40_000,
      currency: 'USD',
      providerPricingVersion: 'gpt-image-2026-08',
    },
  ],
})

describe('Provider billing catalog', () => {
  test('returns an immutable per-operation snapshot keyed by model, mode and resolution', () => {
    const catalog = parseProviderBillingCatalog(catalogJson)

    expect(catalog.snapshot({
      model: 'image-2', operationMode: 'IMAGE_EDIT', resolution: '1K', aspectRatio: '16:9',
    })).toEqual({
      model: 'image-2',
      operationMode: 'IMAGE_EDIT',
      resolution: '1K',
      aspectRatio: '16:9',
      costBasis: 'FIXED_PER_OPERATION',
      costAmountMicros: 40_000,
      currency: 'USD',
      providerPricingVersion: 'gpt-image-2026-08',
    })
  })

  test('fails closed for a missing route, duplicate route, floating price or malformed currency', () => {
    const catalog = parseProviderBillingCatalog(catalogJson)
    expect(() => catalog.snapshot({
      model: 'image-2', operationMode: 'TEXT_TO_IMAGE', resolution: '1K', aspectRatio: '16:9',
    })).toThrow('PROVIDER_BILLING_PROFILE_NOT_FOUND')
    expect(() => parseProviderBillingCatalog(JSON.stringify({
      schemaVersion: '1', entries: [
        JSON.parse(catalogJson).entries[0],
        JSON.parse(catalogJson).entries[0],
      ],
    }))).toThrow('PROVIDER_BILLING_PROFILE_DUPLICATE')
    expect(() => parseProviderBillingCatalog(JSON.stringify({
      schemaVersion: '1', entries: [{
        ...JSON.parse(catalogJson).entries[0], costBasis: 'VARIABLE',
      }],
    }))).toThrow('PROVIDER_BILLING_CATALOG_INVALID')
    expect(() => parseProviderBillingCatalog(JSON.stringify({
      schemaVersion: '1', entries: [{
        ...JSON.parse(catalogJson).entries[0], currency: 'usd',
      }],
    }))).toThrow('PROVIDER_BILLING_CATALOG_INVALID')
    expect(() => parseProviderBillingCatalog(JSON.stringify({
      schemaVersion: '1', entries: [{
        ...JSON.parse(catalogJson).entries[0], costAmountMicros: 0,
      }],
    }))).toThrow('PROVIDER_BILLING_CATALOG_INVALID')
  })
})

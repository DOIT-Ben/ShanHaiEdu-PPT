import { z } from 'zod'
import type { ProviderBillingCatalogPort, ProviderBillingSnapshot } from '../core/ports'

const entrySchema = z.object({
  model: z.string().trim().min(1).max(120),
  operationMode: z.enum(['TEXT_TO_IMAGE', 'IMAGE_EDIT']),
  resolution: z.literal('1K'),
  costBasis: z.literal('FIXED_PER_OPERATION'),
  costAmountMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
  providerPricingVersion: z.string().trim().min(1).max(200),
}).strict()

const catalogSchema = z.object({
  schemaVersion: z.literal('1'),
  entries: z.array(entrySchema).min(1).max(100),
}).strict()

type CatalogEntry = z.infer<typeof entrySchema>

function routeKey(input: Pick<CatalogEntry, 'model' | 'operationMode' | 'resolution'>) {
  return `${input.model}\0${input.operationMode}\0${input.resolution}`
}

export class ProviderBillingCatalog implements ProviderBillingCatalogPort {
  readonly #entries: ReadonlyMap<string, CatalogEntry>

  constructor(entries: readonly CatalogEntry[]) {
    const indexed = new Map<string, CatalogEntry>()
    for (const entry of entries) {
      const key = routeKey(entry)
      if (indexed.has(key)) throw new Error('PROVIDER_BILLING_PROFILE_DUPLICATE')
      indexed.set(key, Object.freeze({ ...entry }))
    }
    this.#entries = indexed
  }

  snapshot(input: Readonly<{
    model: string
    operationMode: 'TEXT_TO_IMAGE' | 'IMAGE_EDIT'
    resolution: '1K'
    aspectRatio: '16:9' | '4:3' | '1:1' | '3:4'
  }>): ProviderBillingSnapshot {
    const entry = this.#entries.get(routeKey(input))
    if (!entry) throw new Error('PROVIDER_BILLING_PROFILE_NOT_FOUND')
    return Object.freeze({ ...entry, aspectRatio: input.aspectRatio })
  }
}

export function parseProviderBillingCatalog(raw: string | undefined) {
  let value: unknown
  try {
    value = JSON.parse(raw ?? '')
  } catch {
    throw new Error('PROVIDER_BILLING_CATALOG_INVALID')
  }
  const parsed = catalogSchema.safeParse(value)
  if (!parsed.success) throw new Error('PROVIDER_BILLING_CATALOG_INVALID')
  return new ProviderBillingCatalog(parsed.data.entries)
}

import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  presentationJobV2PublicJobSchema,
  presentationJobV2UsageSchema,
} from '../src/presentation-job-v2-contracts'

const filename = new URL('../docs/presentation-job-v2-samples.json', import.meta.url)

describe('Presentation Job V2 published samples', () => {
  test('keeps every Job and Usage sample valid against the public contract', async () => {
    const samples = JSON.parse(await readFile(filename, 'utf8')) as Record<string, any>
    for (const key of ['created', 'running', 'completed', 'bestEffort', 'failed']) {
      expect(presentationJobV2PublicJobSchema.safeParse(samples[key].data).success).toBe(true)
    }
    expect(presentationJobV2UsageSchema.safeParse(samples.usage.reconciling.data).success).toBe(true)
    expect(presentationJobV2UsageSchema.safeParse(samples.usage.finalized.data).success).toBe(true)
  })
})

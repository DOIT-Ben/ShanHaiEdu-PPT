import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const files = [
  new URL('../src/presentation-job-v2-contracts.ts', import.meta.url),
  new URL('../src/core/presentation-job-v2-ports.ts', import.meta.url),
  new URL('../src/core/presentation-job-v2-service.ts', import.meta.url),
  new URL('../src/http/presentation-job-v2-handler.ts', import.meta.url),
]
const forbidden = [
  'frameflow', 'reservecredits', 'settlecredits', 'releasecredits', 'finalizecredits',
  'credit', 'price', 'cookie', 'session', 'generationplan', 'blueprint', 'nextattemptat',
  'leasetoken', 'provideralias', 'budgetunits', 'maxrevisionrounds',
]

describe('Presentation Job V2 provider boundary', () => {
  test('keeps the core and facade free of host, V1 execution and pricing coupling', async () => {
    for (const file of files) {
      const source = (await readFile(file, 'utf8')).toLowerCase()
      for (const token of forbidden) expect(source).not.toContain(token)
    }
  })
})

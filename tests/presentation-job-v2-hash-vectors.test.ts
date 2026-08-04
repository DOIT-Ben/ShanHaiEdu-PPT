import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { approvedPageDesignSnapshotHash } from '../src/presentation-job-v2-contracts'

const filename = new URL('../docs/presentation-job-v2-hash-vectors.json', import.meta.url)

describe('Presentation Job V2 hash vectors', () => {
  test('recomputes every published immutable snapshot hash', async () => {
    const document = JSON.parse(await readFile(filename, 'utf8')) as {
      algorithm: string
      vectors: Array<{ snapshot: unknown; sha256: string }>
    }
    expect(document.algorithm).toContain('recursively sort object keys')
    expect(document.vectors.length).toBeGreaterThan(0)
    for (const vector of document.vectors) {
      expect(approvedPageDesignSnapshotHash(vector.snapshot)).toBe(vector.sha256)
    }
  })
})

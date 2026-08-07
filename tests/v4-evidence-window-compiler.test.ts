import { describe, expect, test } from 'bun:test'
import {
  V4_EVIDENCE_CHUNK_MAX_CHARACTERS,
  V4_EVIDENCE_WINDOW_MAX_CHARACTERS,
  V4_EVIDENCE_WINDOW_VERSION,
  V4EvidenceWindowCompiler,
} from '../src/core/v4-evidence-window-compiler'

describe('V4 evidence window compiler', () => {
  test('keeps every ready source represented and bounds large source bodies deterministically', () => {
    const chunks = Array.from({ length: 30 }, (_, index) => ({
      id: `chunk-${String(index).padStart(2, '0')}`,
      sourceId: index % 2 === 0 ? 'source-a' : 'source-b',
      sha256: String(index).padStart(64, '0'),
      pageStart: index + 1,
      text: `${index % 3 === 0 ? '重点目标比较 ' : '普通正文 '}${'内容'.repeat(10_000)}`,
    }))
    const compiler = new V4EvidenceWindowCompiler()
    const input = {
      document: {
        name: 'large.md', chunks, isComplete: true, missingRanges: [],
        sources: [
          { id: 'source-a', name: 'A', kind: 'TEXT' as const, status: 'READY' as const },
          { id: 'source-b', name: 'B', kind: 'TEXT' as const, status: 'READY' as const },
        ],
      },
      instruction: '突出重点', focus: '比较', goal: '理解目标',
    }

    const first = compiler.compile(input)
    const second = compiler.compile(input)

    expect(first).toEqual(second)
    expect(first.audit.version).toBe(V4_EVIDENCE_WINDOW_VERSION)
    expect(first.audit.characterCount).toBeLessThanOrEqual(V4_EVIDENCE_WINDOW_MAX_CHARACTERS)
    expect(first.chunks.every((chunk) => chunk.text.length <= V4_EVIDENCE_CHUNK_MAX_CHARACTERS)).toBe(true)
    expect(new Set(first.chunks.map((chunk) => chunk.sourceId))).toEqual(new Set(['source-a', 'source-b']))
    expect(first.audit.omittedChunkCount).toBeGreaterThan(0)
    expect(first.audit.selectedContentHash).toMatch(/^[a-f0-9]{64}$/)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  V4_EVIDENCE_CHUNK_MAX_CHARACTERS,
  V4_EVIDENCE_WINDOW_MAX_CHARACTERS,
  V4_EVIDENCE_WINDOW_MAX_CHUNKS,
  V4_EVIDENCE_WINDOW_VERSION,
  compileV4EvidenceWindowForRun,
  requirePersistedV4EvidenceWindow,
  V4EvidenceWindowCompiler,
  v4EvidenceWindowStepKey,
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

  test('uses the full 96,000-character window for CJK source bodies and tracks bytes separately', () => {
    const chunks = Array.from({ length: 8 }, (_, index) => ({
      id: `chunk-cjk-${index + 1}`,
      sourceId: `source-cjk-${index + 1}`,
      text: '汉'.repeat(V4_EVIDENCE_CHUNK_MAX_CHARACTERS),
      sha256: String(index + 1).padStart(64, '0'),
    }))
    const result = new V4EvidenceWindowCompiler().compile({
      document: {
        name: 'cjk.txt', chunks, isComplete: true, missingRanges: [],
        sources: chunks.map((chunk) => ({
          id: chunk.sourceId,
          name: `${chunk.sourceId}.txt`,
          kind: 'TEXT' as const,
          status: 'READY' as const,
        })),
      },
      instruction: '保留中文教材正文',
    })

    expect(result.chunks).toHaveLength(8)
    expect(result.audit.characterCount).toBe(V4_EVIDENCE_WINDOW_MAX_CHARACTERS)
    expect(result.chunks.every((chunk) => chunk.text.length === V4_EVIDENCE_CHUNK_MAX_CHARACTERS)).toBe(true)
    expect(result.audit.serializedByteCount).toBeGreaterThan(V4_EVIDENCE_WINDOW_MAX_CHARACTERS)
  })

  test('uses character budgets even when JSON escaping expands the UTF-8 payload', () => {
    const text = `${'\u0001'.repeat(40_000)}${'资料'.repeat(40_000)}`
    const result = new V4EvidenceWindowCompiler().compile({
      document: {
        name: 'escaped.txt', isComplete: true, missingRanges: [],
        chunks: [{ id: 'chunk-escaped', sourceId: 'source', text, sha256: 'a'.repeat(64) }],
        sources: [{ id: 'source', name: 'escaped.txt', kind: 'TEXT', status: 'READY' }],
      },
      instruction: '提取资料',
    })
    expect(result.audit.characterCount).toBe(V4_EVIDENCE_CHUNK_MAX_CHARACTERS)
    expect(result.chunks[0]?.text).toHaveLength(V4_EVIDENCE_CHUNK_MAX_CHARACTERS)
    expect(result.audit.serializedByteCount).toBeGreaterThan(result.audit.characterCount)
  })

  test('accepts only ready sources when a source manifest is present', () => {
    const result = new V4EvidenceWindowCompiler().compile({
      document: {
        name: 'source-status.txt', isComplete: false, missingRanges: ['failed-source'],
        sources: [
          { id: 'ready-source', name: 'ready.txt', kind: 'TEXT', status: 'READY' },
          { id: 'failed-source', name: 'failed.txt', kind: 'TEXT', status: 'FAILED', failureCode: 'SOURCE_READ_FAILED' },
        ],
        chunks: [
          { id: 'ready-chunk', sourceId: 'ready-source', text: '允许进入受信窗口的正文。', sha256: 'a'.repeat(64) },
          { id: 'failed-chunk', sourceId: 'failed-source', text: '绝不能进入受信窗口的失败来源正文。', sha256: 'b'.repeat(64) },
          { id: 'unbound-chunk', text: '有来源清单时也不能作为受信正文。', sha256: 'c'.repeat(64) },
        ],
      },
      instruction: '仅使用已经就绪的资料',
    })

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['ready-chunk'])
    expect(result.audit.omittedChunkCount).toBe(2)
  })

  test('keeps legacy chunks compatible when no source manifest exists', () => {
    const result = new V4EvidenceWindowCompiler().compile({
      document: {
        name: 'legacy.txt', isComplete: true, missingRanges: [],
        chunks: [
          { id: 'legacy-bound', sourceId: 'legacy-source', text: '旧版具名正文。', sha256: 'd'.repeat(64) },
          { id: 'legacy-unbound', text: '旧版未绑定正文。', sha256: 'e'.repeat(64) },
        ],
      },
      instruction: '兼容旧版来源',
    })

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['legacy-bound', 'legacy-unbound'])
  })

  test('rebuilds the durable Chain-4 window and rejects source drift', () => {
    const chunks = Array.from({ length: 9 }, (_, index) => ({
      id: `chunk-${index + 1}`,
      sourceId: 'source',
      text: `${index === 8 ? '窗口外尾部资料。' : '受信资料。'}${'汉'.repeat(V4_EVIDENCE_CHUNK_MAX_CHARACTERS - 5)}`,
      sha256: String(index + 1).padStart(64, '0'),
    }))
    const document = {
      name: 'durable-cjk.txt', chunks, isComplete: true, missingRanges: [],
      sources: [{ id: 'source', name: 'durable-cjk.txt', kind: 'TEXT' as const, status: 'READY' as const }],
    }
    const run = {
      id: 'run-evidence-window',
      presentationGoal: '保留受信中文资料',
      visualDeckV4: {
        instruction: '制作资料驱动的中文演示', sourceMode: 'SOURCE_GROUNDED' as const,
        deckOptions: {
          deckType: 'DETAILED_DECK' as const, language: 'zh-CN', length: { slideCount: 2 },
          aspectRatio: '16:9' as const, focus: '资料重点',
        },
      },
    }
    const window = compileV4EvidenceWindowForRun({ run, document })
    const idempotencyKey = v4EvidenceWindowStepKey(run.id)
    const steps = [{
      id: 'step-evidence-window', runId: run.id, idempotencyKey,
      inputHash: 'input-hash', tool: 'compile_v4_evidence_window', status: 'COMPLETED' as const,
      budgetUnits: 0, budgetReservationId: null, externalOperationId: null, errorCode: null,
      output: window.audit, createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:00.000Z',
    }]

    expect(requirePersistedV4EvidenceWindow({ run, document, steps }).chunks).toEqual(window.chunks)
    const drifted = structuredClone(document)
    drifted.chunks[0]!.text = `已${drifted.chunks[0]!.text.slice(1)}`
    expect(() => requirePersistedV4EvidenceWindow({ run, document: drifted, steps }))
      .toThrow('V4_EVIDENCE_WINDOW_REPLAY_MISMATCH')
  })

  test('keeps a legal short-chunk document within the gateway schema limit', () => {
    const chunks = Array.from({ length: 201 }, (_, index) => ({
      id: `chunk-${String(index).padStart(3, '0')}`,
      sourceId: 'source-a',
      text: index === 200 ? '重点目标位于最后一个短分块。' : `普通短分块 ${index}`,
      sha256: String(index).padStart(64, '0'),
    }))
    const result = new V4EvidenceWindowCompiler().compile({
      document: {
        name: 'many-short-chunks.txt', chunks, isComplete: true, missingRanges: [],
        sources: [{ id: 'source-a', name: 'many-short-chunks.txt', kind: 'TEXT', status: 'READY' }],
      },
      instruction: '重点目标',
    })

    expect(result.chunks).toHaveLength(V4_EVIDENCE_WINDOW_MAX_CHUNKS)
    expect(result.chunks.some((chunk) => chunk.id === 'chunk-200')).toBe(true)
    expect(result.audit.omittedChunkCount).toBe(1)
  })
})

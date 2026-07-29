import { describe, expect, test } from 'bun:test'
import {
  FrameFlowHostAdapter,
  chunkDocumentText,
  type FrameFlowBackendClient,
} from '../src/adapters/frameflow-host'

function client(overrides: Partial<FrameFlowBackendClient> = {}): FrameFlowBackendClient {
  return {
    async getDocumentAttachment() {
      return {
        name: '七年级科学.pdf',
        text: `${'第一章内容。'.repeat(800)}\n\n${'第二章内容。'.repeat(800)}`,
        textTruncated: false,
        pageCount: 42,
      }
    },
    async reserveCredits(input) { return { reservationId: `credit:${input.idempotencyKey}` } },
    async settleCredits() {},
    async releaseCredits() {},
    ...overrides,
  }
}

const host = { tenantId: 'frameflow', externalUserId: 'user-1' }

const approvedPageDesignSource = {
  kind: 'APPROVED_PAGE_DESIGN' as const,
  schemaVersion: '1' as const,
  artifactVersionId: 'page-design-version-1',
  artifactContentHash: 'b'.repeat(64),
  title: '光合作用公开课',
  subject: '生物',
  gradeBand: '七年级',
  lessonDurationMinutes: 45,
  audience: '七年级学生',
  objectives: ['理解光合作用的条件与产物'],
  pages: [1, 2].map((pageNumber) => ({
    pageNumber,
    title: `第 ${pageNumber} 页`,
    teachingPurpose: '建立光合作用的基本心智模型',
    editableCopy: ['观察叶片与光照', '归纳条件和产物'],
    layoutIntent: '左文右图，突出叶片实验关系',
    visualRequirements: ['真实叶片、阳光和实验器材'],
    teacherNotes: '先观察再归纳',
    teacherScript: '请观察叶片在光照条件下发生的变化。',
    studentActivity: '小组观察并汇报',
    animationSequence: ['先出现叶片', '再出现光照关系'],
    boardPlan: '板书条件和产物',
    evidence: [{ type: 'FACT' as const, text: '绿色植物通过光合作用释放氧气', source: '七年级生物教材' }],
  })),
}

describe('FrameFlow host adapter', () => {
  test('resolves each approved page as one stable source chunk without a backend call', async () => {
    let attachmentCalls = 0
    const adapter = new FrameFlowHostAdapter(client({
      async getDocumentAttachment() {
        attachmentCalls += 1
        throw new Error('must not fetch an approved page design')
      },
    }))

    const first = await adapter.resolve({ host, source: approvedPageDesignSource })
    const replay = await adapter.resolve({ host, source: approvedPageDesignSource })

    expect(attachmentCalls).toBe(0)
    expect(first).toEqual(replay)
    expect(first).toMatchObject({ isComplete: true, missingRanges: [] })
    expect(first.sources).toEqual([expect.objectContaining({
      id: 'page-design-version-1', status: 'READY', kind: 'MARKDOWN', pageCount: 2,
    })])
    expect(first.chunks.map((chunk) => ({ pageStart: chunk.pageStart, pageEnd: chunk.pageEnd }))).toEqual([
      { pageStart: 1, pageEnd: 1 },
      { pageStart: 2, pageEnd: 2 },
    ])
    expect(first.chunks[0]?.text).toContain('观察叶片与光照')
    expect(first.chunks[0]?.text).toContain('七年级生物教材')
  })

  test('splits complete attachments into stable source chunks', async () => {
    const adapter = new FrameFlowHostAdapter(client())
    const result = await adapter.resolve({
      host,
      source: { kind: 'HOST_ATTACHMENT', attachmentId: 'attachment-1' },
    })

    expect(result.isComplete).toBe(true)
    expect(result.chunks.length).toBeGreaterThan(1)
    expect(result.chunks.every((chunk) => chunk.text.length <= 6_000)).toBe(true)
    expect(chunkDocumentText(result.chunks[0]!.text)[0]!.sha256).toBe(result.chunks[0]!.sha256)
  })

  test('surfaces truncated extraction instead of claiming full coverage', async () => {
    const adapter = new FrameFlowHostAdapter(client({
      async getDocumentAttachment() {
        return { name: '教材.pdf', text: '只有部分提取内容。'.repeat(100), textTruncated: true, pageCount: 80 }
      },
    }))
    const result = await adapter.resolve({
      host,
      source: { kind: 'HOST_ATTACHMENT', attachmentId: 'attachment-2' },
    })

    expect(result.isComplete).toBe(false)
    expect(result.missingRanges[0]).toContain('80 页')
  })

  test('resolves ordered mixed source packages with page and image lineage', async () => {
    const adapter = new FrameFlowHostAdapter(client({
      async getDocumentAttachment(input) {
        if (input.attachmentId === 'image-1') {
          const bytes = new Uint8Array([137, 80, 78, 71])
          return {
            name: '实验装置.png', kind: 'IMAGE', mimeType: 'image/png', status: 'READY', text: '', textTruncated: false,
            assets: [{
              id: 'image-1:original', sourceId: 'untrusted-source', name: '实验装置.png', mimeType: 'image/png',
              byteLength: bytes.length, sha256: 'a'.repeat(64), width: 640, height: 480, caption: '教材实验装置', bytes,
            }],
          }
        }
        return {
          name: '图文教材.pdf', kind: 'PDF', mimeType: 'application/pdf', status: 'READY', textTruncated: false, pageCount: 2,
          chunks: [{
            id: 'untrusted-chunk', text: '第一页讲解实验装置的组成。', sha256: 'b'.repeat(64), pageStart: 1, pageEnd: 1,
            region: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
          }],
          assets: [],
        }
      },
    }))
    const result = await adapter.resolve({
      host,
      source: {
        kind: 'SOURCE_PACKAGE',
        name: '实验课教材包',
        sources: [
          { kind: 'TEXT', sourceId: 'outline', text: '本课需要认识实验装置，并理解各个组成部分的作用。' },
          { kind: 'HOST_ATTACHMENT', sourceId: 'source-image', attachmentId: 'image-1' },
          { kind: 'HOST_ATTACHMENT', sourceId: 'source-pdf', attachmentId: 'pdf-1' },
        ],
      },
    })

    expect(result.isComplete).toBe(true)
    expect(result.sources?.map((source) => source.id)).toEqual(['outline', 'source-image', 'source-pdf'])
    expect(result.assets).toEqual([expect.objectContaining({ id: 'image-1:original', sourceId: 'source-image' })])
    expect(result.chunks.some((chunk) => chunk.sourceId === 'source-pdf' && chunk.pageStart === 1)).toBe(true)
    expect(new Set(result.chunks.map((chunk) => chunk.id)).size).toBe(result.chunks.length)
  })

  test('makes one failed attachment visible instead of silently dropping it', async () => {
    const adapter = new FrameFlowHostAdapter(client({
      async getDocumentAttachment() {
        return {
          name: '损坏教材.pdf', kind: 'PDF', mimeType: 'application/pdf', status: 'FAILED',
          failureCode: 'INVALID_PDF', text: '', textTruncated: false,
        }
      },
    }))
    const result = await adapter.resolve({
      host,
      source: {
        kind: 'SOURCE_PACKAGE',
        sources: [
          { kind: 'TEXT', sourceId: 'outline', text: '这是仍然可用的课程说明和教学目标文本内容。' },
          { kind: 'HOST_ATTACHMENT', sourceId: 'broken-pdf', attachmentId: 'pdf-broken' },
        ],
      },
    })

    expect(result.isComplete).toBe(false)
    expect(result.sources).toContainEqual(expect.objectContaining({ id: 'broken-pdf', status: 'FAILED', failureCode: 'INVALID_PDF' }))
    expect(result.missingRanges[0]).toContain('损坏教材.pdf')
  })

  test('rejects a combined package that exceeds the aggregate text limit', async () => {
    const adapter = new FrameFlowHostAdapter(client({
      async getDocumentAttachment(input) {
        return {
          name: `${input.attachmentId}.md`, kind: 'MARKDOWN', mimeType: 'text/markdown', status: 'READY',
          text: '教材知识。'.repeat(20_000), textTruncated: false,
        }
      },
    }))
    const result = await adapter.resolve({
      host,
      source: {
        kind: 'SOURCE_PACKAGE',
        sources: [
          { kind: 'HOST_ATTACHMENT', sourceId: 'markdown-1', attachmentId: 'markdown-1' },
          { kind: 'HOST_ATTACHMENT', sourceId: 'markdown-2', attachmentId: 'markdown-2' },
        ],
      },
    })

    expect(result.isComplete).toBe(false)
    expect(result.missingRanges).toContain('教材包提取文字超过 180000 字上限')
  })

  test('maps budget operations without exposing FrameFlow internals to core', async () => {
    const settlements: string[] = []
    const releases: string[] = []
    const adapter = new FrameFlowHostAdapter(client({
      async settleCredits(input) { settlements.push(input.reservationId) },
      async releaseCredits(input) { releases.push(input.reservationId) },
    }))
    const reservation = await adapter.reserve({
      host,
      model: 'image-2',
      units: 10,
      idempotencyKey: 'run-1:slide-1',
    })
    await adapter.settle({ host, reservationId: reservation.reservationId, idempotencyKey: 'settle:run-1:slide-1' })
    await adapter.release({ host, reservationId: reservation.reservationId, idempotencyKey: 'release:run-1:slide-1' })

    expect(reservation.reservationId).toBe('credit:run-1:slide-1')
    expect(settlements).toEqual(['credit:run-1:slide-1'])
    expect(releases).toEqual(['credit:run-1:slide-1'])
  })

  test('accepts host-neutral inline packages without calling the FrameFlow backend', async () => {
    const adapter = new FrameFlowHostAdapter(client())
    const result = await adapter.resolve({
      host: { tenantId: 'shanhai', externalUserId: 'task-1' },
      source: {
        kind: 'SOURCE_PACKAGE',
        sources: [
          { kind: 'TEXT', sourceId: 'textbook', text: '这是长度足够的教材证据文本，用于验证宿主无关的内联来源解析。' },
          { kind: 'TEXT', sourceId: 'lesson', text: '这是长度足够的结构化教案文本，用于验证多来源顺序与血缘。' },
        ],
      },
    })

    expect(result.isComplete).toBe(true)
    expect(result.sources?.map((source) => source.id)).toEqual(['textbook', 'lesson'])
    expect(result.chunks.every((chunk) => chunk.sourceId === 'textbook' || chunk.sourceId === 'lesson')).toBe(true)
  })

  test('keeps FrameFlow attachments and budget operations tenant-scoped', async () => {
    const adapter = new FrameFlowHostAdapter(client())
    const shanhaiHost = { tenantId: 'shanhai', externalUserId: 'task-1' }
    await expect(adapter.resolve({
      host: shanhaiHost,
      source: { kind: 'HOST_ATTACHMENT', attachmentId: 'attachment-1' },
    })).rejects.toThrow('FRAMEFLOW_TENANT_REQUIRED')
    await expect(adapter.reserve({
      host: shanhaiHost,
      model: 'image-2',
      units: 1,
      idempotencyKey: 'shanhai-budget-1',
    })).rejects.toThrow('FRAMEFLOW_TENANT_REQUIRED')
  })
})

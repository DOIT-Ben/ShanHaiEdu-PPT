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
    async releaseCredits() {},
    ...overrides,
  }
}

const host = { tenantId: 'frameflow', externalUserId: 'user-1' }

describe('FrameFlow host adapter', () => {
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

  test('maps budget operations without exposing FrameFlow internals to core', async () => {
    const releases: string[] = []
    const adapter = new FrameFlowHostAdapter(client({
      async releaseCredits(input) { releases.push(input.reservationId) },
    }))
    const reservation = await adapter.reserve({ host, units: 10, idempotencyKey: 'run-1:slide-1' })
    await adapter.release({ host, reservationId: reservation.reservationId, idempotencyKey: 'release:run-1:slide-1' })

    expect(reservation.reservationId).toBe('credit:run-1:slide-1')
    expect(releases).toEqual(['credit:run-1:slide-1'])
  })

  test('rejects accidental cross-host use', async () => {
    const adapter = new FrameFlowHostAdapter(client())
    await expect(adapter.resolve({
      host: { tenantId: 'shanhaiedu', externalUserId: 'user-1' },
      source: { kind: 'TEXT', text: '这是一个长度足够的教材文本，用于验证租户边界。' },
    })).rejects.toThrow('FRAMEFLOW_TENANT_REQUIRED')
  })
})

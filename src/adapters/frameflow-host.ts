import { createHash } from 'node:crypto'
import type { BudgetPort, DocumentPort, DocumentResult, SourceChunk } from '../core/ports'

const DEFAULT_CHUNK_CHARS = 6_000

export interface FrameFlowBackendClient {
  getDocumentAttachment(input: Readonly<{
    externalUserId: string
    attachmentId: string
  }>): Promise<Readonly<{
    name: string
    text: string
    textTruncated: boolean
    pageCount?: number
  }>>

  reserveCredits(input: Readonly<{
    externalUserId: string
    units: number
    idempotencyKey: string
  }>): Promise<Readonly<{ reservationId: string }>>

  releaseCredits(input: Readonly<{
    externalUserId: string
    reservationId: string
    idempotencyKey: string
  }>): Promise<void>
}

function chunkId(index: number, text: string) {
  const digest = createHash('sha256').update(text).digest('hex')
  return { id: `chunk-${String(index + 1).padStart(4, '0')}-${digest.slice(0, 12)}`, sha256: digest }
}

export function chunkDocumentText(text: string, maxChunkChars = DEFAULT_CHUNK_CHARS): readonly SourceChunk[] {
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 500) {
    throw new Error('maxChunkChars must be an integer of at least 500')
  }
  const normalized = text.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const paragraphs = normalized.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''

  const pushCurrent = () => {
    if (current) chunks.push(current)
    current = ''
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChunkChars) {
      pushCurrent()
      for (let offset = 0; offset < paragraph.length; offset += maxChunkChars) {
        chunks.push(paragraph.slice(offset, offset + maxChunkChars))
      }
      continue
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length > maxChunkChars) pushCurrent()
    current = current ? `${current}\n\n${paragraph}` : paragraph
  }
  pushCurrent()

  return chunks.map((chunk, index) => ({ ...chunkId(index, chunk), text: chunk }))
}

export class FrameFlowHostAdapter implements DocumentPort, BudgetPort {
  constructor(private readonly client: FrameFlowBackendClient) {}

  async resolve(input: Parameters<DocumentPort['resolve']>[0]): Promise<DocumentResult> {
    if (input.host.tenantId !== 'frameflow') throw new Error('FRAMEFLOW_TENANT_REQUIRED')

    if (input.source.kind === 'TEXT') {
      return {
        name: input.source.name ?? 'inline-material.txt',
        chunks: chunkDocumentText(input.source.text),
        isComplete: true,
        missingRanges: [],
      }
    }

    const attachment = await this.client.getDocumentAttachment({
      externalUserId: input.host.externalUserId,
      attachmentId: input.source.attachmentId,
    })
    const missingRanges = attachment.textTruncated
      ? [`附件文本提取已截断${attachment.pageCount ? `，原文件共 ${attachment.pageCount} 页` : ''}`]
      : []
    return {
      name: attachment.name,
      chunks: chunkDocumentText(attachment.text),
      isComplete: !attachment.textTruncated,
      missingRanges,
    }
  }

  async reserve(input: Parameters<BudgetPort['reserve']>[0]) {
    if (input.host.tenantId !== 'frameflow') throw new Error('FRAMEFLOW_TENANT_REQUIRED')
    return this.client.reserveCredits({
      externalUserId: input.host.externalUserId,
      units: input.units,
      idempotencyKey: input.idempotencyKey,
    })
  }

  async release(input: Parameters<BudgetPort['release']>[0]) {
    if (input.host.tenantId !== 'frameflow') throw new Error('FRAMEFLOW_TENANT_REQUIRED')
    await this.client.releaseCredits({
      externalUserId: input.host.externalUserId,
      reservationId: input.reservationId,
      idempotencyKey: input.idempotencyKey,
    })
  }
}

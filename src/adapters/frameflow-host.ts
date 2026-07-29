import { createHash } from 'node:crypto'
import type {
  BudgetPort,
  DocumentPort,
  DocumentResult,
  SourceAsset,
  SourceChunk,
  SourceMaterial,
} from '../core/ports'

const DEFAULT_CHUNK_CHARS = 6_000
const MAX_PACKAGE_TEXT_CHARS = 180_000
const MAX_PACKAGE_ASSETS = 80
const MAX_PACKAGE_ASSET_BYTES = 24 * 1024 * 1024

export interface FrameFlowBackendClient {
  getDocumentAttachment(input: Readonly<{
    externalUserId: string
    attachmentId: string
  }>): Promise<Readonly<{
    name: string
    kind?: SourceMaterial['kind']
    mimeType?: string
    status?: SourceMaterial['status']
    failureCode?: string
    text?: string
    textTruncated?: boolean
    pageCount?: number
    chunks?: readonly SourceChunk[]
    assets?: readonly SourceAsset[]
  }>>

  reserveCredits(input: Readonly<{
    externalUserId: string
    model: string
    units: number
    idempotencyKey: string
  }>): Promise<Readonly<{ reservationId: string }>>

  settleCredits(input: Readonly<{
    externalUserId: string
    reservationId: string
    idempotencyKey: string
  }>): Promise<void>

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

function packageChunk(sourceId: string, chunk: SourceChunk) {
  const digest = createHash('sha256').update(`${sourceId}\0${chunk.sha256}`).digest('hex')
  return { ...chunk, id: `chunk-${digest.slice(0, 28)}`, sourceId }
}

function approvedPageText(
  page: Extract<Parameters<DocumentPort['resolve']>[0]['source'], { kind: 'APPROVED_PAGE_DESIGN' }>['pages'][number],
) {
  const evidence = page.evidence.map((item) => [
    `${item.type}: ${item.text}`,
    item.source ? `来源: ${item.source}` : null,
  ].filter(Boolean).join('；'))
  return [
    `# 第 ${page.pageNumber} 页 · ${page.title}`,
    `教学目的：${page.teachingPurpose}`,
    `可编辑文案：\n${page.editableCopy.map((item) => `- ${item}`).join('\n')}`,
    `版式意图：${page.layoutIntent}`,
    `视觉要求：\n${page.visualRequirements.map((item) => `- ${item}`).join('\n') || '- 无额外要求'}`,
    `教师提示：${page.teacherNotes}`,
    `教师讲稿：${page.teacherScript}`,
    `学生活动：${page.studentActivity}`,
    `动画顺序：\n${page.animationSequence.map((item) => `- ${item}`).join('\n')}`,
    `板书设计：${page.boardPlan}`,
    `依据：\n${evidence.map((item) => `- ${item}`).join('\n') || '- 无额外依据'}`,
  ].join('\n\n')
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
    if (input.source.kind === 'TEXT') {
      return {
        name: input.source.name ?? 'inline-material.txt',
        chunks: chunkDocumentText(input.source.text),
        isComplete: true,
        missingRanges: [],
      }
    }

    if (input.source.kind === 'HOST_ATTACHMENT') {
      if (input.host.tenantId !== 'frameflow') throw new Error('FRAMEFLOW_TENANT_REQUIRED')
      const attachment = await this.client.getDocumentAttachment({
        externalUserId: input.host.externalUserId,
        attachmentId: input.source.attachmentId,
      })
      const failed = attachment.status === 'FAILED'
      const missingRanges = failed
        ? [`附件 ${attachment.name} 解析失败：${attachment.failureCode ?? 'ATTACHMENT_PARSE_FAILED'}`]
        : attachment.textTruncated
          ? [`附件文本提取已截断${attachment.pageCount ? `，原文件共 ${attachment.pageCount} 页` : ''}`]
          : []
      return {
        name: attachment.name,
        chunks: failed ? [] : attachment.chunks ?? chunkDocumentText(attachment.text ?? ''),
        sources: [{
          id: input.source.attachmentId,
          name: attachment.name,
          kind: attachment.kind ?? 'MARKDOWN',
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          ...(attachment.pageCount ? { pageCount: attachment.pageCount } : {}),
          status: failed ? 'FAILED' : 'READY',
          ...(attachment.failureCode ? { failureCode: attachment.failureCode } : {}),
        }],
        assets: failed ? [] : attachment.assets ?? [],
        isComplete: !failed && !attachment.textTruncated,
        missingRanges,
      }
    }

    if (input.source.kind === 'APPROVED_PAGE_DESIGN') {
      const source = input.source
      const chunks = source.pages.map((page) => {
        const text = approvedPageText(page)
        const sha256 = createHash('sha256').update(text).digest('hex')
        return {
          id: `approved-page-${String(page.pageNumber).padStart(2, '0')}-${sha256.slice(0, 12)}`,
          sourceId: source.artifactVersionId,
          text,
          sha256,
          pageStart: page.pageNumber,
          pageEnd: page.pageNumber,
        }
      })
      return {
        name: source.title,
        chunks,
        sources: [{
          id: source.artifactVersionId,
          name: `${source.title} · 已审核逐页设计稿`,
          kind: 'MARKDOWN',
          mimeType: 'text/markdown',
          pageCount: source.pages.length,
          status: 'READY',
        }],
        assets: [],
        isComplete: true,
        missingRanges: [],
      }
    }


    const chunks: SourceChunk[] = []
    const assets: SourceAsset[] = []
    const sources: SourceMaterial[] = []
    const missingRanges: string[] = []
    for (const source of input.source.sources) {
      if (source.kind === 'TEXT') {
        chunks.push(...chunkDocumentText(source.text).map((chunk) => packageChunk(source.sourceId, chunk)))
        sources.push({ id: source.sourceId, name: source.name ?? 'inline-material.txt', kind: 'TEXT', status: 'READY' })
        continue
      }
      if (input.host.tenantId !== 'frameflow') throw new Error('FRAMEFLOW_TENANT_REQUIRED')
      const attachment = await this.client.getDocumentAttachment({
        externalUserId: input.host.externalUserId,
        attachmentId: source.attachmentId,
      })
      const failed = attachment.status === 'FAILED'
      sources.push({
        id: source.sourceId,
        name: attachment.name,
        kind: attachment.kind ?? 'MARKDOWN',
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.pageCount ? { pageCount: attachment.pageCount } : {}),
        status: failed ? 'FAILED' : 'READY',
        ...(attachment.failureCode ? { failureCode: attachment.failureCode } : {}),
      })
      if (failed) {
        missingRanges.push(`附件 ${attachment.name} 解析失败：${attachment.failureCode ?? 'ATTACHMENT_PARSE_FAILED'}`)
        continue
      }
      const attachmentChunks = attachment.chunks ?? chunkDocumentText(attachment.text ?? '')
      chunks.push(...attachmentChunks.map((chunk) => packageChunk(source.sourceId, chunk)))
      assets.push(...(attachment.assets ?? []).map((asset) => ({ ...asset, sourceId: source.sourceId })))
      if (attachment.textTruncated) {
        missingRanges.push(`附件 ${attachment.name} 文本提取已截断${attachment.pageCount ? `，原文件共 ${attachment.pageCount} 页` : ''}`)
      }
    }
    const textChars = chunks.reduce((total, chunk) => total + chunk.text.length, 0)
    const assetBytes = assets.reduce((total, asset) => total + asset.byteLength, 0)
    if (textChars > MAX_PACKAGE_TEXT_CHARS) missingRanges.push('教材包提取文字超过 180000 字上限')
    if (assets.length > MAX_PACKAGE_ASSETS) missingRanges.push('教材包提取素材超过 80 个上限')
    if (assetBytes > MAX_PACKAGE_ASSET_BYTES) missingRanges.push('教材包提取素材超过 24MB 上限')
    return {
      name: input.source.name ?? 'source-package',
      chunks,
      sources,
      assets,
      isComplete: missingRanges.length === 0,
      missingRanges,
    }
  }

  async reserve(input: Parameters<BudgetPort['reserve']>[0]) {
    if (input.host.tenantId !== 'frameflow') throw new Error('FRAMEFLOW_TENANT_REQUIRED')
    return this.client.reserveCredits({
      externalUserId: input.host.externalUserId,
      model: input.model,
      units: input.units,
      idempotencyKey: input.idempotencyKey,
    })
  }

  async settle(input: Parameters<BudgetPort['settle']>[0]) {
    if (input.host.tenantId !== 'frameflow') throw new Error('FRAMEFLOW_TENANT_REQUIRED')
    await this.client.settleCredits({
      externalUserId: input.host.externalUserId,
      reservationId: input.reservationId,
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

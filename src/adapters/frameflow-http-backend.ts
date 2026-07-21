import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FrameFlowBackendClient } from './frameflow-host'

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const identifierSchema = z.string().trim().min(1).max(160)
const regionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict()
const failedSchema = z.object({
  name: z.string().trim().min(1).max(240),
  kind: z.enum(['IMAGE', 'PDF', 'MARKDOWN']),
  mimeType: z.string().trim().min(1).max(160),
  status: z.literal('FAILED'),
  failureCode: z.string().trim().min(1).max(160),
}).strict()
const readySchema = z.object({
  name: z.string().trim().min(1).max(240),
  kind: z.enum(['IMAGE', 'PDF', 'MARKDOWN']),
  mimeType: z.string().trim().min(1).max(160),
  status: z.literal('READY'),
  textTruncated: z.literal(false),
  pageCount: z.number().int().positive().max(50).optional(),
  chunks: z.array(z.object({
    id: identifierSchema,
    text: z.string().trim().min(1).max(180_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    pageStart: z.number().int().positive().max(50).optional(),
    pageEnd: z.number().int().positive().max(50).optional(),
    region: regionSchema.optional(),
  }).strict()).max(200),
  assets: z.array(z.object({
    id: identifierSchema,
    sourceId: identifierSchema,
    name: z.string().trim().min(1).max(300),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    byteLength: z.number().int().positive().max(24 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().positive().max(20_000),
    height: z.number().int().positive().max(20_000),
    pageNumber: z.number().int().positive().max(50).optional(),
    caption: z.string().trim().min(1).max(500).optional(),
    contentBase64: z.string().min(4).max(32 * 1024 * 1024),
  }).strict()).max(80),
}).strict()
const envelopeSchema = z.object({ data: z.union([readySchema, failedSchema]) }).strict()

function normalizedLoopbackUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('FRAMEFLOW_INTERNAL_URL_MUST_BE_LOOPBACK')
  }
  return url.toString().replace(/\/$/, '')
}

export class HttpFrameFlowBackend implements FrameFlowBackendClient {
  private readonly baseUrl: string
  private readonly fetchImpl: Fetch

  constructor(private readonly dependencies: Readonly<{
    baseUrl: string
    token: string
    fetchImpl?: Fetch
  }>) {
    this.baseUrl = normalizedLoopbackUrl(dependencies.baseUrl)
    if (dependencies.token.length < 16) throw new Error('FRAMEFLOW_INTERNAL_TOKEN_REQUIRED')
    this.fetchImpl = dependencies.fetchImpl ?? fetch
  }

  async getDocumentAttachment(input: Parameters<FrameFlowBackendClient['getDocumentAttachment']>[0]) {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/internal/ppt-agent/attachments/${encodeURIComponent(input.attachmentId)}`, {
        headers: {
          Authorization: `Bearer ${this.dependencies.token}`,
          'X-PPT-Agent-User': input.externalUserId,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(300_000),
      })
    } catch {
      return {
        name: input.attachmentId,
        kind: 'MARKDOWN' as const,
        status: 'FAILED' as const,
        failureCode: 'SOURCE_ENDPOINT_UNAVAILABLE',
      }
    }
    if (!response.ok) {
      return {
        name: input.attachmentId,
        kind: 'MARKDOWN' as const,
        status: 'FAILED' as const,
        failureCode: `SOURCE_ENDPOINT_HTTP_${response.status}`,
      }
    }
    const parsed = envelopeSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      return {
        name: input.attachmentId,
        kind: 'MARKDOWN' as const,
        status: 'FAILED' as const,
        failureCode: 'SOURCE_ENDPOINT_RESPONSE_INVALID',
      }
    }
    if (parsed.data.data.status === 'FAILED') return parsed.data.data
    const data = parsed.data.data
    let assets
    try {
      assets = data.assets.map(({ contentBase64, pageNumber, caption, ...asset }) => {
        const bytes = new Uint8Array(Buffer.from(contentBase64, 'base64'))
        if (bytes.length !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
          throw new Error('SOURCE_ASSET_INTEGRITY_MISMATCH')
        }
        return {
          ...asset,
          ...(pageNumber === undefined ? {} : { pageNumber }),
          ...(caption === undefined ? {} : { caption }),
          bytes,
        }
      })
    } catch {
      return {
        name: data.name,
        kind: data.kind,
        mimeType: data.mimeType,
        status: 'FAILED' as const,
        failureCode: 'SOURCE_ASSET_INTEGRITY_MISMATCH',
      }
    }
    return {
      name: data.name,
      kind: data.kind,
      mimeType: data.mimeType,
      status: data.status,
      textTruncated: data.textTruncated,
      ...(data.pageCount === undefined ? {} : { pageCount: data.pageCount }),
      chunks: data.chunks.map(({ pageStart, pageEnd, region, ...chunk }) => ({
        ...chunk,
        ...(pageStart === undefined ? {} : { pageStart }),
        ...(pageEnd === undefined ? {} : { pageEnd }),
        ...(region === undefined ? {} : { region }),
      })),
      assets,
    }
  }

  async reserveCredits(input: Parameters<FrameFlowBackendClient['reserveCredits']>[0]) {
    return { reservationId: `frameflow-budget:${input.idempotencyKey}` }
  }

  async releaseCredits() {}
}

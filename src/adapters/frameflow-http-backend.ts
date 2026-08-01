import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FrameFlowBackendClient } from './frameflow-host'
import { BudgetReservationError } from '../core/ports'

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
    region: regionSchema.optional(),
    caption: z.string().trim().min(1).max(500).optional(),
    contentBase64: z.string().min(4).max(32 * 1024 * 1024),
  }).strict()).max(80),
}).strict()
const envelopeSchema = z.object({ data: z.union([readySchema, failedSchema]) }).strict()
const creditEnvelopeSchema = z.object({
  data: z.object({
    reservationId: identifierSchema,
    status: z.enum(['RESERVED', 'SETTLED', 'RELEASED', 'FINALIZED']),
    reservedCredits: z.number().nonnegative(),
    settledCredits: z.number().nonnegative().nullable(),
  }).strict(),
}).strict()
const batchFinalizationCapabilityEnvelopeSchema = z.object({
  data: z.object({ atomicBatchFinalization: z.literal(true) }).strict(),
}).strict()
const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string().trim().min(1).max(160) }).passthrough(),
}).passthrough()

function normalizedLoopbackUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
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
    if (dependencies.token.length < 16 || dependencies.token.length > 512
      || dependencies.token !== dependencies.token.trim()) throw new Error('FRAMEFLOW_INTERNAL_TOKEN_REQUIRED')
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
      assets = data.assets.map(({ contentBase64, pageNumber, region, caption, ...asset }) => {
        const bytes = new Uint8Array(Buffer.from(contentBase64, 'base64'))
        if (bytes.length !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
          throw new Error('SOURCE_ASSET_INTEGRITY_MISMATCH')
        }
        return {
          ...asset,
          ...(pageNumber === undefined ? {} : { pageNumber }),
          ...(region === undefined ? {} : { region }),
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
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/internal/ppt-agent/credits/reservations`, {
        method: 'POST',
        headers: this.creditHeaders(input.externalUserId, input.idempotencyKey, true),
        body: JSON.stringify({ model: input.model, units: input.units }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new BudgetReservationError(
        'HOST_BUDGET_RESERVATION_UNKNOWN',
        'UNKNOWN',
        'FrameFlow credit reservation result is unknown',
      )
    }
    if (!response.ok) {
      const code = await this.errorCode(response, `HOST_BUDGET_HTTP_${response.status}`)
      throw new BudgetReservationError(
        code,
        [400, 401, 402, 403, 404, 405, 413, 415, 422, 423, 429].includes(response.status)
          ? 'NOT_RESERVED'
          : 'UNKNOWN',
        code,
      )
    }
    const parsed = creditEnvelopeSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success || parsed.data.data.status !== 'RESERVED') {
      throw new BudgetReservationError(
        'HOST_BUDGET_RESPONSE_INVALID',
        'UNKNOWN',
        'FrameFlow credit reservation response is invalid',
      )
    }
    return { reservationId: parsed.data.data.reservationId }
  }

  async settleCredits(input: Parameters<FrameFlowBackendClient['settleCredits']>[0]) {
    await this.completeCreditOperation('settle', input, 'SETTLED')
  }

  async releaseCredits(input: Parameters<FrameFlowBackendClient['releaseCredits']>[0]) {
    await this.completeCreditOperation('release', input, 'RELEASED')
  }

  async finalizeCredits(input: Parameters<FrameFlowBackendClient['finalizeCredits']>[0]) {
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/internal/ppt-agent/credits/reservations/${encodeURIComponent(input.reservationId)}/finalize`,
        {
          method: 'POST',
          headers: this.creditHeaders(input.externalUserId, input.idempotencyKey, true),
          body: JSON.stringify({
            batchId: input.batchId,
            settledUnits: input.settledUnits,
            releasedUnits: input.releasedUnits,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      )
    } catch {
      throw new Error('HOST_BUDGET_FINALIZE_UNKNOWN')
    }
    if (!response.ok) {
      throw new Error(await this.errorCode(response, `HOST_BUDGET_FINALIZE_HTTP_${response.status}`))
    }
    const parsed = creditEnvelopeSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success || parsed.data.data.reservationId !== input.reservationId
      || parsed.data.data.status !== 'FINALIZED') {
      throw new Error('HOST_BUDGET_FINALIZE_RESPONSE_INVALID')
    }
  }

  async preflightBatchFinalization(input: Parameters<FrameFlowBackendClient['preflightBatchFinalization']>[0]) {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/internal/ppt-agent/credits/batch-finalization-capability`, {
        headers: this.creditHeaders(input.externalUserId, 'ppt-agent:batch-finalization-preflight'),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      throw new Error('HOST_BATCH_FINALIZATION_CAPABILITY_UNKNOWN')
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new Error('HOST_BATCH_FINALIZATION_UNSUPPORTED')
    }
    if (!response.ok) {
      throw new Error(await this.errorCode(response, `HOST_BATCH_FINALIZATION_CAPABILITY_HTTP_${response.status}`))
    }
    if (!batchFinalizationCapabilityEnvelopeSchema.safeParse(await response.json().catch(() => null)).success) {
      throw new Error('HOST_BATCH_FINALIZATION_UNSUPPORTED')
    }
  }

  private creditHeaders(userId: string, idempotencyKey: string, json = false) {
    return {
      Authorization: `Bearer ${this.dependencies.token}`,
      'X-PPT-Agent-User': userId,
      'Idempotency-Key': idempotencyKey,
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private async completeCreditOperation(
    operation: 'settle' | 'release',
    input: Readonly<{ externalUserId: string; reservationId: string; idempotencyKey: string }>,
    expectedStatus: 'SETTLED' | 'RELEASED',
  ) {
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/internal/ppt-agent/credits/reservations/${encodeURIComponent(input.reservationId)}/${operation}`,
        {
          method: 'POST',
          headers: this.creditHeaders(input.externalUserId, input.idempotencyKey),
          signal: AbortSignal.timeout(15_000),
        },
      )
    } catch {
      throw new Error(`HOST_BUDGET_${operation.toUpperCase()}_UNKNOWN`)
    }
    if (!response.ok) {
      throw new Error(await this.errorCode(response, `HOST_BUDGET_${operation.toUpperCase()}_HTTP_${response.status}`))
    }
    const parsed = creditEnvelopeSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success || parsed.data.data.reservationId !== input.reservationId
      || parsed.data.data.status !== expectedStatus) {
      throw new Error(`HOST_BUDGET_${operation.toUpperCase()}_RESPONSE_INVALID`)
    }
  }

  private async errorCode(response: Response, fallback: string) {
    const parsed = errorEnvelopeSchema.safeParse(await response.json().catch(() => null))
    return parsed.success ? parsed.data.error.code : fallback
  }
}

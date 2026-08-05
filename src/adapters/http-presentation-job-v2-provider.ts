import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  PRESENTATION_JOB_V2_PPTX_MIME_TYPE,
  type PresentationJobV2ProviderPort,
} from '../core/presentation-job-v2-ports'
import { presentationJobV2UsageSummarySchema } from '../presentation-job-v2-contracts'

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 200 * 1024 * 1024

const operationIdSchema = z.string().trim().min(1).max(512)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const inspectionSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('RUNNING'),
    retryAfterMs: z.number().int().min(100).max(300_000).optional(),
  }).strict(),
  z.object({
    state: z.literal('FAILED'),
    errorCode: z.string().trim().min(1).max(160),
    usage: presentationJobV2UsageSummarySchema,
  }).strict(),
  z.object({
    state: z.literal('COMPLETED'),
    quality: z.enum(['PASSED', 'BEST_EFFORT', 'BLOCKING_FAILURE']),
    usage: presentationJobV2UsageSummarySchema,
    artifact: z.object({
      name: z.string().trim().min(1).max(240),
      mimeType: z.literal(PRESENTATION_JOB_V2_PPTX_MIME_TYPE),
      byteLength: z.number().int().positive(),
      sha256: sha256Schema,
    }).strict(),
  }).strict(),
])

function normalizedBaseUrl(value: string) {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('PRESENTATION_PROVIDER_BASE_URL_INSECURE')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('PRESENTATION_PROVIDER_BASE_URL_INVALID')
  }
  return url.toString().replace(/\/$/, '')
}

function positiveInteger(value: number | undefined, fallback: number, code: string) {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new Error(code)
  return normalized
}

function transientStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function retryAfterMs(response: Response) {
  const value = response.headers.get('Retry-After')?.trim() ?? ''
  const seconds = Number(value)
  const parsed = value && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 2_000
  return Math.max(100, Math.min(300_000, Math.ceil(parsed)))
}

function integrityFailure(): never {
  throw new Error('PRESENTATION_PROVIDER_ARTIFACT_INTEGRITY_FAILED')
}

export class HttpPresentationJobV2Provider implements PresentationJobV2ProviderPort {
  private readonly baseUrl: string
  private readonly fetchImpl: Fetch
  private readonly timeoutMs: number
  private readonly maximumArtifactBytes: number

  constructor(dependencies: Readonly<{
    baseUrl: string
    apiKey: string
    fetchImpl?: Fetch
    timeoutMs?: number
    maximumArtifactBytes?: number
  }>) {
    this.baseUrl = normalizedBaseUrl(dependencies.baseUrl)
    if (dependencies.apiKey.length < 8 || dependencies.apiKey.length > 4_096
      || dependencies.apiKey !== dependencies.apiKey.trim()) {
      throw new Error('PRESENTATION_PROVIDER_API_KEY_INVALID')
    }
    this.fetchImpl = dependencies.fetchImpl ?? fetch
    this.timeoutMs = positiveInteger(
      dependencies.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      'PRESENTATION_PROVIDER_TIMEOUT_INVALID',
    )
    this.maximumArtifactBytes = positiveInteger(
      dependencies.maximumArtifactBytes,
      DEFAULT_MAXIMUM_ARTIFACT_BYTES,
      'PRESENTATION_PROVIDER_ARTIFACT_LIMIT_INVALID',
    )
    this.apiKey = dependencies.apiKey
  }

  private readonly apiKey: string

  async submit(input: Parameters<PresentationJobV2ProviderPort['submit']>[0]) {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/presentation-operations`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          contractVersion: '1.0',
          jobId: input.jobId,
          source: input.source,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      throw new Error('PRESENTATION_PROVIDER_SUBMISSION_UNKNOWN')
    }
    if (!response.ok) throw new Error(`PRESENTATION_PROVIDER_SUBMIT_HTTP_${response.status}`)
    const parsed = z.object({ operationId: operationIdSchema }).strict()
      .safeParse(await response.json().catch(() => null))
    if (!parsed.success) throw new Error('PRESENTATION_PROVIDER_SUBMIT_RESPONSE_INVALID')
    return { operationId: parsed.data.operationId }
  }

  async inspect(input: Parameters<PresentationJobV2ProviderPort['inspect']>[0]) {
    const operationId = operationIdSchema.parse(input.operationId)
    let response: Response
    try {
      response = await this.fetchImpl(this.operationUrl(operationId), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      return { state: 'RUNNING' as const, retryAfterMs: 2_000 }
    }
    if (!response.ok) {
      if (transientStatus(response.status)) {
        return { state: 'RUNNING' as const, retryAfterMs: retryAfterMs(response) }
      }
      return {
        state: 'FAILED' as const,
        errorCode: `PRESENTATION_PROVIDER_INSPECT_HTTP_${response.status}`,
        usage: {
          billableImageOperations: 0,
          notChargedImageOperations: 0,
          unknownImageOperations: 1,
          byModel: [{
            model: 'unknown',
            billableImageOperations: 0,
            notChargedImageOperations: 0,
            unknownImageOperations: 1,
          }],
        },
      }
    }
    const parsed = inspectionSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) throw new Error('PRESENTATION_PROVIDER_INSPECT_RESPONSE_INVALID')
    if (parsed.data.state !== 'COMPLETED') return parsed.data
    if (parsed.data.quality === 'BLOCKING_FAILURE') {
      return {
        state: 'FAILED' as const,
        errorCode: 'DELIVERY_BLOCKED_BY_QUALITY',
        usage: parsed.data.usage,
      }
    }
    const bytes = await this.downloadArtifact(operationId, parsed.data.artifact)
    return {
      state: 'COMPLETED' as const,
      quality: parsed.data.quality,
      usage: parsed.data.usage,
      artifact: {
        bytes,
        name: parsed.data.artifact.name,
        mimeType: PRESENTATION_JOB_V2_PPTX_MIME_TYPE,
      },
    }
  }

  private operationUrl(operationId: string) {
    return `${this.baseUrl}/presentation-operations/${encodeURIComponent(operationId)}`
  }

  private async downloadArtifact(
    operationId: string,
    artifact: Extract<z.infer<typeof inspectionSchema>, { state: 'COMPLETED' }>['artifact'],
  ) {
    if (artifact.byteLength > this.maximumArtifactBytes) integrityFailure()
    let response: Response
    try {
      response = await this.fetchImpl(`${this.operationUrl(operationId)}/artifact`, {
        headers: { Accept: PRESENTATION_JOB_V2_PPTX_MIME_TYPE, Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      throw new Error('PRESENTATION_PROVIDER_ARTIFACT_UNAVAILABLE')
    }
    if (!response.ok) throw new Error(`PRESENTATION_PROVIDER_ARTIFACT_HTTP_${response.status}`)
    const mimeType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim()
    const byteLength = Number(response.headers.get('Content-Length'))
    const sha256 = response.headers.get('X-Content-SHA256')?.trim()
    if (mimeType !== PRESENTATION_JOB_V2_PPTX_MIME_TYPE
      || byteLength !== artifact.byteLength
      || sha256 !== artifact.sha256
      || !response.body) integrityFailure()

    const bytes = new Uint8Array(artifact.byteLength)
    const digest = createHash('sha256')
    const reader = response.body.getReader()
    let offset = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (offset + chunk.value.length > bytes.length) {
        await reader.cancel()
        integrityFailure()
      }
      bytes.set(chunk.value, offset)
      offset += chunk.value.length
      digest.update(chunk.value)
    }
    if (offset !== bytes.length || digest.digest('hex') !== artifact.sha256
      || bytes[0] !== 0x50 || bytes[1] !== 0x4b) integrityFailure()
    return bytes
  }
}

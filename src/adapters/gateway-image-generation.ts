import { z } from 'zod'
import sharp from 'sharp'
import type { ArtifactPort, ImageGenerationPort } from '../core/ports'
import { MediaSubmissionError } from '../core/ports'

const gatewayResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) }).passthrough()).min(1),
}).passthrough()

const imageOperationSchema = z.object({
  id: z.string().regex(/^imgop_[0-9a-f]{32}$/),
  status: z.enum(['CREATED', 'SUBMITTING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'EXPIRED', 'FAILED', 'SUBMISSION_UNKNOWN']),
  submission_state: z.enum(['NOT_SUBMITTED', 'SUBMITTED', 'UNKNOWN']),
  result: gatewayResponseSchema.optional(),
  error: z.object({ code: z.string().min(1) }).passthrough().optional(),
}).passthrough()

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function normalizedBaseUrl(value: string) {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('GATEWAY_BASE_URL_INSECURE')
  }
  return url.toString().replace(/\/$/, '')
}

function gatewayErrorCode(payload: unknown, status: number) {
  const parsed = z.object({ error: z.object({ code: z.string().min(1) }).passthrough() }).passthrough().safeParse(payload)
  return parsed.success ? parsed.data.error.code : `GATEWAY_HTTP_${status}`
}

function isTransientInspectionStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function transientInspectionRetryAfterMs(response: Response) {
  const value = response.headers.get('Retry-After')?.trim() ?? ''
  const seconds = value.length > 0 ? Number(value) : Number.NaN
  const fromSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Number.NaN
  const fromDate = value.length > 0 && Number.isNaN(fromSeconds) ? Date.parse(value) - Date.now() : Number.NaN
  const delay = Number.isFinite(fromSeconds) ? fromSeconds : Number.isFinite(fromDate) ? fromDate : 2_000
  return Math.max(1_000, Math.min(60_000, Math.ceil(delay)))
}

function decodedImage(value: string) {
  const bytes = Buffer.from(value, 'base64')
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!png && !jpeg && !webp) throw new Error('GATEWAY_IMAGE_OUTPUT_INVALID')
  return { bytes: new Uint8Array(bytes), mimeType: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' }
}

function operationState(status: z.infer<typeof imageOperationSchema>['status']) {
  return status === 'PROCESSING' ? 'PROCESSING' as const
    : status === 'COMPLETED' ? 'COMPLETED' as const
      : 'QUEUED' as const
}

function pendingOperationState(status: 'CREATED' | 'SUBMITTING' | 'QUEUED' | 'PROCESSING') {
  return status === 'PROCESSING' ? 'PROCESSING' as const : 'QUEUED' as const
}

function billingState(operation: z.infer<typeof imageOperationSchema>) {
  if (operation.submission_state === 'NOT_SUBMITTED') return 'NOT_CHARGED' as const
  return operation.submission_state === 'SUBMITTED' ? 'CHARGED' as const : 'UNKNOWN' as const
}

async function removeConnectedNeutralBackdrop(image: Uint8Array) {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (data.some((value, index) => index % 4 === 3 && value < 250)) return image
  const pixelCount = info.width * info.height
  const visited = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  let head = 0
  let tail = 0
  const neutral = (pixel: number) => {
    const offset = pixel * 4
    const red = data[offset]!
    const green = data[offset + 1]!
    const blue = data[offset + 2]!
    return Math.max(red, green, blue) - Math.min(red, green, blue) <= 24
      && (red + green + blue) / 3 >= 160
  }
  const enqueue = (pixel: number) => {
    if (visited[pixel] || !neutral(pixel)) return
    visited[pixel] = 1
    queue[tail++] = pixel
  }
  for (let x = 0; x < info.width; x += 1) {
    enqueue(x)
    enqueue((info.height - 1) * info.width + x)
  }
  for (let y = 0; y < info.height; y += 1) {
    enqueue(y * info.width)
    enqueue(y * info.width + info.width - 1)
  }
  while (head < tail) {
    const pixel = queue[head++]!
    const x = pixel % info.width
    const y = Math.floor(pixel / info.width)
    if (x > 0) enqueue(pixel - 1)
    if (x + 1 < info.width) enqueue(pixel + 1)
    if (y > 0) enqueue(pixel - info.width)
    if (y + 1 < info.height) enqueue(pixel + info.width)
  }
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (visited[pixel]) data[pixel * 4 + 3] = 0
  }
  return new Uint8Array(await sharp(data, { raw: info }).png({ compressionLevel: 8 }).toBuffer())
}

export class GatewayImageGenerationPort implements ImageGenerationPort {
  private readonly baseUrl: string
  private readonly fetchImpl: Fetch

  constructor(private readonly dependencies: Readonly<{
    baseUrl: string
    apiKey: string
    artifacts: ArtifactPort
    fetchImpl?: Fetch
    timeoutMs?: number
  }>) {
    this.baseUrl = normalizedBaseUrl(dependencies.baseUrl)
    if (dependencies.apiKey.trim().length < 8) throw new Error('GATEWAY_API_KEY_INVALID')
    this.fetchImpl = dependencies.fetchImpl ?? fetch
  }

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    const prompt = [
      input.prompt,
      input.backgroundMode === 'TRANSPARENT'
        ? 'Use an isolated subject on a transparent background. Never draw a checkerboard, transparency grid, frame, or backdrop.'
        : '',
      input.negativePrompt ? `Avoid: ${input.negativePrompt}.` : '',
    ].filter(Boolean).join(' ')
    const reference = input.referenceImage
    const body = reference
      ? (() => {
          const form = new FormData()
          form.set('model', input.model)
          form.set('prompt', prompt)
          form.set('size', input.aspectRatio)
          form.set('resolution', '1K')
          form.set('n', '1')
          form.set('image', new Blob([Buffer.from(reference.bytes)], { type: reference.mimeType }), `reference.${reference.mimeType.split('/')[1]}`)
          return form
        })()
      : JSON.stringify({
          model: input.model,
          prompt,
          size: input.aspectRatio,
          resolution: '1K',
          n: 1,
        })
    if (!reference) return this.submitImageTask(input, body)

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/images/edits`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.dependencies.apiKey}`,
          'Idempotency-Key': input.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(this.dependencies.timeoutMs ?? 600_000),
      })
    } catch {
      throw new MediaSubmissionError('GATEWAY_SUBMISSION_UNKNOWN', 'UNKNOWN', 'gateway submission status is unknown')
    }

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const state = [400, 401, 403, 404, 422].includes(response.status) ? 'NOT_SUBMITTED' as const : 'UNKNOWN' as const
      throw new MediaSubmissionError(gatewayErrorCode(payload, response.status), state, 'gateway rejected image request')
    }

    try {
      const artifact = await this.storeOutput(input, gatewayResponseSchema.parse(payload))
      return { operationId: `gateway-image:${artifact.artifactId}`, state: 'COMPLETED' as const }
    } catch {
      throw new MediaSubmissionError('GATEWAY_OUTPUT_INVALID', 'UNKNOWN', 'gateway returned an invalid image result')
    }
  }

  async lookupByIdempotency(input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0]) {
    const operation = await this.lookupImageTask(input.idempotencyKey)
    if (!operation || operation.submission_state === 'UNKNOWN') return { state: 'UNKNOWN' as const }
    if (operation.submission_state === 'NOT_SUBMITTED') return { state: 'NOT_SUBMITTED' as const }
    return { state: 'SUBMITTED' as const, operationId: operation.id }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    const artifactId = input.operationId.startsWith('gateway-image:') ? input.operationId.slice('gateway-image:'.length) : ''
    if (artifactId) {
      const artifact = await this.dependencies.artifacts.get({ tenantId: input.tenantId, artifactId })
      return artifact
        ? { state: 'COMPLETED' as const, artifactId }
        : { state: 'FAILED' as const, errorCode: 'GATEWAY_ARTIFACT_MISSING', billingState: 'CHARGED' as const }
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/image-tasks/${encodeURIComponent(input.operationId)}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.dependencies.apiKey}` },
        signal: AbortSignal.timeout(this.dependencies.timeoutMs ?? 30_000),
      })
    } catch {
      return { state: 'PROCESSING' as const, retryAfterMs: 2_000 }
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      if (isTransientInspectionStatus(response.status)) {
        return { state: 'PROCESSING' as const, retryAfterMs: transientInspectionRetryAfterMs(response) }
      }
      return { state: 'FAILED' as const, errorCode: gatewayErrorCode(payload, response.status), billingState: 'UNKNOWN' as const }
    }

    const parsed = imageOperationSchema.safeParse(payload)
    if (!parsed.success) {
      return { state: 'FAILED' as const, errorCode: 'GATEWAY_OPERATION_INVALID', billingState: 'UNKNOWN' as const }
    }
    const operation = parsed.data
    if (operation.status === 'CREATED' || operation.status === 'SUBMITTING'
      || operation.status === 'QUEUED' || operation.status === 'PROCESSING') {
      return { state: pendingOperationState(operation.status) }
    }
    if (operation.status === 'COMPLETED') {
      if (!operation.result) {
        return { state: 'FAILED' as const, errorCode: 'GATEWAY_OUTPUT_MISSING', billingState: 'CHARGED' as const }
      }
      try {
        const artifact = await this.storeOutput({
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey ?? input.operationId,
          backgroundMode: input.backgroundMode ?? 'OPAQUE',
        }, operation.result)
        return { state: 'COMPLETED' as const, artifactId: artifact.artifactId }
      } catch {
        return { state: 'FAILED' as const, errorCode: 'GATEWAY_OUTPUT_INVALID', billingState: 'CHARGED' as const }
      }
    }
    return {
      state: 'FAILED' as const,
      errorCode: operation.error?.code ?? (operation.status === 'EXPIRED' ? 'IDEMPOTENCY_RESPONSE_EXPIRED' : 'GATEWAY_OPERATION_FAILED'),
      billingState: billingState(operation),
    }
  }

  private async submitImageTask(
    input: Parameters<ImageGenerationPort['submit']>[0],
    body: string | FormData,
  ) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/image-tasks`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.dependencies.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(this.dependencies.timeoutMs ?? 30_000),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const code = gatewayErrorCode(payload, response.status)
        const state = code === 'IDEMPOTENCY_SUBMISSION_UNKNOWN'
          ? 'UNKNOWN' as const
          : [400, 401, 403, 404, 409, 422].includes(response.status) ? 'NOT_SUBMITTED' as const : 'UNKNOWN' as const
        throw new MediaSubmissionError(code, state, 'gateway rejected image task')
      }
      const operation = imageOperationSchema.safeParse(payload)
      if (!operation.success) {
        throw new MediaSubmissionError('GATEWAY_OPERATION_INVALID', 'UNKNOWN', 'gateway returned an invalid image operation')
      }
      return { operationId: operation.data.id, state: operationState(operation.data.status) }
    } catch (error) {
      if (error instanceof MediaSubmissionError) throw error
      const recovered = await this.lookupImageTask(input.idempotencyKey)
      if (recovered) return { operationId: recovered.id, state: operationState(recovered.status) }
      throw new MediaSubmissionError('GATEWAY_SUBMISSION_UNKNOWN', 'UNKNOWN', 'gateway submission status is unknown')
    }
  }

  private async lookupImageTask(idempotencyKey: string) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/image-tasks/by-idempotency`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.dependencies.apiKey}`,
          'Idempotency-Key': idempotencyKey,
        },
        signal: AbortSignal.timeout(this.dependencies.timeoutMs ?? 30_000),
      })
      if (!response.ok) return null
      const payload = await response.json().catch(() => null)
      const operation = imageOperationSchema.safeParse(payload)
      return operation.success ? operation.data : null
    } catch {
      return null
    }
  }

  private async storeOutput(
    input: Pick<Parameters<ImageGenerationPort['submit']>[0], 'tenantId' | 'idempotencyKey' | 'backgroundMode'>,
    result: z.infer<typeof gatewayResponseSchema>,
  ) {
    const image = decodedImage(result.data[0]!.b64_json)
    const bytes = input.backgroundMode === 'TRANSPARENT'
      ? await removeConnectedNeutralBackdrop(image.bytes)
      : image.bytes
    const runId = input.idempotencyKey.split(':')[0] || 'gateway-run'
    return this.dependencies.artifacts.put({
      tenantId: input.tenantId,
      runId,
      name: `${input.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '_')}.${image.mimeType.split('/')[1]}`,
      mimeType: image.mimeType,
      bytes,
      idempotencyKey: `${input.idempotencyKey}:gateway-output`,
    })
  }
}

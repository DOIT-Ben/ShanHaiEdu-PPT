import { z } from 'zod'
import sharp from 'sharp'
import type { ArtifactPort, ImageAspectDiagnostics, ImageGenerationPort } from '../core/ports'
import { MediaSubmissionError } from '../core/ports'
import { providerTechnicalFailure } from '../core/technical-recovery'
import {
  V4_IMAGE_ASPECT_TARGET,
  visualDeckV4AspectDecision,
  type VisualDeckV4AspectDecision,
} from '../core/image-aspect-policy'

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

type ImageOperation = z.infer<typeof imageOperationSchema>
type PollableImageOperationStatus = Extract<ImageOperation['status'], 'CREATED' | 'SUBMITTING' | 'QUEUED' | 'PROCESSING'>

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const GATEWAY_IMAGE_ASPECT_RATIO_TOLERANCE = 0.03
const MAX_GATEWAY_IMAGE_DIMENSION = 20_000

class GatewayImageAspectRatioError extends Error {
  readonly code = 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID'

  constructor(readonly aspectDiagnostics: ImageAspectDiagnostics | null = null) {
    super('gateway image pixels do not match the requested aspect ratio')
    this.name = 'GatewayImageAspectRatioError'
  }
}

class GatewayImageDimensionsError extends Error {
  readonly code = 'GATEWAY_IMAGE_DIMENSIONS_INVALID'

  constructor() {
    super('gateway image pixels exceed the supported dimensions')
    this.name = 'GatewayImageDimensionsError'
  }
}

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

function expectedAspectRatio(value: Parameters<ImageGenerationPort['submit']>[0]['aspectRatio']) {
  switch (value) {
    case '16:9': return 16 / 9
    case '4:3': return 4 / 3
    case '1:1': return 1
    case '3:4': return 3 / 4
  }
}

async function assertImageAspectRatio(
  image: Uint8Array,
  aspectRatio: Parameters<ImageGenerationPort['submit']>[0]['aspectRatio'],
  exactAspectRatio = false,
) {
  const metadata = await sharp(image).metadata()
  if (!metadata.width || !metadata.height) throw new Error('GATEWAY_IMAGE_OUTPUT_INVALID')
  if (metadata.width > MAX_GATEWAY_IMAGE_DIMENSION || metadata.height > MAX_GATEWAY_IMAGE_DIMENSION) {
    throw new GatewayImageDimensionsError()
  }
  const relativeError = Math.abs((metadata.width / metadata.height) / expectedAspectRatio(aspectRatio) - 1)
  if (aspectRatio === '16:9' && exactAspectRatio) {
    const decision = visualDeckV4AspectDecision(metadata.width, metadata.height)
    if (!decision) {
      throw new GatewayImageAspectRatioError({
        observedWidth: metadata.width,
        observedHeight: metadata.height,
        relativeError,
        normalization: 'REJECTED',
        normalizedWidth: null,
        normalizedHeight: null,
      })
    }
    return {
      crop: decision.crop,
      aspectDiagnostics: {
        observedWidth: metadata.width,
        observedHeight: metadata.height,
        relativeError,
        normalization: decision.crop ? 'NORMALIZED' as const : 'PASSTHROUGH' as const,
        normalizedWidth: decision.crop ? V4_IMAGE_ASPECT_TARGET.width : metadata.width,
        normalizedHeight: decision.crop ? V4_IMAGE_ASPECT_TARGET.height : metadata.height,
      },
    }
  }
  if (relativeError > GATEWAY_IMAGE_ASPECT_RATIO_TOLERANCE) {
    throw new GatewayImageAspectRatioError({
      observedWidth: metadata.width,
      observedHeight: metadata.height,
      relativeError,
      normalization: 'REJECTED',
      normalizedWidth: null,
      normalizedHeight: null,
    })
  }
  return { crop: null, aspectDiagnostics: null }
}

async function normalizedVisualDeckV4Image(
  image: Uint8Array,
  crop: VisualDeckV4AspectDecision['crop'],
) {
  if (!crop) return image
  return new Uint8Array(await sharp(image)
    .extract(crop)
    .resize(V4_IMAGE_ASPECT_TARGET.width, V4_IMAGE_ASPECT_TARGET.height, { fit: 'fill' })
    .png({ compressionLevel: 8 })
    .toBuffer())
}

function operationErrorCode(operation: ImageOperation) {
  return operation.error?.code
    ?? (operation.status === 'EXPIRED' ? 'IDEMPOTENCY_RESPONSE_EXPIRED' : 'GATEWAY_OPERATION_FAILED')
}

function isPollableImageOperationStatus(
  status: ImageOperation['status'],
): status is PollableImageOperationStatus {
  return status === 'CREATED' || status === 'SUBMITTING' || status === 'QUEUED' || status === 'PROCESSING'
}

function acceptedOperationState(operation: ImageOperation) {
  const errorCode = operationErrorCode(operation)
  if (isPollableImageOperationStatus(operation.status)) return pendingOperationState(operation.status)
  if (operation.status === 'SUBMISSION_UNKNOWN') {
    const unknownCode = errorCode === 'GATEWAY_OPERATION_FAILED' ? 'GATEWAY_SUBMISSION_UNKNOWN' : errorCode
    throw new MediaSubmissionError(
      unknownCode,
      'UNKNOWN',
      'gateway image task submission state is unknown',
      providerTechnicalFailure(unknownCode, { disposition: 'RETRYABLE' }),
      { operationId: operation.id },
    )
  }
  if (operation.submission_state === 'NOT_SUBMITTED') {
    throw new MediaSubmissionError(
      errorCode,
      'NOT_SUBMITTED',
      'gateway did not accept the image task',
      providerTechnicalFailure(errorCode),
      { billingState: 'NOT_CHARGED' },
    )
  }
  if (operation.status === 'FAILED' || operation.status === 'EXPIRED') {
    throw new MediaSubmissionError(
      errorCode,
      'SUBMITTED',
      'gateway accepted the image task but it already failed',
      providerTechnicalFailure(errorCode),
      { operationId: operation.id },
    )
  }
  return 'COMPLETED' as const
}

function pendingOperationState(status: PollableImageOperationStatus) {
  return status === 'PROCESSING' ? 'PROCESSING' as const : 'QUEUED' as const
}

function billingState() {
  // `submission_state` says whether the gateway accepted work, not whether a
  // provider charge was settled. This endpoint exposes no billing receipt.
  return 'UNKNOWN' as const
}

function inspectedSubmissionFailure(operation: ImageOperation) {
  const errorCode = operationErrorCode(operation)
  if (isPollableImageOperationStatus(operation.status)) return null
  if (operation.status === 'SUBMISSION_UNKNOWN') {
    const unknownCode = errorCode === 'GATEWAY_OPERATION_FAILED' ? 'GATEWAY_SUBMISSION_UNKNOWN' : errorCode
    return {
      state: 'FAILED' as const,
      submissionState: 'UNKNOWN' as const,
      errorCode: unknownCode,
      billingState: billingState(),
      technicalFailure: providerTechnicalFailure(unknownCode, { disposition: 'RETRYABLE' }),
      requiresIdempotencyDrain: true as const,
    }
  }
  if (operation.submission_state === 'NOT_SUBMITTED') {
    return {
      state: 'FAILED' as const,
      submissionState: 'NOT_SUBMITTED' as const,
      errorCode,
      billingState: 'NOT_CHARGED' as const,
      technicalFailure: providerTechnicalFailure(errorCode),
    }
  }
  return null
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
    /** Explicitly enables the gateway's IMAGE_TASK + IMAGE_EDIT contract. */
    imageEditTaskEnabled?: boolean
  }>) {
    this.baseUrl = normalizedBaseUrl(dependencies.baseUrl)
    if (dependencies.apiKey.trim().length < 8) throw new Error('GATEWAY_API_KEY_INVALID')
    this.fetchImpl = dependencies.fetchImpl ?? fetch
  }

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    const prompt = [
      input.prompt,
      input.backgroundMode === 'TRANSPARENT'
        ? '使用透明背景中的独立主体。不得绘制棋盘格、透明度网格、画框或背景。'
        : '',
      input.negativePrompt ? `避免：${input.negativePrompt}。` : '',
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
    if (input.operationMode === 'IMAGE_EDIT') {
      if (!reference) {
        throw new MediaSubmissionError(
          'IMAGE_EDIT_REFERENCE_REQUIRED',
          'NOT_SUBMITTED',
          'an asynchronous image edit requires one controlled reference image',
          providerTechnicalFailure('IMAGE_EDIT_REFERENCE_REQUIRED'),
          { billingState: 'NOT_CHARGED' },
        )
      }
      if (this.dependencies.imageEditTaskEnabled !== true) {
        throw new MediaSubmissionError(
          'IMAGE_EDIT_ASYNC_TASK_UNSUPPORTED',
          'NOT_SUBMITTED',
          'the gateway has not declared asynchronous image-edit task support',
          providerTechnicalFailure('IMAGE_EDIT_ASYNC_TASK_UNSUPPORTED'),
          { billingState: 'NOT_CHARGED' },
        )
      }
      return this.submitImageTask(input, body)
    }
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
      throw new MediaSubmissionError(
        'GATEWAY_SUBMISSION_UNKNOWN',
        'UNKNOWN',
        'gateway submission status is unknown',
        providerTechnicalFailure('GATEWAY_SUBMISSION_UNKNOWN', { disposition: 'RETRYABLE' }),
      )
    }

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const state = [400, 401, 403, 404, 422].includes(response.status) ? 'NOT_SUBMITTED' as const : 'UNKNOWN' as const
      const code = gatewayErrorCode(payload, response.status)
      throw new MediaSubmissionError(
        code,
        state,
        'gateway rejected image request',
        providerTechnicalFailure(code, {
          httpStatus: response.status,
          ...(state === 'UNKNOWN' ? { disposition: 'RETRYABLE' as const } : {}),
        }),
        state === 'NOT_SUBMITTED' ? { billingState: 'NOT_CHARGED' as const } : {},
      )
    }

    try {
      const output = await this.storeOutput(input, gatewayResponseSchema.parse(payload))
      return {
        operationId: `gateway-image:${output.artifact.artifactId}`,
        state: 'COMPLETED' as const,
        ...(output.aspectDiagnostics ? { aspectDiagnostics: output.aspectDiagnostics } : {}),
      }
    } catch (error) {
      const contractError = error instanceof GatewayImageAspectRatioError || error instanceof GatewayImageDimensionsError
      const errorCode = contractError ? error.code : 'GATEWAY_OUTPUT_INVALID'
      throw new MediaSubmissionError(
        errorCode,
        'SUBMITTED',
        'gateway returned an invalid image result',
        providerTechnicalFailure(errorCode, contractError
          ? { category: 'CONTRACT', disposition: 'NON_RETRYABLE' }
          : {}),
        error instanceof GatewayImageAspectRatioError && error.aspectDiagnostics
          ? { aspectDiagnostics: error.aspectDiagnostics }
          : {},
      )
    }
  }

  async lookupByIdempotency(input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0]) {
    const operation = await this.lookupImageTask(input.idempotencyKey, input.operationMode ?? 'TEXT_TO_IMAGE')
    if (!operation || operation.status === 'SUBMISSION_UNKNOWN') return { state: 'UNKNOWN' as const }
    if (isPollableImageOperationStatus(operation.status)) {
      return { state: 'SUBMITTED' as const, operationId: operation.id }
    }
    if (operation.submission_state === 'NOT_SUBMITTED') return { state: 'NOT_SUBMITTED' as const }
    return { state: 'SUBMITTED' as const, operationId: operation.id }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    const artifactId = input.operationId.startsWith('gateway-image:') ? input.operationId.slice('gateway-image:'.length) : ''
    if (artifactId) {
      const artifact = await this.dependencies.artifacts.get({ tenantId: input.tenantId, artifactId })
      return artifact
          ? { state: 'COMPLETED' as const, artifactId }
          : {
              state: 'FAILED' as const,
              submissionState: 'SUBMITTED' as const,
              errorCode: 'GATEWAY_ARTIFACT_MISSING',
              billingState: 'UNKNOWN' as const,
            technicalFailure: providerTechnicalFailure('GATEWAY_ARTIFACT_MISSING'),
          }
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
      const errorCode = gatewayErrorCode(payload, response.status)
      return {
        state: 'FAILED' as const,
        submissionState: 'SUBMITTED' as const,
        errorCode,
        billingState: 'UNKNOWN' as const,
        technicalFailure: providerTechnicalFailure(errorCode, { httpStatus: response.status }),
      }
    }

    const parsed = imageOperationSchema.safeParse(payload)
    if (!parsed.success) {
      return {
        state: 'FAILED' as const,
        submissionState: 'SUBMITTED' as const,
        errorCode: 'GATEWAY_OPERATION_INVALID',
        billingState: 'UNKNOWN' as const,
        technicalFailure: providerTechnicalFailure('GATEWAY_OPERATION_INVALID'),
      }
    }
    const operation = parsed.data
    const submissionFailure = inspectedSubmissionFailure(operation)
    if (submissionFailure) return submissionFailure
    if (isPollableImageOperationStatus(operation.status)) {
      return { state: pendingOperationState(operation.status) }
    }
    if (operation.status === 'COMPLETED') {
      if (!operation.result) {
        return {
          state: 'FAILED' as const,
          submissionState: 'SUBMITTED' as const,
          errorCode: 'GATEWAY_OUTPUT_MISSING',
          billingState: 'UNKNOWN' as const,
          technicalFailure: providerTechnicalFailure('GATEWAY_OUTPUT_MISSING'),
        }
      }
      try {
        const output = await this.storeOutput({
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey ?? input.operationId,
          aspectRatio: input.aspectRatio,
          ...(input.exactAspectRatio ? { exactAspectRatio: true } : {}),
          backgroundMode: input.backgroundMode ?? 'OPAQUE',
        }, operation.result)
        return {
          state: 'COMPLETED' as const,
          artifactId: output.artifact.artifactId,
          ...(output.aspectDiagnostics ? { aspectDiagnostics: output.aspectDiagnostics } : {}),
        }
      } catch (error) {
        const contractError = error instanceof GatewayImageAspectRatioError || error instanceof GatewayImageDimensionsError
        const errorCode = contractError ? error.code : 'GATEWAY_OUTPUT_INVALID'
        return {
          state: 'FAILED' as const,
          submissionState: 'SUBMITTED' as const,
          errorCode,
          billingState: 'UNKNOWN' as const,
          technicalFailure: providerTechnicalFailure(errorCode, contractError
            ? { category: 'CONTRACT', disposition: 'NON_RETRYABLE' }
            : {}),
          ...(error instanceof GatewayImageAspectRatioError && error.aspectDiagnostics
            ? { aspectDiagnostics: error.aspectDiagnostics }
            : {}),
        }
      }
    }
    const errorCode = operation.error?.code ?? (operation.status === 'EXPIRED' ? 'IDEMPOTENCY_RESPONSE_EXPIRED' : 'GATEWAY_OPERATION_FAILED')
    return {
      state: 'FAILED' as const,
      submissionState: 'SUBMITTED' as const,
      errorCode,
      billingState: billingState(),
      technicalFailure: providerTechnicalFailure(errorCode),
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
          'Idempotency-Key': input.idempotencyKey,
          'X-Image-Operation-Mode': input.operationMode ?? 'TEXT_TO_IMAGE',
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
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
        throw new MediaSubmissionError(
          code,
          state,
          'gateway rejected image task',
          providerTechnicalFailure(code, {
            httpStatus: response.status,
            ...(state === 'UNKNOWN' ? { disposition: 'RETRYABLE' as const } : {}),
          }),
          state === 'NOT_SUBMITTED' ? { billingState: 'NOT_CHARGED' as const } : {},
        )
      }
      const operation = imageOperationSchema.safeParse(payload)
      if (!operation.success) {
        throw new MediaSubmissionError(
          'GATEWAY_OPERATION_INVALID',
          'UNKNOWN',
          'gateway returned an invalid image operation',
          providerTechnicalFailure('GATEWAY_OPERATION_INVALID', { disposition: 'RETRYABLE' }),
        )
      }
      return { operationId: operation.data.id, state: acceptedOperationState(operation.data) }
    } catch (error) {
      if (error instanceof MediaSubmissionError) throw error
      const recovered = await this.lookupImageTask(input.idempotencyKey, input.operationMode ?? 'TEXT_TO_IMAGE')
      if (recovered) return { operationId: recovered.id, state: acceptedOperationState(recovered) }
      throw new MediaSubmissionError(
        'GATEWAY_SUBMISSION_UNKNOWN',
        'UNKNOWN',
        'gateway submission status is unknown',
        providerTechnicalFailure('GATEWAY_SUBMISSION_UNKNOWN', { disposition: 'RETRYABLE' }),
      )
    }
  }

  private async lookupImageTask(
    idempotencyKey: string,
    operationMode: 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' = 'TEXT_TO_IMAGE',
  ) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/image-tasks/by-idempotency`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.dependencies.apiKey}`,
          'Idempotency-Key': idempotencyKey,
          'X-Image-Operation-Mode': operationMode,
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
    input: Pick<Parameters<ImageGenerationPort['submit']>[0],
      'tenantId' | 'idempotencyKey' | 'aspectRatio' | 'backgroundMode' | 'exactAspectRatio'>,
    result: z.infer<typeof gatewayResponseSchema>,
  ) {
    const image = decodedImage(result.data[0]!.b64_json)
    const aspect = await assertImageAspectRatio(image.bytes, input.aspectRatio, input.exactAspectRatio)
    const normalized = input.exactAspectRatio && input.aspectRatio === '16:9'
      ? await normalizedVisualDeckV4Image(image.bytes, aspect.crop)
      : image.bytes
    const bytes = input.backgroundMode === 'TRANSPARENT'
      ? await removeConnectedNeutralBackdrop(normalized)
      : normalized
    const mimeType = aspect.crop ? 'image/png' : image.mimeType
    const runId = input.idempotencyKey.split(':')[0] || 'gateway-run'
    return {
      artifact: await this.dependencies.artifacts.put({
        tenantId: input.tenantId,
        runId,
        name: `${input.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '_')}.${mimeType.split('/')[1]}`,
        mimeType,
        bytes,
        idempotencyKey: `${input.idempotencyKey}:gateway-output`,
      }),
      aspectDiagnostics: aspect.aspectDiagnostics,
    }
  }
}

import { z } from 'zod'
import sharp from 'sharp'
import type { ArtifactPort, ImageGenerationPort } from '../core/ports'
import { MediaSubmissionError } from '../core/ports'

const gatewayResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) }).passthrough()).min(1),
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

function decodedImage(value: string) {
  const bytes = Buffer.from(value, 'base64')
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!png && !jpeg && !webp) throw new Error('GATEWAY_IMAGE_OUTPUT_INVALID')
  return { bytes: new Uint8Array(bytes), mimeType: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' }
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
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.dependencies.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          model: input.model,
          prompt,
          size: input.aspectRatio,
          resolution: '1K',
          n: 1,
        }),
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
      const parsed = gatewayResponseSchema.parse(payload)
      const image = decodedImage(parsed.data[0]!.b64_json)
      const bytes = input.backgroundMode === 'TRANSPARENT'
        ? await removeConnectedNeutralBackdrop(image.bytes)
        : image.bytes
      const runId = input.idempotencyKey.split(':')[0] || 'gateway-run'
      const artifact = await this.dependencies.artifacts.put({
        tenantId: input.tenantId,
        runId,
        name: `${input.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '_')}.${image.mimeType.split('/')[1]}`,
        mimeType: image.mimeType,
        bytes,
        idempotencyKey: `${input.idempotencyKey}:gateway-output`,
      })
      return { operationId: `gateway-image:${artifact.artifactId}`, state: 'COMPLETED' as const }
    } catch {
      throw new MediaSubmissionError('GATEWAY_OUTPUT_INVALID', 'UNKNOWN', 'gateway returned an invalid image result')
    }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    const artifactId = input.operationId.startsWith('gateway-image:') ? input.operationId.slice('gateway-image:'.length) : ''
    if (!artifactId) {
      return { state: 'FAILED' as const, errorCode: 'GATEWAY_OPERATION_INVALID', billingState: 'UNKNOWN' as const }
    }
    const artifact = await this.dependencies.artifacts.get({ tenantId: input.tenantId, artifactId })
    return artifact
      ? { state: 'COMPLETED' as const, artifactId }
      : { state: 'FAILED' as const, errorCode: 'GATEWAY_ARTIFACT_MISSING', billingState: 'CHARGED' as const }
  }
}

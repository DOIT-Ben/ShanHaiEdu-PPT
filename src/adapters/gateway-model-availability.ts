import { z } from 'zod'

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const modelDirectorySchema = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(120) }).passthrough()).max(500),
}).passthrough()

export const MAX_GATEWAY_MODEL_DIRECTORY_BYTES = 256 * 1024

function invalidDirectory() {
  return new Error('GATEWAY_MODEL_DIRECTORY_INVALID')
}

async function boundedDirectoryJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('Content-Length')
  if (declaredLength !== null) {
    const byteLength = Number(declaredLength)
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_GATEWAY_MODEL_DIRECTORY_BYTES) {
      throw invalidDirectory()
    }
  }
  if (!response.body) throw invalidDirectory()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_GATEWAY_MODEL_DIRECTORY_BYTES) {
        await reader.cancel()
        throw invalidDirectory()
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof Error && error.message === 'GATEWAY_MODEL_DIRECTORY_INVALID') throw error
    throw new Error('GATEWAY_MODEL_DIRECTORY_UNAVAILABLE')
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw invalidDirectory()
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

/**
 * This probe deliberately uses only the gateway directory. A visible model is
 * not treated as a successful generation; the model policy also requires a
 * separate, time-bounded real-evaluation attestation before publication.
 */
export class GatewayModelAvailabilityProbe {
  private readonly baseUrl: string
  private readonly fetchImpl: Fetch
  private readonly apiKey: string

  constructor(private readonly dependencies: Readonly<{
    baseUrl: string
    apiKey: string
    fetchImpl?: Fetch
    timeoutMs?: number
  }>) {
    this.baseUrl = normalizedBaseUrl(dependencies.baseUrl)
    this.apiKey = dependencies.apiKey.trim()
    if (this.apiKey.length < 8) throw new Error('GATEWAY_MODEL_DIRECTORY_KEY_REQUIRED')
    if (!Number.isSafeInteger(dependencies.timeoutMs ?? 10_000)
      || (dependencies.timeoutMs ?? 10_000) < 1_000
      || (dependencies.timeoutMs ?? 10_000) > 30_000) {
      throw new Error('GATEWAY_MODEL_DIRECTORY_TIMEOUT_INVALID')
    }
    this.fetchImpl = dependencies.fetchImpl ?? fetch
  }

  async listModels(): Promise<readonly string[]> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.dependencies.timeoutMs ?? 10_000),
      })
    } catch {
      throw new Error('GATEWAY_MODEL_DIRECTORY_UNAVAILABLE')
    }
    if (!response.ok) throw new Error('GATEWAY_MODEL_DIRECTORY_UNAVAILABLE')
    const body = await boundedDirectoryJson(response)
    const parsed = modelDirectorySchema.safeParse(body)
    if (!parsed.success) throw new Error('GATEWAY_MODEL_DIRECTORY_INVALID')
    return [...new Set(parsed.data.data.map((model) => model.id))]
  }
}

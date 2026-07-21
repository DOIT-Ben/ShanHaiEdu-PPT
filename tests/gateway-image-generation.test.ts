import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { GatewayImageGenerationPort } from '../src/adapters/gateway-image-generation'
import { MockArtifactPort } from '../src/adapters/mock-ports'
import { MediaSubmissionError } from '../src/core/ports'

const config = {
  baseUrl: 'https://newapi.doitbenai.cloud/v1',
  apiKey: 'test-image-key-0001',
}

describe('gateway image generation adapter', () => {
  test('stores a synchronous base64 result and recovers it from the opaque operation id', async () => {
    const artifacts = new MockArtifactPort()
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#49A078' } }).png().toBuffer()
    let captured: { url: string; init: RequestInit | undefined } | null = null
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init }
        return Response.json({ data: [{ b64_json: png.toString('base64') }] })
      },
    })
    const submitted = await adapter.submit({
      tenantId: 'frameflow',
      prompt: 'A child-friendly group of three apples supporting the number three lesson',
      negativePrompt: 'text, numbers, logos',
      model: 'image-2',
      aspectRatio: '1:1',
      backgroundMode: 'TRANSPARENT',
      idempotencyKey: 'run-1:asset:apples:r0:v1',
    })

    expect(submitted.state).toBe('COMPLETED')
    expect(await adapter.inspect({ tenantId: 'frameflow', operationId: submitted.operationId }))
      .toMatchObject({ state: 'COMPLETED' })
    const request = captured as unknown as { url: string; init: RequestInit }
    expect(request.url).toBe('https://newapi.doitbenai.cloud/v1/images/generations')
    expect(new Headers(request.init.headers).get('Idempotency-Key')).toBe('run-1:asset:apples:r0:v1')
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      model: 'image-2', size: '1:1', resolution: '1K', n: 1,
    })
    expect(String(JSON.parse(String(request.init.body)).prompt)).toContain('transparent background')
  })

  test('classifies validation rejection as not submitted and network failure as unknown', async () => {
    const artifacts = new MockArtifactPort()
    const rejected = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async () => Response.json({ error: { code: 'INVALID_IMAGE_REQUEST' } }, { status: 422 }),
    })
    await expect(rejected.submit({
      tenantId: 'frameflow', prompt: 'A valid educational illustration prompt', model: 'image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:asset:base:r0:v1',
    })).rejects.toMatchObject({ submissionState: 'NOT_SUBMITTED', code: 'INVALID_IMAGE_REQUEST' })

    const unknown = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async () => { throw new Error('private network detail') },
    })
    await expect(unknown.submit({
      tenantId: 'frameflow', prompt: 'A valid educational illustration prompt', model: 'image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:asset:base:r0:v1',
    })).rejects.toBeInstanceOf(MediaSubmissionError)
    await expect(unknown.submit({
      tenantId: 'frameflow', prompt: 'A valid educational illustration prompt', model: 'image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:asset:base:r0:v1',
    })).rejects.toMatchObject({ submissionState: 'UNKNOWN', code: 'GATEWAY_SUBMISSION_UNKNOWN' })
  })

  test('rejects non-loopback plaintext gateway endpoints', () => {
    expect(() => new GatewayImageGenerationPort({
      baseUrl: 'http://example.com/v1', apiKey: 'test-image-key-0001', artifacts: new MockArtifactPort(),
    })).toThrow('GATEWAY_BASE_URL_INSECURE')
  })
})

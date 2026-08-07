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
  test('submits a persistent async operation and stores its completed output', async () => {
    const artifacts = new MockArtifactPort()
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 216, g: 216, b: 216 } } })
      .composite([{ input: Buffer.from('<svg width="32" height="32"><rect width="32" height="32" rx="8" fill="#D62828"/></svg>'), left: 16, top: 16 }])
      .png().toBuffer()
    const operationId = 'imgop_0123456789abcdef0123456789abcdef'
    const captured: { url: string; init: RequestInit | undefined }[] = []
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async (url, init) => {
        captured.push({ url: String(url), init })
        if (String(url).endsWith('/image-tasks')) {
          return Response.json({ id: operationId, status: 'QUEUED', submission_state: 'SUBMITTED' }, { status: 202 })
        }
        return Response.json({
          id: operationId,
          status: 'COMPLETED',
          submission_state: 'SUBMITTED',
          result: { data: [{ b64_json: png.toString('base64') }] },
        })
      },
    })
    const submitted = await adapter.submit({
      tenantId: 'frameflow',
      prompt: 'A child-friendly group of three apples supporting the number three lesson',
      negativePrompt: 'text, numbers, logos',
      model: 'gpt-image-2',
      aspectRatio: '1:1',
      backgroundMode: 'TRANSPARENT',
      idempotencyKey: 'run-1:asset:apples:r0:v1',
    })

    expect(submitted).toEqual({ operationId, state: 'QUEUED' })
    const inspected = await adapter.inspect({
      tenantId: 'frameflow', operationId: submitted.operationId,
      idempotencyKey: 'run-1:asset:apples:r0:v1', aspectRatio: '1:1', backgroundMode: 'TRANSPARENT',
    })
    expect(inspected).toMatchObject({ state: 'COMPLETED' })
    const stored = inspected.state === 'COMPLETED' ? artifacts.artifacts.get(inspected.artifactId) : null
    const raw = await sharp(stored!.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const alpha = Array.from({ length: raw.info.width * raw.info.height }, (_, index) => raw.data[index * 4 + 3]!)
    expect(Math.min(...alpha)).toBe(0)
    expect(Math.max(...alpha)).toBe(255)
    const request = captured[0] as { url: string; init: RequestInit }
    expect(request.url).toBe('https://newapi.doitbenai.cloud/v1/image-tasks')
    expect(new Headers(request.init.headers).get('Idempotency-Key')).toBe('run-1:asset:apples:r0:v1')
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      model: 'gpt-image-2', size: '1:1', resolution: '1K', n: 1,
    })
    expect(String(JSON.parse(String(request.init.body)).prompt)).toContain('透明背景中的独立主体')
  })

  test('rejects a completed gateway image whose actual pixels violate the requested ratio', async () => {
    const artifacts = new MockArtifactPort()
    const nearSixteenNine = await sharp({
      create: { width: 1360, height: 768, channels: 3, background: '#DDE7F7' },
    }).png().toBuffer()
    const operationId = 'imgop_11111111111111111111111111111111'
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async (url) => String(url).endsWith('/image-tasks')
        ? Response.json({ id: operationId, status: 'QUEUED', submission_state: 'SUBMITTED' }, { status: 202 })
        : Response.json({
            id: operationId,
            status: 'COMPLETED',
            submission_state: 'SUBMITTED',
            result: { data: [{ b64_json: nearSixteenNine.toString('base64') }] },
          }),
    })
    const submitted = await adapter.submit({
      tenantId: 'frameflow', prompt: 'A complete 16 by 9 classroom slide', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:slide:1:image:r0:v1',
    })

    await expect(adapter.inspect({
      tenantId: 'frameflow', operationId: submitted.operationId,
      idempotencyKey: 'run-1:slide:1:image:r0:v1', aspectRatio: '16:9', exactAspectRatio: true,
    })).resolves.toEqual({
      state: 'FAILED',
      errorCode: 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID',
      billingState: 'CHARGED',
      technicalFailure: {
        category: 'CONTRACT', disposition: 'NON_RETRYABLE', diagnosticCode: 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID',
      },
    })
    expect(artifacts.artifacts.size).toBe(0)
  })

  test('preserves the legacy tolerance for a near-16:9 non-V4 image', async () => {
    const artifacts = new MockArtifactPort()
    const nearSixteenNine = await sharp({
      create: { width: 1360, height: 768, channels: 3, background: '#DDE7F7' },
    }).png().toBuffer()
    const operationId = 'imgop_22222222222222222222222222222222'
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async (url) => String(url).endsWith('/image-tasks')
        ? Response.json({ id: operationId, status: 'QUEUED', submission_state: 'SUBMITTED' }, { status: 202 })
        : Response.json({
            id: operationId, status: 'COMPLETED', submission_state: 'SUBMITTED',
            result: { data: [{ b64_json: nearSixteenNine.toString('base64') }] },
          }),
    })
    const submitted = await adapter.submit({
      tenantId: 'frameflow', prompt: 'A legacy 16 by 9 classroom asset', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-legacy:slide:1:image:r0:v1',
    })

    await expect(adapter.inspect({
      tenantId: 'frameflow', operationId: submitted.operationId,
      idempotencyKey: 'run-legacy:slide:1:image:r0:v1', aspectRatio: '16:9',
    })).resolves.toMatchObject({ state: 'COMPLETED' })
  })

  test('classifies validation rejection as not submitted and network failure as unknown', async () => {
    const artifacts = new MockArtifactPort()
    const rejected = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async () => Response.json({ error: { code: 'INVALID_IMAGE_REQUEST' } }, { status: 422 }),
    })
    await expect(rejected.submit({
      tenantId: 'frameflow', prompt: 'A valid educational illustration prompt', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:asset:base:r0:v1',
    })).rejects.toMatchObject({
      submissionState: 'NOT_SUBMITTED',
      code: 'INVALID_IMAGE_REQUEST',
      technicalFailure: {
        category: 'PROVIDER', disposition: 'NON_RETRYABLE', diagnosticCode: 'INVALID_IMAGE_REQUEST',
      },
    })

    const unknown = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async () => { throw new Error('private network detail') },
    })
    await expect(unknown.submit({
      tenantId: 'frameflow', prompt: 'A valid educational illustration prompt', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:asset:base:r0:v1',
    })).rejects.toBeInstanceOf(MediaSubmissionError)
    await expect(unknown.submit({
      tenantId: 'frameflow', prompt: 'A valid educational illustration prompt', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:asset:base:r0:v1',
    })).rejects.toMatchObject({ submissionState: 'UNKNOWN', code: 'GATEWAY_SUBMISSION_UNKNOWN' })

    const submissionUnknown = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async () => Response.json({ error: { code: 'IDEMPOTENCY_SUBMISSION_UNKNOWN' } }, { status: 409 }),
    })
    await expect(submissionUnknown.submit({
      tenantId: 'frameflow', prompt: 'A valid educational illustration prompt', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:asset:base:r0:v1',
    })).rejects.toMatchObject({ submissionState: 'UNKNOWN', code: 'IDEMPOTENCY_SUBMISSION_UNKNOWN' })
  })

  test('recovers the persistent operation by the original idempotency key after a response loss', async () => {
    const artifacts = new MockArtifactPort()
    const operationId = 'imgop_0123456789abcdef0123456789abcdef'
    const requests: string[] = []
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async (url) => {
        requests.push(String(url))
        if (String(url).endsWith('/image-tasks')) throw new Error('connection dropped after gateway accepted request')
        return Response.json({ id: operationId, status: 'SUBMITTING', submission_state: 'UNKNOWN' })
      },
    })

    await expect(adapter.submit({
      tenantId: 'frameflow', prompt: 'A valid educational illustration prompt', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:asset:base:r0:v1',
    })).resolves.toEqual({ operationId, state: 'QUEUED' })
    expect(requests).toEqual([
      'https://newapi.doitbenai.cloud/v1/image-tasks',
      'https://newapi.doitbenai.cloud/v1/image-tasks/by-idempotency',
    ])
  })

  test.each([408, 429, 500])('keeps a known image task pollable after transient gateway status %i', async (status) => {
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => Response.json({ error: { code: 'RATE_LIMITED' } }, { status }),
    })

    await expect(adapter.inspect({
      tenantId: 'frameflow',
      operationId: 'imgop_0123456789abcdef0123456789abcdef',
      idempotencyKey: 'run-1:slide:1:image:r0:v1', aspectRatio: '16:9',
    })).resolves.toMatchObject({ state: 'PROCESSING', retryAfterMs: 2_000 })
  })

  test('honors Retry-After for a transient image task lookup', async () => {
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => Response.json({ error: { code: 'RATE_LIMITED' } }, {
        status: 429,
        headers: { 'Retry-After': '7' },
      }),
    })

    await expect(adapter.inspect({
      tenantId: 'frameflow',
      operationId: 'imgop_0123456789abcdef0123456789abcdef',
      aspectRatio: '16:9',
    })).resolves.toEqual({ state: 'PROCESSING', retryAfterMs: 7_000 })
  })

  test('keeps authorization failures as an explicit unknown-billing result', async () => {
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => Response.json({ error: { code: 'MODEL_FORBIDDEN' } }, { status: 403 }),
    })

    await expect(adapter.inspect({
      tenantId: 'frameflow',
      operationId: 'imgop_0123456789abcdef0123456789abcdef',
      aspectRatio: '16:9',
    })).resolves.toEqual({
      state: 'FAILED',
      errorCode: 'MODEL_FORBIDDEN',
      billingState: 'UNKNOWN',
      technicalFailure: {
        category: 'PROVIDER', disposition: 'NON_RETRYABLE', diagnosticCode: 'MODEL_FORBIDDEN',
      },
    })
  })

  test('fails closed for an unrecognized provider operation code while retaining its diagnostic', async () => {
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => Response.json({
        id: 'imgop_0123456789abcdef0123456789abcdef',
        status: 'FAILED',
        submission_state: 'SUBMITTED',
        error: { code: 'INVALID_REQUEST' },
      }),
    })

    await expect(adapter.inspect({
      tenantId: 'frameflow',
      operationId: 'imgop_0123456789abcdef0123456789abcdef',
      aspectRatio: '16:9',
    })).resolves.toEqual({
      state: 'FAILED',
      errorCode: 'INVALID_REQUEST',
      billingState: 'CHARGED',
      technicalFailure: {
        category: 'PROVIDER', disposition: 'NON_RETRYABLE', diagnosticCode: 'INVALID_REQUEST',
      },
    })
  })

  test('uses a multipart image edit request for a selected source reference', async () => {
    const artifacts = new MockArtifactPort()
    const reference = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#4C956C' } }).png().toBuffer()
    const output = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#2C6E49' } }).png().toBuffer()
    let captured: { url: string; init: RequestInit } | null = null
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init! }
        return Response.json({ data: [{ b64_json: output.toString('base64') }] })
      },
    })

    await adapter.submit({
      tenantId: 'frameflow', prompt: 'Create a lesson illustration based on the exact supplied textbook leaf',
      model: 'gpt-image-2', aspectRatio: '1:1', idempotencyKey: 'run-1:asset:leaf-reference:r0:v1',
      referenceImage: { mimeType: 'image/png', bytes: new Uint8Array(reference), sha256: 'a'.repeat(64) },
    })

    const request = captured as unknown as { url: string; init: RequestInit }
    expect(request.url).toBe('https://newapi.doitbenai.cloud/v1/images/edits')
    expect(new Headers(request.init.headers).has('Content-Type')).toBe(false)
    expect(request.init.body).toBeInstanceOf(FormData)
    const form = request.init.body as FormData
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('prompt')).toContain('exact supplied textbook leaf')
    expect(form.get('image')).toBeInstanceOf(Blob)
    expect((form.get('image') as Blob).size).toBe(reference.length)
  })

  test('looks up an image edit with its persisted operation mode and original key', async () => {
    let captured: { url: string; headers: Headers } | null = null
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts: new MockArtifactPort(),
      fetchImpl: async (url, init) => {
        captured = { url: String(url), headers: new Headers(init?.headers) }
        return Response.json({
          id: 'imgop_0123456789abcdef0123456789abcdef',
          status: 'PROCESSING',
          submission_state: 'SUBMITTED',
        })
      },
    })
    const key = `run-1:slide:1:image:r1:v1:edit:${'a'.repeat(24)}`

    await adapter.lookupByIdempotency!({
      tenantId: 'frameflow', idempotencyKey: key, operationMode: 'IMAGE_EDIT',
    })

    const request = captured as unknown as { url: string; headers: Headers }
    expect(request.url).toBe('https://newapi.doitbenai.cloud/v1/image-tasks/by-idempotency')
    expect(request.headers.get('Idempotency-Key')).toBe(key)
    expect(request.headers.get('X-Image-Operation-Mode')).toBe('IMAGE_EDIT')
  })

  test('rejects non-loopback plaintext gateway endpoints', () => {
    expect(() => new GatewayImageGenerationPort({
      baseUrl: 'http://example.com/v1', apiKey: 'test-image-key-0001', artifacts: new MockArtifactPort(),
    })).toThrow('GATEWAY_BASE_URL_INSECURE')
  })
})

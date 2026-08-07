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

  test.each(['CREATED', 'SUBMITTING'] as const)(
    'keeps a gateway-persisted %s task pollable while its provider submission has not started',
    async (status) => {
      const artifacts = new MockArtifactPort()
      const operationId = 'imgop_1234567890abcdef1234567890abcdef'
      const adapter = new GatewayImageGenerationPort({
        ...config,
        artifacts,
        fetchImpl: async () => Response.json({
          id: operationId,
          status,
          submission_state: 'NOT_SUBMITTED',
        }, { status: 202 }),
      })
      const input = {
        tenantId: 'frameflow',
        prompt: 'A complete 16 by 9 classroom slide',
        model: 'gemini-3-pro-image-preview',
        aspectRatio: '16:9' as const,
        idempotencyKey: 'run-1:slide:1:image:r0:v1',
      }

      await expect(adapter.submit(input)).resolves.toEqual({ operationId, state: 'QUEUED' })
      await expect(adapter.lookupByIdempotency!(input)).resolves.toEqual({ state: 'SUBMITTED', operationId })
      await expect(adapter.inspect({ ...input, operationId })).resolves.toEqual({ state: 'QUEUED' })
    },
  )

  test('normalizes a near-16:9 V4 image into an exact 1600 by 900 artifact', async () => {
    const artifacts = new MockArtifactPort()
    const nearSixteenNine = await sharp({
      create: { width: 1376, height: 768, channels: 3, background: '#DDE7F7' },
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

    const inspected = await adapter.inspect({
      tenantId: 'frameflow', operationId: submitted.operationId,
      idempotencyKey: 'run-1:slide:1:image:r0:v1', aspectRatio: '16:9', exactAspectRatio: true,
    })
    expect(inspected).toMatchObject({
      state: 'COMPLETED',
      aspectDiagnostics: {
        observedWidth: 1376,
        observedHeight: 768,
        relativeError: 0.0078125,
        normalization: 'NORMALIZED',
        normalizedWidth: 1600,
        normalizedHeight: 900,
      },
    })
    const artifact = inspected.state === 'COMPLETED' ? artifacts.artifacts.get(inspected.artifactId) : null
    expect(artifact).toBeDefined()
    await expect(sharp(artifact!.bytes).metadata()).resolves.toMatchObject({ width: 1600, height: 900 })
  })

  test.each([
    { width: 2048, height: 2048, label: 'square' },
    { width: 1200, height: 800, label: 'three-by-two' },
    { width: 1024, height: 768, label: 'four-by-three' },
  ])('rejects a completed V4 $label image whose actual pixels materially violate the requested ratio', async ({ width, height }) => {
    const artifacts = new MockArtifactPort()
    const invalid = await sharp({
      create: { width, height, channels: 3, background: '#DDE7F7' },
    }).png().toBuffer()
    const operationId = 'imgop_11111111111111111111111111111111'
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async (url) => String(url).endsWith('/image-tasks')
        ? Response.json({ id: operationId, status: 'QUEUED', submission_state: 'SUBMITTED' }, { status: 202 })
        : Response.json({
            id: operationId, status: 'COMPLETED', submission_state: 'SUBMITTED',
            result: { data: [{ b64_json: invalid.toString('base64') }] },
          }),
    })
    const submitted = await adapter.submit({
      tenantId: 'frameflow', prompt: 'A complete 16 by 9 classroom slide', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:slide:1:image:r0:v1',
    })

    await expect(adapter.inspect({
      tenantId: 'frameflow', operationId: submitted.operationId,
      idempotencyKey: 'run-1:slide:1:image:r0:v1', aspectRatio: '16:9', exactAspectRatio: true,
    })).resolves.toMatchObject({
      state: 'FAILED',
      errorCode: 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID',
      billingState: 'UNKNOWN',
      aspectDiagnostics: {
        observedWidth: width,
        observedHeight: height,
        normalization: 'REJECTED',
      },
      technicalFailure: {
        category: 'CONTRACT', disposition: 'NON_RETRYABLE', diagnosticCode: 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID',
      },
    })
    expect(artifacts.artifacts.size).toBe(0)
  })

  test('rejects a decoded image whose dimensions exceed the public diagnostic bound', async () => {
    const artifacts = new MockArtifactPort()
    const oversized = await sharp({
      create: { width: 20_001, height: 1, channels: 3, background: '#DDE7F7' },
    }).png().toBuffer()
    const operationId = 'imgop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async (url) => String(url).endsWith('/image-tasks')
        ? Response.json({ id: operationId, status: 'QUEUED', submission_state: 'SUBMITTED' }, { status: 202 })
        : Response.json({
            id: operationId,
            status: 'COMPLETED',
            submission_state: 'SUBMITTED',
            result: { data: [{ b64_json: oversized.toString('base64') }] },
          }),
    })
    const submitted = await adapter.submit({
      tenantId: 'frameflow', prompt: 'A bounded complete classroom slide', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:slide:1:image:r0:v1',
    })

    await expect(adapter.inspect({
      tenantId: 'frameflow', operationId: submitted.operationId,
      idempotencyKey: 'run-1:slide:1:image:r0:v1', aspectRatio: '16:9', exactAspectRatio: true,
    })).resolves.toMatchObject({
      state: 'FAILED',
      errorCode: 'GATEWAY_IMAGE_DIMENSIONS_INVALID',
      billingState: 'UNKNOWN',
      technicalFailure: {
        category: 'CONTRACT', disposition: 'NON_RETRYABLE', diagnosticCode: 'GATEWAY_IMAGE_DIMENSIONS_INVALID',
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
      billingState: 'NOT_CHARGED',
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
    })).rejects.toMatchObject({
      submissionState: 'UNKNOWN', billingState: 'UNKNOWN', code: 'GATEWAY_SUBMISSION_UNKNOWN',
    })

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

  test.each([
    {
      label: 'terminal not-submitted', status: 'FAILED', submissionState: 'NOT_SUBMITTED',
      errorCode: 'IMAGE_TASK_REJECTED', expectedCode: 'IMAGE_TASK_REJECTED', operationId: null,
    },
    {
      label: 'expired before submission', status: 'EXPIRED', submissionState: 'NOT_SUBMITTED',
      errorCode: undefined, expectedCode: 'IDEMPOTENCY_RESPONSE_EXPIRED', operationId: null,
    },
    {
      label: 'unknown', status: 'SUBMITTING', submissionState: 'UNKNOWN',
      errorCode: undefined, expectedCode: 'GATEWAY_SUBMISSION_UNKNOWN', operationId: 'imgop_0123456789abcdef0123456789abcdef',
    },
    {
      label: 'failed', status: 'FAILED', submissionState: 'SUBMITTED',
      errorCode: 'IMAGE_TASK_FAILED', expectedCode: 'IMAGE_TASK_FAILED',
      operationId: 'imgop_0123456789abcdef0123456789abcdef',
    },
    {
      label: 'expired', status: 'EXPIRED', submissionState: 'SUBMITTED',
      errorCode: undefined, expectedCode: 'IDEMPOTENCY_RESPONSE_EXPIRED',
      operationId: 'imgop_0123456789abcdef0123456789abcdef',
    },
  ] as const)('does not turn a recovered $label image task into QUEUED', async (case_) => {
    const artifacts = new MockArtifactPort()
    const operationId = 'imgop_0123456789abcdef0123456789abcdef'
    const requests: string[] = []
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async (url) => {
        requests.push(String(url))
        if (String(url).endsWith('/image-tasks')) throw new Error('connection dropped after gateway accepted request')
        return Response.json({
          id: operationId,
          status: case_.status,
          submission_state: case_.submissionState,
          ...(case_.errorCode ? { error: { code: case_.errorCode } } : {}),
        })
      },
    })

    await expect(adapter.submit({
      tenantId: 'frameflow', prompt: 'A valid educational illustration prompt', model: 'gpt-image-2',
      aspectRatio: '16:9', idempotencyKey: 'run-1:asset:base:r0:v1',
    })).rejects.toMatchObject({
      submissionState: case_.submissionState,
      code: case_.expectedCode,
      ...(case_.operationId ? { operationId: case_.operationId } : {}),
    })
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

  test.each([
    {
      label: 'unknown submission while processing', status: 'PROCESSING', submissionState: 'UNKNOWN',
      error: undefined, expected: { errorCode: 'GATEWAY_SUBMISSION_UNKNOWN', billingState: 'UNKNOWN' },
    },
    {
      label: 'explicitly unsubmitted task while queued', status: 'QUEUED', submissionState: 'NOT_SUBMITTED',
      error: 'MODEL_FORBIDDEN', expected: { errorCode: 'MODEL_FORBIDDEN', billingState: 'NOT_CHARGED' },
    },
    {
      label: 'unknown submission despite a completed payload', status: 'COMPLETED', submissionState: 'UNKNOWN',
      error: undefined, expected: { errorCode: 'GATEWAY_SUBMISSION_UNKNOWN', billingState: 'UNKNOWN' },
    },
  ] as const)('stops inspection for $label', async (case_) => {
    const artifacts = new MockArtifactPort()
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async () => Response.json({
        id: 'imgop_0123456789abcdef0123456789abcdef',
        status: case_.status,
        submission_state: case_.submissionState,
        ...(case_.error ? { error: { code: case_.error } } : {}),
        ...(case_.status === 'COMPLETED' ? { result: { data: [{ b64_json: 'not-an-image' }] } } : {}),
      }),
    })

    await expect(adapter.inspect({
      tenantId: 'frameflow', operationId: 'imgop_0123456789abcdef0123456789abcdef',
      idempotencyKey: 'run-1:slide:1:image:r0:v1', aspectRatio: '16:9',
    })).resolves.toMatchObject({
      state: 'FAILED',
      ...case_.expected,
    })
    expect(artifacts.artifacts.size).toBe(0)
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
      billingState: 'UNKNOWN',
      technicalFailure: {
        category: 'PROVIDER', disposition: 'NON_RETRYABLE', diagnosticCode: 'INVALID_REQUEST',
      },
    })
  })

  test('records an accepted synchronous edit output-contract failure as submitted with unknown billing', async () => {
    const artifacts = new MockArtifactPort()
    const reference = await sharp({
      create: { width: 64, height: 36, channels: 3, background: '#4C956C' },
    }).png().toBuffer()
    const invalid = await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: '#D62828' },
    }).png().toBuffer()
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      fetchImpl: async () => Response.json({ data: [{ b64_json: invalid.toString('base64') }] }),
    })

    await expect(adapter.submit({
      tenantId: 'frameflow',
      prompt: 'Correct only the supplied slide image',
      model: 'gpt-image-2',
      aspectRatio: '16:9',
      exactAspectRatio: true,
      idempotencyKey: 'run-1:slide:1:image:r1:v1:edit:aaaaaaaaaaaaaaaaaaaaaaaa',
      referenceImage: { mimeType: 'image/png', bytes: new Uint8Array(reference), sha256: 'a'.repeat(64) },
    })).rejects.toMatchObject({
      code: 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID',
      submissionState: 'SUBMITTED',
      billingState: 'UNKNOWN',
      technicalFailure: {
        category: 'CONTRACT', disposition: 'NON_RETRYABLE', diagnosticCode: 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID',
      },
    })
  })

  test('submits an explicit image edit as an asynchronous image task with the original idempotency key', async () => {
    const artifacts = new MockArtifactPort()
    const reference = await sharp({
      create: { width: 64, height: 36, channels: 3, background: '#4C956C' },
    }).png().toBuffer()
    const operationId = 'imgop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    let captured: { url: string; init: RequestInit } | null = null
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts,
      imageEditTaskEnabled: true,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init! }
        return Response.json({ id: operationId, status: 'QUEUED', submission_state: 'SUBMITTED' }, { status: 202 })
      },
    })

    await expect(adapter.submit({
      tenantId: 'frameflow',
      prompt: 'Correct only the supplied slide image',
      model: 'gpt-image-2',
      aspectRatio: '16:9',
      exactAspectRatio: true,
      operationMode: 'IMAGE_EDIT',
      idempotencyKey: 'run-1:slide:1:image:r1:v1:edit:aaaaaaaaaaaaaaaaaaaaaaaa',
      referenceImage: { mimeType: 'image/png', bytes: new Uint8Array(reference), sha256: 'a'.repeat(64) },
    })).resolves.toEqual({ operationId, state: 'QUEUED' })

    const request = captured as unknown as { url: string; init: RequestInit }
    expect(request.url).toBe('https://newapi.doitbenai.cloud/v1/image-tasks')
    expect(new Headers(request.init.headers).get('X-Image-Operation-Mode')).toBe('IMAGE_EDIT')
    expect(new Headers(request.init.headers).has('Content-Type')).toBe(false)
    expect(request.init.body).toBeInstanceOf(FormData)
    const form = request.init.body as FormData
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('image')).toBeInstanceOf(Blob)
    expect((form.get('image') as Blob).size).toBe(reference.length)
  })

  test('rejects an explicit image edit before any gateway request when the async task capability is disabled', async () => {
    const reference = await sharp({
      create: { width: 64, height: 36, channels: 3, background: '#4C956C' },
    }).png().toBuffer()
    let calls = 0
    const adapter = new GatewayImageGenerationPort({
      ...config,
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => {
        calls += 1
        return Response.error()
      },
    })

    await expect(adapter.submit({
      tenantId: 'frameflow',
      prompt: 'Correct only the supplied slide image',
      model: 'gpt-image-2',
      aspectRatio: '16:9',
      operationMode: 'IMAGE_EDIT',
      idempotencyKey: 'run-1:slide:1:image:r1:v1:edit:bbbbbbbbbbbbbbbbbbbbbbbb',
      referenceImage: { mimeType: 'image/png', bytes: new Uint8Array(reference), sha256: 'b'.repeat(64) },
    })).rejects.toMatchObject({
      code: 'IMAGE_EDIT_ASYNC_TASK_UNSUPPORTED',
      submissionState: 'NOT_SUBMITTED',
      billingState: 'NOT_CHARGED',
    })
    expect(calls).toBe(0)
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

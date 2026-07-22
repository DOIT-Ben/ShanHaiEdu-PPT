import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { HttpFrameFlowBackend } from '../src/adapters/frameflow-http-backend'

const token = 'test-agent-token-0001'

describe('FrameFlow internal source backend', () => {
  test('loads a controlled source package with server authentication and verified bytes', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let headers = new Headers()
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010',
      token,
      fetchImpl: async (_url, init) => {
        headers = new Headers(init?.headers)
        return Response.json({ data: {
          name: '叶片.png', kind: 'IMAGE', mimeType: 'image/png', status: 'READY', textTruncated: false,
          chunks: [],
          assets: [{
            id: 'asset-1', sourceId: 'attachment-1', name: '叶片.png', mimeType: 'image/png',
            byteLength: bytes.length, sha256, width: 80, height: 60,
            contentBase64: Buffer.from(bytes).toString('base64'),
          }],
        } })
      },
    })

    const result = await backend.getDocumentAttachment({ externalUserId: 'teacher-1', attachmentId: 'attachment-1' })

    expect(headers.get('Authorization')).toBe(`Bearer ${token}`)
    expect(headers.get('X-PPT-Agent-User')).toBe('teacher-1')
    expect(result).toMatchObject({ status: 'READY', assets: [{ id: 'asset-1', bytes }] })
  })

  test('surfaces one unavailable attachment as a visible source failure', async () => {
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token, fetchImpl: async () => new Response(null, { status: 404 }),
    })
    expect(await backend.getDocumentAttachment({ externalUserId: 'teacher-1', attachmentId: 'missing-1' }))
      .toMatchObject({ status: 'FAILED', failureCode: 'SOURCE_ENDPOINT_HTTP_404' })
  })

  test('turns corrupt source image bytes into a visible attachment failure', async () => {
    const client = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token: 'test-internal-token-0001',
      fetchImpl: async () => Response.json({ data: {
        name: '教材图.png', kind: 'IMAGE', mimeType: 'image/png', status: 'READY', textTruncated: false,
        chunks: [], assets: [{
          id: 'asset-1', sourceId: 'attachment-1', name: '教材图.png', mimeType: 'image/png',
          byteLength: 8, sha256: 'a'.repeat(64), width: 32, height: 32,
          contentBase64: Buffer.from('not-image').toString('base64'),
        }],
      } }),
    })

    await expect(client.getDocumentAttachment({ externalUserId: 'teacher-1', attachmentId: 'attachment-1' }))
      .resolves.toMatchObject({ status: 'FAILED', failureCode: 'SOURCE_ASSET_INTEGRITY_MISMATCH' })
  })

  test('rejects non-loopback source endpoints', () => {
    expect(() => new HttpFrameFlowBackend({ baseUrl: 'https://frameflow.example.com', token })).toThrow('MUST_BE_LOOPBACK')
    expect(() => new HttpFrameFlowBackend({ baseUrl: 'http://user@127.0.0.1:3010', token })).toThrow('MUST_BE_LOOPBACK')
    expect(() => new HttpFrameFlowBackend({ baseUrl: 'http://127.0.0.1:3010/internal', token })).toThrow('MUST_BE_LOOPBACK')
    expect(() => new HttpFrameFlowBackend({ baseUrl: 'http://127.0.0.1:3010?target=other', token })).toThrow('MUST_BE_LOOPBACK')
    expect(() => new HttpFrameFlowBackend({ baseUrl: 'http://127.0.0.1:3010', token: `${token} ` })).toThrow('TOKEN_REQUIRED')
  })

  test('reserves catalog-priced FrameFlow credits with authenticated idempotent context', async () => {
    let url = ''
    let request = new Request('http://localhost')
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010',
      token,
      fetchImpl: async (input, init) => {
        url = String(input)
        request = new Request(url, init)
        return Response.json({
          data: {
            reservationId: 'reservation-1',
            status: 'RESERVED',
            reservedCredits: 10,
            settledCredits: null,
          },
        })
      },
    })

    await expect(backend.reserveCredits({
      externalUserId: 'teacher-1',
      model: 'image-2',
      units: 1,
      idempotencyKey: 'run-1:slide-1:image-v1',
    })).resolves.toEqual({ reservationId: 'reservation-1' })
    expect(url).toBe('http://127.0.0.1:3010/api/internal/ppt-agent/credits/reservations')
    expect(request.method).toBe('POST')
    expect(request.headers.get('Authorization')).toBe(`Bearer ${token}`)
    expect(request.headers.get('X-PPT-Agent-User')).toBe('teacher-1')
    expect(request.headers.get('Idempotency-Key')).toBe('run-1:slide-1:image-v1')
    expect(await request.json()).toEqual({ model: 'image-2', units: 1 })
  })

  test('distinguishes definite reservation denial from an unknown host result', async () => {
    const denied = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010',
      token,
      fetchImpl: async () => Response.json({ error: { code: 'INSUFFICIENT_CREDITS' } }, { status: 402 }),
    })
    const unavailable = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010',
      token,
      fetchImpl: async () => Response.json({ error: { code: 'CREDIT_SERVICE_UNAVAILABLE' } }, { status: 503 }),
    })
    const frozen = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010',
      token,
      fetchImpl: async () => Response.json({ error: { code: 'CREDIT_ACCOUNT_FROZEN' } }, { status: 423 }),
    })
    const conflict = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010',
      token,
      fetchImpl: async () => Response.json({ error: { code: 'IDEMPOTENCY_CONFLICT' } }, { status: 409 }),
    })

    const input = {
      externalUserId: 'teacher-1', model: 'image-2', units: 1, idempotencyKey: 'step-1',
    }
    await expect(denied.reserveCredits(input)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      reservationState: 'NOT_RESERVED',
    })
    await expect(unavailable.reserveCredits(input)).rejects.toMatchObject({
      code: 'CREDIT_SERVICE_UNAVAILABLE',
      reservationState: 'UNKNOWN',
    })
    await expect(frozen.reserveCredits(input)).rejects.toMatchObject({
      code: 'CREDIT_ACCOUNT_FROZEN',
      reservationState: 'NOT_RESERVED',
    })
    await expect(conflict.reserveCredits(input)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      reservationState: 'UNKNOWN',
    })
  })

  test('settles and releases reservations through distinct idempotent endpoints', async () => {
    const requests: Request[] = []
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010',
      token,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        const status = request.url.endsWith('/settle') ? 'SETTLED' : 'RELEASED'
        return Response.json({
          data: {
            reservationId: 'reservation/with space',
            status,
            reservedCredits: 10,
            settledCredits: status === 'SETTLED' ? 10 : null,
          },
        })
      },
    })
    const context = { externalUserId: 'teacher-1', reservationId: 'reservation/with space' }

    await backend.settleCredits({ ...context, idempotencyKey: 'settle:step-1' })
    await backend.releaseCredits({ ...context, idempotencyKey: 'release:step-1' })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/internal/ppt-agent/credits/reservations/reservation%2Fwith%20space/settle',
      '/api/internal/ppt-agent/credits/reservations/reservation%2Fwith%20space/release',
    ])
    expect(requests.map((request) => request.headers.get('Idempotency-Key'))).toEqual([
      'settle:step-1',
      'release:step-1',
    ])
  })
})

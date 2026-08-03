import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { HttpFrameFlowBackend } from '../src/adapters/frameflow-http-backend'

const token = 'test-agent-token-0001'

const usageBill = {
  pptRunId: 'run-1',
  authorizationReservationId: 'authorization-1',
  accountingMode: 'USAGE_V2',
  status: 'ACTIVE',
  authorizationCapMilli: 300_000,
  authorizedModel: 'nanobanana',
  authorizedUnits: 30,
  pricingVersion: 'ppt-image-v1',
  unitPriceMilli: 10_000,
  providerSpendSafetyCapOperations: 30,
  generatedOperations: 1,
  chargedOperations: 0,
  notChargedOperations: 0,
  unknownOperations: 1,
  chargeableMilli: 0,
  settledMilli: 0,
  releasedMilli: 0,
  providerCosts: [{ currency: 'USD', actualAmountMicros: 0, estimatedAmountMicros: 25_000 }],
  lastEventSequence: 1,
  lastEventAt: '2026-08-03T07:00:01.000Z',
  settledAt: null,
  firstUnknownAt: '2026-08-03T07:00:01.000Z',
  reconciliationAttempts: 0,
  nextReconcileAt: '2026-08-03T07:01:01.000Z',
  reconciliationDeadlineAt: '2026-08-04T07:00:01.000Z',
  reconciliationLastError: null,
} as const

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

  test('settles, releases and atomically finalizes reservations through idempotent endpoints', async () => {
    const requests: Request[] = []
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010',
      token,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        const status = request.url.endsWith('/settle') ? 'SETTLED' : request.url.endsWith('/release') ? 'RELEASED' : 'FINALIZED'
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
    await backend.finalizeCredits({
      ...context, batchId: 'batch-1', settledUnits: 7, releasedUnits: 3, idempotencyKey: 'finalize:batch-1',
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/internal/ppt-agent/credits/reservations/reservation%2Fwith%20space/settle',
      '/api/internal/ppt-agent/credits/reservations/reservation%2Fwith%20space/release',
      '/api/internal/ppt-agent/credits/reservations/reservation%2Fwith%20space/finalize',
    ])
    expect(requests.map((request) => request.headers.get('Idempotency-Key'))).toEqual([
      'settle:step-1',
      'release:step-1',
      'finalize:batch-1',
    ])
    expect(await requests[2]!.json()).toEqual({ batchId: 'batch-1', settledUnits: 7, releasedUnits: 3 })
  })

  test('requires an explicit host capability before V4 submits paid images', async () => {
    let request = new Request('http://localhost')
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token,
      fetchImpl: async (input, init) => {
        request = new Request(input, init)
        return Response.json({ data: { atomicBatchFinalization: true } })
      },
    })

    await backend.preflightBatchFinalization({ externalUserId: 'teacher-1' })
    expect(new URL(request.url).pathname).toBe('/api/internal/ppt-agent/credits/batch-finalization-capability')
    expect(request.headers.get('X-PPT-Agent-User')).toBe('teacher-1')
  })

  test('uses the Usage V2 permit, immutable event, bill and Run finalization contracts', async () => {
    const requests: Request[] = []
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        const pathname = new URL(request.url).pathname
        if (pathname.endsWith('/permits')) {
          return Response.json({ data: { permit: {
            allowed: true, permitId: 'permit-1', pricingVersion: 'ppt-image-v1', userPriceMilli: 10_000,
          } } }, { status: 201 })
        }
        if (pathname.endsWith('/events')) {
          return Response.json({ data: { replayed: false, bill: usageBill } }, { status: 201 })
        }
        return Response.json({ data: { bill: {
          ...usageBill,
          status: pathname.endsWith('/finalize') ? 'SETTLED' : usageBill.status,
          unknownOperations: pathname.endsWith('/finalize') ? 0 : usageBill.unknownOperations,
          settledMilli: pathname.endsWith('/finalize') ? 10_000 : 0,
          releasedMilli: pathname.endsWith('/finalize') ? 290_000 : 0,
          settledAt: pathname.endsWith('/finalize') ? '2026-08-03T07:02:00.000Z' : null,
        } } })
      },
    })
    const observed = {
      schemaVersion: '2' as const,
      eventId: 'pptu_obs_0123456789abcdef0123456789abcdef',
      sequence: 1,
      eventType: 'OPERATION_OBSERVED' as const,
      pptRunId: 'run-1',
      batchId: 'genbatch_0123456789abcdef0123456789abcdef',
      pageNumber: 1,
      revisionRound: 0,
      idempotencyKey: 'run-1:slide:1:image:r0:v1',
      providerOperationId: 'imgop_0123456789abcdef0123456789abcdef',
      model: 'nanobanana',
      status: 'PROCESSING' as const,
      providerBilling: {
        result: 'UNKNOWN' as const,
        estimatedCostAmountMicros: 25_000,
        currency: 'USD',
        pricingVersion: 'provider-image-2026-08',
      },
      operationCreatedAt: '2026-08-03T07:00:00.000Z',
      operationCompletedAt: null,
      eventAt: '2026-08-03T07:00:01.000Z',
    }

    await expect(backend.authorizeUsageOperation({
      externalUserId: 'teacher-1',
      runId: 'run-1',
      operationIdempotencyKey: observed.idempotencyKey,
      pageNumber: 1,
      revisionRound: 0,
      model: 'nanobanana',
    })).resolves.toMatchObject({ allowed: true, permitId: 'permit-1' })
    await expect(backend.ingestUsageEvent({ externalUserId: 'teacher-1', event: observed }))
      .resolves.toMatchObject({ replayed: false, bill: { pptRunId: 'run-1', unknownOperations: 1 } })
    await expect(backend.getUsageRunBill({ externalUserId: 'teacher-1', runId: 'run-1' }))
      .resolves.toMatchObject({ pptRunId: 'run-1', status: 'ACTIVE' })
    await expect(backend.finalizeUsageRun({
      externalUserId: 'teacher-1', runId: 'run-1', idempotencyKey: 'finalize:run-1',
    })).resolves.toMatchObject({ pptRunId: 'run-1', status: 'SETTLED' })

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'POST /api/internal/ppt-agent/usage/v2/runs/run-1/permits',
      'POST /api/internal/ppt-agent/usage/v2/events',
      'GET /api/internal/ppt-agent/usage/v2/runs/run-1',
      'POST /api/internal/ppt-agent/usage/v2/runs/run-1/finalize',
    ])
    expect(requests.map((request) => request.headers.get('X-PPT-Agent-User'))).toEqual([
      'teacher-1', 'teacher-1', 'teacher-1', 'teacher-1',
    ])
    expect(requests.map((request) => request.headers.get('Idempotency-Key'))).toEqual([
      observed.idempotencyKey, observed.idempotencyKey, null, 'finalize:run-1',
    ])
    expect(await requests[0]!.json()).toEqual({
      operationIdempotencyKey: observed.idempotencyKey,
      pageNumber: 1,
      revisionRound: 0,
      model: 'nanobanana',
    })
    expect(await requests[1]!.json()).toEqual(observed)
  })

  test('keeps a denied Usage V2 permit deterministic and a committed-or-unknown result recoverable', async () => {
    const denied = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token,
      fetchImpl: async () => Response.json({ data: { permit: {
        allowed: false,
        stopReason: 'AUTHORIZATION_CAP_REACHED',
        authorizedOperations: 30,
        authorizationCapOperations: 30,
        providerSpendSafetyCapOperations: 30,
      } } }),
    })
    const unavailable = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token,
      fetchImpl: async () => Response.json({ error: { code: 'PPT_USAGE_TEMPORARILY_UNAVAILABLE' } }, { status: 503 }),
    })
    const malformedSuccess = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token,
      fetchImpl: async () => Response.json({ data: { permit: { allowed: true } } }, { status: 201 }),
    })
    const input = {
      externalUserId: 'teacher-1', runId: 'run-1', operationIdempotencyKey: 'operation-1',
      pageNumber: 1, revisionRound: 0, model: 'nanobanana',
    }

    await expect(denied.authorizeUsageOperation(input)).resolves.toMatchObject({
      allowed: false, stopReason: 'AUTHORIZATION_CAP_REACHED',
    })
    await expect(unavailable.authorizeUsageOperation(input)).rejects.toMatchObject({
      code: 'PPT_USAGE_TEMPORARILY_UNAVAILABLE', outcome: 'UNKNOWN',
    })
    await expect(malformedSuccess.authorizeUsageOperation(input)).rejects.toMatchObject({
      code: 'HOST_USAGE_V2_PERMIT_RESPONSE_INVALID', outcome: 'UNKNOWN',
    })
  })

  test('classifies a Usage V2 contract rejection without hiding it as a retryable network result', async () => {
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token,
      fetchImpl: async () => Response.json({ error: { code: 'PPT_USAGE_IDEMPOTENCY_CONFLICT' } }, { status: 409 }),
    })
    const event = {
      schemaVersion: '2' as const, eventId: 'event-1', sequence: 1,
      eventType: 'OPERATION_OBSERVED' as const, pptRunId: 'run-1', batchId: 'batch-1',
      pageNumber: 1, revisionRound: 0, idempotencyKey: 'operation-1', providerOperationId: 'provider-1',
      model: 'nanobanana', status: 'COMPLETED' as const,
      providerBilling: {
        result: 'CHARGED' as const, actualCostAmountMicros: 25_000,
        currency: 'USD', pricingVersion: 'provider-v1',
      },
      operationCreatedAt: '2026-08-03T07:00:00.000Z',
      operationCompletedAt: '2026-08-03T07:00:05.000Z',
      eventAt: '2026-08-03T07:00:05.000Z',
    }

    await expect(backend.ingestUsageEvent({ externalUserId: 'teacher-1', event })).rejects.toMatchObject({
      code: 'PPT_USAGE_IDEMPOTENCY_CONFLICT', outcome: 'REJECTED',
    })
  })

  test('treats a valid bill for a different Run as an unknown event acknowledgement', async () => {
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token,
      fetchImpl: async () => Response.json({
        data: { replayed: false, bill: { ...usageBill, pptRunId: 'run-other' } },
      }, { status: 201 }),
    })
    const event = {
      schemaVersion: '2' as const, eventId: 'event-run-binding', sequence: 1,
      eventType: 'OPERATION_OBSERVED' as const, pptRunId: 'run-1', batchId: 'batch-1',
      pageNumber: 1, revisionRound: 0, idempotencyKey: 'operation-1', providerOperationId: 'provider-1',
      model: 'nanobanana', status: 'COMPLETED' as const,
      providerBilling: {
        result: 'CHARGED' as const, actualCostAmountMicros: 25_000,
        currency: 'USD', pricingVersion: 'provider-v1',
      },
      operationCreatedAt: '2026-08-03T07:00:00.000Z',
      operationCompletedAt: '2026-08-03T07:00:05.000Z',
      eventAt: '2026-08-03T07:00:05.000Z',
    }

    await expect(backend.ingestUsageEvent({ externalUserId: 'teacher-1', event })).rejects.toMatchObject({
      code: 'HOST_USAGE_V2_EVENT_BILL_RUN_MISMATCH', outcome: 'UNKNOWN',
    })
  })
})

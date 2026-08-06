import { createHash, randomUUID } from 'node:crypto'
import { CONTRACT_VERSION, apiErrorSchema, type PublicErrorAction, type PublicErrorCategory } from '../contracts'
import type { ArtifactPort } from '../core/ports'
import type { QuickDeckEvaluationRepository } from '../core/quick-deck-evaluation-ports'
import { QuickDeckEvaluationError, QuickDeckEvaluationService } from '../core/quick-deck-evaluation-service'
import {
  quickDeckContentFormatSchema,
  quickDeckEvaluationEnvelopeSchema,
} from '../quick-deck-evaluation-contracts'
import { QuickDeckEvaluationEventBroker, DEFAULT_QUICK_DECK_EVENT_BATCH_LIMIT } from './quick-deck-evaluation-event-broker'

const OPENAPI_PATH = '/openapi/v1.json'
const OPENAPI_LINK = `<${OPENAPI_PATH}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`
const MAX_QUICK_DECK_EVALUATION_REQUEST_BYTES = 1_048_576

export interface QuickDeckEvaluationAuthenticationPort {
  authenticateQuickDeckEvaluation(request: Request): Promise<Readonly<{ tenantId: string }> | null>
}

export type QuickDeckEvaluationHandlerDependencies = Readonly<{
  service: QuickDeckEvaluationService
  artifacts: ArtifactPort
  repository: QuickDeckEvaluationRepository
  authentication: QuickDeckEvaluationAuthenticationPort
  eventPollMs?: number
}>

function validIdentifier(value: string) {
  return value.length >= 1 && value.length <= 160 && value === value.trim()
}

function contractHeaders(headers?: HeadersInit) {
  const result = new Headers(headers)
  result.set('Link', OPENAPI_LINK)
  result.set('X-PPT-Agent-Contract-Version', CONTRACT_VERSION)
  result.set('X-Content-Type-Options', 'nosniff')
  return result
}

function response(data: unknown, status = 200, headers?: HeadersInit) {
  const result = contractHeaders(headers)
  if (!result.has('Cache-Control')) result.set('Cache-Control', 'no-store')
  return Response.json(data, { status, headers: result })
}

function errorSemantics(status: number, code: string): Readonly<{
  category: PublicErrorCategory
  retryable: boolean
  action: PublicErrorAction
}> {
  if (code === 'UNAUTHENTICATED') return { category: 'AUTHENTICATION', retryable: false, action: 'AUTHENTICATE' }
  if (status === 429) return { category: 'REQUEST', retryable: true, action: 'WAIT' }
  if (status === 409) return { category: 'DELIVERY', retryable: true, action: 'WAIT' }
  if (status === 410) return { category: 'DELIVERY', retryable: false, action: 'NONE' }
  if (status === 413) return { category: 'REQUEST', retryable: false, action: 'NONE' }
  if (status === 422) return { category: 'CONTRACT', retryable: false, action: 'MODIFY_REQUEST' }
  if (status >= 400 && status < 500) return { category: 'CONTRACT', retryable: false, action: 'NONE' }
  return { category: 'INTERNAL', retryable: true, action: 'RETRY' }
}

type BoundedJsonBody =
  | Readonly<{ kind: 'VALID'; value: unknown }>
  | Readonly<{ kind: 'INVALID' }>
  | Readonly<{ kind: 'TOO_LARGE' }>

async function readBoundedJsonBody(request: Request): Promise<BoundedJsonBody> {
  const declaredLength = request.headers.get('Content-Length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_QUICK_DECK_EVALUATION_REQUEST_BYTES) {
    try { await request.body?.cancel() } catch {}
    return { kind: 'TOO_LARGE' }
  }
  if (!request.body) return { kind: 'INVALID' }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      byteLength += next.value.byteLength
      if (byteLength > MAX_QUICK_DECK_EVALUATION_REQUEST_BYTES) {
        await reader.cancel()
        return { kind: 'TOO_LARGE' }
      }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return value ? { kind: 'VALID', value } : { kind: 'INVALID' }
  } catch {
    return { kind: 'INVALID' }
  }
}

function errorResponse(status: number, code: string, requestId: string) {
  const semantics = errorSemantics(status, code)
  return response(apiErrorSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    error: {
      code,
      message: code === 'UNAUTHENTICATED' ? 'authentication is required' : 'quick deck evaluation request could not be completed',
      ...semantics,
      requestId,
      runId: null,
    },
  }), status)
}

function verifiedBody(stream: ReadableStream<Uint8Array>, byteLength: number, sha256: string) {
  const reader = stream.getReader()
  const digest = createHash('sha256')
  let read = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()
      if (next.done) {
        if (read !== byteLength || digest.digest('hex') !== sha256) {
          controller.error(new Error('QUICK_DECK_EVALUATION_ARTIFACT_INTEGRITY_FAILED'))
        } else {
          controller.close()
        }
        return
      }
      read += next.value.length
      digest.update(next.value)
      if (read > byteLength) {
        controller.error(new Error('QUICK_DECK_EVALUATION_ARTIFACT_INTEGRITY_FAILED'))
        await reader.cancel()
        return
      }
      controller.enqueue(next.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}

function safeFilename(name: string) {
  return name.replace(/["\\\r\n]/g, '_')
}

function sseResponse(input: Readonly<{
  broker: QuickDeckEvaluationEventBroker
  jobId: string
  after: number
  signal: AbortSignal
}>) {
  const encoder = new TextEncoder()
  let cursor = input.after
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe?.()
        try { controller.close() } catch {}
      }
      input.signal.addEventListener('abort', close, { once: true })
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'))
      }, 15_000)
      unsubscribe = await input.broker.subscribe({
        jobId: input.jobId,
        after: cursor,
        onEvent(event) {
          if (closed || (controller.desiredSize ?? 1) <= 0) return false
          cursor = event.sequence
          controller.enqueue(encoder.encode(
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ))
          return true
        },
        onClose: close,
      })
    },
    cancel() {
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      unsubscribe?.()
    },
  }, { highWaterMark: DEFAULT_QUICK_DECK_EVENT_BATCH_LIMIT })
  return new Response(stream, {
    headers: contractHeaders({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }),
  })
}

function isResponse(value: Readonly<{ tenantId: string }> | Response): value is Response {
  return value instanceof Response
}

async function principal(
  dependencies: QuickDeckEvaluationHandlerDependencies,
  request: Request,
  requestId: string,
): Promise<Readonly<{ tenantId: string }> | Response> {
  if (request.headers.has('X-PPT-Agent-Tenant')) return errorResponse(400, 'TENANT_HEADER_NOT_ALLOWED', requestId)
  const authenticated = await dependencies.authentication.authenticateQuickDeckEvaluation(request)
  return authenticated ?? errorResponse(401, 'UNAUTHENTICATED', requestId)
}

export function createQuickDeckEvaluationRequestHandler(dependencies: QuickDeckEvaluationHandlerDependencies) {
  const broker = new QuickDeckEvaluationEventBroker({
    repository: dependencies.repository,
    pollMs: dependencies.eventPollMs ?? 500,
  })
  return async (request: Request, requestId: string): Promise<Response> => {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'v1' || parts[1] !== 'evaluations' || parts[2] !== 'quick-decks') {
      return errorResponse(404, 'NOT_FOUND', requestId)
    }
    const owner = await principal(dependencies, request, requestId)
    if (isResponse(owner)) return owner
    const jobId = parts[3]
    try {
      if (parts.length === 3 && request.method === 'POST') {
        const body = await readBoundedJsonBody(request)
        if (body.kind === 'TOO_LARGE') return errorResponse(413, 'EVALUATION_REQUEST_TOO_LARGE', requestId)
        if (body.kind === 'INVALID') return errorResponse(400, 'INVALID_JSON', requestId)
        const job = await dependencies.service.create(owner.tenantId, body.value)
        return response(quickDeckEvaluationEnvelopeSchema.parse({
          schemaVersion: CONTRACT_VERSION,
          requestId,
          data: job,
        }), 201)
      }
      if (!jobId || !validIdentifier(jobId)) return errorResponse(404, 'NOT_FOUND', requestId)
      if (parts.length === 4 && request.method === 'GET') {
        return response(quickDeckEvaluationEnvelopeSchema.parse({
          schemaVersion: CONTRACT_VERSION,
          requestId,
          data: await dependencies.service.getOwned(owner.tenantId, jobId),
        }))
      }
      if (parts.length === 5 && parts[4] === 'events' && request.method === 'GET') {
        await dependencies.service.getOwned(owner.tenantId, jobId)
        const rawAfter = url.searchParams.get('after') ?? request.headers.get('Last-Event-ID') ?? '0'
        const after = Number(rawAfter)
        if (!Number.isSafeInteger(after) || after < 0) return errorResponse(422, 'INVALID_EVENT_CURSOR', requestId)
        return sseResponse({ broker, jobId, after, signal: request.signal })
      }
      if (parts.length === 5 && parts[4] === 'content' && request.method === 'GET') {
        const parsedFormat = quickDeckContentFormatSchema.safeParse(url.searchParams.get('format') ?? 'pptx')
        if (!parsedFormat.success) return errorResponse(422, 'INVALID_EVALUATION_CONTENT_FORMAT', requestId)
        const artifact = await dependencies.service.getContentOwned(owner.tenantId, jobId, parsedFormat.data)
        if (request.headers.has('Range')) {
          return new Response(null, {
            status: 416,
            headers: contractHeaders({
              'Accept-Ranges': 'none',
              'Content-Range': `bytes */${artifact.byteLength}`,
              'Cache-Control': 'no-store',
            }),
          })
        }
        const opened = await dependencies.artifacts.open({ tenantId: owner.tenantId, artifactId: artifact.artifactId })
        if (!opened || opened.mimeType !== artifact.mimeType || opened.byteLength !== artifact.byteLength || opened.sha256 !== artifact.sha256) {
          return errorResponse(404, 'EVALUATION_CONTENT_NOT_FOUND', requestId)
        }
        const body = opened.verifiedBody ?? verifiedBody(opened.stream, artifact.byteLength, artifact.sha256)
        return new Response(body, {
          status: 200,
          headers: contractHeaders({
            'Accept-Ranges': 'none',
            'Cache-Control': 'private, no-store',
            'Content-Disposition': `attachment; filename="${safeFilename(artifact.name)}"`,
            'Content-Length': String(artifact.byteLength),
            'Content-Type': artifact.mimeType,
            ETag: `"${artifact.sha256}"`,
            'X-PPT-Agent-Artifact-ID': artifact.artifactId,
            'X-PPT-Agent-Content-SHA256': artifact.sha256,
          }),
        })
      }
      return errorResponse(404, 'NOT_FOUND', requestId)
    } catch (error) {
      if (error instanceof QuickDeckEvaluationError) return errorResponse(error.status, error.code, requestId)
      return errorResponse(500, 'INTERNAL_ERROR', requestId)
    }
  }
}

export function createQuickDeckEvaluationHttpHandler(dependencies: QuickDeckEvaluationHandlerDependencies) {
  const handle = createQuickDeckEvaluationRequestHandler(dependencies)
  return async (request: Request) => {
    const supplied = request.headers.get('X-Request-ID')?.trim()
    const requestId = supplied && validIdentifier(supplied) ? supplied : randomUUID()
    return await handle(request, requestId)
  }
}

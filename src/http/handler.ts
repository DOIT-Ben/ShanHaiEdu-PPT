import { randomUUID } from 'node:crypto'
import type { HostContext } from '../contracts'
import { apiErrorSchema, MAX_PLANNING_RETRIES } from '../contracts'
import { getActiveBlueprint } from '../core/active-blueprint'
import type { AgentRepository, ArtifactPort, RunRecord } from '../core/ports'
import { RunService, RunServiceError } from '../core/run-service'
import type { RuntimeHealthMonitor } from '../observability/runtime-health'

export interface HostAuthenticationPort {
  authenticate(request: Request): Promise<HostContext | null>
}

type HandlerDependencies = Readonly<{
  runs: RunService
  repository: AgentRepository
  artifacts: ArtifactPort
  authentication: HostAuthenticationPort
  health: RuntimeHealthMonitor
  eventPollMs?: number
}>

function publicRun(run: RunRecord) {
  return {
    id: run.id,
    host: run.host,
    status: run.status,
    resumeState: run.resumeState,
    version: run.version,
    slideCount: run.slideCount,
    visualDirection: run.visualDirection,
    imageModel: run.imageModel,
    automationLevel: run.automationLevel,
    presentationMode: run.presentationMode ?? 'SLIDE_IMAGE_V2',
    coverDesignMode: run.coverDesignMode ?? 'INDEPENDENT',
    maxVisualAssetsPerSlide: run.maxVisualAssetsPerSlide ?? 4,
    maxRevisionRounds: run.maxRevisionRounds,
    revisionRound: run.revisionRound,
    planningAttempt: run.planningAttempt ?? 0,
    maxPlanningRetries: MAX_PLANNING_RETRIES,
    budgetUnits: run.budgetUnits,
    committedBudgetUnits: run.committedBudgetUnits,
    qualityScore: run.qualityScore,
    qualityOverride: run.qualityOverride,
    qualityOverrideReason: run.qualityOverrideReason,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

function errorResponse(status: number, code: string, message: string, requestId: string, details?: unknown) {
  const body = apiErrorSchema.parse({
    error: { code, message, requestId, ...(details === undefined ? {} : { details }) },
  })
  return json(body, status)
}

function samePrincipal(left: HostContext, right: HostContext) {
  return left.tenantId === right.tenantId && left.externalUserId === right.externalUserId
}

function encodeCursor(run: RunRecord) {
  return Buffer.from(JSON.stringify({ updatedAt: run.updatedAt, id: run.id })).toString('base64url')
}

function decodeCursor(cursor: string) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { updatedAt?: unknown; id?: unknown }
    if (typeof value.updatedAt !== 'string' || typeof value.id !== 'string') return null
    return { updatedAt: value.updatedAt, id: value.id }
  } catch {
    return null
  }
}

async function runDetail(repository: AgentRepository, run: RunRecord) {
  const [deliveries, events] = await Promise.all([
    repository.listDeliveries(run.id),
    repository.listEvents(run.id),
  ])
  const blueprint = await getActiveBlueprint(repository, run.id, run.revisionRound).catch(() => null)
  const issues = new Map<string, Extract<(typeof events)[number], { type: 'issue.detected' }>['payload']>()
  for (const event of events) {
    if (event.type === 'issue.detected') issues.set(event.payload.id, event.payload)
    if (event.type === 'issue.resolved') issues.delete(event.payload.issueId)
  }
  return { ...publicRun(run), blueprint, deliveries, issues: [...issues.values()] }
}

function sseResponse(input: Readonly<{
  repository: AgentRepository
  runId: string
  after: number
  signal: AbortSignal
  pollMs: number
}>) {
  const encoder = new TextEncoder()
  let cursor = input.after
  let timer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        if (timer) clearTimeout(timer)
        if (heartbeat) clearInterval(heartbeat)
        try { controller.close() } catch {}
      }
      input.signal.addEventListener('abort', close, { once: true })
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'))
      }, 15_000)

      const poll = async () => {
        if (closed) return
        try {
          const events = await input.repository.listEvents(input.runId, cursor)
          for (const event of events) {
            cursor = event.sequence
            controller.enqueue(encoder.encode(
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ))
          }
          timer = setTimeout(poll, input.pollMs)
        } catch (error) {
          controller.error(error)
          close()
        }
      }
      await poll()
    },
    cancel() {
      closed = true
      if (timer) clearTimeout(timer)
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

export function createHttpHandler(dependencies: HandlerDependencies) {
  return async function handle(request: Request): Promise<Response> {
    const requestIdHeader = request.headers.get('X-Request-ID')
    const requestId = requestIdHeader && requestIdHeader.length <= 160 ? requestIdHeader : randomUUID()
    try {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health/live') {
        return json(dependencies.health.liveness())
      }
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        const readiness = dependencies.health.readiness()
        return json(readiness, readiness.status === 'READY' ? 200 : 503)
      }
      const host = await dependencies.authentication.authenticate(request)
      if (!host) return errorResponse(401, 'UNAUTHENTICATED', 'authentication is required', requestId)

      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] !== 'v1') {
        return errorResponse(404, 'NOT_FOUND', 'resource was not found', requestId)
      }

      if (parts.length === 3 && parts[1] === 'admin' && parts[2] === 'planning-failures' && request.method === 'GET') {
        if ((host.role ?? 'USER') !== 'ADMIN') {
          return errorResponse(403, 'ADMIN_REQUIRED', 'administrator role is required', requestId)
        }
        const filters = {
          errorCode: url.searchParams.get('errorCode'),
          model: url.searchParams.get('model'),
          contractVersion: url.searchParams.get('contractVersion'),
        }
        if (Object.values(filters).some((value) => value !== null && (value.length === 0 || value !== value.trim()))
          || (filters.errorCode?.length ?? 0) > 100
          || (filters.model?.length ?? 0) > 120
          || (filters.contractVersion?.length ?? 0) > 40) {
          return errorResponse(422, 'INVALID_FILTER', 'planning failure filter is invalid', requestId)
        }
        const report = await dependencies.repository.aggregatePlanningFailures({ tenantId: host.tenantId, ...filters })
        return json({ data: report.groups, totalFailures: report.totalFailures })
      }

      if (parts[1] !== 'runs') return errorResponse(404, 'NOT_FOUND', 'resource was not found', requestId)

      if (parts.length === 2 && request.method === 'POST') {
        const idempotencyKey = request.headers.get('Idempotency-Key')
        if (!idempotencyKey) return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', requestId)
        const body = await request.json().catch(() => null) as { host?: HostContext } | null
        if (!body) return errorResponse(400, 'INVALID_JSON', 'request body must be valid JSON', requestId)
        if (!body.host || !samePrincipal(body.host, host)) {
          return errorResponse(403, 'HOST_CONTEXT_MISMATCH', 'request host does not match authenticated principal', requestId)
        }
        const created = await dependencies.runs.create(body, idempotencyKey)
        return json({ data: publicRun(created.run), replayed: created.replayed }, created.replayed ? 200 : 201)
      }

      if (parts.length === 2 && request.method === 'GET') {
        const pageSizeValue = Number(url.searchParams.get('pageSize') ?? 20)
        if (!Number.isSafeInteger(pageSizeValue) || pageSizeValue < 1 || pageSizeValue > 100) {
          return errorResponse(422, 'INVALID_PAGE_SIZE', 'pageSize must be between 1 and 100', requestId)
        }
        const runs = await dependencies.runs.listOwned(host)
        const cursorValue = url.searchParams.get('cursor')
        let start = 0
        if (cursorValue) {
          const cursor = decodeCursor(cursorValue)
          if (!cursor) return errorResponse(422, 'INVALID_CURSOR', 'cursor is invalid', requestId)
          const index = runs.findIndex((run) => run.id === cursor.id && run.updatedAt === cursor.updatedAt)
          if (index < 0) return errorResponse(422, 'INVALID_CURSOR', 'cursor is no longer valid', requestId)
          start = index + 1
        }
        const page = runs.slice(start, start + pageSizeValue)
        const hasMore = start + page.length < runs.length
        return json({
          data: page.map(publicRun),
          pagination: { pageSize: pageSizeValue, nextCursor: hasMore ? encodeCursor(page.at(-1)!) : null },
        })
      }

      const runId = parts[2]
      if (!runId) return errorResponse(404, 'NOT_FOUND', 'resource was not found', requestId)

      if (parts.length === 3 && request.method === 'GET') {
        const run = await dependencies.runs.getOwned(runId, host)
        return json({ data: await runDetail(dependencies.repository, run) })
      }

      if (parts.length === 4 && parts[3] === 'actions' && request.method === 'POST') {
        const idempotencyKey = request.headers.get('Idempotency-Key')
        if (!idempotencyKey) return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', requestId)
        const body = await request.json().catch(() => null)
        if (!body) return errorResponse(400, 'INVALID_JSON', 'request body must be valid JSON', requestId)
        const updated = await dependencies.runs.act(runId, host, body, idempotencyKey)
        return json({ data: publicRun(updated) })
      }

      if (parts.length === 4 && parts[3] === 'events' && request.method === 'GET') {
        await dependencies.runs.getOwned(runId, host)
        const rawAfter = url.searchParams.get('after') ?? request.headers.get('Last-Event-ID') ?? '0'
        const after = Number(rawAfter)
        if (!Number.isSafeInteger(after) || after < 0) {
          return errorResponse(422, 'INVALID_EVENT_CURSOR', 'event cursor must be a non-negative integer', requestId)
        }
        return sseResponse({
          repository: dependencies.repository,
          runId,
          after,
          signal: request.signal,
          pollMs: dependencies.eventPollMs ?? 500,
        })
      }

      if (parts.length === 6 && parts[3] === 'deliveries' && parts[5] === 'content' && request.method === 'GET') {
        const run = await dependencies.runs.getOwned(runId, host)
        let deliveryId: string
        try {
          deliveryId = decodeURIComponent(parts[4]!)
        } catch {
          return errorResponse(404, 'DELIVERY_NOT_FOUND', 'delivery was not found', requestId)
        }
        const delivery = (await dependencies.repository.listDeliveries(run.id))
          .find((candidate) => candidate.id === deliveryId)
        if (!delivery) return errorResponse(404, 'DELIVERY_NOT_FOUND', 'delivery was not found', requestId)
        const format = url.searchParams.get('format') ?? 'pptx'
        if (format !== 'preview' && format !== 'pptx') {
          return errorResponse(422, 'INVALID_DELIVERY_FORMAT', 'format must be preview or pptx', requestId)
        }
        const reference = format === 'preview' ? delivery.preview : delivery.pptx
        const artifact = await dependencies.artifacts.get({
          tenantId: run.host.tenantId,
          artifactId: reference.artifactId,
        })
        if (!artifact) return errorResponse(404, 'DELIVERY_CONTENT_NOT_FOUND', 'delivery content was not found', requestId)
        return new Response(new Uint8Array(artifact.bytes), {
          headers: {
            'Cache-Control': 'private, no-store',
            'Content-Disposition': `attachment; filename="${reference.name}"`,
            'Content-Length': String(artifact.bytes.length),
            'Content-Type': reference.mimeType,
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }

      return errorResponse(404, 'NOT_FOUND', 'resource was not found', requestId)
    } catch (error) {
      if (error instanceof RunServiceError) {
        return errorResponse(error.status, error.code, error.message, requestId)
      }
      return errorResponse(500, 'INTERNAL_ERROR', 'an internal error occurred', requestId)
    }
  }
}

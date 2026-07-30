import { randomUUID } from 'node:crypto'
import type { HostContext } from '../contracts'
import { apiErrorSchema, MAX_PLANNING_RETRIES, runStatusSchema } from '../contracts'
import { getActiveBlueprint } from '../core/active-blueprint'
import { AdminOperationsError, type AdminOperationsPort } from '../core/admin-operations'
import type { AgentRepository, ArtifactPort, RunRecord } from '../core/ports'
import { RunService, RunServiceError } from '../core/run-service'
import type { RuntimeHealthMonitor } from '../observability/runtime-health'
import { visualDeckV4GenerationPlan } from '../visual-deck-v4-generation-plan'
import type { PrincipalRateLimiterPort, PrincipalRateLimitScope } from './principal-rate-limiter'
import { DEFAULT_EVENT_BATCH_BYTES, DEFAULT_EVENT_BATCH_LIMIT, RunEventBroker } from './run-event-broker'

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
  waitingSlaMs?: number
  stepSlaMs?: number
  operations?: AdminOperationsPort
  rateLimiter?: PrincipalRateLimiterPort
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
    targetAudience: run.targetAudience ?? null,
    presentationGoal: run.presentationGoal ?? null,
    imageModel: run.imageModel,
    automationLevel: run.automationLevel,
    presentationMode: run.presentationMode ?? 'SLIDE_IMAGE_V2',
    coverDesignMode: run.coverDesignMode ?? 'INDEPENDENT',
    assetAcquisitionPolicy: run.assetAcquisitionPolicy ?? 'AI_FIRST',
    maxVisualAssetsPerSlide: run.maxVisualAssetsPerSlide ?? 4,
    ...(run.visualDeckV4 ? { visualDeckV4: run.visualDeckV4 } : {}),
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

function enforceRateLimit(
  rateLimiter: PrincipalRateLimiterPort | undefined,
  scope: PrincipalRateLimitScope,
  host: HostContext,
  requestId: string,
) {
  if (!rateLimiter) return null
  const decision = rateLimiter.consume(scope, host)
  if (decision.allowed) return null
  const response = errorResponse(429, 'RATE_LIMITED', 'request rate limit exceeded', requestId, {
    retryAfterSeconds: decision.retryAfterSeconds,
  })
  response.headers.set('Retry-After', String(decision.retryAfterSeconds))
  return response
}

function matchesAuthenticatedHost(requestHost: HostContext, authenticatedHost: HostContext) {
  return requestHost.tenantId === authenticatedHost.tenantId
    && requestHost.externalUserId === authenticatedHost.externalUserId
    && (requestHost.externalProjectId === undefined
      || requestHost.externalProjectId === authenticatedHost.externalProjectId)
    && (requestHost.role === undefined
      || requestHost.role === (authenticatedHost.role ?? 'USER'))
}

function encodeCursor(run: RunRecord) {
  return Buffer.from(JSON.stringify({ updatedAt: run.updatedAt, id: run.id })).toString('base64url')
}

function decodeCursor(cursor: string) {
  if (cursor.length > 512) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { updatedAt?: unknown; id?: unknown }
    if (typeof value.updatedAt !== 'string' || typeof value.id !== 'string') return null
    if (Number.isNaN(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt) return null
    if (value.id.length < 1 || value.id.length > 160 || value.id !== value.id.trim()) return null
    return { updatedAt: value.updatedAt, id: value.id }
  } catch {
    return null
  }
}

async function runDetail(repository: AgentRepository, run: RunRecord) {
  const [deliveries, snapshot] = await Promise.all([
    repository.listDeliveries(run.id),
    repository.getRunEventSnapshot(run.id),
  ])
  const blueprint = await getActiveBlueprint(repository, run.id, run.revisionRound).catch(() => null)
  const generationPlan = blueprint?.visualDeckV4Proposal
    ? visualDeckV4GenerationPlan(blueprint.visualDeckV4Proposal)
    : null
  return { ...publicRun(run), blueprint, generationPlan, deliveries, issues: snapshot.openIssues, progress: snapshot.progress }
}

function sseResponse(input: Readonly<{
  broker: RunEventBroker
  runId: string
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
        runId: input.runId,
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
  }, { highWaterMark: DEFAULT_EVENT_BATCH_LIMIT })

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
  const eventBroker = new RunEventBroker({
    repository: dependencies.repository,
    pollMs: dependencies.eventPollMs ?? 500,
  })
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

      if (parts.length === 3 && parts[1] === 'admin' && parts[2] === 'operations' && request.method === 'GET') {
        if ((host.role ?? 'USER') !== 'ADMIN') {
          return errorResponse(403, 'ADMIN_REQUIRED', 'administrator role is required', requestId)
        }
        const statusValue = url.searchParams.get('status')
        const status = statusValue ? runStatusSchema.safeParse(statusValue) : null
        const externalUserId = url.searchParams.get('externalUserId')
        const errorCode = url.searchParams.get('errorCode')
        const createdFrom = url.searchParams.get('createdFrom')
        const createdTo = url.searchParams.get('createdTo')
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const validDate = (value: string | null) => value === null || (!Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value)
        if ((status && !status.success)
          || (externalUserId !== null && (externalUserId.length < 1 || externalUserId.length > 160 || externalUserId !== externalUserId.trim()))
          || (errorCode !== null && (errorCode.length < 1 || errorCode.length > 100 || errorCode !== errorCode.trim()))
          || !validDate(createdFrom) || !validDate(createdTo)
          || (createdFrom !== null && createdTo !== null && createdFrom > createdTo)
          || !Number.isSafeInteger(offset) || offset < 0
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          return errorResponse(422, 'INVALID_OPERATIONS_FILTER', 'operations filter is invalid', requestId)
        }
        const report = await dependencies.repository.getOperationsReport({
          tenantId: host.tenantId,
          status: status?.success ? status.data : null,
          externalUserId,
          errorCode,
          createdFrom,
          createdTo,
          offset,
          limit,
          now: new Date().toISOString(),
          waitingSlaMs: dependencies.waitingSlaMs ?? 15 * 60_000,
          stepSlaMs: dependencies.stepSlaMs ?? 30 * 60_000,
        })
        return json({ data: report })
      }

      if (parts.length === 5 && parts[1] === 'admin' && parts[2] === 'operations' && parts[4] === 'actions' && request.method === 'POST') {
        if ((host.role ?? 'USER') !== 'ADMIN') {
          return errorResponse(403, 'ADMIN_REQUIRED', 'administrator role is required', requestId)
        }
        if (!dependencies.operations) return errorResponse(503, 'ADMIN_OPERATIONS_UNAVAILABLE', 'admin operations are unavailable', requestId)
        const rateLimited = enforceRateLimit(dependencies.rateLimiter, 'RUN_ACTION', host, requestId)
        if (rateLimited) return rateLimited
        const idempotencyKey = request.headers.get('Idempotency-Key')?.trim()
        if (!idempotencyKey || idempotencyKey.length > 160) {
          return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', requestId)
        }
        const body = await request.json().catch(() => null) as Record<string, unknown> | null
        const action = body?.action
        const stepId = body?.stepId
        const expectedVersion = body?.expectedVersion
        const reason = body?.reason
        if (!body || !['REINSPECT', 'MARK_NOT_CHARGED', 'MARK_CHARGED'].includes(String(action))
          || typeof stepId !== 'string' || stepId.length < 1 || stepId.length > 160 || stepId !== stepId.trim()
          || !Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0
          || typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500
          || Object.keys(body).some((key) => !['action', 'stepId', 'expectedVersion', 'reason'].includes(key))) {
          return errorResponse(422, 'INVALID_ADMIN_ACTION', 'admin action is invalid', requestId)
        }
        const result = await dependencies.operations.act({
          host,
          runId: parts[3]!,
          stepId,
          action: action as 'REINSPECT' | 'MARK_NOT_CHARGED' | 'MARK_CHARGED',
          expectedVersion: expectedVersion as number,
          idempotencyKey,
          reason: reason.trim(),
        })
        return json({
          data: {
            run: publicRun(result.run),
            step: { id: result.step.id, status: result.step.status, errorCode: result.step.errorCode, updatedAt: result.step.updatedAt },
          },
          replayed: result.replayed,
        })
      }

      if (parts[1] !== 'runs') return errorResponse(404, 'NOT_FOUND', 'resource was not found', requestId)

      if (parts.length === 2 && request.method === 'POST') {
        const rateLimited = enforceRateLimit(dependencies.rateLimiter, 'CREATE_RUN', host, requestId)
        if (rateLimited) return rateLimited
        const idempotencyKey = request.headers.get('Idempotency-Key')
        if (!idempotencyKey) return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', requestId)
        const body = await request.json().catch(() => null) as { host?: HostContext } | null
        if (!body) return errorResponse(400, 'INVALID_JSON', 'request body must be valid JSON', requestId)
        if (!body.host || !matchesAuthenticatedHost(body.host, host)) {
          return errorResponse(403, 'HOST_CONTEXT_MISMATCH', 'request host does not match authenticated principal', requestId)
        }
        const created = await dependencies.runs.create({ ...body, host: { ...body.host, ...host } }, idempotencyKey)
        return json({ data: publicRun(created.run), replayed: created.replayed }, created.replayed ? 200 : 201)
      }

      if (parts.length === 2 && request.method === 'GET') {
        const pageSizeValue = Number(url.searchParams.get('pageSize') ?? 20)
        if (!Number.isSafeInteger(pageSizeValue) || pageSizeValue < 1 || pageSizeValue > 100) {
          return errorResponse(422, 'INVALID_PAGE_SIZE', 'pageSize must be between 1 and 100', requestId)
        }
        const cursorValue = url.searchParams.get('cursor')
        let cursor = null
        if (cursorValue) {
          cursor = decodeCursor(cursorValue)
          if (!cursor) return errorResponse(422, 'INVALID_CURSOR', 'cursor is invalid', requestId)
        }
        const page = await dependencies.runs.listOwnedPage(host, { after: cursor, limit: pageSizeValue })
        return json({
          data: page.runs.map(publicRun),
          pagination: { pageSize: pageSizeValue, nextCursor: page.hasMore ? encodeCursor(page.runs.at(-1)!) : null },
        })
      }

      const runId = parts[2]
      if (!runId) return errorResponse(404, 'NOT_FOUND', 'resource was not found', requestId)

      if (parts.length === 3 && request.method === 'GET') {
        const run = await dependencies.runs.getOwned(runId, host)
        return json({ data: await runDetail(dependencies.repository, run) })
      }

      if (parts.length === 4 && parts[3] === 'actions' && request.method === 'POST') {
        const rateLimited = enforceRateLimit(dependencies.rateLimiter, 'RUN_ACTION', host, requestId)
        if (rateLimited) return rateLimited
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
          broker: eventBroker,
          runId,
          after,
          signal: request.signal,
        })
      }

      if (parts.length === 5 && parts[3] === 'events' && parts[4] === 'history' && request.method === 'GET') {
        await dependencies.runs.getOwned(runId, host)
        const rawAfter = url.searchParams.get('after') ?? '0'
        const after = Number(rawAfter)
        if (!Number.isSafeInteger(after) || after < 0) {
          return errorResponse(422, 'INVALID_EVENT_CURSOR', 'event cursor must be a non-negative integer', requestId)
        }
        const page = await dependencies.repository.readEvents(runId, {
          afterSequence: after,
          limit: DEFAULT_EVENT_BATCH_LIMIT,
          maxBytes: DEFAULT_EVENT_BATCH_BYTES,
        })
        return json({
          data: page.events,
          pagination: { nextAfter: page.nextAfter, hasMore: page.hasMore },
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
        if (format !== 'preview' && format !== 'pptx' && format !== 'sources') {
          return errorResponse(422, 'INVALID_DELIVERY_FORMAT', 'format must be preview, pptx or sources', requestId)
        }
        const reference = format === 'preview' ? delivery.preview : format === 'sources' ? delivery.sources : delivery.pptx
        if (!reference) return errorResponse(404, 'DELIVERY_CONTENT_NOT_FOUND', 'delivery content was not found', requestId)
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
      if (error instanceof AdminOperationsError) {
        return errorResponse(error.status, error.code, error.message, requestId)
      }
      return errorResponse(500, 'INTERNAL_ERROR', 'an internal error occurred', requestId)
    }
  }
}

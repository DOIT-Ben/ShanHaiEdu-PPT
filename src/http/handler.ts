import { createHash, randomUUID } from 'node:crypto'
import type {
  DeliveryAvailability,
  DeliveryUnavailableReason,
  HostContext,
  PublicError,
  PublicErrorCategory,
} from '../contracts'
import {
  adminRevisionRoundsSettingsSchema,
  adminRevisionRoundsUpdateSchema,
  agentEventHistoryEnvelopeSchema,
  apiErrorSchema,
  CONTRACT_VERSION,
  deliveryAvailabilitySchema,
  deliveryUnavailableErrorSchema,
  MAX_PLANNING_RETRIES,
  publicErrorSchema,
  runEnvelopeSchema,
  runListEnvelopeSchema,
  runSnapshotSchema,
  runStatusSchema,
} from '../contracts'
import { getActiveBlueprint } from '../core/active-blueprint'
import { assertFinalDeliveryForCompletion } from '../core/delivery-runner'
import { getGenerationBatch } from '../core/generation-batch'
import { publicErrorCategoryForV4Failure, qualityPolicyAuditForRun } from '../core/v4-lifecycle'
import { AdminOperationsError, type AdminOperationsPort } from '../core/admin-operations'
import {
  AdminRevisionRoundsSettingsError,
  type AdminRevisionRoundsSettingsPort,
} from '../core/admin-revision-rounds-settings'
import type { AgentRepository, ArtifactPort, RunRecord } from '../core/ports'
import { RunService, RunServiceError } from '../core/run-service'
import {
  accountingProtocolFor,
  isUsageV2RunFinalizationAcknowledged,
  isUsageV2RunFinalizationRetryScheduled,
  usageV2FinalizeStepKey,
} from '../core/usage-v2-coordinator'
import type { RuntimeHealthMonitor } from '../observability/runtime-health'
import { publicDeliveryRecordSchema, type DeliveryRecord } from '../presentation-contracts'
import {
  createRunEnvelopeSchema,
  runDetailEnvelopeSchema,
  runDetailSchema,
} from '../run-detail-contracts'
import {
  capabilitiesEnvelopeSchema,
  DEFAULT_PUBLIC_CAPABILITIES,
  publicBlueprintProjection,
  publicRunSources,
  runPlanEnvelopeSchema,
  runSourcesEnvelopeSchema,
  type PublicCapabilities,
} from '../run-query-contracts'
import { visualDeckV4GenerationPlan } from '../visual-deck-v4-generation-plan'
import type { PrincipalRateLimiterPort, PrincipalRateLimitScope } from './principal-rate-limiter'
import { DEFAULT_EVENT_BATCH_BYTES, DEFAULT_EVENT_BATCH_LIMIT, RunEventBroker } from './run-event-broker'
import {
  handlePresentationJobV2Request,
  type PresentationJobV2HandlerDependencies,
} from './presentation-job-v2-handler'
import {
  createQuickDeckEvaluationRequestHandler,
  type QuickDeckEvaluationHandlerDependencies,
} from './quick-deck-evaluation-handler'
import { OPENAPI_DOCUMENT_JSON, OPENAPI_V2_DOCUMENT_JSON } from './openapi-document'

const OPENAPI_PATH = '/openapi/v1.json'
const OPENAPI_LINK = `<${OPENAPI_PATH}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`
const OPENAPI_V2_PATH = '/openapi/v2.json'
const OPENAPI_V2_LINK = `<${OPENAPI_V2_PATH}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`

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
  revisionRoundsSettings?: AdminRevisionRoundsSettingsPort
  rateLimiter?: PrincipalRateLimiterPort
  presentationJobV2?: PresentationJobV2HandlerDependencies
  quickDeckEvaluation?: QuickDeckEvaluationHandlerDependencies
  capabilities?: PublicCapabilities
}>

async function publicRunError(repository: AgentRepository, run: RunRecord): Promise<PublicError | null> {
  if (run.status === 'PAUSED') {
    const paused = [...await repository.listEvents(run.id)].reverse()
      .find((event) => event.type === 'run.paused')
    const reason = paused?.payload && typeof paused.payload === 'object'
      ? (paused.payload as { reason?: unknown }).reason
      : null
    if (reason !== 'BUDGET_INSUFFICIENT') return null
    return publicErrorSchema.parse({
      code: 'BUDGET_INSUFFICIENT',
      category: 'USAGE_V2',
      retryable: true,
      action: 'ADD_BUDGET',
      requestId: null,
      runId: run.id,
    })
  }

  if (run.status === 'RECOVERING') {
    const pending = run.pendingTerminalFailure
    const category = pending
      ? pending.category ?? publicErrorCategoryForV4Failure(
          pending.errorCode,
          pending.reason,
          run.technicalRecovery?.category,
        )
      : run.technicalRecovery?.category ?? 'INTERNAL'
    const retryable = run.technicalRecovery?.retryable ?? false
    return publicErrorSchema.parse({
      code: pending?.errorCode ?? 'TECHNICAL_RECOVERY_PENDING',
      category,
      retryable,
      action: retryable ? 'WAIT' : 'CONTACT_SUPPORT',
      requestId: null,
      runId: run.id,
    })
  }

  if (run.status !== 'FAILED') return null
  const events = await repository.listEvents(run.id)
  const failed = [...events].reverse().find((event) => event.type === 'run.failed')
  if (failed?.type === 'run.failed' && 'error' in failed.payload) {
    const parsed = publicErrorSchema.safeParse(failed.payload.error)
    if (parsed.success && parsed.data.runId === run.id) return parsed.data
  }
  const payload = failed?.type === 'run.failed'
    ? failed.payload as { errorCode?: unknown; reason?: unknown }
    : null
  const errorCode = typeof payload?.errorCode === 'string' ? payload.errorCode : 'WORKER_FATAL'
  const reason = typeof payload?.reason === 'string' ? payload.reason : null
  return publicErrorSchema.parse({
    code: errorCode,
    category: publicErrorCategoryForV4Failure(errorCode, reason, run.technicalRecovery?.category),
    retryable: false,
    action: 'CONTACT_SUPPORT',
    requestId: null,
    runId: run.id,
  })
}

async function publicRun(repository: AgentRepository, run: RunRecord) {
  const normalizedQualityPolicyAudit = qualityPolicyAuditForRun(run)
  const auditPendingOrFailed = ['PENDING', 'REVIEW_PASSED'].includes(run.qualityDisposition ?? '')
    || run.status === 'FAILED'
  const qualityPolicyAudit = auditPendingOrFailed ? null : normalizedQualityPolicyAudit
  const qualityOverrideAudit = !auditPendingOrFailed
    && !normalizedQualityPolicyAudit
    && run.qualityOverrideBy
    && run.qualityOverrideRole
    && run.qualityOverrideReason
    && run.qualityOverrideIssueIds?.length
    && run.qualityOverrideAt
    ? {
        actorId: run.qualityOverrideBy,
        actorRole: run.qualityOverrideRole,
        reason: run.qualityOverrideReason,
        issueIds: run.qualityOverrideIssueIds,
        acceptedAt: run.qualityOverrideAt,
      }
    : null
  const qualityDisposition = run.status === 'FAILED'
    ? 'HARD_FAILURE' as const
    : run.qualityDisposition === 'PENDING'
      ? 'PENDING' as const
      : qualityPolicyAudit
        ? 'SYSTEM_POLICY_ACCEPTED' as const
        : run.qualityDisposition
          ? run.qualityDisposition
          : run.qualityOverride
            ? 'ADMIN_OVERRIDE' as const
            : ['DELIVERING', 'COMPLETED'].includes(run.status)
              ? 'REVIEW_PASSED' as const
              : 'PENDING' as const
  return runSnapshotSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: run.id,
    host: run.host,
    status: run.status,
    resumeState: run.resumeState,
    ...(run.technicalRecovery ? { technicalRecovery: run.technicalRecovery } : {}),
    ...(run.pendingTerminalFailure ? { pendingTerminalFailure: run.pendingTerminalFailure } : {}),
    ...(run.terminalAccounting ? { terminalAccounting: run.terminalAccounting } : {}),
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
    ...(run.release ? { release: run.release } : {}),
    ...(run.visualDeckV4 ? { visualDeckV4: run.visualDeckV4 } : {}),
    maxRevisionRounds: run.maxRevisionRounds,
    revisionRound: run.revisionRound,
    planningAttempt: run.planningAttempt ?? 0,
    maxPlanningRetries: MAX_PLANNING_RETRIES,
    budgetUnits: run.budgetUnits,
    committedBudgetUnits: run.committedBudgetUnits,
    qualityScore: run.qualityScore,
    qualityOverride: ['PENDING', 'REVIEW_PASSED'].includes(qualityDisposition) ? false : run.qualityOverride,
    qualityDisposition,
    qualityPolicyAudit,
    qualityOverrideAudit,
    error: await publicRunError(repository, run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  })
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers)
  if (!responseHeaders.has('Cache-Control')) responseHeaders.set('Cache-Control', 'no-store')
  return Response.json(data, { status, headers: responseHeaders })
}

function observabilityHeaders() {
  return {
    Link: OPENAPI_LINK,
    'X-PPT-Agent-Contract-Version': CONTRACT_VERSION,
  }
}

function openApiResponse() {
  return new Response(OPENAPI_DOCUMENT_JSON, {
    status: 200,
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/vnd.oai.openapi+json; charset=utf-8',
      Link: OPENAPI_LINK,
      'X-Content-Type-Options': 'nosniff',
      'X-PPT-Agent-Contract-Version': CONTRACT_VERSION,
    },
  })
}

function openApiV2Response() {
  return new Response(OPENAPI_V2_DOCUMENT_JSON, {
    status: 200,
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/vnd.oai.openapi+json; charset=utf-8',
      Link: OPENAPI_V2_LINK,
      'X-Content-Type-Options': 'nosniff',
      'X-PPT-Agent-Contract-Version': '2.0',
    },
  })
}

function applyContractHeaders(response: Response, requestId: string) {
  if (!response.headers.has('Link')) response.headers.set('Link', OPENAPI_LINK)
  if (!response.headers.has('X-PPT-Agent-Contract-Version')) {
    response.headers.set('X-PPT-Agent-Contract-Version', CONTRACT_VERSION)
  }
  response.headers.set('X-Request-ID', requestId)
  return response
}

const DELIVERY_ERROR_CODES = new Set([
  'DELIVERY_NOT_AVAILABLE',
  'DELIVERY_NOT_FOUND',
  'DELIVERY_CONTENT_NOT_FOUND',
  'INVALID_DELIVERY_FORMAT',
  'DELIVERY_BLUEPRINT_REQUIRED',
  'DELIVERY_FAILURE_NOT_READY',
])
const QUALITY_ERROR_CODES = new Set([
  'QUALITY_OVERRIDE_ADMIN_REQUIRED',
  'QUALITY_OVERRIDE_ISSUES_MISMATCH',
  'QUALITY_FAILURE_RECOVERY_NOT_ALLOWED',
  'QUALITY_FAILURE_ACCOUNTING_NOT_FINAL',
  'QUALITY_FAILURE_USAGE_FINALIZATION_NOT_ACKNOWLEDGED',
  'QUALITY_FAILURE_BLUEPRINT_INVALID',
  'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE',
  'QUALITY_FAILURE_DELIVERY_EXISTS',
])
const USAGE_V2_ERROR_CODES = new Set([
  'USAGE_V2_PROVIDER_BILLING_CATALOG_REQUIRED',
  'USAGE_V2_PROVIDER_BILLING_PROFILE_NOT_FOUND',
])

function errorSemantics(status: number, code: string): Readonly<{
  category: PublicErrorCategory
  retryable: boolean
  action: PublicError['action']
}> {
  if (DELIVERY_ERROR_CODES.has(code)) return { category: 'DELIVERY', retryable: false, action: 'NONE' }
  if (QUALITY_ERROR_CODES.has(code)) return { category: 'QUALITY', retryable: false, action: 'CONTACT_SUPPORT' }
  if (USAGE_V2_ERROR_CODES.has(code)) return { category: 'USAGE_V2', retryable: false, action: 'CONTACT_SUPPORT' }
  if (code === 'UNAUTHENTICATED') return { category: 'AUTHENTICATION', retryable: false, action: 'AUTHENTICATE' }
  if (code === 'IDEMPOTENCY_CONFLICT') {
    return { category: 'CONTRACT', retryable: false, action: 'MODIFY_REQUEST' }
  }
  if (status === 403) return { category: 'AUTHORIZATION', retryable: false, action: 'NONE' }
  if (status === 429) return { category: 'REQUEST', retryable: true, action: 'WAIT' }
  if (status === 409) return { category: 'CONTRACT', retryable: true, action: 'RETRY' }
  if (status >= 400 && status < 500) {
    return { category: 'CONTRACT', retryable: false, action: status === 422 ? 'MODIFY_REQUEST' : 'NONE' }
  }
  return { category: 'INTERNAL', retryable: true, action: 'RETRY' }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
  runId: string | null = null,
) {
  const semantics = errorSemantics(status, code)
  const body = apiErrorSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    error: {
      code,
      ...semantics,
      message,
      requestId,
      runId,
      ...(details === undefined ? {} : { details }),
    },
  })
  return json(body, status)
}

function deliveryUnavailableSemantics(reason: DeliveryUnavailableReason) {
  if (reason === 'RUN_NOT_COMPLETED' || reason === 'QUALITY_RECOVERY' || reason === 'ACCOUNTING_PENDING') {
    return { retryable: true, action: 'WAIT' as const }
  }
  if (reason === 'RUN_FAILED' || reason === 'RUN_CANCELLED') {
    return { retryable: false, action: 'NONE' as const }
  }
  return { retryable: false, action: 'CONTACT_SUPPORT' as const }
}

function deliveryUnavailableResponse(reason: DeliveryUnavailableReason, requestId: string, runId: string) {
  return json(deliveryUnavailableErrorSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    error: {
      code: 'DELIVERY_NOT_AVAILABLE',
      category: 'DELIVERY',
      message: 'delivery is not available',
      ...deliveryUnavailableSemantics(reason),
      requestId,
      runId,
      details: { reason },
    },
  }), 409)
}

function publicRevisionRoundsSettings(settings: Readonly<{
  maxRevisionRounds: number
  version: number
  isConfigured: boolean
  updatedAt: string | null
}>) {
  return adminRevisionRoundsSettingsSchema.parse({
    maxRevisionRounds: settings.maxRevisionRounds,
    version: settings.version,
    isConfigured: settings.isConfigured,
    updatedAt: settings.updatedAt,
  })
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

type DeliveryProjection = Readonly<{
  deliveryAvailability: DeliveryAvailability
  deliveries: readonly DeliveryRecord[]
  delivery: DeliveryRecord | null
}>

function unavailableDelivery(reason: DeliveryUnavailableReason): DeliveryProjection {
  return {
    deliveryAvailability: deliveryAvailabilitySchema.parse({ state: 'UNAVAILABLE', reason }),
    deliveries: [],
    delivery: null,
  }
}

async function projectDelivery(
  repository: AgentRepository,
  artifacts: ArtifactPort,
  run: RunRecord,
  blueprint: Awaited<ReturnType<typeof getActiveBlueprint>> | null,
): Promise<DeliveryProjection> {
  if (run.status === 'FAILED') return unavailableDelivery('RUN_FAILED')
  if (run.status === 'CANCELLED') return unavailableDelivery('RUN_CANCELLED')
  if (run.status === 'RECOVERING' && run.pendingTerminalFailure) {
    return unavailableDelivery('QUALITY_RECOVERY')
  }
  if (run.terminalAccounting?.accountingStatus === 'RECONCILIATION_REQUIRED') {
    return unavailableDelivery('ACCOUNTING_FAILED')
  }
  if (run.status !== 'COMPLETED') return unavailableDelivery('RUN_NOT_COMPLETED')

  if (accountingProtocolFor(run) === 'FRAMEFLOW_USAGE_V2') {
    const finalization = (await repository.listSteps(run.id))
      .find((step) => step.idempotencyKey === usageV2FinalizeStepKey(run.id))
    if (!isUsageV2RunFinalizationAcknowledged(finalization)) {
      return unavailableDelivery(isUsageV2RunFinalizationRetryScheduled(finalization)
        ? 'ACCOUNTING_PENDING'
        : 'ACCOUNTING_FAILED')
    }
  }

  let storedDeliveries: readonly DeliveryRecord[]
  try {
    storedDeliveries = await repository.listDeliveries(run.id)
  } catch {
    return unavailableDelivery('DELIVERY_CONTRACT_INVALID')
  }
  const candidates = storedDeliveries.filter((delivery) =>
    delivery.runId === run.id
    && delivery.revisionRound === run.revisionRound
    && delivery.disposition === 'FINAL'
    && delivery.identity.status === 'VERIFIED')
  if (candidates.length === 0) return unavailableDelivery('VERIFIED_FINAL_DELIVERY_MISSING')
  if (candidates.length !== 1 || !blueprint) return unavailableDelivery('DELIVERY_CONTRACT_INVALID')

  const parsed = publicDeliveryRecordSchema.safeParse(candidates[0])
  if (!parsed.success) return unavailableDelivery('DELIVERY_CONTRACT_INVALID')
  const delivery = parsed.data
  try {
    assertFinalDeliveryForCompletion(run, blueprint, delivery)
  } catch {
    return unavailableDelivery('DELIVERY_CONTRACT_INVALID')
  }
  const references = [delivery.preview, delivery.pptx, delivery.sources]
    .filter((reference) => reference !== undefined)
  try {
    if (!references.every((reference) => artifacts.verifyIntegrity({
      tenantId: run.host.tenantId,
      artifactId: reference.artifactId,
      mimeType: reference.mimeType,
      byteLength: reference.byteLength,
      sha256: reference.sha256,
    }))) return unavailableDelivery('DELIVERY_CONTENT_INVALID')
  } catch {
    return unavailableDelivery('DELIVERY_CONTENT_INVALID')
  }
  return {
    deliveryAvailability: deliveryAvailabilitySchema.parse({
      state: 'AVAILABLE',
      deliveryId: delivery.id,
      disposition: 'FINAL',
      identityStatus: 'VERIFIED',
    }),
    deliveries: [delivery],
    delivery,
  }
}

async function runDetail(
  repository: AgentRepository,
  artifacts: ArtifactPort,
  runs: RunService,
  run: RunRecord,
  host: HostContext,
) {
  const [snapshot, generationBatch, allowedActions] = await Promise.all([
    repository.getRunEventSnapshot(run.id),
    getGenerationBatch(repository, run),
    runs.getAllowedActions(run.id, host),
  ])
  const blueprint = await getActiveBlueprint(repository, run.id, run.revisionRound).catch(() => null)
  const deliveryProjection = await projectDelivery(repository, artifacts, run, blueprint)
  const generationPlan = blueprint?.visualDeckV4Proposal
    ? visualDeckV4GenerationPlan(blueprint.visualDeckV4Proposal)
    : null
  return runDetailSchema.parse({
    ...(await publicRun(repository, run)),
    blueprint: blueprint ? publicBlueprintProjection(blueprint, run.presentationMode ?? 'SLIDE_IMAGE_V2') : null,
    generationPlan,
    ...(generationBatch ? { generationBatch } : {}),
    deliveries: deliveryProjection.deliveries,
    deliveryAvailability: deliveryProjection.deliveryAvailability,
    issues: snapshot.openIssues,
    progress: snapshot.progress,
    allowedActions,
  })
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
  const quickDeckEvaluationHandler = dependencies.quickDeckEvaluation
    ? createQuickDeckEvaluationRequestHandler(dependencies.quickDeckEvaluation)
    : null
  async function handleRequest(request: Request, requestId: string): Promise<Response> {
    let correlatedRunId: string | null = null
    try {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health/live') {
        return json(dependencies.health.liveness(), 200, observabilityHeaders())
      }
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        const readiness = dependencies.health.readiness()
        return json(readiness, readiness.status === 'READY' ? 200 : 503, observabilityHeaders())
      }
      if (request.method === 'GET' && url.pathname === OPENAPI_PATH) {
        return openApiResponse()
      }
      if (request.method === 'GET' && url.pathname === OPENAPI_V2_PATH) {
        return openApiV2Response()
      }
      if (url.pathname.startsWith('/v2/')) {
        if (!dependencies.presentationJobV2) {
          return errorResponse(503, 'PRESENTATION_JOB_V2_UNAVAILABLE', 'presentation jobs are unavailable', requestId)
        }
        return await handlePresentationJobV2Request(dependencies.presentationJobV2, request, requestId)
      }
      if (url.pathname === '/v1/evaluations/quick-decks' || url.pathname.startsWith('/v1/evaluations/quick-decks/')) {
        if (!quickDeckEvaluationHandler) {
          return errorResponse(503, 'QUICK_DECK_EVALUATION_UNAVAILABLE', 'quick deck evaluations are unavailable', requestId)
        }
        return await quickDeckEvaluationHandler(request, requestId)
      }
      const host = await dependencies.authentication.authenticate(request)
      if (!host) return errorResponse(401, 'UNAUTHENTICATED', 'authentication is required', requestId)

      const parts = url.pathname.split('/').filter(Boolean)
      const pathRunId = parts[0] === 'v1' && parts[1] === 'runs' ? parts[2] : undefined
      if (pathRunId && pathRunId.length <= 160 && pathRunId === pathRunId.trim()) correlatedRunId = pathRunId
      if (parts[0] !== 'v1') {
        return errorResponse(404, 'NOT_FOUND', 'resource was not found', requestId)
      }

      if (parts.length === 4 && parts[1] === 'admin' && parts[2] === 'settings' && parts[3] === 'revision-rounds') {
        if (!dependencies.revisionRoundsSettings) {
          return errorResponse(503, 'ADMIN_SETTINGS_UNAVAILABLE', 'admin settings are unavailable', requestId)
        }
        if (request.method === 'GET') {
          const settings = await dependencies.revisionRoundsSettings.get(host)
          return json({ data: publicRevisionRoundsSettings(settings) })
        }
        if (request.method === 'PATCH') {
          const rateLimited = enforceRateLimit(dependencies.rateLimiter, 'RUN_ACTION', host, requestId)
          if (rateLimited) return rateLimited
          const body = await request.json().catch(() => null)
          const parsed = adminRevisionRoundsUpdateSchema.safeParse(body)
          if (!parsed.success) {
            return errorResponse(422, 'INVALID_ADMIN_SETTINGS', 'revision-round settings are invalid', requestId)
          }
          const settings = await dependencies.revisionRoundsSettings.update({ host, ...parsed.data })
          return json({ data: publicRevisionRoundsSettings(settings) })
        }
        return errorResponse(405, 'METHOD_NOT_ALLOWED', 'method is not allowed', requestId)
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
            run: await publicRun(dependencies.repository, result.run),
            step: { id: result.step.id, status: result.step.status, errorCode: result.step.errorCode, updatedAt: result.step.updatedAt },
          },
          replayed: result.replayed,
        })
      }

      if (parts.length === 2 && parts[1] === 'capabilities' && request.method === 'GET') {
        return json(capabilitiesEnvelopeSchema.parse({
          schemaVersion: CONTRACT_VERSION,
          requestId,
          data: dependencies.capabilities ?? DEFAULT_PUBLIC_CAPABILITIES,
        }))
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
        const detail = await runDetail(dependencies.repository, dependencies.artifacts, dependencies.runs, created.run, host)
        return json(createRunEnvelopeSchema.parse({
          schemaVersion: CONTRACT_VERSION,
          requestId,
          data: detail,
          replayed: created.replayed,
        }), created.replayed ? 200 : 201)
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
        return json(runListEnvelopeSchema.parse({
          schemaVersion: CONTRACT_VERSION,
          requestId,
          data: await Promise.all(page.runs.map((run) => publicRun(dependencies.repository, run))),
          pagination: { pageSize: pageSizeValue, nextCursor: page.hasMore ? encodeCursor(page.runs.at(-1)!) : null },
        }))
      }

      const runId = parts[2]
      if (!runId) return errorResponse(404, 'NOT_FOUND', 'resource was not found', requestId)

      if (parts.length === 3 && request.method === 'GET') {
        const run = await dependencies.runs.getOwned(runId, host)
        return json(runDetailEnvelopeSchema.parse({
          schemaVersion: CONTRACT_VERSION,
          requestId,
          data: await runDetail(dependencies.repository, dependencies.artifacts, dependencies.runs, run, host),
        }))
      }

      if (parts.length === 4 && parts[3] === 'plan' && request.method === 'GET') {
        const run = await dependencies.runs.getOwned(runId, host)
        const blueprint = await getActiveBlueprint(dependencies.repository, run.id, run.revisionRound).catch(() => null)
        const data = run.presentationMode !== 'VISUAL_DECK_V4'
          ? { state: 'NOT_READY' as const, reason: 'V4_REQUIRED' as const }
          : blueprint?.visualDeckV4Proposal
            ? { state: 'AVAILABLE' as const, plan: visualDeckV4GenerationPlan(blueprint.visualDeckV4Proposal) }
            : { state: 'NOT_READY' as const, reason: 'V4_PLAN_NOT_READY' as const }
        return json(runPlanEnvelopeSchema.parse({ schemaVersion: CONTRACT_VERSION, requestId, data }))
      }

      if (parts.length === 4 && parts[3] === 'sources' && request.method === 'GET') {
        const run = await dependencies.runs.getOwned(runId, host)
        const blueprint = await getActiveBlueprint(dependencies.repository, run.id, run.revisionRound).catch(() => null)
        return json(runSourcesEnvelopeSchema.parse({
          schemaVersion: CONTRACT_VERSION,
          requestId,
          data: publicRunSources(blueprint),
        }))
      }

      if (parts.length === 4 && parts[3] === 'actions' && request.method === 'POST') {
        const rateLimited = enforceRateLimit(dependencies.rateLimiter, 'RUN_ACTION', host, requestId)
        if (rateLimited) return rateLimited
        const idempotencyKey = request.headers.get('Idempotency-Key')
        if (!idempotencyKey) return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', requestId)
        const body = await request.json().catch(() => null)
        if (!body) return errorResponse(400, 'INVALID_JSON', 'request body must be valid JSON', requestId)
        const updated = await dependencies.runs.act(runId, host, body, idempotencyKey)
        return json(runEnvelopeSchema.parse({
          schemaVersion: CONTRACT_VERSION,
          requestId,
          data: await publicRun(dependencies.repository, updated),
        }))
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
        return json(agentEventHistoryEnvelopeSchema.parse({
          schemaVersion: CONTRACT_VERSION,
          requestId,
          data: page.events,
          pagination: { nextAfter: page.nextAfter, hasMore: page.hasMore },
        }))
      }

      if (parts.length === 6 && parts[3] === 'deliveries' && parts[5] === 'content' && request.method === 'GET') {
        const run = await dependencies.runs.getOwned(runId, host)
        let deliveryId: string
        try {
          deliveryId = decodeURIComponent(parts[4]!)
        } catch {
          return errorResponse(404, 'DELIVERY_NOT_FOUND', 'delivery was not found', requestId, undefined, runId)
        }
        const format = url.searchParams.get('format') ?? 'pptx'
        if (format !== 'preview' && format !== 'pptx' && format !== 'sources') {
          return errorResponse(422, 'INVALID_DELIVERY_FORMAT', 'format must be preview, pptx or sources', requestId, undefined, runId)
        }
        const blueprint = run.status === 'COMPLETED'
          ? await getActiveBlueprint(dependencies.repository, run.id, run.revisionRound).catch(() => null)
          : null
        const projection = await projectDelivery(
          dependencies.repository,
          dependencies.artifacts,
          run,
          blueprint,
        )
        if (projection.deliveryAvailability.state === 'UNAVAILABLE') {
          return deliveryUnavailableResponse(projection.deliveryAvailability.reason, requestId, runId)
        }
        const delivery = projection.delivery
        if (!delivery || delivery.id !== deliveryId) {
          return errorResponse(404, 'DELIVERY_NOT_FOUND', 'delivery was not found', requestId, undefined, runId)
        }
        const reference = format === 'preview' ? delivery.preview : format === 'sources' ? delivery.sources : delivery.pptx
        if (!reference) {
          return errorResponse(404, 'DELIVERY_CONTENT_NOT_FOUND', 'delivery content was not found', requestId, undefined, runId)
        }
        const artifact = await dependencies.artifacts.get({
          tenantId: run.host.tenantId,
          artifactId: reference.artifactId,
        }).catch(() => null)
        const digest = artifact ? createHash('sha256').update(artifact.bytes).digest('hex') : null
        if (!artifact
          || artifact.mimeType !== reference.mimeType
          || artifact.bytes.length !== reference.byteLength
          || artifact.sha256 !== reference.sha256
          || digest !== reference.sha256) {
          return deliveryUnavailableResponse('DELIVERY_CONTENT_INVALID', requestId, runId)
        }
        const safeName = reference.name.replace(/["\\\r\n]/g, '_')
        return new Response(new Uint8Array(artifact.bytes), {
          headers: {
            'Cache-Control': 'private, no-store',
            'Content-Disposition': `attachment; filename="${safeName}"`,
            'Content-Length': String(artifact.bytes.length),
            'Content-Type': reference.mimeType,
            ETag: `"${reference.sha256}"`,
            'X-PPT-Agent-Content-SHA256': reference.sha256,
            'X-PPT-Agent-Delivery-ID': delivery.id,
            'X-PPT-Agent-Schema-Version': CONTRACT_VERSION,
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }

      return errorResponse(404, 'NOT_FOUND', 'resource was not found', requestId)
    } catch (error) {
      if (error instanceof RunServiceError) {
        return errorResponse(error.status, error.code, error.message, requestId, undefined, correlatedRunId)
      }
      if (error instanceof AdminOperationsError) {
        return errorResponse(error.status, error.code, error.message, requestId, undefined, correlatedRunId)
      }
      if (error instanceof AdminRevisionRoundsSettingsError) {
        return errorResponse(error.status, error.code, error.message, requestId, undefined, correlatedRunId)
      }
      return errorResponse(500, 'INTERNAL_ERROR', 'an internal error occurred', requestId, undefined, correlatedRunId)
    }
  }
  return async function handle(request: Request): Promise<Response> {
    const requestIdHeader = request.headers.get('X-Request-ID')
    const normalizedRequestId = requestIdHeader?.trim()
    const requestId = normalizedRequestId && normalizedRequestId.length <= 160 ? normalizedRequestId : randomUUID()
    return applyContractHeaders(await handleRequest(request, requestId), requestId)
  }
}

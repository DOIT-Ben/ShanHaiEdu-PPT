import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  V4_EVALUATION_CANARY_PAGE_COUNTS,
  V4_EVALUATION_DEFAULT_SERVICE_URL,
  assertV4EvaluationRoots,
  evaluationInputContentHash,
  deliveryAvailabilityWaitState,
  loadV4EvaluationInputs,
  normalizeEvaluationRequest,
  presentationSlideEntries,
  referencedSlideImageEntry,
  requireAvailableDelivery,
  requireTerminalV4SseEvidence,
  readV4EvaluationGatewayTarget,
  readV4RunEventStream,
  reconcileV4SseEventStream,
  REQUIRED_COMPLETED_LIFECYCLE,
  resolveV4EvaluationCanaryPageCounts,
  redactedEvaluationRequest,
  runV4EvaluationCanary,
  validateLifecycle,
  validateQualityGate,
  validateRasterPages,
  validateCreatedV4RunIdentity,
  assertV4RunStatusMatchesSseTerminal,
  exerciseV4PauseResume,
  validateV4PauseResumeSseEvidence,
  v4EvaluationActionIdempotencyKey,
  v4EvaluationIdempotencyKey,
  type V4EvaluationPauseResumeEvidence,
  type V4EvaluationRelease,
} from '../scripts/run-v4-real-evaluation'
import { createPublicCapabilities } from '../src/run-query-contracts'

type LifecycleEvent = Parameters<typeof validateLifecycle>[0][number]

const releasedService: V4EvaluationRelease = {
  softwareVersion: '4.4.0',
  gitSha: 'a'.repeat(40),
  releaseId: 'v4.4.0-aaaaaaaaaaaa',
}

function request() {
  return {
    schemaVersion: '1',
    host: { tenantId: 'phase5', externalUserId: 'evaluation-user' },
    source: { kind: 'TEXT', name: '教材.txt', text: '这是用于真实评测脚本合同测试的完整教材内容。'.repeat(4) },
    slideCount: 10,
    visualDirection: '适合课堂投影的清晰视觉风格',
    imageModel: 'gemini-3-pro-image-preview',
    automationLevel: 'BOUNDED_AUTO',
    budgetUnits: 30,
    maxRevisionRounds: 2,
    presentationMode: 'VISUAL_DECK_V4',
    visualDeckV4: {
      instruction: '请制作一套10页课堂PPT。',
      sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 10 }, aspectRatio: '16:9',
      },
    },
  }
}

function requestForSlideCount(slideCount: 1 | 3 | 10) {
  const value = request()
  value.slideCount = slideCount
  value.visualDeckV4.deckOptions.length = { slideCount }
  value.visualDeckV4.instruction = `请制作一套${slideCount}页课堂PPT。`
  return normalizeEvaluationRequest(value, slideCount)
}

function gatewayCapabilities(imageModel = 'gemini-3-pro-image-preview') {
  const textModel = 'gpt-5.6-terra'
  return createPublicCapabilities({
    runtimeMode: 'GATEWAY',
    textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
    textModels: [textModel],
    visionModels: [textModel],
    imageModels: [imageModel],
    modelAvailability: {
      text: [{ model: textModel, state: 'HEALTHY', checkedAt: '2026-08-08T00:00:00.000Z' }],
      vision: [{ model: textModel, state: 'HEALTHY', checkedAt: '2026-08-08T00:00:00.000Z' }],
      image: [{ model: imageModel, state: 'HEALTHY', checkedAt: '2026-08-08T00:00:00.000Z' }],
      imageEdit: [],
    },
  })
}

function readinessResponse(release = releasedService) {
  return new Response(JSON.stringify({ service: 'ppt-agent', status: 'READY', release }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function capabilitiesResponse(capability: ReturnType<typeof gatewayCapabilities>) {
  return new Response(JSON.stringify({ schemaVersion: '1', requestId: 'v4-eval-capabilities', data: capability }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function completedLifecycleEvents(): LifecycleEvent[] {
  return REQUIRED_COMPLETED_LIFECYCLE.map((type, index) => {
    if (type === 'run.completed') {
      return { eventId: `event-${index + 1}`, sequence: index + 1, type, payload: undefined }
    }
    const stage = type.split('.')[0]!.toUpperCase()
    const started = type.endsWith('.started')
    const reason = null
    return {
      eventId: `event-${index + 1}`,
      sequence: index + 1,
      type,
      payload: {
        stage,
        completed: started ? 0 : 1,
        total: 1,
        pageNumbers: [1],
        revisionKind: null,
        revisionRound: 0,
        reason,
      },
    }
  })
}

function sseEvent(sequence: number, type: 'run.started' | 'run.completed' | 'run.failed') {
  return {
    schemaVersion: '1',
    id: `event-${sequence}`,
    eventId: `event-${sequence}`,
    runId: 'run-sse-1',
    sequence,
    createdAt: '2026-08-08T00:00:00.000Z',
    type,
    payload: type === 'run.started'
      ? { status: 'PLANNING' }
      : type === 'run.completed'
        ? { deliveryId: 'run-sse-1:delivery:r0', qualityOverride: false }
        : { errorCode: 'USAGE_V2_FINALIZATION_REJECTED' },
  }
}

function sseUnknownEvent(sequence: number) {
  return {
    schemaVersion: '1',
    id: `event-${sequence}`,
    eventId: `event-${sequence}`,
    runId: 'run-sse-1',
    sequence,
    createdAt: '2026-08-08T00:00:00.000Z',
    type: 'future.event',
    payload: { index: sequence },
  }
}

function sseAccountingFinalizedEvent(sequence: number) {
  return {
    schemaVersion: '1',
    id: `event-${sequence}`,
    eventId: `event-${sequence}`,
    runId: 'run-sse-1',
    sequence,
    createdAt: '2026-08-08T00:00:00.000Z',
    type: 'run.accounting.finalized',
    payload: {
      presentationMode: 'VISUAL_DECK_V4',
      stage: 'RUN',
      completed: 1,
      total: 1,
      pageNumbers: [1],
      revisionKind: null,
      revisionRound: 0,
      maxRevisionRounds: 2,
      budgetUnits: 10,
      committedBudgetUnits: 4,
      reason: 'INTERNAL_FAILURE',
      retryable: false,
      requiresUserAction: false,
      nextAction: null,
      terminalAccounting: {
        authorizedUnits: 10,
        submittedUnits: 4,
        settledUnits: 4,
        releasedUnits: 6,
        reconciliationUnits: 0,
        accountingStatus: 'FINAL',
      },
    },
  }
}

function streamedSseResponse(frames: readonly string[], requestId: string) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
      controller.close()
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Request-ID': requestId,
    },
  })
}

const actionRelease = {
  softwareVersion: '4.4.0',
  presentationMode: 'VISUAL_DECK_V4' as const,
  compilerVersion: 'visual-deck-v4-chain-4',
  contractVersion: '1',
  gitSha: 'a'.repeat(40),
  releaseId: 'v4.4.0-aaaaaaaaaaaa',
}

function actionRunDetail(input: Readonly<{
  id: string
  status: 'EXECUTING' | 'PAUSED'
  version: number
  resumeState: 'EXECUTING' | null
  allowedActions: readonly { type: 'PAUSE' | 'RESUME'; expectedVersion: number }[]
}>) {
  return {
    schemaVersion: '1' as const,
    id: input.id,
    host: { tenantId: 'phase5', externalUserId: 'evaluation-user' },
    status: input.status,
    resumeState: input.resumeState,
    visualDirection: '适合课堂投影的清晰视觉风格',
    targetAudience: null,
    presentationGoal: null,
    imageModel: 'gemini-3-pro-image-preview',
    automationLevel: 'BOUNDED_AUTO' as const,
    version: input.version,
    slideCount: 1,
    revisionRound: 0,
    maxRevisionRounds: 2,
    planningAttempt: 0,
    maxPlanningRetries: 2 as const,
    budgetUnits: 30,
    committedBudgetUnits: 0,
    qualityScore: null,
    qualityOverride: false,
    qualityDisposition: 'PENDING' as const,
    qualityPolicyAudit: null,
    qualityOverrideAudit: null,
    presentationMode: 'VISUAL_DECK_V4' as const,
    release: actionRelease,
    error: null,
    blueprint: null,
    generationPlan: null,
    deliveries: [],
    deliveryAvailability: { state: 'UNAVAILABLE' as const, reason: 'RUN_NOT_COMPLETED' as const },
    issues: [],
    progress: [],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:01.000Z',
    allowedActions: input.allowedActions,
  }
}

function actionRunSnapshot(detail: ReturnType<typeof actionRunDetail>) {
  const {
    allowedActions: _allowedActions,
    blueprint: _blueprint,
    generationPlan: _generationPlan,
    deliveries: _deliveries,
    deliveryAvailability: _deliveryAvailability,
    issues: _issues,
    progress: _progress,
    ...snapshot
  } = detail
  return snapshot
}

function actionDetailResponse(detail: ReturnType<typeof actionRunDetail>, requestId: string) {
  return new Response(JSON.stringify({ schemaVersion: '1', requestId, data: detail }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
  })
}

function actionSnapshotResponse(detail: ReturnType<typeof actionRunDetail>, requestId: string) {
  return new Response(JSON.stringify({ schemaVersion: '1', requestId, data: actionRunSnapshot(detail) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
  })
}

function actionHistoryResponse(runId: string, requestId: string, cursorSequence = 0, events: readonly unknown[] = []) {
  const data = events.length > 0
    ? events
    : cursorSequence === 0
      ? []
      : [{
          schemaVersion: '1',
          id: `cursor-event-${cursorSequence}`,
          eventId: `cursor-event-${cursorSequence}`,
          runId,
          sequence: cursorSequence,
          createdAt: '2026-08-08T00:00:00.000Z',
          type: 'action.cursor',
          payload: {},
        }]
  return new Response(JSON.stringify({
    schemaVersion: '1', requestId, data,
    pagination: { nextAfter: cursorSequence, hasMore: false },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
  })
}

function actionErrorResponse(code: string, requestId: string, runId: string) {
  return new Response(JSON.stringify({
    schemaVersion: '1',
    error: {
      code, category: 'CONTRACT', retryable: true, action: 'RETRY',
      message: 'action rejected', requestId, runId,
    },
  }), {
    status: 409,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
  })
}

function pauseResumeEvidence(runId = 'run-action-1'): V4EvaluationPauseResumeEvidence {
  return {
    runId,
    pause: {
      type: 'PAUSE', expectedVersion: 4, allowedActionVersion: 4, detailVersion: 4,
      idempotencyKey: 'pause-key', detailRequestId: 'detail-request-1', detailResponseRequestId: 'detail-request-1',
      beforeEvent: { sequence: 4, requestId: 'cursor-request-1', responseRequestId: 'cursor-request-1' },
      afterEvent: { sequence: 5, requestId: 'cursor-request-2', responseRequestId: 'cursor-request-2' },
      conflicts: [],
      requestId: 'action-request-1', responseRequestId: 'action-request-1',
      beforeStatus: 'EXECUTING', status: 'PAUSED', responseVersion: 5, resumeState: 'EXECUTING',
    },
    resume: {
      type: 'RESUME', expectedVersion: 5, allowedActionVersion: 5, detailVersion: 5,
      idempotencyKey: 'resume-key', detailRequestId: 'detail-request-2', detailResponseRequestId: 'detail-request-2',
      beforeEvent: { sequence: 5, requestId: 'cursor-request-3', responseRequestId: 'cursor-request-3' },
      afterEvent: { sequence: 6, requestId: 'cursor-request-4', responseRequestId: 'cursor-request-4' },
      conflicts: [],
      requestId: 'action-request-2', responseRequestId: 'action-request-2',
      beforeStatus: 'PAUSED', status: 'EXECUTING', responseVersion: 6, resumeState: null,
    },
  }
}

describe('V4 real evaluation harness', () => {
  test('uses the main V4 service and only the fixed 1 -> 3 -> 10 canary sequence', () => {
    expect(V4_EVALUATION_DEFAULT_SERVICE_URL).toBe('http://127.0.0.1:4310')
    expect(resolveV4EvaluationCanaryPageCounts(undefined)).toEqual([1, 3, 10])
    expect(resolveV4EvaluationCanaryPageCounts('1,3,10')).toEqual([1, 3, 10])
    expect(() => resolveV4EvaluationCanaryPageCounts('3,10')).toThrow('V4_EVAL_PAGE_COUNTS_INVALID')
    expect(() => resolveV4EvaluationCanaryPageCounts('1,10,3')).toThrow('V4_EVAL_PAGE_COUNTS_INVALID')
  })

  test('rejects production runtime paths before it can read inputs or write an evaluation report', () => {
    expect(() => assertV4EvaluationRoots('/opt/ppt-agent/input', '/opt/ppt-agent-test/evaluation')).toThrow(
      'V4_EVAL_INPUT_PRODUCTION_PATH_FORBIDDEN',
    )
    expect(() => assertV4EvaluationRoots('/srv/ppt-evaluation-input', '/opt/ppt-agent/reports')).toThrow(
      'V4_EVAL_OUTPUT_PRODUCTION_PATH_FORBIDDEN',
    )
  })

  test('writes only hashes for request source and model-facing instructions', () => {
    const input = normalizeEvaluationRequest(request(), 10)
    const manifest = redactedEvaluationRequest(input)
    const serialized = JSON.stringify(manifest)

    expect(serialized).not.toContain(input.source.kind === 'TEXT' ? input.source.text : '')
    expect(serialized).not.toContain(input.visualDeckV4!.instruction)
    expect(manifest.source.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.contentHashes.visualDeckV4).toMatch(/^[a-f0-9]{64}$/)
  })

  test('consumes fragmented SSE frames and flushes the terminal event at EOF with a caller-correlated request id', async () => {
    const requestId = 'v4-eval-sse-request-1'
    const started = sseEvent(1, 'run.started')
    const completed = sseEvent(2, 'run.completed')
    const startedFrame = `id: 1\nevent: run.started\ndata: ${JSON.stringify(started)}\n\n`
    const observed = await readV4RunEventStream({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-sse-1',
      after: 0,
      requestId,
      timeoutMs: 1_000,
      fetch: async (url, init) => {
        expect(new URL(url).pathname).toBe('/v1/runs/run-sse-1/events')
        expect(new URL(url).searchParams.get('after')).toBe('0')
        expect(new Headers(init?.headers).get('X-Request-ID')).toBe(requestId)
        return streamedSseResponse([
          ': heartbeat\n\n',
          startedFrame.slice(0, 45),
          startedFrame.slice(45),
          `id: 2\nevent: run.completed\ndata: ${JSON.stringify(completed)}\n`,
        ], requestId)
      },
    })

    expect(observed.requestId).toBe(requestId)
    expect(observed.responseRequestId).toBe(requestId)
    expect(observed.events).toHaveLength(2)
    expect(observed.events.map((event) => event.eventId)).toEqual(['event-1', 'event-2'])
    expect(observed.events.map((event) => event.sequence)).toEqual([1, 2])
    expect(observed.events.map((event) => event.type)).toEqual(['run.started', 'run.completed'])
    expect(reconcileV4SseEventStream(observed.events, observed.events)).toEqual({
      eventCount: 2,
      historyEventCount: 2,
      trailingAuditEventCount: 0,
      firstSequence: 1,
      lastSequence: 2,
      terminalEventType: 'run.completed',
    })
  })

  test('rejects an SSE response that cannot prove its request id, terminal frame, or history identity', async () => {
    const started = sseEvent(1, 'run.started')
    await expect(readV4RunEventStream({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-sse-1',
      after: 0,
      requestId: 'v4-eval-sse-request-2',
      timeoutMs: 1_000,
      fetch: async () => streamedSseResponse([
        `id: 1\nevent: run.started\ndata: ${JSON.stringify(started)}\n\n`,
      ], 'wrong-request-id'),
    })).rejects.toThrow('V4_EVAL_SSE_REQUEST_ID_MISMATCH')

    expect(() => reconcileV4SseEventStream([started], [{ ...started, eventId: 'different-event' }]))
      .toThrow('V4_EVAL_SSE_HISTORY_IDENTITY_MISMATCH')
  })

  test('keeps consuming after a completed event until the stream closes at its effective terminal event', async () => {
    const requestId = 'v4-eval-sse-request-3'
    const started = sseEvent(1, 'run.started')
    const completed = sseEvent(2, 'run.completed')
    const failed = sseEvent(3, 'run.failed')
    const observed = await readV4RunEventStream({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-sse-1',
      after: 0,
      requestId,
      timeoutMs: 1_000,
      fetch: async () => streamedSseResponse([
        `id: 1\nevent: run.started\ndata: ${JSON.stringify(started)}\n\n`,
        `id: 2\nevent: run.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        `id: 3\nevent: run.failed\ndata: ${JSON.stringify(failed)}\n`,
      ], requestId),
    })

    expect(observed.events.map((event) => event.type)).toEqual(['run.started', 'run.completed', 'run.failed'])
    expect(reconcileV4SseEventStream(observed.events, observed.events).terminalEventType).toBe('run.failed')
  })

  test('pauses and resumes only with server-provided versions and proves both actions on the same SSE stream', async () => {
    const calls: Array<{ path: string; method: string; idempotencyKey: string | null; requestId: string | null }> = []
    const details = [
      actionRunDetail({ id: 'run-action-1', status: 'EXECUTING', version: 4, resumeState: null, allowedActions: [{ type: 'PAUSE', expectedVersion: 4 }] }),
      actionRunDetail({ id: 'run-action-1', status: 'PAUSED', version: 5, resumeState: 'EXECUTING', allowedActions: [{ type: 'RESUME', expectedVersion: 5 }] }),
    ]
    let detailIndex = 0
    let historyIndex = 0
    const evidence = await exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-1',
      batchKey: 'batch-action-1',
      timeoutMs: 1_000,
      pollMs: 1,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        calls.push({
          path: parsed.pathname,
          method: init?.method ?? 'GET',
          idempotencyKey: new Headers(init?.headers).get('Idempotency-Key'),
          requestId: new Headers(init?.headers).get('X-Request-ID'),
        })
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) {
          const cursor = [0, 5, 5, 6][Math.min(historyIndex++, 3)]!
          return actionHistoryResponse('run-action-1', requestId, cursor)
        }
        if (parsed.pathname.endsWith('/actions')) {
          const body = JSON.parse(String(init?.body)) as { type: string; expectedVersion: number }
          const status = body.type === 'PAUSE' ? 'PAUSED' : 'EXECUTING'
          const version = body.type === 'PAUSE' ? 5 : 6
          return actionSnapshotResponse(actionRunDetail({
            id: 'run-action-1', status, version,
            resumeState: body.type === 'PAUSE' ? 'EXECUTING' : null,
            allowedActions: [],
          }), requestId)
        }
        const detail = details[Math.min(detailIndex++, details.length - 1)]!
        return actionDetailResponse(detail, requestId)
      },
    })

    expect(evidence.pause).toMatchObject({
      type: 'PAUSE', expectedVersion: 4, status: 'PAUSED', responseVersion: 5,
      allowedActionVersion: 4, detailVersion: 4,
      beforeEvent: { sequence: 0 }, afterEvent: { sequence: 5 }, conflicts: [],
      idempotencyKey: v4EvaluationActionIdempotencyKey('run-action-1', 'PAUSE', 4, 'batch-action-1'),
    })
    expect(evidence.resume).toMatchObject({
      type: 'RESUME', expectedVersion: 5, status: 'EXECUTING', responseVersion: 6,
      allowedActionVersion: 5, detailVersion: 5,
      idempotencyKey: v4EvaluationActionIdempotencyKey('run-action-1', 'RESUME', 5, 'batch-action-1'),
    })
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.idempotencyKey)).toEqual([
      evidence.pause.idempotencyKey,
      evidence.resume.idempotencyKey,
    ])

    const events = [
      { eventId: 'event-1', runId: 'run-action-1', sequence: 5, type: 'run.paused', payload: { reason: 'PAUSED_BY_USER', resumeState: 'EXECUTING' } },
      { eventId: 'event-2', runId: 'run-action-1', sequence: 6, type: 'run.resumed', payload: { status: 'EXECUTING' } },
    ]
    expect(validateV4PauseResumeSseEvidence(events, evidence)).toEqual({
      pauseEvent: { eventId: 'event-1', sequence: 5, type: 'run.paused' },
      resumeEvent: { eventId: 'event-2', sequence: 6, type: 'run.resumed' },
    })
  })

  test('retries a pause only after an explicit version conflict and binds the retry to the newer server version', async () => {
    const pauseKeys: string[] = []
    const details = [
      actionRunDetail({ id: 'run-action-conflict', status: 'EXECUTING', version: 4, resumeState: null, allowedActions: [{ type: 'PAUSE', expectedVersion: 4 }] }),
      actionRunDetail({ id: 'run-action-conflict', status: 'EXECUTING', version: 5, resumeState: null, allowedActions: [{ type: 'PAUSE', expectedVersion: 5 }] }),
      actionRunDetail({ id: 'run-action-conflict', status: 'PAUSED', version: 6, resumeState: 'EXECUTING', allowedActions: [{ type: 'RESUME', expectedVersion: 6 }] }),
    ]
    let detailIndex = 0
    let historyIndex = 0
    const persistedConflicts: unknown[] = []
    const evidence = await exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-conflict',
      batchKey: 'batch-action-conflict',
      timeoutMs: 1_000,
      pollMs: 1,
      onConflict: (conflict) => { persistedConflicts.push(conflict) },
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) {
          const cursor = [0, 4, 6, 6, 7][Math.min(historyIndex++, 4)]!
          return actionHistoryResponse('run-action-conflict', requestId, cursor)
        }
        if (!parsed.pathname.endsWith('/actions')) {
          const detail = details[Math.min(detailIndex++, details.length - 1)]!
          return actionDetailResponse(detail, requestId)
        }
        const body = JSON.parse(String(init?.body)) as { type: string; expectedVersion: number }
        const key = new Headers(init?.headers).get('Idempotency-Key')
        if (body.type === 'PAUSE') pauseKeys.push(key ?? '')
        if (body.type === 'PAUSE' && body.expectedVersion === 4) {
          return new Response(JSON.stringify({
            schemaVersion: '1',
            error: {
              code: 'RUN_VERSION_CONFLICT', category: 'CONTRACT', retryable: true, action: 'RETRY',
              message: 'version changed', requestId, runId: 'run-action-conflict',
            },
          }), {
            status: 409,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          })
        }
        const status = body.type === 'PAUSE' ? 'PAUSED' : 'EXECUTING'
        const version = body.type === 'PAUSE' ? 6 : 7
        return actionSnapshotResponse(actionRunDetail({
          id: 'run-action-conflict', status, version,
          resumeState: body.type === 'PAUSE' ? 'EXECUTING' : null,
          allowedActions: [],
        }), requestId)
      },
    })

    expect(pauseKeys).toEqual([
      v4EvaluationActionIdempotencyKey('run-action-conflict', 'PAUSE', 4, 'batch-action-conflict'),
      v4EvaluationActionIdempotencyKey('run-action-conflict', 'PAUSE', 5, 'batch-action-conflict'),
    ])
    expect(evidence.pause.expectedVersion).toBe(5)
    expect(evidence.resume.expectedVersion).toBe(6)
    expect(evidence.pause.conflicts).toHaveLength(1)
    expect(persistedConflicts).toHaveLength(1)
    expect(evidence.pause.conflicts[0]).toMatchObject({
      status: 409,
      expectedVersion: 4,
      errorCode: 'RUN_VERSION_CONFLICT',
      errorRunId: 'run-action-conflict',
      beforeEvent: { sequence: 0 },
    })
  })

  test('retains the conflict journal callback when a later action fails', async () => {
    const details = [
      actionRunDetail({ id: 'run-action-journal', status: 'EXECUTING', version: 4, resumeState: null, allowedActions: [{ type: 'PAUSE', expectedVersion: 4 }] }),
      actionRunDetail({ id: 'run-action-journal', status: 'EXECUTING', version: 5, resumeState: null, allowedActions: [{ type: 'PAUSE', expectedVersion: 5 }] }),
      actionRunDetail({ id: 'run-action-journal', status: 'PAUSED', version: 6, resumeState: 'EXECUTING', allowedActions: [{ type: 'RESUME', expectedVersion: 6 }] }),
    ]
    const persistedConflicts: unknown[] = []
    let detailIndex = 0
    let historyIndex = 0
    await expect(exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-journal',
      batchKey: 'batch-action-journal',
      timeoutMs: 1_000,
      pollMs: 1,
      onConflict: (conflict) => { persistedConflicts.push(conflict) },
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) {
          const cursor = [0, 4, 6, 6][Math.min(historyIndex++, 3)]!
          return actionHistoryResponse('run-action-journal', requestId, cursor)
        }
        if (!parsed.pathname.endsWith('/actions')) {
          return actionDetailResponse(details[Math.min(detailIndex++, details.length - 1)]!, requestId)
        }
        const body = JSON.parse(String(init?.body)) as { type: string; expectedVersion: number }
        if (body.type === 'PAUSE' && body.expectedVersion === 4) {
          return actionErrorResponse('RUN_VERSION_CONFLICT', requestId, 'run-action-journal')
        }
        if (body.type === 'RESUME') {
          return actionErrorResponse('IDEMPOTENCY_CONFLICT', requestId, 'run-action-journal')
        }
        return actionSnapshotResponse(details[2]!, requestId)
      },
    })).rejects.toThrow('V4_EVAL_ACTION_HTTP_409_IDEMPOTENCY_CONFLICT')
    expect(persistedConflicts).toHaveLength(1)
    expect(persistedConflicts[0]).toMatchObject({ type: 'PAUSE', errorCode: 'RUN_VERSION_CONFLICT' })
  })

  test('binds detail and action envelopes to the exact request id sent by the harness', async () => {
    const detail = actionRunDetail({
      id: 'run-action-request-id', status: 'EXECUTING', version: 4, resumeState: null,
      allowedActions: [{ type: 'PAUSE', expectedVersion: 4 }],
    })
    let detailCalls = 0
    let actionCalls = 0
    await expect(exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-request-id',
      batchKey: 'batch-request-id',
      timeoutMs: 1_000,
      pollMs: 1,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) return actionHistoryResponse('run-action-request-id', requestId)
        if (parsed.pathname.endsWith('/actions')) {
          actionCalls += 1
          return actionSnapshotResponse(actionRunDetail({
            id: 'run-action-request-id', status: 'PAUSED', version: 5, resumeState: 'EXECUTING', allowedActions: [],
          }), 'response-belongs-to-another-request')
        }
        detailCalls += 1
        return actionDetailResponse(detail, 'detail-belongs-to-another-request')
      },
    })).rejects.toThrow('V4_EVAL_RUN_ACTIONS_REQUEST_ID_MISMATCH')
    expect(detailCalls).toBe(1)
    expect(actionCalls).toBe(0)
  })

  test('rejects a successful action response whose request id is not the action request id', async () => {
    const detail = actionRunDetail({
      id: 'run-action-response-id', status: 'EXECUTING', version: 4, resumeState: null,
      allowedActions: [{ type: 'PAUSE', expectedVersion: 4 }],
    })
    let actionCalls = 0
    let historyIndex = 0
    await expect(exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-response-id',
      batchKey: 'batch-response-id',
      timeoutMs: 1_000,
      pollMs: 1,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) {
          const cursor = [0, 5][Math.min(historyIndex++, 1)]!
          return actionHistoryResponse('run-action-response-id', requestId, cursor)
        }
        if (parsed.pathname.endsWith('/actions')) {
          actionCalls += 1
          return actionSnapshotResponse(actionRunDetail({
            id: 'run-action-response-id', status: 'PAUSED', version: 5, resumeState: 'EXECUTING', allowedActions: [],
          }), 'another-action-request')
        }
        return actionDetailResponse(detail, requestId)
      },
    })).rejects.toThrow('V4_EVAL_ACTION_REQUEST_ID_MISMATCH')
    expect(actionCalls).toBe(1)
  })

  test('does not refresh or retry a non-version 409 action failure', async () => {
    const detail = actionRunDetail({
      id: 'run-action-non-version-conflict', status: 'EXECUTING', version: 4, resumeState: null,
      allowedActions: [{ type: 'PAUSE', expectedVersion: 4 }],
    })
    let detailCalls = 0
    let actionCalls = 0
    await expect(exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-non-version-conflict',
      batchKey: 'batch-non-version-conflict',
      timeoutMs: 1_000,
      pollMs: 1,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) return actionHistoryResponse('run-action-non-version-conflict', requestId)
        if (parsed.pathname.endsWith('/actions')) {
          actionCalls += 1
          return actionErrorResponse('IDEMPOTENCY_CONFLICT', requestId, 'run-action-non-version-conflict')
        }
        detailCalls += 1
        return actionDetailResponse(detail, requestId)
      },
    })).rejects.toThrow('V4_EVAL_ACTION_HTTP_409_IDEMPOTENCY_CONFLICT')
    expect(detailCalls).toBe(1)
    expect(actionCalls).toBe(1)
  })

  test('fails closed when a detail or cursor error is not correlated to the request and Run', async () => {
    const detail = actionRunDetail({
      id: 'run-action-error-correlation', status: 'EXECUTING', version: 4, resumeState: null,
      allowedActions: [{ type: 'PAUSE', expectedVersion: 4 }],
    })
    await expect(exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-error-correlation',
      batchKey: 'batch-detail-error-correlation',
      timeoutMs: 1_000,
      pollMs: 1,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) {
          return actionErrorResponse('HISTORY_UNAVAILABLE', 'wrong-history-request', 'run-action-error-correlation')
        }
        return actionDetailResponse(detail, requestId)
      },
    })).rejects.toThrow('V4_EVAL_ACTION_CURSOR_REQUEST_ID_MISMATCH')

    await expect(exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-error-correlation',
      batchKey: 'batch-cursor-jump',
      timeoutMs: 1_000,
      pollMs: 1,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) {
          return new Response(JSON.stringify({
            schemaVersion: '1', requestId, data: [], pagination: { nextAfter: 7, hasMore: false },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          })
        }
        return actionDetailResponse(detail, requestId)
      },
    })).rejects.toThrow('V4_EVAL_ACTION_CURSOR_SEQUENCE_INVALID')

    await expect(exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-error-correlation',
      batchKey: 'batch-detail-error-correlation-2',
      timeoutMs: 1_000,
      pollMs: 1,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) return actionHistoryResponse('run-action-error-correlation', requestId)
        return new Response(JSON.stringify({
          schemaVersion: '1',
          error: {
            code: 'RUN_NOT_FOUND', category: 'CONTRACT', retryable: false, action: 'NONE',
            message: 'run missing', requestId, runId: 'run-other',
          },
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
        })
      },
    })).rejects.toThrow('V4_EVAL_RUN_ACTIONS_RUN_ID_INVALID')
  })

  test('rejects a version conflict whose error belongs to another Run', async () => {
    const detail = actionRunDetail({
      id: 'run-action-conflict-run-id', status: 'EXECUTING', version: 4, resumeState: null,
      allowedActions: [{ type: 'PAUSE', expectedVersion: 4 }],
    })
    await expect(exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-conflict-run-id',
      batchKey: 'batch-conflict-run-id',
      timeoutMs: 1_000,
      pollMs: 1,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) return actionHistoryResponse('run-action-conflict-run-id', requestId)
        if (parsed.pathname.endsWith('/actions')) {
          return actionErrorResponse('RUN_VERSION_CONFLICT', requestId, 'run-other')
        }
        return actionDetailResponse(detail, requestId)
      },
    })).rejects.toThrow('V4_EVAL_ACTION_ERROR_RUN_ID_MISMATCH')
  })

  test('rejects an action response that does not advance the version or preserve the pause invariant', async () => {
    const runCase = (responseDetail: ReturnType<typeof actionRunDetail>, expectedError: string) => {
      let historyIndex = 0
      return expect(exerciseV4PauseResume({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-action-transition',
      batchKey: `batch-${expectedError}`,
      timeoutMs: 1_000,
      pollMs: 1,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        const requestId = new Headers(init?.headers).get('X-Request-ID') ?? 'missing-request-id'
        if (parsed.pathname.endsWith('/events/history')) {
          const cursor = [0, 5][Math.min(historyIndex++, 1)]!
          return actionHistoryResponse('run-action-transition', requestId, cursor)
        }
        if (parsed.pathname.endsWith('/actions')) return actionSnapshotResponse(responseDetail, requestId)
        return actionDetailResponse(actionRunDetail({
          id: 'run-action-transition', status: 'EXECUTING', version: 4, resumeState: null,
          allowedActions: [{ type: 'PAUSE', expectedVersion: 4 }],
        }), requestId)
      },
      })).rejects.toThrow(expectedError)
    }

    await runCase(actionRunDetail({
      id: 'run-action-transition', status: 'PAUSED', version: 4, resumeState: 'EXECUTING', allowedActions: [],
    }), 'V4_EVAL_ACTION_VERSION_TRANSITION_INVALID')
    await runCase(actionRunDetail({
      id: 'run-action-transition', status: 'EXECUTING', version: 5, resumeState: null, allowedActions: [],
    }), 'V4_EVAL_PAUSE_ACTION_RESULT_INVALID')
  })

  test('rejects foreign-run and stale pause/resume SSE evidence', () => {
    const evidence = pauseResumeEvidence()
    expect(() => validateV4PauseResumeSseEvidence([
      { eventId: 'foreign-1', runId: 'run-other', sequence: 5, type: 'run.paused', payload: { reason: 'PAUSED_BY_USER', resumeState: 'EXECUTING' } },
      { eventId: 'foreign-2', runId: 'run-other', sequence: 6, type: 'run.resumed', payload: { status: 'EXECUTING' } },
    ], evidence)).toThrow('V4_EVAL_SSE_RUN_ID_MISMATCH')
    expect(() => validateV4PauseResumeSseEvidence([
      { eventId: 'stale-1', runId: evidence.runId, sequence: 3, type: 'run.paused', payload: { reason: 'PAUSED_BY_USER', resumeState: 'EXECUTING' } },
      { eventId: 'stale-2', runId: evidence.runId, sequence: 4, type: 'run.resumed', payload: { status: 'EXECUTING' } },
    ], evidence)).toThrow('V4_EVAL_PAUSE_SSE_EVENT_MISSING')
  })

  test('accepts coalesced complete frames larger than the aggregate buffer limit while bounding each frame', async () => {
    const requestId = 'v4-eval-sse-request-4'
    const eventCount = 3_000
    const coalescedFrames = Array.from({ length: eventCount }, (_, index) => {
      const event = sseUnknownEvent(index + 1)
      return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    }).join('')
    const terminal = sseEvent(eventCount + 1, 'run.completed')
    const terminalFrame = `id: ${terminal.sequence}\nevent: ${terminal.type}\ndata: ${JSON.stringify(terminal)}\n`
    expect(coalescedFrames.length + terminalFrame.length).toBeGreaterThan(512 * 1024)

    const observed = await readV4RunEventStream({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-sse-1',
      after: 0,
      requestId,
      timeoutMs: 2_000,
      fetch: async () => streamedSseResponse([coalescedFrames + terminalFrame], requestId),
    })

    expect(observed.events).toHaveLength(eventCount + 1)
    expect(observed.events.at(-1)!.type).toBe('run.completed')
  })

  test('accepts the effective accounting terminal event and tolerates only post-terminal audit history', async () => {
    const requestId = 'v4-eval-sse-request-5'
    const started = sseEvent(1, 'run.started')
    const accounting = sseAccountingFinalizedEvent(2)
    const observed = await readV4RunEventStream({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-sse-1',
      after: 0,
      requestId,
      timeoutMs: 1_000,
      fetch: async () => streamedSseResponse([
        `id: 1\nevent: run.started\ndata: ${JSON.stringify(started)}\n\n`,
        `id: 2\nevent: run.accounting.finalized\ndata: ${JSON.stringify(accounting)}\n`,
      ], requestId),
    })
    const audit = { eventId: 'event-3', runId: 'run-sse-1', sequence: 3, type: 'tool.completed' }
    const reconciliation = reconcileV4SseEventStream(observed.events, [...observed.events, audit])

    expect(reconciliation).toEqual({
      eventCount: 2,
      historyEventCount: 3,
      trailingAuditEventCount: 1,
      firstSequence: 1,
      lastSequence: 2,
      terminalEventType: 'run.accounting.finalized',
    })
    expect(() => reconcileV4SseEventStream(observed.events, [...observed.events, {
      eventId: 'event-3', runId: 'run-sse-1', sequence: 3, type: 'run.failed',
    }])).toThrow('V4_EVAL_SSE_HISTORY_POST_TERMINAL_EVENT_INVALID')
  })

  test('aborts SSE immediately for a non-terminal user-action state and maps caller cancellation', async () => {
    let abortCount = 0
    await expect(requireTerminalV4SseEvidence(
      'PAUSED',
      Promise.resolve({ error: new Error('stream still open') }),
      () => { abortCount += 1 },
    )).rejects.toThrow('V4_EVAL_SSE_RUN_NOT_TERMINAL:PAUSED')
    expect(abortCount).toBe(1)

    const controller = new AbortController()
    controller.abort()
    await expect(readV4RunEventStream({
      serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
      apiToken: 'evaluation-api-token',
      request: requestForSlideCount(1),
      runId: 'run-sse-1',
      after: 0,
      requestId: 'v4-eval-sse-request-6',
      timeoutMs: 1_000,
      signal: controller.signal,
      fetch: async (_url, init) => {
        expect(init?.signal?.aborted).toBe(true)
        throw new Error('caller aborted')
      },
    })).rejects.toThrow('V4_EVAL_SSE_ABORTED')
  })

  test('rejects a stale completed Run snapshot when SSE proves a different effective terminal event', () => {
    expect(() => assertV4RunStatusMatchesSseTerminal('COMPLETED', 'run.failed'))
      .toThrow('V4_EVAL_RUN_STATUS_SSE_TERMINAL_MISMATCH')
    expect(() => assertV4RunStatusMatchesSseTerminal('COMPLETED', 'run.completed')).not.toThrow()
    expect(() => assertV4RunStatusMatchesSseTerminal('FAILED', 'run.accounting.finalized')).not.toThrow()
  })

  test('rejects an invalid later input before any canary preflight or submission can begin', async () => {
    const inputRoot = await mkdtemp(path.join(tmpdir(), 'ppt-agent-v4-eval-input-'))
    try {
      await Promise.all(V4_EVALUATION_CANARY_PAGE_COUNTS.map(async (slideCount) => {
        const caseDirectory = path.join(inputRoot, String(slideCount), 'case-a')
        await mkdir(caseDirectory, { recursive: true })
        const value = requestForSlideCount(slideCount)
        if (slideCount === 10) value.visualDeckV4!.deckOptions.length = { slideCount: 9 }
        await writeFile(path.join(caseDirectory, 'request.json'), JSON.stringify(value))
      }))

      await expect(loadV4EvaluationInputs({
        inputRoot,
        caseIds: ['case-a'],
        pageCounts: V4_EVALUATION_CANARY_PAGE_COUNTS,
      })).rejects.toThrow('v4 length must match slideCount')
    } finally {
      await rm(inputRoot, { recursive: true, force: true })
    }
  })

  test('proves the released gateway target before the first V4 submission', async () => {
    const order: Array<string | number> = []
    const observed = await runV4EvaluationCanary({
      preflight: () => readV4EvaluationGatewayTarget({
        serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
        apiToken: 'evaluation-api-token',
        request: normalizeEvaluationRequest(request(), 10),
        timeoutMs: 1_000,
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: releasedService.releaseId },
        fetch: async (url, init) => {
          order.push(new URL(url).pathname)
          if (new URL(url).pathname === '/health/ready') return readinessResponse()
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer evaluation-api-token')
          expect(new Headers(init?.headers).get('X-PPT-Agent-Tenant')).toBe('phase5')
          return capabilitiesResponse(gatewayCapabilities())
        },
      }),
      persistPreflight: async () => { order.push('preflight.json') },
      caseIds: ['case-a'],
      runCase: async (slideCount, caseId) => {
        order.push(slideCount)
        return { passed: true, slideCount, caseId }
      },
    })

    expect(order).toEqual(['/health/ready', '/v1/capabilities', 'preflight.json', ...V4_EVALUATION_CANARY_PAGE_COUNTS])
    expect(observed).toMatchObject({
      passed: true,
      target: {
        service: 'ppt-agent',
        release: releasedService,
        runtimeMode: 'GATEWAY',
        textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
        models: { text: 'gpt-5.6-terra', vision: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        imageGeneration: { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true },
      },
    })
  })

  test('keeps each real evaluation idempotency key bounded while isolating fresh batches', () => {
    const caseId = 'c'.repeat(80)
    const first = v4EvaluationIdempotencyKey(10, caseId, 'batch-a')
    const second = v4EvaluationIdempotencyKey(10, caseId, 'batch-b')

    expect(first).toMatch(/^[A-Za-z0-9._:-]+$/)
    expect(first.length).toBeLessThanOrEqual(160)
    expect(second).not.toBe(first)
  })

  test('stops after a create response identifies the wrong page mode or image model', () => {
    const input = normalizeEvaluationRequest(request(), 10)
    expect(() => validateCreatedV4RunIdentity({
      slideCount: 3,
      presentationMode: 'VISUAL_DECK_V4',
      imageModel: input.imageModel,
    }, input, 10)).toThrow('V4_EVAL_CREATED_SLIDE_COUNT_INVALID')
    expect(() => validateCreatedV4RunIdentity({
      slideCount: 10,
      presentationMode: 'SLIDE_IMAGE_V2',
      imageModel: input.imageModel,
    }, input, 10)).toThrow('V4_EVAL_CREATED_PRESENTATION_MODE_INVALID')
    expect(() => validateCreatedV4RunIdentity({
      slideCount: 10,
      presentationMode: 'VISUAL_DECK_V4',
      imageModel: 'other-image-model',
    }, input, 10)).toThrow('V4_EVAL_CREATED_IMAGE_MODEL_INVALID')
  })

  test('blocks every submission when the target is a mock, non-image-task, or wrong release', async () => {
    const requestValue = normalizeEvaluationRequest(request(), 10)
    const failures: Array<Readonly<{ capability: unknown; expectedRelease: { gitSha: string | null; releaseId: string | null }; code: string }>> = [
      {
        capability: createPublicCapabilities(),
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: null },
        code: 'V4_EVAL_RUNTIME_MODE_INVALID',
      },
      {
        capability: (() => {
          const capability = gatewayCapabilities()
          return {
            ...capability,
            visualDeckV4: {
              ...capability.visualDeckV4,
              textGeneration: { protocol: 'UNAVAILABLE', streaming: false },
            },
          }
        })(),
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: null },
        code: 'V4_EVAL_TEXT_PROTOCOL_INVALID',
      },
      {
        capability: {
          ...gatewayCapabilities(),
          visualDeckV4: {
            ...gatewayCapabilities().visualDeckV4,
            imageGeneration: { asynchronous: false, protocol: 'LOCAL_MOCK', validatesActualPixels: true },
          },
        },
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: null },
        code: 'V4_EVAL_IMAGE_PROTOCOL_INVALID',
      },
      {
        capability: gatewayCapabilities(),
        expectedRelease: { gitSha: 'b'.repeat(40), releaseId: null },
        code: 'V4_EVAL_READY_GIT_SHA_MISMATCH',
      },
      {
        capability: (() => {
          const capability = gatewayCapabilities()
          return {
            ...capability,
            visualDeckV4: {
              ...capability.visualDeckV4,
              modelAvailability: {
                ...capability.visualDeckV4.modelAvailability!,
                image: [{
                  ...capability.visualDeckV4.modelAvailability!.image[0]!,
                  state: 'DEGRADED',
                }],
              },
            },
          }
        })(),
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: null },
        code: 'V4_EVAL_IMAGE_MODEL_UNAVAILABLE',
      },
    ]

    for (const failure of failures) {
      let submissions = 0
      await expect(runV4EvaluationCanary({
        preflight: () => readV4EvaluationGatewayTarget({
          serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
          apiToken: 'evaluation-api-token',
          request: requestValue,
          timeoutMs: 1_000,
          expectedRelease: failure.expectedRelease,
          fetch: async (url) => new URL(url).pathname === '/health/ready'
            ? readinessResponse()
            : new Response(JSON.stringify({ schemaVersion: '1', requestId: 'v4-eval-capabilities', data: failure.capability }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        }),
        caseIds: ['case-a'],
        runCase: async (slideCount, caseId) => {
          submissions += 1
          return { passed: true, slideCount, caseId }
        },
      })).rejects.toThrow(failure.code)
      expect(submissions).toBe(0)
    }
  })

  test('stops the canary at the first failed case without submitting later pages', async () => {
    const attempted: Array<string> = []
    const result = await runV4EvaluationCanary({
      preflight: async () => ({
        service: 'ppt-agent',
        release: releasedService,
        runtimeMode: 'GATEWAY',
        textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
        models: { text: 'gpt-5.6-terra', vision: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        imageGeneration: { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true },
      }),
      caseIds: ['case-a', 'case-b'],
      runCase: async (slideCount, caseId) => {
        attempted.push(`${slideCount}/${caseId}`)
        return { passed: false, slideCount, caseId, errorCode: 'V4_EVAL_CASE_FAILED' }
      },
    })

    expect(attempted).toEqual(['1/case-a'])
    expect(result).toEqual({
      target: {
        service: 'ppt-agent',
        release: releasedService,
        runtimeMode: 'GATEWAY',
        textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
        models: { text: 'gpt-5.6-terra', vision: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        imageGeneration: { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true },
      },
      passed: false,
      results: [{ passed: false, slideCount: 1, caseId: 'case-a', errorCode: 'V4_EVAL_CASE_FAILED' }],
    })
  })

  test('does not submit a run when preflight evidence cannot be persisted', async () => {
    let submissions = 0
    await expect(runV4EvaluationCanary({
      preflight: async () => ({
        service: 'ppt-agent',
        release: releasedService,
        runtimeMode: 'GATEWAY',
        textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
        models: { text: 'gpt-5.6-terra', vision: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        imageGeneration: { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true },
      }),
      persistPreflight: async () => { throw new Error('V4_EVAL_PREFLIGHT_PERSIST_FAILED') },
      caseIds: ['case-a'],
      runCase: async (slideCount, caseId) => {
        submissions += 1
        return { passed: true, slideCount, caseId }
      },
    })).rejects.toThrow('V4_EVAL_PREFLIGHT_PERSIST_FAILED')
    expect(submissions).toBe(0)
  })

  test('consumes only the exact delivery authorized by deliveryAvailability', () => {
    const delivery = {
      schemaVersion: '1' as const,
      id: 'run-1:delivery:r0',
      runId: 'run-1',
      revisionRound: 0,
      qualityScore: 90,
      qualityOverride: false,
      disposition: 'FINAL' as const,
      qualityStatus: 'APPROVED' as const,
      openIssueIds: [],
      identity: {
        status: 'VERIFIED' as const,
        slideCount: 2,
        pageNumbers: [1, 2],
        blueprintHash: 'a'.repeat(64),
      },
      qualityPolicyAudit: null,
      qualityOverrideAudit: null,
      preview: {
        artifactId: 'preview-1', name: 'preview.png', mimeType: 'image/png' as const,
        sha256: 'b'.repeat(64), byteLength: 100,
      },
      pptx: {
        artifactId: 'pptx-1', name: 'presentation.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const,
        sha256: 'c'.repeat(64), byteLength: 200,
      },
      createdAt: '2026-08-04T00:00:00.000Z',
    }
    const run = {
      schemaVersion: '1' as const,
      id: 'run-1',
      status: 'COMPLETED',
      version: 8,
      slideCount: 2,
      revisionRound: 0,
      committedBudgetUnits: 2,
      qualityScore: 90,
      qualityOverride: false,
      issues: [],
      deliveryAvailability: {
        state: 'AVAILABLE', deliveryId: delivery.id, disposition: 'FINAL', identityStatus: 'VERIFIED',
      },
      deliveries: [delivery],
    }

    expect(requireAvailableDelivery(run)).toEqual(delivery)
    expect(() => requireAvailableDelivery({
      ...run,
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'ACCOUNTING_PENDING' },
    })).toThrow('DELIVERY_UNAVAILABLE:ACCOUNTING_PENDING')
    expect(() => requireAvailableDelivery({
      ...run,
      deliveryAvailability: { ...run.deliveryAvailability, deliveryId: 'delivery-other' },
    })).toThrow('DELIVERY_PUBLIC_IDENTITY_MISMATCH')
  })

  test('waits for AVAILABLE instead of treating any non-accounting state as downloadable', () => {
    const run = {
      schemaVersion: '1' as const,
      id: 'run-1',
      status: 'COMPLETED',
      version: 8,
      slideCount: 2,
      revisionRound: 0,
      committedBudgetUnits: 2,
      qualityScore: 90,
      qualityOverride: false,
      issues: [],
      deliveries: [],
    }

    expect(deliveryAvailabilityWaitState({
      ...run,
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'ACCOUNTING_PENDING' },
    })).toEqual({ state: 'WAIT', reason: 'ACCOUNTING_PENDING' })
    expect(deliveryAvailabilityWaitState({
      ...run,
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'DELIVERY_CONTRACT_INVALID' },
    })).toEqual({ state: 'WAIT', reason: 'DELIVERY_CONTRACT_INVALID' })
    expect(deliveryAvailabilityWaitState({
      ...run,
      deliveryAvailability: {
        state: 'AVAILABLE', deliveryId: 'run-1:delivery:r0', disposition: 'FINAL', identityStatus: 'VERIFIED',
      },
    })).toEqual({ state: 'AVAILABLE', reason: null })
    expect(deliveryAvailabilityWaitState({
      ...run,
      status: 'FAILED',
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_NOT_COMPLETED' },
    })).toEqual({ state: 'TERMINAL', reason: 'RUN_FAILED' })
  })

  test('executes an already matching V4 request without editing it', () => {
    const input = request()
    const normalized = normalizeEvaluationRequest(input, 10)

    expect(normalized.visualDeckV4?.instruction).toBe(input.visualDeckV4.instruction)
    expect(normalized.slideCount).toBe(10)
    expect(normalized.visualDeckV4?.deckOptions.length).toEqual({ slideCount: 10 })
  })

  test('rejects a page-count mismatch instead of rewriting the original instruction', () => {
    const value = request()
    value.visualDeckV4.instruction = '第12页展示课堂练习，整套原计划为12页。'

    expect(() => normalizeEvaluationRequest(value, 2)).toThrow('V4_EVAL_SLIDE_COUNT_MISMATCH')
    expect(value.visualDeckV4.instruction).toBe('第12页展示课堂练习，整套原计划为12页。')
  })

  test('hashes evaluation request contents and case identities instead of the directory path', () => {
    const first = evaluationInputContentHash([
      { caseId: '01-raw-requirement', bytes: new TextEncoder().encode('{"slideCount":10}') },
    ])
    const changedContent = evaluationInputContentHash([
      { caseId: '01-raw-requirement', bytes: new TextEncoder().encode('{"slideCount":12}') },
    ])
    const changedCase = evaluationInputContentHash([
      { caseId: '02-planned-outline', bytes: new TextEncoder().encode('{"slideCount":10}') },
    ])

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(changedContent).not.toBe(first)
    expect(changedCase).not.toBe(first)
  })

  test('accepts one ordered and unique completed lifecycle', () => {
    const events = completedLifecycleEvents()

    expect(validateLifecycle(events, 'COMPLETED', 0)).toEqual({
      passed: true,
      monotonicSequence: true,
      uniqueEventIds: true,
      missing: [],
      terminalEventCount: 1,
      terminalEventType: 'run.completed',
      terminalLifecycleIsLast: true,
      stageLifecyclePairs: {
        PLANNING: 1, GENERATION: 1, PAGE_REVIEW: 1, REVISION: 0, DECK_REVIEW: 1, DELIVERY: 1,
      },
      stageLifecycleValid: true,
      revisionLifecyclePairs: 0,
      revisionLifecycleValid: true,
      revisionRounds: [],
    })
  })

  test('rejects an orphaned or inconsistent revision lifecycle', () => {
    const base = completedLifecycleEvents().map(({ type, payload }) => ({ type, payload }))
    const withOrphan = [
      ...base.slice(0, 7),
      {
        type: 'revision.started',
        payload: {
          completed: 0, total: 2, pageNumbers: [2, 3], revisionKind: 'DECK_VISUAL', revisionRound: 1,
        },
      },
      ...base.slice(7),
    ].map((event, index) => ({ ...event, eventId: `event-${index + 1}`, sequence: index + 1 }))

    const lifecycle = validateLifecycle(withOrphan, 'COMPLETED', 1)

    expect(lifecycle.passed).toBe(false)
    expect(lifecycle.revisionLifecyclePairs).toBe(0)
    expect(lifecycle.revisionLifecycleValid).toBe(false)
  })

  test('rejects missing lifecycle stages and non-raster PPTX pages', () => {
    const lifecycle = validateLifecycle([
      { eventId: 'event-1', sequence: 2, type: 'planning.started' },
      { eventId: 'event-2', sequence: 1, type: 'run.completed' },
    ], 'COMPLETED', 0)
    const raster = validateRasterPages([
      {
        pageNumber: 1,
        mediaEntry: 'ppt/media/image1.png',
        sha256: 'a'.repeat(64),
        byteLength: 100,
        pictureObjects: 1,
        nativeTextObjects: 1,
        imageXEmu: 0,
        imageYEmu: 0,
        imageWidthEmu: 12_192_000,
        imageHeightEmu: 6_858_000,
        imageWidthPx: 1600,
        imageHeightPx: 900,
        imageRelativeAspectError: 0,
        imageAspectRatioValidated: true,
        slideWidthEmu: 12_192_000,
        slideHeightEmu: 6_858_000,
        fullBleed: true,
      },
    ], 2)

    expect(lifecycle.passed).toBe(false)
    expect(lifecycle.monotonicSequence).toBe(false)
    expect(lifecycle.missing).toContain('planning.completed')
    expect(raster).toEqual({ passed: false, continuous: false, expectedPages: 2, validPages: 0 })
  })

  test('rejects duplicate stage starts and a failed revision inside a completed run', () => {
    const duplicate = completedLifecycleEvents()
    duplicate.splice(1, 0, {
      ...duplicate[0]!,
      eventId: 'event-duplicate-planning',
      sequence: 0,
    })
    const duplicateEvents = duplicate.map((event, index) => ({ ...event, sequence: index + 1 }))
    expect(validateLifecycle(duplicateEvents, 'COMPLETED', 0)).toMatchObject({
      passed: false,
      stageLifecycleValid: false,
    })

    const failedRevision = completedLifecycleEvents()
    const deckStartedIndex = failedRevision.findIndex((event) => event.type === 'deck_review.started')
    const revisionEvents: LifecycleEvent[] = [
      {
        eventId: 'revision-started', sequence: 0, type: 'revision.started',
        payload: {
          stage: 'REVISION', completed: 0, total: 1, pageNumbers: [1],
          revisionKind: 'DECK_VISUAL', revisionRound: 1, reason: 'DECK_REVIEW_REJECTED',
        },
      },
      {
        eventId: 'revision-completed', sequence: 0, type: 'revision.completed',
        payload: {
          stage: 'REVISION', completed: 0, total: 1, pageNumbers: [1],
          revisionKind: 'DECK_VISUAL', revisionRound: 1, reason: 'REVISION_FAILED',
        },
      },
    ]
    failedRevision.splice(deckStartedIndex, 0, ...revisionEvents)
    const failedRevisionEvents = failedRevision.map((event, index) => ({ ...event, sequence: index + 1 }))
    expect(validateLifecycle(failedRevisionEvents, 'COMPLETED', 1)).toMatchObject({
      passed: false,
      stageLifecycleValid: false,
      revisionLifecycleValid: false,
    })
  })

  test('accepts one production-shaped single-page V4 revision through page re-review', () => {
    const stage = (
      type: string,
      completed: number,
      total: number,
      pageNumbers: number[],
      reason: string | null = null,
      revisionRound = 0,
      revisionKind: string | null = null,
    ): LifecycleEvent => ({
      eventId: '', sequence: 0, type,
      payload: { stage: type.split('.')[0]!.toUpperCase(), completed, total, pageNumbers, reason,
        revisionRound, revisionKind },
    })
    const allPages = [1, 2, 3]
    const events: LifecycleEvent[] = [
      stage('planning.started', 0, 1, allPages),
      stage('planning.completed', 1, 1, allPages),
      stage('generation.started', 0, 3, allPages),
      stage('generation.progress', 3, 3, allPages),
      stage('generation.completed', 3, 3, allPages),
      stage('page_review.started', 0, 3, allPages),
      stage('page_review.completed', 3, 3, [2], 'PAGE_REVIEW_REJECTED'),
      stage('revision.started', 0, 1, [2], 'PAGE_REVIEW_REJECTED', 1, 'PAGE_VISUAL'),
      stage('revision.progress', 1, 1, [2], null, 1, 'PAGE_VISUAL'),
      stage('revision.completed', 1, 1, [2], null, 1, 'PAGE_VISUAL'),
      stage('page_review.started', 0, 3, allPages, null, 1),
      stage('page_review.completed', 3, 3, allPages, null, 1),
      stage('deck_review.started', 0, 1, allPages, null, 1),
      stage('deck_review.completed', 1, 1, allPages, null, 1),
      stage('delivery.started', 0, 1, allPages, null, 1),
      stage('delivery.completed', 1, 1, allPages, null, 1),
      { eventId: '', sequence: 0, type: 'run.completed' },
    ].map((event, index) => ({ ...event, eventId: `event-${index + 1}`, sequence: index + 1 }))

    expect(validateLifecycle(events, 'COMPLETED', 1)).toMatchObject({
      passed: true,
      stageLifecyclePairs: {
        PLANNING: 1, GENERATION: 1, PAGE_REVIEW: 2, REVISION: 1, DECK_REVIEW: 1, DELIVERY: 1,
      },
      stageLifecycleValid: true,
      revisionLifecyclePairs: 1,
      revisionLifecycleValid: true,
      revisionRounds: [1],
    })
  })

  test('rejects a V4 revision that skips progress and page re-review', () => {
    const base = completedLifecycleEvents()
    const deckStarted = base.find((event) => event.type === 'deck_review.started')!
    const deckCompletedIndex = base.findIndex((event) => event.type === 'deck_review.completed')
    const deckCompleted = base[deckCompletedIndex]!
    if (!deckCompleted.payload || typeof deckCompleted.payload !== 'object') throw new Error('TEST_DECK_PAYLOAD_MISSING')
    base[deckCompletedIndex] = {
      ...deckCompleted,
      payload: { ...deckCompleted.payload, reason: 'DECK_REVIEW_REJECTED' },
    }
    base.splice(deckCompletedIndex + 1, 0, {
      eventId: 'revision-started', sequence: 0, type: 'revision.started',
      payload: {
        stage: 'REVISION', completed: 0, total: 1, pageNumbers: [1],
        revisionKind: 'DECK_VISUAL', revisionRound: 1, reason: 'DECK_REVIEW_REJECTED',
      },
    }, {
      eventId: 'revision-completed', sequence: 0, type: 'revision.completed',
      payload: {
        stage: 'REVISION', completed: 1, total: 1, pageNumbers: [1],
        revisionKind: 'DECK_VISUAL', revisionRound: 1, reason: null,
      },
    }, {
      ...deckStarted,
      eventId: 'second-deck-started',
      sequence: 0,
      payload: { ...(deckStarted.payload as Record<string, unknown>), revisionRound: 1 },
    }, {
      ...deckCompleted,
      eventId: 'second-deck-completed',
      sequence: 0,
      payload: { ...deckCompleted.payload, revisionRound: 1 },
    })
    const events = base.map((event, index) => ({ ...event, sequence: index + 1 }))

    expect(validateLifecycle(events, 'COMPLETED', 1)).toMatchObject({
      passed: false,
      stageLifecycleValid: false,
      revisionLifecycleValid: false,
    })
  })

  test('uses the presentation slide list and the exact picture relationship', () => {
    const presentationXml = '<p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>'
    const presentationRelations = [
      '<Relationships>',
      '<Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/>',
      '<Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/>',
      '<Relationship Id="rId99" Type="x/slide" Target="slides/slide99.xml"/>',
      '</Relationships>',
    ].join('')
    expect(presentationSlideEntries(presentationXml, presentationRelations)).toEqual([
      { pageNumber: 1, slideEntry: 'ppt/slides/slide2.xml' },
      { pageNumber: 2, slideEntry: 'ppt/slides/slide1.xml' },
    ])

    const slideXml = '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>'
    const slideRelations = [
      '<Relationships>',
      '<Relationship Id="rId1" Type="x/image" Target="../media/unused.png"/>',
      '<Relationship Id="rId2" Type="x/image" Target="../media/actual.png"/>',
      '</Relationships>',
    ].join('')
    expect(referencedSlideImageEntry(slideXml, slideRelations, 1)).toBe('ppt/media/actual.png')

    const pages = Array.from({ length: 11 }, (_, index) => ({
      pageNumber: index + 1,
      mediaEntry: `ppt/media/image-${index + 1}.png`,
      sha256: String(index % 10).repeat(64),
      byteLength: 100,
      pictureObjects: 1,
      nativeTextObjects: 0,
      imageXEmu: 0,
      imageYEmu: 0,
      imageWidthEmu: 12_192_000,
      imageHeightEmu: 6_858_000,
      imageWidthPx: 1600,
      imageHeightPx: 900,
      imageRelativeAspectError: 0,
      imageAspectRatioValidated: true,
      slideWidthEmu: 12_192_000,
      slideHeightEmu: 6_858_000,
      fullBleed: index !== 5,
    }))

    expect(validateRasterPages(pages, 10)).toEqual({
      passed: false, continuous: false, expectedPages: 10, validPages: 10,
    })
  })

  test('records post-package image pixels and rejects a non-normalized final slide image', () => {
    const page = {
      pageNumber: 1,
      mediaEntry: 'ppt/media/image-1.png',
      sha256: 'a'.repeat(64),
      byteLength: 100,
      pictureObjects: 1,
      nativeTextObjects: 0,
      imageXEmu: 0,
      imageYEmu: 0,
      imageWidthEmu: 12_192_000,
      imageHeightEmu: 6_858_000,
      imageWidthPx: 1600,
      imageHeightPx: 900,
      imageRelativeAspectError: 0,
      imageAspectRatioValidated: true,
      slideWidthEmu: 12_192_000,
      slideHeightEmu: 6_858_000,
      fullBleed: true,
    }

    expect(validateRasterPages([page], 1)).toMatchObject({ passed: true, validPages: 1 })
    expect(validateRasterPages([{
      ...page,
      imageWidthPx: 1376,
      imageHeightPx: 768,
      imageRelativeAspectError: 0.0078125,
      imageAspectRatioValidated: false,
    }], 1)).toMatchObject({ passed: false, validPages: 0 })
  })

  test('rejects low scores and open critical or factual issues directly', () => {
    const raster = { passed: true, continuous: true, expectedPages: 10, validPages: 10 }
    const lifecycle = {
      passed: true, monotonicSequence: true, uniqueEventIds: true, missing: [], terminalEventCount: 1,
      terminalEventType: 'run.completed', terminalLifecycleIsLast: true,
      stageLifecyclePairs: {
        PLANNING: 1, GENERATION: 1, PAGE_REVIEW: 1, REVISION: 1, DECK_REVIEW: 1, DELIVERY: 1,
      },
      stageLifecycleValid: true,
      revisionLifecyclePairs: 1, revisionLifecycleValid: true, revisionRounds: [1],
    }
    const baseRun = {
      status: 'COMPLETED', slideCount: 10, qualityScore: 79, qualityOverride: false,
      issues: [] as unknown[],
    }

    expect(validateQualityGate(baseRun, raster, lifecycle, 10)).toMatchObject({
      passed: false, qualityScorePassed: false, blockingOpenIssues: 0,
    })
    expect(validateQualityGate({
      ...baseRun,
      qualityScore: 90,
      issues: [{
        id: 'issue-factual', category: 'FACTUAL_RISK', severity: 'WARNING', summary: '存在事实错误。',
        slideIds: ['run-1:slide:2'], sourceChunkIds: ['chunk-1'], status: 'OPEN', repairDomain: 'KNOWLEDGE',
      }],
    }, raster, lifecycle, 10)).toMatchObject({
      passed: false, qualityScorePassed: true, blockingOpenIssues: 1,
    })
  })

  test('rejects missing revision rounds, missing issues and lifecycle events after completion', () => {
    const events = completedLifecycleEvents()
    events.push({ eventId: 'event-after-completion', sequence: events.length + 1, type: 'delivery.completed' })
    const lifecycle = validateLifecycle(events, 'COMPLETED', 1)
    expect(lifecycle).toMatchObject({
      passed: false,
      terminalLifecycleIsLast: false,
      revisionLifecyclePairs: 0,
      revisionLifecycleValid: false,
      revisionRounds: [],
    })

    const raster = { passed: true, continuous: true, expectedPages: 10, validPages: 10 }
    const otherwiseValidLifecycle = { ...lifecycle, passed: true, terminalLifecycleIsLast: true }
    expect(validateQualityGate({
      status: 'COMPLETED', slideCount: 10, qualityScore: 90, qualityOverride: false,
    }, raster, otherwiseValidLifecycle, 10)).toMatchObject({
      passed: false, issuesPresent: false, issuesValid: false,
    })
  })
})

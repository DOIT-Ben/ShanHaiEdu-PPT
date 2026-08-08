import { describe, expect, test } from 'bun:test'
import JSZip from 'jszip'
import sharp from 'sharp'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { parseProviderBillingCatalog } from '../src/adapters/provider-billing-catalog'
import { FixedClock, MockArtifactPort } from '../src/adapters/mock-ports'
import {
  agentEventHistoryEnvelopeSchema,
  apiErrorSchema,
} from '../src/contracts'
import {
  MediaSubmissionError,
  type ImageGenerationPort,
  type UsageAccountingPort,
  type VisualReviewPort,
} from '../src/core/ports'
import { V4ModelPolicy } from '../src/core/v4-model-policy'
import { providerTechnicalFailure } from '../src/core/technical-recovery'
import { createMockRuntime } from '../src/runtime/mock-runtime'
import { ServiceTokenAuthentication } from '../src/http/service-token-authentication'
import { createRunEnvelopeSchema, runDetailEnvelopeSchema } from '../src/run-detail-contracts'
import { UsageAccountingRequestError, type UsageRunBill } from '../src/usage-accounting-contracts'

const token = 'frameflow-contract-token-0001'
const adminToken = 'frameflow-contract-admin-token-0001'
const host = { tenantId: 'frameflow', externalUserId: 'frameflow-user-1', externalProjectId: 'project-1' }

const frameFlowV4Request = {
  schemaVersion: '1',
  host,
  source: {
    kind: 'TEXT',
    name: '五以内数的分与合.txt',
    text: '把五只小鸟分成两个非空组，记录每一种分法，并检查两组合起来仍然是五只。'.repeat(6),
  },
  slideCount: 2,
  visualDirection: '明亮清晰的儿童课堂信息图',
  imageModel: 'gemini-3-pro-image-preview',
  automationLevel: 'BOUNDED_AUTO',
  budgetUnits: 2,
  maxRevisionRounds: 0,
  presentationMode: 'VISUAL_DECK_V4',
  visualDeckV4: {
    instruction: '制作两页讲解五以内数的分与合的课堂视觉 PPT',
    sourceMode: 'SOURCE_GROUNDED',
    deckOptions: {
      deckType: 'DETAILED_DECK',
      language: 'zh-CN',
      length: { slideCount: 2 },
      aspectRatio: '16:9',
      audience: '幼儿园大班学生',
      focus: '理解 5 的分与合',
    },
  },
} as const

const frameFlowV4Readiness = {
  status: 'PASSED' as const,
  evaluationRelease: 'frameflow-contract-test',
  gatewayContractVersion: 'LOCAL_MOCK',
  structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA' as const,
  evaluatedAt: '2026-01-01T00:00:00.000Z',
  evaluationSuite: 'frameflow-contract-test',
  expiresAt: '9999-12-31T23:59:59.999Z',
}

function frameFlowV4ModelPolicy() {
  return new V4ModelPolicy({
    runtimeMode: 'MOCK',
    models: [
      { model: 'gpt-5.6-terra', roles: ['TEXT', 'VISION'], evaluationEnabled: true, published: true, readiness: frameFlowV4Readiness },
      { model: 'gemini-3-pro-image-preview', roles: ['IMAGE'], evaluationEnabled: true, published: true, readiness: frameFlowV4Readiness },
      { model: 'gpt-image-2', roles: ['IMAGE_EDIT'], evaluationEnabled: true, published: true, readiness: frameFlowV4Readiness },
    ],
  })
}

function createFrameFlowRuntime(input: Parameters<typeof createMockRuntime>[0]) {
  return createMockRuntime({ ...input, v4ModelPolicy: frameFlowV4ModelPolicy() })
}

function request(path: string, init: RequestInit = {}, requestId = 'frameflow-request-1') {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-PPT-Agent-Tenant', host.tenantId)
  headers.set('X-PPT-Agent-User', host.externalUserId)
  headers.set('X-PPT-Agent-Project', host.externalProjectId)
  headers.set('X-Request-ID', requestId)
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

function createRequest(key: string, body: unknown = frameFlowV4Request, requestId = `${key}-request`) {
  return request('/v1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  }, requestId)
}

function adminRequest(path: string, init: RequestInit = {}, requestId = 'frameflow-admin-request-1') {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${adminToken}`)
  headers.set('X-PPT-Agent-Tenant', host.tenantId)
  headers.set('X-PPT-Agent-User', 'frameflow-admin-1')
  headers.set('X-PPT-Agent-Role', 'ADMIN')
  headers.set('X-Request-ID', requestId)
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

function expectContractHeaders(response: Response, requestId: string) {
  expect(response.headers.get('X-PPT-Agent-Contract-Version')).toBe('1')
  expect(response.headers.get('X-Request-ID')).toBe(requestId)
  expect(response.headers.get('Link')).toContain('</openapi/v1.json>; rel="service-desc"')
}

async function expectSseRemainsOpen(
  runtime: ReturnType<typeof createMockRuntime>,
  runId: string,
  after: number,
  expectedEventType: string,
) {
  const controller = new AbortController()
  const response = await runtime.handler(request(
    `/v1/runs/${runId}/events?after=${after}`,
    { signal: controller.signal },
  ))
  const reader = response.body!.getReader()
  const first = await reader.read()
  const text = new TextDecoder().decode(first.value)
  const streamState = await Promise.race([
    reader.read().then((next) => next.done ? 'closed' : 'data'),
    Bun.sleep(25).then(() => 'open'),
  ])
  await reader.cancel()
  controller.abort()

  expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  expect(text).toContain(`event: ${expectedEventType}`)
  expect(streamState).toBe('open')
}

async function advanceToTerminal(runtime: ReturnType<typeof createMockRuntime>, repository: InMemoryAgentRepository, runId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await repository.getRun(runId)
    if (current && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) return current
    await runtime.tick()
  }
  throw new Error('RUN_DID_NOT_REACH_TERMINAL_STATE')
}

async function advanceUntilStatus(
  runtime: ReturnType<typeof createMockRuntime>,
  repository: InMemoryAgentRepository,
  runId: string,
  status: 'COMPLETED' | 'FAILED',
) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const current = await repository.getRun(runId)
    if (current?.status === status) return current
    await runtime.tick()
  }
  throw new Error(`RUN_DID_NOT_REACH_${status}`)
}

class HardPageBlocker implements VisualReviewPort {
  async review(input: Parameters<VisualReviewPort['review']>[0]) {
    const pageNumber = Number(/:slide:(\d+):/.exec(input.idempotencyKey)?.[1])
    if (pageNumber !== 2) {
      return { approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null }
    }
    return {
      approved: false,
      textDetected: false,
      visualScore: 45,
      reasons: ['页面对象数量与教材事实矛盾，阻断课堂使用。'],
      retryInstruction: 'Render exactly five countable objects and preserve the source-grounded relationship.',
      qualityImpact: 'HARD_BLOCKER' as const,
    }
  }
}

class UnknownSubmissionImages implements ImageGenerationPort {
  readonly submissions: Parameters<ImageGenerationPort['submit']>[0][] = []
  readonly lookups: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0][] = []

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]): Promise<never> {
    this.submissions.push(structuredClone(input))
    throw new MediaSubmissionError(
      'PROVIDER_SUBMISSION_UNKNOWN',
      'UNKNOWN',
      'provider submission state is unknown',
      providerTechnicalFailure('PROVIDER_SUBMISSION_UNKNOWN', { disposition: 'RETRYABLE' }),
    )
  }

  async lookupByIdempotency(input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0]) {
    this.lookups.push(structuredClone(input))
    return { state: 'UNKNOWN' as const }
  }

  async inspect(): Promise<never> {
    throw new Error('UNKNOWN_SUBMISSION_MUST_NOT_BE_INSPECTED_WITHOUT_OPERATION_ID')
  }
}

class CountingCompletedImages implements ImageGenerationPort {
  readonly submissions: Parameters<ImageGenerationPort['submit']>[0][] = []
  readonly operations = new Map<string, Readonly<{ operationId: string; artifactId: string }>>()

  constructor(private readonly artifacts: MockArtifactPort) {}

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    this.submissions.push(structuredClone(input))
    const existing = this.operations.get(input.idempotencyKey)
    if (existing) return { operationId: existing.operationId, state: 'COMPLETED' as const }
    const operationId = `counting-image-${this.operations.size + 1}`
    const bytes = await sharp({
      create: { width: 1280, height: 720, channels: 3, background: '#5A8F7B' },
    }).png().toBuffer()
    const artifact = await this.artifacts.put({
      tenantId: input.tenantId,
      runId: input.idempotencyKey.split(':slide:')[0]!,
      name: `${operationId}.png`,
      mimeType: 'image/png',
      bytes,
      idempotencyKey: `${input.idempotencyKey}:counting-artifact`,
    })
    this.operations.set(input.idempotencyKey, { operationId, artifactId: artifact.artifactId })
    return { operationId, state: 'COMPLETED' as const }
  }

  async lookupByIdempotency(input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0]) {
    const operation = this.operations.get(input.idempotencyKey)
    return operation
      ? { state: 'SUBMITTED' as const, operationId: operation.operationId }
      : { state: 'NOT_SUBMITTED' as const }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    const operation = [...this.operations.values()].find((candidate) => candidate.operationId === input.operationId)
    if (!operation) throw new Error('COUNTING_IMAGE_OPERATION_NOT_FOUND')
    return { state: 'COMPLETED' as const, artifactId: operation.artifactId }
  }
}

function settledBill(runId: string): UsageRunBill {
  return {
    pptRunId: runId,
    authorizationReservationId: 'authorization-1',
    accountingMode: 'USAGE_V2',
    status: 'SETTLED',
    authorizationCapMilli: 20_000,
    authorizedModel: 'gemini-3-pro-image-preview',
    authorizedUnits: 2,
    pricingVersion: 'ppt-image-v1',
    unitPriceMilli: 10_000,
    providerSpendSafetyCapOperations: 2,
    generatedOperations: 0,
    chargedOperations: 0,
    notChargedOperations: 0,
    unknownOperations: 0,
    chargeableMilli: 0,
    settledMilli: 0,
    releasedMilli: 20_000,
    providerCosts: [],
    lastEventSequence: 0,
    lastEventAt: null,
    settledAt: '2026-08-04T00:00:00.000Z',
    firstUnknownAt: null,
    reconciliationAttempts: 0,
    nextReconcileAt: null,
    reconciliationDeadlineAt: null,
    reconciliationLastError: null,
  }
}

class AuthorizationCapUsage implements UsageAccountingPort {
  async authorizeOperation() {
    return {
      allowed: false as const,
      stopReason: 'AUTHORIZATION_CAP_REACHED' as const,
      authorizedOperations: 0,
      authorizationCapOperations: 0,
      providerSpendSafetyCapOperations: 2,
    }
  }

  async ingestEvent(input: Parameters<UsageAccountingPort['ingestEvent']>[0]) {
    return { replayed: false, bill: settledBill(input.event.pptRunId) }
  }

  async getRunBill(input: Parameters<UsageAccountingPort['getRunBill']>[0]) {
    return settledBill(input.runId)
  }

  async finalizeRun(input: Parameters<UsageAccountingPort['finalizeRun']>[0]) {
    return settledBill(input.runId)
  }
}

type TerminalFinalizeOutcome = 'REVIEW_REQUIRED' | 'LEGACY_RECONCILIATION' | 'RECONCILING' | 'SETTLED' | 'UNKNOWN' | 'REJECTED'
type ReconcileTimestampFormat = 'MILLISECONDS' | 'SECONDS'

class TerminalFinalizeUsage implements UsageAccountingPort {
  readonly finalizeAttempts: Parameters<UsageAccountingPort['finalizeRun']>[0][] = []
  readonly eventAttempts: Parameters<UsageAccountingPort['ingestEvent']>[0]['event'][] = []

  constructor(
    readonly outcomes: TerminalFinalizeOutcome[],
    private readonly clock: FixedClock,
    private readonly reconcileTimestampFormat: ReconcileTimestampFormat = 'MILLISECONDS',
  ) {}

  async authorizeOperation(input: Parameters<UsageAccountingPort['authorizeOperation']>[0]) {
    return {
      allowed: true as const,
      permitId: `permit-${input.pageNumber}`,
      pricingVersion: 'ppt-image-v1',
      userPriceMilli: 10_000,
    }
  }

  async ingestEvent(input: Parameters<UsageAccountingPort['ingestEvent']>[0]) {
    this.eventAttempts.push(structuredClone(input.event))
    return {
      replayed: false,
      bill: {
        ...settledBill(input.event.pptRunId),
        status: 'ACTIVE' as const,
        lastEventSequence: input.event.sequence,
        settledAt: null,
      },
    }
  }

  async getRunBill(input: Parameters<UsageAccountingPort['getRunBill']>[0]) {
    return { ...settledBill(input.runId), status: 'ACTIVE' as const, settledAt: null }
  }

  async finalizeRun(input: Parameters<UsageAccountingPort['finalizeRun']>[0]) {
    this.finalizeAttempts.push(structuredClone(input))
    const outcome = this.outcomes.shift() ?? 'SETTLED'
    if (outcome === 'REJECTED') {
      throw new UsageAccountingRequestError('PPT_USAGE_FINALIZE_REJECTED', 'REJECTED')
    }
    if (outcome === 'UNKNOWN') {
      throw new UsageAccountingRequestError('HOST_USAGE_V2_FINALIZE_UNKNOWN', 'UNKNOWN')
    }
    const nextReconcileAt = new Date(this.clock.now().getTime() + 1_000).toISOString()
    return {
      ...settledBill(input.runId),
      status: outcome,
      settledAt: outcome === 'SETTLED' ? this.clock.now().toISOString() : null,
      nextReconcileAt: outcome === 'RECONCILING'
        ? this.reconcileTimestampFormat === 'SECONDS'
          ? nextReconcileAt.replace('.000Z', 'Z')
          : nextReconcileAt
        : null,
    }
  }
}

const billingCatalog = parseProviderBillingCatalog(JSON.stringify({
  schemaVersion: '1',
  entries: [{
    model: 'gemini-3-pro-image-preview',
    operationMode: 'TEXT_TO_IMAGE',
    resolution: '1K',
    costBasis: 'FIXED_PER_OPERATION',
    costAmountMicros: 25_000,
    currency: 'USD',
    providerPricingVersion: 'gemini-3-pro-image-preview-v1',
  }],
}))

describe('FrameFlow public V4 contract', () => {
  test('creates, resumes events, completes, enumerates and downloads one real PPTX through HTTP', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const runtime = createFrameFlowRuntime({ repository, artifacts, apiToken: token })

    const invalidRequestId = 'request-invalid-contract'
    const invalid = await runtime.handler(createRequest(
      'frameflow-invalid-contract',
      { ...frameFlowV4Request, schemaVersion: '2' },
      invalidRequestId,
    ))
    expect(invalid.status).toBe(422)
    expectContractHeaders(invalid, invalidRequestId)
    const invalidBody = await invalid.json()
    expect(apiErrorSchema.safeParse(invalidBody).success).toBe(true)
    expect(invalidBody).toMatchObject({
      schemaVersion: '1',
      error: {
        code: 'VALIDATION_ERROR',
        category: 'CONTRACT',
        retryable: false,
        action: 'MODIFY_REQUEST',
        requestId: invalidRequestId,
        runId: null,
      },
    })

    const createRequestId = 'request-create-success'
    const created = await runtime.handler(createRequest('frameflow-create-success', frameFlowV4Request, createRequestId))
    expect(created.status).toBe(201)
    expectContractHeaders(created, createRequestId)
    const createdBody = await created.json() as Record<string, any>
    expect(createRunEnvelopeSchema.safeParse(createdBody).success).toBe(true)
    expect(createdBody).toMatchObject({
      schemaVersion: '1',
      requestId: createRequestId,
      replayed: false,
      data: {
        schemaVersion: '1',
        status: 'PLANNING',
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_NOT_COMPLETED' },
        error: null,
      },
    })
    const runId = createdBody.data.id as string
    const guessedDeliveryId = `${runId}:delivery:r0`

    const prematureRequestId = 'request-premature-download'
    const premature = await runtime.handler(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(guessedDeliveryId)}/content?format=pptx`,
      {},
      prematureRequestId,
    ))
    expect(premature.status).toBe(409)
    expectContractHeaders(premature, prematureRequestId)
    const prematureBody = await premature.json()
    expect(apiErrorSchema.parse(prematureBody)).toEqual(prematureBody)
    expect(prematureBody).toEqual({
      schemaVersion: '1',
      error: {
        code: 'DELIVERY_NOT_AVAILABLE',
        category: 'DELIVERY',
        message: 'delivery is not available',
        retryable: true,
        action: 'WAIT',
        requestId: prematureRequestId,
        runId,
        details: { reason: 'RUN_NOT_COMPLETED' },
      },
    })

    const terminal = await advanceToTerminal(runtime, repository, runId)
    expect(terminal.status).toBe('COMPLETED')

    const detailRequestId = 'request-completed-detail'
    const detailResponse = await runtime.handler(request(`/v1/runs/${runId}`, {}, detailRequestId))
    expectContractHeaders(detailResponse, detailRequestId)
    const detail = await detailResponse.json() as Record<string, any>
    expect(runDetailEnvelopeSchema.safeParse(detail).success).toBe(true)
    expect(detail).toMatchObject({
      schemaVersion: '1',
      requestId: detailRequestId,
      data: {
        schemaVersion: '1',
        id: runId,
        status: 'COMPLETED',
        error: null,
        deliveryAvailability: {
          state: 'AVAILABLE',
          disposition: 'FINAL',
          identityStatus: 'VERIFIED',
        },
      },
    })
    expect(detail.data.deliveries).toHaveLength(1)
    const delivery = detail.data.deliveries[0]
    expect(detail.data.deliveryAvailability.deliveryId).toBe(delivery.id)
    expect(delivery).toMatchObject({
      schemaVersion: '1',
      runId,
      disposition: 'FINAL',
      identity: { status: 'VERIFIED', slideCount: 2, pageNumbers: [1, 2] },
      pptx: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    })

    const historyRequestId = 'request-history'
    const historyResponse = await runtime.handler(request(`/v1/runs/${runId}/events/history?after=0`, {}, historyRequestId))
    expectContractHeaders(historyResponse, historyRequestId)
    const history = await historyResponse.json() as Record<string, any>
    expect(agentEventHistoryEnvelopeSchema.safeParse(history).success).toBe(true)
    expect(history).toMatchObject({ schemaVersion: '1', requestId: historyRequestId })
    expect(history.data.at(-1)).toMatchObject({
      schemaVersion: '1', runId, type: 'run.completed', payload: { requiresUserAction: false, nextAction: null },
    })

    const reconnectAfter = history.data.find((event: Record<string, any>) => event.type === 'generation.started').sequence
    const streamRequestId = 'request-sse-reconnect'
    const streamResponse = await runtime.handler(request(
      `/v1/runs/${runId}/events?after=${reconnectAfter}`,
      {},
      streamRequestId,
    ))
    expectContractHeaders(streamResponse, streamRequestId)
    const streamed = (await streamResponse.text()).split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, any>)
    expect(streamed).toEqual(history.data.filter((event: Record<string, any>) => event.sequence > reconnectAfter))

    const downloadRequestId = 'request-download-pptx'
    const pptxResponse = await runtime.handler(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(delivery.id)}/content?format=pptx`,
      {},
      downloadRequestId,
    ))
    expect(pptxResponse.status).toBe(200)
    expectContractHeaders(pptxResponse, downloadRequestId)
    expect(pptxResponse.headers.get('X-PPT-Agent-Schema-Version')).toBe('1')
    expect(pptxResponse.headers.get('X-PPT-Agent-Delivery-ID')).toBe(delivery.id)
    expect(pptxResponse.headers.get('Content-Type')).toBe(delivery.pptx.mimeType)
    const pptx = new Uint8Array(await pptxResponse.arrayBuffer())
    expect(pptx.length).toBeGreaterThan(10_000)
    expect([...pptx.slice(0, 2)]).toEqual([80, 75])
    const archive = await JSZip.loadAsync(pptx, { checkCRC32: true })
    expect(archive.file('[Content_Types].xml')).not.toBeNull()
    expect(archive.file('ppt/presentation.xml')).not.toBeNull()
    expect(Object.keys(archive.files).filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)))
      .toHaveLength(2)
  })

  test('reports an exhausted hard quality blocker as a recoverable quality result without human approval', async () => {
    const repository = new InMemoryAgentRepository()
    const runtime = createFrameFlowRuntime({
      repository,
      artifacts: new MockArtifactPort(),
      apiToken: token,
      visualReviewer: new HardPageBlocker(),
    })
    const created = await runtime.handler(createRequest('frameflow-create-quality-blocker'))
    const runId = ((await created.json()) as Record<string, any>).data.id as string
    const terminal = await advanceToTerminal(runtime, repository, runId)

    expect(terminal.status).toBe('FAILED')
    const detailRequestId = 'request-quality-failure'
    const response = await runtime.handler(request(`/v1/runs/${runId}`, {}, detailRequestId))
    expectContractHeaders(response, detailRequestId)
    const detail = await response.json()
    expect(runDetailEnvelopeSchema.parse(detail)).toEqual(detail)
    expect(detail).toMatchObject({
      schemaVersion: '1',
      requestId: detailRequestId,
      data: {
        status: 'FAILED',
        qualityDisposition: 'HARD_FAILURE',
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_FAILED' },
        error: {
          code: 'QUALITY_REMEDIATION_EXHAUSTED',
          category: 'QUALITY',
          retryable: false,
          action: 'CONTACT_SUPPORT',
          requestId: null,
          runId,
        },
      },
    })
    const historyRequestId = 'request-quality-failure-history'
    const historyResponse = await runtime.handler(request(
      `/v1/runs/${runId}/events/history`,
      {},
      historyRequestId,
    ))
    expectContractHeaders(historyResponse, historyRequestId)
    const history = agentEventHistoryEnvelopeSchema.parse(await historyResponse.json())
    expect(history.data.some((event) =>
      event.type === 'approval.required' && event.payload.kind === 'HUMAN_REVIEW')).toBe(false)
    expect(history.data.some((event) =>
      event.type === 'phase.changed' && event.payload.to === 'NEEDS_HUMAN')).toBe(false)
    expect(history.data.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: {
        errorCode: 'QUALITY_REMEDIATION_EXHAUSTED',
        reason: 'REVISION_LIMIT_REACHED',
        error: {
          code: 'QUALITY_REMEDIATION_EXHAUSTED',
          category: 'QUALITY',
          retryable: false,
          action: 'CONTACT_SUPPORT',
          requestId: null,
          runId,
        },
      },
    })

    const downloadRequestId = 'request-quality-failure-download'
    const download = await runtime.handler(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(`${runId}:delivery:r0`)}/content?format=pptx`,
      {},
      downloadRequestId,
    ))
    expect(download.status).toBe(409)
    expectContractHeaders(download, downloadRequestId)
    expect(await download.json()).toMatchObject({
      schemaVersion: '1',
      error: {
        code: 'DELIVERY_NOT_AVAILABLE',
        category: 'DELIVERY',
        retryable: false,
        action: 'NONE',
        requestId: downloadRequestId,
        runId,
        details: { reason: 'RUN_FAILED' },
      },
    })
  })

  test('keeps an unknown Provider submission in technical recovery and never re-submits it', async () => {
    const repository = new InMemoryAgentRepository()
    const images = new UnknownSubmissionImages()
    const clock = new FixedClock()
    const runtime = createFrameFlowRuntime({
      repository,
      artifacts: new MockArtifactPort(),
      images,
      clock,
      apiToken: token,
    })
    const created = await runtime.handler(createRequest('frameflow-create-provider-unknown'))
    const runId = ((await created.json()) as Record<string, any>).data.id as string

    await runtime.tick()
    await runtime.tick()
    const submissionsAfterFailure = images.submissions.map((submission) => submission.idempotencyKey)
    expect(submissionsAfterFailure.length).toBeGreaterThan(0)
    expect(new Set(submissionsAfterFailure).size).toBe(submissionsAfterFailure.length)
    expect(await repository.getRun(runId)).toMatchObject({ status: 'RECOVERING' })

    const detailRequestId = 'request-provider-recovery'
    const response = await runtime.handler(request(`/v1/runs/${runId}`, {}, detailRequestId))
    expectContractHeaders(response, detailRequestId)
    const detail = await response.json()
    expect(runDetailEnvelopeSchema.parse(detail)).toEqual(detail)
    expect(detail).toMatchObject({
      schemaVersion: '1',
      requestId: detailRequestId,
      data: {
        status: 'RECOVERING',
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_NOT_COMPLETED' },
        error: {
          code: 'TECHNICAL_RECOVERY_PENDING',
          category: 'PROVIDER',
          retryable: true,
          action: 'WAIT',
          requestId: null,
          runId,
        },
      },
    })

    await runtime.tick()
    clock.advance(60_000)
    await runtime.tick()
    expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual(submissionsAfterFailure)
    expect((await repository.getRun(runId))?.status).not.toBe('NEEDS_HUMAN')
    const historyRequestId = 'request-provider-recovery-history'
    const historyResponse = await runtime.handler(request(
      `/v1/runs/${runId}/events/history`,
      {},
      historyRequestId,
    ))
    expectContractHeaders(historyResponse, historyRequestId)
    const history = agentEventHistoryEnvelopeSchema.parse(await historyResponse.json())
    expect(history.data.some((event) =>
      event.type === 'approval.required' && event.payload.kind === 'HUMAN_REVIEW')).toBe(false)
  })

  test('keeps Usage V2 authorization exhaustion paused with ADD_BUDGET through public history', async () => {
    const repository = new InMemoryAgentRepository()
    const runtime = createFrameFlowRuntime({
      repository,
      artifacts: new MockArtifactPort(),
      apiToken: token,
      defaultAccountingProtocol: 'FRAMEFLOW_USAGE_V2',
      usageAccounting: new AuthorizationCapUsage(),
      providerBillingCatalog: billingCatalog,
    })
    const created = await runtime.handler(createRequest('frameflow-create-usage-cap'))
    const runId = ((await created.json()) as Record<string, any>).data.id as string

    await runtime.tick()
    await runtime.tick()
    expect(await repository.getRun(runId)).toMatchObject({ status: 'PAUSED', resumeState: 'EXECUTING' })

    const detailRequestId = 'request-usage-cap-detail'
    const detail = await runtime.handler(request(`/v1/runs/${runId}`, {}, detailRequestId))
    expectContractHeaders(detail, detailRequestId)
    const detailBody = await detail.json()
    expect(runDetailEnvelopeSchema.parse(detailBody)).toEqual(detailBody)
    expect(detailBody).toMatchObject({
      schemaVersion: '1',
      requestId: detailRequestId,
      data: {
        status: 'PAUSED',
        error: {
          code: 'BUDGET_INSUFFICIENT',
          category: 'USAGE_V2',
          retryable: true,
          action: 'ADD_BUDGET',
          requestId: null,
          runId,
        },
      },
    })

    const historyRequestId = 'request-usage-cap-history'
    const historyResponse = await runtime.handler(request(`/v1/runs/${runId}/events/history`, {}, historyRequestId))
    expectContractHeaders(historyResponse, historyRequestId)
    const history = await historyResponse.json() as Record<string, any>
    expect(agentEventHistoryEnvelopeSchema.safeParse(history).success).toBe(true)
    expect(history).toMatchObject({ schemaVersion: '1', requestId: historyRequestId })
    expect(history.data.find((event: Record<string, any>) => event.type === 'run.paused')).toMatchObject({
      schemaVersion: '1',
      runId,
      payload: {
        reason: 'BUDGET_INSUFFICIENT',
        retryable: true,
        requiresUserAction: true,
        nextAction: 'ADD_BUDGET',
      },
    })
  })

  test('recovers REVIEW_REQUIRED through REINSPECT, UNKNOWN and SETTLED with the original delivery identity', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const images = new CountingCompletedImages(artifacts)
    const clock = new FixedClock()
    const usage = new TerminalFinalizeUsage(['REVIEW_REQUIRED', 'UNKNOWN', 'SETTLED'], clock)
    const runtime = createFrameFlowRuntime({
      repository,
      artifacts,
      images,
      clock,
      apiToken: token,
      authentication: new ServiceTokenAuthentication([{
        tenantId: host.tenantId,
        userToken: token,
        adminToken,
      }]),
      defaultAccountingProtocol: 'FRAMEFLOW_USAGE_V2',
      usageAccounting: usage,
      providerBillingCatalog: billingCatalog,
    })
    const created = await runtime.handler(createRequest('frameflow-create-finalize-review'))
    const runId = ((await created.json()) as Record<string, any>).data.id as string

    await advanceUntilStatus(runtime, repository, runId, 'FAILED')
    const submissionCount = images.submissions.length
    const usageEventCount = usage.eventAttempts.length
    expect(submissionCount).toBe(2)
    expect(new Set(images.submissions.map((submission) => submission.idempotencyKey)).size).toBe(2)
    expect(await repository.listDeliveries(runId)).toHaveLength(1)

    const detailRequestId = 'request-finalize-review-detail'
    const detailResponse = await runtime.handler(request(`/v1/runs/${runId}`, {}, detailRequestId))
    expectContractHeaders(detailResponse, detailRequestId)
    const detail = runDetailEnvelopeSchema.parse(await detailResponse.json())
    expect(detail).toMatchObject({
      data: {
        status: 'FAILED',
        qualityDisposition: 'HARD_FAILURE',
        error: {
          code: 'USAGE_V2_FINALIZATION_REJECTED', category: 'USAGE_V2', retryable: false,
          action: 'CONTACT_SUPPORT', requestId: null, runId,
        },
        deliveries: [],
        deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_FAILED' },
      },
    })

    const historyResponse = await runtime.handler(request(`/v1/runs/${runId}/events/history`))
    const history = agentEventHistoryEnvelopeSchema.parse(await historyResponse.json())
    const completed = history.data.find((event) => event.type === 'run.completed')!
    expect(history.data.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: {
        errorCode: 'USAGE_V2_FINALIZATION_REJECTED',
        error: {
          code: 'USAGE_V2_FINALIZATION_REJECTED', category: 'USAGE_V2', retryable: false,
          action: 'CONTACT_SUPPORT', requestId: null, runId,
        },
      },
    })
    expect(history.data.some((event) => event.type === 'approval.required')).toBe(false)
    expect(history.data.some((event) =>
      event.type === 'phase.changed' && event.payload.to === 'NEEDS_HUMAN')).toBe(false)

    const streamResponse = await runtime.handler(request(`/v1/runs/${runId}/events?after=${completed.sequence}`))
    const streamed = (await streamResponse.text()).split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, any>)
    expect(streamed.some((event) => event.type === 'run.failed')).toBe(true)

    const deliveryId = `${runId}:delivery:r0`
    const download = await runtime.handler(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(deliveryId)}/content?format=pptx`,
    ))
    expect(download.status).toBe(409)
    expect(await download.json()).toMatchObject({
      error: {
        code: 'DELIVERY_NOT_AVAILABLE', retryable: false, action: 'NONE', runId,
        details: { reason: 'RUN_FAILED' },
      },
    })

    const failedRun = (await repository.getRun(runId))!
    const userRetry = await runtime.handler(request(
      `/v1/runs/${runId}/actions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'user-finalize-retry-blocked-1' },
        body: JSON.stringify({ schemaVersion: '1', type: 'RETRY_DELIVERY', expectedVersion: failedRun.version }),
      },
    ))
    expect(userRetry.status).toBe(409)
    expect(await userRetry.json()).toMatchObject({
      error: {
        code: 'QUALITY_FAILURE_RECOVERY_NOT_ALLOWED', retryable: false, action: 'CONTACT_SUPPORT', runId,
      },
    })
    expect(images.submissions).toHaveLength(submissionCount)

    const operationsResponse = await runtime.handler(adminRequest('/v1/admin/operations'))
    expect(operationsResponse.status).toBe(200)
    const operations = await operationsResponse.json() as Record<string, any>
    const finalizeItem = operations.data.reconciliation.find((item: Record<string, any>) =>
      item.runId === runId && item.allowedActions.includes('REINSPECT'))
    expect(finalizeItem).toMatchObject({
      stepKey: `${runId}:usage-v2:finalize`,
      status: 'FAILED',
      errorCode: 'HOST_USAGE_V2_REVIEW_REQUIRED',
      allowedActions: ['REINSPECT'],
    })

    const recoveryRequestId = 'request-finalize-review-recovery'
    const recovery = await runtime.handler(adminRequest(
      `/v1/admin/operations/${runId}/actions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'admin-finalize-reinspect-1' },
        body: JSON.stringify({
          stepId: finalizeItem.stepId,
          action: 'REINSPECT',
          expectedVersion: finalizeItem.runVersion,
          reason: '宿主终态账务问题已修复，重投原 finalize 身份。',
        }),
      },
      recoveryRequestId,
    ))
    expect(recovery.status).toBe(200)
    expectContractHeaders(recovery, recoveryRequestId)
    expect(await recovery.json()).toMatchObject({
      data: {
        run: { status: 'COMPLETED', qualityDisposition: 'REVIEW_PASSED' },
        step: { status: 'RUNNING', errorCode: 'HOST_USAGE_V2_FINALIZE_UNKNOWN' },
      },
      replayed: false,
    })
    expect(usage.finalizeAttempts.map((attempt) => attempt.idempotencyKey))
      .toEqual([`finalize:${runId}`, `finalize:${runId}`])
    expect((await repository.listSteps(runId)).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({
        status: 'RUNNING',
        output: {
          idempotencyKey: `finalize:${runId}`, deliveryState: 'PENDING',
          nextAttemptAt: new Date(clock.now().getTime() + 1_000).toISOString(),
        },
      })
    expect(images.submissions).toHaveLength(submissionCount)
    expect(usage.eventAttempts).toHaveLength(usageEventCount)
    expect(await repository.listDeliveries(runId)).toHaveLength(1)

    const pendingDetail = runDetailEnvelopeSchema.parse(await (await runtime.handler(
      request(`/v1/runs/${runId}`),
    )).json())
    expect(pendingDetail.data).toMatchObject({
      status: 'COMPLETED', error: null,
      deliveries: [],
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'ACCOUNTING_PENDING' },
    })
    const pendingDownload = await runtime.handler(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(deliveryId)}/content?format=pptx`,
    ))
    expect(pendingDownload.status).toBe(409)
    expect(await pendingDownload.json()).toMatchObject({
      error: {
        code: 'DELIVERY_NOT_AVAILABLE', retryable: true, action: 'WAIT', runId,
        details: { reason: 'ACCOUNTING_PENDING' },
      },
    })
    const pendingHistory = agentEventHistoryEnvelopeSchema.parse(await (await runtime.handler(
      request(`/v1/runs/${runId}/events/history`),
    )).json())
    const pendingTail = pendingHistory.data.at(-1)!
    expect(pendingHistory.data.slice(-3).map((event) => event.type))
      .toEqual(['phase.changed', 'run.resumed', 'run.completed'])
    expect(pendingHistory.data.some((event) => event.type === 'approval.required')).toBe(false)
    expect(pendingHistory.data.some((event) =>
      event.type === 'phase.changed' && event.payload.to === 'NEEDS_HUMAN')).toBe(false)
    await expectSseRemainsOpen(runtime, runId, pendingTail.sequence - 1, 'run.completed')

    clock.advance(1_000)
    await runtime.tick()
    expect(usage.finalizeAttempts.map((attempt) => attempt.idempotencyKey))
      .toEqual([`finalize:${runId}`, `finalize:${runId}`, `finalize:${runId}`])
    expect(images.submissions).toHaveLength(submissionCount)
    expect(usage.eventAttempts).toHaveLength(usageEventCount)
    expect(await repository.listDeliveries(runId)).toHaveLength(1)
    const settledDetail = runDetailEnvelopeSchema.parse(await (await runtime.handler(
      request(`/v1/runs/${runId}`),
    )).json())
    expect(settledDetail.data).toMatchObject({
      status: 'COMPLETED', error: null,
      deliveryAvailability: { state: 'AVAILABLE', deliveryId },
    })
    const resumed = pendingHistory.data.find((event) => event.type === 'run.resumed')!
    const settledStream = await runtime.handler(request(`/v1/runs/${runId}/events?after=${resumed.sequence}`))
    const settledStreamEvents = (await settledStream.text()).split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, any>)
    expect(settledStreamEvents.map((event) => event.type)).toEqual(['run.completed'])
  })

  test('fails a completed Usage V2 Run on an explicit terminal finalize rejection without resubmitting media', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const images = new CountingCompletedImages(artifacts)
    const clock = new FixedClock()
    const usage = new TerminalFinalizeUsage(['REJECTED'], clock)
    const runtime = createFrameFlowRuntime({
      repository, artifacts, images, clock, apiToken: token,
      defaultAccountingProtocol: 'FRAMEFLOW_USAGE_V2',
      usageAccounting: usage,
      providerBillingCatalog: billingCatalog,
    })
    const created = await runtime.handler(createRequest('frameflow-create-finalize-rejected'))
    const runId = ((await created.json()) as Record<string, any>).data.id as string

    await advanceUntilStatus(runtime, repository, runId, 'FAILED')
    expect(images.submissions).toHaveLength(2)
    expect(usage.finalizeAttempts.map((attempt) => attempt.idempotencyKey)).toEqual([`finalize:${runId}`])
    expect((await repository.listSteps(runId)).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({ status: 'FAILED', errorCode: 'PPT_USAGE_FINALIZE_REJECTED' })
    const detail = runDetailEnvelopeSchema.parse(await (await runtime.handler(request(`/v1/runs/${runId}`))).json())
    expect(detail.data).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'USAGE_V2_FINALIZATION_REJECTED', category: 'USAGE_V2', retryable: false,
        action: 'CONTACT_SUPPORT', runId,
      },
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_FAILED' },
    })
    expect((await repository.listEvents(runId)).some((event) => event.type === 'approval.required')).toBe(false)
  })

  test.each([
    ['with milliseconds', 'MILLISECONDS'],
    ['without milliseconds', 'SECONDS'],
  ] as const)('keeps RECONCILING %s on a durable retry deadline and settles the same finalize identity', async (
    _label,
    timestampFormat,
  ) => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const images = new CountingCompletedImages(artifacts)
    const clock = new FixedClock()
    const usage = new TerminalFinalizeUsage(['RECONCILING', 'SETTLED'], clock, timestampFormat)
    const runtime = createFrameFlowRuntime({
      repository, artifacts, images, clock, apiToken: token,
      defaultAccountingProtocol: 'FRAMEFLOW_USAGE_V2',
      usageAccounting: usage,
      providerBillingCatalog: billingCatalog,
    })
    const created = await runtime.handler(createRequest('frameflow-create-finalize-reconciling'))
    const runId = ((await created.json()) as Record<string, any>).data.id as string

    for (let attempt = 0; attempt < 15 && usage.finalizeAttempts.length === 0; attempt += 1) {
      await runtime.tick()
    }
    expect(usage.finalizeAttempts).toHaveLength(1)
    const submissionCount = images.submissions.length
    const finalization = (await repository.listSteps(runId)).find((step) => step.tool === 'finalize_usage_v2')!
    const expectedNextAttemptAt = new Date(clock.now().getTime() + 1_000).toISOString()
    expect(finalization).toMatchObject({
      status: 'RUNNING', errorCode: null,
      output: {
        idempotencyKey: `finalize:${runId}`, deliveryState: 'PENDING',
        nextAttemptAt: timestampFormat === 'SECONDS'
          ? expectedNextAttemptAt.replace('.000Z', 'Z')
          : expectedNextAttemptAt,
        bill: { status: 'RECONCILING' },
      },
    })
    const waitingDetail = runDetailEnvelopeSchema.parse(await (await runtime.handler(request(`/v1/runs/${runId}`))).json())
    expect(waitingDetail.data).toMatchObject({
      status: 'COMPLETED', error: null,
      deliveries: [],
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'ACCOUNTING_PENDING' },
    })
    const waitingDownload = await runtime.handler(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(`${runId}:delivery:r0`)}/content?format=pptx`,
    ))
    expect(await waitingDownload.json()).toMatchObject({
      error: { retryable: true, action: 'WAIT', details: { reason: 'ACCOUNTING_PENDING' } },
    })
    const waitingEvents = await repository.listEvents(runId)
    const waitingTail = waitingEvents.at(-1)!
    expect(waitingTail.type).toBe('run.completed')
    await expectSseRemainsOpen(runtime, runId, waitingTail.sequence - 1, 'run.completed')

    clock.advance(1_000)
    await runtime.tick()
    expect(usage.finalizeAttempts.map((attempt) => attempt.idempotencyKey))
      .toEqual([`finalize:${runId}`, `finalize:${runId}`])
    expect(images.submissions).toHaveLength(submissionCount)
    expect((await repository.listSteps(runId)).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({ status: 'COMPLETED', output: { deliveryState: 'ACKNOWLEDGED', bill: { status: 'SETTLED' } } })
    const settledDetail = runDetailEnvelopeSchema.parse(await (await runtime.handler(request(`/v1/runs/${runId}`))).json())
    expect(settledDetail.data).toMatchObject({
      status: 'COMPLETED', error: null,
      deliveryAvailability: { state: 'AVAILABLE', deliveryId: `${runId}:delivery:r0` },
    })
  })
})

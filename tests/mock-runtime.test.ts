import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { CONTRACT_VERSION, agentEventSchema, runSnapshotSchema } from '../src/contracts'
import { runDetailSchema } from '../src/run-detail-contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import type { FrameFlowBackendClient } from '../src/adapters/frameflow-host'
import {
  MockArtifactPort,
  MockDeckReviewPort,
  MockPresentationRendererPort,
  MockRevisionApplicationPort,
  MockRevisionPlanningPort,
  MockVisualReviewPort,
  FixedClock,
} from '../src/adapters/mock-ports'
import {
  StructuredModelError,
  type DeckReviewPort,
  type ImageGenerationPort,
  type RevisionApplicationPort,
  type RevisionPlanningPort,
  type VisualReviewPort,
} from '../src/core/ports'
import { createAgentRuntime, createMockRuntime } from '../src/runtime/mock-runtime'
import { PPT_AGENT_CONTRACT_VERSION, PPT_AGENT_SOFTWARE_VERSION } from '../src/release-identity'
import { validateLifecycle } from '../scripts/run-v4-real-evaluation'
import { getActiveBlueprint } from '../src/core/active-blueprint'
import { hashInput } from '../src/core/hash'
import { parseProviderBillingCatalog } from '../src/adapters/provider-billing-catalog'
import type { UsageAccountingPort } from '../src/core/ports'
import { enqueueUsageV2RunFinalization } from '../src/core/usage-v2-coordinator'
import type { UsageRunBill } from '../src/usage-accounting-contracts'
import { deriveV4TerminalAccounting } from '../src/core/v4-terminal-accounting'
import { v4LifecyclePayload } from '../src/core/v4-lifecycle'
import { deliveryRecordSchema } from '../src/presentation-contracts'
import { providerTechnicalFailure } from '../src/core/technical-recovery'

const token = 'test-runtime-token-0001'

function request(path: string, init: RequestInit = {}, user = 'user-1') {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-PPT-Agent-Tenant', 'frameflow')
  headers.set('X-PPT-Agent-User', user)
  return new Request(`http://127.0.0.1:4310${path}`, { ...init, headers })
}

class CountingCompletedImageGeneration implements ImageGenerationPort {
  readonly submissions: Parameters<ImageGenerationPort['submit']>[0][] = []
  private readonly artifactsByOperation = new Map<string, string>()

  constructor(private readonly artifacts: MockArtifactPort) {}

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    this.submissions.push(structuredClone(input))
    const operationId = `counting-image-${hashInput(input.idempotencyKey).slice(0, 24)}`
    if (!this.artifactsByOperation.has(operationId)) {
      const digest = Buffer.from(hashInput(input.idempotencyKey).slice(0, 6), 'hex')
      const bytes = await sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 3,
          background: { r: digest[0]!, g: digest[1]!, b: digest[2]! },
        },
      }).png().toBuffer()
      const artifact = await this.artifacts.put({
        tenantId: input.tenantId,
        runId: input.idempotencyKey.split(':slide:')[0]!,
        name: `${operationId}.png`,
        mimeType: 'image/png',
        bytes,
        idempotencyKey: `${input.idempotencyKey}:artifact`,
      })
      this.artifactsByOperation.set(operationId, artifact.artifactId)
    }
    return { operationId, state: 'COMPLETED' as const }
  }

  async lookupByIdempotency(input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0]) {
    const operationId = `counting-image-${hashInput(input.idempotencyKey).slice(0, 24)}`
    return this.artifactsByOperation.has(operationId)
      ? { state: 'SUBMITTED' as const, operationId }
      : { state: 'NOT_SUBMITTED' as const }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    const artifactId = this.artifactsByOperation.get(input.operationId)
    return artifactId
      ? { state: 'COMPLETED' as const, artifactId }
      : {
          state: 'FAILED' as const,
          errorCode: 'COUNTING_IMAGE_NOT_FOUND',
          billingState: 'NOT_CHARGED' as const,
          technicalFailure: providerTechnicalFailure('COUNTING_IMAGE_NOT_FOUND'),
        }
  }
}

class CountingFrameFlowBackend implements FrameFlowBackendClient {
  readonly reserveCalls: Parameters<FrameFlowBackendClient['reserveCredits']>[0][] = []
  readonly settleCalls: Parameters<FrameFlowBackendClient['settleCredits']>[0][] = []
  readonly releaseCalls: Parameters<FrameFlowBackendClient['releaseCredits']>[0][] = []
  readonly finalizeCalls: Parameters<FrameFlowBackendClient['finalizeCredits']>[0][] = []

  async getDocumentAttachment(): Promise<never> { throw new Error('COUNTING_BACKEND_TEXT_SOURCE_ONLY') }

  async reserveCredits(input: Parameters<FrameFlowBackendClient['reserveCredits']>[0]) {
    this.reserveCalls.push(structuredClone(input))
    return { reservationId: `counting-budget:${input.idempotencyKey}` }
  }

  async settleCredits(input: Parameters<FrameFlowBackendClient['settleCredits']>[0]) {
    this.settleCalls.push(structuredClone(input))
  }

  async releaseCredits(input: Parameters<FrameFlowBackendClient['releaseCredits']>[0]) {
    this.releaseCalls.push(structuredClone(input))
  }

  async finalizeCredits(input: Parameters<FrameFlowBackendClient['finalizeCredits']>[0]) {
    this.finalizeCalls.push(structuredClone(input))
  }

  async preflightBatchFinalization() {}

  snapshot() {
    return {
      reserve: this.reserveCalls.length,
      settle: this.settleCalls.length,
      release: this.releaseCalls.length,
      finalize: this.finalizeCalls.length,
    }
  }
}

class ScenarioVisualReview implements VisualReviewPort {
  readonly requests: Parameters<VisualReviewPort['review']>[0][] = []

  constructor(
    private readonly rejectedPage: number | null,
    private readonly hardBlocker = false,
  ) {}

  async review(input: Parameters<VisualReviewPort['review']>[0]) {
    this.requests.push(structuredClone(input))
    const pageNumber = Number(/:slide:(\d+):/.exec(input.idempotencyKey)?.[1])
    if (pageNumber === this.rejectedPage) {
      return {
        approved: false,
        textDetected: false,
        visualScore: this.hardBlocker ? 45 : 68,
        reasons: [this.hardBlocker
          ? '页面对象数量与教材事实矛盾，阻断课堂使用。'
          : '页面构图仍有可优化空间，但不影响事实、来源、安全或文件完整性。'],
        retryInstruction: this.hardBlocker
          ? 'Render exactly five countable objects and preserve the source-grounded grouping relationship.'
          : 'Simplify the composition while preserving all approved facts and copy.',
        qualityImpact: this.hardBlocker ? 'HARD_BLOCKER' : 'NON_BLOCKING_RECOMMENDATION',
      }
    }
    return { approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null }
  }
}

class ScenarioDeckReview implements DeckReviewPort {
  readonly evaluations: Parameters<DeckReviewPort['evaluate']>[0][] = []

  constructor(private readonly outcome: 'PASS' | 'NON_BLOCKING_REJECT' | 'HARD_BLOCKER') {}

  async evaluate(input: Parameters<DeckReviewPort['evaluate']>[0]) {
    this.evaluations.push(structuredClone(input))
    const base = {
      curriculumCoverageScore: 92,
      narrativeCoherenceScore: 90,
      visualConsistencyScore: 90,
      compositionScore: 90,
      reviewedSourceChunkIds: input.sourceChunks.map((chunk) => chunk.id),
    }
    if (this.outcome === 'NON_BLOCKING_REJECT') {
      return {
        ...base,
        qualityScore: 72,
        summary: '整套内容和来源完整，但第二页构图仍有一项非阻断改进建议。',
        issues: [{
          id: 'deck-composition-recommendation',
          category: 'COMPOSITION_CONFLICT',
          severity: 'WARNING',
          summary: '第二页主体间距可进一步优化。',
          slideIds: [input.slides[1]!.slideId],
          sourceChunkIds: [],
          status: 'OPEN',
          repairDomain: 'LAYOUT',
        }],
      }
    }
    if (this.outcome === 'HARD_BLOCKER') {
      return {
        ...base,
        qualityScore: 88,
        summary: '第二页存在事实错误，必须阻断交付。',
        issues: [{
          id: 'deck-factual-hard-blocker',
          category: 'FACTUAL_RISK',
          severity: 'WARNING',
          summary: '第二页陈述与教材事实不一致。',
          slideIds: [input.slides[1]!.slideId],
          sourceChunkIds: [input.sourceChunks[0]!.id],
          status: 'OPEN',
          repairDomain: 'KNOWLEDGE',
        }],
      }
    }
    return {
      ...base,
      qualityScore: 90,
      summary: '整套审查通过，事实、来源、视觉和文件交付条件均满足。',
      issues: [],
    }
  }
}

type QualityPolicyScenario = Readonly<{
  id: string
  rejectedPage: number | null
  deckOutcome: 'PASS' | 'NON_BLOCKING_REJECT' | 'HARD_BLOCKER'
  hardPageBlocker?: boolean
}>

async function runQualityPolicyScenario(scenario: QualityPolicyScenario) {
  const repository = new InMemoryAgentRepository()
  const artifacts = new MockArtifactPort()
  const images = new CountingCompletedImageGeneration(artifacts)
  const frameFlowBackend = new CountingFrameFlowBackend()
  const visualReviewer = new ScenarioVisualReview(scenario.rejectedPage, scenario.hardPageBlocker)
  const deckReviewer = new ScenarioDeckReview(scenario.deckOutcome)
  const runtimeInput = {
    repository,
    artifacts,
    images,
    frameFlowBackend,
    visualReviewer,
    deckReviewer,
    apiToken: token,
  }
  const runtime = createMockRuntime(runtimeInput)
  const created = await runtime.handler(request('/v1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `quality-policy-${scenario.id}` },
    body: JSON.stringify({
      schemaVersion: '1',
      host: { tenantId: 'frameflow', externalUserId: 'user-1' },
      source: {
        kind: 'TEXT',
        name: '五以内数的分与合.txt',
        text: '把五只小鸟分成两个非空组，记录每一种分法，并检查两组合起来仍然是五只。'.repeat(6),
      },
      slideCount: 2,
      visualDirection: '明亮清晰的儿童课堂信息图',
      imageModel: 'local-mock-image',
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
    }),
  }))
  expect(created.status).toBe(201)
  const runId = (await created.json() as { data: { id: string } }).data.id

  await runtime.tick()
  expect((await repository.listSteps(runId))
    .filter((step) => ['compile_v4_creative_manuscript', 'review_v4_manuscript'].includes(step.tool))
    .map((step) => ({ tool: step.tool, status: step.status }))).toEqual([
      { tool: 'compile_v4_creative_manuscript', status: 'COMPLETED' },
      { tool: 'review_v4_manuscript', status: 'COMPLETED' },
    ])
  await runtime.tick()
  expect(await repository.getRun(runId)).toMatchObject({
    status: 'PAGE_REVIEW',
    committedBudgetUnits: 2,
    maxRevisionRounds: 0,
  })
  expect(images.submissions).toHaveLength(2)
  const billingAfterGeneration = frameFlowBackend.snapshot()
  expect(Object.values(billingAfterGeneration).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0)

  const observedStatuses: string[] = ['PAGE_REVIEW']
  let publicQualityAtDeckReview: unknown = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await runtime.tick()
    const current = await repository.getRun(runId)
    if (!current) throw new Error('SCENARIO_RUN_NOT_FOUND')
    observedStatuses.push(current.status)
    if (current.status === 'DECK_REVIEW') {
      const detail = await runtime.handler(request(`/v1/runs/${runId}`))
      publicQualityAtDeckReview = (await detail.json() as { data: {
        qualityDisposition: string
        qualityPolicyAudit: unknown
      } }).data
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) break
  }

  return {
    repository,
    artifacts,
    images,
    frameFlowBackend,
    visualReviewer,
    deckReviewer,
    runtime,
    runId,
    observedStatuses,
    publicQualityAtDeckReview,
    billingAfterGeneration,
  }
}

async function assertReadableFinalDelivery(
  scenario: Awaited<ReturnType<typeof runQualityPolicyScenario>>,
  expectedSlideCount: number,
) {
  const detailResponse = await scenario.runtime.handler(request(`/v1/runs/${scenario.runId}`))
  expect(detailResponse.status).toBe(200)
  const detail = await detailResponse.json() as { data: {
    qualityDisposition: string
    deliveries: Array<{
      id: string
      disposition: string
      qualityStatus: string
      qualityOverrideAudit?: unknown
      qualityPolicyAudit?: {
        provenance: string
        policyId: string
        reason: string
        issueIds: string[]
        acceptedAt: string
      } | null
      identity: { status: string; slideCount?: number; pageNumbers?: number[] }
    }>
  } }
  expect(detail.data.qualityDisposition).toBe('SYSTEM_POLICY_ACCEPTED')
  expect(detail.data.deliveries).toHaveLength(1)
  const delivery = detail.data.deliveries[0]!
  expect(delivery).toMatchObject({
    disposition: 'FINAL',
    qualityStatus: 'SYSTEM_POLICY_ACCEPTED',
    qualityOverrideAudit: null,
    qualityPolicyAudit: {
      provenance: 'SYSTEM_POLICY',
      policyId: 'v4-non-blocking-quality-v1',
    },
    identity: {
      status: 'VERIFIED',
      slideCount: expectedSlideCount,
      pageNumbers: Array.from({ length: expectedSlideCount }, (_, index) => index + 1),
    },
  })
  expect(delivery.qualityPolicyAudit?.reason.length).toBeGreaterThan(10)
  expect(delivery.qualityPolicyAudit?.issueIds.length).toBeGreaterThan(0)

  const contentPath = `/v1/runs/${scenario.runId}/deliveries/${encodeURIComponent(delivery.id)}/content`
  const previewResponse = await scenario.runtime.handler(request(`${contentPath}?format=preview`))
  expect(previewResponse.status).toBe(200)
  expect(previewResponse.headers.get('Content-Type')).toContain('image/png')
  const previewBytes = new Uint8Array(await previewResponse.arrayBuffer())
  expect([...previewBytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

  const pptxResponse = await scenario.runtime.handler(request(`${contentPath}?format=pptx`))
  expect(pptxResponse.status).toBe(200)
  expect(pptxResponse.headers.get('Content-Type')).toContain('presentationml.presentation')
  const pptxBytes = new Uint8Array(await pptxResponse.arrayBuffer())
  expect(pptxBytes.length).toBeGreaterThan(10_000)
  expect([...pptxBytes.slice(0, 2)]).toEqual([80, 75])

  const directory = await mkdtemp(join(tmpdir(), `ppt-agent-${scenario.runId}-`))
  try {
    const path = join(directory, 'delivery.pptx')
    await writeFile(path, pptxBytes)
    const validation = Bun.spawn(['unzip', '-t', path], { stdout: 'pipe', stderr: 'pipe' })
    await Promise.all([new Response(validation.stdout).text(), new Response(validation.stderr).text()])
    expect(await validation.exited).toBe(0)
    const listing = Bun.spawn(['unzip', '-Z1', path], { stdout: 'pipe', stderr: 'pipe' })
    const [entries, listingError, listingExit] = await Promise.all([
      new Response(listing.stdout).text(),
      new Response(listing.stderr).text(),
      listing.exited,
    ])
    expect(listingError).toBe('')
    expect(listingExit).toBe(0)
    expect(entries.split('\n').filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)))
      .toHaveLength(expectedSlideCount)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('mock runtime', () => {
  test('recovers a terminal Usage V2 finalization through the worker after restart', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock()
    const finalizeCalls: Parameters<UsageAccountingPort['finalizeRun']>[0][] = []
    const bill: UsageRunBill = {
      pptRunId: 'usage-v2-terminal-run', authorizationReservationId: 'authorization-1',
      accountingMode: 'USAGE_V2', status: 'SETTLED', authorizationCapMilli: 300_000,
      authorizedModel: 'gpt-image-2', authorizedUnits: 30, pricingVersion: 'ppt-image-v1',
      unitPriceMilli: 10_000, providerSpendSafetyCapOperations: 30, generatedOperations: 1,
      chargedOperations: 1, notChargedOperations: 0, unknownOperations: 0, chargeableMilli: 10_000,
      settledMilli: 10_000, releasedMilli: 290_000, providerCosts: [], lastEventSequence: 1,
      lastEventAt: '2026-07-21T00:00:00.000Z', settledAt: '2026-07-21T00:00:00.000Z',
      firstUnknownAt: null, reconciliationAttempts: 0, nextReconcileAt: null,
      reconciliationDeadlineAt: null, reconciliationLastError: null,
    }
    const usage: UsageAccountingPort = {
      async authorizeOperation() {
        return { allowed: true, permitId: 'permit-1', pricingVersion: 'ppt-image-v1', userPriceMilli: 10_000 }
      },
      async ingestEvent() { return { replayed: false, bill } },
      async getRunBill() { return bill },
      async finalizeRun(input) { finalizeCalls.push(structuredClone(input)); return bill },
    }
    await repository.createRun({
      id: 'usage-v2-terminal-run', creationKey: 'usage-v2-terminal-create', requestHash: 'usage-v2-terminal-hash',
      host: { tenantId: 'frameflow', externalUserId: 'user-1' },
      source: { kind: 'TEXT', text: '这是用于终态 Usage V2 worker 恢复的完整教材内容。' },
      slideCount: 2, visualDirection: '课堂信息图', imageModel: 'local-mock-image',
      accountingProtocol: 'FRAMEFLOW_USAGE_V2', automationLevel: 'BOUNDED_AUTO', presentationMode: 'VISUAL_DECK_V4',
      maxRevisionRounds: 2, revisionRound: 0, qualityScore: null, status: 'CANCELLED', resumeState: null,
      version: 1, budgetUnits: 30, committedBudgetUnits: 0, qualityOverride: false,
      qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null, leaseUntil: null, leaseVersion: 0,
      createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
    })
    await repository.transact('usage-v2-terminal-run', (transaction) => {
      enqueueUsageV2RunFinalization(transaction, clock)
    })
    const runtime = createMockRuntime({
      repository, artifacts, apiToken: token, clock,
      defaultAccountingProtocol: 'FRAMEFLOW_USAGE_V2',
      usageAccounting: usage,
      providerBillingCatalog: parseProviderBillingCatalog(JSON.stringify({ schemaVersion: '1', entries: [{
        model: 'gpt-image-2', operationMode: 'TEXT_TO_IMAGE', resolution: '1K', costBasis: 'FIXED_PER_OPERATION',
        costAmountMicros: 40_000, currency: 'USD', providerPricingVersion: 'gpt-image-2-2026-08',
      }] })),
    })

    await runtime.tick()

    expect(finalizeCalls).toEqual([expect.objectContaining({
      runId: 'usage-v2-terminal-run', idempotencyKey: 'finalize:usage-v2-terminal-run',
    })])
    expect((await repository.listSteps('usage-v2-terminal-run')).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({ status: 'COMPLETED', output: { bill: { status: 'SETTLED' } } })
  })

  test('forwards structured-model metrics for the bounded chain-4 slot completion without raw content', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock()
    let metricsTaken = 0
    const model = {
      modelName: 'gpt-5.6-terra',
      async preflightStructuredGeneration() {
        return { protocol: 'RESPONSES_JSON_SCHEMA' as const }
      },
      async execute() {
        throw new StructuredModelError('MODEL_JSON_INVALID', true, 'gpt-5.6-terra', 'request-runtime-metrics', 200)
      },
      takeExecutionMetrics() {
        metricsTaken += 1
        return {
          outcome: 'FAILED' as const,
          errorCode: 'MODEL_JSON_INVALID',
          requestId: 'request-runtime-metrics',
          status: 200,
          responseAccepted: true,
          sseEventCount: 4_219,
          lastActivityAt: '2026-08-03T00:00:01.000Z',
          durationMs: 12_345,
          inputTokens: 17_996,
          outputTokens: 4_781,
          totalTokens: 22_777,
        }
      },
    }
    const runtime = createAgentRuntime({
      repository,
      artifacts,
      apiToken: token,
      clock,
      model,
      visualReviewer: new MockVisualReviewPort({}),
      deckReviewer: new MockDeckReviewPort({}),
      revisionPlanner: new MockRevisionPlanningPort({}),
      revisionApplication: new MockRevisionApplicationPort({}),
    })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-v4-metrics-0001' },
      body: JSON.stringify({
        schemaVersion: '1',
        host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: {
          kind: 'TEXT', name: '分与合教材.txt', roleHint: 'CONTENT_SOURCE',
          text: '把五个圆片分成两个非空部分，可以分成一和四，也可以分成二和三。'.repeat(4),
        },
        slideCount: 2,
        visualDirection: '清晰活泼的儿童课堂信息图',
        imageModel: 'local-mock-image',
        automationLevel: 'BOUNDED_AUTO',
        budgetUnits: 2,
        maxRevisionRounds: 2,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: {
          instruction: '为一年级学生制作五以内数的分与合视觉演示',
          sourceMode: 'SOURCE_GROUNDED',
          deckOptions: {
            deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 }, aspectRatio: '16:9',
            audience: '小学一年级学生', focus: '五以内数的分与合',
          },
        },
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id

    await runtime.tick()

    const audit = (await repository.listSteps(runId)).find((step) =>
      step.tool === 'audit_v4_planning_stage' && step.idempotencyKey.includes(':v4:creative-manuscript:'))
    expect(metricsTaken).toBe(2)
    expect(audit).toMatchObject({
      output: {
        attempts: Array.from({ length: 2 }, () => expect.objectContaining({
          outcome: 'FAILED', requestId: 'request-runtime-metrics', status: 200, responseAccepted: true,
          sseEventCount: 4_219, lastActivityAt: '2026-08-03T00:00:01.000Z', durationMs: 12_345,
          inputTokens: 17_996, outputTokens: 4_781, totalTokens: 22_777,
        })),
      },
    })
    const serialized = JSON.stringify(audit?.output)
    for (const forbidden of ['prompt', 'source text', 'rawResponse', 'credential']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test('recovers a V4 source-port outage through the worker without creating a new Run', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock()
    let sourceAttempts = 0
    const backend: FrameFlowBackendClient = {
      async getDocumentAttachment() {
        sourceAttempts += 1
        if (sourceAttempts === 1) throw new Error('NETWORK_TIMEOUT')
        return {
          name: '分数教材.txt',
          text: '把一个蛋糕平均分成两份，其中一份就是这个蛋糕的二分之一。判断分数前必须先判断是否平均分。'.repeat(4),
        }
      },
      async reserveCredits(input) { return { reservationId: `budget:${input.idempotencyKey}` } },
      async settleCredits() {},
      async releaseCredits() {},
      async finalizeCredits() {},
      async preflightBatchFinalization() {},
    }
    const runtime = createMockRuntime({ repository, artifacts, apiToken: token, clock, frameFlowBackend: backend })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-source-recovery-v4' },
      body: JSON.stringify({
        schemaVersion: '1',
        host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: { kind: 'HOST_ATTACHMENT', attachmentId: 'lesson-source-1', roleHint: 'CONTENT_SOURCE' },
        slideCount: 1,
        visualDirection: '温暖、清晰、有故事感的小学课堂绘本视觉',
        imageModel: 'local-mock-image',
        automationLevel: 'BOUNDED_AUTO',
        budgetUnits: 1,
        maxRevisionRounds: 2,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: {
          instruction: '制作一套让三年级学生理解平均分和二分之一的完整视觉演示',
          sourceMode: 'SOURCE_GROUNDED',
          deckOptions: {
            deckType: 'PRESENTER_SLIDES', language: 'zh-CN', length: { slideCount: 1 }, aspectRatio: '16:9',
            audience: '小学三年级学生', focus: '平均分与二分之一', styleHint: '温暖的儿童绘本课堂视觉',
          },
        },
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id

    await runtime.tick()
    expect(await repository.getRun(runId)).toMatchObject({
      status: 'RECOVERING', technicalRecovery: { resumeState: 'PLANNING', reason: 'NETWORK_TIMEOUT', attempt: 1 },
    })
    expect((await repository.listEvents(runId)).some((event) => event.type === 'approval.required')).toBe(false)

    clock.advance(2_000)
    await runtime.tick()
    expect(await repository.getRun(runId)).toMatchObject({ status: 'PLANNING' })
    await runtime.tick()

    expect(await repository.getRun(runId)).toMatchObject({ status: 'EXECUTING' })
    expect(sourceAttempts).toBe(2)
    expect((await repository.listSteps(runId)).filter((step) => step.tool === 'resolve_source'))
      .toEqual([expect.objectContaining({ status: 'COMPLETED', errorCode: null })])
  })

  test('claims a due recovering run and restores its phase before the next worker tick', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock()
    const runtime = createMockRuntime({ repository, artifacts, apiToken: token, clock })
    await repository.createRun({
      id: 'recovery-runtime-run',
      creationKey: 'recovery-runtime-create',
      requestHash: 'recovery-runtime-hash',
      host: { tenantId: 'frameflow', externalUserId: 'user-1' },
      source: { kind: 'TEXT', text: '用于验证恢复 worker 的完整教材内容。' },
      slideCount: 2,
      visualDirection: '清晰课堂信息图',
      imageModel: 'local-mock-image',
      automationLevel: 'BOUNDED_AUTO',
      maxRevisionRounds: 2,
      revisionRound: 0,
      qualityScore: null,
      status: 'RECOVERING',
      resumeState: null,
      technicalRecovery: {
        resumeState: 'EXECUTING', reason: 'PROVIDER_TIMEOUT', retryable: true,
        attempt: 1, maxAttempts: 5, nextAttemptAt: '2026-07-21T00:00:00.000Z', active: true,
      },
      version: 3,
      budgetUnits: 2,
      committedBudgetUnits: 0,
      qualityOverride: false,
      qualityOverrideReason: null,
      qualityOverrideBy: null,
      leaseToken: null,
      leaseUntil: null,
      leaseVersion: 0,
      presentationMode: 'VISUAL_DECK_V4',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    })
    await repository.transact('recovery-runtime-run', (transaction) => {
      transaction.putStep({
        id: 'recovery-image-step', runId: transaction.run.id,
        idempotencyKey: 'recovery-runtime-run:slide:1:image:r0:v1', inputHash: 'recovery-image-input',
        tool: 'generate_slide_image', status: 'FAILED', budgetUnits: 1, budgetReservationId: null,
        externalOperationId: null, errorCode: 'PROVIDER_TIMEOUT', output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    await runtime.tick()

    expect(await repository.getRun('recovery-runtime-run')).toMatchObject({
      status: 'EXECUTING',
      technicalRecovery: { active: false, nextAttemptAt: null },
    })
    expect((await repository.listSteps('recovery-runtime-run')).at(0)).toMatchObject({
      idempotencyKey: 'recovery-runtime-run:slide:1:image:r0:v1',
    })
  })

  test('rejects an image concurrency value outside the gateway batch limit', () => {
    expect(() => createMockRuntime({
      repository: new InMemoryAgentRepository(), artifacts: new MockArtifactPort(), apiToken: token, imageConcurrency: 51,
    })).toThrow('IMAGE_CONCURRENCY_INVALID')
  })

  test('keeps the default Mock capability list and V4 creation policy aligned', async () => {
    const runtime = createMockRuntime({
      repository: new InMemoryAgentRepository(), artifacts: new MockArtifactPort(), apiToken: token,
    })
    const capabilities = await runtime.handler(request('/v1/capabilities'))
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toMatchObject({
      data: { visualDeckV4: { models: { image: ['local-mock-image'] } } },
    })
    const body = {
      schemaVersion: '1', host: { tenantId: 'frameflow', externalUserId: 'user-1' },
      source: { kind: 'TEXT', text: '用于校验 Mock 模型白名单的一段完整教材内容。' },
      slideCount: 1, visualDirection: '清晰的课堂信息图', imageModel: 'local-mock-image',
      automationLevel: 'BOUNDED_AUTO', budgetUnits: 1, maxRevisionRounds: 0,
      presentationMode: 'VISUAL_DECK_V4',
      visualDeckV4: {
        instruction: '用一页说明教材的核心结论', sourceMode: 'SOURCE_GROUNDED',
        deckOptions: { length: { slideCount: 1 }, aspectRatio: '16:9' },
      },
    }
    const rejected = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-policy-rejected-image-0001' },
      body: JSON.stringify({ ...body, imageModel: 'gpt-image-2' }),
    }))
    const accepted = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-policy-allowed-image-0001' },
      body: JSON.stringify(body),
    }))

    expect(rejected.status).toBe(422)
    expect((await rejected.json() as { error: { code: string } }).error.code).toBe('V4_IMAGE_MODEL_NOT_ALLOWED')
    expect(accepted.status).toBe(201)
  })

  test('delivers a notebooklm-style v4 pptx through chain-4 semantic manuscripts', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const runtime = createMockRuntime({ repository, artifacts, apiToken: token })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-create-v4-chain-0001' },
      body: JSON.stringify({
        schemaVersion: '1',
        host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: {
          kind: 'TEXT', name: '分数教材.txt', roleHint: 'CONTENT_SOURCE',
          text: '把一个蛋糕平均分成两份，其中一份就是这个蛋糕的二分之一。判断分数前必须先判断是否平均分。'.repeat(4),
        },
        slideCount: 3,
        visualDirection: '温暖、清晰、有故事感的小学课堂绘本视觉',
        imageModel: 'local-mock-image',
        automationLevel: 'SUPERVISED',
        budgetUnits: 3,
        maxRevisionRounds: 2,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: {
          instruction: '制作一套让三年级学生理解平均分和二分之一的完整视觉演示',
          sourceMode: 'SOURCE_GROUNDED',
          deckOptions: {
            deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 3 }, aspectRatio: '16:9',
            audience: '小学三年级学生', focus: '平均分与二分之一', styleHint: '温暖的儿童绘本课堂视觉',
          },
        },
      }),
    }))
    expect(created.status).toBe(201)
    const createdPayload = await created.json() as { data: {
      schemaVersion: string
      id: string
      release: {
        softwareVersion: string
        presentationMode: string
        compilerVersion: string
        contractVersion: string
        gitSha: string
        releaseId: string
      }
    } }
    const runId = createdPayload.data.id
    expect(runDetailSchema.parse(createdPayload.data)).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      id: runId,
      status: 'PLANNING',
      presentationMode: 'VISUAL_DECK_V4',
    })
    expect(createdPayload.data.release).toEqual({
      softwareVersion: PPT_AGENT_SOFTWARE_VERSION,
      presentationMode: 'VISUAL_DECK_V4',
      compilerVersion: 'visual-deck-v4-chain-4',
      contractVersion: PPT_AGENT_CONTRACT_VERSION,
      gitSha: 'development',
      releaseId: 'development',
    })
    const liveness = await runtime.handler(new Request('http://127.0.0.1:4310/health/live'))
    expect(await liveness.json()).toMatchObject({
      version: PPT_AGENT_SOFTWARE_VERSION,
      release: { softwareVersion: PPT_AGENT_SOFTWARE_VERSION, contractVersion: PPT_AGENT_CONTRACT_VERSION },
    })

    await runtime.tick()
    const plannedResponse = await runtime.handler(request(`/v1/runs/${runId}`))
    const planned = await plannedResponse.json() as { data: {
      status: string
      version: number
      release: { softwareVersion: string; presentationMode: string; contractVersion: string }
      blueprint?: { slides: unknown[] }
      generationPlan?: { title: string; slideCount: number; pages: unknown[]; output: { editable: boolean } }
      deliveryAvailability?: unknown
    } }
    expect(planned.data.status).toBe('EXECUTING')
    expect(runDetailSchema.parse(planned.data)).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      id: runId,
      status: 'EXECUTING',
    })
    expect(planned.data.deliveryAvailability).toEqual({
      state: 'UNAVAILABLE', reason: 'RUN_NOT_COMPLETED',
    })
    expect(planned.data.release).toMatchObject({
      softwareVersion: PPT_AGENT_SOFTWARE_VERSION,
      presentationMode: 'VISUAL_DECK_V4',
      contractVersion: PPT_AGENT_CONTRACT_VERSION,
    })
    expect(planned.data.blueprint?.slides).toHaveLength(3)
    expect(JSON.stringify(planned.data.blueprint)).not.toContain('visualPrompt')
    expect(planned.data.generationPlan).toMatchObject({ slideCount: 3, output: { editable: false } })
    expect(planned.data.generationPlan?.pages).toHaveLength(3)
    const prematureDeliveryId = `${runId}:delivery:r0`
    const prematureDownload = await runtime.handler(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(prematureDeliveryId)}/content?format=pptx`,
    ))
    expect(prematureDownload.status).toBe(409)
    expect(await prematureDownload.json()).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      error: { code: 'DELIVERY_NOT_AVAILABLE', details: { reason: 'RUN_NOT_COMPLETED' } },
    })
    const manuscriptSteps = await repository.listSteps(runId)
    const creativeManuscript = manuscriptSteps.find((step) => step.tool === 'compile_v4_creative_manuscript')
    const reviewManuscript = manuscriptSteps.find((step) => step.tool === 'review_v4_manuscript')
    expect(creativeManuscript).toMatchObject({ status: 'COMPLETED' })
    expect(reviewManuscript).toMatchObject({ status: 'COMPLETED' })
    expect(creativeManuscript?.output).not.toHaveProperty('slides.0.pageNumber')
    expect(reviewManuscript?.output).not.toHaveProperty('slides.0.sourceChunkId')

    for (let index = 0; index < 4; index += 1) await runtime.tick()

    const completedRun = (await repository.getRun(runId))!
    expect(completedRun).toMatchObject({
      status: 'COMPLETED', presentationMode: 'VISUAL_DECK_V4', committedBudgetUnits: 0, qualityScore: 90,
      qualityDisposition: 'REVIEW_PASSED',
    })
    const events = await repository.listEvents(runId)
    expect(validateLifecycle(events, completedRun.status, completedRun.revisionRound)).toMatchObject({
      passed: true,
      stageLifecycleValid: true,
      revisionLifecycleValid: true,
    })
    const lifecycleTypes = events
      .filter((event) => ['planning.started', 'planning.completed', 'generation.started', 'generation.progress',
        'generation.completed', 'page_review.started', 'page_review.completed', 'deck_review.started',
        'deck_review.completed', 'delivery.started', 'delivery.completed'].includes(event.type))
      .map((event) => event.type)
    expect(lifecycleTypes).toEqual([
      'planning.started', 'planning.completed',
      'generation.started', 'generation.progress', 'generation.completed',
      'page_review.started', 'page_review.completed',
      'deck_review.started', 'deck_review.completed',
      'delivery.started', 'delivery.completed',
    ])
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
    expect(events.every((event) => event.eventId === event.id)).toBe(true)
    const generationProgress = events.find((event) => event.type === 'generation.progress')
    expect(generationProgress?.payload).toMatchObject({
      presentationMode: 'VISUAL_DECK_V4', stage: 'GENERATION', completed: 3, total: 3,
      pageNumbers: [1, 2, 3], budgetUnits: 3, committedBudgetUnits: 0,
    })
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({
      type: 'run.completed',
      payload: {
        presentationMode: 'VISUAL_DECK_V4', stage: 'RUN', completed: 1, total: 1,
        requiresUserAction: false, nextAction: null,
      },
    })

    const historyResponse = await runtime.handler(request(`/v1/runs/${runId}/events/history?after=0`))
    const history = await historyResponse.json() as { data: typeof events }
    expect(history.data).toEqual(events)
    expect(history.data.map((event) => agentEventSchema.parse(event))).toEqual(events)
    const reconnectAfter = events.find((event) => event.type === 'generation.started')!.sequence
    const streamResponse = await runtime.handler(request(`/v1/runs/${runId}/events?after=${reconnectAfter}`))
    const streamed = (await streamResponse.text()).split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as typeof events[number])
    expect(streamed).toEqual(events.filter((event) => event.sequence > reconnectAfter))
    expect(new Set(streamed.map((event) => event.sequence)).size).toBe(streamed.length)
    const reviewSteps = (await repository.listSteps(runId)).filter((step) => step.tool === 'review_slide_image')
    expect(reviewSteps).toHaveLength(3)
    const completedSteps = await repository.listSteps(runId)
    expect(completedSteps.filter((step) => step.tool === 'generate_image_batch')).toEqual([
      expect.objectContaining({ status: 'COMPLETED', budgetUnits: 0 }),
    ])
    const imageSteps = completedSteps.filter((step) => step.tool === 'generate_slide_image')
    expect(imageSteps).toHaveLength(3)
    expect(new Set(imageSteps.map((step) => step.idempotencyKey)).size).toBe(3)
    expect(imageSteps.every((step) => step.budgetUnits === 0
      && step.externalOperationId === null
      && (step.output as { renderStrategy?: string }).renderStrategy === 'CONTROLLED_RASTER')).toBe(true)
    const delivery = (await repository.listDeliveries(runId))[0]!
    const deliveredBlueprint = await getActiveBlueprint(repository, runId, completedRun.revisionRound)
    expect(delivery).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      disposition: 'FINAL',
      qualityStatus: 'APPROVED',
      openIssueIds: [],
      identity: {
        status: 'VERIFIED',
        slideCount: 3,
        pageNumbers: [1, 2, 3],
        blueprintHash: hashInput(deliveredBlueprint),
        proposalHash: hashInput(deliveredBlueprint.visualDeckV4Proposal),
      },
    })
    const finalDetailResponse = await runtime.handler(request(`/v1/runs/${runId}`))
    const finalDetail = await finalDetailResponse.json() as { data: Record<string, unknown> & {
      deliveries: unknown[]
      deliveryAvailability: unknown
    } }
    expect(runDetailSchema.parse(finalDetail.data)).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      id: runId,
      status: 'COMPLETED',
    })
    expect(finalDetail.data.deliveryAvailability).toEqual({
      state: 'AVAILABLE',
      deliveryId: delivery.id,
      disposition: 'FINAL',
      identityStatus: 'VERIFIED',
    })
    expect(finalDetail.data.deliveries).toHaveLength(1)
    expect(deliveryRecordSchema.parse(finalDetail.data.deliveries[0])).toEqual(delivery)

    const contentPath = `/v1/runs/${runId}/deliveries/${encodeURIComponent(delivery.id)}/content`
    const previewResponse = await runtime.handler(request(`${contentPath}?format=preview`))
    expect(previewResponse.status).toBe(200)
    expect(previewResponse.headers.get('X-PPT-Agent-Schema-Version')).toBe(CONTRACT_VERSION)
    expect(previewResponse.headers.get('X-PPT-Agent-Content-SHA256')).toBe(delivery.preview.sha256)
    expect([...new Uint8Array(await previewResponse.arrayBuffer()).slice(0, 8)])
      .toEqual([137, 80, 78, 71, 13, 10, 26, 10])

    const pptxResponse = await runtime.handler(request(`${contentPath}?format=pptx`))
    expect(pptxResponse.status).toBe(200)
    expect(pptxResponse.headers.get('Content-Type')).toBe(delivery.pptx.mimeType)
    expect(pptxResponse.headers.get('Content-Length')).toBe(String(delivery.pptx.byteLength))
    expect(pptxResponse.headers.get('X-PPT-Agent-Schema-Version')).toBe(CONTRACT_VERSION)
    expect(pptxResponse.headers.get('X-PPT-Agent-Delivery-ID')).toBe(delivery.id)
    expect(pptxResponse.headers.get('X-PPT-Agent-Content-SHA256')).toBe(delivery.pptx.sha256)
    const pptxBytes = new Uint8Array(await pptxResponse.arrayBuffer())
    expect(pptxBytes.length).toBeGreaterThan(10_000)

    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-v4-chain-'))
    try {
      const path = join(directory, 'visual-deck.pptx')
      await writeFile(path, pptxBytes)
      for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
        const process = Bun.spawn(['unzip', '-p', path, `ppt/slides/slide${pageNumber}.xml`], { stdout: 'pipe', stderr: 'pipe' })
        const xml = await new Response(process.stdout).text()
        expect(await process.exited).toBe(0)
        expect(xml.match(/<p:pic>/g)).toHaveLength(1)
        expect(xml).toContain(`visual-deck-page-${pageNumber}`)
        expect(xml).not.toContain('<a:t>')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }

    const storedPptx = artifacts.artifacts.get(delivery.pptx.artifactId)!
    artifacts.artifacts.set(delivery.pptx.artifactId, {
      ...storedPptx,
      bytes: new TextEncoder().encode('corrupted-after-verification'),
    })
    const corrupted = await runtime.handler(request(`${contentPath}?format=pptx`))
    expect(corrupted.status).toBe(409)
    expect(await corrupted.json()).toEqual({
      schemaVersion: CONTRACT_VERSION,
      error: {
        code: 'DELIVERY_NOT_AVAILABLE',
        category: 'DELIVERY',
        message: 'delivery is not available',
        retryable: false,
        action: 'CONTACT_SUPPORT',
        requestId: expect.any(String),
        runId,
        details: { reason: 'DELIVERY_CONTENT_INVALID' },
      },
    })
  })

  test('delivers a formal single-page V4 Run through planning, review, SSE and PPTX download', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const runtime = createMockRuntime({ repository, artifacts, apiToken: token })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-create-v4-single-0001' },
      body: JSON.stringify({
        schemaVersion: '1', host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: {
          kind: 'TEXT', name: '水循环教材.txt', roleHint: 'CONTENT_SOURCE',
          text: '太阳加热水面形成水汽，水汽凝结成云，降水回到地表，构成持续循环。'.repeat(4),
        },
        slideCount: 1,
        visualDirection: '清晰的自然科学课堂信息图',
        imageModel: 'local-mock-image',
        automationLevel: 'BOUNDED_AUTO', budgetUnits: 1, maxRevisionRounds: 0,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: {
          instruction: '用一页说明水循环的核心关系', sourceMode: 'SOURCE_GROUNDED',
          deckOptions: {
            deckType: 'PRESENTER_SLIDES', language: 'zh-CN', length: { slideCount: 1 }, aspectRatio: '16:9',
            audience: '小学高年级学生', focus: '水循环核心关系',
          },
        },
      }),
    }))
    expect(created.status).toBe(201)
    const runId = (await created.json() as { data: { id: string } }).data.id
    for (let index = 0; index < 6; index += 1) await runtime.tick()

    const completed = (await repository.getRun(runId))!
    expect(completed.status).toBe('COMPLETED')
    const blueprint = await getActiveBlueprint(repository, runId, 0)
    expect(blueprint.visualDeckV4Proposal?.slideBriefs).toEqual([
      expect.objectContaining({ pageNumber: 1, role: 'SINGLE' }),
    ])
    const delivery = (await repository.listDeliveries(runId))[0]!
    expect(delivery.identity).toMatchObject({ status: 'VERIFIED', slideCount: 1, pageNumbers: [1] })
    const events = await repository.listEvents(runId)
    expect(validateLifecycle(events, completed.status, 0)).toMatchObject({ passed: true })
    const history = await runtime.handler(request(`/v1/runs/${runId}/events/history?after=0`))
    expect((await history.json() as { data: unknown[] }).data.length).toBe(events.length)
    const reconnectAfter = events.find((event) => event.type === 'generation.started')!.sequence
    const stream = await runtime.handler(request(`/v1/runs/${runId}/events?after=${reconnectAfter}`))
    const streamed = (await stream.text()).split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { sequence: number })
    expect(streamed.map((event) => event.sequence)).toEqual(
      events.filter((event) => event.sequence > reconnectAfter).map((event) => event.sequence),
    )
    const content = await runtime.handler(request(
      `/v1/runs/${runId}/deliveries/${encodeURIComponent(delivery.id)}/content?format=pptx`,
    ))
    expect(content.status).toBe(200)
    expect((await content.arrayBuffer()).byteLength).toBe(delivery.pptx.byteLength)
  })

  test('automatically completes a new v4 run after a non-blocking page-review rejection with revisions disabled', async () => {
    const scenario = await runQualityPolicyScenario({
      id: 'page-review-rejection',
      rejectedPage: 2,
      deckOutcome: 'PASS',
    })

    expect(scenario.observedStatuses).toEqual(['PAGE_REVIEW', 'DECK_REVIEW', 'DELIVERING', 'COMPLETED'])
    expect(scenario.publicQualityAtDeckReview).toMatchObject({
      qualityDisposition: 'PENDING', qualityPolicyAudit: null,
    })
    expect(scenario.visualReviewer.requests).toHaveLength(2)
    expect(scenario.deckReviewer.evaluations).toHaveLength(1)
    expect(scenario.images.submissions).toHaveLength(2)
    expect(scenario.frameFlowBackend.snapshot()).toEqual(scenario.billingAfterGeneration)
    expect(await scenario.repository.getRun(scenario.runId)).toMatchObject({
      status: 'COMPLETED',
      committedBudgetUnits: 2,
      qualityOverride: true,
      qualityDisposition: 'SYSTEM_POLICY_ACCEPTED',
    })
    const events = await scenario.repository.listEvents(scenario.runId)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.find((event) => event.type === 'page_review.completed')).toMatchObject({
      payload: { reason: 'PAGE_REVIEW_REJECTED', retryable: false },
    })
    expect(events.find((event) => event.type === 'deck_review.completed')).toMatchObject({
      payload: { reason: null },
    })
    await assertReadableFinalDelivery(scenario, 2)
  })

  test('automatically completes a new v4 run after a non-blocking deck-review rejection with revisions disabled', async () => {
    const scenario = await runQualityPolicyScenario({
      id: 'deck-review-rejection',
      rejectedPage: null,
      deckOutcome: 'NON_BLOCKING_REJECT',
    })

    expect(scenario.observedStatuses).toEqual(['PAGE_REVIEW', 'DECK_REVIEW', 'DELIVERING', 'COMPLETED'])
    expect(scenario.visualReviewer.requests).toHaveLength(2)
    expect(scenario.deckReviewer.evaluations).toHaveLength(1)
    expect(scenario.images.submissions).toHaveLength(2)
    expect(scenario.frameFlowBackend.snapshot()).toEqual(scenario.billingAfterGeneration)
    expect(await scenario.repository.getRun(scenario.runId)).toMatchObject({
      status: 'COMPLETED',
      committedBudgetUnits: 2,
      qualityOverride: true,
      qualityDisposition: 'SYSTEM_POLICY_ACCEPTED',
    })
    const events = await scenario.repository.listEvents(scenario.runId)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.find((event) => event.type === 'page_review.completed')).toMatchObject({
      payload: { reason: null },
    })
    expect(events.find((event) => event.type === 'deck_review.completed')).toMatchObject({
      payload: { reason: 'DECK_REVIEW_REJECTED', retryable: false },
    })
    await assertReadableFinalDelivery(scenario, 2)
  })

  test('fails a new v4 run instead of policy-delivering a hard deck-review blocker', async () => {
    const scenario = await runQualityPolicyScenario({
      id: 'deck-review-hard-blocker',
      rejectedPage: null,
      deckOutcome: 'HARD_BLOCKER',
    })

    expect(scenario.observedStatuses).toEqual(['PAGE_REVIEW', 'DECK_REVIEW', 'FAILED'])
    expect(scenario.visualReviewer.requests).toHaveLength(2)
    expect(scenario.deckReviewer.evaluations).toHaveLength(1)
    expect(scenario.images.submissions).toHaveLength(2)
    expect(scenario.frameFlowBackend.snapshot()).toEqual(scenario.billingAfterGeneration)
    expect(await scenario.repository.getRun(scenario.runId)).toMatchObject({
      status: 'FAILED',
      committedBudgetUnits: 2,
      qualityOverride: false,
      qualityDisposition: 'HARD_FAILURE',
    })
    expect(await scenario.repository.listDeliveries(scenario.runId)).toEqual([])
    const events = await scenario.repository.listEvents(scenario.runId)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.some((event) => event.type === 'delivery.started')).toBe(false)
    expect(events.some((event) => event.type === 'issue.resolved'
      && event.payload.resolution === 'ACCEPTED')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT' },
    })
    const detail = await scenario.runtime.handler(request(`/v1/runs/${scenario.runId}`))
    expect(await detail.json()).toMatchObject({ data: { qualityDisposition: 'HARD_FAILURE' } })
  })

  test('fails a new v4 run instead of policy-delivering a hard page-review blocker', async () => {
    const scenario = await runQualityPolicyScenario({
      id: 'page-review-hard-blocker',
      rejectedPage: 2,
      deckOutcome: 'PASS',
      hardPageBlocker: true,
    })

    expect(scenario.observedStatuses).toEqual(['PAGE_REVIEW', 'FAILED'])
    expect(scenario.visualReviewer.requests).toHaveLength(2)
    expect(scenario.deckReviewer.evaluations).toHaveLength(0)
    expect(scenario.images.submissions).toHaveLength(2)
    expect(scenario.frameFlowBackend.snapshot()).toEqual(scenario.billingAfterGeneration)
    expect(await scenario.repository.getRun(scenario.runId)).toMatchObject({
      status: 'FAILED', committedBudgetUnits: 2, qualityOverride: false,
      qualityDisposition: 'HARD_FAILURE',
    })
    expect(await scenario.repository.listDeliveries(scenario.runId)).toEqual([])
    const events = await scenario.repository.listEvents(scenario.runId)
    expect(events.some((event) => event.type === 'deck_review.started')).toBe(false)
    expect(events.some((event) => event.type === 'delivery.started')).toBe(false)
    expect(events.some((event) => event.type === 'issue.resolved'
      && event.payload.resolution === 'ACCEPTED')).toBe(false)
  })

  test('routes a failed deck review through approved local revision and re-review', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const renderer = new MockPresentationRendererPort()
    const blueprint = {
      title: '光合作用',
      curriculum: {
        subject: '生物', grade: '七年级', lessonTitle: '光合作用',
        sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
        learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
        prohibitedExtensions: [], sourceChunkIds: ['chunk-0001-8c189f673e93'],
      },
      slides: [1, 2].map((pageNumber) => ({
        pageNumber, title: pageNumber === 1 ? '光合作用' : '条件与产物', body: ['绿色植物利用光能制造有机物'],
        layout: pageNumber === 1 ? 'HERO' as const : 'SPLIT' as const,
        visualIntent: `用科学课堂画面解释第 ${pageNumber} 页知识`,
        visualPrompt: `A text-free science classroom illustration for page ${pageNumber}`,
        sourceChunkIds: ['chunk-0001-8c189f673e93'],
      })),
    }
    const deckReviewer: DeckReviewPort = {
      async evaluate(input) {
        const revised = input.blueprint.id.includes(':r1')
        return {
          qualityScore: revised ? 91 : 72,
          curriculumCoverageScore: 90, narrativeCoherenceScore: 88,
          visualConsistencyScore: 86, compositionScore: revised ? 90 : 68,
          summary: revised ? '局部修订后布局冲突已消除，整套课件达到交付标准。' : '第二页布局冲突，需要只调整该页元素位置。',
          reviewedSourceChunkIds: input.sourceChunks.map((chunk) => chunk.id),
          issues: revised ? [] : [{
            id: 'issue-layout-2', category: 'COMPOSITION_CONFLICT', severity: 'WARNING',
            summary: '第二页素材与文字区发生布局冲突。', slideIds: [input.slides[1]!.slideId],
            sourceChunkIds: [], status: 'OPEN', repairDomain: 'LAYOUT',
          }],
        }
      },
    }
    const revisionPlanner: RevisionPlanningPort = {
      async plan(input) {
        return {
          summary: '只重新组装第二页，不重新生成图片素材。',
          operations: [{
            id: 'relayout-slide-2', slideId: input.review.issues[0]!.slideIds[0]!,
            kind: 'RELAYOUT', issueIds: ['issue-layout-2'],
            instruction: 'Move the visual away from the editable text area without changing any image prompt.',
            sourceChunkIds: [],
          }],
        }
      },
    }
    const revisionApplication: RevisionApplicationPort = {
      async apply(input) {
        return {
          title: input.blueprint.title,
          curriculum: input.blueprint.curriculum,
          slides: input.blueprint.slides.map((slide) => slide.pageNumber === 2 ? { ...slide, layout: 'EDITORIAL' } : slide),
        }
      },
    }
    const runtime = createAgentRuntime({
      repository, artifacts, renderer, apiToken: token,
      model: {
        async execute(input) {
          const payload = input.payload as { document: { chunks: { id: string }[] } }
          const sourceChunkIds = [payload.document.chunks[0]!.id]
          return {
            ...blueprint,
            curriculum: { ...blueprint.curriculum, sourceChunkIds },
            slides: blueprint.slides.map((slide) => ({ ...slide, sourceChunkIds })),
          }
        },
      },
      visualReviewer: new MockVisualReviewPort({
        approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null,
      }),
      deckReviewer, revisionPlanner, revisionApplication,
    })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-revision-create' },
      body: JSON.stringify({
        schemaVersion: '1', host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: { kind: 'TEXT', name: '光合作用.txt', text: '绿色植物利用光能制造有机物，并释放氧气。这是完整教材内容。' },
        slideCount: 2, visualDirection: '课堂科学信息图', imageModel: 'local-mock-image',
        automationLevel: 'SUPERVISED', budgetUnits: 10, maxRevisionRounds: 2,
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id
    await runtime.tick()
    await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-revision-approve-blueprint' },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_BLUEPRINT', expectedVersion: 1 }),
    }))
    for (let index = 0; index < 3; index += 1) await runtime.tick()
    const awaiting = (await repository.getRun(runId))!
    expect(awaiting.status).toBe('AWAITING_REVISION_APPROVAL')

    await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-revision-approve-plan' },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_REVISION', expectedVersion: awaiting.version }),
    }))
    for (let index = 0; index < 4; index += 1) await runtime.tick()
    expect(await repository.getRun(runId)).toMatchObject({ status: 'COMPLETED', revisionRound: 1, qualityScore: 91 })
  })

  test('runs an authenticated approved deck through delivery with zero provider calls', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const renderer = new MockPresentationRendererPort()
    const runtime = createMockRuntime({ repository, artifacts, renderer, apiToken: token })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-create-0001' },
      body: JSON.stringify({
        schemaVersion: '1',
        host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: { kind: 'TEXT', name: '光合作用教材.txt', text: '绿色植物利用光能制造有机物，并释放氧气。这是完整的课堂教材内容。' },
        slideCount: 2,
        visualDirection: '清晰的课堂科学信息图',
        imageModel: 'local-mock-image',
        automationLevel: 'SUPERVISED',
        budgetUnits: 10,
        maxRevisionRounds: 2,
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id
    expect(created.status).toBe(201)

    await runtime.tick()
    expect(await repository.getRun(runId)).toMatchObject({ status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
    const hidden = await runtime.handler(request(`/v1/runs/${runId}`, {}, 'user-2'))
    expect(hidden.status).toBe(404)

    const approved = await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-approve-0001' },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_BLUEPRINT', expectedVersion: 1 }),
    }))
    expect(approved.status).toBe(200)

    for (let index = 0; index < 4; index += 1) await runtime.tick()
    expect(await repository.getRun(runId)).toMatchObject({
      status: 'COMPLETED', qualityScore: 90, committedBudgetUnits: 2,
    })
    expect(await repository.listDeliveries(runId)).toHaveLength(1)
    expect(renderer).toMatchObject({ previewCalls: 1, pptxCalls: 1 })
  })

  test('fails closed for an exhausted legacy quality actor without resubmitting or rebilling images', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const renderer = new MockPresentationRendererPort()
    const images = new CountingCompletedImageGeneration(artifacts)
    const frameFlowBackend = new CountingFrameFlowBackend()
    const runtime = createMockRuntime({
      repository, artifacts, renderer, images, frameFlowBackend, apiToken: token, appVersion: '4.3.0',
    })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-v4-quality-recovery-create' },
      body: JSON.stringify({
        schemaVersion: '1',
        host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: {
          kind: 'TEXT', name: '五以内数的分与合.txt',
          text: '把五只小鸟分成两个非空组，记录每一种分法，并检查两组合起来仍然是五只。'.repeat(6),
        },
        slideCount: 2,
        visualDirection: '明亮清晰的儿童课堂信息图',
        imageModel: 'local-mock-image',
        automationLevel: 'BOUNDED_AUTO',
        budgetUnits: 2,
        maxRevisionRounds: 2,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: {
          instruction: '制作两页讲解五以内数的分与合的课堂视觉 PPT',
          sourceMode: 'SOURCE_GROUNDED',
          deckOptions: {
            deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 }, aspectRatio: '16:9',
            audience: '幼儿园大班学生', focus: '理解 5 的分与合',
          },
        },
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id
    expect(created.status).toBe(201)
    const originalRun = (await repository.getRun(runId))!
    const originalIdentity = {
      id: originalRun.id,
      creationKey: originalRun.creationKey,
      requestHash: originalRun.requestHash,
      host: originalRun.host,
      release: originalRun.release,
    }
    expect(originalRun.release).toMatchObject({ softwareVersion: '4.3.0', presentationMode: 'VISUAL_DECK_V4' })

    await runtime.tick()
    await runtime.tick()
    const generated = (await repository.getRun(runId))!
    expect(generated).toMatchObject({ status: 'PAGE_REVIEW', committedBudgetUnits: 2, maxRevisionRounds: 2 })
    const beforeSteps = await repository.listSteps(runId)
    const beforeImageSteps = beforeSteps.filter((step) => step.tool === 'generate_slide_image')
    const beforeBatches = beforeSteps.filter((step) => step.tool === 'generate_image_batch')
    expect(beforeImageSteps).toHaveLength(2)
    expect(images.submissions).toHaveLength(2)
    const billingBeforeRecovery = frameFlowBackend.snapshot()
    expect(billingBeforeRecovery.reserve).toBeGreaterThan(0)
    expect(Object.values(billingBeforeRecovery).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0)
    const terminalAccounting = deriveV4TerminalAccounting(generated, beforeSteps)
    expect(terminalAccounting.accountingStatus).toBe('FINAL')
    await repository.transact(runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: '1',
        type: 'issue.detected',
        payload: {
          id: 'legacy-v4-quality-issue', category: 'COMPOSITION_CONFLICT', severity: 'WARNING',
          summary: '旧版本整稿审查发现一项非阻断的构图建议。', slideIds: [`${runId}:slide:2`],
          sourceChunkIds: [], status: 'OPEN', repairDomain: 'LAYOUT',
        },
      })
      transaction.appendEvent({
        schemaVersion: '1',
        type: 'issue.resolved',
        payload: { issueId: 'legacy-v4-quality-issue', resolution: 'ACCEPTED' },
      })
      const {
        qualityDisposition: _qualityDisposition,
        qualityPolicyAudit: _qualityPolicyAudit,
        ...legacyRun
      } = transaction.run
      const failed = {
        ...legacyRun,
        status: 'FAILED' as const,
        version: transaction.run.version + 1,
        terminalAccounting,
        qualityOverride: true,
        qualityOverrideReason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
        qualityOverrideBy: 'ppt-agent-quality-policy',
        qualityOverrideRole: 'ADMIN' as const,
        qualityOverrideIssueIds: ['legacy-v4-quality-issue'],
        qualityOverrideAt: '2026-07-21T00:00:00.000Z',
      }
      transaction.putRun(failed)
      transaction.appendEvent({
        schemaVersion: '1',
        type: 'run.failed',
        payload: {
          ...v4LifecyclePayload(failed, 'RUN', {
            completed: 0, total: 1, pageNumbers: [1, 2], reason: 'REVISION_LIMIT_REACHED', retryable: false,
          }),
          errorCode: 'QUALITY_REMEDIATION_EXHAUSTED',
          terminalAccounting,
        },
      })
    })
    const failed = (await repository.getRun(runId))!

    const resumed = await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-v4-quality-recovery-action' },
      body: JSON.stringify({ schemaVersion: '1', type: 'RETRY_DELIVERY', expectedVersion: failed.version }),
    }))
    expect(resumed.status).toBe(200)
    expect(await resumed.json()).toMatchObject({
      data: {
        status: 'DECK_REVIEW',
        qualityOverride: false,
        qualityDisposition: 'PENDING',
        qualityPolicyAudit: null,
        qualityOverrideAudit: null,
      },
    })
    await runtime.tick()
    await runtime.tick()

    expect(await repository.getRun(runId)).toMatchObject({
      ...originalIdentity,
      status: 'FAILED',
      committedBudgetUnits: 2,
      qualityOverride: false,
      qualityOverrideReason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
      qualityOverrideBy: 'ppt-agent-quality-policy',
      qualityOverrideRole: 'ADMIN',
      qualityOverrideIssueIds: ['legacy-v4-quality-issue'],
      qualityOverrideAt: '2026-07-21T00:00:00.000Z',
      qualityDisposition: 'HARD_FAILURE',
    })
    expect((await repository.getRun(runId))!.qualityPolicyAudit).toBeNull()
    expect(images.submissions).toHaveLength(2)
    expect(frameFlowBackend.snapshot()).toEqual(billingBeforeRecovery)
    const afterSteps = await repository.listSteps(runId)
    expect(afterSteps.filter((step) => step.tool === 'generate_slide_image')).toEqual(beforeImageSteps)
    expect(afterSteps.filter((step) => step.tool === 'generate_image_batch')).toEqual(beforeBatches)
    expect(await repository.listDeliveries(runId)).toEqual([])
    expect(await repository.getTerminalEvent(runId)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT' },
    })
  })

  test('rejects missing or mismatched service credentials', async () => {
    const runtime = createMockRuntime({
      repository: new InMemoryAgentRepository(),
      artifacts: new MockArtifactPort(),
      renderer: new MockPresentationRendererPort(),
      apiToken: token,
    })
    expect((await runtime.handler(new Request('http://127.0.0.1:4310/v1/runs'))).status).toBe(401)
    expect((await runtime.handler(new Request('http://127.0.0.1:4310/v1/runs', { headers: {
      Authorization: 'Bearer wrong-token-value',
      'X-PPT-Agent-Tenant': 'frameflow',
      'X-PPT-Agent-User': 'user-1',
    } }))).status).toBe(401)
  })

  test('reuses generated knowledge assets across v3 pages and exports independent page objects', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const runtime = createMockRuntime({ repository, artifacts, apiToken: token })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-create-v3-0001' },
      body: JSON.stringify({
        schemaVersion: '1',
        host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: { kind: 'TEXT', name: '数量认识.txt', text: '教材通过三个苹果帮助学生建立数量三与具体物体之间的对应关系。' },
        slideCount: 3,
        visualDirection: '纸黏土儿童课堂插画，明亮清晰，知识对象准确',
        imageModel: 'local-mock-image',
        automationLevel: 'SUPERVISED',
        budgetUnits: 15,
        presentationMode: 'LAYERED_COURSEWARE_V3',
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id
    await runtime.tick()
    await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-approve-v3-0001' },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_BLUEPRINT', expectedVersion: 1 }),
    }))
    for (let index = 0; index < 4; index += 1) await runtime.tick()

    expect(await repository.getRun(runId)).toMatchObject({
      status: 'COMPLETED', presentationMode: 'LAYERED_COURSEWARE_V3', committedBudgetUnits: 8,
    })
    const mediaSteps = (await repository.listSteps(runId)).filter((step) => step.tool === 'generate_slide_image')
    expect(mediaSteps).toHaveLength(8)
    const delivery = (await repository.listDeliveries(runId))[0]!
    const artifact = artifacts.artifacts.get(delivery.pptx.artifactId)
    expect(artifact?.bytes.length).toBeGreaterThan(20_000)

    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-v3-e2e-'))
    try {
      const path = join(directory, 'delivery.pptx')
      await writeFile(path, artifact!.bytes)
      const process = Bun.spawn(['unzip', '-p', path, 'ppt/slides/slide3.xml'], { stdout: 'pipe', stderr: 'pipe' })
      const xml = await new Response(process.stdout).text()
      expect(await process.exited).toBe(0)
      expect(xml.match(/<p:pic>/g)).toHaveLength(5)
      expect(xml).toContain('base-3')
      expect(xml).toContain('knowledge-3-1')
      expect(xml).toContain('knowledge-3-4')
      expect(xml).toContain('title-3')
      expect(xml).toContain('body-3')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

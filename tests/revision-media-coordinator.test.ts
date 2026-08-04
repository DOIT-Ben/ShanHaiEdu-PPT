import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  FixedClock,
  MockArtifactPort,
  MockBudgetPort,
  MockImageGenerationPort,
  MockPresentationRendererPort,
  MockVisualReviewPort,
} from '../src/adapters/mock-ports'
import { revisionBlueprintStepKey } from '../src/core/active-blueprint'
import { V4_REVISION_PROMPT_MAX_LENGTH } from '../src/core/blueprint-assets'
import { MediaStepRunner } from '../src/core/media-step-runner'
import { PageReviewCoordinator } from '../src/core/page-review-coordinator'
import { generationBatchStepKeyFor, getGenerationBatch } from '../src/core/generation-batch'
import { planningStepKey } from '../src/core/planning-runner'
import type { RunRecord } from '../src/core/ports'
import { RevisionMediaCoordinator } from '../src/core/revision-media-coordinator'
import { SlideGenerationCoordinator } from '../src/core/slide-generation-coordinator'
import { applyRunAction } from '../src/core/policy'
import { resumeTechnicalRecovery } from '../src/core/technical-recovery'
import { revisionPlanStepKey } from '../src/core/revision-planning-runner'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { VisualReviewRunner } from '../src/core/visual-review-runner'
import { parseProviderBillingCatalog } from '../src/adapters/provider-billing-catalog'
import { UsageV2Coordinator } from '../src/core/usage-v2-coordinator'
import type { UsageAccountingPort } from '../src/core/ports'
import type { UsageRunBill } from '../src/usage-accounting-contracts'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-1', requestHash: 'hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是局部重绘协调器使用的完整测试教材。' },
    slideCount: 2, visualDirection: '课堂科学信息图', imageModel: 'image-2',
    automationLevel: 'SUPERVISED', maxRevisionRounds: 2, revisionRound: 1,
    qualityScore: 72, status: 'REVISING', resumeState: null, version: 8,
    budgetUnits: 100, committedBudgetUnits: 20, qualityOverride: false,
    qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null,
    leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  }
}

function blueprint(id: string, corrected = false) {
  return {
    id, title: '光合作用', visualDirection: '课堂科学信息图', createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber, title: pageNumber === 1 ? '认识光合作用' : '条件与产物', body: ['教材内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: `用课堂科学画面表达第 ${pageNumber} 页知识点`,
      visualPrompt: corrected && pageNumber === 2
        ? 'A corrected oxygen release classroom illustration, no text or symbols'
        : `A clean educational science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: ['chunk-1'],
    })),
  }
}

function revisionPlan() {
  return {
    id: 'plan-r1', reviewId: 'review-r0', revisionRound: 1, createdAt: '2026-07-21T00:00:00.000Z',
    summary: '仅重绘第二页存在问题的视觉素材。',
    operations: [{
      id: 'operation-1', slideId: 'run-1:slide:2', kind: 'REGENERATE_IMAGE', issueIds: ['issue-1'],
      instruction: 'Remove the inconsistent object and preserve a clean text-safe area.', sourceChunkIds: ['chunk-1'],
    }],
  }
}

function layeredBlueprint() {
  const base = blueprint('blueprint-r1', true)
  return {
    ...base,
    renderMode: 'LAYERED_COURSEWARE_V3' as const,
    coverDesignMode: 'FOLLOW_TEMPLATE' as const,
    sourceManifest: [],
    sourceAssets: [],
    slides: base.slides.map((slide) => ({
      ...slide,
      sourceAssetIds: [],
      layeredDesign: {
        designKind: slide.pageNumber === 1 ? 'COVER' as const : 'CONTENT' as const,
        backgroundColor: '#EAF7FF',
        elements: [
          {
            kind: 'IMAGE' as const, elementId: `base-${slide.pageNumber}`, role: 'BASE_LAYER' as const,
            knowledgePoint: '建立科学课堂背景', prompt: 'A clean wide science classroom background without text',
            negativePrompt: 'text, logo, watermark', sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
            sourceAssetStrategy: 'REGENERATE' as const,
            placement: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 0,
            fit: 'COVER' as const, aspectRatio: '16:9' as const, backgroundMode: 'OPAQUE' as const,
          },
          {
            kind: 'IMAGE' as const, elementId: `knowledge-${slide.pageNumber}`, role: 'KNOWLEDGE_VISUAL' as const,
            knowledgePoint: '展示光合作用知识对象', prompt: 'A transparent leaf explaining photosynthesis without text',
            negativePrompt: 'text, logo, watermark', sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
            sourceAssetStrategy: 'REGENERATE' as const,
            placement: { x: 0.6, y: 0.2, width: 0.3, height: 0.5 }, zIndex: 2,
            fit: 'CONTAIN' as const, aspectRatio: '1:1' as const, backgroundMode: 'TRANSPARENT' as const,
          },
          {
            kind: 'TEXT' as const, elementId: `title-${slide.pageNumber}`, role: 'TITLE' as const,
            text: slide.title, sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
            placement: { x: 0.08, y: 0.15, width: 0.4, height: 0.15 }, zIndex: 3,
            style: { fontSize: 30, bold: true, color: '#17365D', align: 'LEFT' as const },
          },
        ],
      },
    })),
  }
}

function layeredRevisionPlan() {
  const base = revisionPlan()
  return {
    ...base,
    operations: [{ ...base.operations[0]!, targetElementId: 'knowledge-2' }],
  }
}

function visualDeckV4Blueprint() {
  const source = { kind: 'TEXT' as const, name: '光合作用教材.txt', text: '绿色植物利用光能制造有机物并释放氧气。'.repeat(8) }
  return createVisualDeckV4Blueprint({
    runId: 'run-1', inputHash: 'plan-hash', source,
    document: {
      name: source.name, isComplete: true, missingRanges: [],
      chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
    },
    config: {
      instruction: '制作两页光合作用视觉演示', sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 }, aspectRatio: '16:9',
        audience: '七年级学生', focus: '理解光合作用', styleHint: '课堂科学信息图',
      },
    },
    slideCount: 2, visualDirection: '课堂科学信息图', createdAt: '2026-07-21T00:00:00.000Z',
  })
}

async function revisionImageKey(repository: InMemoryAgentRepository, pageNumber: number, revisionRound = 1) {
  const prefix = `run-1:slide:${pageNumber}:image:r${revisionRound}:v1`
  const key = (await repository.listSteps('run-1'))
    .find((step) => step.tool === 'generate_slide_image' && step.idempotencyKey.startsWith(prefix))
    ?.idempotencyKey
  if (!key) throw new Error(`revision image key not found for page ${pageNumber}`)
  return key
}

async function fixture(
  overrides: Partial<RunRecord> = {},
  inputs: Readonly<{
    blueprint?: unknown
    plan?: ReturnType<typeof revisionPlan>
    imageConcurrency?: number
    revisionImageModel?: string
  }> = {},
) {
  const repository = new InMemoryAgentRepository()
  const budget = new MockBudgetPort()
  const images = new MockImageGenerationPort()
  const artifacts = new MockArtifactPort()
  const renderer = new MockPresentationRendererPort()
  const clock = new FixedClock()
  await repository.createRun(run(overrides))
  await repository.transact('run-1', (transaction) => {
    const put = (id: string, key: string, tool: string, output: unknown, budgetUnits = 0) => transaction.putStep({
      id, runId: 'run-1', idempotencyKey: key, inputHash: `hash-${id}`, tool, status: 'COMPLETED',
      budgetUnits, budgetReservationId: budgetUnits ? `budget-${id}` : null,
      externalOperationId: budgetUnits ? `operation-${id}` : null, errorCode: null, output,
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    put('plan', planningStepKey('run-1'), 'create_blueprint', blueprint('blueprint-r0'))
    put('apply-r1', revisionBlueprintStepKey('run-1', 1), 'apply_revision', inputs.blueprint ?? blueprint('blueprint-r1', true))
    put('revision-plan-r1', revisionPlanStepKey('run-1', 1), 'plan_revision', inputs.plan ?? revisionPlan())
    for (const pageNumber of [1, 2]) put(
      `image-r0-${pageNumber}`,
      `run-1:slide:${pageNumber}:image:r0:v1`,
      'generate_slide_image',
      { slideId: `run-1:slide:${pageNumber}`, versionId: `run-1:slide:${pageNumber}:r0:v1`, artifactId: `artifact-r0-${pageNumber}` },
      10,
    )
  })
  const media = new MediaStepRunner({ repository, budget, images, clock })
  const sourceBytes = new Uint8Array(await sharp({
    create: { width: 160, height: 90, channels: 3, background: '#EAF7FF' },
  }).png().toBuffer())
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
  for (const artifactId of ['artifact-r0-1', 'artifact-r0-2', 'artifact-r1-2']) {
    artifacts.artifacts.set(artifactId, {
      mimeType: 'image/png', bytes: sourceBytes, sha256: sourceSha256,
    })
  }
  return {
    repository,
    budget,
    images,
    artifacts,
    renderer,
    clock,
    media,
    coordinator: new RevisionMediaCoordinator({
      repository,
      media,
      batchBudget: budget,
      artifacts,
      clock,
      revisionImageModel: inputs.revisionImageModel ?? 'image-2',
      ...(inputs.imageConcurrency === undefined ? {} : { imageConcurrency: inputs.imageConcurrency }),
    }),
    generation: new SlideGenerationCoordinator({
      repository,
      media,
      batchBudget: budget,
      documents: {
        async resolve() {
          return { name: 'source', chunks: [], assets: [], isComplete: true, missingRanges: [] }
        },
      },
      artifacts,
      clock,
    }),
    sourceBytes,
    sourceSha256,
  }
}

function revisionUsageBill(overrides: Partial<UsageRunBill> = {}): UsageRunBill {
  return {
    pptRunId: 'run-1', authorizationReservationId: 'authorization-1', accountingMode: 'USAGE_V2', status: 'ACTIVE',
    authorizationCapMilli: 300_000, authorizedModel: 'image-2', authorizedUnits: 30,
    pricingVersion: 'ppt-image-v1', unitPriceMilli: 10_000, providerSpendSafetyCapOperations: 30,
    generatedOperations: 0, chargedOperations: 0, notChargedOperations: 0, unknownOperations: 0,
    chargeableMilli: 0, settledMilli: 0, releasedMilli: 0, providerCosts: [], lastEventSequence: 0,
    lastEventAt: null, settledAt: null, firstUnknownAt: null, reconciliationAttempts: 0,
    nextReconcileAt: null, reconciliationDeadlineAt: null, reconciliationLastError: null,
    ...overrides,
  }
}

class RevisionUsagePort implements UsageAccountingPort {
  readonly permits: Parameters<UsageAccountingPort['authorizeOperation']>[0][] = []
  readonly events: Parameters<UsageAccountingPort['ingestEvent']>[0]['event'][] = []
  permitResult: 'ALLOW' | 'DENY' = 'ALLOW'

  async authorizeOperation(input: Parameters<UsageAccountingPort['authorizeOperation']>[0]) {
    this.permits.push(structuredClone(input))
    if (this.permitResult === 'DENY') {
      return {
        allowed: false as const, stopReason: 'AUTHORIZATION_CAP_REACHED' as const,
        authorizedOperations: 30, authorizationCapOperations: 30, providerSpendSafetyCapOperations: 30,
      }
    }
    return { allowed: true as const, permitId: `permit-${input.pageNumber}`, pricingVersion: 'ppt-image-v1', userPriceMilli: 10_000 }
  }

  async ingestEvent(input: Parameters<UsageAccountingPort['ingestEvent']>[0]) {
    this.events.push(structuredClone(input.event))
    return { replayed: false, bill: revisionUsageBill({ lastEventSequence: input.event.sequence }) }
  }

  async getRunBill() { return revisionUsageBill() }
  async finalizeRun() { return revisionUsageBill({ status: 'SETTLED' }) }
}

async function usageV2RevisionFixture(inputs: Readonly<{
  plan?: ReturnType<typeof revisionPlan>
  imageConcurrency?: number
}> = {}) {
  const basePlan = revisionPlan()
  const plan = inputs.plan ?? {
    ...basePlan,
    operations: [
      { ...basePlan.operations[0]!, id: 'operation-page-1', slideId: 'run-1:slide:1', instruction: 'Correct page one.' },
      { ...basePlan.operations[0]!, id: 'operation-page-2', slideId: 'run-1:slide:2', instruction: 'Correct page two.' },
    ],
  }
  const imageConcurrency = inputs.imageConcurrency ?? 2
  const base = await fixture({
    presentationMode: 'VISUAL_DECK_V4', accountingProtocol: 'FRAMEFLOW_USAGE_V2',
  }, { blueprint: visualDeckV4Blueprint(), plan, imageConcurrency })
  const usage = new RevisionUsagePort()
  const usageV2 = new UsageV2Coordinator({
    repository: base.repository,
    usage,
    billingCatalog: parseProviderBillingCatalog(JSON.stringify({ schemaVersion: '1', entries: [{
      model: 'image-2', operationMode: 'IMAGE_EDIT', resolution: '1K',
      costBasis: 'FIXED_PER_OPERATION', costAmountMicros: 40_000, currency: 'USD',
      providerPricingVersion: 'image-2-edit-2026-08',
    }] })),
    clock: base.clock,
  })
  const media = new MediaStepRunner({
    repository: base.repository, budget: base.budget, images: base.images, clock: base.clock, usageV2,
  })
  const coordinator = new RevisionMediaCoordinator({
    repository: base.repository, media, batchBudget: base.budget, artifacts: base.artifacts,
    clock: base.clock, revisionImageModel: 'image-2', imageConcurrency,
  })
  return { ...base, usage, media, coordinator }
}

describe('revision media coordinator', () => {
  test('runs Usage V2 image edits through per-page permits and local batch reduction without legacy credit calls', async () => {
    const { repository, budget, images, usage, coordinator } = await usageV2RevisionFixture()

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'REVISING', submitted: 2, total: 2 })
    expect(usage.permits.map(({ pageNumber, revisionRound, model }) => ({ pageNumber, revisionRound, model })))
      .toEqual([
        { pageNumber: 1, revisionRound: 1, model: 'image-2' },
        { pageNumber: 2, revisionRound: 1, model: 'image-2' },
      ])
    expect(budget.reservationRequests).toHaveLength(0)
    expect(budget.batchReservationRequests).toHaveLength(0)

    images.complete(await revisionImageKey(repository, 1), 'artifact-r1-1')
    images.complete(await revisionImageKey(repository, 2), 'artifact-r1-2')
    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 2, total: 2 })
    expect(usage.events.filter((event) => event.eventType === 'OPERATION_OBSERVED')).toHaveLength(2)
    expect(usage.events.filter((event) => event.eventType === 'BILLING_RESOLVED')).toHaveLength(2)
    expect(budget.batchFinalizationAttempts).toHaveLength(0)
  })

  test('keeps a permit-denied V4 revision paused and resumes the original image operation once', async () => {
    const { repository, images, usage, coordinator } = await usageV2RevisionFixture({
      plan: revisionPlan(), imageConcurrency: 1,
    })
    usage.permitResult = 'DENY'

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'PAUSED', submitted: 1, total: 1 })
    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'PAUSED', completed: 0, total: 1 })
    expect(images.submitCalls).toBe(0)
    const [mediaStep] = (await repository.listSteps('run-1')).filter((step) =>
      step.tool === 'generate_slide_image' && step.idempotencyKey.includes(':r1:'))
    expect(mediaStep).toMatchObject({ status: 'FAILED', errorCode: 'AUTHORIZATION_CAP_REACHED' })
    const originalKey = mediaStep!.idempotencyKey
    const pausedEvents = await repository.listEvents('run-1')
    expect(pausedEvents.find((event) => event.type === 'run.paused')).toMatchObject({
      payload: {
        presentationMode: 'VISUAL_DECK_V4', reason: 'BUDGET_INSUFFICIENT',
        requiresUserAction: true, nextAction: 'ADD_BUDGET', resumeState: 'REVISING',
      },
    })
    expect(pausedEvents.some((event) => event.type === 'approval.required'
      && event.payload.kind === 'HUMAN_REVIEW')).toBe(false)
    expect(pausedEvents.some((event) => event.type === 'revision.completed')).toBe(false)
    expect(pausedEvents.some((event) => event.type === 'technical.recovery.started')).toBe(false)
    expect(pausedEvents.some((event) => event.type === 'run.failed'
      && event.payload.errorCode === 'WORKER_FATAL')).toBe(false)

    await repository.transact('run-1', (transaction) => {
      const funded = applyRunAction(transaction.run, {
        schemaVersion: CONTRACT_VERSION,
        type: 'ADD_BUDGET',
        expectedVersion: transaction.run.version,
        additionalBudgetUnits: 5,
      })
      const resumed = applyRunAction(funded, {
        schemaVersion: CONTRACT_VERSION,
        type: 'RESUME',
        expectedVersion: funded.version,
      })
      transaction.putRun({ ...transaction.run, ...resumed, updatedAt: transaction.run.updatedAt })
    })
    usage.permitResult = 'ALLOW'

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(usage.permits.map((permit) => permit.operationIdempotencyKey)).toEqual([originalKey, originalKey])
    expect(images.submitCalls).toBe(1)
    expect(images.requests.has(originalKey)).toBe(true)
  })

  test('releases the whole unsubmitted V4 revision batch when a permit-paused Run is cancelled', async () => {
    const { repository, images, usage, coordinator, generation } = await usageV2RevisionFixture({
      plan: revisionPlan(), imageConcurrency: 1,
    })
    usage.permitResult = 'DENY'
    await coordinator.submit('run-1', 5)

    await repository.transact('run-1', (transaction) => {
      const cancelled = applyRunAction(transaction.run, {
        schemaVersion: CONTRACT_VERSION,
        type: 'CANCEL',
        expectedVersion: transaction.run.version,
        reason: '用户取消额度不足的返修任务。',
      })
      transaction.putRun({ ...transaction.run, ...cancelled, updatedAt: transaction.run.updatedAt })
    })

    expect(await generation.reconcileTerminalGenerationBatch('run-1')).toBe(true)
    expect(images.submitCalls).toBe(0)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'CANCELLED', committedBudgetUnits: 20 })
    expect((await repository.listSteps('run-1')).find((step) =>
      step.idempotencyKey === generationBatchStepKeyFor('run-1', { revisionRound: 1, scope: 'REVISION' })))
      .toMatchObject({
        status: 'COMPLETED',
        output: { accounting: { settlement: 'RELEASED', settledUnits: 0, releasedUnits: 5 } },
      })
  })

  test('edits the latest controlled V4 page with the configured GPT model before review', async () => {
    const { repository, budget, images, sourceBytes, sourceSha256, coordinator } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', imageModel: 'nano-banana-pro',
    }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
      revisionImageModel: 'image-2',
    })

    const submitted = await coordinator.submit('run-1', 5)
    const [key, request] = [...images.requests.entries()][0]!
    const step = (await repository.listSteps('run-1')).find((candidate) => candidate.idempotencyKey === key)

    expect(submitted).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(key).toMatch(/^run-1:slide:2:image:r1:v1:edit:[a-f0-9]{24}$/)
    expect(request.model).toBe('image-2')
    expect(request.referenceImage).toEqual({
      mimeType: 'image/png', bytes: sourceBytes, sha256: sourceSha256,
    })
    expect(request.prompt).toContain('Edit the attached source slide in place')
    expect(request.prompt).toContain('Remove the inconsistent object')
    expect(step?.output).toMatchObject({
      model: 'image-2',
      operationMode: 'IMAGE_EDIT',
      referenceImageSha256: sourceSha256,
      repairContractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      repairContract: {
        mode: 'IMAGE_EDIT', editModel: 'image-2', issueIds: ['issue-1'],
        sourceArtifact: { artifactId: 'artifact-r0-2', sha256: sourceSha256, width: 160, height: 90 },
      },
    })
    expect(budget.batchReservationRequests).toHaveLength(1)
    expect(budget.batchReservationRequests[0]).toMatchObject({ model: 'image-2', units: 5 })
    const batchStep = (await repository.listSteps('run-1')).find((candidate) =>
      candidate.idempotencyKey === generationBatchStepKeyFor('run-1', { revisionRound: 1, scope: 'REVISION' }))
    expect(batchStep?.output).toMatchObject({ accountingModel: 'image-2', operationMode: 'IMAGE_EDIT' })
    const publicBatch = await getGenerationBatch(repository, (await repository.getRun('run-1'))!, {
      revisionRound: 1,
      scope: 'REVISION',
    })
    expect(publicBatch).not.toHaveProperty('accountingModel')
    expect(publicBatch).not.toHaveProperty('operationMode')
  })

  test('keeps the persisted edit model, contract and key after runtime configuration drift', async () => {
    const { repository, budget, images, artifacts, media, clock, coordinator } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', imageModel: 'nano-banana-pro',
    }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
      revisionImageModel: 'image-2',
    })
    await coordinator.submit('run-1', 5)
    const originalKey = await revisionImageKey(repository, 2)
    const drifted = new RevisionMediaCoordinator({
      repository,
      media,
      batchBudget: budget,
      artifacts,
      clock,
      revisionImageModel: 'image-3-new-default',
    })

    await expect(drifted.submit('run-1', 5)).resolves.toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })

    expect(await revisionImageKey(repository, 2)).toBe(originalKey)
    expect(images.submitCalls).toBe(1)
    expect(images.requests.get(originalKey)?.model).toBe('image-2')
    expect(budget.batchReservationRequests).toHaveLength(1)
    expect(budget.batchReservationRequests[0]?.model).toBe('image-2')
  })

  test('accepts a controlled V4 repair source within the three-percent 16:9 tolerance', async () => {
    const { repository, images, artifacts, coordinator } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', imageModel: 'nano-banana-pro',
    }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
      revisionImageModel: 'image-2',
    })
    const bytes = new Uint8Array(await sharp({
      create: { width: 1360, height: 768, channels: 3, background: '#FFFFFF' },
    }).png().toBuffer())
    artifacts.artifacts.set('artifact-r0-2', {
      mimeType: 'image/png', bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
    })

    await expect(coordinator.submit('run-1', 5)).resolves.toMatchObject({
      status: 'REVISING', submitted: 1, total: 1,
    })
    const [editKey, editRequest] = [...images.requests.entries()][0]!
    expect(editKey).toContain(':edit:')
    expect(editRequest?.model).toBe('image-2')
    expect(editRequest?.referenceImage?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await revisionImageKey(repository, 2)).toContain(':edit:')
  })

  test('rebuilds every planned V4 page as 16:9 when one edit source exceeds the tolerance', async () => {
    const basePlan = revisionPlan()
    const plan = {
      ...basePlan,
      operations: [
        { ...basePlan.operations[0]!, id: 'operation-page-1', slideId: 'run-1:slide:1' },
        basePlan.operations[0]!,
      ],
    }
    const { repository, images, artifacts, coordinator } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', imageModel: 'nano-banana-pro',
    }, {
      blueprint: visualDeckV4Blueprint(),
      plan,
      revisionImageModel: 'image-2',
    })
    const bytes = new Uint8Array(await sharp({
      create: { width: 1536, height: 1024, channels: 3, background: '#FFFFFF' },
    }).png().toBuffer())
    artifacts.artifacts.set('artifact-r0-2', {
      mimeType: 'image/png', bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
    })

    await expect(coordinator.submit('run-1', 5)).resolves.toMatchObject({
      status: 'REVISING', submitted: 2, total: 2,
    })
    expect([...images.requests.entries()].every(([key, request]) =>
      !key.includes(':edit:') && request.model === 'nano-banana-pro' && !('referenceImage' in request))).toBe(true)
    const rebuiltSteps = (await repository.listSteps('run-1')).filter((step) =>
      step.tool === 'generate_slide_image' && step.idempotencyKey.includes(':r1:v1'))
    expect(rebuiltSteps).toHaveLength(2)
    expect(rebuiltSteps.every((step) => {
      const output = step.output as { operationMode?: unknown; aspectRatio?: unknown }
      return output.operationMode === 'TEXT_TO_IMAGE' && output.aspectRatio === '16:9'
    })).toBe(true)
  })

  test.each([
    ['missing', async (artifacts: MockArtifactPort) => { artifacts.artifacts.delete('artifact-r0-2') }, 'V4_REPAIR_SOURCE_ARTIFACT_MISSING'],
    ['cross-tenant', async (artifacts: MockArtifactPort) => { artifacts.owners.set('artifact-r0-2', 'another-tenant') }, 'V4_REPAIR_SOURCE_ARTIFACT_MISSING'],
    ['sha mismatch', async (artifacts: MockArtifactPort) => {
      const artifact = artifacts.artifacts.get('artifact-r0-2')!
      artifacts.artifacts.set('artifact-r0-2', { ...artifact, sha256: 'b'.repeat(64) })
    }, 'V4_REPAIR_SOURCE_SHA_MISMATCH'],
    ['unsupported mime', async (artifacts: MockArtifactPort) => {
      const artifact = artifacts.artifacts.get('artifact-r0-2')!
      artifacts.artifacts.set('artifact-r0-2', { ...artifact, mimeType: 'image/gif' })
    }, 'V4_REPAIR_SOURCE_MIME_UNSUPPORTED'],
    ['corrupt raster', async (artifacts: MockArtifactPort) => {
      const bytes = new TextEncoder().encode('not an image')
      artifacts.artifacts.set('artifact-r0-2', {
        mimeType: 'image/png', bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }, 'V4_REPAIR_SOURCE_IMAGE_INVALID'],
  ] as const)('rejects a %s controlled source before budget reservation or Provider submission', async (_label, mutate, errorCode) => {
    const { repository, budget, images, artifacts, coordinator } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', imageModel: 'nano-banana-pro',
    }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
      revisionImageModel: 'image-2',
    })
    await mutate(artifacts)

    await expect(coordinator.submit('run-1', 5)).rejects.toThrow(errorCode)
    expect(images.requests.size).toBe(0)
    expect(budget.batchReservationRequests).toHaveLength(0)
    expect((await repository.listSteps('run-1')).some((step) => step.tool === 'generate_image_batch')).toBe(false)
  })

  test('redraws only planned pages and returns the revised deck to page review', async () => {
    const { repository, images, artifacts, renderer, clock, coordinator } = await fixture()
    const submitted = await coordinator.submit('run-1', 5)
    const key = 'run-1:slide:2:image:r1:v1'

    expect(submitted).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(images.operations.size).toBe(1)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 25 })
    images.complete(key, 'artifact-r1-2')
    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 1, total: 1 })

    await repository.transact('run-1', (transaction) => transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'issue.detected',
      payload: {
        id: 'issue-1', category: 'PROVIDER_RESULT_FAILED', severity: 'CRITICAL',
        summary: '第2页原始产物缺失。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
      },
    }))

    const reviewerPort = new MockVisualReviewPort({
      approved: true, textDetected: false, visualScore: 91, reasons: [], retryInstruction: null,
    })
    const reviewer = new VisualReviewRunner({ repository, reviewer: reviewerPort, clock })
    const pages = new PageReviewCoordinator({ repository, reviewer, artifacts, renderer, clock })
    expect(await pages.reviewAll('run-1')).toMatchObject({ status: 'DECK_REVIEW', approved: 4, total: 4 })
    expect(reviewerPort.reviews.size).toBe(4)
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'issue.resolved' && event.payload.issueId === 'issue-1')).toBe(true)
  })

  test('moves a V4 run into technical accounting recovery when another page has no usable artifact', async () => {
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
    })
    await repository.transact('run-1', (transaction) => {
      const missing = transaction.getStep('run-1:slide:1:image:r0:v1')!
      transaction.putStep({ ...missing, status: 'FAILED_CHARGED', errorCode: 'IMAGE_TASK_FAILED', output: null })
    })

    await coordinator.submit('run-1', 5)
    images.complete(await revisionImageKey(repository, 2), 'artifact-r1-2')

    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'RECOVERING', completed: 1, total: 1 })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING',
      revisionRound: 1,
      pendingTerminalFailure: { errorCode: 'TECHNICAL_CONTRACT_INVALID', reason: 'REVISION_FAILED' },
      terminalAccounting: { accountingStatus: 'RECONCILIATION_REQUIRED' },
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'phase.changed'
      && event.payload.to === 'RECOVERING'
      && event.payload.reason === 'TERMINAL_ACCOUNTING_PENDING')).toBe(true)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.some((event) => event.type === 'page_review.started')).toBe(false)
  })

  test('recovers a revision image left in submitting without double-reserving budget', async () => {
    const { repository, images, coordinator } = await fixture()
    await coordinator.submit('run-1', 5)
    const key = await revisionImageKey(repository, 2)
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(key)!
      transaction.putStep({ ...step, status: 'SUBMITTING', externalOperationId: null })
    })

    const recovered = await coordinator.submit('run-1', 5)

    expect(recovered).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(images.operations.size).toBe(1)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 25 })
    expect((await repository.listSteps('run-1')).find((step) => step.idempotencyKey === key))
      .toMatchObject({ status: 'WAITING', externalOperationId: expect.any(String) })
  })

  test('recovers a completed V4 page redraw through revision media without resubmitting it', async () => {
    const { repository, images, media, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
    })
    await coordinator.submit('run-1', 5)
    const key = await revisionImageKey(repository, 2)
    const target = (await repository.listSteps('run-1')).find((step) => step.idempotencyKey === key)!
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: transaction.run.version + 1 })
      transaction.putStep({ ...target, status: 'BILLING_UNKNOWN', errorCode: 'RATE_LIMITED' })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'issue-1', category: 'IMAGE_QUALITY', severity: 'WARNING',
          summary: '待重绘页面的视觉问题保留到重新审查。', slideIds: ['run-1:slide:2'], sourceChunkIds: [], status: 'OPEN',
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: `${target.id}:provider-result`, category: 'PROVIDER_RESULT_FAILED', severity: 'CRITICAL',
          summary: '局部重绘查询遇到临时限流。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
        },
      })
    })
    images.statuses.set(target.externalOperationId!, { state: 'PROCESSING' })
    expect(await media.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 0 })

    images.statuses.set(target.externalOperationId!, { state: 'COMPLETED', artifactId: 'artifact-r1-2' })
    expect(await media.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 1 })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'REVISING' })

    const operationCount = images.operations.size
    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 1, total: 1 })
    expect(images.operations.size).toBe(operationCount)
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'phase.changed' && event.payload.from === 'NEEDS_HUMAN' && event.payload.to === 'REVISING')).toBe(true)
  })

  test('submits and settles planned V4 redraws as one concurrent internal batch', async () => {
    const basePlan = revisionPlan()
    const plan = {
      ...basePlan,
      operations: [
        { ...basePlan.operations[0]!, id: 'operation-page-1', slideId: 'run-1:slide:1', instruction: 'Correct page one.' },
        { ...basePlan.operations[0]!, id: 'operation-page-2', slideId: 'run-1:slide:2', instruction: 'Correct page two.' },
      ],
    }
    const { repository, budget, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan,
      imageConcurrency: 2,
    })
    images.submissionDelayMs = 10

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'REVISING', submitted: 2, total: 2 })
    expect(images.maxConcurrentSubmissions).toBe(2)
    expect(budget.batchReservations.size).toBe(1)
    expect(budget.reservations.size).toBe(0)
    expect((await repository.listSteps('run-1')).find((step) =>
      step.idempotencyKey === 'run-1:revision-generation-batch:r1'))
      .toMatchObject({ status: 'RUNNING', budgetUnits: 10, budgetReservationId: expect.any(String) })

    images.complete(await revisionImageKey(repository, 1), 'artifact-r1-1')
    images.complete(await revisionImageKey(repository, 2), 'artifact-r1-2')
    images.inspectionDelayMs = 10

    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 2, total: 2 })
    expect(images.maxConcurrentInspections).toBe(2)
    expect(budget.batchFinalizations).toEqual([expect.objectContaining({
      idempotencyKey: 'finalize:run-1:revision-generation-batch:r1', settledUnits: 10, releasedUnits: 0,
    })])
    expect((await repository.listSteps('run-1')).find((step) =>
      step.idempotencyKey === 'run-1:revision-generation-batch:r1'))
      .toMatchObject({ status: 'COMPLETED', output: { accounting: { settlement: 'SETTLED', settledUnits: 10 } } })
  })

  test('reconciles a cancelled V4 revision batch without leaving its authorization open', async () => {
    const { repository, budget, images, media, coordinator, generation } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
    })
    await coordinator.submit('run-1', 5)
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
    })
    images.complete(await revisionImageKey(repository, 2), 'artifact-r1-2')

    await media.reconcilePendingRun('run-1')
    expect(await generation.reconcileTerminalGenerationBatch('run-1')).toBe(true)
    expect(await generation.reconcileTerminalGenerationBatch('run-1')).toBe(true)
    expect(budget.batchFinalizations).toEqual([expect.objectContaining({
      idempotencyKey: 'finalize:run-1:revision-generation-batch:r1', settledUnits: 5, releasedUnits: 0,
    })])
    expect(budget.batchFinalizationAttempts).toHaveLength(1)
  })

  test('releases a cancelled V4 revision batch when its interrupted submission was never accepted', async () => {
    const { repository, budget, images, media, coordinator, generation } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
    })
    await coordinator.submit('run-1', 5)
    const key = await revisionImageKey(repository, 2)
    const operationId = images.operations.get(key)!
    images.operations.delete(key)
    images.requests.delete(key)
    images.statuses.delete(operationId)
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(key)!
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
      transaction.putStep({ ...step, status: 'SUBMITTING', externalOperationId: null })
    })

    expect(await media.reconcilePendingRun('run-1')).toMatchObject({ inspected: 1, changed: 1 })
    expect(await generation.reconcileTerminalGenerationBatch('run-1')).toBe(true)
    expect((await repository.listSteps('run-1')).find((step) => step.idempotencyKey === key))
      .toMatchObject({ status: 'FAILED_NOT_CHARGED', errorCode: 'PROVIDER_SUBMISSION_NOT_FOUND' })
    expect(budget.batchFinalizations).toEqual([expect.objectContaining({
      idempotencyKey: 'finalize:run-1:revision-generation-batch:r1', settledUnits: 0, releasedUnits: 5,
    })])
  })

  test('recovers an interrupted unsubmitted V4 redraw without another authorization', async () => {
    const { repository, budget, images, media, coordinator, clock } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
    })
    await coordinator.submit('run-1', 5)
    const key = await revisionImageKey(repository, 2)
    const operationId = images.operations.get(key)!
    images.operations.delete(key)
    images.requests.delete(key)
    images.statuses.delete(operationId)
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(key)!
      transaction.putStep({ ...step, status: 'SUBMITTING', externalOperationId: null })
    })

    expect(await media.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 1 })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'RECOVERING' })
    expect(budget.batchReservations.size).toBe(1)
    clock.advance(2_000)
    await repository.transact('run-1', (transaction) => resumeTechnicalRecovery(transaction, clock))

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(images.operations.has(key)).toBe(true)
    expect(budget.batchReservations.size).toBe(1)
  })

  test('keeps a failed revision-batch finalization internal to the V4 event contract', async () => {
    const { repository, budget, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
    })
    await coordinator.submit('run-1', 5)
    images.complete(await revisionImageKey(repository, 2), 'artifact-r1-2')
    budget.failNextSettlement('HOST_FINALIZE_UNAVAILABLE')

    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'RECOVERING', completed: 1, total: 1 })
    expect((await repository.listEvents('run-1')).filter((event) => event.type === 'generation.batch.updated')).toEqual([])
  })

  test('pauses before any redraw when the remaining budget is insufficient', async () => {
    const { repository, images, coordinator } = await fixture({
      budgetUnits: 20,
      committedBudgetUnits: 20,
      presentationMode: 'VISUAL_DECK_V4',
    })
    const result = await coordinator.submit('run-1', 5)

    expect(result).toMatchObject({ status: 'PAUSED', submitted: 0, total: 1 })
    expect(images.operations.size).toBe(0)
    expect((await repository.listEvents('run-1')).find((event) => event.type === 'run.paused')).toMatchObject({
      payload: {
        presentationMode: 'VISUAL_DECK_V4', stage: 'RUN', reason: 'BUDGET_INSUFFICIENT',
        retryable: true, requiresUserAction: true, nextAction: 'ADD_BUDGET',
      },
    })
  })

  test('redraws one v3 element using the canonical strategy-aware asset key', async () => {
    const { images, coordinator } = await fixture({}, {
      blueprint: layeredBlueprint(),
      plan: layeredRevisionPlan(),
    })

    const result = await coordinator.submit('run-1', 5)

    expect(result).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(images.operations.size).toBe(1)
    expect([...images.requests.values()][0]).toMatchObject({
      backgroundMode: 'TRANSPARENT',
      prompt: expect.stringContaining('transparent leaf'),
    })
  })

  test('redraws a v4 page with the complete approved brief plus the review correction', async () => {
    const base = visualDeckV4Blueprint()
    const brief = base.visualDeckV4Proposal!.slideBriefs[1]!
    brief.lockedCopy = [...brief.lockedCopy, '权威对象总数：12；6+6=12']
    brief.facts = Array.from(
      { length: 12 },
      (_, index) => `${index === 11 ? '最后一条权威对象总数事实：12' : `来源事实 ${index + 1}`}：${
        '绿色植物利用光能制造有机物并释放氧气。'.repeat(20)
      }`.slice(0, 400),
    )
    brief.numbers = ['12']
    brief.formulas = ['6+6=12']
    const revision = {
      ...revisionPlan(),
      operations: Array.from({ length: 50 }, (_, index) => ({
        ...revisionPlan().operations[0]!,
        id: `operation-${index + 1}`,
        instruction: `Correction ${index + 1}: remove extra mark`,
        sourceChunkIds: ['chunk-1'],
      })),
    }
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: base,
      plan: revision,
    })

    await coordinator.submit('run-1', 5)

    const request = [...images.requests.values()][0]
    expect(request?.prompt).toContain('Edit the attached source slide in place')
    expect(request?.prompt).toContain(base.visualDeckV4Proposal!.slideBriefs[1]!.title)
    expect(request?.prompt).toContain('Correction 1')
    expect(request?.prompt).toContain('Correction 50')
    expect(request?.prompt).toContain('最后一条权威对象总数事实：12')
    expect(request?.prompt).toContain('Numbers that must remain exact: 12')
    expect(request?.prompt).toContain('Formulas that must remain exact: 6+6=12')
    expect(request?.prompt).toContain('COUNTABLE OBJECT SAFETY')
    expect(request?.prompt).toContain('Do not invent any additional labels')
    expect(request?.prompt).toContain('Visible text that must remain exact')
    expect(request?.negativePrompt).toContain('facts-field prose')
    expect(request?.prompt.length).toBeLessThanOrEqual(V4_REVISION_PROMPT_MAX_LENGTH)
    images.complete(await revisionImageKey(repository, 2), 'artifact-r1-2')
    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 1, total: 1 })
    const lifecycle = (await repository.listEvents('run-1'))
      .filter((event) => event.type === 'revision.progress' || event.type === 'revision.completed'
        || event.type === 'page_review.started')
    expect(lifecycle.map((event) => event.type)).toEqual([
      'revision.progress', 'revision.completed', 'page_review.started',
    ])
    expect(lifecycle[1]).toMatchObject({
      payload: { revisionKind: 'DECK_VISUAL', pageNumbers: [2], completed: 1, total: 1 },
    })
  })

  test('rejects oversized v4 correction instructions before any paid redraw', async () => {
    const revision = {
      ...revisionPlan(),
      operations: [
        {
          ...revisionPlan().operations[0]!, id: 'operation-a',
          instruction: `${'A'.repeat(1_950)} KEEP_REQUIREMENT_A`,
        },
        {
          ...revisionPlan().operations[0]!, id: 'operation-b',
          instruction: `${'B'.repeat(1_950)} KEEP_REQUIREMENT_B`,
        },
        {
          ...revisionPlan().operations[0]!, id: 'operation-c',
          instruction: `${'C'.repeat(1_950)} KEEP_REQUIREMENT_C`,
        },
      ],
    }
    const { images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revision,
    })

    expect(coordinator.submit('run-1', 5)).rejects.toThrow('V4_REVISION_INSTRUCTION_BUDGET_EXCEEDED')
    expect(images.operations.size).toBe(0)
  })

  test('redraws a v4 page after a source-grounded content correction', async () => {
    const base = visualDeckV4Blueprint()
    const correction = 'Correct the teaching claim from the cited source and redraw the complete page.'
    const revision = {
      ...revisionPlan(),
      operations: [{
        ...revisionPlan().operations[0]!,
        kind: 'UPDATE_CONTENT' as const,
        instruction: correction,
        sourceChunkIds: ['chunk-1'],
      }],
    }
    const { images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: base,
      plan: revision,
    })

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ submitted: 1, total: 1 })
    expect([...images.requests.values()][0]?.prompt).toContain(correction)
  })

  test('carries prior page-review corrections into a later v4 redraw', async () => {
    const currentCorrection = 'Move the teaching objects upward and preserve the approved composition.'
    const priorCorrection = 'Remove the unauthorized Arabic numeral and keep the Chinese copy exact.'
    const revision = {
      ...revisionPlan(),
      operations: [{ ...revisionPlan().operations[0]!, instruction: currentCorrection }],
    }
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revision,
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-prior-page-review', runId: 'run-1',
        idempotencyKey: 'run-1:slide:2:image:r0:v1:review', inputHash: 'prior-review-hash',
        tool: 'review_slide_image', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null,
        output: {
          approved: false, textDetected: true, visualScore: 62,
          reasons: ['页面出现未允许的阿拉伯数字。'], retryInstruction: priorCorrection,
        },
        createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
      })
      transaction.putStep({
        id: 'step-unrelated-page-review', runId: 'run-1',
        idempotencyKey: 'run-1:slide:1:image:r0:v1:review', inputHash: 'unrelated-review-hash',
        tool: 'review_slide_image', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null,
        output: {
          approved: false, textDetected: false, visualScore: 70,
          reasons: ['第一页需要调整。'], retryInstruction: 'Unrelated page-one correction must not trigger a redraw.',
        },
        createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
      })
    })

    await coordinator.submit('run-1', 5)

    const prompt = [...images.requests.values()][0]?.prompt
    expect(prompt).toContain(priorCorrection)
    expect(prompt).toContain(currentCorrection)
    expect(prompt).not.toContain('Unrelated page-one correction')
    expect(images.operations.size).toBe(1)
  })

  test('carries prior deck-review correction operations into a later v4 redraw', async () => {
    const priorCorrection = 'Keep the two-part teaching board consistent across the sequence.'
    const currentCorrection = 'Remove the redundant number rail while preserving the teaching board.'
    const priorPlan = {
      ...revisionPlan(),
      operations: [{ ...revisionPlan().operations[0]!, kind: 'RELAYOUT' as const, instruction: priorCorrection }],
    }
    const { repository, images, coordinator } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', revisionRound: 2, maxRevisionRounds: 4,
    }, {
      blueprint: visualDeckV4Blueprint(),
      plan: priorPlan,
    })
    const currentPlan = {
      ...revisionPlan(),
      id: 'plan-r2', reviewId: 'review-r1', revisionRound: 2,
      operations: [{ ...revisionPlan().operations[0]!, id: 'operation-r2', instruction: currentCorrection }],
    }
    await repository.transact('run-1', (transaction) => {
      const now = transaction.run.updatedAt
      transaction.putStep({
        id: 'apply-r2', runId: 'run-1', idempotencyKey: revisionBlueprintStepKey('run-1', 2),
        inputHash: 'hash-apply-r2', tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: visualDeckV4Blueprint(), createdAt: now, updatedAt: now,
      })
      transaction.putStep({
        id: 'revision-plan-r2', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 2),
        inputHash: 'hash-revision-plan-r2', tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: currentPlan, createdAt: now, updatedAt: now,
      })
      transaction.putStep({
        id: 'future-page-review-r4', runId: 'run-1',
        idempotencyKey: 'run-1:slide:2:image:r4:v1:review', inputHash: 'future-page-review-r4',
        tool: 'review_slide_image', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null,
        output: {
          approved: false, textDetected: false, visualScore: 50, reasons: ['未来轮孤儿记录。'],
          retryInstruction: 'FUTURE ROUND FOUR INSTRUCTION MUST NOT APPEAR',
        },
        createdAt: now, updatedAt: now,
      })
    })

    await coordinator.submit('run-1', 5)

    const prompt = [...images.requests.values()][0]?.prompt
    expect(prompt).toContain(priorCorrection)
    expect(prompt).toContain(currentCorrection)
    expect(prompt).not.toContain('FUTURE ROUND FOUR INSTRUCTION')
  })

  test('preserves four full page-review instructions without truncating their tails', async () => {
    const currentCorrection = `${'D'.repeat(970)} CURRENT_TAIL`
    const revision = {
      ...revisionPlan(),
      operations: [{ ...revisionPlan().operations[0]!, instruction: currentCorrection }],
    }
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revision,
    })
    await repository.transact('run-1', (transaction) => {
      for (const [index, marker] of ['FIRST_TAIL', 'SECOND_TAIL', 'THIRD_TAIL'].entries()) {
        transaction.putStep({
          id: `step-prior-review-${index}`, runId: 'run-1',
          idempotencyKey: `run-1:slide:2:image:r0:v1:review:${index}`, inputHash: `review-${index}`,
          tool: 'review_slide_image', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
          externalOperationId: null, errorCode: null,
          output: {
            approved: false, textDetected: false, visualScore: 60, reasons: ['需要继续修订。'],
            retryInstruction: `${String.fromCharCode(65 + index).repeat(970)} ${marker}`,
          },
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        })
      }
    })

    await coordinator.submit('run-1', 5)

    const prompt = [...images.requests.values()][0]?.prompt ?? ''
    for (const marker of ['FIRST_TAIL', 'SECOND_TAIL', 'THIRD_TAIL', 'CURRENT_TAIL']) {
      expect(prompt).toContain(marker)
    }
  })

  test('moves a v4 revision to technical recovery when the redraw provider route is unavailable', async () => {
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
    })
    images.failNext('NO_HEALTHY_ROUTE_BEFORE_SUBMIT', 'NOT_SUBMITTED')

    await coordinator.submit('run-1', 5)
    const result = await coordinator.refresh('run-1')

    expect(result.status).toBe('RECOVERING')
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'RECOVERING' })
    expect((await repository.listEvents('run-1')).find((event) => event.type === 'revision.completed'))
      .toMatchObject({
        payload: {
          reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE', retryable: true,
          requiresUserAction: false, nextAction: null,
        },
      })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'technical.recovery.started')).toBe(true)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('resubmits a confirmed-unsubmitted V4 redraw after recovery with the original image key', async () => {
    const { repository, images, clock, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
    })
    images.failNext('NO_HEALTHY_ROUTE_BEFORE_SUBMIT', 'NOT_SUBMITTED')

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'RECOVERING', submitted: 1, total: 1 })
    const key = await revisionImageKey(repository, 2)
    expect(images.operations.size).toBe(0)
    clock.advance(2_000)
    await repository.transact('run-1', (transaction) => resumeTechnicalRecovery(transaction, clock))

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(images.operations.get(key)).toBeDefined()
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 25, status: 'REVISING' })
  })

  test('ends a v4 revision once in technical recovery when the provider rejects a submitted redraw', async () => {
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
    })
    await coordinator.submit('run-1', 5)
    images.fail(await revisionImageKey(repository, 2), 'PROVIDER_REJECTED', 'UNKNOWN')

    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'RECOVERING', completed: 0 })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING',
      committedBudgetUnits: 25,
      pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
      terminalAccounting: { accountingStatus: 'RECONCILIATION_REQUIRED' },
    })
    const events = await repository.listEvents('run-1')
    const lifecycle = events
      .filter((event) => event.type.startsWith('revision.'))
    expect(lifecycle.filter((event) => event.type === 'revision.completed')).toHaveLength(1)
    expect(lifecycle.at(-1)).toMatchObject({
      type: 'revision.completed',
      payload: { reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE', retryable: false },
    })
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('fails closed when a v4 redraw receives an unknown provider error code', async () => {
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
    })
    await coordinator.submit('run-1', 5)
    images.fail(await revisionImageKey(repository, 2), 'INVALID_REQUEST', 'UNKNOWN')

    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'RECOVERING', completed: 0 })
    const events = await repository.listEvents('run-1')
    expect(events).toContainEqual(expect.objectContaining({
      type: 'technical.recovery.completed',
      payload: expect.objectContaining({ reason: 'INVALID_REQUEST', retryable: false, active: false }),
    }))
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })
})

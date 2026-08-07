import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockArtifactPort } from '../src/adapters/mock-ports'
import { hashInput } from '../src/core/hash'
import { revisionBlueprintStepKey } from '../src/core/active-blueprint'
import { deliveryStepKey } from '../src/core/delivery-runner'
import { planningStepKey } from '../src/core/planning-runner'
import { revisionPlanStepKey } from '../src/core/revision-planning-runner'
import { RunService, RunServiceError } from '../src/core/run-service'
import { appendV4LifecycleEvent, v4LifecyclePayload } from '../src/core/v4-lifecycle'
import { parseProviderBillingCatalog } from '../src/adapters/provider-billing-catalog'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { enqueueUsageV2RunFinalization } from '../src/core/usage-v2-coordinator'
import type { UsageRunBill } from '../src/usage-accounting-contracts'
import { V4ModelPolicy } from '../src/core/v4-model-policy'

const host = { tenantId: 'frameflow', externalUserId: 'user-1' }
const request = {
  schemaVersion: CONTRACT_VERSION,
  host,
  source: { kind: 'TEXT', name: '教材.txt', text: '这是用于创建独立 PPT Agent Run 的完整教材内容。'.repeat(4) },
  slideCount: 2,
  visualDirection: '清晰的课堂科学信息图风格',
  imageModel: 'gpt-image-2',
  automationLevel: 'SUPERVISED',
  budgetUnits: 100,
} as const

function usageV2Catalog(model = 'gpt-image-2') {
  return parseProviderBillingCatalog(JSON.stringify({ schemaVersion: '1', entries: [{
    model, operationMode: 'TEXT_TO_IMAGE', resolution: '1K', costBasis: 'FIXED_PER_OPERATION',
    costAmountMicros: 40_000, currency: 'USD', providerPricingVersion: `${model}-2026-08`,
  }] }))
}

function blueprint() {
  return {
    id: 'blueprint-1',
    title: '光合作用',
    visualDirection: request.visualDirection,
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物',
      grade: '七年级',
      lessonTitle: '光合作用',
      sourceSummary: '教材说明绿色植物利用光能制造有机物并释放氧气的过程。',
      learningObjectives: ['理解光合作用的主要条件与产物'],
      scopeBoundaries: ['仅覆盖教材中的定性知识'],
      prohibitedExtensions: [],
      sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: `第 ${pageNumber} 页`,
      body: ['教材范围内的教学内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: '用清晰的科学课堂画面支持当前知识点',
      visualPrompt: 'A clean educational science illustration with no text, letters, numbers, logos or watermark',
      sourceChunkIds: ['chunk-1'],
    })),
  }
}

function visualDeckV4Blueprint(runId: string) {
  const source = {
    kind: 'TEXT' as const,
    name: '教材.txt',
    text: '把五只小鸟分成两个非空组，记录每一种分法，并检查两组合起来仍然是五只。'.repeat(8),
  }
  return createVisualDeckV4Blueprint({
    runId,
    inputHash: 'v4-quality-recovery-plan-hash',
    source,
    document: {
      name: source.name,
      chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
      isComplete: true,
      missingRanges: [],
    },
    config: {
      instruction: '制作两页讲解五以内数的分与合的课堂视觉 PPT',
      sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 }, aspectRatio: '16:9',
        audience: '幼儿园大班学生', focus: '理解 5 的分与合', styleHint: '明亮清晰的儿童课堂信息图',
      },
    },
    slideCount: 2,
    visualDirection: '明亮清晰的儿童课堂信息图',
    createdAt: '2026-08-03T00:00:00.000Z',
  })
}

function fixture() {
  const repository = new InMemoryAgentRepository()
  const artifacts = new MockArtifactPort()
  const clock = new FixedClock()
  return { repository, artifacts, clock, service: new RunService({ repository, artifacts, clock }) }
}

type QualityRecoveryImageFault =
  | 'NULL_OUTPUT' | 'CROSS_PAGE' | 'WRONG_VERSION' | 'MISSING_ARTIFACT' | 'DUPLICATE_ARTIFACT'
  | 'NON_IMAGE' | 'EMPTY_ARTIFACT' | 'SHA_MISMATCH'

async function failedV4QualityRecoveryFixture(input: Readonly<{
  imageFault?: QualityRecoveryImageFault
  usageFinalization?: 'ACKNOWLEDGED' | 'REVIEW_REQUIRED'
}> = {}) {
  const { repository, artifacts, clock, service } = fixture()
  const created = await service.create({
    ...request,
    presentationMode: 'VISUAL_DECK_V4',
    automationLevel: 'BOUNDED_AUTO',
    maxRevisionRounds: 0,
    budgetUnits: 2,
    visualDeckV4: {
      instruction: '根据教材自动制作完整课堂演示文稿',
      sourceMode: 'SOURCE_GROUNDED',
      deckOptions: { length: { slideCount: 2 }, aspectRatio: '16:9' },
    },
  }, `frameflow-v4-quality-recovery-${input.imageFault ?? 'valid'}-${input.usageFinalization ?? 'v1'}`)
  const planned = visualDeckV4Blueprint(created.run.id)
  const imageArtifacts = await Promise.all([1, 2].map((pageNumber) => artifacts.put({
    tenantId: 'frameflow',
    runId: created.run.id,
    name: `quality-recovery-${pageNumber}.png`,
    mimeType: 'image/png',
    bytes: new TextEncoder().encode(`quality-recovery-image-${pageNumber}`),
    idempotencyKey: `${created.run.id}:quality-recovery-artifact:${pageNumber}`,
  })))
  const firstStoredArtifact = artifacts.artifacts.get(imageArtifacts[0]!.artifactId)!
  if (input.imageFault === 'NON_IMAGE') firstStoredArtifact.mimeType = 'text/plain'
  if (input.imageFault === 'EMPTY_ARTIFACT') firstStoredArtifact.bytes = new Uint8Array()
  if (input.imageFault === 'SHA_MISMATCH') firstStoredArtifact.sha256 = '0'.repeat(64)
  const terminalAccounting = {
    authorizedUnits: 2, submittedUnits: 2, settledUnits: 2,
    releasedUnits: 0, reconciliationUnits: 0, accountingStatus: 'FINAL' as const,
  }
  await repository.transact(created.run.id, (transaction) => {
    transaction.putStep({
      id: 'step-v4-quality-recovery-plan', runId: created.run.id,
      idempotencyKey: planningStepKey(created.run.id), inputHash: 'v4-quality-recovery-plan-hash',
      tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: planned,
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    for (const pageNumber of [1, 2]) {
      const validOutput = {
        slideId: `${created.run.id}:slide:${pageNumber}`,
        versionId: `${created.run.id}:slide:${pageNumber}:r0:v1`,
        artifactId: imageArtifacts[pageNumber - 1]!.artifactId,
      }
      const output = pageNumber !== 1 ? validOutput
        : input.imageFault === 'NULL_OUTPUT' ? null
          : input.imageFault === 'CROSS_PAGE' ? { ...validOutput, slideId: `${created.run.id}:slide:2` }
            : input.imageFault === 'WRONG_VERSION' ? { ...validOutput, versionId: `${created.run.id}:slide:1:r1:v1` }
              : input.imageFault === 'MISSING_ARTIFACT' ? { ...validOutput, artifactId: 'artifact-missing' }
                : input.imageFault === 'DUPLICATE_ARTIFACT'
                  ? { ...validOutput, artifactId: imageArtifacts[1]!.artifactId }
                : validOutput
      transaction.putStep({
        id: `step-v4-quality-recovery-image-${pageNumber}`, runId: created.run.id,
        idempotencyKey: `${created.run.id}:slide:${pageNumber}:image:r0:v1`,
        inputHash: `v4-quality-recovery-image-${pageNumber}`, tool: 'generate_slide_image',
        status: 'COMPLETED', budgetUnits: 1, budgetReservationId: 'reservation-v4-quality-recovery',
        externalOperationId: `operation-v4-quality-recovery-${pageNumber}`, errorCode: null, output,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    }
    transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'issue.detected',
      payload: {
        id: 'v4-quality-recovery-page-issue', category: 'IMAGE_QUALITY', severity: 'WARNING',
        summary: '第二页构图仍有可优化空间。', slideIds: [`${created.run.id}:slide:2`],
        sourceChunkIds: [], status: 'OPEN',
      },
    })
    const failed = {
      ...transaction.run,
      ...(input.usageFinalization ? { accountingProtocol: 'FRAMEFLOW_USAGE_V2' as const } : {}),
      status: 'FAILED' as const,
      version: 7,
      committedBudgetUnits: 2,
      terminalAccounting,
    }
    transaction.putRun(failed)
    transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'run.failed',
      payload: {
        ...v4LifecyclePayload(failed, 'RUN', {
          completed: 0, total: 1, pageNumbers: [1, 2], reason: 'REVISION_LIMIT_REACHED', retryable: false,
        }),
        errorCode: 'QUALITY_REMEDIATION_EXHAUSTED',
        terminalAccounting,
      },
    })
    if (input.usageFinalization) {
      const finalization = enqueueUsageV2RunFinalization(transaction, clock)!
      const acknowledged = input.usageFinalization === 'ACKNOWLEDGED'
      transaction.putStep({
        ...finalization,
        status: acknowledged ? 'COMPLETED' : 'FAILED',
        errorCode: acknowledged ? null : 'HOST_USAGE_V2_REVIEW_REQUIRED',
        output: {
          ...(finalization.output as Record<string, unknown>),
          deliveryState: acknowledged ? 'ACKNOWLEDGED' : 'REVIEW_REQUIRED',
          ...(acknowledged ? { bill: settledUsageV2Bill(created.run.id) } : {}),
        },
      })
    }
  })
  return { repository, artifacts, clock, service, runId: created.run.id, expectedVersion: 7 }
}

function settledUsageV2Bill(runId: string): UsageRunBill {
  return {
    pptRunId: runId,
    authorizationReservationId: 'authorization-quality-recovery',
    accountingMode: 'USAGE_V2',
    status: 'SETTLED',
    authorizationCapMilli: 20_000,
    authorizedModel: 'gpt-image-2',
    authorizedUnits: 2,
    pricingVersion: 'ppt-image-v1',
    unitPriceMilli: 10_000,
    providerSpendSafetyCapOperations: 2,
    generatedOperations: 2,
    chargedOperations: 2,
    notChargedOperations: 0,
    unknownOperations: 0,
    chargeableMilli: 20_000,
    settledMilli: 20_000,
    releasedMilli: 0,
    providerCosts: [],
    lastEventSequence: 2,
    lastEventAt: '2026-08-03T00:00:00.000Z',
    settledAt: '2026-08-03T00:00:00.000Z',
    firstUnknownAt: null,
    reconciliationAttempts: 0,
    nextReconcileAt: null,
    reconciliationDeadlineAt: null,
    reconciliationLastError: null,
  }
}

describe('run service', () => {
  test('rejects unpublished image models only for new V4 Runs and preserves exact replay', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    const allowed = new RunService({
      repository,
      clock,
      v4ModelPolicy: new V4ModelPolicy({
        runtimeMode: 'GATEWAY', textModels: ['text'], visionModels: ['vision'], imageModels: ['gpt-image-2'],
      }),
    })
    const v4Request = {
      ...request,
      presentationMode: 'VISUAL_DECK_V4' as const,
      visualDeckV4: {
        instruction: '根据来源生成两页演示', sourceMode: 'SOURCE_GROUNDED' as const,
        deckOptions: { length: { slideCount: 2 }, aspectRatio: '16:9' as const },
      },
    }
    const created = await allowed.create(v4Request, 'v4-model-policy-create-0001')
    const restricted = new RunService({
      repository,
      clock,
      v4ModelPolicy: new V4ModelPolicy({
        runtimeMode: 'GATEWAY', textModels: ['text'], visionModels: ['vision'], imageModels: ['other-image'],
      }),
    })

    await expect(restricted.create(v4Request, 'v4-model-policy-create-0001'))
      .resolves.toMatchObject({ replayed: true, run: { id: created.run.id } })
    await expect(restricted.create(v4Request, 'v4-model-policy-create-0002'))
      .rejects.toMatchObject({ status: 422, code: 'V4_IMAGE_MODEL_NOT_ALLOWED' })
  })
  test('creates and safely replays a host-scoped Run', async () => {
    const { repository, service } = fixture()
    const first = await service.create(request, 'frameflow-create-0001')
    const replay = await service.create(request, 'frameflow-create-0001')

    expect(first).toMatchObject({ replayed: false, run: { status: 'PLANNING', slideCount: 2, budgetUnits: 100 } })
    expect(replay).toMatchObject({ replayed: true, run: { id: first.run.id } })
    expect(await repository.listRuns()).toHaveLength(1)
    expect((await repository.listEvents(first.run.id)).map((event) => event.type)).toEqual(['run.started'])
  })

  test('freezes Usage V2 only onto new FrameFlow V4 Runs and never drifts on replay', async () => {
    const repository = new InMemoryAgentRepository()
    const v2Service = new RunService({
      repository,
      clock: new FixedClock(),
      defaultAccountingProtocol: 'FRAMEFLOW_USAGE_V2',
      providerBillingCatalog: usageV2Catalog(),
    })
    const v4Request = {
      ...request,
      presentationMode: 'VISUAL_DECK_V4' as const,
      automationLevel: 'BOUNDED_AUTO' as const,
      visualDeckV4: {
        instruction: '根据教材自动制作完整课堂演示文稿',
        sourceMode: 'SOURCE_GROUNDED' as const,
        deckOptions: { length: { slideCount: 2 as const }, aspectRatio: '16:9' as const },
      },
    }

    const v2 = await v2Service.create(v4Request, 'frameflow-v2-create-0001')
    const legacyMode = await v2Service.create(request, 'frameflow-legacy-create-0001')
    const otherHost = await v2Service.create({
      ...v4Request,
      host: { tenantId: 'shanhai', externalUserId: 'task-1' },
    }, 'shanhai-v4-create-0001')
    const restartedWithLegacyDefault = new RunService({
      repository,
      clock: new FixedClock(),
      defaultAccountingProtocol: 'LEGACY_RESERVATION_V1',
    })
    const replay = await restartedWithLegacyDefault.create(v4Request, 'frameflow-v2-create-0001')

    expect(v2.run.accountingProtocol).toBe('FRAMEFLOW_USAGE_V2')
    expect(legacyMode.run.accountingProtocol).toBe('LEGACY_RESERVATION_V1')
    expect(otherHost.run.accountingProtocol).toBe('LEGACY_RESERVATION_V1')
    expect(replay).toMatchObject({ replayed: true, run: { accountingProtocol: 'FRAMEFLOW_USAGE_V2' } })
  })

  test('creates the Usage V2 finalization outbox atomically when a V4 Run is cancelled', async () => {
    const repository = new InMemoryAgentRepository()
    const service = new RunService({
      repository, clock: new FixedClock(), defaultAccountingProtocol: 'FRAMEFLOW_USAGE_V2',
      providerBillingCatalog: usageV2Catalog(),
    })
    const created = await service.create({
      ...request,
      presentationMode: 'VISUAL_DECK_V4',
      automationLevel: 'BOUNDED_AUTO',
      visualDeckV4: {
        instruction: '根据教材自动制作完整课堂演示文稿',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: { length: { slideCount: 2 }, aspectRatio: '16:9' },
      },
    }, 'frameflow-v2-cancel-create-0001')

    await expect(service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION, type: 'CANCEL', expectedVersion: 0,
      reason: '用户终止当前生成任务。',
    }, 'frameflow-v2-cancel-action-0001')).resolves.toMatchObject({ status: 'CANCELLED' })

    expect((await repository.listSteps(created.run.id)).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({
        status: 'RUNNING', idempotencyKey: `${created.run.id}:usage-v2:finalize`,
        output: { idempotencyKey: `finalize:${created.run.id}`, deliveryState: 'PENDING' },
      })
    expect(await repository.getTerminalEvent(created.run.id)).toMatchObject({ type: 'run.cancelled' })
  })

  test('rejects a new Usage V2 Run before planning when its initial image cost profile is missing', async () => {
    const repository = new InMemoryAgentRepository()
    const service = new RunService({
      repository,
      clock: new FixedClock(),
      defaultAccountingProtocol: 'FRAMEFLOW_USAGE_V2',
      providerBillingCatalog: usageV2Catalog('another-model'),
    })

    await expect(service.create({
      ...request,
      presentationMode: 'VISUAL_DECK_V4',
      automationLevel: 'BOUNDED_AUTO',
      visualDeckV4: {
        instruction: '根据教材自动制作完整课堂演示文稿',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: { length: { slideCount: 2 }, aspectRatio: '16:9' },
      },
    }, 'frameflow-v2-missing-cost-profile')).rejects.toMatchObject({
      status: 503,
      code: 'USAGE_V2_PROVIDER_BILLING_PROFILE_NOT_FOUND',
    })
    expect(await repository.listRuns()).toHaveLength(0)
  })

  test('uses the configured tenant revision-round setting over caller input', async () => {
    const { repository, service } = fixture()
    await repository.updateTenantRevisionRoundsSettings({
      tenantId: host.tenantId,
      maxRevisionRounds: 4,
      expectedVersion: 0,
      updatedBy: 'admin-1',
      updatedAt: '2026-08-02T00:00:00.000Z',
    })

    const inherited = await service.create(request, 'frameflow-create-settings-default')
    const explicit = await service.create({ ...request, maxRevisionRounds: 1 }, 'frameflow-create-settings-explicit')

    expect(inherited.run.maxRevisionRounds).toBe(4)
    expect(explicit.run.maxRevisionRounds).toBe(4)
  })

  test('rejects a changed request under the same creation key', async () => {
    const { service } = fixture()
    await service.create(request, 'frameflow-create-0001')

    await expect(service.create({ ...request, slideCount: 3 }, 'frameflow-create-0001'))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' })
  })

  test('hides runs across host ownership boundaries', async () => {
    const { service } = fixture()
    const created = await service.create(request, 'frameflow-create-0001')

    await expect(service.getOwned(created.run.id, { tenantId: 'frameflow', externalUserId: 'user-2' }))
      .rejects.toBeInstanceOf(RunServiceError)
    expect(await service.listOwnedPage(
      { tenantId: 'shanhaiedu', externalUserId: 'user-1' },
      { after: null, limit: 20 },
    )).toEqual({ runs: [], hasMore: false })
  })

  test('requires a completed persisted blueprint before approval', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
    })
    await expect(service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'APPROVE_BLUEPRINT',
      expectedVersion: 1,
    }, 'approve-blueprint-0001')).rejects.toMatchObject({ status: 409, code: 'BLUEPRINT_NOT_READY' })

    await repository.transact(created.run.id, (transaction) => {
      const key = planningStepKey(created.run.id)
      transaction.putStep({
        id: 'step-plan-1',
        runId: created.run.id,
        idempotencyKey: key,
        inputHash: hashInput({ blueprint: 1 }),
        tool: 'create_blueprint',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: blueprint(),
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })
    const approved = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'APPROVE_BLUEPRINT',
      expectedVersion: 1,
    }, 'approve-blueprint-0001')
    expect(approved).toMatchObject({ status: 'EXECUTING', version: 2 })
    expect((await repository.listEvents(created.run.id)).map((event) => event.type)).toContain('approval.resolved')
  })

  test('approves the completed blueprint from the current planning retry', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-retry-approval-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        status: 'AWAITING_BLUEPRINT_APPROVAL',
        planningAttempt: 1,
        version: 3,
      })
      transaction.putStep({
        id: 'step-plan-retry-1',
        runId: created.run.id,
        idempotencyKey: planningStepKey(created.run.id, 1),
        inputHash: hashInput({ blueprint: 'retry-1' }),
        tool: 'create_blueprint',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: blueprint(),
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })

    const approved = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'APPROVE_BLUEPRINT',
      expectedVersion: 3,
    }, 'approve-retry-blueprint-0001')

    expect(approved).toMatchObject({ status: 'EXECUTING', planningAttempt: 1, version: 4 })
  })

  test('persists the actor and reason for manual quality override', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: 1 })
      transaction.putStep({
        id: 'step-plan-override', runId: created.run.id, idempotencyKey: planningStepKey(created.run.id),
        inputHash: 'plan-override-hash', tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null, output: blueprint(),
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'issue-visual-1', category: 'VISUAL_CONSISTENCY', severity: 'WARNING',
          summary: '第二页插画风格与封面略有差异。', slideIds: [`${created.run.id}:slide:2`],
          sourceChunkIds: [], status: 'OPEN', repairDomain: 'ASSET',
        },
      })
    })
    const reason = '教师已逐页复核事实风险并明确接受当前交付结果。'
    const accepted = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'ACCEPT_WITH_OVERRIDE',
      expectedVersion: 1,
      reason,
      issueIds: ['issue-visual-1'],
    }, 'quality-override-0001')

    expect(accepted).toMatchObject({
      status: 'DELIVERING',
      qualityOverride: true,
      qualityOverrideReason: reason,
      qualityOverrideBy: 'user-1',
      qualityOverrideRole: 'USER',
      qualityOverrideIssueIds: ['issue-visual-1'],
    })
    expect((await repository.listEvents(created.run.id)).some((event) =>
      event.type === 'issue.resolved' && event.payload.issueId === 'issue-visual-1')).toBe(true)
  })

  test('blocks ordinary users from overriding critical teaching issues and requires a blueprint', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-critical-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: 1 })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'issue-factual-1', category: 'FACTUAL_RISK', severity: 'CRITICAL',
          summary: '课件中的核心事实与教材来源不一致。', slideIds: [], sourceChunkIds: ['chunk-1'], status: 'OPEN',
          repairDomain: 'KNOWLEDGE',
        },
      })
    })
    const action = {
      schemaVersion: CONTRACT_VERSION,
      type: 'ACCEPT_WITH_OVERRIDE',
      expectedVersion: 1,
      reason: '管理员已逐项阅读风险声明并承担本次内容审批责任。',
      issueIds: ['issue-factual-1'],
    } as const

    await expect(service.act(created.run.id, host, action, 'critical-override-user-0001'))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERY_BLUEPRINT_REQUIRED' })

    await repository.transact(created.run.id, (transaction) => {
      transaction.putStep({
        id: 'step-plan-critical', runId: created.run.id, idempotencyKey: planningStepKey(created.run.id),
        inputHash: 'plan-critical-hash', tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null, output: blueprint(),
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })
    await expect(service.act(created.run.id, host, action, 'critical-override-user-0002'))
      .rejects.toMatchObject({ status: 403, code: 'QUALITY_OVERRIDE_ADMIN_REQUIRED' })

    const accepted = await service.act(created.run.id, { ...host, role: 'ADMIN' }, action, 'critical-override-admin-0001')
    expect(accepted).toMatchObject({
      status: 'DELIVERING', qualityOverrideRole: 'ADMIN', qualityOverrideIssueIds: ['issue-factual-1'],
    })
    await expect(service.act(created.run.id, { ...host, role: 'ADMIN' }, action, 'critical-override-admin-stale-0001'))
      .rejects.toMatchObject({ status: 409, code: 'RUN_VERSION_CONFLICT' })
  })

  test('reserves every v4 quality override for audited administrators', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-v4-override-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4',
        status: 'NEEDS_HUMAN',
        version: 1,
      })
      transaction.putStep({
        id: 'step-plan-v4-override', runId: created.run.id, idempotencyKey: planningStepKey(created.run.id),
        inputHash: 'plan-v4-override-hash', tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null, output: blueprint(),
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'issue-v4-visual-1', category: 'VISUAL_CONSISTENCY', severity: 'WARNING',
          summary: '第二页插画风格与封面略有差异。', slideIds: [`${created.run.id}:slide:2`],
          sourceChunkIds: [], status: 'OPEN', repairDomain: 'ASSET',
        },
      })
    })
    const action = {
      schemaVersion: CONTRACT_VERSION,
      type: 'ACCEPT_WITH_OVERRIDE',
      expectedVersion: 1,
      reason: '内部管理员已复核全部页面并记录本次质量放行依据。',
      issueIds: ['issue-v4-visual-1'],
    } as const

    await expect(service.act(created.run.id, host, action, 'v4-override-user-0001'))
      .rejects.toMatchObject({ status: 403, code: 'QUALITY_OVERRIDE_ADMIN_REQUIRED' })
    expect(await repository.getRun(created.run.id)).toMatchObject({ status: 'NEEDS_HUMAN', qualityOverride: false, version: 1 })

    const accepted = await service.act(
      created.run.id,
      { ...host, role: 'ADMIN' },
      action,
      'v4-override-admin-0001',
    )
    expect(accepted).toMatchObject({
      status: 'DELIVERING', qualityOverride: true, qualityOverrideRole: 'ADMIN',
      qualityOverrideIssueIds: ['issue-v4-visual-1'],
      qualityDisposition: 'ADMIN_OVERRIDE', qualityPolicyAudit: null,
    })
  })

  test('requires a persisted revision plan and advances its round on approval', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'AWAITING_REVISION_APPROVAL', version: 4 })
    })
    const action = {
      schemaVersion: CONTRACT_VERSION,
      type: 'APPROVE_REVISION',
      expectedVersion: 4,
    } as const
    await expect(service.act(created.run.id, host, action, 'approve-revision-0001'))
      .rejects.toMatchObject({ status: 409, code: 'REVISION_PLAN_NOT_READY' })

    await repository.transact(created.run.id, (transaction) => {
      transaction.putStep({
        id: 'step-revision-plan-1',
        runId: created.run.id,
        idempotencyKey: revisionPlanStepKey(created.run.id, 1),
        inputHash: hashInput({ revisionPlan: 1 }),
        tool: 'plan_revision',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: {
          id: 'revision-plan-1',
          reviewId: 'deck-review-1',
          revisionRound: 1,
          createdAt: '2026-07-21T00:00:00.000Z',
          summary: '仅修订第二页的事实表述和对应视觉素材。',
          operations: [{
            id: 'operation-1',
            slideId: `${created.run.id}:slide:2`,
            kind: 'UPDATE_CONTENT',
            issueIds: ['issue-1'],
            instruction: '依据教材限定条件重写第二页产物描述，不增加教材外知识。',
            sourceChunkIds: ['chunk-1'],
          }],
        },
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })
    const approved = await service.act(created.run.id, host, action, 'approve-revision-0001')

    expect(approved).toMatchObject({ status: 'REVISING', revisionRound: 1, version: 5 })
  })

  test('closes a legacy active v4 revision lifecycle when the teacher rejects the plan', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-reject-revision-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4',
        status: 'AWAITING_REVISION_APPROVAL',
        version: 4,
      })
      appendV4LifecycleEvent(transaction, 'revision.started', {
        completed: 0, total: 1, pageNumbers: [2], revisionKind: 'DECK_VISUAL', revisionRound: 1,
      })
    })

    const rejected = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'REJECT_REVISION',
      expectedVersion: 4,
      reason: '当前修订方向不符合本节课的教学安排。',
    }, 'reject-revision-0001')

    expect(rejected.status).toBe('NEEDS_HUMAN')
    const revisions = (await repository.listEvents(created.run.id))
      .filter((event) => event.type.startsWith('revision.'))
    expect(revisions.map((event) => event.type)).toEqual(['revision.started', 'revision.completed'])
    expect(revisions[1]).toMatchObject({
      payload: { reason: 'REVISION_REJECTED_BY_USER', pageNumbers: [2], revisionRound: 1 },
    })
  })

  test('closes an active v4 revision lifecycle before cancelling the run', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-cancel-revision-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4',
        status: 'REVISING',
        revisionRound: 1,
        version: 4,
      })
      appendV4LifecycleEvent(transaction, 'revision.started', {
        completed: 0, total: 2, pageNumbers: [1, 2], revisionKind: 'DECK_VISUAL', revisionRound: 1,
      })
      appendV4LifecycleEvent(transaction, 'revision.progress', {
        completed: 1, total: 2, pageNumbers: [1, 2], revisionKind: 'DECK_VISUAL', revisionRound: 1,
      })
    })

    const cancelled = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'CANCEL',
      expectedVersion: 4,
      reason: '用户终止当前生成任务。',
    }, 'cancel-revision-0001')

    expect(cancelled.status).toBe('CANCELLED')
    const events = await repository.listEvents(created.run.id)
    const relevant = events.filter((event) => event.type.startsWith('revision.')
      || event.type === 'phase.changed' || event.type === 'run.cancelled')
    expect(relevant.map((event) => event.type)).toEqual([
      'revision.started', 'revision.progress', 'revision.completed', 'phase.changed', 'run.cancelled',
    ])
    expect(relevant[2]).toMatchObject({
      payload: {
        completed: 1, total: 2, pageNumbers: [1, 2], revisionRound: 1,
        reason: 'CANCELLED_BY_USER', requiresUserAction: false, nextAction: null,
      },
    })
  })

  test('closes active v4 generation before cancelling the run', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-cancel-generation-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4', status: 'EXECUTING', version: 4 })
      appendV4LifecycleEvent(transaction, 'generation.started', {
        completed: 0, total: 2, pageNumbers: [1, 2],
      })
      appendV4LifecycleEvent(transaction, 'generation.progress', {
        completed: 1, total: 2, pageNumbers: [1, 2],
      })
    })

    expect(await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION, type: 'CANCEL', expectedVersion: 4,
      reason: '用户终止当前生成任务。',
    }, 'cancel-generation-0001')).toMatchObject({ status: 'CANCELLED' })

    const relevant = (await repository.listEvents(created.run.id)).filter((event) =>
      event.type.startsWith('generation.') || event.type === 'phase.changed' || event.type === 'run.cancelled')
    expect(relevant.map((event) => event.type)).toEqual([
      'generation.started', 'generation.progress', 'generation.completed', 'phase.changed', 'run.cancelled',
    ])
    expect(relevant[2]).toMatchObject({
      payload: { completed: 1, total: 2, reason: 'CANCELLED_BY_USER', retryable: false },
    })
  })

  test('closes the suspended v4 generation when a paused run is cancelled', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-pause-cancel-generation-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4', status: 'EXECUTING', version: 4 })
      appendV4LifecycleEvent(transaction, 'generation.started', {
        completed: 0, total: 2, pageNumbers: [1, 2],
      })
      appendV4LifecycleEvent(transaction, 'generation.progress', {
        completed: 1, total: 2, pageNumbers: [1, 2],
      })
    })
    const paused = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION, type: 'PAUSE', expectedVersion: 4,
    }, 'pause-generation-0001')
    expect(paused).toMatchObject({ status: 'PAUSED', version: 5 })

    expect(await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION, type: 'CANCEL', expectedVersion: 5,
      reason: '用户在暂停后终止任务。',
    }, 'cancel-paused-generation-0001')).toMatchObject({ status: 'CANCELLED' })

    const events = await repository.listEvents(created.run.id)
    const completed = events.filter((event) => event.type === 'generation.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      payload: { completed: 1, total: 2, reason: 'CANCELLED_BY_USER' },
    })
    expect(events.findIndex((event) => event.type === 'generation.completed'))
      .toBeLessThan(events.findIndex((event) => event.type === 'run.cancelled'))
  })

  test('turns a teacher limited page request into a persisted revision plan', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-limited-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: 4 })
      transaction.putStep({
        id: 'step-plan-limited', runId: created.run.id, idempotencyKey: planningStepKey(created.run.id),
        inputHash: 'plan-limited-hash', tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null, output: blueprint(),
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-failed-page-2', runId: created.run.id,
        idempotencyKey: `${created.run.id}:slide:2:image:r0:v1`, inputHash: 'failed-page-2-hash',
        tool: 'generate_slide_image', status: 'FAILED_CHARGED', budgetUnits: 1,
        budgetReservationId: 'reservation-page-2', externalOperationId: 'operation-page-2',
        errorCode: 'IMAGE_TASK_FAILED', output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'step-failed-page-2:provider-result', category: 'PROVIDER_RESULT_FAILED', severity: 'CRITICAL',
          summary: '第2页 Provider 已收费但未返回产物。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
        },
      })
    })

    const revised = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'SUBMIT_LIMITED_REVISION',
      expectedVersion: 4,
      slideId: `${created.run.id}:slide:2`,
      repairDomain: 'LAYOUT',
      instruction: '将第二页主视觉移到右侧，完整保留左侧可编辑文字区域。',
    }, 'limited-revision-layout-0001')

    expect(revised).toMatchObject({ status: 'REVISING', revisionRound: 1, version: 5 })
    const step = (await repository.listSteps(created.run.id))
      .find((candidate) => candidate.idempotencyKey === revisionPlanStepKey(created.run.id, 1))!
    expect(step).toMatchObject({
      tool: 'plan_revision', status: 'COMPLETED',
      output: {
        revisionRound: 1,
        operations: [{
          slideId: `${created.run.id}:slide:2`, kind: 'RELAYOUT',
          issueIds: ['step-failed-page-2:provider-result'],
        }],
      },
    })
  })

  test('rejects an over-budget v4 limited revision before entering revising', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-limited-over-budget-0001')
    await repository.transact(created.run.id, (transaction) => {
      const now = transaction.run.updatedAt
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4',
        status: 'NEEDS_HUMAN',
        revisionRound: 1,
        maxRevisionRounds: 4,
        version: 4,
      })
      transaction.putStep({
        id: 'step-blueprint-r1', runId: created.run.id,
        idempotencyKey: revisionBlueprintStepKey(created.run.id, 1), inputHash: 'blueprint-r1',
        tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null, output: blueprint(), createdAt: now, updatedAt: now,
      })
      transaction.putStep({
        id: 'step-prior-plan-r1', runId: created.run.id,
        idempotencyKey: revisionPlanStepKey(created.run.id, 1), inputHash: 'prior-plan-r1',
        tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null,
        output: {
          id: 'prior-plan-r1', reviewId: 'review-r0', revisionRound: 1, createdAt: now,
          summary: '上一轮包含两项必须无损保留的页面视觉修复。',
          operations: [1, 2].map((index) => ({
            id: `prior-operation-${index}`, slideId: `${created.run.id}:slide:2`, kind: 'RELAYOUT',
            issueIds: [`prior-issue-${index}`], instruction: String(index).repeat(2_000), sourceChunkIds: [],
          })),
        },
        createdAt: now, updatedAt: now,
      })
    })

    await expect(service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'SUBMIT_LIMITED_REVISION',
      expectedVersion: 4,
      slideId: `${created.run.id}:slide:2`,
      repairDomain: 'LAYOUT',
      instruction: '继续修复当前页面，同时完整保留所有历史视觉约束。'.repeat(20),
    }, 'limited-revision-over-budget-0001')).rejects.toMatchObject({
      status: 422,
      code: 'REVISION_INSTRUCTION_BUDGET_EXCEEDED',
    })
    expect(await repository.getRun(created.run.id)).toMatchObject({ status: 'NEEDS_HUMAN', revisionRound: 1, version: 4 })
    expect((await repository.listSteps(created.run.id)).some((step) =>
      step.idempotencyKey === revisionPlanStepKey(created.run.id, 2))).toBe(false)
  })

  test('retries failed planning with distinct attempts and enforces the retry limit', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-replan-0001')
    const failAttempt = async (attempt: number, version: number) => repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', planningAttempt: attempt, version })
      transaction.putStep({
        id: `step-plan-failed-${attempt}`,
        runId: created.run.id,
        idempotencyKey: planningStepKey(created.run.id, attempt),
        inputHash: `failed-input-${attempt}`,
        tool: 'create_blueprint',
        status: 'FAILED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: 'BLUEPRINT_MODEL_OUTPUT_INVALID',
        output: null,
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })

    await failAttempt(0, 1)
    const retried = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_PLANNING',
      expectedVersion: 1,
    }, 'retry-planning-0001')
    expect(retried).toMatchObject({ status: 'PLANNING', planningAttempt: 1, version: 2 })

    await failAttempt(1, 3)
    const replanned = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'REPLAN',
      expectedVersion: 3,
      slideCount: 3,
      visualDirection: '更明亮、留白更多的低年级课堂视觉',
    }, 'replan-with-input-0001')
    expect(replanned).toMatchObject({
      status: 'PLANNING', planningAttempt: 2, version: 4, slideCount: 3,
      visualDirection: '更明亮、留白更多的低年级课堂视觉',
    })

    await failAttempt(2, 5)
    await expect(service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_PLANNING',
      expectedVersion: 5,
    }, 'retry-planning-over-limit-0001')).rejects.toMatchObject({
      status: 422,
      code: 'PLANNING_RETRY_LIMIT_REACHED',
    })
  })

  test('allows a V4 replan to one page and keeps its length snapshot aligned', async () => {
    const { repository, service } = fixture()
    const created = await service.create({
      ...request,
      presentationMode: 'VISUAL_DECK_V4',
      automationLevel: 'BOUNDED_AUTO',
      visualDeckV4: {
        instruction: '根据教材制作视觉演示',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: { length: { slideCount: 2 }, aspectRatio: '16:9' },
      },
    }, 'frameflow-create-v4-single-replan-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: 1 })
      transaction.putStep({
        id: 'step-v4-plan-failed', runId: created.run.id,
        idempotencyKey: planningStepKey(created.run.id, 0), inputHash: 'failed-v4-input',
        tool: 'create_blueprint', status: 'FAILED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: 'MODEL_JSON_INVALID', output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    const replanned = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'REPLAN',
      expectedVersion: 1,
      slideCount: 1,
      visualDirection: '一个主视觉承载主题和结论的单页信息图',
    }, 'v4-replan-to-single-0001')

    expect(replanned).toMatchObject({
      presentationMode: 'VISUAL_DECK_V4',
      status: 'PLANNING',
      slideCount: 1,
      visualDeckV4: { deckOptions: { length: { slideCount: 1 } } },
    })
  })

  test('retries delivery only when the current delivery step failed', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-delivery-retry-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: 1 })
      transaction.putStep({
        id: 'step-delivery-failed', runId: created.run.id,
        idempotencyKey: deliveryStepKey(transaction.run), inputHash: 'delivery-input',
        tool: 'deliver_presentation', status: 'FAILED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: 'DELIVERY_FAILED', output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    const retried = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: 1,
    }, 'retry-delivery-0001')

    expect(retried).toMatchObject({ status: 'DELIVERING', version: 2 })
  })

  test('resumes one failed v4 quality gate without creating media or changing settled units', async () => {
    const { repository, artifacts, service } = fixture()
    const created = await service.create({
      ...request,
      presentationMode: 'VISUAL_DECK_V4',
      automationLevel: 'BOUNDED_AUTO',
      maxRevisionRounds: 0,
      budgetUnits: 2,
      visualDeckV4: {
        instruction: '根据教材自动制作完整课堂演示文稿',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: { length: { slideCount: 2 }, aspectRatio: '16:9' },
      },
    }, 'frameflow-v4-quality-recovery-create-0001')
    const planned = visualDeckV4Blueprint(created.run.id)
    const terminalAccounting = {
      authorizedUnits: 2, submittedUnits: 2, settledUnits: 2,
      releasedUnits: 0, reconciliationUnits: 0, accountingStatus: 'FINAL' as const,
    }
    const recoveryArtifacts = await Promise.all([1, 2].map((pageNumber) => artifacts.put({
      tenantId: 'frameflow', runId: created.run.id, name: `quality-recovery-${pageNumber}.png`,
      mimeType: 'image/png', bytes: new TextEncoder().encode(`quality-recovery-image-${pageNumber}`),
      idempotencyKey: `${created.run.id}:quality-recovery-artifact:${pageNumber}`,
    })))
    await repository.transact(created.run.id, (transaction) => {
      transaction.putStep({
        id: 'step-v4-quality-recovery-plan', runId: created.run.id,
        idempotencyKey: planningStepKey(created.run.id), inputHash: 'v4-quality-recovery-plan-hash',
        tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null, output: planned,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      for (const pageNumber of [1, 2]) {
        transaction.putStep({
          id: `step-v4-quality-recovery-image-${pageNumber}`, runId: created.run.id,
          idempotencyKey: `${created.run.id}:slide:${pageNumber}:image:r0:v1`,
          inputHash: `v4-quality-recovery-image-${pageNumber}`, tool: 'generate_slide_image',
          status: 'COMPLETED', budgetUnits: 1, budgetReservationId: 'reservation-v4-quality-recovery',
          externalOperationId: `operation-v4-quality-recovery-${pageNumber}`, errorCode: null,
          output: {
            slideId: `${created.run.id}:slide:${pageNumber}`,
            versionId: `${created.run.id}:slide:${pageNumber}:r0:v1`,
            artifactId: recoveryArtifacts[pageNumber - 1]!.artifactId,
          },
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        })
      }
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'v4-quality-recovery-page-issue', category: 'IMAGE_QUALITY', severity: 'WARNING',
          summary: '第二页构图仍有可优化空间。', slideIds: [`${created.run.id}:slide:2`],
          sourceChunkIds: [], status: 'OPEN',
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.resolved',
        payload: { issueId: 'v4-quality-recovery-page-issue', resolution: 'ACCEPTED' },
      })
      const {
        qualityDisposition: _qualityDisposition,
        qualityPolicyAudit: _qualityPolicyAudit,
        ...legacyRun
      } = transaction.run
      const failed = {
        ...legacyRun,
        status: 'FAILED' as const,
        version: 7,
        committedBudgetUnits: 2,
        terminalAccounting,
        qualityOverride: true,
        qualityOverrideReason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
        qualityOverrideBy: 'ppt-agent-quality-policy',
        qualityOverrideRole: 'ADMIN' as const,
        qualityOverrideIssueIds: ['v4-quality-recovery-page-issue'],
        qualityOverrideAt: '2026-07-21T00:00:00.000Z',
      }
      transaction.putRun(failed)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
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

    const beforeSteps = await repository.listSteps(created.run.id)
    await repository.transact(created.run.id, (transaction) => {
      transaction.putStep({
        id: 'step-v4-quality-recovery-pending-orphan', runId: created.run.id,
        idempotencyKey: `${created.run.id}:slide:99:image:r0:v1`, inputHash: 'pending-orphan',
        tool: 'generate_slide_image', status: 'WAITING', budgetUnits: 0, budgetReservationId: 'pending-orphan',
        externalOperationId: 'pending-orphan-operation', errorCode: null, output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })
    await expect(service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: 7,
    }, 'retry-v4-quality-accounting-not-final')).rejects.toMatchObject({
      status: 409,
      code: 'QUALITY_FAILURE_ACCOUNTING_NOT_FINAL',
    })
    await repository.transact(created.run.id, (transaction) => {
      const pending = transaction.getStep(`${created.run.id}:slide:99:image:r0:v1`)!
      transaction.putStep({ ...pending, status: 'FAILED_NOT_CHARGED', externalOperationId: null })
    })
    const recovered = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: 7,
    }, 'retry-v4-quality-delivery-0001')
    const replayed = await service.act(created.run.id, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: 7,
    }, 'retry-v4-quality-delivery-0001')

    expect(recovered).toMatchObject({
      status: 'DECK_REVIEW',
      version: 8,
      committedBudgetUnits: 2,
      qualityOverride: false,
      qualityOverrideReason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
      qualityOverrideBy: 'ppt-agent-quality-policy',
      qualityOverrideRole: 'ADMIN',
      qualityOverrideIssueIds: ['v4-quality-recovery-page-issue'],
      qualityOverrideAt: '2026-07-21T00:00:00.000Z',
      qualityDisposition: 'PENDING',
    })
    expect(recovered.qualityPolicyAudit).toBeNull()
    expect(replayed).toEqual(recovered)
    const afterSteps = await repository.listSteps(created.run.id)
    expect(afterSteps.filter((step) => step.tool === 'generate_slide_image'))
      .toEqual([
        ...beforeSteps.filter((step) => step.tool === 'generate_slide_image'),
        expect.objectContaining({ id: 'step-v4-quality-recovery-pending-orphan', status: 'FAILED_NOT_CHARGED' }),
      ])
    expect(afterSteps.some((step) => step.tool === 'deliver_presentation')).toBe(false)
    expect(await repository.getTerminalEvent(created.run.id)).toBeNull()
    const events = await repository.listEvents(created.run.id)
    expect(events.filter((event) => event.type === 'run.resumed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'deck_review.started')).toHaveLength(1)
    expect(events.some((event) => event.type === 'delivery.started')).toBe(false)
  })

  test('clears an explicit system policy audit before resuming a failed v4 quality gate', async () => {
    const seeded = await failedV4QualityRecoveryFixture()
    const policyAudit = {
      provenance: 'SYSTEM_POLICY' as const,
      policyId: 'v4-non-blocking-quality-v1',
      reason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
      issueIds: ['v4-quality-recovery-page-issue'],
      acceptedAt: '2026-07-21T00:00:00.000Z',
    }

    await seeded.repository.transact(seeded.runId, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        qualityOverride: true,
        qualityDisposition: 'HARD_FAILURE',
        qualityPolicyAudit: policyAudit,
      })
    })

    const recovered = await seeded.service.act(seeded.runId, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: seeded.expectedVersion,
    }, 'retry-v4-quality-clears-policy-audit')

    expect(recovered).toMatchObject({
      status: 'DECK_REVIEW',
      qualityOverride: false,
      qualityDisposition: 'PENDING',
      qualityPolicyAudit: null,
    })
  })

  test('rejects quality recovery before state mutation when Usage V2 finalization requires review', async () => {
    const seeded = await failedV4QualityRecoveryFixture({ usageFinalization: 'REVIEW_REQUIRED' })

    await expect(seeded.service.act(seeded.runId, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: seeded.expectedVersion,
    }, 'retry-v4-quality-v2-review-required')).rejects.toMatchObject({
      status: 409,
      code: 'QUALITY_FAILURE_USAGE_FINALIZATION_NOT_ACKNOWLEDGED',
    })

    expect(await seeded.repository.getRun(seeded.runId)).toMatchObject({ status: 'FAILED', version: 7 })
    expect((await seeded.repository.listEvents(seeded.runId)).some((event) => event.type === 'run.resumed')).toBe(false)
  })

  test('allows quality recovery after Usage V2 finalization is acknowledged', async () => {
    const seeded = await failedV4QualityRecoveryFixture({ usageFinalization: 'ACKNOWLEDGED' })

    await expect(seeded.service.act(seeded.runId, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: seeded.expectedVersion,
    }, 'retry-v4-quality-v2-acknowledged')).resolves.toMatchObject({
      status: 'DECK_REVIEW', version: 8,
    })
  })

  test('rejects invalid or missing controlled page artifacts before quality recovery', async () => {
    for (const imageFault of [
      'NULL_OUTPUT', 'CROSS_PAGE', 'WRONG_VERSION', 'MISSING_ARTIFACT', 'DUPLICATE_ARTIFACT',
      'NON_IMAGE', 'EMPTY_ARTIFACT', 'SHA_MISMATCH',
    ] as const) {
      const seeded = await failedV4QualityRecoveryFixture({ imageFault })

      await expect(seeded.service.act(seeded.runId, host, {
        schemaVersion: CONTRACT_VERSION,
        type: 'RETRY_DELIVERY',
        expectedVersion: seeded.expectedVersion,
      }, `retry-v4-quality-invalid-artifact-${imageFault.toLowerCase()}`)).rejects.toMatchObject({
        status: 409,
        code: 'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE',
      })

      expect(await seeded.repository.getRun(seeded.runId)).toMatchObject({ status: 'FAILED', version: 7 })
      expect((await seeded.repository.listEvents(seeded.runId)).some((event) => event.type === 'run.resumed')).toBe(false)
    }
  })

  test('rejects a page Step that changes after artifact preflight but before the recovery transaction', async () => {
    const seeded = await failedV4QualityRecoveryFixture()
    const replacement = await seeded.artifacts.put({
      tenantId: 'frameflow', runId: seeded.runId, name: 'replacement.png', mimeType: 'image/png',
      bytes: new TextEncoder().encode('replacement-image'),
      idempotencyKey: `${seeded.runId}:quality-recovery-race-replacement`,
    })
    let artifactReads = 0
    const racingArtifacts = {
      put: seeded.artifacts.put.bind(seeded.artifacts),
      open: seeded.artifacts.open.bind(seeded.artifacts),
      getByIdempotencyKey: seeded.artifacts.getByIdempotencyKey.bind(seeded.artifacts),
      verifyIntegrity: seeded.artifacts.verifyIntegrity.bind(seeded.artifacts),
      get: async (input: Parameters<typeof seeded.artifacts.get>[0]) => {
        const artifact = await seeded.artifacts.get(input)
        artifactReads += 1
        if (artifactReads === 2) {
          await seeded.repository.transact(seeded.runId, (transaction) => {
            const key = `${seeded.runId}:slide:1:image:r0:v1`
            const step = transaction.getStep(key)!
            transaction.putStep({
              ...step,
              output: {
                slideId: `${seeded.runId}:slide:1`,
                versionId: `${seeded.runId}:slide:1:r0:v1`,
                artifactId: replacement.artifactId,
              },
            })
          })
        }
        return artifact
      },
    }
    const racingService = new RunService({
      repository: seeded.repository, artifacts: racingArtifacts, clock: seeded.clock,
    })

    await expect(racingService.act(seeded.runId, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: seeded.expectedVersion,
    }, 'retry-v4-quality-artifact-race')).rejects.toMatchObject({
      status: 409,
      code: 'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE',
    })
    expect(await seeded.repository.getRun(seeded.runId)).toMatchObject({ status: 'FAILED', version: 7 })
  })

  test('rejects an artifact whose content changes after preflight but before recovery state mutation', async () => {
    const seeded = await failedV4QualityRecoveryFixture()
    const firstImage = (await seeded.repository.listSteps(seeded.runId))
      .find((step) => step.idempotencyKey === `${seeded.runId}:slide:1:image:r0:v1`)!
    const firstArtifactId = (firstImage.output as { artifactId: string }).artifactId
    let artifactReads = 0
    const racingArtifacts = {
      put: seeded.artifacts.put.bind(seeded.artifacts),
      open: seeded.artifacts.open.bind(seeded.artifacts),
      getByIdempotencyKey: seeded.artifacts.getByIdempotencyKey.bind(seeded.artifacts),
      verifyIntegrity: seeded.artifacts.verifyIntegrity.bind(seeded.artifacts),
      get: async (input: Parameters<typeof seeded.artifacts.get>[0]) => {
        const artifact = await seeded.artifacts.get(input)
        artifactReads += 1
        if (artifactReads === 2) {
          seeded.artifacts.artifacts.set(firstArtifactId, {
            mimeType: 'text/plain',
            bytes: new Uint8Array(),
            sha256: '0'.repeat(64),
          })
        }
        return artifact
      },
    }
    const racingService = new RunService({
      repository: seeded.repository, artifacts: racingArtifacts, clock: seeded.clock,
    })

    await expect(racingService.act(seeded.runId, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: seeded.expectedVersion,
    }, 'retry-v4-quality-artifact-content-race')).rejects.toMatchObject({
      status: 409,
      code: 'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE',
    })
    expect(await seeded.repository.getRun(seeded.runId)).toMatchObject({ status: 'FAILED', version: 7 })
    expect((await seeded.repository.listEvents(seeded.runId)).some((event) => event.type === 'run.resumed')).toBe(false)
  })

  test('rejects a pre-revision image for a page targeted by the adopted revision plan', async () => {
    const seeded = await failedV4QualityRecoveryFixture()
    await seeded.repository.transact(seeded.runId, (transaction) => {
      const revisedBlueprint = visualDeckV4Blueprint(seeded.runId)
      transaction.putStep({
        id: 'step-v4-quality-recovery-revision-plan-r1', runId: seeded.runId,
        idempotencyKey: revisionPlanStepKey(seeded.runId, 1), inputHash: 'quality-recovery-revision-plan-r1',
        tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null,
        output: {
          id: `${seeded.runId}:revision-plan:r1`, reviewId: `${seeded.runId}:deck-review:r0`, revisionRound: 1,
          createdAt: transaction.run.createdAt, summary: '第一轮规划明确要求更新第二页并重新生成该页图片。',
          operations: [{
            id: `${seeded.runId}:revision:r1:p2`, slideId: `${seeded.runId}:slide:2`, kind: 'UPDATE_CONTENT',
            issueIds: ['v4-quality-recovery-page-issue'], instruction: '依据来源修正第二页内容并重新生成完整页面图片。',
            sourceChunkIds: ['chunk-1'],
          }],
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-v4-quality-recovery-revision-blueprint-r1', runId: seeded.runId,
        idempotencyKey: revisionBlueprintStepKey(seeded.runId, 1), inputHash: 'quality-recovery-blueprint-r1',
        tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null, output: revisedBlueprint,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putRun({ ...transaction.run, revisionRound: 1 })
    })

    await expect(seeded.service.act(seeded.runId, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: seeded.expectedVersion,
    }, 'retry-v4-quality-stale-targeted-page')).rejects.toMatchObject({
      status: 409,
      code: 'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE',
    })
    expect(await seeded.repository.getRun(seeded.runId)).toMatchObject({ status: 'FAILED', version: 7 })
    expect((await seeded.repository.listEvents(seeded.runId)).some((event) => event.type === 'run.resumed')).toBe(false)
  })

  test('replays the same user action without duplicate events', async () => {
    const { repository, service } = fixture()
    const created = await service.create(request, 'frameflow-create-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'EXECUTING', version: 1 })
    })
    const action = { schemaVersion: CONTRACT_VERSION, type: 'PAUSE', expectedVersion: 1 } as const
    const first = await service.act(created.run.id, host, action, 'pause-action-0001')
    const eventCount = (await repository.listEvents(created.run.id)).length
    const replay = await service.act(created.run.id, host, action, 'pause-action-0001')

    expect(replay).toEqual(first)
    expect((await repository.listEvents(created.run.id)).length).toBe(eventCount)
    await expect(service.act(created.run.id, host, { ...action, type: 'CANCEL' }, 'pause-action-0001'))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' })
  })
})

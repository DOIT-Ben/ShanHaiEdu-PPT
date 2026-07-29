import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { hashInput } from '../src/core/hash'
import { deliveryStepKey } from '../src/core/delivery-runner'
import { planningStepKey } from '../src/core/planning-runner'
import { revisionPlanStepKey } from '../src/core/revision-planning-runner'
import { RunService, RunServiceError } from '../src/core/run-service'

const host = { tenantId: 'frameflow', externalUserId: 'user-1' }
const request = {
  schemaVersion: CONTRACT_VERSION,
  host,
  source: { kind: 'TEXT', name: '教材.txt', text: '这是用于创建独立 PPT Agent Run 的完整教材内容。'.repeat(4) },
  slideCount: 2,
  visualDirection: '清晰的课堂科学信息图风格',
  imageModel: 'image-2',
  automationLevel: 'SUPERVISED',
  budgetUnits: 100,
} as const

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

function fixture() {
  const repository = new InMemoryAgentRepository()
  return { repository, service: new RunService({ repository, clock: new FixedClock() }) }
}

describe('run service', () => {
  test('creates and safely replays a host-scoped Run', async () => {
    const { repository, service } = fixture()
    const first = await service.create(request, 'frameflow-create-0001')
    const replay = await service.create(request, 'frameflow-create-0001')

    expect(first).toMatchObject({ replayed: false, run: { status: 'PLANNING', slideCount: 2, budgetUnits: 100 } })
    expect(replay).toMatchObject({ replayed: true, run: { id: first.run.id } })
    expect(await repository.listRuns()).toHaveLength(1)
    expect((await repository.listEvents(first.run.id)).map((event) => event.type)).toEqual(['run.started'])
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
      output: { revisionRound: 1, operations: [{ slideId: `${created.run.id}:slide:2`, kind: 'RELAYOUT' }] },
    })
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

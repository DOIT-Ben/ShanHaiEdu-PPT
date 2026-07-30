import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockRevisionPlanningPort } from '../src/adapters/mock-ports'
import { deckReviewStepKey } from '../src/core/deck-review-runner'
import { planningStepKey } from '../src/core/planning-runner'
import type { DocumentPort, DocumentResult, RunRecord } from '../src/core/ports'
import { RevisionPlanningRunner, revisionPlanStepKey } from '../src/core/revision-planning-runner'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于局部修订计划测试的完整教材内容。' },
    slideCount: 2,
    visualDirection: '清晰的课堂科学信息图风格',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: 72,
    status: 'DECK_REVIEW',
    resumeState: null,
    version: 6,
    budgetUnits: 100,
    committedBudgetUnits: 20,
    qualityOverride: false,
    qualityOverrideReason: null,
    qualityOverrideBy: null,
    leaseToken: null,
    leaseUntil: null,
    leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  }
}

function blueprint() {
  return {
    id: 'blueprint-1',
    title: '光合作用',
    visualDirection: '清晰的课堂科学信息图风格',
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1', 'chunk-2'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: `第 ${pageNumber} 页`,
      body: ['教学内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: `第 ${pageNumber} 页对应的教材视觉目标`,
      visualPrompt: `A clean science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: [`chunk-${pageNumber}`],
    })),
  }
}

function review(revisionRound = 0) {
  return {
    id: `run-1:deck-review:r${revisionRound}`,
    revisionRound,
    createdAt: '2026-07-21T00:00:00.000Z',
    qualityScore: 72,
    curriculumCoverageScore: 70,
    narrativeCoherenceScore: 78,
    visualConsistencyScore: 76,
    compositionScore: 74,
    summary: '整套课件结构基本完整，但第二页存在一处教材事实限定风险。',
    reviewedSourceChunkIds: ['chunk-1', 'chunk-2'],
    issues: [{
      id: 'issue-1',
      category: 'FACTUAL_RISK',
      severity: 'CRITICAL',
      summary: '第二页中的产物描述缺少教材限定条件。',
      slideIds: ['run-1:slide:2'],
      sourceChunkIds: ['chunk-2'],
      status: 'OPEN',
    }],
  }
}

function plan() {
  return {
    summary: '仅修订第二页的事实表述，保留其他已经通过检查的页面。',
    operations: [{
      id: 'operation-1',
      slideId: 'run-1:slide:2',
      kind: 'UPDATE_CONTENT',
      issueIds: ['issue-1'],
      instruction: '依据教材限定条件重写第二页产物描述，不增加教材外知识。',
      sourceChunkIds: ['chunk-2'],
    }],
  }
}

class StaticDocumentPort implements DocumentPort {
  result: DocumentResult = {
    name: '光合作用教材.txt',
    chunks: [
      { id: 'chunk-1', text: '绿色植物利用光能制造有机物。', sha256: 'sha-1' },
      { id: 'chunk-2', text: '光合作用释放氧气。', sha256: 'sha-2' },
    ],
    isComplete: true,
    missingRanges: [],
  }
  async resolve() { return structuredClone(this.result) }
}

async function fixture(runOverrides: Partial<RunRecord> = {}, response: unknown = plan()) {
  const repository = new InMemoryAgentRepository()
  const documents = new StaticDocumentPort()
  const planner = new MockRevisionPlanningPort(response)
  const currentRun = run(runOverrides)
  await repository.createRun(currentRun)
  await repository.transact('run-1', (transaction) => {
    transaction.putStep({
      id: 'step-plan', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'plan-hash',
      tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: blueprint(),
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    transaction.putStep({
      id: `step-deck-review-r${currentRun.revisionRound}`,
      runId: 'run-1',
      idempotencyKey: deckReviewStepKey(currentRun),
      inputHash: `deck-review-hash-r${currentRun.revisionRound}`,
      tool: 'review_deck', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: review(currentRun.revisionRound),
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
  })
  return {
    repository,
    planner,
    runner: new RevisionPlanningRunner({ repository, documents, planner, clock: new FixedClock() }),
  }
}

describe('revision planning runner', () => {
  test('waits for explicit approval in supervised mode', async () => {
    const { repository, planner, runner } = await fixture()
    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL', replayed: false, plan: { revisionRound: 1 } })
    expect(await repository.getRun('run-1')).toMatchObject({ revisionRound: 0, version: 7 })
    expect(planner.requests.size).toBe(1)
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toContain('approval.required')
  })

  test('enters the next revision round directly in bounded auto mode', async () => {
    const { repository, runner } = await fixture({ automationLevel: 'BOUNDED_AUTO' })
    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'REVISING', plan: { revisionRound: 1 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'REVISING', revisionRound: 1, version: 7 })
  })

  test('stops without a planner call at the configured revision limit', async () => {
    const { repository, planner, runner } = await fixture({ revisionRound: 2, maxRevisionRounds: 2 })
    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', step: null, plan: null })
    expect(planner.requests.size).toBe(0)
    expect(await repository.getRun('run-1')).toMatchObject({ revisionRound: 2 })
  })

  test('keeps deck revision capacity after two bounded page redraw rounds', async () => {
    const { repository, runner } = await fixture({
      automationLevel: 'BOUNDED_AUTO', revisionRound: 2, maxRevisionRounds: 2,
    })
    await repository.transact('run-1', (transaction) => {
      for (const round of [1, 2]) {
        transaction.putStep({
          id: `step-page-revision-${round}`, runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', round),
          inputHash: `page-revision-${round}`, tool: 'plan_page_revision', status: 'COMPLETED', budgetUnits: 0,
          budgetReservationId: null, externalOperationId: null, errorCode: null,
          output: { id: `page-plan-${round}`, reviewId: `page-review-${round - 1}`, revisionRound: round,
            createdAt: transaction.run.createdAt, ...plan() },
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        })
      }
    })

    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'REVISING', plan: { revisionRound: 3 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'REVISING', revisionRound: 3 })
  })

  test('rejects a plan that invents issue and source references', async () => {
    const invalid = plan()
    invalid.operations[0]!.issueIds = ['issue-invented']
    invalid.operations[0]!.sourceChunkIds = ['chunk-invented']
    const { repository, runner } = await fixture({}, invalid)
    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', plan: null, step: { status: 'FAILED' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
    const events = await repository.listEvents('run-1')
    expect(events.find((event) => event.type === 'phase.changed')?.payload)
      .toMatchObject({ from: 'DECK_REVIEW', to: 'NEEDS_HUMAN' })
    expect(events.map((event) => event.type)).toContain('approval.required')
  })

  test('replays a completed supervised plan without another planner call', async () => {
    const { planner, runner } = await fixture()
    const first = await runner.plan('run-1')
    const replay = await runner.plan('run-1')

    expect(replay).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL', replayed: true })
    expect(replay.plan).toEqual(first.plan)
    expect(planner.plans.size).toBe(1)
  })
})

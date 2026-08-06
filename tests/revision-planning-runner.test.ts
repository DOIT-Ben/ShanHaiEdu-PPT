import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockRevisionPlanningPort } from '../src/adapters/mock-ports'
import { deckReviewStepKey } from '../src/core/deck-review-runner'
import { getActiveBlueprint } from '../src/core/active-blueprint'
import { hashInput } from '../src/core/hash'
import { planningStepKey } from '../src/core/planning-runner'
import { StructuredModelError, type DocumentPort, type DocumentResult, type RunRecord } from '../src/core/ports'
import { RevisionPlanningRunner, revisionPlanStepKey } from '../src/core/revision-planning-runner'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import type { DeckReview, RevisionPlanDraft } from '../src/presentation-contracts'

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

function layeredBlueprint() {
  const base = blueprint()
  return {
    ...base,
    renderMode: 'LAYERED_COURSEWARE_V3' as const,
    coverDesignMode: 'FOLLOW_TEMPLATE' as const,
    slides: base.slides.map((slide) => ({
      ...slide,
      layeredDesign: {
        designKind: slide.pageNumber === 1 ? 'COVER' as const : 'CONTENT' as const,
        backgroundColor: '#F7FBFA',
        elements: [
          {
            kind: 'IMAGE' as const, elementId: `base-${slide.pageNumber}`, role: 'BASE_LAYER' as const,
            knowledgePoint: '建立本页知识情境', prompt: 'A wide text-free science classroom background',
            negativePrompt: 'text, logo, watermark', sourceChunkIds: slide.sourceChunkIds,
            placement: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 0,
            fit: 'COVER' as const, aspectRatio: '16:9' as const, backgroundMode: 'OPAQUE' as const,
          },
          {
            kind: 'IMAGE' as const, elementId: `knowledge-${slide.pageNumber}`, role: 'KNOWLEDGE_VISUAL' as const,
            knowledgePoint: '展示光合作用知识对象', prompt: 'A transparent leaf explaining photosynthesis',
            negativePrompt: 'text, logo, watermark', sourceChunkIds: slide.sourceChunkIds,
            placement: { x: 0.62, y: 0.2, width: 0.3, height: 0.5 }, zIndex: 10,
            fit: 'CONTAIN' as const, aspectRatio: '1:1' as const, backgroundMode: 'TRANSPARENT' as const,
          },
          {
            kind: 'TEXT' as const, elementId: `title-${slide.pageNumber}`, role: 'TITLE' as const,
            text: slide.title, sourceChunkIds: slide.sourceChunkIds,
            placement: { x: 0.08, y: 0.2, width: 0.4, height: 0.2 }, zIndex: 20,
            style: { fontSize: 30, bold: true, color: '#17202A', align: 'LEFT' as const },
          },
        ],
      },
    })),
  }
}

function visualDeckV4Blueprint() {
  const source = {
    kind: 'TEXT' as const,
    name: '光合作用教材.txt',
    text: '绿色植物利用光能制造有机物并释放氧气。'.repeat(12),
  }
  return createVisualDeckV4Blueprint({
    runId: 'run-1', inputHash: 'plan-hash', source,
    document: {
      name: source.name,
      chunks: [
        { id: 'chunk-1', text: '绿色植物利用光能制造有机物。'.repeat(4), sha256: 'sha-1' },
        { id: 'chunk-2', text: '光合作用释放氧气。'.repeat(4), sha256: 'sha-2' },
      ],
      isComplete: true,
      missingRanges: [],
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

function review(revisionRound = 0): DeckReview {
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

function plan(): RevisionPlanDraft {
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

async function fixture(
  runOverrides: Partial<RunRecord> = {},
  response: unknown = plan(),
  activeBlueprint: unknown = blueprint(),
) {
  const repository = new InMemoryAgentRepository()
  const documents = new StaticDocumentPort()
  const planner = new MockRevisionPlanningPort(response)
  const currentRun = run(runOverrides)
  await repository.createRun(currentRun)
  await repository.transact('run-1', (transaction) => {
    transaction.putStep({
      id: 'step-plan', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'plan-hash',
      tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: activeBlueprint,
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
    documents,
    planner,
    runner: new RevisionPlanningRunner({
      repository, documents, planner, clock: new FixedClock(), sleep: async () => {},
    }),
  }
}

describe('revision planning runner', () => {
  test('waits for explicit approval in supervised mode', async () => {
    const { repository, planner, runner } = await fixture({ presentationMode: 'VISUAL_DECK_V4' })
    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL', replayed: false, plan: { revisionRound: 1 } })
    expect(await repository.getRun('run-1')).toMatchObject({ revisionRound: 0, version: 7 })
    expect(planner.requests.size).toBe(1)
    const eventTypes = (await repository.listEvents('run-1')).map((event) => event.type)
    expect(eventTypes).toContain('approval.required')
    expect(eventTypes.filter((type) => type.startsWith('revision.'))).toEqual([])
  })

  test('enters the next revision round directly in bounded auto mode', async () => {
    const { repository, runner } = await fixture({ automationLevel: 'BOUNDED_AUTO' })
    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'REVISING', plan: { revisionRound: 1 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'REVISING', revisionRound: 1, version: 7 })
  })

  test('starts bounded revision progress from the actual plan rather than ignored info issues', async () => {
    const { repository, runner } = await fixture({
      automationLevel: 'BOUNDED_AUTO', presentationMode: 'VISUAL_DECK_V4',
    }, plan(), visualDeckV4Blueprint())
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.issues.unshift({
        id: 'issue-info', category: 'DUPLICATION', severity: 'INFO',
        summary: '第一页存在一项不阻断交付的轻微信息重复。', slideIds: ['run-1:slide:1'],
        sourceChunkIds: [], status: 'OPEN', repairDomain: 'LAYOUT',
      })
      transaction.putStep({ ...step, output })
    })

    expect(await runner.plan('run-1')).toMatchObject({ status: 'REVISING' })
    const started = (await repository.listEvents('run-1')).filter((event) => event.type === 'revision.started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      payload: { total: 1, pageNumbers: [2], revisionKind: 'DECK_CONTENT', revisionRound: 1 },
    })
  })

  test('limits a high-scoring deck revision to blocking issues', async () => {
    const { repository, planner, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.qualityScore = 85
      output.issues.push({
        id: 'issue-advisory', category: 'VISUAL_CONSISTENCY', severity: 'WARNING',
        summary: '标题容器存在一项不阻断交付的轻微差异。', slideIds: ['run-1:slide:1'],
        sourceChunkIds: [], status: 'OPEN', repairDomain: 'LAYOUT',
      })
      transaction.putStep({ ...step, output })
    })

    expect(await runner.plan('run-1')).toMatchObject({ plan: { operations: [{ issueIds: ['issue-1'] }] } })
    expect([...planner.requests.values()][0]?.review.issues.map((issue) => issue.id)).toEqual(['issue-1'])
  })

  test('keeps warnings actionable while the deck score is below threshold', async () => {
    const { repository, planner, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.issues.push({
        id: 'issue-warning', category: 'VISUAL_CONSISTENCY', severity: 'WARNING',
        summary: '低分课件中标题样式需要统一。', slideIds: ['run-1:slide:1'],
        sourceChunkIds: [], status: 'OPEN', repairDomain: 'LAYOUT',
      })
      transaction.putStep({ ...step, output })
    })

    expect(await runner.plan('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', plan: null })
    expect([...planner.requests.values()][0]?.review.issues.map((issue) => issue.id))
      .toEqual(['issue-1', 'issue-warning'])
    expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'REVISION_PLAN_ISSUE_COVERAGE_INCOMPLETE',
    })
  })

  test('delivers a v4 run when a rejected review has only informational issues', async () => {
    const { repository, planner, runner } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO',
      budgetUnits: 0, committedBudgetUnits: 0,
    }, plan(), visualDeckV4Blueprint())
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.issues = [{
        ...output.issues[0]!,
        category: 'DUPLICATION',
        severity: 'INFO',
        summary: '页面存在不影响交付的信息重复。',
        sourceChunkIds: [],
        repairDomain: 'LAYOUT',
      }]
      transaction.putStep({ ...step, output })
    })

    expect(await runner.plan('run-1')).toMatchObject({
      status: 'DELIVERING',
      step: null,
      plan: null,
    })
    expect(planner.requests.size).toBe(0)
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'delivery.started' })
  })

  test('falls back to a complete deterministic v4 plan after model contract repair is exhausted', async () => {
    const invalidPlan = { summary: '模型未能生成任何有效的局部修订操作。', operations: [] }
    const { planner, runner } = await fixture(
      { presentationMode: 'VISUAL_DECK_V4' },
      invalidPlan,
      visualDeckV4Blueprint(),
    )

    const result = await runner.plan('run-1')

    expect(planner.requests.size).toBe(2)
    expect(result).toMatchObject({
      status: 'AWAITING_REVISION_APPROVAL',
      plan: {
        revisionRound: 1,
        operations: [{
          slideId: 'run-1:slide:2',
          kind: 'UPDATE_CONTENT',
          issueIds: ['issue-1'],
          sourceChunkIds: ['chunk-2'],
        }],
      },
    })
  })

  test('normalizes short issue summaries in the deterministic v4 fallback', async () => {
    const { repository, runner } = await fixture(
      { presentationMode: 'VISUAL_DECK_V4' },
      { summary: '模型未能生成任何有效的局部修订操作。', operations: [] },
      visualDeckV4Blueprint(),
    )
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.issues[0]!.summary = '错'
      transaction.putStep({ ...step, output })
    })

    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL' })
    expect(result.plan?.operations[0]?.instruction).toBe('逐项修复审查问题：错')
    expect(result.plan?.operations[0]?.instruction.length).toBeGreaterThanOrEqual(10)
  })

  test('groups more than fifty review issues by slide and repair kind in the deterministic fallback', async () => {
    const { repository, runner } = await fixture(
      { presentationMode: 'VISUAL_DECK_V4' },
      { summary: '模型未能生成任何有效的局部修订操作。', operations: [] },
      visualDeckV4Blueprint(),
    )
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.issues.push(...Array.from({ length: 50 }, (_, index) => ({
        id: `issue-layout-${index + 1}`,
        category: 'COMPOSITION_CONFLICT' as const,
        severity: 'WARNING' as const,
        summary: `第二页构图问题 ${index + 1} 需要修复。`,
        slideIds: ['run-1:slide:2'],
        sourceChunkIds: [],
        status: 'OPEN' as const,
        repairDomain: 'LAYOUT' as const,
      })))
      transaction.putStep({ ...step, output })
    })

    const result = await runner.plan('run-1')
    const operations = result.plan?.operations ?? []
    const covered = new Set(operations.flatMap((operation) => operation.issueIds))

    expect(result).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL' })
    expect(operations).toHaveLength(4)
    expect(operations.every((operation) => operation.issueIds.length <= 20)).toBe(true)
    expect(covered.size).toBe(51)
    expect(covered.has('issue-1')).toBe(true)
    expect(covered.has('issue-layout-50')).toBe(true)
  })

  test('continues to delivery without a planner call at the configured v4 revision limit', async () => {
    const { repository, planner, runner } = await fixture({
      revisionRound: 2,
      maxRevisionRounds: 2,
      presentationMode: 'VISUAL_DECK_V4',
      automationLevel: 'BOUNDED_AUTO',
      budgetUnits: 0,
      committedBudgetUnits: 0,
    })
    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'DELIVERING', step: null, plan: null })
    expect(planner.requests.size).toBe(0)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'DELIVERING', revisionRound: 2 })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type.startsWith('revision.'))).toBe(false)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'delivery.started' })
  })

  test('keeps a supervised v4 run behind internal review when revisions are disabled', async () => {
    const { repository, planner, runner } = await fixture({
      presentationMode: 'VISUAL_DECK_V4',
      automationLevel: 'SUPERVISED',
      revisionRound: 0,
      maxRevisionRounds: 0,
      budgetUnits: 0,
      committedBudgetUnits: 0,
    })

    expect(await runner.plan('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', plan: null })
    expect(planner.requests.size).toBe(0)
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'NEEDS_HUMAN', qualityOverride: false,
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'approval.required')).toBe(true)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'delivery.started')).toBe(false)
  })

  test('counts completed page redraws against the public total revision limit', async () => {
    const { repository, planner, runner } = await fixture({
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

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', plan: null })
    expect(planner.requests.size).toBe(0)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', revisionRound: 2 })
  })

  test('rejects a plan that invents issue and source references', async () => {
    const invalid = plan()
    invalid.operations[0]!.issueIds = ['issue-invented']
    invalid.operations[0]!.sourceChunkIds = ['chunk-invented']
    const { repository, planner, runner } = await fixture({}, invalid)
    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', plan: null, step: { status: 'FAILED' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
    expect(planner.requests.size).toBe(2)
    expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'REVISION_PLAN_ISSUE_COVERAGE_INCOMPLETE',
    })
    const events = await repository.listEvents('run-1')
    expect(events.find((event) => event.type === 'phase.changed')?.payload)
      .toMatchObject({ from: 'DECK_REVIEW', to: 'NEEDS_HUMAN' })
    expect(events.map((event) => event.type)).toContain('approval.required')
  })

  test('rejects a repair operation that crosses the issue repair domain', async () => {
    const invalid = plan()
    invalid.operations[0]!.kind = 'REGENERATE_IMAGE'
    const { planner, runner } = await fixture({}, invalid)

    expect(await runner.plan('run-1')).toMatchObject({
      status: 'NEEDS_HUMAN', plan: null, step: { errorCode: 'REVISION_PLAN_FAILED' },
    })
    expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'REVISION_PLAN_REPAIR_DOMAIN_MISMATCH',
    })
  })

  test('rejects one operation that claims an issue from another slide', async () => {
    const invalid = plan()
    invalid.operations[0]!.issueIds = ['issue-1', 'issue-other-slide']
    invalid.operations[0]!.sourceChunkIds = ['chunk-1', 'chunk-2']
    invalid.operations.push({
      ...invalid.operations[0]!,
      id: 'operation-other-slide',
      slideId: 'run-1:slide:1',
      issueIds: ['issue-other-slide'],
      sourceChunkIds: ['chunk-1'],
    })
    const { repository, planner, runner } = await fixture({}, invalid)
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.issues.push({
        ...output.issues[0]!,
        id: 'issue-other-slide',
        slideIds: ['run-1:slide:1'],
        sourceChunkIds: ['chunk-1'],
      })
      transaction.putStep({ ...step, output })
    })

    expect(await runner.plan('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', plan: null })
    expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'REVISION_PLAN_ISSUE_SLIDE_MISMATCH',
    })
  })

  test('requires every slide named by a cross-page issue to receive an operation', async () => {
    const { repository, planner, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.issues[0]!.slideIds = ['run-1:slide:1', 'run-1:slide:2']
      transaction.putStep({ ...step, output })
    })

    expect(await runner.plan('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', plan: null })
    expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'REVISION_PLAN_ISSUE_COVERAGE_INCOMPLETE',
    })
  })

  test('requires source references for every knowledge-domain repair', async () => {
    const invalid = plan()
    invalid.operations[0]!.sourceChunkIds = []
    const { repository, planner, runner } = await fixture({}, invalid)
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.issues[0] = {
        ...output.issues[0]!,
        category: 'COMPOSITION_CONFLICT',
        repairDomain: 'KNOWLEDGE',
      }
      transaction.putStep({ ...step, output })
    })

    expect(await runner.plan('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', plan: null })
    expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'REVISION_PLAN_SOURCE_REFERENCE_REQUIRED',
    })
  })

  test('requires complete source coverage when one operation combines knowledge issues', async () => {
    const invalid = plan()
    invalid.operations[0]!.issueIds = ['issue-1', 'issue-2']
    const { repository, planner, runner } = await fixture({}, invalid)
    await repository.transact('run-1', (transaction) => {
      const key = deckReviewStepKey(transaction.run)
      const step = transaction.getStep(key)!
      const output = structuredClone(step.output as ReturnType<typeof review>)
      output.issues.push({
        ...output.issues[0]!,
        id: 'issue-2',
        summary: '第二页的另一项知识表述需要依据第一段教材修复。',
        sourceChunkIds: ['chunk-1'],
      })
      transaction.putStep({ ...step, output })
    })

    expect(await runner.plan('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', plan: null })
    expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'REVISION_PLAN_SOURCE_COVERAGE_INCOMPLETE',
    })
  })

  test('replaces an oversized model correction with the lossless review-summary fallback', async () => {
    const invalid = plan()
    invalid.operations.push(...[2, 3].map((index) => ({
      ...invalid.operations[0]!,
      id: `operation-${index}`,
      instruction: `${index}${'补充上下文。'.repeat(300)}`.slice(0, 2_000),
    })))
    invalid.operations[0]!.instruction = `${'说明问题。'.repeat(400)}`.slice(0, 2_000)
    const { planner, runner } = await fixture({}, invalid, visualDeckV4Blueprint())

    expect(await runner.plan('run-1')).toMatchObject({
      status: 'AWAITING_REVISION_APPROVAL',
      plan: { operations: [{ instruction: '逐项修复审查问题：第二页中的产物描述缺少教材限定条件。' }] },
    })
    expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'V4_REVISION_INSTRUCTION_BUDGET_EXCEEDED',
    })
  })

  test('validates prior visual correction memory before starting another deck revision', async () => {
    const current = plan()
    current.operations[0]!.instruction = '保留历史视觉要求并修复当前页面问题。'.repeat(12)
    const { repository, planner, runner } = await fixture({
      revisionRound: 1, maxRevisionRounds: 4, presentationMode: 'VISUAL_DECK_V4',
      automationLevel: 'BOUNDED_AUTO', committedBudgetUnits: 0,
    }, current, visualDeckV4Blueprint())
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-prior-plan-r1', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 1),
        inputHash: 'prior-plan-r1', tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: {
          id: 'prior-plan-r1', reviewId: 'review-r0', revisionRound: 1,
          createdAt: transaction.run.createdAt, summary: '上一轮包含两项必须保留的页面视觉修复。',
          operations: [1, 2, 3].map((index) => ({
            id: `prior-operation-${index}`, slideId: 'run-1:slide:2', kind: 'RELAYOUT',
            issueIds: [`prior-issue-${index}`], instruction: String(index).repeat(1_400), sourceChunkIds: [],
          })),
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    expect(await runner.plan('run-1')).toMatchObject({
      status: 'DELIVERING', plan: null,
    })
    expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'V4_REVISION_INSTRUCTION_BUDGET_EXCEEDED',
    })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'revision.started')).toBe(false)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'run.failed')).toBe(false)
    expect((await repository.listEvents('run-1')).at(-1)).toMatchObject({ type: 'delivery.started' })
  })

  test('rejects missing, unknown and non-image v3 revision targets during planning', async () => {
    const targets = [
      { targetElementId: undefined, error: 'REVISION_TARGET_ELEMENT_REQUIRED' },
      { targetElementId: 'unknown-element', error: 'REVISION_TARGET_ELEMENT_INVALID' },
      { targetElementId: 'title-2', error: 'REVISION_TARGET_ELEMENT_INVALID' },
    ] as const
    for (const target of targets) {
      const invalid = plan()
      invalid.operations[0]!.kind = 'REGENERATE_IMAGE'
      invalid.operations[0]!.sourceChunkIds = []
      if (target.targetElementId) invalid.operations[0]!.targetElementId = target.targetElementId
      const { repository, planner, runner } = await fixture({}, invalid, layeredBlueprint())
      await repository.transact('run-1', (transaction) => {
        const key = deckReviewStepKey(transaction.run)
        const step = transaction.getStep(key)!
        const output = structuredClone(step.output as ReturnType<typeof review>)
        output.issues[0] = {
          ...output.issues[0]!,
          category: 'ASSET_RELEVANCE',
          severity: 'WARNING',
          sourceChunkIds: [],
          repairDomain: 'ASSET',
        }
        transaction.putStep({ ...step, output })
      })

      expect(await runner.plan('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', plan: null })
      expect([...planner.requests.values()][1]?.contractRepairIssues).toContainEqual({
        path: '$', message: target.error,
      })
    }
  })

  test('repairs malformed provider JSON with a distinct bounded model key', async () => {
    const { planner, runner } = await fixture()
    const validPlan = planner.plan.bind(planner)
    let attempts = 0
    planner.plan = async (input) => {
      attempts += 1
      if (attempts === 1) throw new StructuredModelError('MODEL_JSON_INVALID', true, 'gpt-test', null)
      return validPlan(input)
    }

    expect(await runner.plan('run-1')).toMatchObject({
      status: 'AWAITING_REVISION_APPROVAL', plan: { revisionRound: 1 },
    })
    expect(attempts).toBe(2)
    const repairRequest = [...planner.requests.values()][0]!
    expect(repairRequest.idempotencyKey).toMatch(/^revision-contract-repair-[a-f0-9]{64}$/)
    expect(repairRequest.contractRepairIssues).toEqual([{ path: '$', message: 'MODEL_JSON_INVALID' }])
  })

  test('retries a transient revision planning provider failure with the stable contract key', async () => {
    const { planner, runner } = await fixture()
    const planOnce = planner.plan.bind(planner)
    const keys: string[] = []
    planner.plan = async (input) => {
      keys.push(input.idempotencyKey)
      if (keys.length < 3) {
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6-terra', `plan-request-${keys.length}`)
      }
      return planOnce(input)
    }

    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL', plan: { revisionRound: 1 } })
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(1)
  })

  test('persists the final revision planning provider diagnostic after bounded retries are exhausted', async () => {
    const { repository, planner, runner } = await fixture()
    let attempts = 0
    planner.plan = async () => {
      attempts += 1
      throw new StructuredModelError('PROVIDER_TIMEOUT', true, 'gpt-5.6-terra', `plan-timeout-${attempts}`)
    }

    const result = await runner.plan('run-1')

    expect(attempts).toBe(5)
    expect(result).toMatchObject({
      status: 'NEEDS_HUMAN',
      step: {
        status: 'FAILED',
        errorCode: 'PROVIDER_TIMEOUT',
        output: {
          diagnostic: {
            providerAttempt: 5,
            maxProviderAttempts: 5,
            model: 'gpt-5.6-terra',
            requestId: 'plan-timeout-5',
          },
        },
      },
    })
  })

  test('does not use the v4 fallback after transient provider retries are exhausted', async () => {
    const { repository, planner, runner } = await fixture(
      { presentationMode: 'VISUAL_DECK_V4' },
      plan(),
      visualDeckV4Blueprint(),
    )
    let attempts = 0
    planner.plan = async () => {
      attempts += 1
      throw new StructuredModelError('PROVIDER_TIMEOUT', true, 'gpt-5.6-terra', `revision-plan-timeout-${attempts}`)
    }

    const result = await runner.plan('run-1')

    expect(attempts).toBe(5)
    expect(result).toMatchObject({
      status: 'RECOVERING',
      plan: null,
      step: {
        status: 'RUNNING',
        errorCode: 'PROVIDER_TIMEOUT',
        output: { diagnostic: { providerAttempt: 5, requestId: 'revision-plan-timeout-5' } },
      },
    })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'RECOVERING' })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'technical.recovery.started')).toBe(true)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('recovers a transient V4 source-resolution failure instead of asking the user to retry', async () => {
    const { repository, documents, runner } = await fixture({ presentationMode: 'VISUAL_DECK_V4' })
    documents.resolve = async () => { throw new Error('GATEWAY_HTTP_500') }

    expect(await runner.plan('run-1')).toMatchObject({ status: 'RECOVERING', step: null, plan: null })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING',
      technicalRecovery: { resumeState: 'DECK_REVIEW', reason: 'GATEWAY_HTTP_500', retryable: true },
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'technical.recovery.started')).toBe(true)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('replays a completed supervised plan without another planner call', async () => {
    const { planner, runner } = await fixture()
    const first = await runner.plan('run-1')
    const replay = await runner.plan('run-1')

    expect(replay).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL', replayed: true })
    expect(replay.plan).toEqual(first.plan)
    expect(planner.plans.size).toBe(1)
  })

  test('does not duplicate an in-flight revision plan', async () => {
    const { planner, runner } = await fixture()
    const planOnce = planner.plan.bind(planner)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    planner.plan = async (input) => {
      started()
      await gate
      return planOnce(input)
    }

    const first = runner.plan('run-1')
    await entered
    const second = runner.plan('run-1')
    release()
    const [completed, concurrent] = await Promise.all([first, second])

    expect(concurrent).toEqual(completed)
    expect(completed).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL', plan: { revisionRound: 1 } })
    expect(planner.plans.size).toBe(1)
  })

  test('converges successful planning across independent runner instances', async () => {
    const { repository, runner } = await fixture()
    const delayedPlanner = new MockRevisionPlanningPort(plan())
    const planOnce = delayedPlanner.plan.bind(delayedPlanner)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    delayedPlanner.plan = async (input) => {
      started()
      await gate
      return planOnce(input)
    }
    const competingRunner = new RevisionPlanningRunner({
      repository,
      documents: new StaticDocumentPort(),
      planner: delayedPlanner,
      clock: new FixedClock(),
      sleep: async () => {},
    })

    const lateCompletion = competingRunner.plan('run-1')
    await entered
    const completed = await runner.plan('run-1')
    release()
    const converged = await lateCompletion

    expect(completed).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL', replayed: false })
    expect(converged).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL', replayed: true })
    const events = await repository.listEvents('run-1')
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'phase.changed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'approval.required')).toHaveLength(1)
  })

  test('resumes a persisted running revision plan after process restart', async () => {
    const activeBlueprint = blueprint()
    const { repository, planner, runner } = await fixture({}, plan(), activeBlueprint)
    const persistedBlueprint = await getActiveBlueprint(repository, 'run-1', 0)
    const sourceChunks = [
      { id: 'chunk-1', sha256: 'sha-1' },
      { id: 'chunk-2', sha256: 'sha-2' },
    ]
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-run-1-revision-plan-r1',
        runId: 'run-1',
        idempotencyKey: revisionPlanStepKey('run-1', 1),
        inputHash: hashInput({
          tool: 'plan_revision',
          blueprint: persistedBlueprint,
          review: review(),
          sourceChunks,
          targetRevisionRound: 1,
        }),
        tool: 'plan_revision',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })

    const result = await runner.plan('run-1')

    expect(result).toMatchObject({ status: 'AWAITING_REVISION_APPROVAL', replayed: false, plan: { revisionRound: 1 } })
    expect(planner.plans.size).toBe(1)
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'plan_revision'))
      .toMatchObject({ status: 'COMPLETED' })
  })
})

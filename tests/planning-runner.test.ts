import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockStructuredModelPort } from '../src/adapters/mock-ports'
import { PlanningRunner } from '../src/core/planning-runner'
import type { DocumentPort, DocumentResult, RunRecord } from '../src/core/ports'
import type { StructuredModelPort } from '../src/core/ports'

const source = {
  kind: 'TEXT',
  name: '光合作用教材.txt',
  text: '绿色植物通过光合作用制造有机物并释放氧气。'.repeat(10),
} as const

const request = {
  runId: 'run-1',
  stepId: 'step-plan-1',
  idempotencyKey: 'run-1:blueprint:v1',
  source,
  slideCount: 2,
  visualDirection: '清晰的课堂科学信息图风格',
} as const

function run(): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source,
    slideCount: 2,
    visualDirection: request.visualDirection,
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'PLANNING',
    resumeState: null,
    version: 0,
    budgetUnits: 100,
    committedBudgetUnits: 0,
    qualityOverride: false,
    qualityOverrideReason: null,
    qualityOverrideBy: null,
    leaseToken: null,
    leaseUntil: null,
    leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function document(overrides: Partial<DocumentResult> = {}): DocumentResult {
  return {
    name: '光合作用教材.txt',
    chunks: [
      { id: 'chunk-0001', text: '绿色植物利用光能制造有机物。', sha256: 'sha-1' },
      { id: 'chunk-0002', text: '这个过程释放氧气，需要叶绿体。', sha256: 'sha-2' },
    ],
    isComplete: true,
    missingRanges: [],
    ...overrides,
  }
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    title: '绿色植物的光合作用',
    curriculum: {
      subject: '生物',
      grade: '七年级',
      lessonTitle: '绿色植物的光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
      learningObjectives: ['理解光合作用的基本条件和产物'],
      scopeBoundaries: ['仅覆盖教材中的定性知识'],
      prohibitedExtensions: ['不扩展复杂化学反应机理'],
      sourceChunkIds: ['chunk-0001', 'chunk-0002'],
    },
    slides: [
      {
        pageNumber: 1,
        title: '认识光合作用',
        body: ['绿色植物能够利用光能制造有机物'],
        layout: 'HERO',
        visualIntent: '以阳光照射绿色叶片建立主题视觉',
        visualPrompt: 'A classroom illustration of green leaves receiving sunlight, no text or symbols',
        sourceChunkIds: ['chunk-0001'],
      },
      {
        pageNumber: 2,
        title: '条件与产物',
        body: ['需要叶绿体', '释放氧气'],
        layout: 'SPLIT',
        visualIntent: '左右构图呈现反应条件和主要产物',
        visualPrompt: 'A balanced botanical science scene with open text-safe areas, no text or symbols',
        sourceChunkIds: ['chunk-0002'],
      },
    ],
    ...overrides,
  }
}

class MutableDocumentPort implements DocumentPort {
  constructor(public result: DocumentResult) {}
  async resolve() { return structuredClone(this.result) }
}

async function fixture(documentResult = document(), modelResponse: unknown = draft()) {
  const repository = new InMemoryAgentRepository()
  const documents = new MutableDocumentPort(documentResult)
  const model = new MockStructuredModelPort(modelResponse)
  await repository.createRun(run())
  const runner = new PlanningRunner({ repository, documents, model, clock: new FixedClock() })
  return { repository, documents, model, runner }
}

describe('planning runner', () => {
  test('plans a source-grounded blueprint and waits for approval', async () => {
    const { repository, model, runner } = await fixture()
    const result = await runner.plan(request)

    expect(result).toMatchObject({ replayed: false, step: { status: 'COMPLETED' } })
    expect(result.blueprint?.slides).toHaveLength(2)
    expect(result.blueprint?.curriculum.sourceChunkIds).toEqual(['chunk-0001', 'chunk-0002'])
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
    expect(model.executions.size).toBe(1)
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toEqual([
      'tool.started',
      'tool.completed',
      'phase.changed',
      'approval.required',
    ])
  })

  test('replays the persisted blueprint without another model execution', async () => {
    const { model, runner } = await fixture()
    const first = await runner.plan(request)
    const replay = await runner.plan(request)

    expect(replay.replayed).toBe(true)
    expect(replay.blueprint).toEqual(first.blueprint)
    expect(model.executions.size).toBe(1)
  })

  test('repairs dynamic source-reference failures before persisting the blueprint', async () => {
    const repository = new InMemoryAgentRepository()
    const documents = new MutableDocumentPort(document())
    const invalid = draft()
    invalid.slides[1]!.sourceChunkIds = ['chunk-invented']
    const executions: Parameters<StructuredModelPort['execute']>[0][] = []
    const model: StructuredModelPort = {
      async execute(input) {
        executions.push(structuredClone(input))
        return structuredClone(executions.length === 1 ? invalid : draft())
      },
    }
    await repository.createRun(run())
    const runner = new PlanningRunner({ repository, documents, model, clock: new FixedClock() })

    const result = await runner.plan(request)

    expect(result.step.status).toBe('COMPLETED')
    expect(executions).toHaveLength(2)
    expect(executions[1]!.idempotencyKey).toMatch(/^blueprint-repair-[a-f0-9]{64}$/)
    expect(executions[1]!.payload).toMatchObject({
      contractRepairIssues: [{ path: 'blueprint', message: 'BLUEPRINT_SOURCE_REFERENCE_INVALID' }],
    })
  })

  test('stops before the model when document extraction is incomplete', async () => {
    const { repository, model, runner } = await fixture(document({
      isComplete: false,
      missingRanges: ['附件文本提取已截断，原文件共 80 页'],
    }))
    const result = await runner.plan(request)

    expect(result).toMatchObject({ blueprint: null, step: { status: 'FAILED', errorCode: 'SOURCE_INCOMPLETE' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
    expect(model.executions.size).toBe(0)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'issue.detected')).toBe(true)
  })

  test('rejects invented source references from model output', async () => {
    const invalid = draft()
    invalid.slides[1]!.sourceChunkIds = ['chunk-invented']
    const { repository, runner } = await fixture(document(), invalid)
    const result = await runner.plan(request)

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'BLUEPRINT_SOURCE_REFERENCE_INVALID' })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
  })

  test('rejects the same planning key when resolved document content changes', async () => {
    const { documents, runner } = await fixture()
    await runner.plan(request)
    documents.result = document({
      chunks: [{ id: 'chunk-0001', text: '宿主附件已经改变。', sha256: 'changed-sha' }],
    })

    await expect(runner.plan(request)).rejects.toThrow('STEP_IDEMPOTENCY_CONFLICT')
  })
})

import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockRevisionApplicationPort } from '../src/adapters/mock-ports'
import { getActiveBlueprint } from '../src/core/active-blueprint'
import { planningStepKey } from '../src/core/planning-runner'
import type { DocumentPort, RunRecord } from '../src/core/ports'
import { RevisionApplicationRunner } from '../src/core/revision-application-runner'
import { revisionPlanStepKey } from '../src/core/revision-planning-runner'

function run(): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-1', requestHash: 'hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是局部修订执行器使用的完整测试教材。' },
    slideCount: 2, visualDirection: '课堂科学信息图', imageModel: 'image-2',
    automationLevel: 'SUPERVISED', maxRevisionRounds: 2, revisionRound: 1,
    qualityScore: 72, status: 'REVISING', resumeState: null, version: 8,
    budgetUnits: 100, committedBudgetUnits: 20, qualityOverride: false,
    qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null,
    leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function blueprint() {
  return {
    id: 'blueprint-r0', title: '光合作用', visualDirection: '课堂科学信息图',
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1', 'chunk-2'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber, title: pageNumber === 1 ? '认识光合作用' : '条件与产物',
      body: [pageNumber === 1 ? '绿色植物利用光能' : '产生有机物并释放氧气'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: `用课堂科学画面表达第 ${pageNumber} 页知识点`,
      visualPrompt: `A clean educational science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: [`chunk-${pageNumber}`],
    })),
  }
}

function plan(kind: 'UPDATE_CONTENT' | 'REGENERATE_IMAGE' | 'RELAYOUT' = 'UPDATE_CONTENT') {
  return {
    id: 'revision-plan-r1', reviewId: 'deck-review-r0', revisionRound: 1,
    createdAt: '2026-07-21T00:00:00.000Z', summary: '仅修订第二页已经识别的问题。',
    operations: [{
      id: 'operation-1', slideId: 'run-1:slide:2', kind, issueIds: ['issue-1'],
      instruction: '依据教材限定条件修订第二页，不改变其他页面。', sourceChunkIds: ['chunk-2'],
    }],
  }
}

function draft() {
  const { id: _id, visualDirection: _visualDirection, createdAt: _createdAt, ...value } = blueprint()
  return structuredClone(value)
}

class StaticDocumentPort implements DocumentPort {
  async resolve() {
    return {
      name: '教材.txt', isComplete: true, missingRanges: [],
      chunks: [
        { id: 'chunk-1', text: '绿色植物利用光能。', sha256: 'sha-1' },
        { id: 'chunk-2', text: '制造有机物并释放氧气。', sha256: 'sha-2' },
      ],
    }
  }
}

async function fixture(response: unknown, revisionPlan = plan()) {
  const repository = new InMemoryAgentRepository()
  const application = new MockRevisionApplicationPort(response)
  await repository.createRun(run())
  await repository.transact('run-1', (transaction) => {
    transaction.putStep({
      id: 'step-plan', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'plan-hash',
      tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: blueprint(),
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    transaction.putStep({
      id: 'step-revision-plan', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 1), inputHash: 'revision-plan-hash',
      tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: revisionPlan,
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
  })
  return {
    repository, application,
    runner: new RevisionApplicationRunner({
      repository, documents: new StaticDocumentPort(), application, clock: new FixedClock(),
    }),
  }
}

describe('revision application runner', () => {
  test('updates only the planned content slide and returns to deck review', async () => {
    const revised = draft()
    revised.slides[1]!.body = ['在光照条件下制造有机物并释放氧气']
    const { repository, runner } = await fixture(revised)
    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'DECK_REVIEW', requiresMedia: false, replayed: false })
    expect(result.blueprint?.slides[0]?.body).toEqual(blueprint().slides[0]?.body)
    expect(result.blueprint?.slides[1]?.body).toEqual(revised.slides[1]?.body)
    expect((await getActiveBlueprint(repository, 'run-1', 1)).id).toBe('run-1:blueprint:r1')
  })

  test('rejects changes to a slide outside the revision plan', async () => {
    const revised = draft()
    revised.slides[0]!.title = '擅自修改的第一页'
    const { repository, runner } = await fixture(revised)
    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', blueprint: null, step: { errorCode: 'REVISION_APPLICATION_FAILED' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
  })

  test('keeps the run in revision when the plan requires a regenerated image', async () => {
    const revised = draft()
    revised.slides[1]!.visualPrompt = 'A corrected educational oxygen release illustration, no text or symbols'
    const { repository, runner } = await fixture(revised, plan('REGENERATE_IMAGE'))
    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'REVISING', requiresMedia: true })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'REVISING', revisionRound: 1 })
  })

  test('replays a completed application without another model execution', async () => {
    const revised = draft()
    revised.slides[1]!.body = ['在光照条件下制造有机物并释放氧气']
    const { application, runner } = await fixture(revised)
    const first = await runner.apply('run-1')
    const replay = await runner.apply('run-1')

    expect(replay).toMatchObject({ status: 'DECK_REVIEW', replayed: true })
    expect(replay.blueprint).toEqual(first.blueprint)
    expect(application.applications.size).toBe(1)
  })
})

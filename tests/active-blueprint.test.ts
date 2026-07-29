import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { getActiveBlueprint, revisionBlueprintStepKey } from '../src/core/active-blueprint'
import { planningStepKey } from '../src/core/planning-runner'
import type { RunRecord } from '../src/core/ports'

function run(): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-1', requestHash: 'hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是当前有效蓝图读取器的完整测试教材。' },
    slideCount: 2, visualDirection: '课堂科学信息图', imageModel: 'image-2',
    automationLevel: 'SUPERVISED', maxRevisionRounds: 2, revisionRound: 1,
    qualityScore: 70, status: 'REVISING', resumeState: null, version: 5,
    budgetUnits: 100, committedBudgetUnits: 20, qualityOverride: false,
    qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null,
    leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function blueprint(id: string, secondTitle: string) {
  return {
    id,
    title: '光合作用',
    visualDirection: '课堂科学信息图',
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: pageNumber === 2 ? secondTitle : '认识光合作用',
      body: ['教材范围内的教学内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: '用清晰的科学课堂画面支持当前知识点',
      visualPrompt: 'A clean educational science illustration with no text or symbols',
      sourceChunkIds: ['chunk-1'],
    })),
  }
}

describe('active blueprint', () => {
  test('selects the latest completed revision at or before the current round', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())
    await repository.transact('run-1', (transaction) => {
      for (const [key, tool, output] of [
        [planningStepKey('run-1'), 'create_blueprint', blueprint('blueprint-r0', '条件与产物')],
        [revisionBlueprintStepKey('run-1', 1), 'apply_revision', blueprint('blueprint-r1', '修订后的条件与产物')],
        [revisionBlueprintStepKey('run-1', 2), 'apply_revision', blueprint('blueprint-r2', '未到轮次的标题')],
      ] as const) {
        transaction.putStep({
          id: `step-${key}`, runId: 'run-1', idempotencyKey: key, inputHash: `hash-${key}`,
          tool, status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
          externalOperationId: null, errorCode: null, output,
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        })
      }
    })

    const active = await getActiveBlueprint(repository, 'run-1', 1)
    expect(active.id).toBe('blueprint-r1')
    expect(active.slides[1]?.title).toBe('修订后的条件与产物')
  })

  test('falls back to the initial blueprint when no revision is complete', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-plan', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'hash-plan',
        tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null, output: blueprint('blueprint-r0', '条件与产物'),
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    expect((await getActiveBlueprint(repository, 'run-1', 1)).id).toBe('blueprint-r0')
  })

  test('uses the latest completed planning retry when the initial attempt failed', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun({
      ...run(),
      status: 'AWAITING_BLUEPRINT_APPROVAL',
      revisionRound: 0,
      planningAttempt: 1,
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-plan-initial', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'hash-plan-initial',
        tool: 'create_blueprint', status: 'FAILED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: 'BLUEPRINT_SOURCE_REFERENCE_INVALID', output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-plan-retry-1', runId: 'run-1', idempotencyKey: planningStepKey('run-1', 1), inputHash: 'hash-plan-retry-1',
        tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null, output: blueprint('blueprint-retry-1', '重试后的条件与产物'),
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    const active = await getActiveBlueprint(repository, 'run-1', 0)
    expect(active.id).toBe('blueprint-retry-1')
    expect(active.slides[1]?.title).toBe('重试后的条件与产物')
  })
})

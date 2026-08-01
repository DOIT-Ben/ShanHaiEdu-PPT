import { describe, expect, test } from 'bun:test'
import { FrameFlowHostAdapter } from '../src/adapters/frameflow-host'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { CONTRACT_VERSION } from '../src/contracts'
import { PlanningRunner, planningStepKey } from '../src/core/planning-runner'
import { RunService } from '../src/core/run-service'
import {
  compileVisualDeckV4Proposal,
  visualDeckV4PlanningStageStepKey,
  type VisualDeckV4PlanningStage,
} from '../src/core/visual-deck-v4-planner'
import type { StructuredModelPort } from '../src/core/ports'

const stages: readonly VisualDeckV4PlanningStage[] = [
  'source-spec', 'deck-visual', 'slide-briefs', 'final-coherence',
]

function request() {
  return {
    schemaVersion: CONTRACT_VERSION,
    host: { tenantId: 'frameflow', externalUserId: 'v4-user' },
    source: {
      kind: 'SOURCE_PACKAGE' as const,
      name: '百分数课程资料',
      sources: [
        { kind: 'TEXT' as const, sourceId: 'textbook', name: '教材.md', roleHint: 'CONTENT_SOURCE' as const, text: '教材解释百分数表示一个数是另一个数的百分之几，并提供生活比较案例。'.repeat(8) },
        { kind: 'TEXT' as const, sourceId: 'design', name: '设计稿.md', roleHint: 'DESIGN_REFERENCE' as const, text: '设计稿要求用清晰视觉层级、统一配色和逐步展开的课堂叙事。'.repeat(8) },
      ],
    },
    slideCount: 10,
    visualDirection: '成熟清晰的资料驱动课堂视觉叙事',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED' as const,
    budgetUnits: 10,
    presentationMode: 'VISUAL_DECK_V4' as const,
    visualDeckV4: {
      instruction: '为六年级学生制作一套理解百分数的视觉演示',
      sourceMode: 'SOURCE_GROUNDED' as const,
      deckOptions: {
        deckType: 'DETAILED_DECK' as const, language: 'zh-CN', length: { slideCount: 10 }, aspectRatio: '16:9' as const,
        audience: '小学六年级学生', focus: '理解统一比较标准', styleHint: '成熟清晰的课堂信息图',
      },
    },
  }
}

function coherenceReview() {
  return {
    decision: 'APPROVED' as const,
    summary: '资料绑定、十页叙事、逐页施工单与统一视觉规则均已核对。',
    checks: [
      'REQUEST_BINDING', 'SOURCE_GROUNDING', 'NARRATIVE_COHERENCE', 'SLIDE_COVERAGE', 'VISUAL_COHERENCE',
    ].map((dimension) => ({ dimension, passed: true as const, evidence: `${dimension} 已通过。` })),
  }
}

function documents() {
  return new FrameFlowHostAdapter({
    async getDocumentAttachment(): Promise<never> { throw new Error('attachment access is not expected') },
    async reserveCredits(): Promise<never> { throw new Error('budget access is not expected') },
    async settleCredits(): Promise<never> { throw new Error('budget access is not expected') },
    async releaseCredits(): Promise<never> { throw new Error('budget access is not expected') },
  })
}

function proposalFromSourceStage(
  created: Awaited<ReturnType<RunService['create']>>,
  input: ReturnType<typeof request>,
  clock: FixedClock,
  payload: any,
) {
  return compileVisualDeckV4Proposal({
    runId: created.run.id,
    inputHash: 'model-v4-plan',
    source: created.run.source,
    document: { ...payload.document, isComplete: true },
    config: input.visualDeckV4,
    slideCount: input.slideCount,
    visualDirection: input.visualDirection,
    createdAt: clock.now().toISOString(),
  })
}

function stagedModel(
  created: Awaited<ReturnType<RunService['create']>>,
  input: ReturnType<typeof request>,
  clock: FixedClock,
  failSlideBriefsOnce = false,
  repairSlideBriefsOnce = false,
) {
  let proposal: ReturnType<typeof compileVisualDeckV4Proposal> | null = null
  let shouldFail = failSlideBriefsOnce
  const operations: string[] = []
  const repairPayloads: unknown[] = []
  const model: StructuredModelPort & { preflightStructuredGeneration: () => Promise<{ protocol: 'RESPONSES_JSON_SCHEMA' }> } = {
    async preflightStructuredGeneration() { return { protocol: 'RESPONSES_JSON_SCHEMA' } },
    async execute(modelInput) {
      operations.push(modelInput.operation)
      if (modelInput.operation === 'create_visual_deck_v4_source_spec') {
        proposal = proposalFromSourceStage(created, input, clock, modelInput.payload)
        return { sourceUnderstanding: proposal.sourceUnderstanding, presentationSpec: proposal.presentationSpec }
      }
      if (!proposal) throw new Error('TEST_SOURCE_SPEC_REQUIRED')
      if (modelInput.operation === 'create_visual_deck_v4_deck_visual') {
        return { deckPlan: proposal.deckPlan, visualContract: proposal.visualContract }
      }
      if (modelInput.operation === 'create_visual_deck_v4_slide_briefs') {
        if (shouldFail) {
          shouldFail = false
          throw new Error('TEST_SLIDE_BRIEFS_FAILURE')
        }
        const slideBriefs = structuredClone(proposal.slideBriefs)
        if (repairSlideBriefsOnce) {
          const payload = modelInput.payload as { contractRepairIssues?: unknown }
          if (!payload.contractRepairIssues) {
            slideBriefs[1]!.numbers = ['999']
          } else {
            repairPayloads.push(payload.contractRepairIssues)
            slideBriefs[1]!.numbers = ['999']
            slideBriefs[1]!.lockedCopy.push('999')
          }
        }
        return { slideBriefs }
      }
      if (modelInput.operation === 'review_visual_deck_v4_coherence') return coherenceReview()
      throw new Error(`TEST_OPERATION_UNEXPECTED:${modelInput.operation}`)
    },
  }
  return { model, operations, repairPayloads }
}

describe('visual deck v4 planning runner', () => {
  test('persists a real ten-page plan as four recoverable structured stages', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = new RunService({ repository, clock })
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-planning-0001')
    const { model, operations } = stagedModel(created, inputRequest, clock)
    const runner = new PlanningRunner({ repository, documents: documents(), model, clock })
    const input = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    } as const

    await expect(runner.plan({ ...input, presentationMode: 'SLIDE_IMAGE_V2' }))
      .rejects.toThrow('RUN_PRESENTATION_MODE_MISMATCH')
    const first = await runner.plan(input)
    const replay = await runner.plan(input)

    expect(operations).toEqual([
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'create_visual_deck_v4_slide_briefs',
      'review_visual_deck_v4_coherence',
    ])
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(first.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'AWAITING_BLUEPRINT_APPROVAL', committedBudgetUnits: 0,
    })
    const steps = await repository.listSteps(created.run.id)
    expect(steps).toHaveLength(6)
    for (const stage of stages) {
      expect(steps.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(created.run.id, stage)))
        .toMatchObject({ status: 'COMPLETED' })
    }
  })

  test('resumes only the failed Slide Briefs stage with its original idempotency key', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = new RunService({ repository, clock })
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-planning-recovery-0001')
    const { model, operations } = stagedModel(created, inputRequest, clock, true)
    const runner = new PlanningRunner({ repository, documents: documents(), model, clock })
    const input = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    } as const

    const failed = await runner.plan(input)
    expect(failed.blueprint).toBeNull()
    expect(await repository.getRun(created.run.id)).toMatchObject({ status: 'NEEDS_HUMAN' })
    const beforeRetry = await repository.listSteps(created.run.id)
    expect(beforeRetry.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(created.run.id, 'source-spec')))
      .toMatchObject({ status: 'COMPLETED' })
    expect(beforeRetry.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(created.run.id, 'slide-briefs')))
      .toMatchObject({ status: 'FAILED' })

    const resumedRun = await service.act(created.run.id, created.run.host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_PLANNING', expectedVersion: (await repository.getRun(created.run.id))!.version,
    }, 'retry-v4-stage-0001')
    expect(resumedRun.planningAttempt).toBe(0)
    const resumed = await runner.plan(input)
    expect(resumed.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect((await repository.getRunEventSnapshot(created.run.id)).openIssues).toEqual([])
    expect(operations).toEqual([
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'create_visual_deck_v4_slide_briefs',
      'create_visual_deck_v4_slide_briefs',
      'review_visual_deck_v4_coherence',
    ])
  })

  test('repairs a cross-field Slide Brief contract without rerunning prior V4 stages', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = new RunService({ repository, clock })
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-slide-brief-contract-repair-0001')
    const { model, operations, repairPayloads } = stagedModel(created, inputRequest, clock, false, true)
    const runner = new PlanningRunner({ repository, documents: documents(), model, clock })
    const input = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    } as const

    const result = await runner.plan(input)

    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs[1]?.lockedCopy).toContain('999')
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'AWAITING_BLUEPRINT_APPROVAL', committedBudgetUnits: 0,
    })
    expect(operations).toEqual([
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'create_visual_deck_v4_slide_briefs',
      'create_visual_deck_v4_slide_briefs',
      'review_visual_deck_v4_coherence',
    ])
    expect(repairPayloads).toEqual([[
      { path: 'slideBriefs.1.numbers.0', message: 'v4 visible numbers must occur in title or lockedCopy' },
    ]])
    const steps = await repository.listSteps(created.run.id)
    expect(steps.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(
      created.run.id, 'slide-briefs', 0, 1,
    ))).toMatchObject({ status: 'COMPLETED' })
  })
})

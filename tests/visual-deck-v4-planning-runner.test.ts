import { describe, expect, test } from 'bun:test'
import { FrameFlowHostAdapter } from '../src/adapters/frameflow-host'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { CONTRACT_VERSION } from '../src/contracts'
import { PlanningRunner, planningStepKey } from '../src/core/planning-runner'
import { RunService } from '../src/core/run-service'
import {
  type VisualDeckV4PlanningArtifact,
  visualDeckV4PlanningArtifactStepKey,
} from '../src/core/visual-deck-v4-planner'
import type { StructuredModelPort } from '../src/core/ports'

const artifacts: readonly VisualDeckV4PlanningArtifact[] = [
  'source-understanding', 'presentation-spec', 'deck-plan', 'slide-briefs', 'visual-contract',
]

describe('visual deck v4 planning runner', () => {
  test('persists and replays the five-stage mock plan without calling a provider', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-07-30T00:00:00.000Z'))
    const service = new RunService({ repository, clock })
    const request = {
      schemaVersion: CONTRACT_VERSION,
      host: { tenantId: 'frameflow', externalUserId: 'v4-user' },
      source: {
        kind: 'SOURCE_PACKAGE',
        name: '百分数课程资料',
        sources: [
          { kind: 'TEXT', sourceId: 'textbook', name: '教材.md', roleHint: 'CONTENT_SOURCE', text: '教材解释百分数表示一个数是另一个数的百分之几，并提供生活比较案例。'.repeat(8) },
          { kind: 'TEXT', sourceId: 'design', name: '设计稿.md', roleHint: 'DESIGN_REFERENCE', text: '设计稿要求用清晰视觉层级、统一配色和逐步展开的课堂叙事。'.repeat(8) },
        ],
      },
      slideCount: 12,
      visualDirection: '成熟清晰的资料驱动课堂视觉叙事',
      imageModel: 'image-2',
      automationLevel: 'SUPERVISED',
      budgetUnits: 12,
      presentationMode: 'VISUAL_DECK_V4',
      visualDeckV4: {
        instruction: '为六年级学生制作一套理解百分数的视觉演示',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: {
          deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 12 }, aspectRatio: '16:9',
          audience: '小学六年级学生', focus: '理解统一比较标准', styleHint: '成熟清晰的课堂信息图',
        },
      },
    } as const
    const created = await service.create(request, 'create-v4-planning-0001')
    let providerCalls = 0
    const model: StructuredModelPort = {
      async execute() {
        providerCalls += 1
        throw new Error('v4 mock planning must not call a provider')
      },
    }
    const documents = new FrameFlowHostAdapter({
      async getDocumentAttachment(): Promise<never> { throw new Error('attachment access is not expected') },
      async reserveCredits(): Promise<never> { throw new Error('budget access is not expected') },
      async settleCredits(): Promise<never> { throw new Error('budget access is not expected') },
      async releaseCredits(): Promise<never> { throw new Error('budget access is not expected') },
    })
    const runner = new PlanningRunner({ repository, documents, model, clock })
    const input = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: request.presentationMode,
      visualDeckV4: request.visualDeckV4,
    } as const

    await expect(runner.plan({ ...input, presentationMode: 'SLIDE_IMAGE_V2' }))
      .rejects.toThrow('RUN_PRESENTATION_MODE_MISMATCH')
    const first = await runner.plan(input)
    const replay = await runner.plan(input)
    const proposal = first.blueprint?.visualDeckV4Proposal

    expect(providerCalls).toBe(0)
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(proposal?.slideBriefs).toHaveLength(12)
    const available = new Set(proposal?.sourceUnderstanding.sources.flatMap((source) => source.sourceChunkIds))
    expect(proposal?.slideBriefs.every((brief) => brief.sourceChunkIds.every((id) => available.has(id)))).toBe(true)
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'AWAITING_BLUEPRINT_APPROVAL',
      committedBudgetUnits: 0,
    })
    const steps = await repository.listSteps(created.run.id)
    expect(steps).toHaveLength(6)
    expect(steps.filter((step) => step.status === 'COMPLETED')).toHaveLength(6)
    for (const artifact of artifacts) {
      expect(steps.some((step) => step.idempotencyKey === visualDeckV4PlanningArtifactStepKey(created.run.id, artifact))).toBe(true)
    }
  })
})

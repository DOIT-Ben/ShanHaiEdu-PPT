import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockVisualReviewPort } from '../src/adapters/mock-ports'
import { PageReviewCoordinator } from '../src/core/page-review-coordinator'
import { planningStepKey } from '../src/core/planning-runner'
import type { RunRecord } from '../src/core/ports'
import { VisualReviewRunner } from '../src/core/visual-review-runner'

function run(): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于页面质检聚合测试的完整教材内容。' },
    slideCount: 3,
    visualDirection: '清晰的课堂科学信息图风格',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'PAGE_REVIEW',
    resumeState: null,
    version: 5,
    budgetUnits: 100,
    committedBudgetUnits: 30,
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
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2, 3].map((pageNumber) => ({
      pageNumber,
      title: `第 ${pageNumber} 页`,
      body: ['教学内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: `第 ${pageNumber} 页对应的教材视觉目标`,
      visualPrompt: `A clean science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: ['chunk-1'],
    })),
  }
}

async function fixture() {
  const repository = new InMemoryAgentRepository()
  const reviewerPort = new MockVisualReviewPort({
    approved: true,
    textDetected: false,
    visualScore: 90,
    reasons: [],
    retryInstruction: null,
  })
  const clock = new FixedClock()
  await repository.createRun(run())
  await repository.transact('run-1', (transaction) => {
    transaction.putStep({
      id: 'step-plan', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'plan-hash',
      tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: blueprint(),
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    for (const pageNumber of [1, 2, 3]) {
      transaction.putStep({
        id: `step-image-${pageNumber}`,
        runId: 'run-1',
        idempotencyKey: `run-1:slide:${pageNumber}:image:r0:v1`,
        inputHash: `image-hash-${pageNumber}`,
        tool: 'generate_slide_image',
        status: 'COMPLETED',
        budgetUnits: 10,
        budgetReservationId: `budget-${pageNumber}`,
        externalOperationId: `operation-${pageNumber}`,
        errorCode: null,
        output: {
          slideId: `run-1:slide:${pageNumber}`,
          versionId: `run-1:slide:${pageNumber}:r0:v1`,
          artifactId: `artifact-${pageNumber}`,
        },
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    }
  })
  const reviewer = new VisualReviewRunner({ repository, reviewer: reviewerPort, clock })
  return { repository, reviewerPort, coordinator: new PageReviewCoordinator({ repository, reviewer, clock }) }
}

describe('page review coordinator', () => {
  test('moves to deck review only when every page is approved', async () => {
    const { repository, reviewerPort, coordinator } = await fixture()
    const result = await coordinator.reviewAll('run-1')

    expect(result).toMatchObject({ status: 'DECK_REVIEW', approved: 3, rejected: 0, total: 3 })
    expect(reviewerPort.reviews.size).toBe(3)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'DECK_REVIEW', version: 6 })
  })

  test('stops for human approval when one page is rejected without creating media', async () => {
    const { repository, reviewerPort, coordinator } = await fixture()
    reviewerPort.respondToArtifact('artifact-2', {
      approved: false,
      textDetected: true,
      visualScore: 35,
      reasons: ['图片中出现可读文字'],
      retryInstruction: 'Remove all text, letters, numbers, logos and watermarks from the image.',
    })
    const result = await coordinator.reviewAll('run-1')

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', approved: 2, rejected: 1, total: 3 })
    expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'generate_slide_image')).toHaveLength(3)
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toContain('approval.required')
  })

  test('replays a completed page-review phase without model calls', async () => {
    const { reviewerPort, coordinator } = await fixture()
    const first = await coordinator.reviewAll('run-1')
    const replay = await coordinator.reviewAll('run-1')

    expect(replay).toMatchObject({ status: 'DECK_REVIEW', approved: 3, total: 3 })
    expect(first.approved).toBe(replay.approved)
    expect(reviewerPort.reviews.size).toBe(3)
  })
})

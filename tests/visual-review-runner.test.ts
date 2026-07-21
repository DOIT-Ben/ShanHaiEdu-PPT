import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockVisualReviewPort } from '../src/adapters/mock-ports'
import { VisualReviewRunner } from '../src/core/visual-review-runner'
import type { RunRecord } from '../src/core/ports'

const request = {
  runId: 'run-1',
  stepId: 'step-review-1',
  idempotencyKey: 'run-1:slide-1:review-v1',
  slideId: 'slide-1',
  versionId: 'slide-1:v1',
  artifactId: 'artifact-1',
  visualIntent: '绿色叶片在阳光下展示光合作用主题',
  layout: 'HERO',
  visualDirection: '清晰的课堂科学信息图风格',
} as const

function run(): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于视觉质检测试的完整教材内容。' },
    slideCount: 2,
    visualDirection: request.visualDirection,
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'PAGE_REVIEW',
    resumeState: null,
    version: 1,
    budgetUnits: 100,
    committedBudgetUnits: 10,
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

async function fixture(response: unknown) {
  const repository = new InMemoryAgentRepository()
  const reviewer = new MockVisualReviewPort(response)
  await repository.createRun(run())
  return {
    repository,
    reviewer,
    runner: new VisualReviewRunner({ repository, reviewer, clock: new FixedClock() }),
  }
}

describe('side-effect-free visual review runner', () => {
  test('persists an approved review without changing media budget', async () => {
    const { repository, reviewer, runner } = await fixture({
      approved: true,
      textDetected: false,
      visualScore: 92,
      reasons: [],
      retryInstruction: null,
    })
    const result = await runner.review(request)

    expect(result).toMatchObject({ replayed: false, review: { approved: true, visualScore: 92 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'PAGE_REVIEW', committedBudgetUnits: 10 })
    expect(reviewer.reviews.size).toBe(1)
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toEqual(['tool.started', 'tool.completed'])
  })

  test('reports a rejected image but does not create a redraw', async () => {
    const { repository, runner } = await fixture({
      approved: false,
      textDetected: true,
      visualScore: 40,
      reasons: ['图片中出现可读文字'],
      retryInstruction: 'Remove every visible word, letter, number, logo and watermark from the image.',
    })
    const result = await runner.review(request)

    expect(result.review).toMatchObject({ approved: false, textDetected: true })
    expect(await repository.listSteps('run-1')).toHaveLength(1)
    const issue = (await repository.listEvents('run-1')).find((event) => event.type === 'issue.detected')
    expect(issue?.payload).toMatchObject({ severity: 'CRITICAL', slideIds: ['slide-1'] })
  })

  test('replays a persisted review and rejects changed inputs', async () => {
    const { reviewer, runner } = await fixture({
      approved: true,
      textDetected: false,
      visualScore: 90,
      reasons: [],
      retryInstruction: null,
    })
    const first = await runner.review(request)
    const replay = await runner.review(request)

    expect(replay.replayed).toBe(true)
    expect(replay.review).toEqual(first.review)
    expect(reviewer.reviews.size).toBe(1)
    await expect(runner.review({ ...request, artifactId: 'artifact-2' }))
      .rejects.toThrow('STEP_IDEMPOTENCY_CONFLICT')
  })

  test('moves to human review when the reviewer returns an invalid contract', async () => {
    const { repository, runner } = await fixture({
      approved: true,
      textDetected: true,
      visualScore: 80,
      reasons: [],
      retryInstruction: null,
    })
    const result = await runner.review(request)

    expect(result).toMatchObject({ review: null, step: { status: 'FAILED', errorCode: 'VISUAL_REVIEW_FAILED' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
  })
})

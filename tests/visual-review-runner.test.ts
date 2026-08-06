import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockVisualReviewPort } from '../src/adapters/mock-ports'
import { VisualReviewRunner } from '../src/core/visual-review-runner'
import { StructuredModelError } from '../src/core/ports'
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
    imageModel: 'gpt-image-2',
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
    runner: new VisualReviewRunner({ repository, reviewer, clock: new FixedClock(), sleep: async () => {} }),
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

  test('persists an invalid review result without taking ownership of the batch phase', async () => {
    const { repository, runner } = await fixture({
      approved: true,
      textDetected: true,
      visualScore: 80,
      reasons: [],
      retryInstruction: null,
    })
    const result = await runner.review(request)

    expect(result).toMatchObject({
      review: null,
      step: {
        status: 'FAILED',
        errorCode: 'MODEL_JSON_INVALID',
        output: {
          diagnostic: {
            providerAttempt: 1,
            maxProviderAttempts: 5,
            contractAttempt: 2,
            maxContractAttempts: 2,
            model: null,
            requestId: null,
          },
        },
      },
    })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'PAGE_REVIEW' })
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toEqual([
      'tool.started', 'tool.failed',
    ])
  })

  test('retries a transient review provider failure with the same idempotency key', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())
    const requests: string[] = []
    const delays: number[] = []
    const reviewer = new VisualReviewRunner({
      repository,
      clock: new FixedClock(),
      reviewer: {
        async review(input) {
          requests.push(input.idempotencyKey)
          if (requests.length < 5) {
            throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6-terra', 'review-request-1')
          }
          return { approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null }
        },
      },
      sleep: async (milliseconds) => { delays.push(milliseconds) },
    })

    const result = await reviewer.review(request)

    expect(result.review).toMatchObject({ approved: true, visualScore: 92 })
    expect(requests).toEqual(Array.from({ length: 5 }, () => request.idempotencyKey))
    expect(delays).toEqual([2_000, 10_000, 30_000, 60_000])
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'PAGE_REVIEW' })
  })

  test('repairs an invalid review contract with a distinct model key', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())
    const requests: string[] = []
    const contractIssues: unknown[] = []
    const delays: number[] = []
    const reviewer = new VisualReviewRunner({
      repository,
      clock: new FixedClock(),
      reviewer: {
        async review(input) {
          requests.push(input.idempotencyKey)
          contractIssues.push(input.contractRepairIssues)
          if (requests.length === 1) {
            return { approved: true, textDetected: true, visualScore: 80, reasons: [], retryInstruction: null }
          }
          return { approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null }
        },
      },
      sleep: async (milliseconds) => { delays.push(milliseconds) },
    })

    const result = await reviewer.review(request)

    expect(result.review).toMatchObject({ approved: true, visualScore: 92 })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toBe(request.idempotencyKey)
    expect(requests[1]).not.toBe(request.idempotencyKey)
    expect(delays).toEqual([])
    expect(contractIssues[1]).toEqual([
      { path: 'approved', message: 'an image with detected text cannot be approved' },
    ])
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'PAGE_REVIEW' })
  })

  test('preserves the final provider diagnostic after bounded retries are exhausted', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())
    let attempts = 0
    const runner = new VisualReviewRunner({
      repository,
      clock: new FixedClock(),
      reviewer: {
        async review() {
          attempts += 1
          throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6-terra', `review-request-${attempts}`)
        },
      },
      sleep: async () => {},
    })

    const result = await runner.review(request)

    expect(attempts).toBe(5)
    expect(result).toMatchObject({
      review: null,
      step: {
        status: 'FAILED',
        errorCode: 'PROVIDER_UNAVAILABLE',
        output: {
          diagnostic: {
            providerAttempt: 5,
            maxProviderAttempts: 5,
            contractAttempt: 1,
            maxContractAttempts: 2,
            model: 'gpt-5.6-terra',
            requestId: 'review-request-5',
          },
        },
      },
    })
    const failed = (await repository.listEvents('run-1')).find((event) => event.type === 'tool.failed')
    expect(failed?.payload).toMatchObject({ errorCode: 'PROVIDER_UNAVAILABLE', retryable: false })
  })

  test('converges concurrent runner failures to one persisted terminal step event', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())
    let calls = 0
    let release!: () => void
    let bothStarted!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { bothStarted = resolve })
    const port = {
      async review() {
        calls += 1
        if (calls === 2) bothStarted()
        await gate
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', false, 'gpt-5.6-terra', `concurrent-${calls}`)
      },
    }
    const firstRunner = new VisualReviewRunner({ repository, reviewer: port, clock: new FixedClock() })
    const secondRunner = new VisualReviewRunner({ repository, reviewer: port, clock: new FixedClock() })

    const first = firstRunner.review(request)
    const second = secondRunner.review(request)
    await entered
    release()
    await Promise.all([first, second])

    expect(calls).toBe(2)
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toEqual([
      'tool.started', 'tool.failed',
    ])
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'PAGE_REVIEW' })
  })

  test('does not let a late success overwrite a persisted concurrent failure', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())
    let releaseSuccess!: () => void
    let successStarted!: () => void
    const gate = new Promise<void>((resolve) => { releaseSuccess = resolve })
    const entered = new Promise<void>((resolve) => { successStarted = resolve })
    const lateSuccessRunner = new VisualReviewRunner({
      repository,
      clock: new FixedClock(),
      reviewer: {
        async review() {
          successStarted()
          await gate
          return { approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null }
        },
      },
    })
    const failingRunner = new VisualReviewRunner({
      repository,
      clock: new FixedClock(),
      reviewer: {
        async review() {
          throw new StructuredModelError('PROVIDER_UNAVAILABLE', false, 'gpt-5.6-terra', 'winning-failure')
        },
      },
    })

    const lateSuccess = lateSuccessRunner.review(request)
    await entered
    const failed = await failingRunner.review(request)
    releaseSuccess()
    const converged = await lateSuccess

    expect(failed).toMatchObject({ review: null, replayed: false, step: { status: 'FAILED' } })
    expect(converged).toMatchObject({ review: null, replayed: true, step: { status: 'FAILED' } })
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toEqual([
      'tool.started', 'tool.failed',
    ])
  })
})

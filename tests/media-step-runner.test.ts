import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockBudgetPort, MockImageGenerationPort } from '../src/adapters/mock-ports'
import { MediaStepRunner } from '../src/core/media-step-runner'
import type { RunRecord } from '../src/core/ports'
import { hashInput } from '../src/core/hash'
import { reserveBudget } from '../src/core/policy'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于媒体步骤测试的完整教材内容。' },
    slideCount: 2,
    visualDirection: '课堂信息图',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'EXECUTING',
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
    ...overrides,
  }
}

const request = {
  runId: 'run-1',
  stepId: 'step-slide-1',
  idempotencyKey: 'run-1:slide-1:image-v1',
  slideId: 'slide-1',
  versionId: 'slide-1:v1',
  prompt: 'Classroom science illustration, no text',
  model: 'image-2',
  budgetUnits: 10,
} as const

async function fixture(overrides: Partial<RunRecord> = {}) {
  const repository = new InMemoryAgentRepository()
  const budget = new MockBudgetPort()
  const images = new MockImageGenerationPort()
  const clock = new FixedClock()
  await repository.createRun(run(overrides))
  return { repository, budget, images, runner: new MediaStepRunner({ repository, budget, images, clock }) }
}

describe('media step runner', () => {
  test('persists budget and a stable step before one provider submission', async () => {
    const { repository, budget, images, runner } = await fixture()
    const result = await runner.submitSlideImage(request)

    expect(result).toMatchObject({ replayed: false, step: { status: 'WAITING', budgetUnits: 10 } })
    expect(images.operations.size).toBe(1)
    expect(budget.reservations.size).toBe(1)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 10 })
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toEqual([
      'tool.started',
      'budget.updated',
      'tool.progress',
    ])
  })

  test('replays a completed submission without duplicate budget or media work', async () => {
    const { budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    const replay = await runner.submitSlideImage(request)

    expect(replay.replayed).toBe(true)
    expect(images.operations.size).toBe(1)
    expect(budget.reservations.size).toBe(1)
  })

  test('rejects the same idempotency key with different media input', async () => {
    const { runner } = await fixture()
    await runner.submitSlideImage(request)

    await expect(runner.submitSlideImage({ ...request, prompt: 'A different visual request, no text' }))
      .rejects.toThrow('STEP_IDEMPOTENCY_CONFLICT')
  })

  test('releases both budgets when the provider proves no submission occurred', async () => {
    const { repository, budget, images, runner } = await fixture()
    images.failNext('NO_HEALTHY_ROUTE_BEFORE_SUBMIT', 'NOT_SUBMITTED')
    const result = await runner.submitSlideImage(request)

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'NO_HEALTHY_ROUTE_BEFORE_SUBMIT' })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0, status: 'EXECUTING' })
    expect(budget.released.size).toBe(1)
  })

  test('keeps budget and requires a human when submission state is unknown', async () => {
    const { repository, budget, images, runner } = await fixture({ presentationMode: 'VISUAL_DECK_V4' })
    images.failNext('IDEMPOTENCY_SUBMISSION_UNKNOWN', 'UNKNOWN')
    const result = await runner.submitSlideImage(request)

    expect(result.step).toMatchObject({ status: 'SUBMISSION_UNKNOWN', errorCode: 'IDEMPOTENCY_SUBMISSION_UNKNOWN' })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 10, status: 'NEEDS_HUMAN' })
    expect(budget.released.size).toBe(0)
    const events = await repository.listEvents('run-1')
    expect(events.map((event) => event.type)).toContain('issue.detected')
    expect(events.find((event) => event.type === 'phase.changed')?.payload)
      .toMatchObject({ from: 'EXECUTING', to: 'NEEDS_HUMAN' })
    expect(events.map((event) => event.type)).toContain('approval.required')
  })

  test('releases Agent budget without calling Provider when the host account is frozen', async () => {
    const { repository, budget, images, runner } = await fixture()
    budget.failNext('CREDIT_ACCOUNT_FROZEN', 'NOT_RESERVED')
    const result = await runner.submitSlideImage(request)

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'CREDIT_ACCOUNT_FROZEN' })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0, status: 'EXECUTING' })
    expect(images.operations.size).toBe(0)
  })

  test('keeps Agent budget and stops before media when host reservation is unknown', async () => {
    const { repository, budget, images, runner } = await fixture()
    budget.failNext('HOST_BUDGET_UNKNOWN', 'UNKNOWN')
    const result = await runner.submitSlideImage(request)

    expect(result.step).toMatchObject({ status: 'RESERVATION_UNKNOWN', errorCode: 'HOST_BUDGET_UNKNOWN' })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 10, status: 'NEEDS_HUMAN' })
    expect(images.operations.size).toBe(0)
  })

  test('resumes an interrupted budget release without submitting media', async () => {
    const { repository, budget, images, runner } = await fixture()
    const reservation = await budget.reserve({
      host: run().host,
      model: request.model,
      units: request.budgetUnits,
      idempotencyKey: request.idempotencyKey,
    })
    await repository.transact('run-1', (transaction) => {
      const reserved = reserveBudget(transaction.run, request.budgetUnits)
      transaction.putRun({ ...transaction.run, ...reserved })
      transaction.putStep({
        id: request.stepId,
        runId: request.runId,
        idempotencyKey: request.idempotencyKey,
        inputHash: hashInput({
          tool: 'generate_slide_image',
          slideId: request.slideId,
          versionId: request.versionId,
          prompt: request.prompt,
          model: request.model,
          aspectRatio: '16:9',
          budgetUnits: request.budgetUnits,
        }),
        tool: 'generate_slide_image',
        status: 'RELEASING',
        budgetUnits: request.budgetUnits,
        budgetReservationId: reservation.reservationId,
        externalOperationId: null,
        errorCode: 'NO_HEALTHY_ROUTE_BEFORE_SUBMIT',
        output: { slideId: request.slideId, versionId: request.versionId },
        createdAt: run().createdAt,
        updatedAt: run().updatedAt,
      })
    })

    const result = await runner.submitSlideImage(request)
    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'NO_HEALTHY_ROUTE_BEFORE_SUBMIT' })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0 })
    expect(images.operations.size).toBe(0)
    expect(budget.released).toContain(reservation.reservationId)
  })

  test('marks a submitted image complete only after a controlled artifact is available', async () => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    expect((await runner.refreshSlideImage('run-1', request.idempotencyKey)).changed).toBe(false)
    images.complete(request.idempotencyKey, 'artifact-slide-1-v1')
    const completed = await runner.refreshSlideImage('run-1', request.idempotencyKey)
    const replay = await runner.refreshSlideImage('run-1', request.idempotencyKey)

    expect(completed).toMatchObject({ changed: true, step: { status: 'COMPLETED' } })
    expect(completed.step.output).toEqual({
      slideId: request.slideId,
      versionId: request.versionId,
      artifactId: 'artifact-slide-1-v1',
    })
    expect(replay).toMatchObject({ changed: false, step: { status: 'COMPLETED' } })
    expect(budget.settled.size).toBe(1)
    expect((await repository.listEvents('run-1')).map((event) => event.type).at(-1)).toBe('tool.completed')
  })

  test('retries an unknown host settlement before marking provider success complete', async () => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    images.complete(request.idempotencyKey, 'artifact-slide-1-v1')
    budget.failNextSettlement()

    await expect(runner.refreshSlideImage('run-1', request.idempotencyKey))
      .rejects.toThrow('HOST_SETTLEMENT_UNKNOWN')
    expect((await repository.listSteps('run-1'))[0]).toMatchObject({ status: 'WAITING' })
    expect(budget.settled.size).toBe(0)

    const completed = await runner.refreshSlideImage('run-1', request.idempotencyKey)
    expect(completed.step.status).toBe('COMPLETED')
    expect(budget.settled.size).toBe(1)
  })

  test('releases budget when an inspected task failed without charge', async () => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    images.fail(request.idempotencyKey, 'PROVIDER_REJECTED', 'NOT_CHARGED')
    const result = await runner.refreshSlideImage('run-1', request.idempotencyKey)

    expect(result).toMatchObject({ changed: true, step: { status: 'FAILED', errorCode: 'PROVIDER_REJECTED' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'EXECUTING', committedBudgetUnits: 0 })
    expect(budget.released.size).toBe(1)
  })

  test('retries an unknown host release without losing the reservation', async () => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    images.fail(request.idempotencyKey, 'PROVIDER_REJECTED', 'NOT_CHARGED')
    budget.failNextRelease()

    await expect(runner.refreshSlideImage('run-1', request.idempotencyKey))
      .rejects.toThrow('HOST_RELEASE_UNKNOWN')
    expect((await repository.listSteps('run-1'))[0]).toMatchObject({
      status: 'RELEASING',
      budgetReservationId: expect.any(String),
    })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 10 })

    expect(await runner.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 1 })
    expect((await repository.listSteps('run-1'))[0]).toMatchObject({ status: 'FAILED' })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0 })
    expect(budget.released.size).toBe(1)
  })

  test('keeps charged failed work in budget and requires human review', async () => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    images.fail(request.idempotencyKey, 'PROVIDER_OUTPUT_INVALID', 'CHARGED')
    const result = await runner.refreshSlideImage('run-1', request.idempotencyKey)

    expect(result).toMatchObject({ changed: true, step: { status: 'FAILED_CHARGED', errorCode: 'PROVIDER_OUTPUT_INVALID' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', committedBudgetUnits: 10 })
    expect(budget.settled.size).toBe(1)
    expect(budget.released.size).toBe(0)
  })

  test('reconciles a provider result that completes after run cancellation', async () => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED', version: transaction.run.version + 1 })
    })
    images.complete(request.idempotencyKey, 'artifact-after-cancel')

    expect(await runner.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 1 })
    expect((await repository.listSteps('run-1'))[0]).toMatchObject({
      status: 'COMPLETED_AFTER_CANCEL',
      output: { artifactId: 'artifact-after-cancel' },
    })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'CANCELLED', committedBudgetUnits: 10 })
    expect(budget.settled.size).toBe(1)
  })

  test('releases uncharged work that fails after cancellation', async () => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED', version: transaction.run.version + 1 })
    })
    images.fail(request.idempotencyKey, 'PROVIDER_REJECTED', 'NOT_CHARGED')

    await runner.reconcilePendingRun('run-1')
    expect((await repository.listSteps('run-1'))[0]).toMatchObject({ status: 'FAILED_NOT_CHARGED' })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'CANCELLED', committedBudgetUnits: 0 })
    expect(budget.released.size).toBe(1)
  })

  test.each([
    ['CHARGED', 'FAILED_CHARGED'],
    ['UNKNOWN', 'BILLING_UNKNOWN'],
  ] as const)('keeps %s failed work visible after cancellation', async (billingState, expectedStatus) => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED', version: transaction.run.version + 1 })
    })
    images.fail(request.idempotencyKey, 'PROVIDER_FAILED_AFTER_CANCEL', billingState)

    await runner.reconcilePendingRun('run-1')
    expect((await repository.listSteps('run-1'))[0]).toMatchObject({ status: expectedStatus })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'CANCELLED', committedBudgetUnits: 10 })
    expect(budget.settled.size).toBe(billingState === 'CHARGED' ? 1 : 0)
    expect(budget.released.size).toBe(0)
  })
})

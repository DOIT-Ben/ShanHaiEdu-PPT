import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockBudgetPort, MockImageGenerationPort } from '../src/adapters/mock-ports'
import { AdminOperationsService } from '../src/core/admin-operations'
import { generationBatchStepKeyFor } from '../src/core/generation-batch'
import { MediaStepRunner } from '../src/core/media-step-runner'
import type { RunRecord, StepRecord } from '../src/core/ports'
import { storedGenerationBatchSchema } from '../src/generation-batch-contracts'

function run(): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-run-1', requestHash: 'hash',
    host: { tenantId: 'frameflow', externalUserId: 'teacher-1' },
    source: { kind: 'TEXT', text: '管理员对账测试教材内容'.repeat(3) }, slideCount: 2,
    visualDirection: '课堂视觉', imageModel: 'image-2', automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2, revisionRound: 0, qualityScore: null, status: 'NEEDS_HUMAN',
    resumeState: null, version: 1, budgetUnits: 10, committedBudgetUnits: 4,
    qualityOverride: false, qualityOverrideReason: null, qualityOverrideBy: null,
    leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function target(status: StepRecord['status']): StepRecord {
  return {
    id: 'step-image-1', runId: 'run-1', idempotencyKey: 'run-1:image-1', inputHash: 'image-hash',
    tool: 'generate_slide_image', status, budgetUnits: 4, budgetReservationId: 'reservation-1',
    externalOperationId: 'operation-1', errorCode: 'PROVIDER_STATE_UNKNOWN',
    output: { slideId: 'slide-1', versionId: 'slide-1:v1' },
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

async function fixture(status: StepRecord['status'], overrides: Partial<StepRecord> = {}) {
  const repository = new InMemoryAgentRepository()
  const budget = new MockBudgetPort()
  const images = new MockImageGenerationPort()
  const clock = new FixedClock()
  await repository.createRun(run())
  await repository.transact('run-1', (transaction) => transaction.putStep({ ...target(status), ...overrides }))
  const media = new MediaStepRunner({ repository, budget, images, clock })
  const service = new AdminOperationsService({ repository, budget, media, clock })
  const base = {
    host: { tenantId: 'frameflow', externalUserId: 'admin-1', role: 'ADMIN' as const },
    runId: 'run-1', stepId: 'step-image-1', expectedVersion: 1,
    idempotencyKey: 'admin-action-1', reason: '已核对供应商后台工单 20260721。',
  }
  return { repository, budget, images, service, base }
}

async function attachRevisionBatch(
  repository: InMemoryAgentRepository,
  status: StepRecord['status'],
  childReservationId: string | null,
) {
  const page = (await repository.listSteps('run-1')).find((step) => step.id === 'step-image-1')!
  const pageKey = page.idempotencyKey
  const batchKey = generationBatchStepKeyFor('run-1', { revisionRound: 1, scope: 'REVISION' })
  const batchId = `genbatch_${'b'.repeat(32)}`
  const reservationId = 'batch-reservation-1'
  await repository.transact('run-1', (transaction) => {
    const currentPage = transaction.getStep(pageKey)!
    transaction.putRun({
      ...transaction.run,
      presentationMode: 'VISUAL_DECK_V4',
      imageModel: 'nano-banana-pro',
      revisionRound: 1,
    })
    transaction.putStep({
      ...currentPage,
      status,
      budgetReservationId: childReservationId,
      output: {
        slideId: 'run-1:slide:1',
        versionId: 'run-1:slide:1:r1:v1',
        model: 'image-2',
        operationMode: 'IMAGE_EDIT',
        repairContractHash: 'c'.repeat(64),
        batchId,
      },
    })
    transaction.putStep({
      id: 'step-run-1-revision-generation-batch-r1',
      runId: 'run-1',
      idempotencyKey: batchKey,
      inputHash: 'batch-input-hash',
      tool: 'generate_image_batch',
      status: 'RUNNING',
      budgetUnits: 4,
      budgetReservationId: reservationId,
      externalOperationId: null,
      errorCode: null,
      output: storedGenerationBatchSchema.parse({
        batchId,
        proposalHash: 'd'.repeat(64),
        revisionRound: 1,
        submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS',
        accountingModel: 'image-2',
        operationMode: 'IMAGE_EDIT',
        pageCount: 1,
        pages: [{ pageNumber: 1, idempotencyKey: pageKey, promptHash: 'e'.repeat(64) }],
        accounting: {
          estimatedUnits: 4,
          committedUnits: 4,
          settledUnits: 0,
          releasedUnits: 0,
          reconciliationUnits: 4,
          authorization: 'RESERVED',
          settlement: 'PENDING',
        },
        progress: { submitted: 1, completed: 0, failed: 0 },
        status: 'RECONCILIATION_REQUIRED',
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
      }),
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    })
  })
  return { pageKey, batchId, batchKey, reservationId }
}

describe('admin operations service', () => {
  test('marks an unknown submission not charged exactly once and releases both budgets', async () => {
    const { repository, budget, service, base } = await fixture('SUBMISSION_UNKNOWN')
    const first = await service.act({ ...base, action: 'MARK_NOT_CHARGED' })
    const replay = await service.act({ ...base, action: 'MARK_NOT_CHARGED' })

    expect(first).toMatchObject({ replayed: false, step: { status: 'FAILED_NOT_CHARGED' } })
    expect(replay).toMatchObject({ replayed: true, step: { status: 'FAILED_NOT_CHARGED' } })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0, version: 2 })
    expect(budget.released).toEqual(new Set(['reservation-1']))
    expect((await repository.listEvents('run-1')).filter((event) => event.type === 'approval.resolved')).toHaveLength(1)
    expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'admin_reconciliation')).toHaveLength(1)
  })

  test('marks unknown billing charged without releasing reserved budget', async () => {
    const { repository, budget, service, base } = await fixture('BILLING_UNKNOWN')
    const result = await service.act({ ...base, action: 'MARK_CHARGED' })

    expect(result.step.status).toBe('FAILED_CHARGED')
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 4, version: 2 })
    expect(budget.settled).toEqual(new Set(['reservation-1']))
    expect(budget.released.size).toBe(0)
  })

  test('rejects charging a reservation that never reached the Provider', async () => {
    const { service, base } = await fixture('RESERVATION_UNKNOWN', { budgetReservationId: null })

    await expect(service.act({ ...base, action: 'MARK_CHARGED' }))
      .rejects.toMatchObject({ code: 'STEP_NOT_RECONCILABLE' })
  })

  test('releases only Agent budget when the host proves no reservation exists', async () => {
    const { repository, budget, service, base } = await fixture('RESERVATION_UNKNOWN', { budgetReservationId: null })
    budget.failNext('INSUFFICIENT_CREDITS', 'NOT_RESERVED')

    const result = await service.act({ ...base, action: 'MARK_NOT_CHARGED' })

    expect(result.step).toMatchObject({ status: 'FAILED_NOT_CHARGED', budgetReservationId: null })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0 })
    expect(budget.released.size).toBe(0)
  })

  test('finishes a legacy unknown reservation after a frozen host account is classified as not reserved', async () => {
    const { repository, budget, service, base } = await fixture('RESERVATION_UNKNOWN', { budgetReservationId: null })
    budget.failNext('CREDIT_ACCOUNT_FROZEN', 'NOT_RESERVED')

    const result = await service.act({ ...base, action: 'MARK_NOT_CHARGED' })

    expect(result.step).toMatchObject({
      status: 'FAILED_NOT_CHARGED', budgetReservationId: null, errorCode: 'PROVIDER_STATE_UNKNOWN',
    })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0 })
    expect(budget.released.size).toBe(0)
  })

  test('recovers and releases a host reservation whose response was lost', async () => {
    const { repository, budget, service, base } = await fixture('RESERVATION_UNKNOWN', { budgetReservationId: null })
    const recovered = await budget.reserve({
      host: run().host,
      model: run().imageModel,
      units: 4,
      idempotencyKey: 'run-1:image-1',
    })

    const result = await service.act({ ...base, action: 'MARK_NOT_CHARGED' })

    expect(result.step).toMatchObject({ status: 'FAILED_NOT_CHARGED', budgetReservationId: recovered.reservationId })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0 })
    expect(budget.released).toEqual(new Set([recovered.reservationId]))
  })

  test('uses the persisted GPT edit model for administrator accounting after configuration drift', async () => {
    const { repository, budget, service, base } = await fixture('RESERVATION_UNKNOWN', {
      idempotencyKey: `run-1:slide:1:image:r1:v1:edit:${'a'.repeat(24)}`,
      budgetReservationId: null,
      output: {
        slideId: 'run-1:slide:1', versionId: 'run-1:slide:1:r1:v1',
        model: 'image-2', operationMode: 'IMAGE_EDIT', repairContractHash: 'b'.repeat(64),
      },
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, imageModel: 'nano-banana-pro' })
    })

    await service.act({ ...base, action: 'MARK_NOT_CHARGED' })

    expect(budget.reservationRequests.at(-1)).toMatchObject({ model: 'image-2' })
  })

  test('classifies an uncharged batch page without creating or releasing a page reservation', async () => {
    const { repository, budget, service, base } = await fixture('SUBMISSION_UNKNOWN', {
      idempotencyKey: `run-1:slide:1:image:r1:v1:edit:${'a'.repeat(24)}`,
      budgetReservationId: null,
    })
    const batch = await attachRevisionBatch(repository, 'SUBMISSION_UNKNOWN', null)

    const result = await service.act({ ...base, action: 'MARK_NOT_CHARGED' })

    expect(result.step).toMatchObject({
      status: 'FAILED_NOT_CHARGED',
      budgetReservationId: batch.reservationId,
    })
    expect(budget.reservationRequests).toHaveLength(0)
    expect(budget.batchFinalizations).toEqual([expect.objectContaining({
      reservationId: batch.reservationId,
      batchId: batch.batchId,
      settledUnits: 0,
      releasedUnits: 4,
    })])
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0 })
  })

  test('classifies a charged batch page only through atomic batch finalization', async () => {
    const { repository, budget, service, base } = await fixture('BILLING_UNKNOWN', {
      idempotencyKey: `run-1:slide:1:image:r1:v1:edit:${'a'.repeat(24)}`,
    })
    const batch = await attachRevisionBatch(repository, 'BILLING_UNKNOWN', 'batch-reservation-1')

    const result = await service.act({ ...base, action: 'MARK_CHARGED' })

    expect(result.step).toMatchObject({ status: 'FAILED_CHARGED', budgetReservationId: batch.reservationId })
    expect(budget.reservationRequests).toHaveLength(0)
    expect(budget.batchFinalizations).toEqual([expect.objectContaining({
      reservationId: batch.reservationId,
      batchId: batch.batchId,
      settledUnits: 4,
      releasedUnits: 0,
    })])
  })

  test.each([
    ['missing batch', 'BATCH_ACCOUNTING_CONTEXT_INVALID', async (repository: InMemoryAgentRepository) => {
      const step = (await repository.listSteps('run-1')).find((candidate) => candidate.id === 'step-image-1')!
      await repository.transact('run-1', (transaction) => transaction.putStep({
        ...step,
        output: { ...step.output as object, batchId: `genbatch_${'f'.repeat(32)}` },
      }))
    }],
    ['page membership mismatch', 'BATCH_PAGE_MEMBERSHIP_INVALID', async (repository: InMemoryAgentRepository) => {
      const batchKey = generationBatchStepKeyFor('run-1', { revisionRound: 1, scope: 'REVISION' })
      await repository.transact('run-1', (transaction) => {
        const batchStep = transaction.getStep(batchKey)!
        const batch = storedGenerationBatchSchema.parse(batchStep.output)
        transaction.putStep({
          ...batchStep,
          output: storedGenerationBatchSchema.parse({
            ...batch,
            pages: [{ ...batch.pages[0]!, idempotencyKey: 'run-1:another-page' }],
          }),
        })
      })
    }],
    ['missing batch reservation', 'BATCH_RESERVATION_UNRESOLVED', async (repository: InMemoryAgentRepository) => {
      const batchKey = generationBatchStepKeyFor('run-1', { revisionRound: 1, scope: 'REVISION' })
      await repository.transact('run-1', (transaction) => {
        const batchStep = transaction.getStep(batchKey)!
        transaction.putStep({ ...batchStep, budgetReservationId: null })
      })
    }],
    ['reservation mismatch', 'BATCH_RESERVATION_ID_CONFLICT', async (repository: InMemoryAgentRepository) => {
      const page = (await repository.listSteps('run-1')).find((candidate) => candidate.id === 'step-image-1')!
      await repository.transact('run-1', (transaction) => transaction.putStep({
        ...page,
        budgetReservationId: 'different-reservation',
      }))
    }],
  ] as const)('fails closed for a %s without calling any budget operation', async (_label, code, mutate) => {
    const { repository, budget, service, base } = await fixture('SUBMISSION_UNKNOWN', {
      idempotencyKey: `run-1:slide:1:image:r1:v1:edit:${'a'.repeat(24)}`,
      budgetReservationId: null,
    })
    if (code !== 'BATCH_ACCOUNTING_CONTEXT_INVALID') {
      await attachRevisionBatch(repository, 'SUBMISSION_UNKNOWN', null)
    }
    await mutate(repository)

    await expect(service.act({ ...base, action: 'MARK_NOT_CHARGED' })).rejects.toMatchObject({ status: 409, code })
    expect(budget.reservationRequests).toHaveLength(0)
    expect(budget.batchFinalizations).toHaveLength(0)
    expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'admin_reconciliation')).toHaveLength(0)
  })

  test('reinspects a late Provider result and records an audited completion', async () => {
    const { repository, budget, images, service, base } = await fixture('WAITING')
    images.statuses.set('operation-1', { state: 'COMPLETED', artifactId: 'artifact-1' })
    const result = await service.act({ ...base, action: 'REINSPECT' })

    expect(result.step).toMatchObject({ status: 'COMPLETED', output: { artifactId: 'artifact-1' } })
    expect(budget.settled).toEqual(new Set(['reservation-1']))
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.resolved')).toBe(true)
  })

  test('restores a complete V4 image batch after a billing-unknown reinspection without resubmission', async () => {
    const { repository, budget, images, service, base } = await fixture('BILLING_UNKNOWN', {
      id: 'step-v4-image-1',
      idempotencyKey: 'run-1:slide:1:image:r0:v1',
      externalOperationId: 'operation-v4-1',
      output: { slideId: 'run-1:slide:1', versionId: 'run-1:slide:1:r0:v1' },
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4',
        committedBudgetUnits: 8,
      })
      transaction.putStep({
        ...target('COMPLETED'),
        id: 'step-v4-image-2',
        idempotencyKey: 'run-1:slide:2:image:r0:v1',
        budgetReservationId: 'reservation-v4-2',
        externalOperationId: 'operation-v4-2',
        errorCode: null,
        output: {
          slideId: 'run-1:slide:2', versionId: 'run-1:slide:2:r0:v1', artifactId: 'artifact-v4-2',
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'step-v4-image-1:provider-result', category: 'PROVIDER_RESULT_FAILED', severity: 'CRITICAL',
          summary: '图片结果查询遇到暂时性限流。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
        },
      })
    })
    images.statuses.set('operation-v4-1', { state: 'COMPLETED', artifactId: 'artifact-v4-1' })

    const result = await service.act({ ...base, action: 'REINSPECT', stepId: 'step-v4-image-1' })

    expect(result).toMatchObject({ run: { status: 'EXECUTING', version: 2 }, step: { status: 'COMPLETED' } })
    expect(images.operations.size).toBe(0)
    expect(budget.settled).toEqual(new Set(['reservation-1']))
    const events = await repository.listEvents('run-1')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'issue.resolved', payload: expect.objectContaining({ issueId: 'step-v4-image-1:provider-result' }) }),
      expect.objectContaining({ type: 'phase.changed', payload: expect.objectContaining({ from: 'NEEDS_HUMAN', to: 'EXECUTING', reason: 'PROVIDER_REINSPECTION_RECOVERED' }) }),
      expect.objectContaining({ type: 'run.resumed', payload: expect.objectContaining({ status: 'EXECUTING' }) }),
      expect.objectContaining({ type: 'generation.progress', payload: expect.objectContaining({ completed: 2, total: 2, pageNumbers: [1, 2] }) }),
    ]))
  })

  test('records a reinspection without resolving approval while a historical provider task is still processing', async () => {
    const { repository, images, service, base } = await fixture('BILLING_UNKNOWN')
    images.statuses.set('operation-1', { state: 'PROCESSING', retryAfterMs: 2_000 })

    const result = await service.act({ ...base, action: 'REINSPECT' })

    expect(result).toMatchObject({ replayed: false, step: { status: 'BILLING_UNKNOWN' } })
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'admin_reconciliation'))
      .toMatchObject({ status: 'COMPLETED', output: expect.objectContaining({ resultStatus: 'BILLING_UNKNOWN' }) })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.resolved')).toBe(false)
  })

  test('allows only one concurrent accounting decision for a Run', async () => {
    const { service, base } = await fixture('BILLING_UNKNOWN')
    const results = await Promise.allSettled([
      service.act({ ...base, idempotencyKey: 'admin-charged', action: 'MARK_CHARGED' }),
      service.act({ ...base, idempotencyKey: 'admin-not-charged', action: 'MARK_NOT_CHARGED' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected').map((result) =>
      result.status === 'rejected' ? result.reason.code : null)).toEqual(['ADMIN_ACTION_IN_PROGRESS'])
  })
})

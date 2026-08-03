import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { parseProviderBillingCatalog } from '../src/adapters/provider-billing-catalog'
import {
  enqueueUsageV2RunFinalization,
  usageV2FinalizeStepKey,
  UsageV2Coordinator,
} from '../src/core/usage-v2-coordinator'
import { reconcileVisualDeckV4TerminalState } from '../src/core/v4-lifecycle'
import type { RunRecord, StepRecord, UsageAccountingPort } from '../src/core/ports'
import { UsageAccountingRequestError, type UsageOperationEventV2, type UsageRunBill } from '../src/usage-accounting-contracts'

const host = { tenantId: 'frameflow', externalUserId: 'teacher-1' }

function run(): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-1', requestHash: 'request-1', host,
    source: { kind: 'TEXT', text: '这是用于 Usage V2 协调器测试的完整教材内容。' },
    slideCount: 10, visualDirection: '课堂信息图', imageModel: 'nanobanana',
    accountingProtocol: 'FRAMEFLOW_USAGE_V2', automationLevel: 'BOUNDED_AUTO', presentationMode: 'VISUAL_DECK_V4',
    maxRevisionRounds: 2, revisionRound: 0, qualityScore: null, status: 'EXECUTING', resumeState: null,
    version: 0, budgetUnits: 30, committedBudgetUnits: 10, qualityOverride: false,
    qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-08-03T07:00:00.000Z', updatedAt: '2026-08-03T07:00:00.000Z',
  }
}

function mediaStep(pageNumber: number): StepRecord {
  const key = `run-1:slide:${pageNumber}:image:r0:v1`
  return {
    id: `step-${pageNumber}`, runId: 'run-1', idempotencyKey: key, inputHash: `hash-${pageNumber}`,
    tool: 'generate_slide_image', status: 'RESERVED', budgetUnits: 1,
    budgetReservationId: 'usage-v2:genbatch_0123456789abcdef0123456789abcdef', externalOperationId: null,
    errorCode: null,
    output: {
      slideId: `run-1:slide:${pageNumber}`, versionId: `run-1:slide:${pageNumber}:r0:v1`,
      model: 'nanobanana', operationMode: 'TEXT_TO_IMAGE', backgroundMode: 'OPAQUE',
      batchId: 'genbatch_0123456789abcdef0123456789abcdef', pageNumber, revisionRound: 0,
    },
    createdAt: '2026-08-03T07:00:00.000Z', updatedAt: '2026-08-03T07:00:00.000Z',
  }
}

function bill(overrides: Partial<UsageRunBill> = {}): UsageRunBill {
  return {
    pptRunId: 'run-1', authorizationReservationId: 'authorization-1', accountingMode: 'USAGE_V2', status: 'ACTIVE',
    authorizationCapMilli: 300_000, authorizedModel: 'nanobanana', authorizedUnits: 30,
    pricingVersion: 'ppt-image-v1', unitPriceMilli: 10_000, providerSpendSafetyCapOperations: 30,
    generatedOperations: 0, chargedOperations: 0, notChargedOperations: 0, unknownOperations: 0,
    chargeableMilli: 0, settledMilli: 0, releasedMilli: 0, providerCosts: [], lastEventSequence: 0,
    lastEventAt: null, settledAt: null, firstUnknownAt: null, reconciliationAttempts: 0,
    nextReconcileAt: null, reconciliationDeadlineAt: null, reconciliationLastError: null,
    ...overrides,
  }
}

class RecordingUsagePort implements UsageAccountingPort {
  readonly permits: Parameters<UsageAccountingPort['authorizeOperation']>[0][] = []
  readonly eventAttempts: UsageOperationEventV2[] = []
  readonly acceptedEvents: UsageOperationEventV2[] = []
  failFirstEventUnknown = false
  rejectEvents = false
  readonly finalizeAttempts: Parameters<UsageAccountingPort['finalizeRun']>[0][] = []
  finalizeOutcomes: (UsageRunBill['status'] | 'UNKNOWN')[] = []

  async authorizeOperation(input: Parameters<UsageAccountingPort['authorizeOperation']>[0]) {
    this.permits.push(structuredClone(input))
    return { allowed: true as const, permitId: `permit-${input.pageNumber}`, pricingVersion: 'ppt-image-v1', userPriceMilli: 10_000 }
  }

  async ingestEvent(input: Parameters<UsageAccountingPort['ingestEvent']>[0]) {
    this.eventAttempts.push(structuredClone(input.event))
    if (this.rejectEvents) {
      throw new UsageAccountingRequestError('PPT_USAGE_IDEMPOTENCY_CONFLICT', 'REJECTED')
    }
    if (this.failFirstEventUnknown) {
      this.failFirstEventUnknown = false
      throw new UsageAccountingRequestError('HOST_USAGE_V2_EVENT_UNKNOWN', 'UNKNOWN')
    }
    if (!this.acceptedEvents.some((event) => event.eventId === input.event.eventId)) {
      this.acceptedEvents.push(structuredClone(input.event))
    }
    return { replayed: false, bill: bill({ lastEventSequence: input.event.sequence }) }
  }

  async getRunBill() { return bill() }
  async finalizeRun(input: Parameters<UsageAccountingPort['finalizeRun']>[0]) {
    this.finalizeAttempts.push(structuredClone(input))
    const outcome = this.finalizeOutcomes.shift() ?? 'SETTLED'
    if (outcome === 'UNKNOWN') throw new UsageAccountingRequestError('HOST_USAGE_V2_FINALIZE_UNKNOWN', 'UNKNOWN')
    return bill({ status: outcome, settledMilli: 10_000, releasedMilli: 290_000 })
  }
}

function catalog(costAmountMicros: number) {
  return parseProviderBillingCatalog(JSON.stringify({ schemaVersion: '1', entries: [{
    model: 'nanobanana', operationMode: 'TEXT_TO_IMAGE', resolution: '1K',
    costBasis: 'FIXED_PER_OPERATION', costAmountMicros, currency: 'USD',
    providerPricingVersion: `nano-${costAmountMicros}`,
  }] }))
}

async function fixture(pages = 1, costAmountMicros = 25_000) {
  const repository = new InMemoryAgentRepository()
  await repository.createRun({ ...run(), slideCount: pages, committedBudgetUnits: pages })
  await repository.transact('run-1', (transaction) => {
    for (let page = 1; page <= pages; page += 1) transaction.putStep(mediaStep(page))
  })
  const usage = new RecordingUsagePort()
  const clock = new FixedClock()
  const coordinator = new UsageV2Coordinator({
    repository, usage, billingCatalog: catalog(costAmountMicros), clock,
  })
  return { repository, usage, coordinator, clock }
}

async function authorizeAndAttachOperation(
  coordinator: UsageV2Coordinator,
  repository: InMemoryAgentRepository,
  pageNumber: number,
  state: 'QUEUED' | 'PROCESSING' | 'COMPLETED' = 'QUEUED',
) {
  const key = `run-1:slide:${pageNumber}:image:r0:v1`
  await coordinator.authorizeMediaOperation({
    runId: 'run-1', mediaStepKey: key,
    batchId: 'genbatch_0123456789abcdef0123456789abcdef', pageNumber, revisionRound: 0,
    model: 'nanobanana', operationMode: 'TEXT_TO_IMAGE', resolution: '1K', aspectRatio: '16:9',
  })
  const operationId = `imgop_${String(pageNumber).padStart(32, '0')}`
  await repository.transact('run-1', (transaction) => {
    const step = transaction.getStep(key)!
    transaction.putStep({ ...step, status: 'WAITING', externalOperationId: operationId })
  })
  await coordinator.recordProviderSubmission({ runId: 'run-1', mediaStepKey: key, operationId, state })
  return { key, operationId }
}

describe('Usage V2 coordinator', () => {
  test('retries an unknown terminal finalization with the original durable key and completes once', async () => {
    const { repository, usage, coordinator, clock } = await fixture()
    usage.finalizeOutcomes = ['UNKNOWN', 'SETTLED']
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'COMPLETED', updatedAt: clock.now().toISOString() })
      enqueueUsageV2RunFinalization(transaction, clock)
    })

    expect(await coordinator.reconcileTerminalRun('run-1')).toBe(false)
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({ status: 'RUNNING', errorCode: 'HOST_USAGE_V2_FINALIZE_UNKNOWN' })

    clock.advance(1_000)
    expect(await coordinator.reconcileTerminalRun('run-1')).toBe(true)
    expect(usage.finalizeAttempts.map((attempt) => attempt.idempotencyKey))
      .toEqual(['finalize:run-1', 'finalize:run-1'])
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({
        idempotencyKey: usageV2FinalizeStepKey('run-1'), status: 'COMPLETED', errorCode: null,
        output: { deliveryState: 'ACKNOWLEDGED', bill: { status: 'SETTLED' } },
      })
  })

  test('keeps RECONCILING recoverable but stops REVIEW_REQUIRED without claiming settlement', async () => {
    const reconciling = await fixture()
    reconciling.usage.finalizeOutcomes = ['RECONCILING', 'SETTLED']
    await reconciling.repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
      enqueueUsageV2RunFinalization(transaction, reconciling.clock)
    })

    expect(await reconciling.coordinator.reconcileTerminalRun('run-1')).toBe(false)
    expect((await reconciling.repository.listSteps('run-1')).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({ status: 'RUNNING', output: { deliveryState: 'PENDING', bill: { status: 'RECONCILING' } } })
    reconciling.clock.advance(1_000)
    expect(await reconciling.coordinator.reconcileTerminalRun('run-1')).toBe(true)

    const review = await fixture()
    review.usage.finalizeOutcomes = ['REVIEW_REQUIRED']
    await review.repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'FAILED' })
      enqueueUsageV2RunFinalization(transaction, review.clock)
    })

    expect(await review.coordinator.reconcileTerminalRun('run-1')).toBe(false)
    expect((await review.repository.listSteps('run-1')).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({
        status: 'FAILED', errorCode: 'HOST_USAGE_V2_REVIEW_REQUIRED',
        output: { deliveryState: 'REVIEW_REQUIRED', bill: { status: 'REVIEW_REQUIRED' } },
      })
    expect(review.usage.finalizeAttempts).toHaveLength(1)
  })

  test('serializes ten concurrent observed and resolved events with immutable identities', async () => {
    const { repository, usage, coordinator } = await fixture(10)
    const operations = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      authorizeAndAttachOperation(coordinator, repository, index + 1)))

    await Promise.all(operations.map(({ key }) => coordinator.recordProviderResult({
      runId: 'run-1', mediaStepKey: key, status: 'COMPLETED', billingState: 'CHARGED',
    })))

    expect(usage.permits).toHaveLength(10)
    expect(usage.acceptedEvents).toHaveLength(20)
    expect(usage.acceptedEvents.map((event) => event.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    expect(new Set(usage.acceptedEvents.map((event) => event.eventId)).size).toBe(20)
    for (const { key, operationId } of operations) {
      const observed = usage.acceptedEvents.find((event) => event.providerOperationId === operationId && event.eventType === 'OPERATION_OBSERVED')!
      const resolved = usage.acceptedEvents.find((event) => event.providerOperationId === operationId && event.eventType === 'BILLING_RESOLVED')!
      expect(observed.idempotencyKey).toBe(key)
      expect(resolved.idempotencyKey).toBe(`${key}:billing-resolved`)
      expect(resolved.sequence).toBeGreaterThan(observed.sequence)
    }
  })

  test('replays an unknown event response with the exact payload and never reallocates sequence', async () => {
    const { repository, usage, coordinator, clock } = await fixture()
    usage.failFirstEventUnknown = true
    const { key } = await authorizeAndAttachOperation(coordinator, repository, 1)

    expect(usage.eventAttempts).toHaveLength(1)
    clock.advance(1_000)
    await coordinator.flushEvents('run-1')

    expect(usage.eventAttempts).toHaveLength(2)
    expect(usage.eventAttempts[1]).toEqual(usage.eventAttempts[0])
    expect(usage.acceptedEvents).toEqual([usage.eventAttempts[0]!])
    expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'report_usage_v2'))
      .toEqual([expect.objectContaining({ status: 'COMPLETED' })])
    expect(key).toBe(usage.eventAttempts[0]!.idempotencyKey)
  })

  test('records a synchronous completed submission as final observed usage without a resolved event', async () => {
    const { repository, usage, coordinator } = await fixture()
    await authorizeAndAttachOperation(coordinator, repository, 1, 'COMPLETED')

    expect(usage.acceptedEvents).toHaveLength(1)
    expect(usage.acceptedEvents[0]).toMatchObject({
      eventType: 'OPERATION_OBSERVED', status: 'COMPLETED',
      providerBilling: { result: 'CHARGED', actualCostAmountMicros: 25_000 },
    })
  })

  test('uses the pre-call cost snapshot after restart with a changed billing catalog', async () => {
    const { repository, usage, coordinator } = await fixture(1, 25_000)
    const key = 'run-1:slide:1:image:r0:v1'
    await coordinator.authorizeMediaOperation({
      runId: 'run-1', mediaStepKey: key,
      batchId: 'genbatch_0123456789abcdef0123456789abcdef', pageNumber: 1, revisionRound: 0,
      model: 'nanobanana', operationMode: 'TEXT_TO_IMAGE', resolution: '1K', aspectRatio: '16:9',
    })
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(key)!
      transaction.putStep({ ...step, status: 'WAITING', externalOperationId: 'imgop_00000000000000000000000000000001' })
    })
    const restarted = new UsageV2Coordinator({
      repository, usage, billingCatalog: catalog(99_000), clock: new FixedClock(),
    })

    await restarted.recordProviderSubmission({
      runId: 'run-1', mediaStepKey: key, operationId: 'imgop_00000000000000000000000000000001', state: 'COMPLETED',
    })

    expect(usage.acceptedEvents[0]).toMatchObject({
      providerBilling: {
        result: 'CHARGED', actualCostAmountMicros: 25_000, pricingVersion: 'nano-25000',
      },
    })
  })

  test('reuses the persisted resolved event after a crash instead of regenerating its timestamps', async () => {
    const { repository, usage, coordinator, clock } = await fixture()
    const { key } = await authorizeAndAttachOperation(coordinator, repository, 1)
    usage.failFirstEventUnknown = true

    await coordinator.recordProviderResult({
      runId: 'run-1', mediaStepKey: key, status: 'COMPLETED', billingState: 'CHARGED',
    })
    const firstResolvedAttempt = usage.eventAttempts.find((event) => event.eventType === 'BILLING_RESOLVED')!
    clock.advance(2_000)

    await expect(coordinator.recordProviderResult({
      runId: 'run-1', mediaStepKey: key, status: 'COMPLETED', billingState: 'CHARGED',
    })).resolves.toBe(true)

    const resolvedAttempts = usage.eventAttempts.filter((event) => event.eventType === 'BILLING_RESOLVED')
    expect(resolvedAttempts).toEqual([firstResolvedAttempt, firstResolvedAttempt])
    expect((await repository.listSteps('run-1')).filter((step) =>
      step.tool === 'report_usage_v2'
        && (step.output as { event?: { eventType?: string } } | null)?.event?.eventType === 'BILLING_RESOLVED'))
      .toHaveLength(1)
  })

  test('moves a hard-rejected V4 Usage event into technical failure recovery without user approval', async () => {
    const { repository, usage, coordinator, clock } = await fixture()
    usage.rejectEvents = true

    await authorizeAndAttachOperation(coordinator, repository, 1)

    const failed = (await repository.listSteps('run-1')).find((step) => step.tool === 'report_usage_v2')!
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'PPT_USAGE_IDEMPOTENCY_CONFLICT' })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING',
      resumeState: null,
      pendingTerminalFailure: {
        errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED',
        reason: 'INTERNAL_FAILURE',
      },
      terminalAccounting: { accountingStatus: 'RECONCILIATION_REQUIRED' },
      technicalRecovery: { reason: 'TERMINAL_ACCOUNTING_PENDING', active: true },
    })
    expect(failed).toMatchObject({ output: { blockedRunStatus: 'EXECUTING' } })
    const rejectedEvents = await repository.listEvents('run-1')
    expect(rejectedEvents.some((event) =>
      event.type === 'issue.detected' && event.payload.id === `${failed.id}:usage-v2-delivery`)).toBe(true)
    expect(rejectedEvents.some((event) => event.type === 'approval.required')).toBe(false)
    expect(rejectedEvents.some((event) => event.type === 'run.failed')).toBe(false)

    usage.rejectEvents = false
    await expect(coordinator.retryRejectedEvent('run-1', failed.idempotencyKey)).resolves.toBe(true)

    expect(usage.eventAttempts).toHaveLength(2)
    expect(usage.eventAttempts[1]).toEqual(usage.eventAttempts[0])
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING', pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
    })
    expect((await repository.listSteps('run-1')).find((step) => step.idempotencyKey === failed.idempotencyKey))
      .toMatchObject({ status: 'COMPLETED', errorCode: null })

    await repository.transact('run-1', (transaction) => {
      const image = transaction.getStep('run-1:slide:1:image:r0:v1')!
      transaction.putStep({ ...image, status: 'FAILED_NOT_CHARGED', errorCode: 'PROVIDER_REJECTED' })
      transaction.putRun({ ...transaction.run, committedBudgetUnits: 0 })
      expect(reconcileVisualDeckV4TerminalState(transaction, clock)).toBe(true)
    })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'FAILED', terminalAccounting: { accountingStatus: 'FINAL' },
    })
    expect((await repository.listEvents('run-1')).at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
    })
  })

  test('keeps a V4 Usage conflict in technical recovery when an admin retry is initially unknown', async () => {
    const { repository, usage, coordinator, clock } = await fixture()
    usage.rejectEvents = true
    await authorizeAndAttachOperation(coordinator, repository, 1)
    const failed = (await repository.listSteps('run-1')).find((step) => step.tool === 'report_usage_v2')!
    usage.rejectEvents = false
    usage.failFirstEventUnknown = true

    expect(await coordinator.retryRejectedEvent('run-1', failed.idempotencyKey)).toBe(false)
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING', pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
    })

    clock.advance(1_000)
    expect(await coordinator.flushEvents('run-1')).toBe(true)
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING', pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
    })
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'issue.resolved' && event.payload.issueId === `${failed.id}:usage-v2-delivery`)).toBe(true)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('keeps V2 page and revision identity strict outside the legacy Provider input hash', async () => {
    const { coordinator, usage } = await fixture()

    await expect(coordinator.authorizeMediaOperation({
      runId: 'run-1', mediaStepKey: 'run-1:slide:1:image:r0:v1',
      batchId: 'genbatch_0123456789abcdef0123456789abcdef', pageNumber: 2, revisionRound: 0,
      model: 'nanobanana', operationMode: 'TEXT_TO_IMAGE', resolution: '1K', aspectRatio: '16:9',
    })).rejects.toThrow('USAGE_V2_MEDIA_IDENTITY_CONFLICT')
    expect(usage.permits).toHaveLength(0)
  })

  test.each([
    ['CAP_EXCEEDED', 'COMPLETED', true],
    ['LEGACY_RECONCILIATION', 'FAILED', false],
    ['ACTIVE', 'RUNNING', false],
  ] as const)('maps final bill status %s without claiming a different terminal result', async (
    billStatus,
    expectedStepStatus,
    expectedComplete,
  ) => {
    const current = await fixture()
    current.usage.finalizeOutcomes = [billStatus]
    await current.repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
      enqueueUsageV2RunFinalization(transaction, current.clock)
    })

    expect(await current.coordinator.reconcileTerminalRun('run-1')).toBe(expectedComplete)
    expect((await current.repository.listSteps('run-1')).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({ status: expectedStepStatus, output: { bill: { status: billStatus } } })
  })
})

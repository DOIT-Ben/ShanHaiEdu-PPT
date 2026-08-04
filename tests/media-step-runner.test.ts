import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockBudgetPort, MockImageGenerationPort } from '../src/adapters/mock-ports'
import { MediaStepRunner } from '../src/core/media-step-runner'
import type { RunRecord } from '../src/core/ports'
import { hashInput } from '../src/core/hash'
import { applyRunAction, reserveBudget } from '../src/core/policy'
import { resumeTechnicalRecovery } from '../src/core/technical-recovery'
import { parseProviderBillingCatalog } from '../src/adapters/provider-billing-catalog'
import { UsageV2Coordinator } from '../src/core/usage-v2-coordinator'
import type { UsageAccountingPort } from '../src/core/ports'
import { UsageAccountingRequestError, type UsageRunBill } from '../src/usage-accounting-contracts'
import { createHash } from 'node:crypto'

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
  return { repository, budget, images, clock, runner: new MediaStepRunner({ repository, budget, images, clock }) }
}

function usageBill(): UsageRunBill {
  return {
    pptRunId: 'run-1', authorizationReservationId: 'authorization-1', accountingMode: 'USAGE_V2', status: 'ACTIVE',
    authorizationCapMilli: 300_000, authorizedModel: 'image-2', authorizedUnits: 30,
    pricingVersion: 'ppt-image-v1', unitPriceMilli: 10_000, providerSpendSafetyCapOperations: 30,
    generatedOperations: 1, chargedOperations: 0, notChargedOperations: 0, unknownOperations: 1,
    chargeableMilli: 0, settledMilli: 0, releasedMilli: 0, providerCosts: [], lastEventSequence: 1,
    lastEventAt: '2026-08-03T07:00:00.000Z', settledAt: null, firstUnknownAt: '2026-08-03T07:00:00.000Z',
    reconciliationAttempts: 0, nextReconcileAt: null, reconciliationDeadlineAt: null, reconciliationLastError: null,
  }
}

class MediaUsagePort implements UsageAccountingPort {
  readonly order: string[] = []
  readonly permitKeys: string[] = []
  readonly events: Parameters<UsageAccountingPort['ingestEvent']>[0]['event'][] = []
  permitResult: 'ALLOW' | 'DENY' | 'UNKNOWN' = 'ALLOW'
  permitStopReason: 'AUTHORIZATION_CAP_REACHED' | 'PROVIDER_SAFETY_CAP_REACHED' = 'AUTHORIZATION_CAP_REACHED'

  async authorizeOperation(input: Parameters<UsageAccountingPort['authorizeOperation']>[0]) {
    this.order.push('permit')
    this.permitKeys.push(input.operationIdempotencyKey)
    if (this.permitResult === 'UNKNOWN') {
      throw new UsageAccountingRequestError('HOST_USAGE_V2_PERMIT_UNKNOWN', 'UNKNOWN')
    }
    if (this.permitResult === 'DENY') {
      return {
        allowed: false as const, stopReason: this.permitStopReason,
        authorizedOperations: 30, authorizationCapOperations: 30, providerSpendSafetyCapOperations: 30,
      }
    }
    return { allowed: true as const, permitId: 'permit-1', pricingVersion: 'ppt-image-v1', userPriceMilli: 10_000 }
  }

  async ingestEvent(input: Parameters<UsageAccountingPort['ingestEvent']>[0]) {
    this.order.push('event')
    this.events.push(structuredClone(input.event))
    return { replayed: false, bill: usageBill() }
  }

  async getRunBill() { return usageBill() }
  async finalizeRun() { return { ...usageBill(), status: 'SETTLED' as const } }
}

async function usageFixture(overrides: Partial<RunRecord> = {}) {
  const repository = new InMemoryAgentRepository()
  const budget = new MockBudgetPort()
  const images = new MockImageGenerationPort()
  const clock = new FixedClock()
  const usage = new MediaUsagePort()
  await repository.createRun(run({
    presentationMode: 'VISUAL_DECK_V4', accountingProtocol: 'FRAMEFLOW_USAGE_V2',
    imageModel: 'image-2', committedBudgetUnits: 10,
    ...overrides,
  }))
  const billingCatalog = parseProviderBillingCatalog(JSON.stringify({ schemaVersion: '1', entries: [{
    model: 'image-2', operationMode: 'TEXT_TO_IMAGE', resolution: '1K',
    costBasis: 'FIXED_PER_OPERATION', costAmountMicros: 40_000, currency: 'USD',
    providerPricingVersion: 'image-2-2026-08',
  }] }))
  const usageV2 = new UsageV2Coordinator({ repository, usage, billingCatalog, clock })
  const originalSubmit = images.submit.bind(images)
  images.submit = async (input) => {
    usage.order.push('provider')
    return originalSubmit(input)
  }
  return {
    repository, budget, images, clock, usage,
    runner: new MediaStepRunner({ repository, budget, images, clock, usageV2 }),
  }
}

const usageRequest = {
  ...request,
  pageNumber: 1,
  revisionRound: 0,
  batchReservation: {
    batchId: 'genbatch_0123456789abcdef0123456789abcdef',
    reservationId: 'usage-v2:genbatch_0123456789abcdef0123456789abcdef',
  },
} as const

const usageIdentityFields = [
  ['operationIdempotencyKey'], ['batchId'], ['pageNumber'], ['revisionRound'], ['model'], ['operationMode'],
] as const

type UsageIdentityField = typeof usageIdentityFields[number][0]

type PersistedUsageMetadata = Readonly<{
  operationIdempotencyKey: string
  batchId: string
  pageNumber: number
  revisionRound: number
  billingSnapshot: Readonly<{
    model: string
    operationMode: 'TEXT_TO_IMAGE' | 'IMAGE_EDIT'
    [key: string]: unknown
  }>
  [key: string]: unknown
}>

function tamperedUsageMetadata(metadata: PersistedUsageMetadata, field: UsageIdentityField): PersistedUsageMetadata {
  switch (field) {
    case 'operationIdempotencyKey': return { ...metadata, operationIdempotencyKey: 'run-1:tampered-operation-key' }
    case 'batchId': return { ...metadata, batchId: 'genbatch_tampered0123456789abcdef012345' }
    case 'pageNumber': return { ...metadata, pageNumber: 2 }
    case 'revisionRound': return { ...metadata, revisionRound: 1 }
    case 'model': return { ...metadata, billingSnapshot: { ...metadata.billingSnapshot, model: 'tampered-model' } }
    case 'operationMode': return {
      ...metadata,
      billingSnapshot: { ...metadata.billingSnapshot, operationMode: 'IMAGE_EDIT' },
    }
  }
}

async function tamperPersistedUsageIdentity(
  repository: InMemoryAgentRepository,
  field: UsageIdentityField,
) {
  await repository.transact('run-1', (transaction) => {
    const step = transaction.getStep(usageRequest.idempotencyKey)!
    const output = step.output as Record<string, unknown>
    transaction.putStep({
      ...step,
      output: {
        ...output,
        usageV2: tamperedUsageMetadata(output.usageV2 as PersistedUsageMetadata, field),
      },
    })
  })
}

describe('media step runner', () => {
  test('resumes a 4.2 V1 batch page without changing the persisted Provider step identity', async () => {
    const { repository, images, runner } = await fixture({
      presentationMode: 'VISUAL_DECK_V4',
      accountingProtocol: 'LEGACY_RESERVATION_V1',
      committedBudgetUnits: 10,
    })
    const legacyInputHash = hashInput({
      tool: 'generate_slide_image',
      slideId: request.slideId,
      versionId: request.versionId,
      prompt: request.prompt,
      model: request.model,
      aspectRatio: '16:9',
      budgetUnits: request.budgetUnits,
    })
    const batchReservation = { batchId: 'legacy-batch-1', reservationId: 'legacy-reservation-1' }
    await repository.transact('run-1', (transaction) => transaction.putStep({
      id: request.stepId,
      runId: request.runId,
      idempotencyKey: request.idempotencyKey,
      inputHash: legacyInputHash,
      tool: 'generate_slide_image',
      status: 'RESERVED',
      budgetUnits: request.budgetUnits,
      budgetReservationId: batchReservation.reservationId,
      externalOperationId: null,
      errorCode: null,
      output: {
        slideId: request.slideId,
        versionId: request.versionId,
        model: request.model,
        operationMode: 'TEXT_TO_IMAGE',
        backgroundMode: 'OPAQUE',
        batchId: batchReservation.batchId,
      },
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    }))

    await expect(runner.submitSlideImage({
      ...request,
      batchReservation,
      pageNumber: 1,
      revisionRound: 0,
    })).resolves.toMatchObject({ step: { status: 'WAITING' }, replayed: false })

    expect(images.submitCalls).toBe(1)
  })

  test('routes a post-submit Usage V2 operation conflict into technical recovery without resubmitting Provider work', async () => {
    const { repository, images, runner } = await usageFixture()
    const eventId = `pptu_obs_${createHash('sha256')
      .update(['run-1', usageRequest.idempotencyKey].join('\0')).digest('hex').slice(0, 32)}`
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'conflicting-observed', runId: 'run-1',
        idempotencyKey: `run-1:usage-v2:event:${eventId}`, inputHash: 'conflicting-hash',
        tool: 'report_usage_v2', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: 'different-provider-operation', errorCode: null,
        output: {
          deliveryState: 'ACKNOWLEDGED', nextAttemptAt: null, billStatus: 'ACTIVE',
          event: {
            schemaVersion: '2', eventId, sequence: 1, eventType: 'OPERATION_OBSERVED', pptRunId: 'run-1',
            batchId: usageRequest.batchReservation.batchId, pageNumber: 1, revisionRound: 0,
            idempotencyKey: usageRequest.idempotencyKey, providerOperationId: 'different-provider-operation',
            model: 'image-2', status: 'PROCESSING', providerBilling: {
              result: 'UNKNOWN', estimatedCostAmountMicros: 40_000, currency: 'USD', pricingVersion: 'image-2-2026-08',
            },
            operationCreatedAt: '2026-07-21T00:00:00.000Z', operationCompletedAt: null,
            eventAt: '2026-07-21T00:00:00.000Z',
          },
        },
        createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
      })
    })

    const result = await runner.submitSlideImage(usageRequest)
    const providerOperationId = images.operations.get(usageRequest.idempotencyKey)!

    expect(images.submitCalls).toBe(1)
    expect(result.step).toMatchObject({
      status: 'WAITING',
      externalOperationId: providerOperationId,
      errorCode: 'USAGE_V2_PROVIDER_OPERATION_CONFLICT',
      output: {
        technicalFailure: {
          category: 'USAGE_V2', disposition: 'NON_RETRYABLE',
          diagnosticCode: 'USAGE_V2_PROVIDER_OPERATION_CONFLICT',
        },
        usageV2Recovery: {
          stage: 'PROVIDER_SUBMISSION',
          providerOperationId,
          operationIdempotencyKey: usageRequest.idempotencyKey,
          submissionState: 'QUEUED',
          diagnosticCode: 'USAGE_V2_PROVIDER_OPERATION_CONFLICT',
        },
      },
    })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING',
      pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
      technicalRecovery: { reason: 'TERMINAL_ACCOUNTING_PENDING', active: true },
      terminalAccounting: { accountingStatus: 'RECONCILIATION_REQUIRED' },
    })
    await expect(runner.refreshSlideImage('run-1', usageRequest.idempotencyKey))
      .resolves.toMatchObject({ step: { externalOperationId: providerOperationId } })
    expect(images.submitCalls).toBe(1)
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.some((event) => event.type === 'run.failed'
      && event.payload.errorCode === 'WORKER_FATAL')).toBe(false)
  })

  test('types invalid post-submit Usage V2 metadata without losing the accepted operation', async () => {
    const { repository, images, runner } = await usageFixture()
    const submit = images.submit.bind(images)
    images.submit = async (input) => {
      const accepted = await submit(input)
      await repository.transact('run-1', (transaction) => {
        const step = transaction.getStep(usageRequest.idempotencyKey)!
        const output = step.output as Record<string, unknown>
        transaction.putStep({
          ...step,
          output: { ...output, usageV2: { protocol: 'FRAMEFLOW_USAGE_V2' } },
        })
      })
      return accepted
    }

    const result = await runner.submitSlideImage(usageRequest)
    const providerOperationId = images.operations.get(usageRequest.idempotencyKey)!

    expect(result.step).toMatchObject({
      status: 'WAITING', externalOperationId: providerOperationId,
      errorCode: 'USAGE_V2_MEDIA_METADATA_INVALID',
      output: {
        technicalFailure: {
          category: 'USAGE_V2', disposition: 'NON_RETRYABLE',
          diagnosticCode: 'USAGE_V2_MEDIA_METADATA_INVALID',
        },
        usageV2Recovery: {
          stage: 'PROVIDER_SUBMISSION', providerOperationId,
          operationIdempotencyKey: usageRequest.idempotencyKey,
          diagnosticCode: 'USAGE_V2_MEDIA_METADATA_INVALID',
        },
      },
    })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING',
      pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
    })
    expect(images.submitCalls).toBe(1)
  })

  test.each(usageIdentityFields)(
    'rejects a shape-valid post-submit Usage V2 %s mismatch without emitting the wrong event',
    async (field) => {
      const { repository, images, usage, runner } = await usageFixture()
      const submit = images.submit.bind(images)
      images.submit = async (input) => {
        const accepted = await submit(input)
        await tamperPersistedUsageIdentity(repository, field)
        return accepted
      }

      const result = await runner.submitSlideImage(usageRequest)
      const providerOperationId = images.operations.get(usageRequest.idempotencyKey)!

      expect(result.step).toMatchObject({
        idempotencyKey: usageRequest.idempotencyKey,
        status: 'WAITING',
        externalOperationId: providerOperationId,
        errorCode: 'USAGE_V2_MEDIA_IDENTITY_CONFLICT',
        output: {
          technicalFailure: {
            category: 'USAGE_V2', disposition: 'NON_RETRYABLE',
            diagnosticCode: 'USAGE_V2_MEDIA_IDENTITY_CONFLICT',
          },
          usageV2Recovery: {
            stage: 'PROVIDER_SUBMISSION', providerOperationId,
            operationIdempotencyKey: usageRequest.idempotencyKey,
            diagnosticCode: 'USAGE_V2_MEDIA_IDENTITY_CONFLICT',
          },
        },
      })
      expect(usage.events).toHaveLength(0)
      expect(await repository.getRun('run-1')).toMatchObject({
        status: 'RECOVERING', pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
      })
      await runner.refreshSlideImage('run-1', usageRequest.idempotencyKey)
      expect(images.submitCalls).toBe(1)
      const events = await repository.listEvents('run-1')
      expect(events.some((event) => event.type === 'approval.required')).toBe(false)
      expect(events.some((event) => event.type === 'run.failed'
        && event.payload.errorCode === 'WORKER_FATAL')).toBe(false)
    },
  )

  test('requires a persisted Usage V2 permit before Provider submission without a legacy reservation', async () => {
    const { repository, budget, images, usage, runner } = await usageFixture()

    const result = await runner.submitSlideImage(usageRequest)

    expect(result.step.status).toBe('WAITING')
    expect(usage.order).toEqual(['permit', 'provider', 'event'])
    expect(usage.permitKeys).toEqual([usageRequest.idempotencyKey])
    expect(usage.events).toHaveLength(1)
    expect(images.submitCalls).toBe(1)
    expect(budget.reservationRequests).toHaveLength(0)
    expect(budget.batchReservationRequests).toHaveLength(0)
    expect((await repository.listSteps('run-1')).find((step) => step.idempotencyKey === usageRequest.idempotencyKey))
      .toMatchObject({ output: { usageV2: { billingSnapshot: { costAmountMicros: 40_000 }, permit: { allowed: true } } } })
  })

  test('pauses a V4 Run for more budget when the Usage V2 authorization cap is reached', async () => {
    const { repository, budget, images, usage, runner } = await usageFixture()
    usage.permitResult = 'DENY'

    const result = await runner.submitSlideImage(usageRequest)

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'AUTHORIZATION_CAP_REACHED' })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'PAUSED', resumeState: 'EXECUTING',
    })
    const events = await repository.listEvents('run-1')
    expect(events.find((event) => event.type === 'run.paused')).toMatchObject({
      payload: {
        presentationMode: 'VISUAL_DECK_V4', stage: 'RUN', reason: 'BUDGET_INSUFFICIENT',
        retryable: true, requiresUserAction: true, nextAction: 'ADD_BUDGET', resumeState: 'EXECUTING',
      },
    })
    expect(events.find((event) => event.type === 'approval.required')).toMatchObject({
      payload: { kind: 'BUDGET' },
    })
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'technical.recovery.started')).toBe(false)
    expect(images.submitCalls).toBe(0)
    expect(budget.reservationRequests).toHaveLength(0)
  })

  test('rechecks the original permit key after an authorization-cap budget resume', async () => {
    const { repository, images, usage, runner } = await usageFixture()
    usage.permitResult = 'DENY'
    await runner.submitSlideImage(usageRequest)
    expect(images.submitCalls).toBe(0)

    await repository.transact('run-1', (transaction) => {
      const funded = applyRunAction(transaction.run, {
        schemaVersion: CONTRACT_VERSION,
        type: 'ADD_BUDGET',
        expectedVersion: transaction.run.version,
        additionalBudgetUnits: 10,
      })
      const resumed = applyRunAction(funded, {
        schemaVersion: CONTRACT_VERSION,
        type: 'RESUME',
        expectedVersion: funded.version,
      })
      transaction.putRun({ ...transaction.run, ...resumed, updatedAt: transaction.run.updatedAt })
    })
    usage.permitResult = 'ALLOW'

    await expect(runner.submitSlideImage(usageRequest))
      .resolves.toMatchObject({ step: { status: 'WAITING' } })
    expect(usage.permitKeys).toEqual([usageRequest.idempotencyKey, usageRequest.idempotencyKey])
    expect(images.submitCalls).toBe(1)
  })

  test('keeps a definite Usage V2 permit denial on the existing non-V4 failure path', async () => {
    const { repository, images, usage, runner } = await usageFixture({ presentationMode: 'SLIDE_IMAGE_V2' })
    usage.permitResult = 'DENY'

    const result = await runner.submitSlideImage(usageRequest)

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'AUTHORIZATION_CAP_REACHED' })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'EXECUTING' })
    expect(images.submitCalls).toBe(0)
  })

  test('keeps the Provider safety cap distinct from a user budget pause', async () => {
    const { repository, images, usage, runner } = await usageFixture()
    usage.permitResult = 'DENY'
    usage.permitStopReason = 'PROVIDER_SAFETY_CAP_REACHED'

    const result = await runner.submitSlideImage(usageRequest)

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_SAFETY_CAP_REACHED' })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'EXECUTING' })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'run.paused')).toBe(false)
    expect(images.submitCalls).toBe(0)
  })

  test('routes a post-result Usage V2 identity conflict into technical recovery with the original operation', async () => {
    const { repository, images, runner } = await usageFixture()
    const submitted = await runner.submitSlideImage(usageRequest)
    const providerOperationId = submitted.step.externalOperationId!
    const eventId = `pptu_res_${createHash('sha256')
      .update(['run-1', usageRequest.idempotencyKey, providerOperationId].join('\0')).digest('hex').slice(0, 32)}`
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'conflicting-resolved', runId: 'run-1',
        idempotencyKey: `run-1:usage-v2:event:${eventId}`, inputHash: 'conflicting-resolved-hash',
        tool: 'report_usage_v2', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: 'different-provider-operation', errorCode: null,
        output: {
          deliveryState: 'ACKNOWLEDGED', nextAttemptAt: null, billStatus: 'ACTIVE', blockedRunStatus: null,
          event: {
            schemaVersion: '2', eventId, sequence: 2, eventType: 'BILLING_RESOLVED', pptRunId: 'run-1',
            batchId: usageRequest.batchReservation.batchId, pageNumber: 1, revisionRound: 0,
            idempotencyKey: `${usageRequest.idempotencyKey}:billing-resolved`,
            providerOperationId: 'different-provider-operation', model: 'image-2', status: 'COMPLETED',
            providerBilling: {
              result: 'CHARGED', actualCostAmountMicros: 40_000, currency: 'USD',
              pricingVersion: 'image-2-2026-08',
            },
            operationCreatedAt: '2026-07-21T00:00:00.000Z',
            operationCompletedAt: '2026-07-21T00:00:00.000Z', eventAt: '2026-07-21T00:00:00.000Z',
          },
        },
        createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
      })
    })
    images.complete(usageRequest.idempotencyKey, 'artifact-slide-1-v1')

    const result = await runner.refreshSlideImage('run-1', usageRequest.idempotencyKey)

    expect(result).toMatchObject({
      changed: true,
      step: {
        status: 'WAITING', externalOperationId: providerOperationId,
        errorCode: 'USAGE_V2_EVENT_IDENTITY_CONFLICT',
        output: {
          technicalFailure: {
            category: 'USAGE_V2', disposition: 'NON_RETRYABLE',
            diagnosticCode: 'USAGE_V2_EVENT_IDENTITY_CONFLICT',
          },
          usageV2Recovery: {
            stage: 'PROVIDER_RESULT', providerOperationId,
            operationIdempotencyKey: usageRequest.idempotencyKey,
            providerStatus: 'COMPLETED', billingState: 'CHARGED',
            diagnosticCode: 'USAGE_V2_EVENT_IDENTITY_CONFLICT',
          },
        },
      },
    })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'RECOVERING',
      pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
      technicalRecovery: { reason: 'TERMINAL_ACCOUNTING_PENDING', active: true },
    })
    await expect(runner.refreshSlideImage('run-1', usageRequest.idempotencyKey))
      .resolves.toMatchObject({ step: { externalOperationId: providerOperationId } })
    expect(images.submitCalls).toBe(1)
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.some((event) => event.type === 'run.failed'
      && event.payload.errorCode === 'WORKER_FATAL')).toBe(false)
  })

  test.each(usageIdentityFields)(
    'rejects a shape-valid post-result Usage V2 %s mismatch without emitting a resolved event',
    async (field) => {
      const { repository, images, usage, runner } = await usageFixture()
      const submitted = await runner.submitSlideImage(usageRequest)
      const providerOperationId = submitted.step.externalOperationId!
      images.complete(usageRequest.idempotencyKey, 'artifact-slide-1-v1')
      const inspect = images.inspect.bind(images)
      images.inspect = async (input) => {
        const result = await inspect(input)
        await tamperPersistedUsageIdentity(repository, field)
        return result
      }

      const result = await runner.refreshSlideImage('run-1', usageRequest.idempotencyKey)

      expect(result).toMatchObject({
        changed: true,
        step: {
          idempotencyKey: usageRequest.idempotencyKey,
          status: 'WAITING',
          externalOperationId: providerOperationId,
          errorCode: 'USAGE_V2_MEDIA_IDENTITY_CONFLICT',
          output: {
            technicalFailure: {
              category: 'USAGE_V2', disposition: 'NON_RETRYABLE',
              diagnosticCode: 'USAGE_V2_MEDIA_IDENTITY_CONFLICT',
            },
            usageV2Recovery: {
              stage: 'PROVIDER_RESULT', providerOperationId,
              operationIdempotencyKey: usageRequest.idempotencyKey,
              providerStatus: 'COMPLETED', billingState: 'CHARGED',
              diagnosticCode: 'USAGE_V2_MEDIA_IDENTITY_CONFLICT',
            },
          },
        },
      })
      expect(usage.events).toEqual([
        expect.objectContaining({
          eventType: 'OPERATION_OBSERVED',
          batchId: usageRequest.batchReservation.batchId,
          pageNumber: usageRequest.pageNumber,
          revisionRound: usageRequest.revisionRound,
          idempotencyKey: usageRequest.idempotencyKey,
          providerOperationId,
          model: usageRequest.model,
        }),
      ])
      expect(await repository.getRun('run-1')).toMatchObject({
        status: 'RECOVERING', pendingTerminalFailure: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
      })
      await runner.refreshSlideImage('run-1', usageRequest.idempotencyKey)
      expect(images.submitCalls).toBe(1)
      const events = await repository.listEvents('run-1')
      expect(events.some((event) => event.type === 'approval.required')).toBe(false)
      expect(events.some((event) => event.type === 'run.failed'
        && event.payload.errorCode === 'WORKER_FATAL')).toBe(false)
    },
  )

  test('keeps an unknown permit recoverable and retries the same key before one Provider submission', async () => {
    const { images, usage, runner } = await usageFixture()
    usage.permitResult = 'UNKNOWN'

    const unknown = await runner.submitSlideImage(usageRequest)
    usage.permitResult = 'ALLOW'
    const recovered = await runner.submitSlideImage(usageRequest)

    expect(unknown.step).toMatchObject({ status: 'RESERVATION_UNKNOWN', errorCode: 'HOST_USAGE_V2_PERMIT_UNKNOWN' })
    expect(recovered.step.status).toBe('WAITING')
    expect(usage.permitKeys).toEqual([usageRequest.idempotencyKey, usageRequest.idempotencyKey])
    expect(images.submitCalls).toBe(1)
  })

  test('reconciles an accepted image edit after response loss without a second POST', async () => {
    const { repository, images, runner } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', imageModel: 'nano-banana-pro',
    })
    const editRequest = {
      ...request,
      idempotencyKey: `run-1:slide:1:image:r1:v1:edit:${'a'.repeat(24)}`,
      model: 'image-2',
      operationMode: 'IMAGE_EDIT' as const,
      repairContractHash: 'b'.repeat(64),
      referenceImage: {
        mimeType: 'image/png' as const,
        bytes: new Uint8Array([1, 2, 3]),
        sha256: 'c'.repeat(64),
      },
    }
    const first = await runner.submitSlideImage(editRequest)
    const operationId = first.step.externalOperationId!
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(editRequest.idempotencyKey)!
      transaction.putStep({ ...step, status: 'SUBMITTING', externalOperationId: null })
    })

    const recovered = await runner.submitSlideImage(editRequest)

    expect(recovered.step).toMatchObject({ status: 'WAITING', externalOperationId: operationId })
    expect(images.submitCalls).toBe(1)
    expect(images.lookupRequests).toEqual([{
      tenantId: 'frameflow',
      idempotencyKey: editRequest.idempotencyKey,
      operationMode: 'IMAGE_EDIT',
    }])
  })

  test('keeps an unknown image edit unresolved without changing model, key or POST count', async () => {
    const { repository, images, runner } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', imageModel: 'nano-banana-pro',
    })
    const editRequest = {
      ...request,
      idempotencyKey: `run-1:slide:1:image:r1:v1:edit:${'d'.repeat(24)}`,
      model: 'image-2',
      operationMode: 'IMAGE_EDIT' as const,
      repairContractHash: 'e'.repeat(64),
      referenceImage: {
        mimeType: 'image/png' as const,
        bytes: new Uint8Array([4, 5, 6]),
        sha256: 'f'.repeat(64),
      },
    }
    await runner.submitSlideImage(editRequest)
    images.lookupByIdempotency = async (input) => {
      images.lookupRequests.push(structuredClone(input))
      return { state: 'UNKNOWN' as const }
    }
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(editRequest.idempotencyKey)!
      transaction.putStep({ ...step, status: 'SUBMITTING', externalOperationId: null })
    })

    const unknown = await runner.submitSlideImage(editRequest)
    const replay = await runner.submitSlideImage(editRequest)

    expect(unknown.step).toMatchObject({
      status: 'SUBMISSION_UNKNOWN',
      output: { model: 'image-2', operationMode: 'IMAGE_EDIT', repairContractHash: 'e'.repeat(64) },
    })
    expect(replay.step.status).toBe('SUBMISSION_UNKNOWN')
    expect(images.submitCalls).toBe(1)
    expect(images.lookupRequests).toHaveLength(1)
  })

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

  test('releases an unknown V4 submission only after lookup proves it was not submitted', async () => {
    const { repository, budget, images, clock, runner } = await fixture({ presentationMode: 'VISUAL_DECK_V4' })
    images.failNext('IDEMPOTENCY_SUBMISSION_UNKNOWN', 'UNKNOWN')
    const result = await runner.submitSlideImage(request)

    expect(result.step).toMatchObject({ status: 'SUBMISSION_UNKNOWN', errorCode: 'IDEMPOTENCY_SUBMISSION_UNKNOWN' })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 10, status: 'RECOVERING' })
    expect(budget.released.size).toBe(0)
    const events = await repository.listEvents('run-1')
    expect(events.map((event) => event.type)).toContain('issue.detected')
    expect(events.find((event) => event.type === 'phase.changed')?.payload)
      .toMatchObject({ from: 'EXECUTING', to: 'RECOVERING' })
    expect(events.map((event) => event.type)).toContain('technical.recovery.started')
    expect(events.map((event) => event.type)).not.toContain('approval.required')

    clock.advance(2_000)
    await repository.transact('run-1', (transaction) => resumeTechnicalRecovery(transaction, clock))
    const recovered = await runner.submitSlideImage(request)

    expect(recovered.step).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_SUBMISSION_NOT_FOUND' })
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0, status: 'RECOVERING' })
    expect(images.operations.size).toBe(0)
    expect(budget.reservations.size).toBe(1)
    expect(budget.released.size).toBe(1)
  })

  test('backs off interrupted submission reconciliation when the Provider lookup remains unknown', async () => {
    const { repository, images, runner, clock } = await fixture({ presentationMode: 'VISUAL_DECK_V4', status: 'CANCELLED' })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'EXECUTING' })
    })
    await runner.submitSlideImage(request)
    let lookups = 0
    images.lookupByIdempotency = async () => {
      lookups += 1
      return { state: 'UNKNOWN' as const }
    }
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(request.idempotencyKey)!
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
      transaction.putStep({ ...step, status: 'SUBMITTING', externalOperationId: null })
    })

    expect(await runner.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 1 })
    const afterFirst = await repository.listEvents('run-1')
    expect((await repository.listSteps('run-1'))[0]).toMatchObject({
      status: 'SUBMISSION_UNKNOWN', output: { submissionLookupAttempt: 1, nextInspectionAt: expect.any(String) },
    })

    expect(await runner.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 0 })
    expect(lookups).toBe(1)
    expect(await repository.listEvents('run-1')).toEqual(afterFirst)

    clock.advance(2_000)
    expect(await runner.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 1 })
    expect(lookups).toBe(2)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'CANCELLED' })
    expect((await repository.listEvents('run-1')).filter((event) => event.type === 'tool.failed')).toHaveLength(1)
  })

  test('routes a V4 model permission failure to administrator technical handling without user approval', async () => {
    const { repository, images, runner } = await fixture({ presentationMode: 'VISUAL_DECK_V4' })
    images.failNext('MODEL_FORBIDDEN', 'NOT_SUBMITTED')

    const result = await runner.submitSlideImage(request)

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'MODEL_FORBIDDEN' })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'FAILED',
      technicalRecovery: { reason: 'MODEL_FORBIDDEN', retryable: false, active: false },
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.find((event) => event.type === 'run.failed')).toMatchObject({
      payload: { errorCode: 'TECHNICAL_CONFIGURATION_REQUIRED' },
    })
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
      backgroundMode: 'OPAQUE',
      model: 'image-2',
      operationMode: 'TEXT_TO_IMAGE',
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

  test('recovers a completed Provider operation from billing unknown without a second submission', async () => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    const operationId = images.operations.get(request.idempotencyKey)!
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(request.idempotencyKey)!
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: transaction.run.version + 1 })
      transaction.putStep({ ...step, status: 'BILLING_UNKNOWN', errorCode: 'RATE_LIMITED' })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: `${step.id}:provider-result`, category: 'PROVIDER_RESULT_FAILED', severity: 'CRITICAL',
          summary: 'Provider 查询暂时不可用。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
        },
      })
    })
    images.statuses.set(operationId, { state: 'COMPLETED', artifactId: 'artifact-recovered' })

    const recovered = await runner.refreshSlideImage('run-1', request.idempotencyKey)

    expect(recovered).toMatchObject({ changed: true, step: { status: 'COMPLETED', output: { artifactId: 'artifact-recovered' } } })
    expect(images.operations.size).toBe(1)
    expect(budget.settled.size).toBe(1)
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'issue.resolved' && event.payload.issueId === request.stepId + ':provider-result')).toBe(true)
  })

  test('reconciles a known billing-unknown operation when its next poll later completes', async () => {
    const { repository, budget, images, runner } = await fixture()
    await runner.submitSlideImage(request)
    const operationId = images.operations.get(request.idempotencyKey)!
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(request.idempotencyKey)!
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: transaction.run.version + 1 })
      transaction.putStep({ ...step, status: 'BILLING_UNKNOWN', errorCode: 'RATE_LIMITED' })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: `${step.id}:provider-result`, category: 'PROVIDER_RESULT_FAILED', severity: 'CRITICAL',
          summary: 'Provider 查询暂时不可用。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
        },
      })
    })
    images.statuses.set(operationId, { state: 'PROCESSING' })
    expect(await runner.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 0 })

    images.statuses.set(operationId, { state: 'COMPLETED', artifactId: 'artifact-background-recovered' })
    expect(await runner.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 1 })
    expect((await repository.listSteps('run-1'))[0]).toMatchObject({ status: 'COMPLETED' })
    expect(images.operations.size).toBe(1)
    expect(budget.settled.size).toBe(1)
  })

  test('defers the next media inspection when the Provider asks for backoff', async () => {
    const { images, runner } = await fixture()
    await runner.submitSlideImage(request)
    const operationId = images.operations.get(request.idempotencyKey)!
    images.statuses.set(operationId, { state: 'PROCESSING', retryAfterMs: 2_000 })

    const deferred = await runner.refreshSlideImage('run-1', request.idempotencyKey)
    const skipped = await runner.refreshSlideImage('run-1', request.idempotencyKey)

    expect(deferred).toMatchObject({ changed: true, step: { output: { nextInspectionAt: expect.any(String) } } })
    expect(skipped).toMatchObject({ changed: false })
    expect(images.inspectCalls).toBe(1)
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

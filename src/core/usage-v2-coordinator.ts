import { createHash } from 'node:crypto'
import { CONTRACT_VERSION } from '../contracts'
import {
  UsageAccountingRequestError,
  usageOperationEventV2Schema,
  usageRunBillSchema,
  type ProviderBilling,
  type UsageOperationEventV2,
  type UsagePermit,
  type UsageRunBill,
} from '../usage-accounting-contracts'
import { hashInput } from './hash'
import { isPendingMediaReconciliationStep } from './media-reconciliation'
import { isTerminalStatus, transitionRun } from './policy'
import type {
  AgentRepository,
  AgentTransaction,
  ClockPort,
  ProviderBillingCatalogPort,
  ProviderBillingSnapshot,
  RunRecord,
  StepRecord,
  UsageAccountingPort,
} from './ports'

type UsageMediaMetadata = Readonly<{
  protocol: 'FRAMEFLOW_USAGE_V2'
  batchId: string
  pageNumber: number
  revisionRound: number
  operationIdempotencyKey: string
  operationCreatedAt: string
  billingSnapshot: ProviderBillingSnapshot
  permit: UsagePermit | Readonly<{
    allowed: null
    errorCode: string | null
    outcome: 'REJECTED' | 'UNKNOWN' | null
  }>
}>

type UsageOutboxOutput = Readonly<{
  event: UsageOperationEventV2
  deliveryState: 'PENDING' | 'ACKNOWLEDGED' | 'REJECTED'
  nextAttemptAt: string | null
  billStatus: string | null
  blockedRunStatus: UsageReviewResumeStatus | null
}>

type UsageReviewResumeStatus = 'PLANNING' | 'EXECUTING' | 'PAGE_REVIEW' | 'DECK_REVIEW' | 'REVISING' | 'DELIVERING'

const usageReviewResumeStatuses = new Set<UsageReviewResumeStatus>([
  'PLANNING', 'EXECUTING', 'PAGE_REVIEW', 'DECK_REVIEW', 'REVISING', 'DELIVERING',
])

type UsageFinalizeOutput = Readonly<{
  schemaVersion: '2'
  idempotencyKey: string
  deliveryState: 'PENDING' | 'ACKNOWLEDGED' | 'REVIEW_REQUIRED'
  nextAttemptAt: string | null
  bill: UsageRunBill | null
}>

export function accountingProtocolFor(run: Pick<RunRecord, 'accountingProtocol'>) {
  return run.accountingProtocol ?? 'LEGACY_RESERVATION_V1'
}

export function usageV2FinalizeStepKey(runId: string) {
  return `${runId}:usage-v2:finalize`
}

function finalizeRequestKey(runId: string) {
  return `finalize:${runId}`
}

function finalizeStepOutput(step: StepRecord): UsageFinalizeOutput {
  const output = outputRecord(step) as Partial<UsageFinalizeOutput>
  if (output.schemaVersion !== '2'
    || output.idempotencyKey !== finalizeRequestKey(step.runId)
    || !['PENDING', 'ACKNOWLEDGED', 'REVIEW_REQUIRED'].includes(String(output.deliveryState))
    || (output.nextAttemptAt !== null && typeof output.nextAttemptAt !== 'string')) {
    throw new Error('USAGE_V2_FINALIZE_OUTBOX_INVALID')
  }
  const bill = output.bill === null ? null : usageRunBillSchema.parse(output.bill)
  return {
    schemaVersion: '2',
    idempotencyKey: output.idempotencyKey,
    deliveryState: output.deliveryState as UsageFinalizeOutput['deliveryState'],
    nextAttemptAt: output.nextAttemptAt,
    bill,
  }
}

export function enqueueUsageV2RunFinalization(transaction: AgentTransaction, clock: ClockPort) {
  if (accountingProtocolFor(transaction.run) !== 'FRAMEFLOW_USAGE_V2') return null
  if (!isTerminalStatus(transaction.run.status)) throw new Error('USAGE_V2_TERMINAL_RUN_REQUIRED')
  const key = usageV2FinalizeStepKey(transaction.run.id)
  const requestKey = finalizeRequestKey(transaction.run.id)
  const inputHash = hashInput({ tool: 'finalize_usage_v2', runId: transaction.run.id, idempotencyKey: requestKey })
  const existing = transaction.getStep(key)
  if (existing) {
    if (existing.tool !== 'finalize_usage_v2' || existing.inputHash !== inputHash) {
      throw new Error('USAGE_V2_FINALIZE_IDEMPOTENCY_CONFLICT')
    }
    finalizeStepOutput(existing)
    return existing
  }
  const now = clock.now().toISOString()
  const output: UsageFinalizeOutput = {
    schemaVersion: '2',
    idempotencyKey: requestKey,
    deliveryState: 'PENDING',
    nextAttemptAt: null,
    bill: null,
  }
  const step: StepRecord = {
    id: `step-${hashInput({ runId: transaction.run.id, tool: 'finalize_usage_v2' }).slice(0, 28)}`,
    runId: transaction.run.id,
    idempotencyKey: key,
    inputHash,
    tool: 'finalize_usage_v2',
    status: 'RUNNING',
    budgetUnits: 0,
    budgetReservationId: null,
    externalOperationId: null,
    errorCode: null,
    output,
    createdAt: now,
    updatedAt: now,
  }
  transaction.putStep(step)
  return step
}

function outputRecord(step: StepRecord) {
  return step.output && typeof step.output === 'object'
    ? step.output as Record<string, unknown>
    : {}
}

function usageMetadata(step: StepRecord): UsageMediaMetadata {
  const metadata = outputRecord(step).usageV2
  if (!metadata || typeof metadata !== 'object') throw new Error('USAGE_V2_MEDIA_METADATA_MISSING')
  return metadata as UsageMediaMetadata
}

function eventStepOutput(step: StepRecord): UsageOutboxOutput {
  const output = outputRecord(step) as Partial<UsageOutboxOutput>
  const event = usageOperationEventV2Schema.parse(output.event)
  if (!['PENDING', 'ACKNOWLEDGED', 'REJECTED'].includes(String(output.deliveryState))) {
    throw new Error('USAGE_V2_OUTBOX_INVALID')
  }
  return {
    event,
    deliveryState: output.deliveryState as UsageOutboxOutput['deliveryState'],
    nextAttemptAt: typeof output.nextAttemptAt === 'string' ? output.nextAttemptAt : null,
    billStatus: typeof output.billStatus === 'string' ? output.billStatus : null,
    blockedRunStatus: usageReviewResumeStatuses.has(output.blockedRunStatus as UsageReviewResumeStatus)
      ? output.blockedRunStatus as UsageReviewResumeStatus
      : null,
  }
}

function digest(parts: readonly string[]) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
}

function observedEventId(runId: string, operationKey: string) {
  return `pptu_obs_${digest([runId, operationKey])}`
}

function resolvedEventId(runId: string, operationKey: string, providerOperationId: string) {
  return `pptu_res_${digest([runId, operationKey, providerOperationId])}`
}

function outboxStepKey(runId: string, eventId: string) {
  return `${runId}:usage-v2:event:${eventId}`
}

function providerBilling(snapshot: ProviderBillingSnapshot, result: 'CHARGED' | 'NOT_CHARGED' | 'UNKNOWN'): ProviderBilling {
  if (result === 'UNKNOWN') {
    return {
      result,
      estimatedCostAmountMicros: snapshot.costAmountMicros,
      currency: snapshot.currency,
      pricingVersion: snapshot.providerPricingVersion,
    }
  }
  if (result === 'NOT_CHARGED') {
    return {
      result,
      actualCostAmountMicros: 0,
      currency: snapshot.currency,
      pricingVersion: snapshot.providerPricingVersion,
    }
  }
  return {
    result: 'CHARGED',
    actualCostAmountMicros: snapshot.costAmountMicros,
    currency: snapshot.currency,
    pricingVersion: snapshot.providerPricingVersion,
  }
}

export class UsageV2Coordinator {
  readonly #runLocks = new Map<string, Promise<void>>()

  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    usage: UsageAccountingPort
    billingCatalog: ProviderBillingCatalogPort
    clock: ClockPort
  }>) {}

  async authorizeMediaOperation(input: Readonly<{
    runId: string
    mediaStepKey: string
    batchId: string
    pageNumber: number
    revisionRound: number
    model: string
    operationMode: 'TEXT_TO_IMAGE' | 'IMAGE_EDIT'
    resolution: '1K'
    aspectRatio: '16:9' | '4:3' | '1:1' | '3:4'
  }>) {
    const freshSnapshot = this.dependencies.billingCatalog.snapshot(input)
    const prepared = await this.dependencies.repository.transact(input.runId, (transaction) => {
      if (accountingProtocolFor(transaction.run) !== 'FRAMEFLOW_USAGE_V2') throw new Error('USAGE_V2_RUN_REQUIRED')
      const step = transaction.getStep(input.mediaStepKey)
      if (!step || step.tool !== 'generate_slide_image') throw new Error('STEP_NOT_FOUND')
      const output = outputRecord(step)
      if (output.batchId !== input.batchId
        || output.pageNumber !== input.pageNumber
        || output.revisionRound !== input.revisionRound
        || output.model !== input.model
        || output.operationMode !== input.operationMode) {
        throw new Error('USAGE_V2_MEDIA_IDENTITY_CONFLICT')
      }
      const existing = output.usageV2 as UsageMediaMetadata | undefined
      if (existing) {
        if (existing.protocol !== 'FRAMEFLOW_USAGE_V2'
          || existing.batchId !== input.batchId
          || existing.pageNumber !== input.pageNumber
          || existing.revisionRound !== input.revisionRound
          || existing.operationIdempotencyKey !== input.mediaStepKey
          || existing.billingSnapshot.model !== input.model
          || existing.billingSnapshot.operationMode !== input.operationMode
          || existing.billingSnapshot.resolution !== input.resolution
          || existing.billingSnapshot.aspectRatio !== input.aspectRatio) {
          throw new Error('USAGE_V2_MEDIA_IDENTITY_CONFLICT')
        }
        return { run: transaction.run, step, metadata: existing }
      }
      const metadata: UsageMediaMetadata = {
        protocol: 'FRAMEFLOW_USAGE_V2',
        batchId: input.batchId,
        pageNumber: input.pageNumber,
        revisionRound: input.revisionRound,
        operationIdempotencyKey: input.mediaStepKey,
        operationCreatedAt: this.dependencies.clock.now().toISOString(),
        billingSnapshot: freshSnapshot,
        permit: { allowed: null, errorCode: null, outcome: null },
      }
      const updated = { ...step, output: { ...output, usageV2: metadata }, updatedAt: this.dependencies.clock.now().toISOString() }
      transaction.putStep(updated)
      return { run: transaction.run, step: updated, metadata }
    })
    if (prepared.metadata.permit.allowed !== null) return prepared.metadata.permit
    if (prepared.metadata.permit.outcome === 'REJECTED') {
      throw new UsageAccountingRequestError(
        prepared.metadata.permit.errorCode ?? 'HOST_USAGE_V2_PERMIT_REJECTED',
        'REJECTED',
      )
    }

    try {
      const permit = await this.dependencies.usage.authorizeOperation({
        host: prepared.run.host,
        runId: input.runId,
        operationIdempotencyKey: input.mediaStepKey,
        pageNumber: input.pageNumber,
        revisionRound: input.revisionRound,
        model: input.model,
      })
      await this.persistPermit(input.runId, input.mediaStepKey, permit)
      return permit
    } catch (error) {
      const code = error instanceof UsageAccountingRequestError ? error.code : 'HOST_USAGE_V2_PERMIT_UNKNOWN'
      if (error instanceof UsageAccountingRequestError && error.outcome === 'REJECTED') {
        await this.persistPermitError(input.runId, input.mediaStepKey, code, true)
      } else {
        await this.persistPermitError(input.runId, input.mediaStepKey, code, false)
      }
      throw error
    }
  }

  async recordProviderSubmission(input: Readonly<{
    runId: string
    mediaStepKey: string
    operationId: string
    state: 'QUEUED' | 'PROCESSING' | 'COMPLETED'
  }>) {
    const { run, step, metadata } = await this.requireMedia(input.runId, input.mediaStepKey, input.operationId)
    if (metadata.permit.allowed !== true) throw new Error('USAGE_V2_PERMIT_REQUIRED')
    const persisted = await this.findObserved(run.id, metadata.operationIdempotencyKey)
    if (persisted) {
      if (persisted.providerOperationId !== input.operationId) throw new Error('USAGE_V2_PROVIDER_OPERATION_CONFLICT')
      return this.flushEvents(run.id)
    }
    const completed = input.state === 'COMPLETED'
    const eventAt = this.dependencies.clock.now().toISOString()
    await this.enqueueEvent(run, {
      schemaVersion: '2',
      eventId: observedEventId(run.id, metadata.operationIdempotencyKey),
      sequence: 1,
      eventType: 'OPERATION_OBSERVED',
      pptRunId: run.id,
      batchId: metadata.batchId,
      pageNumber: metadata.pageNumber,
      revisionRound: metadata.revisionRound,
      idempotencyKey: metadata.operationIdempotencyKey,
      providerOperationId: input.operationId,
      model: metadata.billingSnapshot.model,
      status: completed ? 'COMPLETED' : 'PROCESSING',
      providerBilling: providerBilling(metadata.billingSnapshot, completed ? 'CHARGED' : 'UNKNOWN'),
      operationCreatedAt: metadata.operationCreatedAt,
      operationCompletedAt: completed ? eventAt : null,
      eventAt,
    })
    return this.flushEvents(step.runId)
  }

  async recordProviderResult(input: Readonly<{
    runId: string
    mediaStepKey: string
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED'
    billingState: 'CHARGED' | 'NOT_CHARGED' | 'UNKNOWN'
  }>) {
    const { run, step, metadata } = await this.requireMedia(input.runId, input.mediaStepKey)
    if (!step.externalOperationId) throw new Error('MEDIA_OPERATION_ID_MISSING')
    const observed = await this.findObserved(run.id, metadata.operationIdempotencyKey)
    if (!observed) throw new Error('USAGE_V2_OBSERVED_REQUIRED')
    if (observed.providerBilling.result !== 'UNKNOWN' || input.billingState === 'UNKNOWN') {
      return this.flushEvents(run.id)
    }
    const eventId = resolvedEventId(run.id, metadata.operationIdempotencyKey, step.externalOperationId)
    const persisted = await this.findEvent(run.id, eventId)
    if (persisted) {
      if (persisted.eventType !== 'BILLING_RESOLVED'
        || persisted.providerOperationId !== step.externalOperationId
        || persisted.idempotencyKey !== `${metadata.operationIdempotencyKey}:billing-resolved`) {
        throw new Error('USAGE_V2_EVENT_IDENTITY_CONFLICT')
      }
      return this.flushEvents(run.id)
    }
    const eventAt = this.dependencies.clock.now().toISOString()
    await this.enqueueEvent(run, {
      schemaVersion: '2',
      eventId,
      sequence: 1,
      eventType: 'BILLING_RESOLVED',
      pptRunId: run.id,
      batchId: metadata.batchId,
      pageNumber: metadata.pageNumber,
      revisionRound: metadata.revisionRound,
      idempotencyKey: `${metadata.operationIdempotencyKey}:billing-resolved`,
      providerOperationId: step.externalOperationId,
      model: metadata.billingSnapshot.model,
      status: input.status,
      providerBilling: providerBilling(metadata.billingSnapshot, input.billingState),
      operationCreatedAt: metadata.operationCreatedAt,
      operationCompletedAt: eventAt,
      eventAt,
    })
    return this.flushEvents(run.id)
  }

  async flushEvents(runId: string) {
    return this.withRunLock(runId, async () => {
      const run = await this.dependencies.repository.getRun(runId)
      if (!run) throw new Error('RUN_NOT_FOUND')
      const steps = (await this.dependencies.repository.listSteps(runId))
        .filter((step) => step.tool === 'report_usage_v2')
        .sort((left, right) => eventStepOutput(left).event.sequence - eventStepOutput(right).event.sequence)
      if (steps.some((step) => step.status === 'FAILED')) return false
      for (const step of steps) {
        if (step.status === 'COMPLETED') continue
        const output = eventStepOutput(step)
        if (output.nextAttemptAt && Date.parse(output.nextAttemptAt) > this.dependencies.clock.now().getTime()) return false
        try {
          const result = await this.dependencies.usage.ingestEvent({ host: run.host, event: output.event })
          await this.updateOutbox(step.idempotencyKey, {
            status: 'COMPLETED', deliveryState: 'ACKNOWLEDGED', errorCode: null,
            nextAttemptAt: null, billStatus: result.bill.status,
          })
          if (output.blockedRunStatus) await this.completeUsageReview(run.id, step.idempotencyKey)
        } catch (error) {
          const rejected = error instanceof UsageAccountingRequestError && error.outcome === 'REJECTED'
          const errorCode = error instanceof UsageAccountingRequestError ? error.code : 'HOST_USAGE_V2_EVENT_UNKNOWN'
          if (rejected) {
            await this.rejectOutbox(step.idempotencyKey, errorCode)
          } else {
            await this.updateOutbox(step.idempotencyKey, {
              status: 'RUNNING', deliveryState: 'PENDING', errorCode,
              nextAttemptAt: new Date(this.dependencies.clock.now().getTime() + 1_000).toISOString(),
              billStatus: null,
            })
          }
          return false
        }
      }
      return true
    })
  }

  async retryRejectedEvent(runId: string, key: string) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      if (accountingProtocolFor(transaction.run) !== 'FRAMEFLOW_USAGE_V2') throw new Error('USAGE_V2_RUN_REQUIRED')
      const step = transaction.getStep(key)
      if (!step || step.tool !== 'report_usage_v2') throw new Error('USAGE_V2_OUTBOX_NOT_FOUND')
      const output = eventStepOutput(step)
      if (step.status !== 'FAILED' || output.deliveryState !== 'REJECTED') {
        throw new Error('USAGE_V2_OUTBOX_NOT_RETRYABLE')
      }
      transaction.putStep({
        ...step,
        status: 'RUNNING',
        errorCode: null,
        output: { ...output, deliveryState: 'PENDING', nextAttemptAt: null },
        updatedAt: this.dependencies.clock.now().toISOString(),
      })
    })
    await this.flushEvents(runId)
    return this.completeUsageReview(runId, key)
  }

  async reconcileTerminalRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run || accountingProtocolFor(run) !== 'FRAMEFLOW_USAGE_V2' || !isTerminalStatus(run.status)) return false
    const steps = await this.dependencies.repository.listSteps(runId)
    const finalization = steps.find((step) => step.idempotencyKey === usageV2FinalizeStepKey(runId))
    if (!finalization || finalization.tool !== 'finalize_usage_v2') {
      throw new Error('USAGE_V2_FINALIZE_OUTBOX_MISSING')
    }
    if (finalization.status === 'COMPLETED') return true
    if (finalization.status === 'FAILED') return false
    const output = finalizeStepOutput(finalization)
    if (output.nextAttemptAt && Date.parse(output.nextAttemptAt) > this.dependencies.clock.now().getTime()) return false
    if (!await this.flushEvents(runId)) return false
    const refreshedSteps = await this.dependencies.repository.listSteps(runId)
    if (refreshedSteps.some(isPendingMediaReconciliationStep)) return false

    let bill: UsageRunBill
    try {
      bill = await this.dependencies.usage.finalizeRun({
        host: run.host,
        runId,
        idempotencyKey: output.idempotencyKey,
      })
      if (bill.pptRunId !== runId) {
        throw new UsageAccountingRequestError('HOST_USAGE_V2_BILL_RUN_MISMATCH', 'REJECTED')
      }
    } catch (error) {
      const rejected = error instanceof UsageAccountingRequestError && error.outcome === 'REJECTED'
      await this.updateFinalization(runId, {
        status: rejected ? 'FAILED' : 'RUNNING',
        deliveryState: rejected ? 'REVIEW_REQUIRED' : 'PENDING',
        errorCode: error instanceof UsageAccountingRequestError ? error.code : 'HOST_USAGE_V2_FINALIZE_UNKNOWN',
        nextAttemptAt: rejected ? null : new Date(this.dependencies.clock.now().getTime() + 1_000).toISOString(),
        bill: output.bill,
      })
      return false
    }

    if (bill.status === 'SETTLED' || bill.status === 'CAP_EXCEEDED') {
      await this.updateFinalization(runId, {
        status: 'COMPLETED', deliveryState: 'ACKNOWLEDGED', errorCode: null, nextAttemptAt: null, bill,
      })
      return true
    }
    if (bill.status === 'REVIEW_REQUIRED' || bill.status === 'LEGACY_RECONCILIATION') {
      await this.updateFinalization(runId, {
        status: 'FAILED', deliveryState: 'REVIEW_REQUIRED',
        errorCode: `HOST_USAGE_V2_${bill.status}`, nextAttemptAt: null, bill,
      })
      return false
    }
    const hostNextAttempt = bill.status === 'RECONCILING' ? bill.nextReconcileAt : null
    const nextAttemptAt = hostNextAttempt && Date.parse(hostNextAttempt) > this.dependencies.clock.now().getTime()
      ? hostNextAttempt
      : new Date(this.dependencies.clock.now().getTime() + 1_000).toISOString()
    await this.updateFinalization(runId, {
      status: 'RUNNING', deliveryState: 'PENDING', errorCode: null, nextAttemptAt, bill,
    })
    return false
  }

  private async persistPermit(runId: string, mediaStepKey: string, permit: UsagePermit) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(mediaStepKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const output = outputRecord(step)
      const metadata = usageMetadata(step)
      transaction.putStep({
        ...step,
        output: { ...output, usageV2: { ...metadata, permit } },
        updatedAt: this.dependencies.clock.now().toISOString(),
      })
    })
  }

  private async persistPermitError(runId: string, mediaStepKey: string, errorCode: string, rejected: boolean) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(mediaStepKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const output = outputRecord(step)
      const metadata = usageMetadata(step)
      transaction.putStep({
        ...step,
        output: {
          ...output,
          usageV2: {
            ...metadata,
            permit: { allowed: null, errorCode, outcome: rejected ? 'REJECTED' : 'UNKNOWN' },
          },
        },
        errorCode,
        updatedAt: this.dependencies.clock.now().toISOString(),
      })
    })
  }

  private async requireMedia(runId: string, mediaStepKey: string, operationId?: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run || accountingProtocolFor(run) !== 'FRAMEFLOW_USAGE_V2') throw new Error('USAGE_V2_RUN_REQUIRED')
    const step = (await this.dependencies.repository.listSteps(runId))
      .find((candidate) => candidate.idempotencyKey === mediaStepKey)
    if (!step || step.tool !== 'generate_slide_image') throw new Error('STEP_NOT_FOUND')
    if (operationId && step.externalOperationId !== operationId) throw new Error('USAGE_V2_PROVIDER_OPERATION_CONFLICT')
    return { run, step, metadata: usageMetadata(step) }
  }

  private async enqueueEvent(run: RunRecord, candidate: UsageOperationEventV2) {
    await this.dependencies.repository.transact(run.id, (transaction) => {
      const key = outboxStepKey(run.id, candidate.eventId)
      const existing = transaction.getStep(key)
      if (existing) {
        const existingEvent = eventStepOutput(existing).event
        const normalized = { ...candidate, sequence: existingEvent.sequence }
        if (existing.inputHash !== hashInput(normalized)) throw new Error('USAGE_V2_EVENT_IDENTITY_CONFLICT')
        return
      }
      const sequence = transaction.listSteps()
        .filter((step) => step.tool === 'report_usage_v2')
        .reduce((maximum, step) => Math.max(maximum, eventStepOutput(step).event.sequence), 0) + 1
      const event = usageOperationEventV2Schema.parse({ ...candidate, sequence })
      const now = this.dependencies.clock.now().toISOString()
      const output: UsageOutboxOutput = {
        event, deliveryState: 'PENDING', nextAttemptAt: null, billStatus: null, blockedRunStatus: null,
      }
      transaction.putStep({
        id: `step-${candidate.eventId}`,
        runId: run.id,
        idempotencyKey: key,
        inputHash: hashInput(event),
        tool: 'report_usage_v2',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: event.providerOperationId,
        errorCode: null,
        output,
        createdAt: now,
        updatedAt: now,
      })
    })
  }

  private async findObserved(runId: string, operationKey: string) {
    const eventId = observedEventId(runId, operationKey)
    return this.findEvent(runId, eventId)
  }

  private async findEvent(runId: string, eventId: string) {
    const step = (await this.dependencies.repository.listSteps(runId))
      .find((candidate) => candidate.idempotencyKey === outboxStepKey(runId, eventId))
    return step ? eventStepOutput(step).event : null
  }

  private async rejectOutbox(key: string, errorCode: string) {
    const runId = key.split(':usage-v2:event:')[0]!
    await this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(key)
      if (!step || step.tool !== 'report_usage_v2') throw new Error('USAGE_V2_OUTBOX_NOT_FOUND')
      const output = eventStepOutput(step)
      const inheritedStatus = transaction.listSteps()
        .filter((candidate) => candidate.tool === 'report_usage_v2' && candidate.status === 'FAILED')
        .map(eventStepOutput)
        .find((candidate) => candidate.blockedRunStatus)?.blockedRunStatus ?? null
      const blockedRunStatus = output.blockedRunStatus
        ?? (usageReviewResumeStatuses.has(transaction.run.status as UsageReviewResumeStatus)
          ? transaction.run.status as UsageReviewResumeStatus
          : inheritedStatus)
      const now = this.dependencies.clock.now().toISOString()
      transaction.putStep({
        ...step,
        status: 'FAILED',
        errorCode,
        output: {
          ...output,
          deliveryState: 'REJECTED',
          nextAttemptAt: null,
          billStatus: null,
          blockedRunStatus,
        },
        updatedAt: now,
      })
      if (usageReviewResumeStatuses.has(transaction.run.status as UsageReviewResumeStatus)) {
        const from = transaction.run.status
        const updated = { ...transaction.run, ...transitionRun(transaction.run, 'NEEDS_HUMAN'), updatedAt: now }
        transaction.putRun(updated)
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from, to: 'NEEDS_HUMAN', reason: errorCode },
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'HUMAN_REVIEW', summary: 'Usage V2 事件被宿主明确拒绝，需要管理员修复冲突后重投原事件。' },
        })
      }
      const issueId = `${step.id}:usage-v2-delivery`
      const open = new Set<string>()
      for (const event of transaction.listEvents()) {
        if (event.type === 'issue.detected') open.add(event.payload.id)
        if (event.type === 'issue.resolved') open.delete(event.payload.issueId)
      }
      if (!open.has(issueId)) transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: issueId,
          category: 'PROVIDER_RESULT_FAILED',
          severity: 'CRITICAL',
          summary: `Usage V2 事件被宿主明确拒绝（${errorCode}），已停止自动重试并保留原事件。`,
          slideIds: [],
          sourceChunkIds: [],
          status: 'OPEN',
        },
      })
    })
  }

  private async completeUsageReview(runId: string, key: string) {
    return this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(key)
      if (!step || step.tool !== 'report_usage_v2') throw new Error('USAGE_V2_OUTBOX_NOT_FOUND')
      const output = eventStepOutput(step)
      if (step.status !== 'COMPLETED') return false
      const issueId = `${step.id}:usage-v2-delivery`
      const open = new Set<string>()
      for (const event of transaction.listEvents()) {
        if (event.type === 'issue.detected') open.add(event.payload.id)
        if (event.type === 'issue.resolved') open.delete(event.payload.issueId)
      }
      if (open.has(issueId)) transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.resolved',
        payload: { issueId, resolution: 'FIXED' },
      })
      const failedUsage = transaction.listSteps().some((candidate) =>
        candidate.tool === 'report_usage_v2' && candidate.status === 'FAILED')
      const blockedRunStatus = output.blockedRunStatus
        ?? transaction.listSteps()
          .filter((candidate) => candidate.tool === 'report_usage_v2')
          .map(eventStepOutput)
          .find((candidate) => candidate.blockedRunStatus)?.blockedRunStatus
        ?? null
      if (!failedUsage && transaction.run.status === 'NEEDS_HUMAN' && blockedRunStatus) {
        const now = this.dependencies.clock.now().toISOString()
        transaction.putRun({
          ...transaction.run,
          status: blockedRunStatus,
          resumeState: null,
          version: transaction.run.version + 1,
          updatedAt: now,
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'NEEDS_HUMAN', to: blockedRunStatus, reason: 'USAGE_V2_EVENT_RECONCILED' },
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'run.resumed',
          payload: { status: blockedRunStatus },
        })
      }
      transaction.putStep({
        ...step,
        output: { ...output, blockedRunStatus: null },
        updatedAt: this.dependencies.clock.now().toISOString(),
      })
      return true
    })
  }

  private async updateOutbox(
    key: string,
    update: Readonly<{
      status: StepRecord['status']
      deliveryState: UsageOutboxOutput['deliveryState']
      errorCode: string | null
      nextAttemptAt: string | null
      billStatus: string | null
    }>,
  ) {
    const runId = key.split(':usage-v2:event:')[0]!
    await this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(key)
      if (!step) throw new Error('USAGE_V2_OUTBOX_NOT_FOUND')
      const output = eventStepOutput(step)
      transaction.putStep({
        ...step,
        status: update.status,
        errorCode: update.errorCode,
        output: {
          ...output,
          deliveryState: update.deliveryState,
          nextAttemptAt: update.nextAttemptAt,
          billStatus: update.billStatus,
        },
        updatedAt: this.dependencies.clock.now().toISOString(),
      })
    })
  }

  private async updateFinalization(
    runId: string,
    update: Readonly<{
      status: StepRecord['status']
      deliveryState: UsageFinalizeOutput['deliveryState']
      errorCode: string | null
      nextAttemptAt: string | null
      bill: UsageRunBill | null
    }>,
  ) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      const step = transaction.getStep(usageV2FinalizeStepKey(runId))
      if (!step || step.tool !== 'finalize_usage_v2') throw new Error('USAGE_V2_FINALIZE_OUTBOX_MISSING')
      const output = finalizeStepOutput(step)
      transaction.putStep({
        ...step,
        status: update.status,
        errorCode: update.errorCode,
        output: {
          ...output,
          deliveryState: update.deliveryState,
          nextAttemptAt: update.nextAttemptAt,
          bill: update.bill,
        },
        updatedAt: this.dependencies.clock.now().toISOString(),
      })
    })
  }

  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#runLocks.get(runId) ?? Promise.resolve()
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => gate)
    this.#runLocks.set(runId, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.#runLocks.get(runId) === queued) this.#runLocks.delete(runId)
    }
  }
}

import { CONTRACT_VERSION } from '../contracts'
import { generationBatchSchema, type GenerationBatch } from '../generation-batch-contracts'
import type { PresentationBlueprint } from '../presentation-contracts'
import { hashInput } from './hash'
import {
  BudgetReservationError,
  type AgentRepository,
  type AgentTransaction,
  type BatchBudgetPort,
  type ClockPort,
  type RunRecord,
  type StepRecord,
} from './ports'
import { releaseBudget, reserveBudget } from './policy'
import { beginTechnicalRecovery } from './technical-recovery'

type Requirement = Readonly<{
  pageNumber: number
  idempotencyKey: string
  prompt: string
}>

export function generationBatchStepKey(run: Pick<RunRecord, 'id' | 'revisionRound'>) {
  return `${run.id}:generation-batch:r${run.revisionRound}`
}

function proposalHash(blueprint: PresentationBlueprint) {
  return hashInput(blueprint.visualDeckV4Proposal ?? blueprint)
}

function batchId(run: Pick<RunRecord, 'id' | 'revisionRound'>, proposal: string) {
  return `genbatch_${hashInput({ runId: run.id, revisionRound: run.revisionRound, proposal }).slice(0, 32)}`
}

function initialBatch(run: RunRecord, blueprint: PresentationBlueprint, requirements: readonly Requirement[], unitBudgetUnits: number, now: string) {
  const proposal = proposalHash(blueprint)
  return generationBatchSchema.parse({
    batchId: batchId(run, proposal),
    proposalHash: proposal,
    revisionRound: run.revisionRound,
    submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS',
    pageCount: requirements.length,
    pages: requirements.map((requirement) => ({
      pageNumber: requirement.pageNumber,
      idempotencyKey: requirement.idempotencyKey,
      promptHash: hashInput(requirement.prompt),
    })),
    accounting: {
      estimatedUnits: requirements.length * unitBudgetUnits,
      committedUnits: 0,
      settledUnits: 0,
      releasedUnits: 0,
      reconciliationUnits: 0,
      authorization: 'PENDING',
      settlement: 'NOT_READY',
    },
    progress: { submitted: 0, completed: 0, failed: 0 },
    status: 'PREPARED',
    createdAt: now,
    updatedAt: now,
  })
}

export async function ensureGenerationBatch(input: Readonly<{
  repository: AgentRepository
  clock: ClockPort
  run: RunRecord
  blueprint: PresentationBlueprint
  requirements: readonly Requirement[]
  unitBudgetUnits: number
}>) {
  const key = generationBatchStepKey(input.run)
  const proposal = proposalHash(input.blueprint)
  return input.repository.transact(input.run.id, (transaction) => {
    const existing = transaction.getStep(key)
    if (existing) {
      if (existing.tool !== 'generate_image_batch' || existing.inputHash !== hashInput({
        proposalHash: proposal,
        unitBudgetUnits: input.unitBudgetUnits,
        pages: input.requirements.map((item) => ({ pageNumber: item.pageNumber, key: item.idempotencyKey, promptHash: hashInput(item.prompt) })),
      })) throw new Error('GENERATION_BATCH_IDEMPOTENCY_CONFLICT')
      return generationBatchSchema.parse(existing.output)
    }
    const now = input.clock.now().toISOString()
    const batch = initialBatch(input.run, input.blueprint, input.requirements, input.unitBudgetUnits, now)
    transaction.putStep({
      id: `step-${input.run.id}-generation-batch-r${input.run.revisionRound}`,
      runId: input.run.id,
      idempotencyKey: key,
      inputHash: hashInput({
        proposalHash: proposal,
        unitBudgetUnits: input.unitBudgetUnits,
        pages: input.requirements.map((item) => ({ pageNumber: item.pageNumber, key: item.idempotencyKey, promptHash: hashInput(item.prompt) })),
      }),
      tool: 'generate_image_batch',
      status: 'RUNNING',
      budgetUnits: batch.accounting.estimatedUnits,
      budgetReservationId: null,
      externalOperationId: null,
      errorCode: null,
      output: batch,
      createdAt: now,
      updatedAt: now,
    })
    transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'generation.batch.created',
      payload: batch,
    })
    return batch
  })
}

function terminalFailure(status: StepRecord['status']) {
  return ['FAILED', 'FAILED_NOT_CHARGED', 'FAILED_CHARGED', 'RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN', 'BILLING_UNKNOWN'].includes(status)
}

function batchFromSteps(batch: GenerationBatch, steps: readonly StepRecord[], now: string) {
  const byKey = new Map(steps.map((step) => [step.idempotencyKey, step]))
  let submitted = 0
  let completed = 0
  let failed = 0
  let reconciliationUnits = 0
  for (const page of batch.pages) {
    const step = byKey.get(page.idempotencyKey)
    if (!step) continue
    if (['SUBMITTING', 'WAITING', 'COMPLETED', 'COMPLETED_AFTER_CANCEL', 'FAILED_CHARGED', 'BILLING_UNKNOWN'].includes(step.status)) {
      submitted += 1
    }
    if (['COMPLETED', 'COMPLETED_AFTER_CANCEL'].includes(step.status)) {
      completed += 1
      continue
    }
    if (terminalFailure(step.status)) {
      failed += 1
      if (['RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN', 'BILLING_UNKNOWN'].includes(step.status)) {
        reconciliationUnits += step.budgetUnits
      }
      continue
    }
  }
  if (batch.accounting.authorization === 'UNKNOWN' || batch.accounting.settlement === 'UNKNOWN') {
    reconciliationUnits = Math.max(reconciliationUnits, batch.accounting.estimatedUnits)
  }
  const allTerminal = completed + failed === batch.pageCount
  const settlementFinished = ['SETTLED', 'RELEASED'].includes(batch.accounting.settlement)
  const hasUnknown = reconciliationUnits > 0 || (allTerminal && failed > 0 && !settlementFinished)
  return generationBatchSchema.parse({
    ...batch,
    accounting: {
      ...batch.accounting,
      reconciliationUnits,
    },
    progress: { submitted, completed, failed },
    status: settlementFinished ? 'COMPLETED' : hasUnknown ? 'RECONCILIATION_REQUIRED' : 'PROCESSING',
    updatedAt: now,
  })
}

export async function refreshGenerationBatch(input: Readonly<{
  repository: AgentRepository
  clock: ClockPort
  runId: string
  revisionRound: number
}>) {
  const key = `${input.runId}:generation-batch:r${input.revisionRound}`
  return input.repository.transact(input.runId, (transaction) => refreshGenerationBatchInTransaction(transaction, input.clock, key))
}

export function refreshGenerationBatchInTransaction(transaction: AgentTransaction, clock: ClockPort, key = generationBatchStepKey(transaction.run)) {
  const step = transaction.getStep(key)
  if (!step || step.tool !== 'generate_image_batch') return null
  const before = generationBatchSchema.parse(step.output)
  const next = batchFromSteps(before, transaction.listSteps(), clock.now().toISOString())
  if (JSON.stringify(before) === JSON.stringify(next)) return next
  const status = next.status === 'COMPLETED'
    ? 'COMPLETED'
    : next.accounting.authorization === 'UNKNOWN'
      ? 'RESERVATION_UNKNOWN'
      : next.accounting.settlement === 'UNKNOWN'
        ? 'BILLING_UNKNOWN'
        : 'RUNNING'
  transaction.putStep({
    ...step,
    status,
    output: next,
    updatedAt: next.updatedAt,
  })
  transaction.appendEvent({
    schemaVersion: CONTRACT_VERSION,
    type: 'generation.batch.updated',
    payload: next,
  })
  return next
}

export type GenerationBatchReservation = Readonly<{
  batchId: string
  reservationId: string
}>

type BatchFinalization = Readonly<{
  batch: GenerationBatch
  settledUnits: number
  releasedUnits: number
}>

function requireBatchStep(transaction: AgentTransaction, key: string) {
  const step = transaction.getStep(key)
  if (!step || step.tool !== 'generate_image_batch') throw new Error('GENERATION_BATCH_STEP_NOT_FOUND')
  return step
}

function updatedBatch(
  batch: GenerationBatch,
  accounting: GenerationBatch['accounting'],
  updatedAt: string,
  status = batch.status,
) {
  return generationBatchSchema.parse({ ...batch, accounting, status, updatedAt })
}

/**
 * The opaque host reservation belongs to the whole V4 batch. This operation
 * runs before any concurrent image submission and is safe to replay.
 */
export async function reserveGenerationBatch(input: Readonly<{
  repository: AgentRepository
  budget: BatchBudgetPort
  clock: ClockPort
  runId: string
  revisionRound: number
  model: string
}>): Promise<GenerationBatchReservation | null> {
  const key = `${input.runId}:generation-batch:r${input.revisionRound}`
  const prepared = await input.repository.transact(input.runId, (transaction) => {
    const step = requireBatchStep(transaction, key)
    const batch = generationBatchSchema.parse(step.output)
    if (step.budgetReservationId) {
      return { host: transaction.run.host, batch, reservationId: step.budgetReservationId }
    }
    if (step.status === 'FAILED' && batch.accounting.authorization !== 'REJECTED') return null
    const now = input.clock.now().toISOString()
    if (step.status !== 'RESERVED' && step.status !== 'RESERVATION_UNKNOWN') {
      const policy = reserveBudget(transaction.run, step.budgetUnits)
      const run = { ...transaction.run, ...policy, updatedAt: now }
      const next = updatedBatch(batch, {
        ...batch.accounting,
        committedUnits: step.budgetUnits,
        authorization: 'PENDING',
        settlement: 'NOT_READY',
      }, now)
      transaction.putRun(run)
      transaction.putStep({ ...step, status: 'RESERVED', output: next, updatedAt: now })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'budget.updated',
        payload: { budgetUnits: run.budgetUnits, committedBudgetUnits: run.committedBudgetUnits },
      })
      transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'generation.batch.updated', payload: next })
      return { host: run.host, batch: next, reservationId: null }
    }
    return { host: transaction.run.host, batch, reservationId: null }
  })
  if (!prepared) return null
  if (prepared.reservationId) return { batchId: prepared.batch.batchId, reservationId: prepared.reservationId }

  try {
    const reserved = await input.budget.reserveBatch({
      host: prepared.host,
      model: input.model,
      units: prepared.batch.accounting.estimatedUnits,
      batchId: prepared.batch.batchId,
      idempotencyKey: key,
    })
    return input.repository.transact(input.runId, (transaction) => {
      const step = requireBatchStep(transaction, key)
      const batch = generationBatchSchema.parse(step.output)
      const now = input.clock.now().toISOString()
      const next = updatedBatch(batch, {
        ...batch.accounting,
        committedUnits: step.budgetUnits,
        authorization: 'RESERVED',
        settlement: 'PENDING',
      }, now)
      transaction.putStep({
        ...step,
        status: 'RUNNING',
        budgetReservationId: reserved.reservationId,
        output: next,
        updatedAt: now,
      })
      transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'generation.batch.updated', payload: next })
      return { batchId: next.batchId, reservationId: reserved.reservationId }
    })
  } catch (error) {
    const errorCode = error instanceof BudgetReservationError ? error.code : 'BATCH_BUDGET_RESERVATION_UNKNOWN'
    const definitelyNotReserved = error instanceof BudgetReservationError && error.reservationState === 'NOT_RESERVED'
    await input.repository.transact(input.runId, (transaction) => {
      const step = requireBatchStep(transaction, key)
      const batch = generationBatchSchema.parse(step.output)
      const now = input.clock.now().toISOString()
      if (definitelyNotReserved) {
        const policy = releaseBudget(transaction.run, step.budgetUnits)
        const run = { ...transaction.run, ...policy, updatedAt: now }
        const next = updatedBatch(batch, {
          ...batch.accounting,
          committedUnits: 0,
          authorization: 'REJECTED',
          settlement: 'NOT_READY',
        }, now)
        transaction.putRun(run)
        transaction.putStep({ ...step, status: 'FAILED', errorCode, output: next, updatedAt: now })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'budget.updated',
          payload: { budgetUnits: run.budgetUnits, committedBudgetUnits: run.committedBudgetUnits },
        })
        transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'generation.batch.updated', payload: next })
        return
      }
      const next = updatedBatch(batch, {
        ...batch.accounting,
        authorization: 'UNKNOWN',
        reconciliationUnits: batch.accounting.estimatedUnits,
      }, now, 'RECONCILIATION_REQUIRED')
      transaction.putStep({ ...step, status: 'RESERVATION_UNKNOWN', errorCode, output: next, updatedAt: now })
      const recovery = beginTechnicalRecovery(transaction, input.clock, errorCode)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode, retryable: recovery?.technicalRecovery?.retryable ?? false },
      })
      transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'generation.batch.updated', payload: next })
    })
    return null
  }
}

/** Stops before any paid image submission when the host lacks atomic batch finalization. */
export async function preflightGenerationBatchFinalization(input: Readonly<{
  repository: AgentRepository
  budget: BatchBudgetPort
  clock: ClockPort
  runId: string
  revisionRound: number
}>): Promise<boolean> {
  const run = await input.repository.getRun(input.runId)
  if (!run) throw new Error('RUN_NOT_FOUND')
  try {
    await input.budget.preflightBatchFinalization({ host: run.host })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const errorCode = message.includes('AUTH') || message.includes('PERMISSION') || /HTTP_(401|403)/.test(message)
      ? 'BATCH_BUDGET_FINALIZATION_AUTH_FAILED'
      : message.includes('UNSUPPORTED') || /HTTP_(404|405|501)/.test(message)
        ? 'BATCH_BUDGET_FINALIZATION_UNSUPPORTED'
        : 'BATCH_BUDGET_FINALIZATION_UNKNOWN'
    await input.repository.transact(input.runId, (transaction) => {
      const step = requireBatchStep(transaction, `${input.runId}:generation-batch:r${input.revisionRound}`)
      const batch = generationBatchSchema.parse(step.output)
      const now = input.clock.now().toISOString()
      const next = updatedBatch(batch, {
        ...batch.accounting,
        authorization: 'REJECTED',
        settlement: 'NOT_READY',
      }, now)
      transaction.putStep({ ...step, status: 'FAILED', errorCode, output: next, updatedAt: now })
      const recovery = beginTechnicalRecovery(transaction, input.clock, errorCode)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode, retryable: recovery?.technicalRecovery?.retryable ?? false },
      })
      transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'generation.batch.updated', payload: next })
    })
    return false
  }
}

function batchFinalization(batch: GenerationBatch, steps: readonly StepRecord[]): BatchFinalization | null {
  const byKey = new Map(steps.map((step) => [step.idempotencyKey, step]))
  let settledUnits = 0
  let releasedUnits = 0
  for (const page of batch.pages) {
    const step = byKey.get(page.idempotencyKey)
    if (!step) return null
    if (['COMPLETED', 'COMPLETED_AFTER_CANCEL', 'FAILED_CHARGED'].includes(step.status)) {
      settledUnits += step.budgetUnits
      continue
    }
    if (['FAILED', 'FAILED_NOT_CHARGED'].includes(step.status)) {
      releasedUnits += step.budgetUnits
      continue
    }
    return null
  }
  if (settledUnits + releasedUnits !== batch.accounting.estimatedUnits) {
    throw new Error('GENERATION_BATCH_ACCOUNTING_ALLOCATION_INVALID')
  }
  return { batch, settledUnits, releasedUnits }
}

/** Finalizes one batch authorization with one atomic settle/release instruction. */
export async function finalizeGenerationBatch(input: Readonly<{
  repository: AgentRepository
  budget: BatchBudgetPort
  clock: ClockPort
  runId: string
  revisionRound: number
}>): Promise<boolean> {
  const key = `${input.runId}:generation-batch:r${input.revisionRound}`
  const pending = await input.repository.transact(input.runId, (transaction) => {
    const step = requireBatchStep(transaction, key)
    const batch = generationBatchSchema.parse(step.output)
    if (!step.budgetReservationId || ['SETTLED', 'RELEASED'].includes(batch.accounting.settlement)) return null
    const finalization = batchFinalization(batch, transaction.listSteps())
    return finalization ? {
      host: transaction.run.host,
      reservationId: step.budgetReservationId,
      ...finalization,
    } : null
  })
  if (!pending) {
    const run = await input.repository.getRun(input.runId)
    const batch = run ? await getGenerationBatch(input.repository, run) : null
    return batch?.accounting.settlement === 'SETTLED' || batch?.accounting.settlement === 'RELEASED'
  }
  try {
    await input.budget.finalizeBatch({
      host: pending.host,
      reservationId: pending.reservationId,
      batchId: pending.batch.batchId,
      settledUnits: pending.settledUnits,
      releasedUnits: pending.releasedUnits,
      idempotencyKey: `finalize:${key}`,
    })
  } catch {
    await input.repository.transact(input.runId, (transaction) => {
      const step = requireBatchStep(transaction, key)
      const batch = generationBatchSchema.parse(step.output)
      const now = input.clock.now().toISOString()
      const next = updatedBatch(batch, {
        ...batch.accounting,
        settlement: 'UNKNOWN',
        reconciliationUnits: batch.accounting.estimatedUnits,
      }, now, 'RECONCILIATION_REQUIRED')
      transaction.putStep({
        ...step,
        status: 'BILLING_UNKNOWN',
        errorCode: 'BATCH_BUDGET_FINALIZATION_UNKNOWN',
        output: next,
        updatedAt: now,
      })
      const recovery = beginTechnicalRecovery(transaction, input.clock, 'BATCH_BUDGET_FINALIZATION_UNKNOWN')
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: {
          stepId: step.id,
          errorCode: 'BATCH_BUDGET_FINALIZATION_UNKNOWN',
          retryable: recovery?.technicalRecovery?.retryable ?? false,
        },
      })
      transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'generation.batch.updated', payload: next })
    })
    return false
  }
  await input.repository.transact(input.runId, (transaction) => {
    const step = requireBatchStep(transaction, key)
    const batch = generationBatchSchema.parse(step.output)
    const now = input.clock.now().toISOString()
    const fullyReleased = pending.settledUnits === 0
    const next = updatedBatch(batch, {
      ...batch.accounting,
      committedUnits: pending.settledUnits,
      settledUnits: pending.settledUnits,
      releasedUnits: pending.releasedUnits,
      reconciliationUnits: 0,
      settlement: fullyReleased ? 'RELEASED' : 'SETTLED',
    }, now, 'COMPLETED')
    const run = pending.releasedUnits > 0
      ? { ...transaction.run, ...releaseBudget(transaction.run, pending.releasedUnits), updatedAt: now }
      : transaction.run
    if (pending.releasedUnits > 0) transaction.putRun(run)
    transaction.putStep({ ...step, status: 'COMPLETED', output: next, updatedAt: now })
    if (pending.releasedUnits > 0) {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'budget.updated',
        payload: { budgetUnits: run.budgetUnits, committedBudgetUnits: run.committedBudgetUnits },
      })
    }
    transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'generation.batch.updated', payload: next })
  })
  return true
}

export async function getGenerationBatch(repository: AgentRepository, run: RunRecord) {
  const step = (await repository.listSteps(run.id)).find((candidate) => candidate.idempotencyKey === generationBatchStepKey(run))
  return step?.tool === 'generate_image_batch' ? generationBatchSchema.parse(step.output) : null
}

export { generationBatchSchema, type GenerationBatch }

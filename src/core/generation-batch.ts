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
import { beginTechnicalRecovery, isTechnicalFailureCode } from './technical-recovery'

type Requirement = Readonly<{
  pageNumber: number
  idempotencyKey: string
  prompt: string
}>

export type GenerationBatchScope = 'INITIAL' | 'REVISION'

export type GenerationBatchIdentity = Readonly<{
  revisionRound: number
  scope: GenerationBatchScope
}>

export function generationBatchStepKey(run: Pick<RunRecord, 'id' | 'revisionRound'>) {
  return generationBatchStepKeyFor(run.id, { revisionRound: run.revisionRound, scope: 'INITIAL' })
}

export function generationBatchStepKeyFor(runId: string, identity: GenerationBatchIdentity) {
  return identity.scope === 'INITIAL'
    ? `${runId}:generation-batch:r${identity.revisionRound}`
    : `${runId}:revision-generation-batch:r${identity.revisionRound}`
}

export function generationBatchIdentityFromStepKey(runId: string, key: string): GenerationBatchIdentity | null {
  const initial = new RegExp(`^${escapeRegExp(runId)}:generation-batch:r(\\d+)$`).exec(key)
  if (initial) return { revisionRound: Number(initial[1]), scope: 'INITIAL' }
  const revision = new RegExp(`^${escapeRegExp(runId)}:revision-generation-batch:r(\\d+)$`).exec(key)
  if (revision) return { revisionRound: Number(revision[1]), scope: 'REVISION' }
  return null
}

function proposalHash(blueprint: PresentationBlueprint) {
  return hashInput(blueprint.visualDeckV4Proposal ?? blueprint)
}

function batchId(run: Pick<RunRecord, 'id'>, identity: GenerationBatchIdentity, proposal: string) {
  const input = identity.scope === 'INITIAL'
    ? { runId: run.id, revisionRound: identity.revisionRound, proposal }
    : { runId: run.id, ...identity, proposal }
  return `genbatch_${hashInput(input).slice(0, 32)}`
}

function initialBatch(
  run: RunRecord,
  identity: GenerationBatchIdentity,
  blueprint: PresentationBlueprint,
  requirements: readonly Requirement[],
  unitBudgetUnits: number,
  now: string,
) {
  const proposal = proposalHash(blueprint)
  return generationBatchSchema.parse({
    batchId: batchId(run, identity, proposal),
    proposalHash: proposal,
    revisionRound: identity.revisionRound,
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
  identity?: GenerationBatchIdentity
}>) {
  const identity = input.identity ?? { revisionRound: input.run.revisionRound, scope: 'INITIAL' as const }
  const key = generationBatchStepKeyFor(input.run.id, identity)
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
    const batch = initialBatch(input.run, identity, input.blueprint, input.requirements, input.unitBudgetUnits, now)
    transaction.putStep({
      id: `step-${input.run.id}-${identity.scope === 'INITIAL' ? 'generation-batch' : 'revision-generation-batch'}-r${identity.revisionRound}`,
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
    appendGenerationBatchEvent(transaction, 'generation.batch.created', batch, identity.scope === 'INITIAL')
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
  scope?: GenerationBatchScope
}>) {
  const key = generationBatchStepKeyFor(input.runId, {
    revisionRound: input.revisionRound,
    scope: input.scope ?? 'INITIAL',
  })
  return input.repository.transact(input.runId, (transaction) => refreshGenerationBatchInTransaction(
    transaction,
    input.clock,
    key,
    (input.scope ?? 'INITIAL') === 'INITIAL',
  ))
}

export function refreshGenerationBatchInTransaction(
  transaction: AgentTransaction,
  clock: ClockPort,
  key = generationBatchStepKey(transaction.run),
  publish = true,
) {
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
  appendGenerationBatchEvent(transaction, 'generation.batch.updated', next, publish)
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
  scope?: GenerationBatchScope
}>): Promise<GenerationBatchReservation | null> {
  const key = generationBatchStepKeyFor(input.runId, {
    revisionRound: input.revisionRound,
    scope: input.scope ?? 'INITIAL',
  })
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
      appendGenerationBatchEvent(transaction, 'generation.batch.updated', next, (input.scope ?? 'INITIAL') === 'INITIAL')
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
      appendGenerationBatchEvent(transaction, 'generation.batch.updated', next, (input.scope ?? 'INITIAL') === 'INITIAL')
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
        appendGenerationBatchEvent(transaction, 'generation.batch.updated', next, (input.scope ?? 'INITIAL') === 'INITIAL')
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
      appendGenerationBatchEvent(transaction, 'generation.batch.updated', next, (input.scope ?? 'INITIAL') === 'INITIAL')
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
  scope?: GenerationBatchScope
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
      const step = requireBatchStep(transaction, generationBatchStepKeyFor(input.runId, {
        revisionRound: input.revisionRound,
        scope: input.scope ?? 'INITIAL',
      }))
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
      appendGenerationBatchEvent(transaction, 'generation.batch.updated', next, (input.scope ?? 'INITIAL') === 'INITIAL')
    })
    return false
  }
}

function batchFinalization(batch: GenerationBatch, steps: readonly StepRecord[], run: RunRecord): BatchFinalization | null {
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
    if (step.status === 'FAILED' && run.technicalRecovery?.active && isTechnicalFailureCode(step.errorCode ?? '')) {
      // The existing authorization remains valid while the stable image key is
      // being retried. Releasing it here would make recovery submit against a
      // finalized host reservation.
      return null
    }
    if (['FAILED', 'FAILED_NOT_CHARGED'].includes(step.status)) {
      releasedUnits += step.budgetUnits
      continue
    }
    if (step.status === 'SUBMISSION_UNKNOWN') {
      // A submission acknowledgement was lost. Its original image key must be
      // reconciled before an atomic batch can be settled or released.
      return null
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
  scope?: GenerationBatchScope
}>): Promise<boolean> {
  const key = generationBatchStepKeyFor(input.runId, {
    revisionRound: input.revisionRound,
    scope: input.scope ?? 'INITIAL',
  })
  const pending = await input.repository.transact(input.runId, (transaction) => {
    const step = requireBatchStep(transaction, key)
    const batch = generationBatchSchema.parse(step.output)
    if (!step.budgetReservationId || ['SETTLED', 'RELEASED'].includes(batch.accounting.settlement)) return null
    const finalization = batchFinalization(batch, transaction.listSteps(), transaction.run)
    return finalization ? {
      host: transaction.run.host,
      reservationId: step.budgetReservationId,
      ...finalization,
    } : null
  })
  if (!pending) {
    const run = await input.repository.getRun(input.runId)
    const batch = run ? await getGenerationBatch(input.repository, run, {
      revisionRound: input.revisionRound,
      scope: input.scope ?? 'INITIAL',
    }) : null
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
      appendGenerationBatchEvent(transaction, 'generation.batch.updated', next, (input.scope ?? 'INITIAL') === 'INITIAL')
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
    appendGenerationBatchEvent(transaction, 'generation.batch.updated', next, (input.scope ?? 'INITIAL') === 'INITIAL')
  })
  return true
}

export async function getGenerationBatch(
  repository: AgentRepository,
  run: RunRecord,
  identity?: GenerationBatchIdentity,
) {
  const step = (await repository.listSteps(run.id)).find((candidate) => identity
    ? candidate.idempotencyKey === generationBatchStepKeyFor(run.id, identity)
    : candidate.idempotencyKey.startsWith(`${run.id}:generation-batch:r`))
  return step?.tool === 'generate_image_batch' ? generationBatchSchema.parse(step.output) : null
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function appendGenerationBatchEvent(
  transaction: AgentTransaction,
  type: 'generation.batch.created' | 'generation.batch.updated',
  batch: GenerationBatch,
  publish: boolean,
) {
  if (!publish) return
  transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type, payload: batch })
}

export { generationBatchSchema, type GenerationBatch }

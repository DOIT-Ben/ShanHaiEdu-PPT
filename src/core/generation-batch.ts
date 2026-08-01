import { CONTRACT_VERSION } from '../contracts'
import { generationBatchSchema, type GenerationBatch } from '../generation-batch-contracts'
import type { PresentationBlueprint } from '../presentation-contracts'
import { hashInput } from './hash'
import type { AgentRepository, AgentTransaction, ClockPort, RunRecord, StepRecord } from './ports'

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
  let committedUnits = 0
  let settledUnits = 0
  let releasedUnits = 0
  let reconciliationUnits = 0
  for (const page of batch.pages) {
    const step = byKey.get(page.idempotencyKey)
    if (!step) continue
    if (['SUBMITTING', 'WAITING', 'COMPLETED', 'COMPLETED_AFTER_CANCEL', 'FAILED_CHARGED', 'BILLING_UNKNOWN'].includes(step.status)) {
      submitted += 1
    }
    if (['COMPLETED', 'COMPLETED_AFTER_CANCEL'].includes(step.status)) {
      completed += 1
      committedUnits += step.budgetUnits
      settledUnits += step.budgetUnits
      continue
    }
    if (terminalFailure(step.status)) {
      failed += 1
      if (step.status === 'FAILED_CHARGED') {
        committedUnits += step.budgetUnits
        settledUnits += step.budgetUnits
      } else if (['RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN', 'BILLING_UNKNOWN'].includes(step.status)) {
        committedUnits += step.budgetUnits
        reconciliationUnits += step.budgetUnits
      } else {
        releasedUnits += step.budgetUnits
      }
      continue
    }
    if (['RESERVED', 'SUBMITTING', 'WAITING', 'RELEASING'].includes(step.status)) committedUnits += step.budgetUnits
  }
  const hasUnknown = reconciliationUnits > 0
  const finished = completed + failed === batch.pageCount
  return generationBatchSchema.parse({
    ...batch,
    accounting: {
      estimatedUnits: batch.accounting.estimatedUnits,
      committedUnits,
      settledUnits,
      releasedUnits,
      reconciliationUnits,
    },
    progress: { submitted, completed, failed },
    status: hasUnknown ? 'RECONCILIATION_REQUIRED' : finished ? 'COMPLETED' : 'PROCESSING',
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
  transaction.putStep({
    ...step,
    status: next.status === 'COMPLETED' ? 'COMPLETED' : 'RUNNING',
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

export async function getGenerationBatch(repository: AgentRepository, run: RunRecord) {
  const step = (await repository.listSteps(run.id)).find((candidate) => candidate.idempotencyKey === generationBatchStepKey(run))
  return step?.tool === 'generate_image_batch' ? generationBatchSchema.parse(step.output) : null
}

export { generationBatchSchema, type GenerationBatch }

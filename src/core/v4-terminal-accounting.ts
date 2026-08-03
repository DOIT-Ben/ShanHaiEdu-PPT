import { generationBatchSchema } from '../generation-batch-contracts'
import {
  terminalAccountingSchema,
  type TerminalAccounting,
} from '../terminal-accounting-contracts'
import type { RunRecord, StepRecord } from './ports'

export { terminalAccountingSchema, type TerminalAccounting }

const SUBMITTED_STATUSES = new Set<StepRecord['status']>([
  'SUBMITTING', 'WAITING', 'COMPLETED', 'COMPLETED_AFTER_CANCEL', 'FAILED_CHARGED', 'BILLING_UNKNOWN',
])

const TERMINAL_PAGE_STATUSES = new Set<StepRecord['status']>([
  'COMPLETED', 'COMPLETED_AFTER_CANCEL', 'FAILED', 'FAILED_NOT_CHARGED', 'FAILED_CHARGED',
])

const LEGACY_SETTLED_PAGE_STATUSES = new Set<StepRecord['status']>([
  'COMPLETED', 'COMPLETED_AFTER_CANCEL', 'FAILED_CHARGED',
])

function isDefinitivePreflightRejection(step: StepRecord, batch: ReturnType<typeof generationBatchSchema.parse>) {
  return step.status === 'FAILED'
    && step.budgetReservationId === null
    && step.externalOperationId === null
    && batch.status === 'COMPLETED'
    && batch.accounting.authorization === 'REJECTED'
    && batch.accounting.settlement === 'RELEASED'
    && batch.accounting.committedUnits === 0
    && batch.accounting.settledUnits === 0
    && batch.accounting.releasedUnits === batch.accounting.estimatedUnits
    && batch.accounting.reconciliationUnits === 0
    && batch.progress.submitted === 0
    && batch.progress.completed === 0
    && batch.progress.failed === batch.pageCount
}

/** Reduces each durable V4 batch once and associates media only through batch page keys. */
export function deriveV4TerminalAccounting(
  run: Pick<RunRecord, 'id' | 'budgetUnits' | 'committedBudgetUnits'>,
  steps: readonly StepRecord[],
): TerminalAccounting {
  const imageSteps = steps.filter((step) => step.runId === run.id && step.tool === 'generate_slide_image')
  const imagesByKey = new Map(imageSteps.map((step) => [step.idempotencyKey, step]))
  const referencedImageKeys = new Set<string>()
  let submittedUnits = 0
  let settledUnits = 0
  let reconciliationUnits = 0
  let final = true

  const batchSteps = steps.filter((step) => step.runId === run.id && step.tool === 'generate_image_batch')
  for (const batchStep of batchSteps) {
    const parsed = generationBatchSchema.safeParse(batchStep.output)
    if (!parsed.success) {
      final = false
      reconciliationUnits += batchStep.budgetUnits
      continue
    }
    const batch = parsed.data
    if (isDefinitivePreflightRejection(batchStep, batch)) continue
    settledUnits += batch.accounting.settledUnits
    reconciliationUnits += batch.accounting.reconciliationUnits
    if (batchStep.status !== 'COMPLETED'
      || batch.status !== 'COMPLETED'
      || !['SETTLED', 'RELEASED'].includes(batch.accounting.settlement)) {
      final = false
    }
    const estimatedPageUnits = Math.max(1, Math.ceil(batch.accounting.estimatedUnits / batch.pageCount))
    for (const page of batch.pages) {
      if (referencedImageKeys.has(page.idempotencyKey)) {
        final = false
        reconciliationUnits += estimatedPageUnits
        continue
      }
      referencedImageKeys.add(page.idempotencyKey)
      const imageStep = imagesByKey.get(page.idempotencyKey)
      if (!imageStep) {
        final = false
        reconciliationUnits += estimatedPageUnits
        continue
      }
      if (SUBMITTED_STATUSES.has(imageStep.status)) submittedUnits += imageStep.budgetUnits
      if (!TERMINAL_PAGE_STATUSES.has(imageStep.status)) {
        final = false
        reconciliationUnits += imageStep.budgetUnits
      }
    }
  }

  if (batchSteps.length === 0) {
    for (const imageStep of imageSteps) {
      if (SUBMITTED_STATUSES.has(imageStep.status)) submittedUnits += imageStep.budgetUnits
      if (LEGACY_SETTLED_PAGE_STATUSES.has(imageStep.status)) settledUnits += imageStep.budgetUnits
      if (!TERMINAL_PAGE_STATUSES.has(imageStep.status)) {
        final = false
        reconciliationUnits += imageStep.budgetUnits
      }
    }
  } else {
    for (const imageStep of imageSteps) {
      if (referencedImageKeys.has(imageStep.idempotencyKey)) continue
      final = false
      reconciliationUnits += imageStep.budgetUnits
    }
  }

  const commitmentDifference = Math.abs(settledUnits - run.committedBudgetUnits)
  if (commitmentDifference > 0) {
    final = false
    reconciliationUnits += commitmentDifference
  }
  if (settledUnits > run.budgetUnits) {
    final = false
    reconciliationUnits += settledUnits - run.budgetUnits
  }

  const releasedUnits = Math.max(0, run.budgetUnits - settledUnits)
  const accountingStatus = final && reconciliationUnits === 0
    && settledUnits + releasedUnits === run.budgetUnits
    ? 'FINAL' as const
    : 'RECONCILIATION_REQUIRED' as const

  return terminalAccountingSchema.parse({
    authorizedUnits: run.budgetUnits,
    submittedUnits,
    settledUnits,
    releasedUnits,
    reconciliationUnits,
    accountingStatus,
  })
}

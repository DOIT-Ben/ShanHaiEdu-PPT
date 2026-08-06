import { describe, expect, test } from 'bun:test'
import { generationBatchStepKeyFor } from '../src/core/generation-batch'
import type { RunRecord, StepRecord, StepStatus } from '../src/core/ports'
import {
  deriveV4TerminalAccounting,
  terminalAccountingSchema,
} from '../src/core/v4-terminal-accounting'

const timestamp = '2026-08-03T00:00:00.000Z'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-run-1', requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '用于验证终态账务聚合的完整教材内容。'.repeat(3) },
    slideCount: 12, visualDirection: '清晰课堂视觉', imageModel: 'gpt-image-2',
    automationLevel: 'BOUNDED_AUTO', presentationMode: 'VISUAL_DECK_V4',
    maxRevisionRounds: 2, revisionRound: 2, qualityScore: 72,
    status: 'DECK_REVIEW', resumeState: null, version: 10,
    budgetUnits: 36, committedBudgetUnits: 15,
    qualityOverride: false, qualityOverrideReason: null, qualityOverrideBy: null,
    leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: timestamp, updatedAt: timestamp,
    ...overrides,
  }
}

function imageStep(pageNumber: number, revisionRound: number, status: StepStatus = 'COMPLETED'): StepRecord {
  const key = `run-1:slide:${pageNumber}:image:r${revisionRound}:v1`
  return {
    id: `step-image-r${revisionRound}-p${pageNumber}`, runId: 'run-1', idempotencyKey: key,
    inputHash: `hash-r${revisionRound}-p${pageNumber}`, tool: 'generate_slide_image', status,
    budgetUnits: 1, budgetReservationId: `reservation-${key}`, externalOperationId: `operation-${key}`,
    errorCode: status === 'COMPLETED' ? null : 'TEST_PENDING', output: {},
    createdAt: timestamp, updatedAt: timestamp,
  }
}

function completedBatch(revisionRound: number, scope: 'INITIAL' | 'REVISION', pageNumbers: readonly number[]): StepRecord {
  const key = generationBatchStepKeyFor('run-1', { revisionRound, scope })
  const suffix = scope === 'INITIAL' ? 'a' : revisionRound === 1 ? 'b' : 'c'
  return {
    id: `step-batch-${scope.toLowerCase()}-r${revisionRound}`,
    runId: 'run-1', idempotencyKey: key, inputHash: `batch-hash-${scope}-${revisionRound}`,
    tool: 'generate_image_batch', status: 'COMPLETED', budgetUnits: pageNumbers.length,
    budgetReservationId: `batch-reservation-${scope}-${revisionRound}`,
    externalOperationId: null, errorCode: null,
    output: {
      batchId: `genbatch_${suffix.repeat(32)}`,
      proposalHash: suffix.repeat(64),
      revisionRound,
      submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS',
      pageCount: pageNumbers.length,
      pages: pageNumbers.map((actualPageNumber, index) => ({
        pageNumber: index + 1,
        idempotencyKey: `run-1:slide:${actualPageNumber}:image:r${revisionRound}:v1`,
        promptHash: String(actualPageNumber % 10).repeat(64),
      })),
      accounting: {
        estimatedUnits: pageNumbers.length,
        committedUnits: pageNumbers.length,
        settledUnits: pageNumbers.length,
        releasedUnits: 0,
        reconciliationUnits: 0,
        authorization: 'RESERVED',
        settlement: 'SETTLED',
      },
      progress: { submitted: pageNumbers.length, completed: pageNumbers.length, failed: 0 },
      status: 'COMPLETED',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function completedSteps(): StepRecord[] {
  const initialPages = Array.from({ length: 12 }, (_, index) => index + 1)
  return [
    completedBatch(0, 'INITIAL', initialPages),
    ...initialPages.map((pageNumber) => imageStep(pageNumber, 0)),
    completedBatch(1, 'REVISION', [3, 5]),
    imageStep(3, 1),
    imageStep(5, 1),
    completedBatch(2, 'REVISION', [10]),
    imageStep(10, 2),
  ]
}

describe('v4 terminal accounting', () => {
  test('aggregates initial and revision batches exactly once', () => {
    const accounting = deriveV4TerminalAccounting(run(), completedSteps())

    expect(accounting).toEqual({
      authorizedUnits: 36,
      submittedUnits: 15,
      settledUnits: 15,
      releasedUnits: 21,
      reconciliationUnits: 0,
      accountingStatus: 'FINAL',
    })
    expect(terminalAccountingSchema.parse(accounting)).toEqual(accounting)
  })

  test('normalizes a legacy unbatched v4 run from definitive page accounting', () => {
    const initialPages = Array.from({ length: 12 }, (_, index) => index + 1)
    const legacySteps = [
      ...initialPages.map((pageNumber) => imageStep(pageNumber, 0)),
      imageStep(3, 1),
      imageStep(5, 1),
      imageStep(10, 2),
    ]

    expect(deriveV4TerminalAccounting(run(), legacySteps)).toEqual({
      authorizedUnits: 36,
      submittedUnits: 15,
      settledUnits: 15,
      releasedUnits: 21,
      reconciliationUnits: 0,
      accountingStatus: 'FINAL',
    })
  })

  test.each([
    ['active page', (steps: StepRecord[]) => {
      const index = steps.findIndex((step) => step.id === 'step-image-r2-p10')
      steps[index] = { ...steps[index]!, status: 'WAITING' }
    }],
    ['missing page', (steps: StepRecord[]) => {
      steps.splice(steps.findIndex((step) => step.id === 'step-image-r2-p10'), 1)
    }],
    ['submission unknown', (steps: StepRecord[]) => {
      const index = steps.findIndex((step) => step.id === 'step-image-r2-p10')
      steps[index] = { ...steps[index]!, status: 'SUBMISSION_UNKNOWN' }
    }],
    ['billing unknown', (steps: StepRecord[]) => {
      const index = steps.findIndex((step) => step.id === 'step-image-r2-p10')
      steps[index] = { ...steps[index]!, status: 'BILLING_UNKNOWN' }
    }],
    ['unbatched image', (steps: StepRecord[]) => {
      steps.push(imageStep(11, 2))
    }],
  ] as const)('refuses FINAL accounting for %s', (_label, mutate) => {
    const steps = completedSteps()
    mutate(steps)

    expect(deriveV4TerminalAccounting(run(), steps)).toMatchObject({
      accountingStatus: 'RECONCILIATION_REQUIRED',
    })
  })

  test('refuses FINAL accounting when batch settlement disagrees with the Run commitment', () => {
    expect(deriveV4TerminalAccounting(run({ committedBudgetUnits: 14 }), completedSteps())).toMatchObject({
      settledUnits: 15,
      accountingStatus: 'RECONCILIATION_REQUIRED',
    })
  })
})

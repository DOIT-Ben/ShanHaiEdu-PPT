import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockBudgetPort } from '../src/adapters/mock-ports'
import {
  ensureGenerationBatch,
  finalizeGenerationBatch,
  preflightGenerationBatchFinalization,
  reserveGenerationBatch,
  type GenerationBatchIdentity,
} from '../src/core/generation-batch'
import type { RunRecord, StepRecord } from '../src/core/ports'
import { presentationBlueprintSchema } from '../src/presentation-contracts'

const createdAt = '2026-08-03T07:00:00.000Z'

function run(identity: GenerationBatchIdentity): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-1', requestHash: 'request-1',
    host: { tenantId: 'frameflow', externalUserId: 'teacher-1' },
    source: { kind: 'TEXT', text: '这是用于 Usage V2 批次归约测试的完整教材内容。' },
    slideCount: 2, visualDirection: '课堂信息图', imageModel: identity.scope === 'INITIAL' ? 'nanobanana' : 'image-2',
    accountingProtocol: 'FRAMEFLOW_USAGE_V2', automationLevel: 'BOUNDED_AUTO', presentationMode: 'VISUAL_DECK_V4',
    maxRevisionRounds: 2, revisionRound: identity.revisionRound, qualityScore: null,
    status: identity.scope === 'INITIAL' ? 'EXECUTING' : 'REVISING', resumeState: null,
    version: 0, budgetUnits: 30, committedBudgetUnits: 0, qualityOverride: false,
    qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt, updatedAt: createdAt,
  }
}

function blueprint() {
  return presentationBlueprintSchema.parse({
    id: 'blueprint-1', title: '百分数', visualDirection: '课堂信息图', createdAt,
    sourceManifest: [], sourceAssets: [],
    curriculum: {
      subject: '数学', grade: '六年级', lessonTitle: '认识百分数',
      sourceSummary: '本节课通过生活情境帮助学生理解百分数的意义与表达方式。',
      learningObjectives: ['理解百分数'], scopeBoundaries: ['教材范围'], prohibitedExtensions: [],
      sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber, title: `第 ${pageNumber} 页`, body: ['教材内容'], layout: 'HERO',
      visualIntent: '用清晰的课堂信息图表达百分数概念',
      visualPrompt: `A classroom percentage visual for page ${pageNumber}, no text`,
      sourceChunkIds: ['chunk-1'],
    })),
  })
}

function requirements(identity: GenerationBatchIdentity) {
  return [1, 2].map((pageNumber) => ({
    pageNumber,
    idempotencyKey: identity.scope === 'INITIAL'
      ? `run-1:slide:${pageNumber}:image:r${identity.revisionRound}:v1`
      : `run-1:slide:${pageNumber}:image:r${identity.revisionRound}:v1:edit:0123456789abcdef01234567`,
    prompt: `A classroom percentage visual for page ${pageNumber}, no text`,
  }))
}

function observedStep(input: Readonly<{
  identity: GenerationBatchIdentity
  batchId: string
  pageNumber: number
  operationKey: string
  status: StepRecord['status']
}>): StepRecord {
  const operationId = `provider-${input.pageNumber}`
  return {
    id: `usage-${input.pageNumber}`, runId: 'run-1',
    idempotencyKey: `run-1:usage-v2:event:observed-${input.pageNumber}`,
    inputHash: `usage-hash-${input.pageNumber}`, tool: 'report_usage_v2', status: input.status,
    budgetUnits: 0, budgetReservationId: null, externalOperationId: operationId, errorCode: null,
    output: {
      deliveryState: input.status === 'COMPLETED' ? 'ACKNOWLEDGED' : 'PENDING',
      nextAttemptAt: null, billStatus: input.status === 'COMPLETED' ? 'ACTIVE' : null,
      event: {
        schemaVersion: '2', eventId: `observed-${input.pageNumber}`, sequence: input.pageNumber,
        eventType: 'OPERATION_OBSERVED', pptRunId: 'run-1', batchId: input.batchId,
        pageNumber: input.pageNumber, revisionRound: input.identity.revisionRound,
        idempotencyKey: input.operationKey, providerOperationId: operationId,
        model: input.identity.scope === 'INITIAL' ? 'nanobanana' : 'image-2', status: 'COMPLETED',
        providerBilling: {
          result: 'CHARGED', actualCostAmountMicros: 25_000, currency: 'USD', pricingVersion: 'provider-v1',
        },
        operationCreatedAt: createdAt, operationCompletedAt: createdAt, eventAt: createdAt,
      },
    },
    createdAt, updatedAt: createdAt,
  }
}

async function fixture(identity: GenerationBatchIdentity) {
  const repository = new InMemoryAgentRepository()
  const clock = new FixedClock(new Date(createdAt))
  const budget = new MockBudgetPort()
  const runRecord = run(identity)
  const batchRequirements = requirements(identity)
  await repository.createRun(runRecord)
  const batch = await ensureGenerationBatch({
    repository, clock, run: runRecord, blueprint: blueprint(), requirements: batchRequirements,
    unitBudgetUnits: 5, accountingModel: runRecord.imageModel,
    operationMode: identity.scope === 'INITIAL' ? 'TEXT_TO_IMAGE' : 'IMAGE_EDIT', identity,
  })
  return { repository, clock, budget, runRecord, batch, batchRequirements }
}

describe('Usage V2 generation batch reducer', () => {
  for (const identity of [
    { revisionRound: 0, scope: 'INITIAL' as const },
    { revisionRound: 1, scope: 'REVISION' as const },
  ]) {
    test(`keeps ${identity.scope.toLowerCase()} batches local and waits for acknowledged Usage events`, async () => {
      const { repository, clock, budget, batch, batchRequirements } = await fixture(identity)
      budget.nextBatchFinalizationPreflightFailure = new Error('OLD_PREFLIGHT_MUST_NOT_RUN')

      await expect(preflightGenerationBatchFinalization({
        repository, budget, clock, runId: 'run-1', revisionRound: identity.revisionRound, scope: identity.scope,
      })).resolves.toBe(true)
      const reservation = await reserveGenerationBatch({
        repository, budget, clock, runId: 'run-1', revisionRound: identity.revisionRound, scope: identity.scope,
      })

      expect(reservation).toEqual({ batchId: batch.batchId, reservationId: `usage-v2:${batch.batchId}` })
      expect(budget.batchReservationRequests).toHaveLength(0)
      expect((await repository.getRun('run-1'))?.committedBudgetUnits).toBe(10)

      await repository.transact('run-1', (transaction) => {
        for (const requirement of batchRequirements) {
          const pageNumber = requirement.pageNumber
          const operationId = `provider-${pageNumber}`
          transaction.putStep({
            id: `image-${pageNumber}`, runId: 'run-1', idempotencyKey: requirement.idempotencyKey,
            inputHash: `image-hash-${pageNumber}`, tool: 'generate_slide_image', status: 'COMPLETED',
            budgetUnits: 5, budgetReservationId: reservation!.reservationId, externalOperationId: operationId,
            errorCode: null, output: { artifactId: `artifact-${pageNumber}` }, createdAt, updatedAt: createdAt,
          })
          transaction.putStep(observedStep({
            identity, batchId: batch.batchId, pageNumber, operationKey: requirement.idempotencyKey,
            status: pageNumber === 1 ? 'RUNNING' : 'COMPLETED',
          }))
        }
      })

      await expect(finalizeGenerationBatch({
        repository, budget, clock, runId: 'run-1', revisionRound: identity.revisionRound, scope: identity.scope,
      })).resolves.toBe(false)
      expect(budget.batchFinalizationAttempts).toHaveLength(0)

      await repository.transact('run-1', (transaction) => {
        const pending = transaction.getStep('run-1:usage-v2:event:observed-1')!
        transaction.putStep({
          ...pending, status: 'COMPLETED',
          output: { ...(pending.output as object), deliveryState: 'ACKNOWLEDGED', billStatus: 'ACTIVE' },
        })
      })

      await expect(finalizeGenerationBatch({
        repository, budget, clock, runId: 'run-1', revisionRound: identity.revisionRound, scope: identity.scope,
      })).resolves.toBe(true)
      expect(budget.batchFinalizationAttempts).toHaveLength(0)
      expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 10 })
      expect((await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch'))
        .toMatchObject({ status: 'COMPLETED', output: { accounting: {
          authorization: 'RESERVED', settlement: 'SETTLED', settledUnits: 10, releasedUnits: 0,
          reconciliationUnits: 0,
        } } })
    })
  }
})

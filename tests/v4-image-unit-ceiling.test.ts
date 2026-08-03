import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { ensureGenerationBatch } from '../src/core/generation-batch'
import type { RunRecord } from '../src/core/ports'
import type { PresentationBlueprint } from '../src/presentation-contracts'

function run(): RunRecord {
  return {
    id: 'run-10-pages', creationKey: 'create-10-pages', requestHash: 'hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '十页课件计费上限测试材料。'.repeat(5) },
    slideCount: 10, visualDirection: '课堂信息图', imageModel: 'nano-banana-pro',
    presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO',
    maxRevisionRounds: 2, revisionRound: 0, qualityScore: null, status: 'EXECUTING', resumeState: null,
    version: 1, budgetUnits: 30, committedBudgetUnits: 0, qualityOverride: false,
    qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z',
  }
}

const blueprint = {
  id: 'blueprint-10-pages',
  visualDeckV4Proposal: { identity: 'proposal-10-pages' },
} as unknown as PresentationBlueprint

function requirements(round: number, edit: boolean) {
  return Array.from({ length: 10 }, (_, index) => ({
    pageNumber: index + 1,
    idempotencyKey: edit
      ? `run-10-pages:slide:${index + 1}:image:r${round}:v1:edit:${String(index + 1).padStart(24, '0')}`
      : `run-10-pages:slide:${index + 1}:image:r0:v1`,
    prompt: `page ${index + 1} round ${round}`,
  }))
}

describe('V4 image-unit ceiling', () => {
  test('ten initial Nano pages plus two complete GPT edit rounds allocate exactly 30 image units', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    const initialRun = run()
    await repository.createRun(initialRun)

    await ensureGenerationBatch({
      repository, clock, run: initialRun, blueprint, requirements: requirements(0, false),
      unitBudgetUnits: 1, accountingModel: 'nano-banana-pro', operationMode: 'TEXT_TO_IMAGE',
      identity: { revisionRound: 0, scope: 'INITIAL' },
    })
    for (const revisionRound of [1, 2]) {
      await ensureGenerationBatch({
        repository, clock, run: { ...initialRun, revisionRound }, blueprint,
        requirements: requirements(revisionRound, true), unitBudgetUnits: 1,
        accountingModel: 'image-2', operationMode: 'IMAGE_EDIT',
        identity: { revisionRound, scope: 'REVISION' },
      })
    }

    const batches = (await repository.listSteps(initialRun.id)).filter((step) => step.tool === 'generate_image_batch')
    expect(batches).toHaveLength(3)
    expect(batches.reduce((total, step) => total + step.budgetUnits, 0)).toBe(30)
    expect(batches.map((step) => step.output)).toEqual([
      expect.objectContaining({ accountingModel: 'nano-banana-pro', operationMode: 'TEXT_TO_IMAGE' }),
      expect.objectContaining({ accountingModel: 'image-2', operationMode: 'IMAGE_EDIT' }),
      expect.objectContaining({ accountingModel: 'image-2', operationMode: 'IMAGE_EDIT' }),
    ])
  })
})

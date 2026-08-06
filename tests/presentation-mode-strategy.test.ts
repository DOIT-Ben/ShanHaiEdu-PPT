import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { getPresentationModeStrategy, listPresentationModeStrategies } from '../src/core/presentation-mode-strategy'
import { RunService } from '../src/core/run-service'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'

describe('presentation mode strategy', () => {
  test('registers every supported mode with an explicit planning, asset, delivery, and execution policy', () => {
    expect(listPresentationModeStrategies()).toEqual([
      {
        mode: 'SLIDE_IMAGE_V2', planningKind: 'BLUEPRINT', assetModel: 'SLIDE_BACKGROUND',
        deliveryModel: 'EDITABLE_TEXT_OVER_RASTER', executionAvailability: 'AVAILABLE',
      },
      {
        mode: 'SLIDE_IMAGE_V2_1', planningKind: 'BLUEPRINT_WITH_REFLECTION', assetModel: 'SLIDE_BACKGROUND',
        deliveryModel: 'EDITABLE_TEXT_OVER_RASTER', executionAvailability: 'AVAILABLE',
      },
      {
        mode: 'LAYERED_COURSEWARE_V3', planningKind: 'BLUEPRINT', assetModel: 'LAYERED_ELEMENTS',
        deliveryModel: 'EDITABLE_LAYERED_PPTX', executionAvailability: 'AVAILABLE',
      },
      {
        mode: 'VISUAL_DECK_V4', planningKind: 'VISUAL_DECK_COMPILER', assetModel: 'COMPLETE_SLIDE_RASTER',
        deliveryModel: 'RASTER_SLIDES_IN_PPTX', executionAvailability: 'AVAILABLE',
      },
    ])
    expect(getPresentationModeStrategy('VISUAL_DECK_V4').planningKind).toBe('VISUAL_DECK_COMPILER')
  })

  test('allows an approved v4 proposal to enter its registered execution path', async () => {
    const repository = new InMemoryAgentRepository()
    const service = new RunService({ repository, clock: new FixedClock() })
    const request = {
      schemaVersion: CONTRACT_VERSION,
      host: { tenantId: 'frameflow', externalUserId: 'user-v4' },
      source: { kind: 'TEXT', name: '教材.txt', text: '这是用于验证V4执行隔离的教材内容。'.repeat(4) },
      slideCount: 12,
      visualDirection: '资料驱动的叙事型视觉幻灯片',
      imageModel: 'gpt-image-2',
      automationLevel: 'SUPERVISED',
      budgetUnits: 100,
      presentationMode: 'VISUAL_DECK_V4',
      visualDeckV4: {
        instruction: '根据教材制作一套12页的资料驱动视觉演示',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: {
          deckType: 'DETAILED_DECK',
          language: 'zh-CN',
          length: { slideCount: 12 },
          aspectRatio: '16:9',
          focus: '教材核心概念',
        },
      },
    } as const
    const created = await service.create(request, 'create-v4-strategy-0001')
    const blueprint = createVisualDeckV4Blueprint({
      runId: created.run.id,
      inputHash: 'v4-plan-hash',
      source: request.source,
      document: {
        name: request.source.name,
        chunks: [{ id: 'chunk-1', text: request.source.text, sha256: 'a'.repeat(64) }],
        isComplete: true,
        missingRanges: [],
      },
      config: {
        ...request.visualDeckV4,
        deckOptions: request.visualDeckV4.deckOptions,
      },
      slideCount: request.slideCount,
      visualDirection: request.visualDirection,
      createdAt: '2026-07-30T00:00:00.000Z',
    })
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
      transaction.putStep({
        id: 'step-v4-plan', runId: created.run.id, idempotencyKey: `${created.run.id}:blueprint:v1`,
        inputHash: 'v4-plan-hash', tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: blueprint,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    })

    const approved = await service.act(created.run.id, request.host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'APPROVE_BLUEPRINT',
      expectedVersion: 1,
    }, 'approve-v4-strategy-0001')
    expect(approved.status).toBe('EXECUTING')
  })
})

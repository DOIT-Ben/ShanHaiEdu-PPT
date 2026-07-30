import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { getPresentationModeStrategy, listPresentationModeStrategies } from '../src/core/presentation-mode-strategy'
import { RunService } from '../src/core/run-service'

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
        deliveryModel: 'RASTER_SLIDES_IN_PPTX', executionAvailability: 'NOT_IMPLEMENTED',
      },
    ])
    expect(getPresentationModeStrategy('VISUAL_DECK_V4').planningKind).toBe('VISUAL_DECK_COMPILER')
  })

  test('does not allow v4 approval to enter a legacy image execution path', async () => {
    const repository = new InMemoryAgentRepository()
    const service = new RunService({ repository, clock: new FixedClock() })
    const request = {
      schemaVersion: CONTRACT_VERSION,
      host: { tenantId: 'frameflow', externalUserId: 'user-v4' },
      source: { kind: 'TEXT', name: '教材.txt', text: '这是用于验证V4执行隔离的教材内容。'.repeat(4) },
      slideCount: 12,
      visualDirection: '资料驱动的叙事型视觉幻灯片',
      imageModel: 'image-2',
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
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
    })

    await expect(service.act(created.run.id, request.host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'APPROVE_BLUEPRINT',
      expectedVersion: 1,
    }, 'approve-v4-strategy-0001')).rejects.toMatchObject({
      status: 422,
      code: 'MODE_EXECUTION_NOT_IMPLEMENTED',
    })
    expect((await repository.getRun(created.run.id))?.status).toBe('AWAITING_BLUEPRINT_APPROVAL')
  })
})

import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  assertControlledRasterSvgTextWhitelist,
  controlledRasterSvg,
  SharpControlledRasterPort,
} from '../src/adapters/v4-controlled-raster'
import { FixedClock, MockArtifactPort, MockBudgetPort, MockImageGenerationPort } from '../src/adapters/mock-ports'
import { hashInput } from '../src/core/hash'
import { MediaStepRunner } from '../src/core/media-step-runner'
import { planningStepKey } from '../src/core/planning-runner'
import { SlideGenerationCoordinator } from '../src/core/slide-generation-coordinator'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { presentationBlueprintSchema } from '../src/presentation-contracts'
import type { ControlledRasterPort, RunRecord } from '../src/core/ports'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-controlled-raster', creationKey: 'create-controlled-raster', requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'teacher-1' },
    source: { kind: 'TEXT', text: '桌上有5个苹果。水循环形成云和雨。'.repeat(5) },
    slideCount: 3, visualDirection: '清晰的课堂信息图', imageModel: 'gemini-3-pro-image-preview',
    v4ModelSnapshot: {
      schemaVersion: '1',
      textModel: 'gpt-5.6-terra',
      visionModel: 'gpt-5.6-terra',
      imageModel: 'gemini-3-pro-image-preview',
      imageEditModel: 'gpt-image-2',
    },
    presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO', maxRevisionRounds: 2,
    revisionRound: 0, qualityScore: null, status: 'EXECUTING', resumeState: null, version: 1,
    budgetUnits: 100, committedBudgetUnits: 0, qualityOverride: false, qualityOverrideReason: null,
    qualityOverrideBy: null, leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  }
}

function controlledBlueprint(slideCount = 3) {
  const source = { kind: 'TEXT' as const, name: '课堂材料.txt', text: '桌上有5个苹果。水循环形成云和雨。'.repeat(8) }
  const base = createVisualDeckV4Blueprint({
    runId: 'run-controlled-raster', inputHash: 'request-hash', source,
    document: {
      name: source.name,
      chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
      isComplete: true,
      missingRanges: [],
    },
    config: {
      instruction: `制作${slideCount}页课堂视觉演示`, sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'PRESENTER_SLIDES', language: 'zh-CN', length: { slideCount }, aspectRatio: '16:9',
        audience: '小学学生', focus: '数量和水循环', styleHint: '清晰的课堂信息图',
      },
    },
    slideCount,
    visualDirection: '清晰的课堂信息图',
    compilerVersion: 'visual-deck-v4-chain-4',
    createdAt: '2026-08-07T00:00:00.000Z',
  })
  const proposal = base.visualDeckV4Proposal!
  const first = proposal.slideBriefs[0]!
  return presentationBlueprintSchema.parse({
    ...base,
    visualDeckV4Proposal: {
      ...proposal,
      slideBriefs: proposal.slideBriefs.map((brief, index) => index === 0 ? {
        ...first,
        title: '五个苹果',
        keyClaim: '桌上有5个苹果。',
        audienceTakeaway: '能够准确数出5个苹果。',
        lockedCopy: ['桌上有5个苹果。'],
        facts: ['桌上有5个苹果。'],
        numbers: [],
        formulas: [],
      } : {
        ...brief,
        title: `水循环阶段${index + 1}`,
        keyClaim: '水循环形成云和雨。',
        audienceTakeaway: '理解水循环的自然过程。',
        lockedCopy: ['水循环形成云和雨。'],
        facts: ['水循环形成云和雨。'],
        numbers: [],
        formulas: [],
      }),
    },
    slides: base.slides.map((slide, index) => index === 0 ? {
      ...slide,
      title: '五个苹果',
      body: ['桌上有5个苹果。'],
    } : {
      ...slide,
      title: `水循环阶段${index + 1}`,
      body: ['水循环形成云和雨。'],
    }),
  })
}

async function seedBlueprint(repository: InMemoryAgentRepository, record: RunRecord, blueprint: ReturnType<typeof controlledBlueprint>) {
  await repository.transact(record.id, (transaction) => {
    transaction.putStep({
      id: 'step-plan', runId: record.id, idempotencyKey: planningStepKey(record.id),
      inputHash: hashInput({ blueprint }), tool: 'create_blueprint', status: 'COMPLETED',
      budgetUnits: 0, budgetReservationId: null, externalOperationId: null, errorCode: null,
      output: blueprint, createdAt: record.createdAt, updatedAt: record.updatedAt,
    })
  })
}

function failingControlledRaster(kind: 'ASPECT' | 'TEXT' | 'RENDER'): ControlledRasterPort {
  return {
    async render() {
      if (kind === 'TEXT') throw new Error('CONTROLLED_RASTER_VISIBLE_TEXT_TOO_LARGE')
      if (kind === 'RENDER') throw new Error('controlled raster test renderer failed')
      return { artifactId: 'controlled-raster-invalid-aspect', sha256: 'a'.repeat(64), width: 4, height: 3 }
    },
  }
}

describe('V4 controlled raster', () => {
  test('renders a deterministic 1600 by 900 PNG for a complete exact diagram', async () => {
    const artifacts = new MockArtifactPort()
    const renderer = new SharpControlledRasterPort({ artifacts })
    const output = await renderer.render({
      tenantId: 'frameflow', runId: 'run-controlled-raster', pageNumber: 1,
      title: '五个苹果', visibleCopy: ['桌上有5个苹果。'],
      diagram: { kind: 'EXACT_COUNT', itemLabel: '苹果', count: 5 },
      idempotencyKey: 'run-controlled-raster:slide:1:image:r0:v1',
    })

    expect(output).toMatchObject({ width: 1600, height: 900 })
    const artifact = await artifacts.get({ tenantId: 'frameflow', artifactId: output.artifactId })
    expect(await sharp(artifact!.bytes).metadata()).toMatchObject({ format: 'png', width: 1600, height: 900 })
  })

  test('renders no SVG text outside the approved title and locked copy whitelist', () => {
    const input = {
      tenantId: 'frameflow', runId: 'run-controlled-raster', pageNumber: 1,
      title: '五个苹果', visibleCopy: ['桌上有5个苹果。'],
      diagram: { kind: 'EXACT_COUNT' as const, itemLabel: '苹果', count: 5 },
      idempotencyKey: 'controlled-raster-visible-copy',
    }
    const svg = controlledRasterSvg(input)
    const textNodes = [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
      .map((match) => match[1]!.replace(/<[^>]*>/g, ''))

    expect(textNodes).toEqual(['五个苹果', '桌上有5个苹果。'])
    expect(svg).not.toContain('精确关系图示')
    expect(svg).not.toContain('5个苹果</text>')
  })

  test('rejects unapproved text found in the final SVG before rasterization', () => {
    expect(() => assertControlledRasterSvgTextWhitelist(
      '<svg><text>已批准标题</text><text>未批准文本</text></svg>',
      new Set(['已批准标题']),
    )).toThrow('CONTROLLED_RASTER_VISIBLE_TEXT_NOT_ALLOWED')
  })

  test('keeps controlled pages in the V4 batch with zero Provider units', async () => {
    const repository = new InMemoryAgentRepository()
    const budget = new MockBudgetPort()
    const images = new MockImageGenerationPort()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const record = run()
    await repository.createRun(record)
    const blueprint = controlledBlueprint()
    await seedBlueprint(repository, record, blueprint)
    const media = new MediaStepRunner({ repository, budget, images, clock })
    const coordinator = new SlideGenerationCoordinator({
      repository, media, batchBudget: budget,
      documents: { resolve: async () => ({ name: 'source', chunks: [], isComplete: true, missingRanges: [] }) },
      artifacts, clock, controlledRaster: new SharpControlledRasterPort({ artifacts }),
    })

    const submitted = await coordinator.submitBlueprintImages(record.id, 10)
    expect(submitted).toMatchObject({ submitted: 3, total: 3 })
    expect(images.operations.size).toBe(2)
    const steps = await repository.listSteps(record.id)
    expect(steps.find((step) => step.idempotencyKey.endsWith(':slide:1:image:r0:v1')))
      .toMatchObject({ status: 'COMPLETED', budgetUnits: 0, output: { renderStrategy: 'CONTROLLED_RASTER' } })
    expect(steps.find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ budgetUnits: 20, output: { accounting: { estimatedUnits: 20 } } })

    for (const [index, key] of [...images.operations.keys()].entries()) images.complete(key, `artifact-generated-${index + 1}`)
    await expect(coordinator.refreshBlueprintImages(record.id)).resolves.toMatchObject({ status: 'PAGE_REVIEW', completed: 3 })
    expect(budget.batchFinalizations).toEqual([expect.objectContaining({ settledUnits: 20, releasedUnits: 0 })])
  })

  test('fails closed before reserving or submitting when a resolved controlled page has no renderer', async () => {
    const repository = new InMemoryAgentRepository()
    const budget = new MockBudgetPort()
    const images = new MockImageGenerationPort()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const record = run()
    await repository.createRun(record)
    const blueprint = controlledBlueprint()
    await seedBlueprint(repository, record, blueprint)
    const media = new MediaStepRunner({ repository, budget, images, clock })
    const coordinator = new SlideGenerationCoordinator({
      repository, media, batchBudget: budget,
      documents: { resolve: async () => ({ name: 'source', chunks: [], isComplete: true, missingRanges: [] }) },
      artifacts, clock,
    })

    await expect(coordinator.submitBlueprintImages(record.id, 10)).rejects.toThrow('CONTROLLED_RASTER_PORT_REQUIRED')
    expect(images.operations.size).toBe(0)
    expect(budget.batchReservationRequests).toHaveLength(0)
  })

  for (const [kind, errorCode] of [
    ['ASPECT', 'CONTROLLED_RASTER_ASPECT_RATIO_INVALID'],
    ['TEXT', 'CONTROLLED_RASTER_VISIBLE_TEXT_TOO_LARGE'],
    ['RENDER', 'CONTROLLED_RASTER_RENDER_FAILED'],
  ] as const) {
    test(`persists a ${kind.toLowerCase()} controlled initial raster failure before terminal batch accounting`, async () => {
      const repository = new InMemoryAgentRepository()
      const budget = new MockBudgetPort()
      const images = new MockImageGenerationPort()
      const artifacts = new MockArtifactPort()
      const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
      const record = run({ slideCount: 1 })
      await repository.createRun(record)
      await seedBlueprint(repository, record, controlledBlueprint(1))
      const media = new MediaStepRunner({ repository, budget, images, clock })
      const coordinator = new SlideGenerationCoordinator({
        repository, media, batchBudget: budget,
        documents: { resolve: async () => ({ name: 'source', chunks: [], isComplete: true, missingRanges: [] }) },
        artifacts, clock, controlledRaster: failingControlledRaster(kind),
      })

      await expect(coordinator.submitBlueprintImages(record.id, 10)).resolves.toMatchObject({ status: 'RECOVERING' })
      expect(images.operations.size).toBe(0)
      const failedStep = (await repository.listSteps(record.id)).find((step) =>
        step.idempotencyKey.endsWith(':slide:1:image:r0:v1'))
      expect(failedStep).toMatchObject({
        status: 'FAILED', budgetUnits: 0, errorCode,
        output: {
          renderStrategy: 'CONTROLLED_RASTER',
          technicalFailure: {
            category: kind === 'RENDER' ? 'INTERNAL' : 'CONTRACT',
            disposition: 'NON_RETRYABLE',
            diagnosticCode: errorCode,
          },
        },
      })
      if (kind === 'ASPECT') expect(failedStep).toMatchObject({ output: { imageWidth: 4, imageHeight: 3 } })

      await expect(coordinator.reconcileTerminalGenerationBatch(record.id)).resolves.toBe(true)
      expect(await repository.getRun(record.id)).toMatchObject({ status: 'FAILED' })
      expect((await repository.listSteps(record.id)).find((step) => step.tool === 'generate_image_batch'))
        .toMatchObject({ status: 'COMPLETED', output: { accounting: { settlement: 'RELEASED' } } })
    })
  }

  test('waits for a mixed batch provider result before settling its controlled raster failure', async () => {
    const repository = new InMemoryAgentRepository()
    const budget = new MockBudgetPort()
    const images = new MockImageGenerationPort()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const record = run({ slideCount: 2 })
    await repository.createRun(record)
    await seedBlueprint(repository, record, controlledBlueprint(2))
    const media = new MediaStepRunner({ repository, budget, images, clock })
    const coordinator = new SlideGenerationCoordinator({
      repository, media, batchBudget: budget,
      documents: { resolve: async () => ({ name: 'source', chunks: [], isComplete: true, missingRanges: [] }) },
      artifacts, clock, controlledRaster: failingControlledRaster('ASPECT'),
    })

    await expect(coordinator.submitBlueprintImages(record.id, 10)).resolves.toMatchObject({ status: 'RECOVERING' })
    expect(images.operations.size).toBe(1)
    await expect(coordinator.reconcileTerminalGenerationBatch(record.id)).resolves.toBe(false)

    const providerKey = [...images.operations.keys()][0]!
    images.complete(providerKey, 'artifact-provider-page-2')
    await media.reconcilePendingRun(record.id)
    await expect(coordinator.reconcileTerminalGenerationBatch(record.id)).resolves.toBe(true)

    expect(images.operations.size).toBe(1)
    expect(await repository.getRun(record.id)).toMatchObject({ status: 'FAILED' })
    expect(budget.batchFinalizations).toEqual([
      expect.objectContaining({ settledUnits: 10, releasedUnits: 0 }),
    ])
  })
})

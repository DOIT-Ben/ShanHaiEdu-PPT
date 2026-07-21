import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockArtifactPort, MockBudgetPort, MockImageGenerationPort } from '../src/adapters/mock-ports'
import { hashInput } from '../src/core/hash'
import { MediaStepRunner } from '../src/core/media-step-runner'
import { planningStepKey } from '../src/core/planning-runner'
import type { DocumentResult, RunRecord } from '../src/core/ports'
import { SlideGenerationCoordinator } from '../src/core/slide-generation-coordinator'

function run(budgetUnits = 100): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于批量页面生成测试的完整教材内容。' },
    slideCount: 3,
    visualDirection: '清晰的课堂科学信息图风格',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'EXECUTING',
    resumeState: null,
    version: 1,
    budgetUnits,
    committedBudgetUnits: 0,
    qualityOverride: false,
    qualityOverrideReason: null,
    qualityOverrideBy: null,
    leaseToken: null,
    leaseUntil: null,
    leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function blueprint() {
  return {
    id: 'blueprint-1',
    title: '光合作用',
    visualDirection: '清晰的课堂科学信息图风格',
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物',
      grade: '七年级',
      lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的过程。',
      learningObjectives: ['理解光合作用的条件与产物'],
      scopeBoundaries: ['仅覆盖教材中的定性知识'],
      prohibitedExtensions: [],
      sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2, 3].map((pageNumber) => ({
      pageNumber,
      title: `第 ${pageNumber} 页`,
      body: ['教材范围内的教学内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: '以清晰的科学课堂画面支持当前知识点',
      visualPrompt: `A clean educational science illustration for slide ${pageNumber}, no text or symbols`,
      sourceChunkIds: ['chunk-1'],
    })),
  }
}

async function fixture(budgetUnits = 100, blueprintValue: ReturnType<typeof blueprint> | Record<string, unknown> = blueprint(), documentResult: DocumentResult = {
  name: 'source', chunks: [], assets: [], isComplete: true, missingRanges: [],
}) {
  const repository = new InMemoryAgentRepository()
  const budget = new MockBudgetPort()
  const images = new MockImageGenerationPort()
  const clock = new FixedClock()
  const artifacts = new MockArtifactPort()
  const documents = { resolve: async () => structuredClone(documentResult) }
  await repository.createRun(run(budgetUnits))
  await repository.transact('run-1', (transaction) => {
    const key = planningStepKey('run-1')
    transaction.putStep({
      id: 'step-plan-1',
      runId: 'run-1',
      idempotencyKey: key,
      inputHash: hashInput({ blueprint: 1 }),
      tool: 'create_blueprint',
      status: 'COMPLETED',
      budgetUnits: 0,
      budgetReservationId: null,
      externalOperationId: null,
      errorCode: null,
      output: blueprintValue,
      createdAt: transaction.run.createdAt,
      updatedAt: transaction.run.updatedAt,
    })
  })
  const media = new MediaStepRunner({ repository, budget, images, clock })
  const coordinator = new SlideGenerationCoordinator({ repository, media, documents, artifacts, clock })
  return { repository, budget, images, artifacts, coordinator }
}

function layeredBlueprint(strategy: 'REUSE_ORIGINAL' | 'REFERENCE_GENERATION') {
  const base = blueprint()
  return {
    ...base,
    renderMode: 'LAYERED_COURSEWARE_V3',
    coverDesignMode: 'INDEPENDENT',
    sourceManifest: [{ id: 'source-image-1', name: '叶片.png', kind: 'IMAGE', mimeType: 'image/png', status: 'READY' }],
    sourceAssets: [{
      id: 'source-asset-1', sourceId: 'source-image-1', name: '叶片.png', mimeType: 'image/png',
      byteLength: 8, sha256: 'a'.repeat(64), width: 640, height: 480,
    }],
    curriculum: { ...base.curriculum, sourceAssetIds: ['source-asset-1'] },
    slides: base.slides.slice(0, 2).map((slide, index) => ({
      ...slide,
      sourceAssetIds: index === 0 ? ['source-asset-1'] : [],
      layeredDesign: {
        designKind: index === 0 ? 'COVER' : 'CONTENT',
        backgroundColor: '#F5F8FF',
        elements: [
          {
            kind: 'IMAGE', elementId: `base-${index + 1}`, role: 'BASE_LAYER',
            knowledgePoint: '建立教材知识情境', prompt: 'A child friendly botanical classroom scene without text or logos',
            negativePrompt: 'text, watermark, logo', sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
            sourceAssetStrategy: 'REGENERATE', placement: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 0,
            fit: 'COVER', aspectRatio: '16:9', backgroundMode: 'OPAQUE',
          },
          ...(index === 0 ? [{
            kind: 'IMAGE', elementId: 'source-leaf', role: 'KNOWLEDGE_VISUAL',
            knowledgePoint: '使用教材叶片原图讲解光合作用', prompt: 'Use the supplied textbook leaf as the exact visual reference for this lesson',
            negativePrompt: 'text, watermark, logo', sourceChunkIds: ['chunk-1'], sourceAssetIds: ['source-asset-1'],
            sourceAssetStrategy: strategy, placement: { x: 0.6, y: 0.2, width: 0.3, height: 0.5 }, zIndex: 10,
            fit: 'CONTAIN', aspectRatio: '1:1', backgroundMode: 'TRANSPARENT',
          }] : []),
          ...(index > 0 ? [{
            kind: 'SHAPE', elementId: `panel-${index + 1}`, role: 'CONTENT_PANEL', shape: 'ROUNDED_RECTANGLE',
            placement: { x: 0.05, y: 0.1, width: 0.48, height: 0.78 }, zIndex: 15,
            fillColor: '#FFFFFF', transparency: 8,
          }] : []),
          {
            kind: 'TEXT', elementId: `title-${index + 1}`, role: 'TITLE', text: slide.title,
            sourceChunkIds: ['chunk-1'], sourceAssetIds: index === 0 ? ['source-asset-1'] : [],
            placement: { x: 0.09, y: 0.2, width: 0.39, height: 0.18 }, zIndex: 20,
            style: { fontSize: 30, bold: true, color: '#17202A', align: 'LEFT' },
          },
        ],
      },
    })),
  }
}

function sourceDocument() {
  return {
    name: 'source-package', chunks: [], isComplete: true, missingRanges: [],
    assets: [{
      id: 'source-asset-1', sourceId: 'source-image-1', name: '叶片.png', mimeType: 'image/png' as const,
      byteLength: 8, sha256: 'a'.repeat(64), width: 640, height: 480,
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    }],
  }
}

describe('slide generation coordinator', () => {
  test('submits every blueprint slide with per-page budget accounting', async () => {
    const { repository, budget, images, coordinator } = await fixture()
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ status: 'EXECUTING', submitted: 3, total: 3 })
    expect(images.operations.size).toBe(3)
    expect(budget.reservations.size).toBe(3)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 30 })
    expect(result.steps.map((step) => step.output)).toEqual([
      { slideId: 'run-1:slide:1', versionId: 'run-1:slide:1:r0:v1' },
      { slideId: 'run-1:slide:2', versionId: 'run-1:slide:2:r0:v1' },
      { slideId: 'run-1:slide:3', versionId: 'run-1:slide:3:r0:v1' },
    ])
  })

  test('replays a completed batch without duplicate provider calls or progress events', async () => {
    const { repository, images, coordinator } = await fixture()
    await coordinator.submitBlueprintImages('run-1', 10)
    const eventCount = (await repository.listEvents('run-1')).length
    const replay = await coordinator.submitBlueprintImages('run-1', 10)

    expect(replay.submitted).toBe(3)
    expect(images.operations.size).toBe(3)
    expect((await repository.listEvents('run-1')).length).toBe(eventCount)
  })

  test('pauses before any submission when total initial budget is insufficient', async () => {
    const { repository, budget, images, coordinator } = await fixture(20)
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ status: 'PAUSED', submitted: 0, total: 3 })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'PAUSED',
      resumeState: 'EXECUTING',
      committedBudgetUnits: 0,
    })
    expect(images.operations.size).toBe(0)
    expect(budget.reservations.size).toBe(0)
  })

  test('stops the batch immediately when a provider submission is unknown', async () => {
    const { repository, images, coordinator } = await fixture()
    images.failNext('IDEMPOTENCY_SUBMISSION_UNKNOWN', 'UNKNOWN')
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', submitted: 0, total: 3 })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', committedBudgetUnits: 10 })
    expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'generate_slide_image')).toHaveLength(1)
  })

  test('moves to page review only after every image has a controlled artifact', async () => {
    const { repository, images, coordinator } = await fixture()
    await coordinator.submitBlueprintImages('run-1', 10)
    const keys = [...images.operations.keys()]
    images.complete(keys[0]!, 'artifact-1')
    expect(await coordinator.refreshBlueprintImages('run-1')).toMatchObject({
      status: 'EXECUTING', completed: 1, total: 3,
    })
    images.complete(keys[1]!, 'artifact-2')
    images.complete(keys[2]!, 'artifact-3')
    const completed = await coordinator.refreshBlueprintImages('run-1')

    expect(completed).toEqual({
      status: 'PAGE_REVIEW',
      completed: 3,
      total: 3,
      artifactIds: ['artifact-1', 'artifact-2', 'artifact-3'],
    })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'PAGE_REVIEW', version: 5 })
  })

  test('moves to human review when a completed provider operation failed', async () => {
    const { repository, images, coordinator } = await fixture()
    await coordinator.submitBlueprintImages('run-1', 10)
    const firstKey = [...images.operations.keys()][0]!
    images.fail(firstKey, 'PROVIDER_REJECTED', 'NOT_CHARGED')
    const result = await coordinator.refreshBlueprintImages('run-1')

    expect(result.status).toBe('NEEDS_HUMAN')
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', committedBudgetUnits: 20 })
  })

  test('reuses an original source image without image-provider calls or budget charge', async () => {
    const { repository, images, budget, artifacts, coordinator } = await fixture(100, layeredBlueprint('REUSE_ORIGINAL'), sourceDocument())
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ status: 'EXECUTING', submitted: 3, total: 3 })
    expect(images.operations.size).toBe(2)
    expect(budget.reservations.size).toBe(2)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 20 })
    const reused = result.steps.find((step) => (step.output as { sourceAssetId?: string })?.sourceAssetId === 'source-asset-1')
    expect(reused).toMatchObject({ status: 'COMPLETED', budgetUnits: 0 })
    const artifactId = (reused!.output as { artifactId: string }).artifactId
    expect((await artifacts.get({ tenantId: 'frameflow', artifactId }))?.bytes).toEqual(sourceDocument().assets[0]!.bytes)
  })

  test('sends the selected source image to reference generation', async () => {
    const { images, budget, coordinator } = await fixture(100, layeredBlueprint('REFERENCE_GENERATION'), sourceDocument())
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ submitted: 3, total: 3 })
    expect(images.operations.size).toBe(3)
    expect(budget.reservations.size).toBe(3)
    const referenced = [...images.requests.values()].find((request) => request.referenceImage)
    expect(referenced?.referenceImage).toMatchObject({ mimeType: 'image/png', sha256: 'a'.repeat(64) })
    expect(referenced?.referenceImage?.bytes).toEqual(sourceDocument().assets[0]!.bytes)
  })
})

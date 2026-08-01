import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  FixedClock,
  MockArtifactPort,
  MockAssetCandidateReviewPort,
  MockBudgetPort,
  MockImageGenerationPort,
} from '../src/adapters/mock-ports'
import { getActiveBlueprint, revisionBlueprintStepKey } from '../src/core/active-blueprint'
import { blueprintImageRequirements } from '../src/core/blueprint-assets'
import { refreshGenerationBatch } from '../src/core/generation-batch'
import { hashInput } from '../src/core/hash'
import { MediaStepRunner } from '../src/core/media-step-runner'
import { planningStepKey } from '../src/core/planning-runner'
import type { AssetCandidate, AssetCandidateReviewPort, AssetDiscoveryPort, DocumentResult, RunRecord } from '../src/core/ports'
import { SlideGenerationCoordinator } from '../src/core/slide-generation-coordinator'
import { resumeTechnicalRecovery } from '../src/core/technical-recovery'
import { presentationBlueprintSchema } from '../src/presentation-contracts'

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

function approvedRunSource() {
  return {
    kind: 'APPROVED_PAGE_DESIGN' as const,
    schemaVersion: '1' as const,
    artifactVersionId: 'page-design-version-1',
    artifactContentHash: 'a'.repeat(64),
    title: '光合作用',
    subject: '生物',
    gradeBand: '七年级',
    lessonDurationMinutes: 45,
    audience: '七年级学生',
    objectives: ['理解光合作用'],
    pages: [1, 2, 3].map((pageNumber) => ({
      pageNumber,
      title: `第 ${pageNumber} 页`,
      teachingPurpose: '理解光合作用',
      editableCopy: ['教材范围内的教学内容'],
      layoutIntent: '左文右图',
      visualRequirements: ['叶片和阳光'],
      teacherNotes: '引导观察',
      teacherScript: '请观察叶片和阳光之间的关系。',
      studentActivity: '观察并回答',
      animationSequence: ['先出现叶片'],
      boardPlan: '板书光合作用',
      evidence: [],
    })),
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
}, discovery?: AssetDiscoveryPort, assetAcquisitionPolicy: RunRecord['assetAcquisitionPolicy'] = 'AI_FIRST',
candidateReviewer?: AssetCandidateReviewPort) {
  const repository = new InMemoryAgentRepository()
  const budget = new MockBudgetPort()
  const images = new MockImageGenerationPort()
  const clock = new FixedClock()
  const artifacts = new MockArtifactPort()
  const documents = { resolve: async () => structuredClone(documentResult) }
  await repository.createRun({ ...run(budgetUnits), assetAcquisitionPolicy })
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
  const webReviewer = candidateReviewer ?? (discovery ? new MockAssetCandidateReviewPort({
    approved: true,
    textDetected: false,
    visualScore: 90,
    reasons: [],
    retryInstruction: null,
  }) : undefined)
  const coordinator = new SlideGenerationCoordinator({
    repository,
    media,
    batchBudget: budget,
    documents,
    artifacts,
    clock,
    ...(discovery ? { discovery } : {}),
    ...(webReviewer ? { candidateReviewer: webReviewer } : {}),
  })
  return { repository, budget, images, artifacts, media, coordinator, candidateReviewer: webReviewer, clock }
}

function webSearchBlueprint() {
  const value = layeredBlueprint('REUSE_ORIGINAL')
  for (const slide of value.slides) {
    for (const element of slide.layeredDesign.elements) {
      if (element.kind !== 'IMAGE') continue
      Object.assign(element, {
        sourceAssetIds: [],
        sourceAssetStrategy: 'SEARCH_WEB',
        assetIntent: {
          searchQueries: [`${element.elementId} classroom visual`, element.knowledgePoint],
          mediaType: element.role === 'BASE_LAYER' ? 'TEXTURE' : 'PHOTO',
          styleKeywords: ['bright classroom', 'clean composition'],
          transparencyPreference: element.role === 'BASE_LAYER' ? 'PREFER_OPAQUE' : 'EITHER',
        },
      })
    }
  }
  return value
}

function discovery(returnCandidates = true) {
  const searches: Parameters<AssetDiscoveryPort['search']>[0][] = []
  const acquisitions: Parameters<AssetDiscoveryPort['acquire']>[0][] = []
  const candidate: AssetCandidate = {
    provider: 'WIKIMEDIA_COMMONS', providerAssetId: 'file-1', title: 'Classroom visual',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Classroom_visual.png',
    downloadUrl: 'https://upload.wikimedia.org/classroom-visual.png', creator: 'Example Author',
    license: 'CC_BY', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Classroom visual by Example Author, CC BY 4.0', mimeType: 'image/png', width: 1200, height: 800,
  }
  const port: AssetDiscoveryPort = {
    async search(input) {
      searches.push(input)
      return returnCandidates ? [{ ...candidate, providerAssetId: `file-${searches.length}` }] : []
    },
    async acquire(input) {
      acquisitions.push(input)
      return { candidate: input.candidate, bytes: new Uint8Array([137, 80, 78, 71]), sha256: 'b'.repeat(64) }
    },
  }
  return { port, searches, acquisitions }
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
  test('compiles V2.1 visual prompts without changing legacy V2 prompts', () => {
    const legacy = presentationBlueprintSchema.parse({ ...blueprint(), renderMode: 'SLIDE_IMAGE_V2' })
    const reflected = presentationBlueprintSchema.parse({ ...blueprint(), renderMode: 'SLIDE_IMAGE_V2_1' })
    const legacyPrompt = blueprintImageRequirements(run(), legacy)[0]!.prompt
    const reflectedPrompt = blueprintImageRequirements(run(), reflected)[0]!.prompt

    expect(legacyPrompt).toBe(legacy.slides[0]!.visualPrompt)
    expect(reflectedPrompt).toContain(reflected.slides[0]!.visualPrompt)
    expect(reflectedPrompt).toContain(`Global art direction: ${reflected.visualDirection}.`)
    expect(reflectedPrompt).toContain('Place one strong focal subject in the right half')
    expect(reflectedPrompt).toContain('No text, no letters, no numbers')
    expect(reflectedPrompt).toContain('do not draw a text box')
    expect(reflectedPrompt.length).toBeLessThanOrEqual(3_000)
  })

  test('submits every blueprint slide with per-page budget accounting', async () => {
    const { repository, budget, images, coordinator } = await fixture()
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ status: 'EXECUTING', submitted: 3, total: 3 })
    expect(images.operations.size).toBe(3)
    expect(budget.reservations.size).toBe(3)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 30 })
    expect(result.steps.map((step) => step.output)).toEqual([
      { slideId: 'run-1:slide:1', versionId: 'run-1:slide:1:r0:v1', backgroundMode: 'OPAQUE' },
      { slideId: 'run-1:slide:2', versionId: 'run-1:slide:2:r0:v1', backgroundMode: 'OPAQUE' },
      { slideId: 'run-1:slide:3', versionId: 'run-1:slide:3:r0:v1', backgroundMode: 'OPAQUE' },
    ])
  })

  test('submits a V4 deck concurrently through one batch reservation', async () => {
    const { repository, budget, images, coordinator } = await fixture()
    images.submissionDelayMs = 15
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })

    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ status: 'EXECUTING', submitted: 3, total: 3 })
    expect(images.maxConcurrentSubmissions).toBe(3)
    expect(images.operations.size).toBe(3)
    expect(budget.reservations.size).toBe(0)
    expect(budget.batchReservations.size).toBe(1)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 30 })
    const batch = (await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch')
    expect(batch?.output).toMatchObject({
      batchId: expect.stringMatching(/^genbatch_[a-f0-9]{32}$/),
      submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS',
      pageCount: 3,
      accounting: {
        estimatedUnits: 30, committedUnits: 30, settledUnits: 0,
        authorization: 'RESERVED', settlement: 'PENDING',
      },
      progress: { submitted: 3, completed: 0, failed: 0 },
      status: 'PROCESSING',
    })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'generation.batch.created')).toBe(true)
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

  test('recovers reserved and submitting steps with the original host and Provider keys', async () => {
    for (const crashStatus of ['RESERVED', 'SUBMITTING'] as const) {
      const { repository, budget, images, media, coordinator } = await fixture()
      const currentRun = (await repository.getRun('run-1'))!
      const activeBlueprint = await getActiveBlueprint(repository, 'run-1', currentRun.revisionRound)
      const requirement = blueprintImageRequirements(currentRun, activeBlueprint)[0]!
      const versionId = 'run-1:slide:1:r0:v1'
      const request = {
        runId: 'run-1',
        stepId: `step-run-1-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r0`,
        idempotencyKey: requirement.idempotencyKey,
        slideId: requirement.slideId,
        versionId,
        prompt: requirement.prompt,
        model: currentRun.imageModel,
        budgetUnits: 10,
        aspectRatio: requirement.aspectRatio,
        backgroundMode: requirement.backgroundMode,
      } as const
      await media.submitSlideImage(request)
      const operationId = images.operations.get(requirement.idempotencyKey)!
      await repository.transact('run-1', (transaction) => {
        const step = transaction.getStep(requirement.idempotencyKey)!
        transaction.putStep({
          ...step,
          status: crashStatus,
          budgetReservationId: crashStatus === 'RESERVED' ? null : step.budgetReservationId,
          externalOperationId: null,
        })
      })
      if (crashStatus === 'RESERVED') {
        images.operations.delete(requirement.idempotencyKey)
        images.requests.delete(requirement.idempotencyKey)
        images.statuses.delete(operationId)
      }

      const recovered = await coordinator.submitBlueprintImages('run-1', 10)

      expect(recovered).toMatchObject({ submitted: 3, total: 3 })
      expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'generate_slide_image'))
        .toHaveLength(3)
      expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'generate_slide_image')
        .every((step) => step.status === 'WAITING')).toBe(true)
      expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 30 })
      expect(budget.reservations.size).toBe(3)
      expect(images.operations.size).toBe(3)
    }
  })

  test('recovers the current approved page from reserved and submitting without starting the next page', async () => {
    for (const crashStatus of ['RESERVED', 'SUBMITTING'] as const) {
      const { repository, images, media, coordinator } = await fixture()
      await repository.transact('run-1', (transaction) => {
        transaction.putRun({ ...transaction.run, source: approvedRunSource() })
      })
      const currentRun = (await repository.getRun('run-1'))!
      const activeBlueprint = await getActiveBlueprint(repository, 'run-1', currentRun.revisionRound)
      const requirement = blueprintImageRequirements(currentRun, activeBlueprint)[0]!
      const request = {
        runId: 'run-1',
        stepId: `step-run-1-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r0`,
        idempotencyKey: requirement.idempotencyKey,
        slideId: requirement.slideId,
        versionId: 'run-1:slide:1:r0:v1',
        prompt: requirement.prompt,
        model: currentRun.imageModel,
        budgetUnits: 10,
        aspectRatio: requirement.aspectRatio,
        backgroundMode: requirement.backgroundMode,
      } as const
      await media.submitSlideImage(request)
      const operationId = images.operations.get(requirement.idempotencyKey)!
      await repository.transact('run-1', (transaction) => {
        const step = transaction.getStep(requirement.idempotencyKey)!
        transaction.putStep({
          ...step,
          status: crashStatus,
          budgetReservationId: crashStatus === 'RESERVED' ? null : step.budgetReservationId,
          externalOperationId: null,
        })
      })
      if (crashStatus === 'RESERVED') {
        images.operations.delete(requirement.idempotencyKey)
        images.requests.delete(requirement.idempotencyKey)
        images.statuses.delete(operationId)
      }

      const recovered = await coordinator.submitBlueprintImages('run-1', 10)

      expect(recovered).toMatchObject({ submitted: 1, total: 3 })
      expect(images.operations.size).toBe(1)
      expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'generate_slide_image'))
        .toHaveLength(1)
    }
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

  test('pauses a V4 batch when the host definitely rejects its single authorization', async () => {
    const { repository, budget, images, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    budget.failNext('HOST_BALANCE_INSUFFICIENT', 'NOT_RESERVED')

    expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({ status: 'PAUSED', submitted: 0 })
    expect(images.operations.size).toBe(0)
    expect(budget.batchReservations.size).toBe(0)
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'PAUSED', resumeState: 'EXECUTING', committedBudgetUnits: 0,
    })
  })

  test('stops before image submission when atomic batch finalization is unsupported by the host', async () => {
    const { repository, budget, images, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    budget.nextBatchFinalizationPreflightFailure = new Error('HOST_BATCH_FINALIZATION_UNSUPPORTED')

    expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({ status: 'NEEDS_HUMAN', submitted: 0 })
    expect(images.operations.size).toBe(0)
    expect(budget.batchReservations.size).toBe(0)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ status: 'FAILED', errorCode: 'BATCH_BUDGET_FINALIZATION_UNSUPPORTED' })
  })

  test('does not re-run the host capability preflight after a batch reservation exists', async () => {
    const { repository, budget, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    budget.nextBatchFinalizationPreflightFailure = new Error('HOST_BATCH_FINALIZATION_UNSUPPORTED')

    expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({ status: 'EXECUTING', submitted: 3 })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'EXECUTING', committedBudgetUnits: 30 })
  })

  test('moves a V4 batch into technical recovery when a provider submission is unknown', async () => {
    const { repository, images, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    images.failNext('IDEMPOTENCY_SUBMISSION_UNKNOWN', 'UNKNOWN')
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ status: 'RECOVERING', submitted: 2, total: 3 })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'RECOVERING', committedBudgetUnits: 30 })
    expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'generate_slide_image')).toHaveLength(3)
    expect((await repository.listEvents('run-1')).find((event) => event.type === 'generation.completed'))
      .toMatchObject({
        payload: {
          reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE', retryable: true,
          requiresUserAction: false, nextAction: null,
        },
      })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'technical.recovery.started')).toBe(true)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('resubmits a confirmed-unsubmitted V4 batch page after recovery without changing its image key', async () => {
    const { repository, images, clock, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    const failedKey = 'run-1:slide:1:image:r0:v1'
    images.failNext('NO_HEALTHY_ROUTE_BEFORE_SUBMIT', 'NOT_SUBMITTED')

    expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({ status: 'RECOVERING', total: 3 })
    expect(images.operations.has(failedKey)).toBe(false)
    clock.advance(2_000)
    await repository.transact('run-1', (transaction) => resumeTechnicalRecovery(transaction, clock))

    expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({ status: 'EXECUTING', submitted: 3, total: 3 })
    expect(images.operations.has(failedKey)).toBe(true)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'EXECUTING', committedBudgetUnits: 30 })
  })

  test('settles a V4 batch once after every image has a controlled artifact', async () => {
    const { repository, images, budget, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    const keys = [...images.operations.keys()]
    images.complete(keys[0]!, 'artifact-1')
    expect(await coordinator.refreshBlueprintImages('run-1')).toMatchObject({
      status: 'EXECUTING', completed: 1, total: 3,
    })
    expect((await repository.getRunEventSnapshot('run-1')).progress).toContainEqual(expect.objectContaining({
      stepId: 'run-1:completed-pages', completed: 1, total: 3,
    }))
    images.complete(keys[1]!, 'artifact-2')
    images.complete(keys[2]!, 'artifact-3')
    const completed = await coordinator.refreshBlueprintImages('run-1')

    expect(completed).toEqual({
      status: 'PAGE_REVIEW',
      completed: 3,
      total: 3,
      artifactIds: ['artifact-1', 'artifact-2', 'artifact-3'],
    })
    expect(budget.settled.size).toBe(1)
    expect(budget.reservations.size).toBe(0)
    expect(budget.batchReservations.size).toBe(1)
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ status: 'COMPLETED', output: { accounting: { settlement: 'SETTLED', settledUnits: 30 } } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'PAGE_REVIEW', version: 3 })
    expect((await repository.getRunEventSnapshot('run-1')).progress).toContainEqual(expect.objectContaining({
      stepId: 'run-1:completed-pages', completed: 3, total: 3,
    }))
  })

  test('recovers a V4 batch settlement with its original reservation and idempotency key', async () => {
    const { repository, images, budget, coordinator, clock } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    const keys = [...images.operations.keys()]
    for (const [index, key] of keys.entries()) images.complete(key, `artifact-${index + 1}`)
    budget.failNextSettlement('HOST_SETTLEMENT_UNKNOWN')

    expect(await coordinator.refreshBlueprintImages('run-1')).toMatchObject({ status: 'RECOVERING', completed: 3 })
    expect(await repository.getRun('run-1')).toMatchObject({
      technicalRecovery: { resumeState: 'EXECUTING', reason: 'BATCH_BUDGET_FINALIZATION_UNKNOWN', active: true },
    })
    expect(budget.batchReservations.size).toBe(1)
    expect(budget.reservations.size).toBe(0)
    const batchBeforeRecovery = (await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch')!
    const reservationId = batchBeforeRecovery.budgetReservationId

    clock.advance(2_000)
    await repository.transact('run-1', (transaction) => resumeTechnicalRecovery(transaction, clock))
    expect(await coordinator.refreshBlueprintImages('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 3 })
    const batchAfterRecovery = (await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch')!
    expect(batchAfterRecovery).toMatchObject({
      budgetReservationId: reservationId,
      status: 'COMPLETED',
      output: { accounting: { settlement: 'SETTLED' } },
    })
    expect(budget.batchReservations.size).toBe(1)
    expect(budget.settled.size).toBe(1)
  })

  test('releases one V4 batch authorization when every page is definitely unsubmitted', async () => {
    const { repository, images, budget, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    for (const key of images.operations.keys()) images.fail(key, 'INVALID_IMAGE_PROMPT', 'NOT_CHARGED')

    expect(await coordinator.refreshBlueprintImages('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', completed: 0 })
    expect(budget.released.size).toBe(1)
    expect(budget.reservations.size).toBe(0)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0 })
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ status: 'COMPLETED', output: { accounting: { settlement: 'RELEASED', releasedUnits: 30 } } })
  })

  test('settles a cancelled V4 batch after its submitted pages complete during terminal reconciliation', async () => {
    const { repository, images, budget, media, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
    })
    for (const [index, key] of [...images.operations.keys()].entries()) images.complete(key, `late-artifact-${index + 1}`)

    await media.reconcilePendingRun('run-1')
    expect(await coordinator.reconcileTerminalGenerationBatch('run-1')).toBe(true)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'CANCELLED', committedBudgetUnits: 30 })
    expect(budget.settled.size).toBe(1)
    expect(budget.reservations.size).toBe(0)
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ status: 'COMPLETED', output: { accounting: { settlement: 'SETTLED', settledUnits: 30 } } })
  })

  test('releases a cancelled V4 batch after every submitted page is confirmed uncharged', async () => {
    const { repository, images, budget, media, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
    })
    for (const key of images.operations.keys()) images.fail(key, 'CANCELLED_BEFORE_START', 'NOT_CHARGED')

    await media.reconcilePendingRun('run-1')
    expect(await coordinator.reconcileTerminalGenerationBatch('run-1')).toBe(true)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'CANCELLED', committedBudgetUnits: 0 })
    expect(budget.released.size).toBe(1)
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ status: 'COMPLETED', output: { accounting: { settlement: 'RELEASED', releasedUnits: 30 } } })
  })

  test('atomically settles completed pages and releases uncharged pages after cancellation', async () => {
    const { repository, images, budget, media, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
    })
    const [first, ...remaining] = [...images.operations.keys()]
    images.complete(first!, 'late-artifact-1')
    for (const key of remaining) images.fail(key, 'CANCELLED_BEFORE_START', 'NOT_CHARGED')

    await media.reconcilePendingRun('run-1')
    expect(await coordinator.reconcileTerminalGenerationBatch('run-1')).toBe(true)
    expect(budget.batchFinalizations).toEqual([expect.objectContaining({
      settledUnits: 10,
      releasedUnits: 20,
      idempotencyKey: 'finalize:run-1:generation-batch:r0',
    })])
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'CANCELLED', committedBudgetUnits: 10 })
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ status: 'COMPLETED', output: { accounting: {
        settlement: 'SETTLED', settledUnits: 10, releasedUnits: 20, reconciliationUnits: 0,
      } } })
  })

  test('retries a cancelled batch finalization with the original atomic idempotency key', async () => {
    const { repository, images, budget, media, coordinator, clock } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'CANCELLED' })
    })
    for (const [index, key] of [...images.operations.keys()].entries()) images.complete(key, `late-artifact-${index + 1}`)
    await media.reconcilePendingRun('run-1')
    budget.failNextSettlement('HOST_BATCH_FINALIZATION_TIMEOUT')

    expect(await coordinator.reconcileTerminalGenerationBatch('run-1')).toBe(false)
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ status: 'BILLING_UNKNOWN', errorCode: 'BATCH_BUDGET_FINALIZATION_UNKNOWN' })
    await refreshGenerationBatch({ repository, clock, runId: 'run-1', revisionRound: 0 })
    expect(await repository.listRunsWithPendingMedia(10)).toEqual(['run-1'])
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ status: 'BILLING_UNKNOWN', output: { accounting: { settlement: 'UNKNOWN' } } })

    expect(await coordinator.reconcileTerminalGenerationBatch('run-1')).toBe(true)
    expect(budget.batchFinalizationAttempts).toHaveLength(2)
    expect(new Set(budget.batchFinalizationAttempts.map((input) => input.idempotencyKey))).toEqual(
      new Set(['finalize:run-1:generation-batch:r0']),
    )
  })

  test('submits approved page designs one page at a time and waits for completion before the next page', async () => {
    const { repository, images, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        source: approvedRunSource(),
      })
    })

    expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({ submitted: 1, total: 3 })
    expect(images.operations.size).toBe(1)
    expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({ submitted: 1, total: 3 })
    expect(images.operations.size).toBe(1)

    const firstKey = [...images.operations.keys()][0]!
    images.complete(firstKey, 'artifact-1')
    await coordinator.refreshBlueprintImages('run-1')
    expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({ submitted: 2, total: 3 })
    expect(images.operations.size).toBe(2)
  })

  test('counts only current revision image steps when a recovered run preserves completed history', async () => {
    const { repository, images, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        source: approvedRunSource(),
        revisionRound: 1,
        committedBudgetUnits: 30,
      })
      transaction.putStep({
        id: 'step-revision-blueprint-1',
        runId: 'run-1',
        idempotencyKey: revisionBlueprintStepKey('run-1', 1),
        inputHash: 'revision-blueprint-hash-1',
        tool: 'apply_revision',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: { ...blueprint(), id: 'blueprint-r1' },
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
      for (const pageNumber of [1, 2, 3]) {
        transaction.putStep({
          id: `step-image-r0-${pageNumber}`,
          runId: 'run-1',
          idempotencyKey: `run-1:slide:${pageNumber}:image:r0:v1`,
          inputHash: `image-r0-hash-${pageNumber}`,
          tool: 'generate_slide_image',
          status: 'COMPLETED',
          budgetUnits: 10,
          budgetReservationId: `budget-r0-${pageNumber}`,
          externalOperationId: `operation-r0-${pageNumber}`,
          errorCode: null,
          output: {
            slideId: `run-1:slide:${pageNumber}`,
            versionId: `run-1:slide:${pageNumber}:r0:v1`,
            artifactId: `artifact-r0-${pageNumber}`,
          },
          createdAt: transaction.run.createdAt,
          updatedAt: transaction.run.updatedAt,
        })
      }
    })

    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
      expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({
        status: 'EXECUTING', submitted: pageNumber, total: 3,
      })
      const key = `run-1:slide:${pageNumber}:image:r1:v1`
      images.complete(key, `artifact-r1-${pageNumber}`)
      expect(await coordinator.refreshBlueprintImages('run-1')).toMatchObject({
        status: pageNumber === 3 ? 'PAGE_REVIEW' : 'EXECUTING',
        completed: pageNumber,
        total: 3,
      })
    }

    expect(images.operations.size).toBe(3)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'PAGE_REVIEW', committedBudgetUnits: 60 })
  })

  test('moves to human review when a completed provider operation failed', async () => {
    const { repository, images, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    const keys = [...images.operations.keys()]
    images.complete(keys[0]!, 'artifact-r1-1')
    images.fail(keys[1]!, 'PROVIDER_REJECTED', 'CHARGED')
    const result = await coordinator.refreshBlueprintImages('run-1')

    expect(result.status).toBe('NEEDS_HUMAN')
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', committedBudgetUnits: 30 })
    const events = await repository.listEvents('run-1')
    expect(events.find((event) => event.type === 'phase.changed')?.payload)
      .toMatchObject({ from: 'EXECUTING', to: 'NEEDS_HUMAN' })
    expect(events.map((event) => event.type)).toContain('approval.required')
    const lifecycle = events.filter((event) => event.type.startsWith('generation.'))
    expect(lifecycle.filter((event) => event.type === 'generation.completed')).toHaveLength(1)
    expect(lifecycle.at(-1)).toMatchObject({
      type: 'generation.completed',
      payload: { completed: 1, total: 3, retryable: false },
    })
  })

  test('continues a recovered V4 image batch into page review without resubmitting images', async () => {
    const { repository, images, media, coordinator } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    await coordinator.submitBlueprintImages('run-1', 10)
    const keys = [...images.operations.keys()]
    images.complete(keys[0]!, 'artifact-v4-1')
    images.complete(keys[1]!, 'artifact-v4-2')
    await coordinator.refreshBlueprintImages('run-1')

    const target = (await repository.listSteps('run-1')).find((step) => step.idempotencyKey === keys[2])!
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: transaction.run.version + 1 })
      transaction.putStep({ ...target, status: 'BILLING_UNKNOWN', errorCode: 'RATE_LIMITED' })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: `${target.id}:provider-result`, category: 'PROVIDER_RESULT_FAILED', severity: 'CRITICAL',
          summary: '历史查询被网关限流。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
        },
      })
    })
    images.statuses.set(target.externalOperationId!, { state: 'PROCESSING' })
    expect(await media.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 0 })
    images.statuses.set(target.externalOperationId!, { state: 'COMPLETED', artifactId: 'artifact-v4-3' })
    expect(await media.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 1 })

    const operationCount = images.operations.size
    expect(await coordinator.submitBlueprintImages('run-1', 10)).toMatchObject({ status: 'EXECUTING', submitted: 3, total: 3 })
    expect(await coordinator.refreshBlueprintImages('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 3, total: 3 })
    expect(images.operations.size).toBe(operationCount)
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

  test('uses discovered web assets without image generation or budget charge', async () => {
    const found = discovery()
    const { repository, images, budget, coordinator, candidateReviewer } = await fixture(
      100, webSearchBlueprint(), sourceDocument(), found.port, 'SEARCH_FIRST',
    )
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ submitted: 3, total: 3 })
    expect(found.searches).toHaveLength(3)
    expect(found.acquisitions).toHaveLength(3)
    expect(images.operations.size).toBe(0)
    expect(budget.reservations.size).toBe(0)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 0 })
    expect((candidateReviewer as MockAssetCandidateReviewPort).reviews).toHaveLength(3)
    expect(result.steps.every((step) => (step.output as { acquisition?: string })?.acquisition === 'SEARCH_WEB')).toBe(true)
    expect((result.steps[0]!.output as { provenance: { license: string } }).provenance.license).toBe('CC_BY')
    expect((result.steps[0]!.output as { provenance: { selectionReview: { visualScore: number } } })
      .provenance.selectionReview.visualScore).toBe(90)
  })

  test('falls back to AI when downloaded candidates fail the visual quality gate', async () => {
    const found = discovery()
    const reviewer = new MockAssetCandidateReviewPort({
      approved: false,
      textDetected: false,
      visualScore: 45,
      reasons: ['素材存在明显白底并与整套画风冲突'],
      retryInstruction: 'Select a clean asset that matches the requested classroom style.',
    })
    const { images, budget, coordinator } = await fixture(
      100, webSearchBlueprint(), sourceDocument(), found.port, 'SEARCH_FIRST', reviewer,
    )
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ submitted: 3, total: 3 })
    expect(found.acquisitions).toHaveLength(3)
    expect(reviewer.reviews).toHaveLength(3)
    expect(images.operations.size).toBe(3)
    expect(budget.reservations.size).toBe(3)
  })

  test('falls back to AI only for web searches without an acceptable candidate', async () => {
    const missing = discovery(false)
    const { images, budget, coordinator } = await fixture(100, webSearchBlueprint(), sourceDocument(), missing.port, 'SEARCH_FIRST')
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ submitted: 3, total: 3 })
    expect(missing.searches).toHaveLength(3)
    expect(images.operations.size).toBe(3)
    expect(budget.reservations.size).toBe(3)
  })

  test('does not search web assets for AI-first runs', async () => {
    const found = discovery()
    const { images, budget, coordinator } = await fixture(100, webSearchBlueprint(), sourceDocument(), found.port)
    const result = await coordinator.submitBlueprintImages('run-1', 10)

    expect(result).toMatchObject({ submitted: 3, total: 3 })
    expect(found.searches).toHaveLength(0)
    expect(images.operations.size).toBe(3)
    expect(budget.reservations.size).toBe(3)
  })
})

import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  FixedClock,
  MockArtifactPort,
  MockBudgetPort,
  MockImageGenerationPort,
  MockPresentationRendererPort,
  MockVisualReviewPort,
} from '../src/adapters/mock-ports'
import { revisionBlueprintStepKey } from '../src/core/active-blueprint'
import { V4_REVISION_PROMPT_MAX_LENGTH } from '../src/core/blueprint-assets'
import { MediaStepRunner } from '../src/core/media-step-runner'
import { PageReviewCoordinator } from '../src/core/page-review-coordinator'
import { planningStepKey } from '../src/core/planning-runner'
import type { RunRecord } from '../src/core/ports'
import { RevisionMediaCoordinator } from '../src/core/revision-media-coordinator'
import { resumeTechnicalRecovery } from '../src/core/technical-recovery'
import { revisionPlanStepKey } from '../src/core/revision-planning-runner'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { VisualReviewRunner } from '../src/core/visual-review-runner'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-1', requestHash: 'hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是局部重绘协调器使用的完整测试教材。' },
    slideCount: 2, visualDirection: '课堂科学信息图', imageModel: 'image-2',
    automationLevel: 'SUPERVISED', maxRevisionRounds: 2, revisionRound: 1,
    qualityScore: 72, status: 'REVISING', resumeState: null, version: 8,
    budgetUnits: 100, committedBudgetUnits: 20, qualityOverride: false,
    qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null,
    leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  }
}

function blueprint(id: string, corrected = false) {
  return {
    id, title: '光合作用', visualDirection: '课堂科学信息图', createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber, title: pageNumber === 1 ? '认识光合作用' : '条件与产物', body: ['教材内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: `用课堂科学画面表达第 ${pageNumber} 页知识点`,
      visualPrompt: corrected && pageNumber === 2
        ? 'A corrected oxygen release classroom illustration, no text or symbols'
        : `A clean educational science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: ['chunk-1'],
    })),
  }
}

function revisionPlan() {
  return {
    id: 'plan-r1', reviewId: 'review-r0', revisionRound: 1, createdAt: '2026-07-21T00:00:00.000Z',
    summary: '仅重绘第二页存在问题的视觉素材。',
    operations: [{
      id: 'operation-1', slideId: 'run-1:slide:2', kind: 'REGENERATE_IMAGE', issueIds: ['issue-1'],
      instruction: 'Remove the inconsistent object and preserve a clean text-safe area.', sourceChunkIds: ['chunk-1'],
    }],
  }
}

function layeredBlueprint() {
  const base = blueprint('blueprint-r1', true)
  return {
    ...base,
    renderMode: 'LAYERED_COURSEWARE_V3' as const,
    coverDesignMode: 'FOLLOW_TEMPLATE' as const,
    sourceManifest: [],
    sourceAssets: [],
    slides: base.slides.map((slide) => ({
      ...slide,
      sourceAssetIds: [],
      layeredDesign: {
        designKind: slide.pageNumber === 1 ? 'COVER' as const : 'CONTENT' as const,
        backgroundColor: '#EAF7FF',
        elements: [
          {
            kind: 'IMAGE' as const, elementId: `base-${slide.pageNumber}`, role: 'BASE_LAYER' as const,
            knowledgePoint: '建立科学课堂背景', prompt: 'A clean wide science classroom background without text',
            negativePrompt: 'text, logo, watermark', sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
            sourceAssetStrategy: 'REGENERATE' as const,
            placement: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 0,
            fit: 'COVER' as const, aspectRatio: '16:9' as const, backgroundMode: 'OPAQUE' as const,
          },
          {
            kind: 'IMAGE' as const, elementId: `knowledge-${slide.pageNumber}`, role: 'KNOWLEDGE_VISUAL' as const,
            knowledgePoint: '展示光合作用知识对象', prompt: 'A transparent leaf explaining photosynthesis without text',
            negativePrompt: 'text, logo, watermark', sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
            sourceAssetStrategy: 'REGENERATE' as const,
            placement: { x: 0.6, y: 0.2, width: 0.3, height: 0.5 }, zIndex: 2,
            fit: 'CONTAIN' as const, aspectRatio: '1:1' as const, backgroundMode: 'TRANSPARENT' as const,
          },
          {
            kind: 'TEXT' as const, elementId: `title-${slide.pageNumber}`, role: 'TITLE' as const,
            text: slide.title, sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
            placement: { x: 0.08, y: 0.15, width: 0.4, height: 0.15 }, zIndex: 3,
            style: { fontSize: 30, bold: true, color: '#17365D', align: 'LEFT' as const },
          },
        ],
      },
    })),
  }
}

function layeredRevisionPlan() {
  const base = revisionPlan()
  return {
    ...base,
    operations: [{ ...base.operations[0]!, targetElementId: 'knowledge-2' }],
  }
}

function visualDeckV4Blueprint() {
  const source = { kind: 'TEXT' as const, name: '光合作用教材.txt', text: '绿色植物利用光能制造有机物并释放氧气。'.repeat(8) }
  return createVisualDeckV4Blueprint({
    runId: 'run-1', inputHash: 'plan-hash', source,
    document: {
      name: source.name, isComplete: true, missingRanges: [],
      chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
    },
    config: {
      instruction: '制作两页光合作用视觉演示', sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 }, aspectRatio: '16:9',
        audience: '七年级学生', focus: '理解光合作用', styleHint: '课堂科学信息图',
      },
    },
    slideCount: 2, visualDirection: '课堂科学信息图', createdAt: '2026-07-21T00:00:00.000Z',
  })
}

async function fixture(
  overrides: Partial<RunRecord> = {},
  inputs: Readonly<{ blueprint?: unknown; plan?: ReturnType<typeof revisionPlan> }> = {},
) {
  const repository = new InMemoryAgentRepository()
  const budget = new MockBudgetPort()
  const images = new MockImageGenerationPort()
  const artifacts = new MockArtifactPort()
  const renderer = new MockPresentationRendererPort()
  const clock = new FixedClock()
  await repository.createRun(run(overrides))
  await repository.transact('run-1', (transaction) => {
    const put = (id: string, key: string, tool: string, output: unknown, budgetUnits = 0) => transaction.putStep({
      id, runId: 'run-1', idempotencyKey: key, inputHash: `hash-${id}`, tool, status: 'COMPLETED',
      budgetUnits, budgetReservationId: budgetUnits ? `budget-${id}` : null,
      externalOperationId: budgetUnits ? `operation-${id}` : null, errorCode: null, output,
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    put('plan', planningStepKey('run-1'), 'create_blueprint', blueprint('blueprint-r0'))
    put('apply-r1', revisionBlueprintStepKey('run-1', 1), 'apply_revision', inputs.blueprint ?? blueprint('blueprint-r1', true))
    put('revision-plan-r1', revisionPlanStepKey('run-1', 1), 'plan_revision', inputs.plan ?? revisionPlan())
    for (const pageNumber of [1, 2]) put(
      `image-r0-${pageNumber}`,
      `run-1:slide:${pageNumber}:image:r0:v1`,
      'generate_slide_image',
      { slideId: `run-1:slide:${pageNumber}`, versionId: `run-1:slide:${pageNumber}:r0:v1`, artifactId: `artifact-r0-${pageNumber}` },
      10,
    )
  })
  const media = new MediaStepRunner({ repository, budget, images, clock })
  for (const artifactId of ['artifact-r0-1', 'artifact-r0-2', 'artifact-r1-2']) {
    artifacts.artifacts.set(artifactId, {
      mimeType: 'image/png', bytes: new TextEncoder().encode(artifactId), sha256: artifactId.padEnd(64, '0').slice(0, 64),
    })
  }
  return { repository, images, artifacts, renderer, clock, media, coordinator: new RevisionMediaCoordinator({ repository, media, clock }) }
}

describe('revision media coordinator', () => {
  test('redraws only planned pages and returns the revised deck to page review', async () => {
    const { repository, images, artifacts, renderer, clock, coordinator } = await fixture()
    const submitted = await coordinator.submit('run-1', 5)
    const key = 'run-1:slide:2:image:r1:v1'

    expect(submitted).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(images.operations.size).toBe(1)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 25 })
    images.complete(key, 'artifact-r1-2')
    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 1, total: 1 })

    const reviewerPort = new MockVisualReviewPort({
      approved: true, textDetected: false, visualScore: 91, reasons: [], retryInstruction: null,
    })
    const reviewer = new VisualReviewRunner({ repository, reviewer: reviewerPort, clock })
    const pages = new PageReviewCoordinator({ repository, reviewer, artifacts, renderer, clock })
    expect(await pages.reviewAll('run-1')).toMatchObject({ status: 'DECK_REVIEW', approved: 4, total: 4 })
    expect(reviewerPort.reviews.size).toBe(4)
  })

  test('recovers a revision image left in submitting without double-reserving budget', async () => {
    const { repository, images, coordinator } = await fixture()
    await coordinator.submit('run-1', 5)
    const key = 'run-1:slide:2:image:r1:v1'
    await repository.transact('run-1', (transaction) => {
      const step = transaction.getStep(key)!
      transaction.putStep({ ...step, status: 'SUBMITTING', externalOperationId: null })
    })

    const recovered = await coordinator.submit('run-1', 5)

    expect(recovered).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(images.operations.size).toBe(1)
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 25 })
    expect((await repository.listSteps('run-1')).find((step) => step.idempotencyKey === key))
      .toMatchObject({ status: 'WAITING', externalOperationId: expect.any(String) })
  })

  test('recovers a completed V4 page redraw through revision media without resubmitting it', async () => {
    const { repository, images, media, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
    })
    await coordinator.submit('run-1', 5)
    const key = 'run-1:slide:2:image:r1:v1'
    const target = (await repository.listSteps('run-1')).find((step) => step.idempotencyKey === key)!
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'NEEDS_HUMAN', version: transaction.run.version + 1 })
      transaction.putStep({ ...target, status: 'BILLING_UNKNOWN', errorCode: 'RATE_LIMITED' })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'issue-1', category: 'IMAGE_QUALITY', severity: 'WARNING',
          summary: '待重绘页面的视觉问题保留到重新审查。', slideIds: ['run-1:slide:2'], sourceChunkIds: [], status: 'OPEN',
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: `${target.id}:provider-result`, category: 'PROVIDER_RESULT_FAILED', severity: 'CRITICAL',
          summary: '局部重绘查询遇到临时限流。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
        },
      })
    })
    images.statuses.set(target.externalOperationId!, { state: 'PROCESSING' })
    expect(await media.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 0 })

    images.statuses.set(target.externalOperationId!, { state: 'COMPLETED', artifactId: 'artifact-r1-2' })
    expect(await media.reconcilePendingRun('run-1')).toEqual({ inspected: 1, changed: 1 })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'REVISING' })

    const operationCount = images.operations.size
    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 1, total: 1 })
    expect(images.operations.size).toBe(operationCount)
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'phase.changed' && event.payload.from === 'NEEDS_HUMAN' && event.payload.to === 'REVISING')).toBe(true)
  })

  test('pauses before any redraw when the remaining budget is insufficient', async () => {
    const { repository, images, coordinator } = await fixture({
      budgetUnits: 20,
      committedBudgetUnits: 20,
      presentationMode: 'VISUAL_DECK_V4',
    })
    const result = await coordinator.submit('run-1', 5)

    expect(result).toMatchObject({ status: 'PAUSED', submitted: 0, total: 1 })
    expect(images.operations.size).toBe(0)
    expect((await repository.listEvents('run-1')).find((event) => event.type === 'run.paused')).toMatchObject({
      payload: {
        presentationMode: 'VISUAL_DECK_V4', stage: 'RUN', reason: 'BUDGET_INSUFFICIENT',
        retryable: true, requiresUserAction: true, nextAction: 'ADD_BUDGET',
      },
    })
  })

  test('redraws one v3 element using the canonical strategy-aware asset key', async () => {
    const { images, coordinator } = await fixture({}, {
      blueprint: layeredBlueprint(),
      plan: layeredRevisionPlan(),
    })

    const result = await coordinator.submit('run-1', 5)

    expect(result).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(images.operations.size).toBe(1)
    expect([...images.requests.values()][0]).toMatchObject({
      backgroundMode: 'TRANSPARENT',
      prompt: expect.stringContaining('transparent leaf'),
    })
  })

  test('redraws a v4 page with the complete approved brief plus the review correction', async () => {
    const base = visualDeckV4Blueprint()
    const brief = base.visualDeckV4Proposal!.slideBriefs[1]!
    brief.lockedCopy = [...brief.lockedCopy, '权威对象总数：12；6+6=12']
    brief.facts = Array.from(
      { length: 12 },
      (_, index) => `${index === 11 ? '最后一条权威对象总数事实：12' : `来源事实 ${index + 1}`}：${
        '绿色植物利用光能制造有机物并释放氧气。'.repeat(20)
      }`.slice(0, 400),
    )
    brief.numbers = ['12']
    brief.formulas = ['6+6=12']
    const revision = {
      ...revisionPlan(),
      operations: Array.from({ length: 50 }, (_, index) => ({
        ...revisionPlan().operations[0]!,
        id: `operation-${index + 1}`,
        instruction: `Correction ${index + 1}: remove extra mark`,
        sourceChunkIds: ['chunk-1'],
      })),
    }
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: base,
      plan: revision,
    })

    await coordinator.submit('run-1', 5)

    const request = [...images.requests.values()][0]
    expect(request?.prompt).toContain('Create one finished, full-bleed 16:9 presentation slide')
    expect(request?.prompt).toContain(base.visualDeckV4Proposal!.slideBriefs[1]!.title)
    expect(request?.prompt).toContain('Correction 1')
    expect(request?.prompt).toContain('Correction 50')
    expect(request?.prompt).toContain('最后一条权威对象总数事实：12')
    expect(request?.prompt).toContain('Numbers that must appear exactly: 12')
    expect(request?.prompt).toContain('Formulas that must appear exactly: 6+6=12')
    expect(request?.prompt).toContain('COUNTABLE OBJECT SAFETY')
    expect(request?.prompt).toContain('Do not invent any additional labels')
    expect(request?.prompt).toContain('closed visible-text allowlist')
    expect(request?.negativePrompt).toContain('facts-field prose')
    expect(request?.prompt.length).toBeLessThanOrEqual(V4_REVISION_PROMPT_MAX_LENGTH)
    images.complete('run-1:slide:2:image:r1:v1', 'artifact-r1-2')
    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'PAGE_REVIEW', completed: 1, total: 1 })
    const lifecycle = (await repository.listEvents('run-1'))
      .filter((event) => event.type === 'revision.progress' || event.type === 'revision.completed'
        || event.type === 'page_review.started')
    expect(lifecycle.map((event) => event.type)).toEqual([
      'revision.progress', 'revision.completed', 'page_review.started',
    ])
    expect(lifecycle[1]).toMatchObject({
      payload: { revisionKind: 'DECK_VISUAL', pageNumbers: [2], completed: 1, total: 1 },
    })
  })

  test('rejects oversized v4 correction instructions before any paid redraw', async () => {
    const revision = {
      ...revisionPlan(),
      operations: [
        {
          ...revisionPlan().operations[0]!, id: 'operation-a',
          instruction: `${'A'.repeat(1_950)} KEEP_REQUIREMENT_A`,
        },
        {
          ...revisionPlan().operations[0]!, id: 'operation-b',
          instruction: `${'B'.repeat(1_950)} KEEP_REQUIREMENT_B`,
        },
        {
          ...revisionPlan().operations[0]!, id: 'operation-c',
          instruction: `${'C'.repeat(1_950)} KEEP_REQUIREMENT_C`,
        },
      ],
    }
    const { images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revision,
    })

    expect(coordinator.submit('run-1', 5)).rejects.toThrow('V4_REVISION_INSTRUCTION_BUDGET_EXCEEDED')
    expect(images.operations.size).toBe(0)
  })

  test('redraws a v4 page after a source-grounded content correction', async () => {
    const base = visualDeckV4Blueprint()
    const correction = 'Correct the teaching claim from the cited source and redraw the complete page.'
    const revision = {
      ...revisionPlan(),
      operations: [{
        ...revisionPlan().operations[0]!,
        kind: 'UPDATE_CONTENT' as const,
        instruction: correction,
        sourceChunkIds: ['chunk-1'],
      }],
    }
    const { images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: base,
      plan: revision,
    })

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ submitted: 1, total: 1 })
    expect([...images.requests.values()][0]?.prompt).toContain(correction)
  })

  test('carries prior page-review corrections into a later v4 redraw', async () => {
    const currentCorrection = 'Move the teaching objects upward and preserve the approved composition.'
    const priorCorrection = 'Remove the unauthorized Arabic numeral and keep the Chinese copy exact.'
    const revision = {
      ...revisionPlan(),
      operations: [{ ...revisionPlan().operations[0]!, instruction: currentCorrection }],
    }
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revision,
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-prior-page-review', runId: 'run-1',
        idempotencyKey: 'run-1:slide:2:image:r0:v1:review', inputHash: 'prior-review-hash',
        tool: 'review_slide_image', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null,
        output: {
          approved: false, textDetected: true, visualScore: 62,
          reasons: ['页面出现未允许的阿拉伯数字。'], retryInstruction: priorCorrection,
        },
        createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
      })
      transaction.putStep({
        id: 'step-unrelated-page-review', runId: 'run-1',
        idempotencyKey: 'run-1:slide:1:image:r0:v1:review', inputHash: 'unrelated-review-hash',
        tool: 'review_slide_image', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null,
        output: {
          approved: false, textDetected: false, visualScore: 70,
          reasons: ['第一页需要调整。'], retryInstruction: 'Unrelated page-one correction must not trigger a redraw.',
        },
        createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
      })
    })

    await coordinator.submit('run-1', 5)

    const prompt = [...images.requests.values()][0]?.prompt
    expect(prompt).toContain(priorCorrection)
    expect(prompt).toContain(currentCorrection)
    expect(prompt).not.toContain('Unrelated page-one correction')
    expect(images.operations.size).toBe(1)
  })

  test('carries prior deck-review correction operations into a later v4 redraw', async () => {
    const priorCorrection = 'Keep the two-part teaching board consistent across the sequence.'
    const currentCorrection = 'Remove the redundant number rail while preserving the teaching board.'
    const priorPlan = {
      ...revisionPlan(),
      operations: [{ ...revisionPlan().operations[0]!, kind: 'RELAYOUT' as const, instruction: priorCorrection }],
    }
    const { repository, images, coordinator } = await fixture({
      presentationMode: 'VISUAL_DECK_V4', revisionRound: 2, maxRevisionRounds: 4,
    }, {
      blueprint: visualDeckV4Blueprint(),
      plan: priorPlan,
    })
    const currentPlan = {
      ...revisionPlan(),
      id: 'plan-r2', reviewId: 'review-r1', revisionRound: 2,
      operations: [{ ...revisionPlan().operations[0]!, id: 'operation-r2', instruction: currentCorrection }],
    }
    await repository.transact('run-1', (transaction) => {
      const now = transaction.run.updatedAt
      transaction.putStep({
        id: 'apply-r2', runId: 'run-1', idempotencyKey: revisionBlueprintStepKey('run-1', 2),
        inputHash: 'hash-apply-r2', tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: visualDeckV4Blueprint(), createdAt: now, updatedAt: now,
      })
      transaction.putStep({
        id: 'revision-plan-r2', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 2),
        inputHash: 'hash-revision-plan-r2', tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: currentPlan, createdAt: now, updatedAt: now,
      })
      transaction.putStep({
        id: 'future-page-review-r4', runId: 'run-1',
        idempotencyKey: 'run-1:slide:2:image:r4:v1:review', inputHash: 'future-page-review-r4',
        tool: 'review_slide_image', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
        externalOperationId: null, errorCode: null,
        output: {
          approved: false, textDetected: false, visualScore: 50, reasons: ['未来轮孤儿记录。'],
          retryInstruction: 'FUTURE ROUND FOUR INSTRUCTION MUST NOT APPEAR',
        },
        createdAt: now, updatedAt: now,
      })
    })

    await coordinator.submit('run-1', 5)

    const prompt = [...images.requests.values()][0]?.prompt
    expect(prompt).toContain(priorCorrection)
    expect(prompt).toContain(currentCorrection)
    expect(prompt).not.toContain('FUTURE ROUND FOUR INSTRUCTION')
  })

  test('preserves four full page-review instructions without truncating their tails', async () => {
    const currentCorrection = `${'D'.repeat(970)} CURRENT_TAIL`
    const revision = {
      ...revisionPlan(),
      operations: [{ ...revisionPlan().operations[0]!, instruction: currentCorrection }],
    }
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revision,
    })
    await repository.transact('run-1', (transaction) => {
      for (const [index, marker] of ['FIRST_TAIL', 'SECOND_TAIL', 'THIRD_TAIL'].entries()) {
        transaction.putStep({
          id: `step-prior-review-${index}`, runId: 'run-1',
          idempotencyKey: `run-1:slide:2:image:r0:v1:review:${index}`, inputHash: `review-${index}`,
          tool: 'review_slide_image', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
          externalOperationId: null, errorCode: null,
          output: {
            approved: false, textDetected: false, visualScore: 60, reasons: ['需要继续修订。'],
            retryInstruction: `${String.fromCharCode(65 + index).repeat(970)} ${marker}`,
          },
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        })
      }
    })

    await coordinator.submit('run-1', 5)

    const prompt = [...images.requests.values()][0]?.prompt ?? ''
    for (const marker of ['FIRST_TAIL', 'SECOND_TAIL', 'THIRD_TAIL', 'CURRENT_TAIL']) {
      expect(prompt).toContain(marker)
    }
  })

  test('moves a v4 revision to technical recovery when the redraw provider route is unavailable', async () => {
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
    })
    images.failNext('NO_HEALTHY_ROUTE_BEFORE_SUBMIT', 'NOT_SUBMITTED')

    await coordinator.submit('run-1', 5)
    const result = await coordinator.refresh('run-1')

    expect(result.status).toBe('RECOVERING')
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'RECOVERING' })
    expect((await repository.listEvents('run-1')).find((event) => event.type === 'revision.completed'))
      .toMatchObject({
        payload: {
          reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE', retryable: true,
          requiresUserAction: false, nextAction: null,
        },
      })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'technical.recovery.started')).toBe(true)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('resubmits a confirmed-unsubmitted V4 redraw after recovery with the original image key', async () => {
    const { repository, images, clock, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
    })
    const key = 'run-1:slide:2:image:r1:v1'
    images.failNext('NO_HEALTHY_ROUTE_BEFORE_SUBMIT', 'NOT_SUBMITTED')

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'RECOVERING', submitted: 1, total: 1 })
    expect(images.operations.size).toBe(0)
    clock.advance(2_000)
    await repository.transact('run-1', (transaction) => resumeTechnicalRecovery(transaction, clock))

    expect(await coordinator.submit('run-1', 5)).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    expect(images.operations.get(key)).toBeDefined()
    expect(await repository.getRun('run-1')).toMatchObject({ committedBudgetUnits: 25, status: 'REVISING' })
  })

  test('ends a v4 revision once when the submitted redraw later fails', async () => {
    const { repository, images, coordinator } = await fixture({ presentationMode: 'VISUAL_DECK_V4' }, {
      blueprint: visualDeckV4Blueprint(),
      plan: revisionPlan(),
    })
    await coordinator.submit('run-1', 5)
    images.fail('run-1:slide:2:image:r1:v1', 'PROVIDER_REJECTED', 'UNKNOWN')

    expect(await coordinator.refresh('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', completed: 0 })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'NEEDS_HUMAN', committedBudgetUnits: 25,
    })
    const lifecycle = (await repository.listEvents('run-1'))
      .filter((event) => event.type.startsWith('revision.'))
    expect(lifecycle.filter((event) => event.type === 'revision.completed')).toHaveLength(1)
    expect(lifecycle.at(-1)).toMatchObject({
      type: 'revision.completed',
      payload: { reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE', retryable: false },
    })
  })
})

import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  FixedClock,
  MockArtifactPort,
  MockPresentationRendererPort,
  MockVisualReviewPort,
} from '../src/adapters/mock-ports'
import { PageReviewCoordinator } from '../src/core/page-review-coordinator'
import { revisionBlueprintStepKey } from '../src/core/active-blueprint'
import { planningStepKey } from '../src/core/planning-runner'
import type { RunRecord, VisualReviewPort } from '../src/core/ports'
import { StructuredModelError } from '../src/core/ports'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { revisionPlanStepKey } from '../src/core/revision-planning-runner'
import type { PresentationBlueprint } from '../src/presentation-contracts'
import { VisualReviewRunner } from '../src/core/visual-review-runner'
import { resumeTechnicalRecovery } from '../src/core/technical-recovery'
import { generationBatchStepKeyFor } from '../src/core/generation-batch'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于页面质检聚合测试的完整教材内容。' },
    slideCount: 3,
    visualDirection: '清晰的课堂科学信息图风格',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'PAGE_REVIEW',
    resumeState: null,
    version: 5,
    budgetUnits: 100,
    committedBudgetUnits: 30,
    qualityOverride: false,
    qualityOverrideReason: null,
    qualityOverrideBy: null,
    leaseToken: null,
    leaseUntil: null,
    leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  }
}

function blueprint() {
  return {
    id: 'blueprint-1',
    title: '光合作用',
    visualDirection: '清晰的课堂科学信息图风格',
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2, 3].map((pageNumber) => ({
      pageNumber,
      title: `第 ${pageNumber} 页`,
      body: ['教学内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: `第 ${pageNumber} 页对应的教材视觉目标`,
      visualPrompt: `A clean science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: ['chunk-1'],
    })),
  }
}

function visualDeckV4Blueprint() {
  const source = {
    kind: 'TEXT' as const,
    name: '分与合教材.txt',
    text: '把五只小鸟分成两组，记录每一种分法，并检查合起来仍然是五只。'.repeat(8),
  }
  return createVisualDeckV4Blueprint({
    runId: 'run-1', inputHash: 'plan-hash', source,
    document: {
      name: source.name,
      chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
      isComplete: true,
      missingRanges: [],
    },
    config: {
      instruction: '制作三页讲解5以内数的分与合的视觉PPT',
      sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 3 }, aspectRatio: '16:9',
        audience: '幼儿园大班学生', focus: '理解5的分与合', styleHint: '明亮清晰的儿童课堂信息图',
      },
    },
    slideCount: 3,
    visualDirection: '明亮清晰的儿童课堂信息图',
    createdAt: '2026-07-21T00:00:00.000Z',
  })
}

async function fixture(options: Readonly<{
  reviewerPort?: VisualReviewPort
  reviewConcurrency?: number
  runOverrides?: Partial<RunRecord>
  plannedBlueprint?: PresentationBlueprint
  onReviewCompleted?: () => void
}> = {}) {
  const repository = new InMemoryAgentRepository()
  const reviewerPort = options.reviewerPort ?? new MockVisualReviewPort({
    approved: true,
    textDetected: false,
    visualScore: 90,
    reasons: [],
    retryInstruction: null,
  })
  const clock = new FixedClock()
  const artifacts = new MockArtifactPort()
  const renderer = new MockPresentationRendererPort()
  const sourceArtifacts = await Promise.all([1, 2, 3].map((pageNumber) => artifacts.put({
    tenantId: 'frameflow', runId: 'run-1', name: `slide-${pageNumber}.png`, mimeType: 'image/png',
    bytes: new TextEncoder().encode(`source-${pageNumber}`), idempotencyKey: `source-${pageNumber}`,
  })))
  await repository.createRun(run(options.runOverrides))
  await repository.transact('run-1', (transaction) => {
    transaction.putStep({
      id: 'step-plan', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'plan-hash',
      tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: options.plannedBlueprint ?? blueprint(),
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    for (const pageNumber of [1, 2, 3]) {
      transaction.putStep({
        id: `step-image-${pageNumber}`,
        runId: 'run-1',
        idempotencyKey: `run-1:slide:${pageNumber}:image:r0:v1`,
        inputHash: `image-hash-${pageNumber}`,
        tool: 'generate_slide_image',
        status: 'COMPLETED',
        budgetUnits: 10,
        budgetReservationId: `budget-${pageNumber}`,
        externalOperationId: `operation-${pageNumber}`,
        errorCode: null,
        output: {
          slideId: `run-1:slide:${pageNumber}`,
          versionId: `run-1:slide:${pageNumber}:r0:v1`,
          artifactId: sourceArtifacts[pageNumber - 1]!.artifactId,
        },
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    }
    if (transaction.run.presentationMode === 'VISUAL_DECK_V4') {
      transaction.putStep({
        id: 'step-generation-batch-r0', runId: 'run-1',
        idempotencyKey: generationBatchStepKeyFor('run-1', { revisionRound: 0, scope: 'INITIAL' }),
        inputHash: 'generation-batch-r0-hash', tool: 'generate_image_batch', status: 'COMPLETED',
        budgetUnits: 30, budgetReservationId: 'batch-reservation-r0', externalOperationId: null,
        errorCode: null,
        output: {
          batchId: `genbatch_${'a'.repeat(32)}`, proposalHash: 'a'.repeat(64), revisionRound: 0,
          submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS', pageCount: 3,
          pages: [1, 2, 3].map((pageNumber) => ({
            pageNumber, idempotencyKey: `run-1:slide:${pageNumber}:image:r0:v1`, promptHash: String(pageNumber).repeat(64),
          })),
          accounting: {
            estimatedUnits: 30, committedUnits: 30, settledUnits: 30, releasedUnits: 0,
            reconciliationUnits: 0, authorization: 'RESERVED', settlement: 'SETTLED',
          },
          progress: { submitted: 3, completed: 3, failed: 0 }, status: 'COMPLETED',
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
    }
  })
  const reviewer = new VisualReviewRunner({ repository, reviewer: reviewerPort, clock })
    return {
      repository,
      clock,
      reviewerPort,
    artifacts,
    renderer,
    coordinator: new PageReviewCoordinator({
      repository,
      reviewer,
      artifacts,
      renderer,
      clock,
      ...(options.onReviewCompleted ? { onReviewCompleted: options.onReviewCompleted } : {}),
      ...(options.reviewConcurrency === undefined ? {} : { reviewConcurrency: options.reviewConcurrency }),
    }),
  }
}

describe('page review coordinator', () => {
  test('reports worker activity after each completed page review', async () => {
    let completed = 0
    const { coordinator } = await fixture({ onReviewCompleted: () => { completed += 1 } })

    const result = await coordinator.reviewAll('run-1')

    expect(result).toMatchObject({ status: 'DECK_REVIEW', approved: 6, total: 6 })
    expect(completed).toBe(6)
  })

  test('moves to deck review only when every page is approved', async () => {
    const { repository, reviewerPort, renderer, coordinator } = await fixture()
    const result = await coordinator.reviewAll('run-1')

    expect(result).toMatchObject({ status: 'DECK_REVIEW', approved: 6, rejected: 0, total: 6 })
    expect((reviewerPort as MockVisualReviewPort).reviews.size).toBe(6)
    expect(renderer.slidePreviewCalls).toBe(1)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'DECK_REVIEW', version: 6 })
  })

  test('stops for human approval when one page is rejected without creating media', async () => {
    const { repository, reviewerPort, coordinator } = await fixture()
    const imageStep = (await repository.listSteps('run-1')).find((step) => step.id === 'step-image-2')!
    const artifactId = (imageStep.output as { artifactId: string }).artifactId
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact(artifactId, {
      approved: false,
      textDetected: true,
      visualScore: 35,
      reasons: ['图片中出现可读文字'],
      retryInstruction: 'Remove all text, letters, numbers, logos and watermarks from the image.',
    })
    const result = await coordinator.reviewAll('run-1')

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', approved: 2, rejected: 1, total: 6 })
    expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'generate_slide_image')).toHaveLength(3)
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toContain('approval.required')
  })

  test('creates a bounded page-only revision plan for rejected v4 pages', async () => {
    const planned = visualDeckV4Blueprint()
    const { repository, reviewerPort, coordinator } = await fixture({
      plannedBlueprint: planned,
      runOverrides: {
        source: { kind: 'TEXT', name: '分与合教材.txt', text: '把五只小鸟分成两组，记录每一种分法，并检查合起来仍然是五只。'.repeat(8) },
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: {
          instruction: '制作三页讲解5以内数的分与合的视觉PPT',
          sourceMode: 'SOURCE_GROUNDED',
          deckOptions: {
            deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 3 }, aspectRatio: '16:9',
            audience: '幼儿园大班学生', focus: '理解5的分与合', styleHint: '明亮清晰的儿童课堂信息图',
          },
        },
        automationLevel: 'BOUNDED_AUTO',
      },
    })
    const imageStep = (await repository.listSteps('run-1')).find((step) => step.id === 'step-image-2')!
    const artifactId = (imageStep.output as { artifactId: string }).artifactId
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact(artifactId, {
      approved: false,
      textDetected: true,
      visualScore: 52,
      reasons: ['标题中的数字2被错误写成“两”'],
      retryInstruction: 'Keep all allowed copy unchanged and render the Arabic numeral 2 exactly.',
    })

    const result = await coordinator.reviewAll('run-1')

    expect(result).toMatchObject({ status: 'REVISING', approved: 2, rejected: 1, total: 3 })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'REVISING', revisionRound: 1 })
    const planStep = (await repository.listSteps('run-1'))
      .find((step) => step.idempotencyKey === revisionPlanStepKey('run-1', 1))
    expect(planStep).toMatchObject({
      tool: 'plan_page_revision',
      status: 'COMPLETED',
      output: {
        revisionRound: 1,
        operations: [{
          slideId: 'run-1:slide:2',
          kind: 'REGENERATE_IMAGE',
          issueIds: ['step-image-2:review:visual-review'],
          instruction: 'Keep all allowed copy unchanged and render the Arabic numeral 2 exactly.',
        }],
      },
    })
    const requests = [...(reviewerPort as MockVisualReviewPort).requests.values()]
    expect(requests[1]?.visualIntent).toContain(`允许文字：${planned.slides[1]!.title}`)
    expect(requests[1]?.visualIntent).toContain('非展示事实核对项')
    expect(requests[1]?.visualIntent).toContain(planned.visualDeckV4Proposal!.slideBriefs[1]!.facts[0]!)
    const lifecycle = (await repository.listEvents('run-1'))
      .filter((event) => event.type === 'page_review.completed' || event.type === 'revision.started')
    expect(lifecycle).toHaveLength(2)
    expect(lifecycle[0]).toMatchObject({
      type: 'page_review.completed',
      payload: { completed: 3, total: 3, reason: 'PAGE_REVIEW_REJECTED' },
    })
    expect(lifecycle[1]).toMatchObject({
      type: 'revision.started',
      payload: {
        revisionKind: 'PAGE_VISUAL', revisionRound: 1, maxRevisionRounds: 2,
        pageNumbers: [2], completed: 0, total: 1,
      },
    })
  })

  test('keeps a rejected supervised v4 page behind internal review when automatic revision is disabled', async () => {
    const planned = visualDeckV4Blueprint()
    const { repository, reviewerPort, coordinator } = await fixture({
      plannedBlueprint: planned,
      runOverrides: {
        presentationMode: 'VISUAL_DECK_V4',
        automationLevel: 'SUPERVISED',
        maxRevisionRounds: 0,
      },
    })
    const imageStep = (await repository.listSteps('run-1')).find((step) => step.id === 'step-image-2')!
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact((imageStep.output as { artifactId: string }).artifactId, {
      approved: false,
      textDetected: false,
      visualScore: 55,
      reasons: ['第二页构图需要内部复核。'],
      retryInstruction: 'Remove the duplicated countable objects on page two.',
    })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'NEEDS_HUMAN', rejected: 1 })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'NEEDS_HUMAN',
      qualityOverride: false,
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'approval.required')).toBe(true)
    expect(events.some((event) => event.type === 'issue.resolved'
      && event.payload.resolution === 'ACCEPTED')).toBe(false)
  })

  test('accepts quality findings and continues to deck review when v4 remediation is disabled', async () => {
    const planned = visualDeckV4Blueprint()
    const { repository, reviewerPort, coordinator } = await fixture({
      plannedBlueprint: planned,
      runOverrides: {
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO',
        revisionRound: 0, maxRevisionRounds: 0,
      },
    })
    const imageStep = (await repository.listSteps('run-1')).find((step) => step.id === 'step-image-2')!
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact((imageStep.output as { artifactId: string }).artifactId, {
      approved: false, textDetected: false, visualScore: 78,
      reasons: ['第二页视觉间距仍可优化，但不影响事实、来源或课堂使用。'],
      retryInstruction: 'Increase the spacing between the two complete object groups without changing their count.',
      qualityImpact: 'NON_BLOCKING_RECOMMENDATION',
    })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'DECK_REVIEW', rejected: 1 })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'DECK_REVIEW', revisionRound: 0, qualityDisposition: 'PENDING',
      qualityOverride: false, qualityPolicyAudit: null,
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'issue.resolved'
      && event.payload.resolution === 'ACCEPTED')).toBe(false)
    expect(events.find((event) => event.type === 'page_review.completed')).toMatchObject({
      payload: { reason: 'PAGE_REVIEW_REJECTED', retryable: false },
    })
    expect(events.at(-1)).toMatchObject({ type: 'deck_review.started' })
  })

  test('fails instead of policy-accepting a rejected page without an explicit non-blocking classification', async () => {
    const planned = visualDeckV4Blueprint()
    const { repository, reviewerPort, coordinator } = await fixture({
      plannedBlueprint: planned,
      runOverrides: {
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO',
        revisionRound: 0, maxRevisionRounds: 0,
      },
    })
    const imageStep = (await repository.listSteps('run-1')).find((step) => step.id === 'step-image-2')!
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact((imageStep.output as { artifactId: string }).artifactId, {
      approved: false, textDetected: false, visualScore: 55,
      reasons: ['第二页的对象数量与教材事实矛盾，阻断课堂使用。'],
      retryInstruction: 'Render exactly five countable objects and preserve the source-grounded grouping relationship.',
    })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'FAILED', rejected: 1 })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'FAILED', qualityDisposition: 'HARD_FAILURE', qualityOverride: false,
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'delivery.started')).toBe(false)
    expect(events.some((event) => event.type === 'issue.resolved'
      && event.payload.resolution === 'ACCEPTED')).toBe(false)
  })

  test('keeps prior issues open while a redraw still fails and resolves them after the page passes', async () => {
    const planned = visualDeckV4Blueprint()
    const { repository, reviewerPort, artifacts, coordinator } = await fixture({
      plannedBlueprint: planned,
      runOverrides: {
        presentationMode: 'VISUAL_DECK_V4',
        automationLevel: 'BOUNDED_AUTO',
      },
    })
    const original = (await repository.listSteps('run-1')).find((step) => step.id === 'step-image-2')!
    const originalArtifactId = (original.output as { artifactId: string }).artifactId
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact(originalArtifactId, {
      approved: false,
      textDetected: true,
      visualScore: 40,
      reasons: ['页面出现额外文字。'],
      retryInstruction: 'Remove the extra copy and preserve only the approved title.',
    })
    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'REVISING', rejected: 1 })

    const revisedArtifact = await artifacts.put({
      tenantId: 'frameflow', runId: 'run-1', name: 'slide-2-r1.png', mimeType: 'image/png',
      bytes: new TextEncoder().encode('revised-slide-2'), idempotencyKey: 'revised-slide-2',
    })
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact(revisedArtifact.artifactId, {
      approved: false,
      textDetected: true,
      visualScore: 55,
      reasons: ['修订页仍有未授权标签。'],
      retryInstruction: 'Remove the remaining unauthorized label and keep the approved copy unchanged.',
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-apply-r1', runId: 'run-1', idempotencyKey: revisionBlueprintStepKey('run-1', 1),
        inputHash: 'apply-r1-hash', tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: { ...planned, id: 'blueprint-r1' },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-image-2-r1', runId: 'run-1', idempotencyKey: 'run-1:slide:2:image:r1:v1',
        inputHash: 'image-r1-hash', tool: 'generate_slide_image', status: 'COMPLETED', budgetUnits: 1,
        budgetReservationId: 'budget-r1', externalOperationId: 'operation-r1', errorCode: null,
        output: {
          slideId: 'run-1:slide:2', versionId: 'run-1:slide:2:r1:v1', artifactId: revisedArtifact.artifactId,
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putRun({
        ...transaction.run,
        status: 'PAGE_REVIEW',
        revisionRound: 1,
        version: transaction.run.version + 1,
      })
    })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'REVISING', rejected: 1 })
    expect((await repository.listEvents('run-1')).filter((event) => event.type === 'issue.resolved')).toHaveLength(0)

    const finalArtifact = await artifacts.put({
      tenantId: 'frameflow', runId: 'run-1', name: 'slide-2-r2.png', mimeType: 'image/png',
      bytes: new TextEncoder().encode('final-slide-2'), idempotencyKey: 'final-slide-2',
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-apply-r2', runId: 'run-1', idempotencyKey: revisionBlueprintStepKey('run-1', 2),
        inputHash: 'apply-r2-hash', tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: { ...planned, id: 'blueprint-r2' },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-image-2-r2', runId: 'run-1', idempotencyKey: 'run-1:slide:2:image:r2:v1',
        inputHash: 'image-r2-hash', tool: 'generate_slide_image', status: 'COMPLETED', budgetUnits: 1,
        budgetReservationId: 'budget-r2', externalOperationId: 'operation-r2', errorCode: null,
        output: {
          slideId: 'run-1:slide:2', versionId: 'run-1:slide:2:r2:v1', artifactId: finalArtifact.artifactId,
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putRun({
        ...transaction.run,
        status: 'PAGE_REVIEW',
        revisionRound: 2,
        version: transaction.run.version + 1,
      })
    })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'DECK_REVIEW', rejected: 0 })
    const resolved = (await repository.listEvents('run-1')).filter((event) => event.type === 'issue.resolved')
    expect(resolved).toHaveLength(2)
    expect(resolved.find((event) => event.type === 'issue.resolved'
      && event.payload.issueId === 'step-image-2:review:visual-review')).toMatchObject({
      payload: { issueId: 'step-image-2:review:visual-review', resolution: 'FIXED' },
    })
  })

  test('resolves only the planned issue when multiple issues target one page', async () => {
    const planned = visualDeckV4Blueprint()
    const { repository, reviewerPort, artifacts, coordinator } = await fixture({
      plannedBlueprint: planned,
      runOverrides: {
        presentationMode: 'VISUAL_DECK_V4',
        automationLevel: 'BOUNDED_AUTO',
      },
    })
    const original = (await repository.listSteps('run-1')).find((step) => step.id === 'step-image-2')!
    const originalArtifactId = (original.output as { artifactId: string }).artifactId
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact(originalArtifactId, {
      approved: false,
      textDetected: true,
      visualScore: 40,
      reasons: ['页面出现未授权文字。'],
      retryInstruction: 'Remove the unauthorized text and keep the approved copy unchanged.',
    })
    await coordinator.reviewAll('run-1')
    await repository.transact('run-1', (transaction) => {
      transaction.appendEvent({
        schemaVersion: '1',
        type: 'issue.detected',
        payload: {
          id: 'independent-image-quality-issue',
          category: 'IMAGE_QUALITY',
          severity: 'WARNING',
          summary: '同一页面还有未纳入本轮计划的独立清晰度问题。',
          slideIds: ['run-1:slide:2'],
          sourceChunkIds: [],
          status: 'OPEN',
        },
      })
    })
    const revisedArtifact = await artifacts.put({
      tenantId: 'frameflow', runId: 'run-1', name: 'slide-2-r1.png', mimeType: 'image/png',
      bytes: new TextEncoder().encode('revised-slide-2'), idempotencyKey: 'revised-slide-2',
    })
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact(revisedArtifact.artifactId, {
      approved: true,
      textDetected: false,
      visualScore: 92,
      reasons: [],
      retryInstruction: null,
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-apply-r1', runId: 'run-1', idempotencyKey: revisionBlueprintStepKey('run-1', 1),
        inputHash: 'apply-r1-hash', tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: { ...planned, id: 'blueprint-r1' },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-image-2-r1', runId: 'run-1', idempotencyKey: 'run-1:slide:2:image:r1:v1',
        inputHash: 'image-r1-hash', tool: 'generate_slide_image', status: 'COMPLETED', budgetUnits: 1,
        budgetReservationId: 'budget-r1', externalOperationId: 'operation-r1', errorCode: null,
        output: {
          slideId: 'run-1:slide:2', versionId: 'run-1:slide:2:r1:v1', artifactId: revisedArtifact.artifactId,
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putRun({
        ...transaction.run,
        status: 'PAGE_REVIEW',
        revisionRound: 1,
        version: transaction.run.version + 1,
      })
    })

    await coordinator.reviewAll('run-1')
    const resolvedIds = (await repository.listEvents('run-1'))
      .filter((event) => event.type === 'issue.resolved')
      .map((event) => event.payload.issueId)
    expect(resolvedIds).toContain('step-image-2:review:visual-review')
    expect(resolvedIds).not.toContain('independent-image-quality-issue')
  })

  test('accepts the current page when cumulative v4 instructions cannot fit another bounded revision', async () => {
    const planned = visualDeckV4Blueprint()
    const { repository, reviewerPort, artifacts, coordinator } = await fixture({
      plannedBlueprint: planned,
      runOverrides: {
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO',
        revisionRound: 1, maxRevisionRounds: 4, committedBudgetUnits: 31,
      },
    })
    const revisedArtifact = await artifacts.put({
      tenantId: 'frameflow', runId: 'run-1', name: 'slide-2-r1.png', mimeType: 'image/png',
      bytes: new TextEncoder().encode('revised-slide-2-over-budget'), idempotencyKey: 'revised-slide-2-over-budget',
    })
    ;(reviewerPort as MockVisualReviewPort).respondToArtifact(revisedArtifact.artifactId, {
      approved: false, textDetected: false, visualScore: 76,
      reasons: ['页面仍有非阻断的视觉复杂度优化建议。'],
      retryInstruction: 'C'.repeat(1_000),
      qualityImpact: 'NON_BLOCKING_RECOMMENDATION',
    })
    await repository.transact('run-1', (transaction) => {
      const now = transaction.run.updatedAt
      transaction.putStep({
        id: 'step-apply-r1', runId: 'run-1', idempotencyKey: revisionBlueprintStepKey('run-1', 1),
        inputHash: 'apply-r1-hash', tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: { ...planned, id: 'blueprint-r1' }, createdAt: now, updatedAt: now,
      })
      transaction.putStep({
        id: 'step-prior-plan-r1', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 1),
        inputHash: 'prior-plan-r1-hash', tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: {
          id: 'prior-plan-r1', reviewId: 'review-r0', revisionRound: 1, createdAt: now,
          summary: '上一轮包含两项必须无损保留的视觉修复要求。',
          operations: [1, 2].map((index) => ({
            id: `prior-operation-${index}`, slideId: 'run-1:slide:2', kind: 'RELAYOUT',
            issueIds: [`prior-issue-${index}`], instruction: String(index).repeat(2_000), sourceChunkIds: [],
          })),
        },
        createdAt: now, updatedAt: now,
      })
      transaction.putStep({
        id: 'step-image-2-r1', runId: 'run-1', idempotencyKey: 'run-1:slide:2:image:r1:v1',
        inputHash: 'image-r1-hash', tool: 'generate_slide_image', status: 'COMPLETED', budgetUnits: 1,
        budgetReservationId: 'budget-r1', externalOperationId: 'operation-r1', errorCode: null,
        output: {
          slideId: 'run-1:slide:2', versionId: 'run-1:slide:2:r1:v1', artifactId: revisedArtifact.artifactId,
        },
        createdAt: now, updatedAt: now,
      })
      transaction.putStep({
        id: 'step-revision-generation-batch-r1', runId: 'run-1',
        idempotencyKey: generationBatchStepKeyFor('run-1', { revisionRound: 1, scope: 'REVISION' }),
        inputHash: 'revision-generation-batch-r1-hash', tool: 'generate_image_batch', status: 'COMPLETED',
        budgetUnits: 1, budgetReservationId: 'batch-reservation-r1', externalOperationId: null,
        errorCode: null,
        output: {
          batchId: `genbatch_${'b'.repeat(32)}`, proposalHash: 'b'.repeat(64), revisionRound: 1,
          submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS', pageCount: 1,
          pages: [{ pageNumber: 1, idempotencyKey: 'run-1:slide:2:image:r1:v1', promptHash: '2'.repeat(64) }],
          accounting: {
            estimatedUnits: 1, committedUnits: 1, settledUnits: 1, releasedUnits: 0,
            reconciliationUnits: 0, authorization: 'RESERVED', settlement: 'SETTLED',
          },
          progress: { submitted: 1, completed: 1, failed: 0 }, status: 'COMPLETED',
          createdAt: now, updatedAt: now,
        },
        createdAt: now, updatedAt: now,
      })
    })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'DECK_REVIEW', rejected: 1 })
    expect((await repository.listSteps('run-1')).some((step) =>
      step.idempotencyKey === revisionPlanStepKey('run-1', 2))).toBe(false)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'revision.started')).toBe(false)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'issue.resolved' && event.payload.resolution === 'ACCEPTED')).toBe(false)
  })

  test('replays a completed page-review phase without model calls', async () => {
    const { reviewerPort, coordinator } = await fixture()
    const first = await coordinator.reviewAll('run-1')
    const replay = await coordinator.reviewAll('run-1')

    expect(replay).toMatchObject({ status: 'DECK_REVIEW', approved: 6, total: 6 })
    expect(first.approved).toBe(replay.approved)
    expect((reviewerPort as MockVisualReviewPort).reviews.size).toBe(6)
  })

  test('runs visual reviews with configured bounded concurrency', async () => {
    let active = 0
    let maximumActive = 0
    let calls = 0
    const reviewerPort: VisualReviewPort = {
      async review() {
        calls += 1
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return { approved: true, textDetected: false, visualScore: 90, reasons: [], retryInstruction: null }
      },
    }
    const { coordinator } = await fixture({ reviewerPort, reviewConcurrency: 2 })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'DECK_REVIEW', approved: 6 })
    expect(calls).toBe(6)
    expect(maximumActive).toBe(2)
  })

  test('emits one human-review transition when concurrent visual reviews fail', async () => {
    const reviewerPort: VisualReviewPort = {
      async review() {
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error('injected review failure')
      },
    }
    const { repository, coordinator } = await fixture({ reviewerPort, reviewConcurrency: 3 })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
    const events = await repository.listEvents('run-1')
    const transitions = events.filter((event) => event.type === 'phase.changed')
    expect(transitions).toHaveLength(1)
    expect(transitions[0]?.payload).toMatchObject({ from: 'PAGE_REVIEW', to: 'NEEDS_HUMAN' })
    expect(events.filter((event) => event.type === 'approval.required')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'page_review.completed')).toHaveLength(0)
  })

  test('reports every affected v4 page when concurrent visual reviews fail', async () => {
    const reviewerPort: VisualReviewPort = {
      async review() {
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error('injected review failure')
      },
    }
    const { repository, coordinator } = await fixture({
      reviewerPort,
      reviewConcurrency: 3,
      plannedBlueprint: visualDeckV4Blueprint(),
      runOverrides: { presentationMode: 'VISUAL_DECK_V4' },
    })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'RECOVERING' })
    const completed = (await repository.listEvents('run-1'))
      .filter((event) => event.type === 'page_review.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      payload: {
        completed: 0, total: 3, pageNumbers: [1, 2, 3],
        reason: 'PAGE_REVIEW_FAILED', retryable: true,
        requiresUserAction: false, nextAction: null,
      },
    })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'technical.recovery.started')).toBe(true)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('prioritizes an execution failure over content rejections in the same v4 batch', async () => {
    let calls = 0
    const reviewerPort: VisualReviewPort = {
      async review() {
        calls += 1
        if (calls === 1) {
          return {
            approved: false,
            textDetected: false,
            visualScore: 72,
            reasons: ['构图需要局部调整'],
            retryInstruction: 'Keep the approved copy and simplify the composition.',
          }
        }
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', false, 'gpt-5.6', 'page-review-2')
      },
    }
    const { repository, coordinator } = await fixture({
      reviewerPort,
      reviewConcurrency: 1,
      plannedBlueprint: visualDeckV4Blueprint(),
      runOverrides: {
        presentationMode: 'VISUAL_DECK_V4',
        automationLevel: 'BOUNDED_AUTO',
      },
    })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({
      status: 'RECOVERING', approved: 0, rejected: 1, total: 3,
    })
    const events = await repository.listEvents('run-1')
    expect(events.filter((event) => event.type === 'phase.changed')).toHaveLength(1)
    expect(events.some((event) => event.type === 'revision.started')).toBe(false)
    expect((await repository.listSteps('run-1')).some((step) => step.tool === 'plan_page_revision')).toBe(false)
    expect(events.find((event) => event.type === 'page_review.completed')?.payload).toMatchObject({
      completed: 1,
      total: 3,
      reason: 'PAGE_REVIEW_FAILED',
      retryable: true,
    })
  })

  test('resumes failed V4 review work and preserves prior rejected pages for automatic revision', async () => {
    let calls = 0
    const reviewerPort: VisualReviewPort = {
      async review() {
        calls += 1
        if (calls === 1) {
          return {
            approved: false,
            textDetected: false,
            visualScore: 72,
            reasons: ['第一页构图需要调整'],
            retryInstruction: 'Keep the approved copy and simplify the composition.',
          }
        }
        if (calls === 2) throw new StructuredModelError('PROVIDER_UNAVAILABLE', false, 'gpt-5.6', 'page-review-2')
        return { approved: true, textDetected: false, visualScore: 90, reasons: [], retryInstruction: null }
      },
    }
    const { repository, clock, coordinator } = await fixture({
      reviewerPort,
      reviewConcurrency: 1,
      plannedBlueprint: visualDeckV4Blueprint(),
      runOverrides: { presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO' },
    })

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'RECOVERING', rejected: 1, total: 3 })
    clock.advance(2_000)
    await repository.transact('run-1', (transaction) => resumeTechnicalRecovery(transaction, clock))

    expect(await coordinator.reviewAll('run-1')).toMatchObject({ status: 'REVISING', rejected: 1, total: 3 })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'REVISING', revisionRound: 1 })
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'plan_page_revision'))
      .toMatchObject({ output: { operations: [expect.objectContaining({ slideId: 'run-1:slide:1' })] } })
  })
})

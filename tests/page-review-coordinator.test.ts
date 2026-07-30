import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  FixedClock,
  MockArtifactPort,
  MockPresentationRendererPort,
  MockVisualReviewPort,
} from '../src/adapters/mock-ports'
import { PageReviewCoordinator } from '../src/core/page-review-coordinator'
import { planningStepKey } from '../src/core/planning-runner'
import type { RunRecord, VisualReviewPort } from '../src/core/ports'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { revisionPlanStepKey } from '../src/core/revision-planning-runner'
import type { PresentationBlueprint } from '../src/presentation-contracts'
import { VisualReviewRunner } from '../src/core/visual-review-runner'

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
  })
  const reviewer = new VisualReviewRunner({ repository, reviewer: reviewerPort, clock })
  return {
    repository,
    reviewerPort,
    renderer,
    coordinator: new PageReviewCoordinator({
      repository,
      reviewer,
      artifacts,
      renderer,
      clock,
      ...(options.reviewConcurrency === undefined ? {} : { reviewConcurrency: options.reviewConcurrency }),
    }),
  }
}

describe('page review coordinator', () => {
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
          instruction: 'Keep all allowed copy unchanged and render the Arabic numeral 2 exactly.',
        }],
      },
    })
    const requests = [...(reviewerPort as MockVisualReviewPort).requests.values()]
    expect(requests[1]?.visualIntent).toContain(`允许文字：${planned.slides[1]!.title}`)
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
  })
})

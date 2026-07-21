import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockArtifactPort, MockDeckReviewPort, MockPresentationRendererPort } from '../src/adapters/mock-ports'
import { DeckReviewRunner } from '../src/core/deck-review-runner'
import { planningStepKey } from '../src/core/planning-runner'
import type { DocumentPort, DocumentResult, RunRecord } from '../src/core/ports'

function run(): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于整套课件质量评估测试的完整教材内容。' },
    slideCount: 2,
    visualDirection: '清晰的课堂科学信息图风格',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'DECK_REVIEW',
    resumeState: null,
    version: 5,
    budgetUnits: 100,
    committedBudgetUnits: 20,
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
      learningObjectives: ['理解光合作用'],
      scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [],
      sourceChunkIds: ['chunk-1', 'chunk-2'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: `第 ${pageNumber} 页`,
      body: ['教学内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: `第 ${pageNumber} 页对应的教材视觉目标`,
      visualPrompt: `A clean science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: [`chunk-${pageNumber}`],
    })),
  }
}

function document(): DocumentResult {
  return {
    name: '光合作用教材.txt',
    chunks: [
      { id: 'chunk-1', text: '绿色植物利用光能制造有机物。', sha256: 'sha-1' },
      { id: 'chunk-2', text: '光合作用释放氧气。', sha256: 'sha-2' },
    ],
    isComplete: true,
    missingRanges: [],
  }
}

function passingReview() {
  return {
    qualityScore: 88,
    curriculumCoverageScore: 92,
    narrativeCoherenceScore: 87,
    visualConsistencyScore: 85,
    compositionScore: 88,
    summary: '整套课件覆盖教材要点，叙事和视觉节奏符合交付要求。',
    reviewedSourceChunkIds: ['chunk-1', 'chunk-2'],
    issues: [],
  }
}

class StaticDocumentPort implements DocumentPort {
  constructor(public result: DocumentResult) {}
  async resolve() { return structuredClone(this.result) }
}

async function fixture(response: unknown = passingReview()) {
  const repository = new InMemoryAgentRepository()
  const documents = new StaticDocumentPort(document())
  const reviewer = new MockDeckReviewPort(response)
  const artifacts = new MockArtifactPort()
  const renderer = new MockPresentationRendererPort()
  const sourceArtifacts = await Promise.all([1, 2].map((pageNumber) => artifacts.put({
    tenantId: 'frameflow', runId: 'run-1', name: `slide-${pageNumber}.png`, mimeType: 'image/png',
    bytes: new TextEncoder().encode(`source-${pageNumber}`), idempotencyKey: `source-${pageNumber}`,
  })))
  await repository.createRun(run())
  await repository.transact('run-1', (transaction) => {
    transaction.putStep({
      id: 'step-plan', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'plan-hash',
      tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: blueprint(),
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    for (const pageNumber of [1, 2]) {
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
  return {
    repository,
    documents,
    reviewer,
    artifacts,
    renderer,
    runner: new DeckReviewRunner({ repository, documents, reviewer, artifacts, renderer, clock: new FixedClock() }),
  }
}

describe('deck review runner', () => {
  test('evaluates ordered controlled artifacts and enters delivery after the fixed quality gate passes', async () => {
    const { repository, reviewer, renderer, runner } = await fixture()
    const result = await runner.review('run-1')

    expect(result).toMatchObject({ passed: true, replayed: false, review: { qualityScore: 88 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'DELIVERING', qualityScore: 88, version: 6 })
    const request = [...reviewer.requests.values()][0]!
    expect(request.slides.map((slide) => slide.artifactId)).toEqual([
      'artifact:frameflow:run-1:deck-review:r0:slide:1:composite',
      'artifact:frameflow:run-1:deck-review:r0:slide:2:composite',
    ])
    expect(renderer.slidePreviewCalls).toBe(1)
    expect(request.sourceChunks.map((chunk) => chunk.id)).toEqual(['chunk-1', 'chunk-2'])
  })

  test('persists a low score and issues without creating media or advancing the phase', async () => {
    const { repository, runner } = await fixture({
      ...passingReview(),
      qualityScore: 72,
      issues: [{
        id: 'issue-deck-1',
        category: 'SEQUENCE_BREAK',
        severity: 'WARNING',
        summary: '第一页到第二页之间缺少条件与结果的叙事连接。',
        slideIds: ['run-1:slide:1', 'run-1:slide:2'],
        sourceChunkIds: [],
        status: 'OPEN',
      }],
    })
    const result = await runner.review('run-1')

    expect(result).toMatchObject({ passed: false, review: { qualityScore: 72 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'DECK_REVIEW', qualityScore: 72 })
    expect((await repository.listSteps('run-1')).filter((step) => step.tool === 'generate_slide_image')).toHaveLength(2)
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toContain('issue.detected')
  })

  test('moves to human review when the evaluator invents a source or slide reference', async () => {
    const { repository, runner } = await fixture({
      ...passingReview(),
      issues: [{
        id: 'issue-deck-invalid',
        category: 'FACTUAL_RISK',
        severity: 'CRITICAL',
        summary: '评估器返回了不属于当前教材和课件的引用。',
        slideIds: ['run-1:slide:99'],
        sourceChunkIds: ['chunk-invented'],
        status: 'OPEN',
      }],
    })
    const result = await runner.review('run-1')

    expect(result).toMatchObject({ review: null, passed: false, step: { status: 'FAILED' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
  })

  test('replays a completed deck review without another evaluator call', async () => {
    const { reviewer, runner } = await fixture()
    const first = await runner.review('run-1')
    const replay = await runner.review('run-1')

    expect(replay).toMatchObject({ passed: true, replayed: true })
    expect(replay.review).toEqual(first.review)
    expect(reviewer.evaluations.size).toBe(1)
  })
})

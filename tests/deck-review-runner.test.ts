import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockArtifactPort, MockDeckReviewPort, MockPresentationRendererPort } from '../src/adapters/mock-ports'
import { CONTRACT_VERSION } from '../src/contracts'
import { getActiveBlueprint, revisionBlueprintStepKey } from '../src/core/active-blueprint'
import { DeckReviewRunner, deckReviewStepKey } from '../src/core/deck-review-runner'
import { hashInput } from '../src/core/hash'
import { planningStepKey } from '../src/core/planning-runner'
import type { DocumentPort, DocumentResult, RunRecord } from '../src/core/ports'
import { StructuredModelError } from '../src/core/ports'
import { revisionPlanStepKey } from '../src/core/revision-planning-runner'
import { appendV4LifecycleEvent } from '../src/core/v4-lifecycle'
import { generationBatchStepKeyFor } from '../src/core/generation-batch'
import { DeliveryRunner } from '../src/core/delivery-runner'

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
    runner: new DeckReviewRunner({
      repository, documents, reviewer, artifacts, renderer, clock: new FixedClock(), sleep: async () => {},
    }),
  }
}

describe('deck review runner', () => {
  test('evaluates ordered controlled artifacts and enters delivery after the fixed quality gate passes', async () => {
    const { repository, reviewer, renderer, runner } = await fixture()
    const result = await runner.review('run-1')

    expect(result).toMatchObject({ passed: true, replayed: false, review: { qualityScore: 88 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'DELIVERING', qualityScore: 88, version: 6 })
    const request = [...reviewer.requests.values()][0]!
    expect(request.slides.map((slide) => slide.artifactId))
      .toEqual(request.slides.map((slide) => expect.stringMatching(/^artifact:frameflow:run-1:slide-previews:/)))
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

  test('does not mark a high-scoring v4 deck with an open recommendation as review-passed', async () => {
    const { repository, runner } = await fixture({
      ...passingReview(),
      issues: [{
        id: 'high-score-recommendation', category: 'IMAGE_QUALITY', severity: 'WARNING',
        summary: '第二页视觉间距仍有非阻断优化空间。', slideIds: ['run-1:slide:2'],
        sourceChunkIds: [], status: 'OPEN',
      }],
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO', maxRevisionRounds: 2,
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'DECK_REVIEW', qualityDisposition: 'PENDING', qualityOverride: false,
    })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'delivery.started')).toBe(false)
  })

  test('does not repackage a historically accepted hard blocker as system policy', async () => {
    const { repository, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO', maxRevisionRounds: 0,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'legacy-accepted-factual-risk', category: 'FACTUAL_RISK', severity: 'WARNING',
          summary: '旧版本曾接受一项事实风险，但没有可验证的系统策略来源。',
          slideIds: ['run-1:slide:2'], sourceChunkIds: ['chunk-2'], status: 'OPEN',
          repairDomain: 'KNOWLEDGE',
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.resolved',
        payload: { issueId: 'legacy-accepted-factual-risk', resolution: 'ACCEPTED' },
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'FAILED', qualityDisposition: 'HARD_FAILURE', qualityOverride: false,
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'delivery.started')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT' },
    })
  })

  test('accepts review findings and enters delivery when v4 has no revision round available', async () => {
    const { repository, runner } = await fixture({
      ...passingReview(),
      qualityScore: 72,
      issues: [{
        id: 'issue-deck-limit',
        category: 'IMAGE_QUALITY',
        severity: 'WARNING',
        summary: '第二页存在模型审查识别出的视觉数量歧义。',
        slideIds: ['run-1:slide:2'],
        sourceChunkIds: ['chunk-2'],
        status: 'OPEN',
      }],
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4',
        automationLevel: 'BOUNDED_AUTO',
        maxRevisionRounds: 0,
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false, review: { qualityScore: 72 } })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'DELIVERING', qualityScore: 72, revisionRound: 0, maxRevisionRounds: 0,
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.some((event) => event.type === 'issue.resolved'
      && event.payload.issueId === 'issue-deck-limit'
      && event.payload.resolution === 'ACCEPTED')).toBe(true)
    expect(events.find((event) => event.type === 'deck_review.completed')).toMatchObject({
      payload: { reason: 'DECK_REVIEW_REJECTED', retryable: false },
    })
    expect(events.at(-1)).toMatchObject({ type: 'delivery.started' })
  })

  test('delivers after accepting more quality issues than the delivery audit projection can enumerate', async () => {
    const issues = Array.from({ length: 51 }, (_, index) => ({
      id: `issue-deck-overflow-${index + 1}`,
      category: 'IMAGE_QUALITY' as const,
      severity: 'WARNING' as const,
      summary: `第 ${index % 2 + 1} 页存在第 ${index + 1} 项非阻断视觉质量建议。`,
      slideIds: [`run-1:slide:${index % 2 + 1}`],
      sourceChunkIds: [],
      status: 'OPEN' as const,
    }))
    const { repository, artifacts, renderer, runner } = await fixture({
      ...passingReview(),
      qualityScore: 72,
      issues,
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO', maxRevisionRounds: 0,
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false })
    const delivery = await new DeliveryRunner({
      repository, artifacts, renderer, clock: new FixedClock(),
    }).deliver('run-1')

    expect(delivery).toMatchObject({ status: 'COMPLETED', delivery: { qualityStatus: 'SYSTEM_POLICY_ACCEPTED' } })
    expect(delivery.delivery?.openIssueIds.length).toBeLessThanOrEqual(50)
    expect(delivery.delivery?.qualityPolicyAudit?.issueIds.length).toBeLessThanOrEqual(50)
    expect(delivery.delivery?.qualityOverrideAudit).toBeNull()
    const acceptedIssueIds = (await repository.listEvents('run-1')).flatMap((event) =>
      event.type === 'issue.resolved' && event.payload.resolution === 'ACCEPTED'
        ? [event.payload.issueId]
        : [])
    expect(acceptedIssueIds.filter((issueId) => issues.some((issue) => issue.id === issueId))).toHaveLength(51)
  })

  test('does not deliver an exhausted v4 quality gate while a hard issue remains open', async () => {
    const { repository, runner } = await fixture({
      ...passingReview(),
      qualityScore: 72,
      issues: [{
        id: 'quality-issue-with-hard-blocker', category: 'IMAGE_QUALITY', severity: 'WARNING',
        summary: '第二页构图仍有可优化空间。', slideIds: ['run-1:slide:2'],
        sourceChunkIds: [], status: 'OPEN',
      }],
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO', maxRevisionRounds: 0,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'hard-source-blocker', category: 'SOURCE_INCOMPLETE', severity: 'CRITICAL',
          summary: '来源材料仍缺少关键范围。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
        },
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'FAILED' })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'delivery.started')).toBe(false)
    expect(events.some((event) => event.type === 'issue.resolved'
      && event.payload.issueId === 'hard-source-blocker')).toBe(false)
    expect(events.some((event) => event.type === 'issue.resolved'
      && event.payload.resolution === 'ACCEPTED')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT' },
    })
  })

  test('fails an exhausted v4 deck review when a warning identifies a curriculum hard blocker', async () => {
    const { repository, runner } = await fixture({
      ...passingReview(),
      issues: [{
        id: 'curriculum-hard-blocker', category: 'CURRICULUM_GAP', severity: 'WARNING',
        summary: '第二页遗漏教材要求掌握的关键知识。', slideIds: ['run-1:slide:2'],
        sourceChunkIds: ['chunk-2'], status: 'OPEN', repairDomain: 'KNOWLEDGE',
      }],
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO', maxRevisionRounds: 0,
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'FAILED', qualityDisposition: 'HARD_FAILURE',
    })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'delivery.started')).toBe(false)
    expect(events.some((event) => event.type === 'issue.resolved')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT' },
    })
  })

  test('fails a replayed rejected deck review instead of deadlocking when a hard issue remains open', async () => {
    const { repository, reviewer, runner } = await fixture({
      ...passingReview(),
      qualityScore: 72,
      issues: [{
        id: 'replayed-quality-issue', category: 'IMAGE_QUALITY', severity: 'WARNING',
        summary: '第二页构图仍有可优化空间。', slideIds: ['run-1:slide:2'],
        sourceChunkIds: [], status: 'OPEN',
      }],
    })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO', maxRevisionRounds: 0,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'replayed-hard-source-blocker', category: 'SOURCE_INCOMPLETE', severity: 'CRITICAL',
          summary: '来源材料仍缺少关键范围。', slideIds: [], sourceChunkIds: [], status: 'OPEN',
        },
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'FAILED' })
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'DECK_REVIEW', version: transaction.run.version + 1 })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.resumed',
        payload: { status: 'DECK_REVIEW' },
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ replayed: true, passed: false })
    expect(reviewer.requests.size).toBe(1)
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'FAILED' })
    expect((await repository.listEvents('run-1')).at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT' },
    })
  })

  test('accepts a historical quality issue at the revision limit without claiming review approval', async () => {
    const { repository, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO',
        revisionRound: 0, maxRevisionRounds: 0,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'historical-quality-issue', category: 'IMAGE_QUALITY', severity: 'WARNING',
          summary: '历史页审留下的视觉问题尚未返修。', slideIds: ['run-1:slide:2'],
          sourceChunkIds: [], status: 'OPEN',
        },
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false, review: { qualityScore: 88 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'DELIVERING', qualityOverride: true })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'issue.resolved'
      && event.payload.issueId === 'historical-quality-issue'
      && event.payload.resolution === 'ACCEPTED')).toBe(true)
    expect(events.find((event) => event.type === 'deck_review.completed')).toMatchObject({
      payload: { reason: null },
    })
  })

  test('does not review-pass a deck while a prior page recommendation remains open below the round limit', async () => {
    const { repository, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4', automationLevel: 'BOUNDED_AUTO',
        revisionRound: 1, maxRevisionRounds: 4,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'page-recommendation-awaiting-policy', category: 'IMAGE_QUALITY', severity: 'WARNING',
          summary: '页审留下的非阻断构图建议尚未形成最终策略结论。', slideIds: ['run-1:slide:2'],
          sourceChunkIds: [], status: 'OPEN',
        },
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false })
    expect(await repository.getRun('run-1')).toMatchObject({
      status: 'DECK_REVIEW', qualityDisposition: 'PENDING', qualityOverride: false,
    })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'delivery.started')).toBe(false)
  })

  test('resolves deck issues across an intervening page-only revision round', async () => {
    const { repository, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4',
        revisionRound: 2,
        version: transaction.run.version + 1,
      })
      transaction.putStep({
        id: 'step-apply-r1', runId: 'run-1', idempotencyKey: revisionBlueprintStepKey('run-1', 1),
        inputHash: 'apply-r1-hash', tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: { ...blueprint(), id: 'blueprint-r1' },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-apply-r2', runId: 'run-1', idempotencyKey: revisionBlueprintStepKey('run-1', 2),
        inputHash: 'apply-r2-hash', tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: { ...blueprint(), id: 'blueprint-r2' },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-revision-plan-r1', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 1),
        inputHash: 'revision-plan-r1-hash', tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: {
          id: 'revision-plan-r1', reviewId: 'deck-review-r0', revisionRound: 1,
          createdAt: transaction.run.createdAt, summary: '修复第二页的教材事实问题。',
          operations: [{
            id: 'operation-r1', slideId: 'run-1:slide:2', kind: 'UPDATE_CONTENT',
            issueIds: ['issue-old'], instruction: '依据教材修正第二页事实表述。', sourceChunkIds: ['chunk-2'],
          }],
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-page-revision-plan-r2', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 2),
        inputHash: 'page-revision-plan-r2-hash', tool: 'plan_page_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: {
          id: 'page-revision-plan-r2', reviewId: 'page-review-r1', revisionRound: 2,
          createdAt: transaction.run.createdAt, summary: '继续修复第二页的图片质量问题。',
          operations: [{
            id: 'page-operation-r2', slideId: 'run-1:slide:2', kind: 'REGENERATE_IMAGE',
            issueIds: ['page-issue-r1'], instruction: '移除额外标签并保持允许文字不变。', sourceChunkIds: ['chunk-2'],
          }],
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      const previousImages = transaction.listSteps().filter((step) => step.tool === 'generate_slide_image')
      for (const [index, previous] of previousImages.entries()) {
        const pageNumber = index + 1
        const previousOutput = previous.output as { artifactId: string }
        transaction.putStep({
          ...previous,
          id: `step-image-r2-${pageNumber}`,
          idempotencyKey: `run-1:slide:${pageNumber}:image:r2:v1`,
          inputHash: `image-r2-hash-${pageNumber}`,
          output: {
            slideId: `run-1:slide:${pageNumber}`,
            versionId: `run-1:slide:${pageNumber}:r2:v1`,
            artifactId: previousOutput.artifactId,
          },
        })
      }
      appendV4LifecycleEvent(transaction, 'revision.started', {
        completed: 0, total: 1, pageNumbers: [2], revisionKind: 'DECK_CONTENT', revisionRound: 1,
      })
      appendV4LifecycleEvent(transaction, 'revision.completed', {
        completed: 1, total: 1, pageNumbers: [2], revisionKind: 'DECK_CONTENT', revisionRound: 1,
      })
      appendV4LifecycleEvent(transaction, 'revision.started', {
        completed: 0, total: 1, pageNumbers: [2], revisionKind: 'PAGE_VISUAL', revisionRound: 2,
      })
      appendV4LifecycleEvent(transaction, 'revision.completed', {
        completed: 1, total: 1, pageNumbers: [2], revisionKind: 'PAGE_VISUAL', revisionRound: 2,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'issue-old', category: 'FACTUAL_RISK', severity: 'CRITICAL', summary: '第二页事实错误。',
          slideIds: ['run-1:slide:2'], sourceChunkIds: ['chunk-2'], status: 'OPEN', repairDomain: 'KNOWLEDGE',
        },
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: true })
    expect((await repository.listEvents('run-1')).find((event) => event.type === 'issue.resolved')).toMatchObject({
      payload: { issueId: 'issue-old', resolution: 'FIXED' },
    })
  })

  test('does not resolve a v4 issue when its applied revision later failed during media generation', async () => {
    const { repository, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4',
        revisionRound: 2,
        committedBudgetUnits: 40,
        version: transaction.run.version + 1,
      })
      for (const round of [1, 2]) {
        transaction.putStep({
          id: `step-apply-r${round}`, runId: 'run-1', idempotencyKey: revisionBlueprintStepKey('run-1', round),
          inputHash: `apply-r${round}-hash`, tool: 'apply_revision', status: 'COMPLETED', budgetUnits: 0,
          budgetReservationId: null, externalOperationId: null, errorCode: null,
          output: { ...blueprint(), id: `blueprint-r${round}` },
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        })
      }
      transaction.putStep({
        id: 'failed-media-plan-r1', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 1),
        inputHash: 'failed-media-plan-r1-hash', tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: {
          id: 'failed-media-plan-r1', reviewId: 'deck-review-r0', revisionRound: 1,
          createdAt: transaction.run.createdAt, summary: '计划修复历史事实问题并重画第二页。',
          operations: [{
            id: 'failed-media-operation-r1', slideId: 'run-1:slide:2', kind: 'UPDATE_CONTENT',
            issueIds: ['failed-media-factual-risk'], instruction: '依据教材修复事实问题并重画页面。',
            sourceChunkIds: ['chunk-2'],
          }],
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'successful-page-plan-r2', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 2),
        inputHash: 'successful-page-plan-r2-hash', tool: 'plan_page_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: {
          id: 'successful-page-plan-r2', reviewId: 'page-review-r1', revisionRound: 2,
          createdAt: transaction.run.createdAt, summary: '第二轮只修复另一项页面视觉问题。',
          operations: [{
            id: 'successful-page-operation-r2', slideId: 'run-1:slide:1', kind: 'REGENERATE_IMAGE',
            issueIds: ['page-issue-r1'], instruction: '移除额外装饰并保持允许文字不变。', sourceChunkIds: ['chunk-1'],
          }],
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      const previousImages = transaction.listSteps().filter((step) => step.tool === 'generate_slide_image')
      for (const [index, previous] of previousImages.entries()) {
        const pageNumber = index + 1
        const previousOutput = previous.output as { artifactId: string }
        transaction.putStep({
          ...previous,
          id: `step-image-r2-${pageNumber}`,
          idempotencyKey: `run-1:slide:${pageNumber}:image:r2:v1`,
          inputHash: `image-r2-hash-${pageNumber}`,
          output: {
            slideId: `run-1:slide:${pageNumber}`,
            versionId: `run-1:slide:${pageNumber}:r2:v1`,
            artifactId: previousOutput.artifactId,
          },
        })
      }
      transaction.putStep({
        id: 'step-generation-batch-r0', runId: 'run-1',
        idempotencyKey: generationBatchStepKeyFor('run-1', { revisionRound: 0, scope: 'INITIAL' }),
        inputHash: 'generation-batch-r0-hash', tool: 'generate_image_batch', status: 'COMPLETED',
        budgetUnits: 20, budgetReservationId: 'batch-reservation-r0', externalOperationId: null, errorCode: null,
        output: {
          batchId: `genbatch_${'a'.repeat(32)}`, proposalHash: 'a'.repeat(64), revisionRound: 0,
          submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS', pageCount: 2,
          pages: [1, 2].map((pageNumber) => ({
            pageNumber, idempotencyKey: `run-1:slide:${pageNumber}:image:r0:v1`, promptHash: String(pageNumber).repeat(64),
          })),
          accounting: {
            estimatedUnits: 20, committedUnits: 20, settledUnits: 20, releasedUnits: 0,
            reconciliationUnits: 0, authorization: 'RESERVED', settlement: 'SETTLED',
          },
          progress: { submitted: 2, completed: 2, failed: 0 }, status: 'COMPLETED',
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-revision-generation-batch-r2', runId: 'run-1',
        idempotencyKey: generationBatchStepKeyFor('run-1', { revisionRound: 2, scope: 'REVISION' }),
        inputHash: 'revision-generation-batch-r2-hash', tool: 'generate_image_batch', status: 'COMPLETED',
        budgetUnits: 20, budgetReservationId: 'batch-reservation-r2', externalOperationId: null, errorCode: null,
        output: {
          batchId: `genbatch_${'b'.repeat(32)}`, proposalHash: 'b'.repeat(64), revisionRound: 2,
          submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS', pageCount: 2,
          pages: [1, 2].map((pageNumber) => ({
            pageNumber, idempotencyKey: `run-1:slide:${pageNumber}:image:r2:v1`, promptHash: String(pageNumber + 2).repeat(64),
          })),
          accounting: {
            estimatedUnits: 20, committedUnits: 20, settledUnits: 20, releasedUnits: 0,
            reconciliationUnits: 0, authorization: 'RESERVED', settlement: 'SETTLED',
          },
          progress: { submitted: 2, completed: 2, failed: 0 }, status: 'COMPLETED',
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      appendV4LifecycleEvent(transaction, 'revision.started', {
        completed: 0, total: 1, pageNumbers: [2], revisionKind: 'DECK_CONTENT', revisionRound: 1,
      })
      appendV4LifecycleEvent(transaction, 'revision.completed', {
        completed: 0, total: 1, pageNumbers: [2], revisionKind: 'DECK_CONTENT', revisionRound: 1,
        reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE', retryable: false,
        requiresUserAction: true, nextAction: 'REVIEW_RESULT',
      })
      appendV4LifecycleEvent(transaction, 'revision.started', {
        completed: 0, total: 1, pageNumbers: [1], revisionKind: 'PAGE_VISUAL', revisionRound: 2,
      })
      appendV4LifecycleEvent(transaction, 'revision.completed', {
        completed: 1, total: 1, pageNumbers: [1], revisionKind: 'PAGE_VISUAL', revisionRound: 2,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'failed-media-factual-risk', category: 'FACTUAL_RISK', severity: 'CRITICAL',
          summary: '第一轮媒体生成失败，历史事实问题仍未证明修复。', slideIds: ['run-1:slide:2'],
          sourceChunkIds: ['chunk-2'], status: 'OPEN', repairDomain: 'KNOWLEDGE',
        },
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false, review: { qualityScore: 88 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'FAILED' })
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'issue.resolved' && event.payload.issueId === 'failed-media-factual-risk')).toBe(false)
  })

  test('does not deliver while an untargeted historical blocking issue remains open', async () => {
    const { repository, reviewer, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({
        ...transaction.run,
        presentationMode: 'VISUAL_DECK_V4',
        revisionRound: 1,
        version: transaction.run.version + 1,
      })
      transaction.putStep({
        id: 'step-generation-batch-r0', runId: 'run-1',
        idempotencyKey: generationBatchStepKeyFor('run-1', { revisionRound: 0, scope: 'INITIAL' }),
        inputHash: 'generation-batch-r0-hash', tool: 'generate_image_batch', status: 'COMPLETED',
        budgetUnits: 20, budgetReservationId: 'batch-reservation-r0', externalOperationId: null,
        errorCode: null,
        output: {
          batchId: `genbatch_${'a'.repeat(32)}`, proposalHash: 'a'.repeat(64), revisionRound: 0,
          submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS', pageCount: 2,
          pages: [1, 2].map((pageNumber) => ({
            pageNumber, idempotencyKey: `run-1:slide:${pageNumber}:image:r0:v1`, promptHash: String(pageNumber).repeat(64),
          })),
          accounting: {
            estimatedUnits: 20, committedUnits: 20, settledUnits: 20, releasedUnits: 0,
            reconciliationUnits: 0, authorization: 'RESERVED', settlement: 'SETTLED',
          },
          progress: { submitted: 2, completed: 2, failed: 0 }, status: 'COMPLETED',
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'unapplied-revision-plan-r1', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 1),
        inputHash: 'unapplied-revision-plan-r1-hash', tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0,
        budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: {
          id: 'unapplied-revision-plan-r1', reviewId: 'deck-review-r0', revisionRound: 1,
          createdAt: transaction.run.createdAt, summary: '计划修复历史事实问题，但执行阶段尚未成功。',
          operations: [{
            id: 'unapplied-operation-r1', slideId: 'run-1:slide:2', kind: 'UPDATE_CONTENT',
            issueIds: ['historical-factual-risk'], instruction: '依据教材修复历史事实问题。',
            sourceChunkIds: ['chunk-2'],
          }],
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'historical-factual-risk', category: 'FACTUAL_RISK', severity: 'CRITICAL',
          summary: '历史事实问题尚未经过任何修订计划处理。', slideIds: ['run-1:slide:2'],
          sourceChunkIds: ['chunk-2'], status: 'OPEN', repairDomain: 'KNOWLEDGE',
        },
      })
    })

    expect(await runner.review('run-1')).toMatchObject({ passed: false, replayed: false, review: { qualityScore: 88 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'FAILED', qualityScore: 88 })
    const events = await repository.listEvents('run-1')
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT' },
    })
    expect(await runner.review('run-1')).toMatchObject({ passed: false, replayed: true, review: { qualityScore: 88 } })
    expect(reviewer.evaluations.size).toBe(1)
  })

  test('blocks a high-scoring deck while any factual risk remains open', async () => {
    const { repository, runner } = await fixture({
      ...passingReview(),
      qualityScore: 88,
      issues: [{
        id: 'issue-factual-warning',
        category: 'FACTUAL_RISK',
        severity: 'WARNING',
        summary: '第二页对光合作用产物的数量关系存在事实性错误。',
        slideIds: ['run-1:slide:2'],
        sourceChunkIds: ['chunk-2'],
        status: 'OPEN',
      }],
    })

    const result = await runner.review('run-1')

    expect(result).toMatchObject({ passed: false, review: { qualityScore: 88 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'DECK_REVIEW', qualityScore: 88 })
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
    const events = await repository.listEvents('run-1')
    expect(events.find((event) => event.type === 'phase.changed')?.payload)
      .toMatchObject({ from: 'DECK_REVIEW', to: 'NEEDS_HUMAN' })
    expect(events.map((event) => event.type)).toContain('approval.required')
  })

  test('retries a transient deck review provider failure with the stable model key', async () => {
    const { reviewer, runner } = await fixture()
    const evaluateOnce = reviewer.evaluate.bind(reviewer)
    const keys: string[] = []
    reviewer.evaluate = async (input) => {
      keys.push(input.idempotencyKey)
      if (keys.length < 3) {
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6', `deck-request-${keys.length}`)
      }
      return evaluateOnce(input)
    }

    const result = await runner.review('run-1')

    expect(result).toMatchObject({ passed: true, review: { qualityScore: 88 } })
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(1)
  })

  test('repairs an invalid deck review contract with a distinct bounded model key', async () => {
    const { reviewer, runner } = await fixture()
    const evaluateOnce = reviewer.evaluate.bind(reviewer)
    const keys: string[] = []
    const contractIssues: unknown[] = []
    reviewer.evaluate = async (input) => {
      keys.push(input.idempotencyKey)
      contractIssues.push(input.contractRepairIssues)
      if (keys.length === 1) return { ...passingReview(), reviewedSourceChunkIds: [] }
      return evaluateOnce(input)
    }

    const result = await runner.review('run-1')

    expect(result).toMatchObject({ passed: true, review: { qualityScore: 88 } })
    expect(keys).toHaveLength(2)
    expect(keys[1]).toMatch(/^deck-review-contract-repair-[a-f0-9]{64}$/)
    expect(contractIssues[1]).toEqual([{
      path: 'reviewedSourceChunkIds', message: 'Too small: expected array to have >=1 items',
    }])
  })

  test('persists the final deck provider diagnostic after bounded retries are exhausted', async () => {
    const { repository, reviewer, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    let attempts = 0
    reviewer.evaluate = async () => {
      attempts += 1
      throw new StructuredModelError('PROVIDER_TIMEOUT', true, 'gpt-5.6', `deck-timeout-${attempts}`)
    }

    const result = await runner.review('run-1')

    expect(attempts).toBe(5)
    expect(result).toMatchObject({
      review: null,
      step: {
        status: 'RUNNING',
        errorCode: 'PROVIDER_TIMEOUT',
        output: {
          diagnostic: {
            providerAttempt: 5,
            maxProviderAttempts: 5,
            contractAttempt: 1,
            maxContractAttempts: 3,
            model: 'gpt-5.6',
            requestId: 'deck-timeout-5',
          },
        },
      },
    })
    const events = await repository.listEvents('run-1')
    expect(events.find((event) => event.type === 'tool.failed')?.payload)
      .toMatchObject({ errorCode: 'PROVIDER_TIMEOUT', retryable: true })
    expect(events.find((event) => event.type === 'deck_review.completed')?.payload)
      .toMatchObject({ reason: 'DECK_REVIEW_FAILED', retryable: true, requiresUserAction: false, nextAction: null })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'RECOVERING' })
    expect(events.some((event) => event.type === 'technical.recovery.started')).toBe(true)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('replays a completed deck review without another evaluator call', async () => {
    const { reviewer, runner } = await fixture()
    const first = await runner.review('run-1')
    const replay = await runner.review('run-1')

    expect(replay).toMatchObject({ passed: true, replayed: true })
    expect(replay.review).toEqual(first.review)
    expect(reviewer.evaluations.size).toBe(1)
  })

  test('does not duplicate an in-flight deck review', async () => {
    const { reviewer, runner } = await fixture()
    const evaluateOnce = reviewer.evaluate.bind(reviewer)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    reviewer.evaluate = async (input) => {
      started()
      await gate
      return evaluateOnce(input)
    }

    const first = runner.review('run-1')
    await entered
    const second = runner.review('run-1')
    release()
    const [completed, concurrent] = await Promise.all([first, second])

    expect(concurrent).toEqual(completed)
    expect(completed).toMatchObject({ passed: true, replayed: false })
    expect(reviewer.evaluations.size).toBe(1)
  })

  test('keeps the successful terminal deck review when another runner fails afterward', async () => {
    const { repository, documents, artifacts, renderer, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, presentationMode: 'VISUAL_DECK_V4' })
    })
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    const competingRunner = new DeckReviewRunner({
      repository,
      documents,
      artifacts,
      renderer,
      clock: new FixedClock(),
      reviewer: {
        async evaluate() {
          started()
          await gate
          throw new StructuredModelError('PROVIDER_UNAVAILABLE', false, 'gpt-5.6', 'late-deck-failure')
        },
      },
      sleep: async () => {},
    })

    const lateFailure = competingRunner.review('run-1')
    await entered
    const completed = await runner.review('run-1')
    release()
    const converged = await lateFailure

    expect(completed).toMatchObject({ passed: true, replayed: false, review: { qualityScore: 88 } })
    expect(converged).toMatchObject({ passed: true, replayed: true, review: { qualityScore: 88 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'DELIVERING', qualityScore: 88 })
    const events = await repository.listEvents('run-1')
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'tool.failed')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'deck_review.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'phase.changed')).toHaveLength(1)
  })

  test('resumes a persisted running deck review after process restart', async () => {
    const { repository, reviewer, runner } = await fixture()
    const activeBlueprint = await getActiveBlueprint(repository, 'run-1', 0)
    const sourceChunks = [
      { id: 'chunk-1', sha256: 'sha-1' },
      { id: 'chunk-2', sha256: 'sha-2' },
    ]
    const slides = activeBlueprint.slides.map((slide) => ({
      slideId: `run-1:slide:${slide.pageNumber}`,
      pageNumber: slide.pageNumber,
      artifactId: `artifact:frameflow:source-${slide.pageNumber}`,
      title: slide.title,
      body: slide.body,
      layout: slide.layout,
      visualIntent: slide.visualIntent,
      sourceChunkIds: slide.sourceChunkIds,
    }))
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-run-1-deck-review-r0',
        runId: 'run-1',
        idempotencyKey: deckReviewStepKey(transaction.run),
        inputHash: hashInput({
          tool: 'review_deck',
          revisionRound: 0,
          blueprint: activeBlueprint,
          sourceChunks,
          slides,
        }),
        tool: 'review_deck',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })

    const result = await runner.review('run-1')

    expect(result).toMatchObject({ passed: true, replayed: false, review: { qualityScore: 88 } })
    expect(reviewer.evaluations.size).toBe(1)
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'review_deck'))
      .toMatchObject({ status: 'COMPLETED' })
  })
})

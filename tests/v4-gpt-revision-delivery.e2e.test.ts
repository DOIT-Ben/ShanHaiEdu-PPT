import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  FixedClock,
  MockArtifactPort,
  MockBudgetPort,
  MockDeckReviewPort,
  MockImageGenerationPort,
  MockRevisionApplicationPort,
  MockRevisionPlanningPort,
  MockVisualReviewPort,
} from '../src/adapters/mock-ports'
import { SharpPptxPresentationRenderer } from '../src/adapters/presentation-renderer'
import { DeckReviewRunner } from '../src/core/deck-review-runner'
import { DeliveryRunner } from '../src/core/delivery-runner'
import { MediaStepRunner } from '../src/core/media-step-runner'
import { PageReviewCoordinator } from '../src/core/page-review-coordinator'
import { planningStepKey } from '../src/core/planning-runner'
import type { DocumentPort, DocumentResult, PresentationRendererPort, RunRecord } from '../src/core/ports'
import { RevisionApplicationRunner } from '../src/core/revision-application-runner'
import { RevisionMediaCoordinator } from '../src/core/revision-media-coordinator'
import { RevisionPlanningRunner } from '../src/core/revision-planning-runner'
import { SlideGenerationCoordinator } from '../src/core/slide-generation-coordinator'
import { compileV4EvidenceWindowForRun, v4EvidenceWindowStepKey } from '../src/core/v4-evidence-window-compiler'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { VisualReviewRunner } from '../src/core/visual-review-runner'

const runId = 'run-v4-gpt-revision-e2e'
const host = { tenantId: 'frameflow', externalUserId: 'teacher-1' }
const source = {
  kind: 'SOURCE_PACKAGE' as const,
  name: '分数课程资料',
  sources: [
    {
      kind: 'TEXT' as const,
      sourceId: 'lesson',
      name: '教材.md',
      roleHint: 'CONTENT_SOURCE' as const,
      text: '把一个蛋糕平均分成两份，其中一份是二分之一。'.repeat(4),
    },
    {
      kind: 'TEXT' as const,
      sourceId: 'practice',
      name: '练习.md',
      roleHint: 'TEACHING_GUIDE' as const,
      text: '判断图形是否平均分，并说出涂色部分表示的分数。'.repeat(4),
    },
  ],
}
const v4Config = {
  instruction: '制作一套学生能够理解分数意义的完整视觉演示',
  sourceMode: 'SOURCE_GROUNDED' as const,
  deckOptions: {
    deckType: 'DETAILED_DECK' as const,
    language: 'zh-CN' as const,
    length: { slideCount: 2 },
    aspectRatio: '16:9' as const,
    audience: '小学三年级学生',
    focus: '平均分与二分之一',
    styleHint: '温暖的儿童绘本课堂视觉',
  },
}

function document(): DocumentResult {
  return {
    name: source.name,
    chunks: [
      { id: 'chunk-lesson', sourceId: 'lesson', text: source.sources[0]!.text, sha256: 'a'.repeat(64) },
      { id: 'chunk-practice', sourceId: 'practice', text: source.sources[1]!.text, sha256: 'b'.repeat(64) },
    ],
    sources: [
      { id: 'lesson', name: '教材.md', kind: 'MARKDOWN', status: 'READY' },
      { id: 'practice', name: '练习.md', kind: 'MARKDOWN', status: 'READY' },
    ],
    assets: [],
    isComplete: true,
    missingRanges: [],
  }
}

class StaticDocumentPort implements DocumentPort {
  async resolve() { return structuredClone(document()) }
}

class CapturingRenderer implements PresentationRendererPort {
  private readonly delegate = new SharpPptxPresentationRenderer()
  pptxSlideHashes: string[] = []

  renderSlidePreviews(input: Parameters<PresentationRendererPort['renderSlidePreviews']>[0]) {
    return this.delegate.renderSlidePreviews(input)
  }

  renderPreviewFromSlidePreviews(input: Parameters<PresentationRendererPort['renderPreviewFromSlidePreviews']>[0]) {
    return this.delegate.renderPreviewFromSlidePreviews(input)
  }

  renderPreview(input: Parameters<PresentationRendererPort['renderPreview']>[0]) {
    return this.delegate.renderPreview(input)
  }

  renderPptx(input: Parameters<PresentationRendererPort['renderPptx']>[0]) {
    this.pptxSlideHashes = input.slides.map((slide) => createHash('sha256').update(slide.image).digest('hex'))
    return this.delegate.renderPptx(input)
  }
}

function run(): RunRecord {
  return {
    id: runId,
    creationKey: 'create-v4-gpt-revision-e2e',
    requestHash: 'request-v4-gpt-revision-e2e',
    host,
    source,
    slideCount: 2,
    visualDirection: '温暖的儿童绘本课堂视觉',
    imageModel: 'gemini-3-pro-image-preview',
    v4ModelSnapshot: {
      schemaVersion: '1',
      textModel: 'gpt-5.6-terra',
      visionModel: 'gpt-5.6-terra',
      imageModel: 'gemini-3-pro-image-preview',
      imageEditModel: 'gpt-image-2',
    },
    v4StructuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
    automationLevel: 'BOUNDED_AUTO',
    presentationMode: 'VISUAL_DECK_V4',
    visualDeckV4: v4Config,
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'EXECUTING',
    resumeState: null,
    version: 1,
    budgetUnits: 6,
    committedBudgetUnits: 0,
    qualityOverride: false,
    qualityOverrideReason: null,
    qualityOverrideBy: null,
    leaseToken: null,
    leaseUntil: null,
    leaseVersion: 0,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  }
}

function blueprint() {
  return createVisualDeckV4Blueprint({
    runId,
    inputHash: 'input-v4-gpt-revision-e2e',
    source,
    document: document(),
    config: v4Config,
    slideCount: 2,
    visualDirection: '温暖的儿童绘本课堂视觉',
    createdAt: '2026-08-03T00:00:00.000Z',
  })
}

function passingDeckReview() {
  return {
    qualityScore: 92,
    curriculumCoverageScore: 94,
    narrativeCoherenceScore: 91,
    visualConsistencyScore: 92,
    compositionScore: 91,
    summary: '两页课件内容、叙事和视觉均达到完整交付标准。',
    reviewedSourceChunkIds: ['chunk-lesson', 'chunk-practice'],
    issues: [],
  }
}

describe('V4 GPT revision delivery integration', () => {
  test('delivers a real PPTX after gemini-3-pro-image-preview generation, gpt-image-2 edit, re-review and atomic batch settlement', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    const documents = new StaticDocumentPort()
    const budget = new MockBudgetPort()
    const images = new MockImageGenerationPort()
    const artifacts = new MockArtifactPort()
    const renderer = new CapturingRenderer()
    const planned = blueprint()
    await repository.createRun(run())
    await repository.transact(runId, (transaction) => {
      const evidenceWindow = compileV4EvidenceWindowForRun({ run: transaction.run, document: document() })
      transaction.putStep({
        id: `step-${runId}-plan`,
        runId,
        idempotencyKey: planningStepKey(runId),
        inputHash: 'plan-hash',
        tool: 'create_blueprint',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: planned,
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: `step-${runId}-evidence-window`,
        runId,
        idempotencyKey: v4EvidenceWindowStepKey(runId),
        inputHash: 'evidence-window-hash',
        tool: 'compile_v4_evidence_window',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: evidenceWindow.audit,
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })

    const media = new MediaStepRunner({ repository, budget, images, clock })
    const generation = new SlideGenerationCoordinator({
      repository, media, batchBudget: budget, documents, artifacts, clock,
    })
    expect(await generation.submitBlueprintImages(runId, 1)).toMatchObject({ submitted: 2, total: 2 })
    const initialRequests = [...images.requests.entries()]
    expect(initialRequests).toHaveLength(2)
    expect(initialRequests.every(([, request]) => request.model === 'gemini-3-pro-image-preview' && !request.referenceImage)).toBe(true)

    const initialBytes = await Promise.all([
      sharp({ create: { width: 1600, height: 900, channels: 3, background: '#E5484D' } }).png().toBuffer(),
      sharp({ create: { width: 1600, height: 900, channels: 3, background: '#1F6FEB' } }).png().toBuffer(),
    ])
    const initialArtifacts = await Promise.all(initialBytes.map((bytes, index) => artifacts.put({
      tenantId: host.tenantId,
      runId,
      name: `initial-${index + 1}.png`,
      mimeType: 'image/png',
      bytes,
      idempotencyKey: `${runId}:initial-artifact:${index + 1}`,
    })))
    for (const [index, artifact] of initialArtifacts.entries()) {
      images.complete(`${runId}:slide:${index + 1}:image:r0:v1`, artifact.artifactId)
    }
    expect(await generation.refreshBlueprintImages(runId)).toMatchObject({ status: 'PAGE_REVIEW', completed: 2 })
    expect(budget.batchFinalizations).toEqual([expect.objectContaining({ settledUnits: 2, releasedUnits: 0 })])

    const visualReviewer = new MockVisualReviewPort({
      approved: true, textDetected: false, visualScore: 93, reasons: [], retryInstruction: null,
    })
    const visual = new VisualReviewRunner({ repository, reviewer: visualReviewer, clock })
    const pages = new PageReviewCoordinator({ repository, reviewer: visual, artifacts, renderer, clock })
    expect(await pages.reviewAll(runId)).toMatchObject({ status: 'DECK_REVIEW', rejected: 0 })

    const deckReviewer = new MockDeckReviewPort({
      ...passingDeckReview(),
      qualityScore: 72,
      visualConsistencyScore: 66,
      summary: '第二页视觉对象与整套风格不一致，需要保留内容后局部修正。',
      issues: [{
        id: 'issue-page-2-style',
        category: 'VISUAL_CONSISTENCY',
        severity: 'WARNING',
        summary: '第二页视觉对象与整套风格不一致。',
        slideIds: [`${runId}:slide:2`],
        sourceChunkIds: [],
        status: 'OPEN',
        repairDomain: 'ASSET',
      }],
    })
    const deck = new DeckReviewRunner({
      repository, documents, reviewer: deckReviewer, artifacts, renderer, clock,
    })
    expect(await deck.review(runId)).toMatchObject({ passed: false, review: { qualityScore: 72 } })

    const plannerPort = new MockRevisionPlanningPort({
      summary: '只修正第二页视觉对象，第一页和已确认教学内容保持不变。',
      operations: [{
        id: 'operation-page-2-style',
        slideId: `${runId}:slide:2`,
        kind: 'REGENERATE_IMAGE',
        issueIds: ['issue-page-2-style'],
        instruction: '只编辑第二页不一致的视觉对象，保持文字、事实、公式和其他区域不变。',
        sourceChunkIds: [],
      }],
    })
    const revisionPlanning = new RevisionPlanningRunner({ repository, documents, planner: plannerPort, clock })
    expect(await revisionPlanning.plan(runId)).toMatchObject({ status: 'REVISING', plan: { revisionRound: 1 } })
    const applicationPort = new MockRevisionApplicationPort({})
    const revisionApplication = new RevisionApplicationRunner({
      repository, documents, application: applicationPort, clock,
    })
    expect(await revisionApplication.apply(runId)).toMatchObject({ status: 'REVISING', requiresMedia: true })
    expect(applicationPort.requests.size).toBe(0)

    const revision = new RevisionMediaCoordinator({
      repository, media, batchBudget: budget, artifacts, clock, revisionImageModel: 'gpt-image-2',
    })
    expect(await revision.submit(runId, 1)).toMatchObject({ status: 'REVISING', submitted: 1, total: 1 })
    const editEntry = [...images.requests.entries()].find(([key]) => key.startsWith(`${runId}:slide:2:image:r1:v1:edit:`))
    expect(editEntry).toBeDefined()
    const [editKey, editRequest] = editEntry!
    expect(editRequest).toMatchObject({
      model: 'gpt-image-2',
      referenceImage: { sha256: initialArtifacts[1]!.sha256 },
    })
    expect(editRequest.referenceImage?.bytes).toEqual(new Uint8Array(initialBytes[1]!))

    const revisedBytes = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: '#20A464' },
    }).png().toBuffer()
    const revisedArtifact = await artifacts.put({
      tenantId: host.tenantId,
      runId,
      name: 'revised-2.png',
      mimeType: 'image/png',
      bytes: revisedBytes,
      idempotencyKey: `${runId}:revised-artifact:2`,
    })
    images.complete(editKey, revisedArtifact.artifactId)
    expect(await revision.refresh(runId)).toMatchObject({ status: 'PAGE_REVIEW', completed: 1, total: 1 })
    expect(budget.batchFinalizations).toEqual([
      expect.objectContaining({ settledUnits: 2, releasedUnits: 0 }),
      expect.objectContaining({ settledUnits: 1, releasedUnits: 0 }),
    ])
    expect(await pages.reviewAll(runId)).toMatchObject({ status: 'DECK_REVIEW', rejected: 0 })
    expect([...visualReviewer.requests.keys()].some((key) => key.startsWith(`${editKey}:review`))).toBe(true)

    deckReviewer.response = passingDeckReview()
    expect(await deck.review(runId)).toMatchObject({ passed: true, review: { qualityScore: 92 } })
    const delivered = await new DeliveryRunner({ repository, artifacts, renderer, clock }).deliver(runId)
    expect(delivered).toMatchObject({ status: 'COMPLETED', delivery: { qualityStatus: 'APPROVED' } })
    expect(renderer.pptxSlideHashes).toEqual([
      createHash('sha256').update(initialBytes[0]!).digest('hex'),
      createHash('sha256').update(revisedBytes).digest('hex'),
    ])
    expect(await repository.getRun(runId)).toMatchObject({
      status: 'COMPLETED', revisionRound: 1, committedBudgetUnits: 3, qualityScore: 92,
    })

    const pptx = await artifacts.get({ tenantId: host.tenantId, artifactId: delivered.delivery!.pptx.artifactId })
    expect(pptx?.bytes.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-v4-gpt-revision-'))
    try {
      const path = join(directory, 'revised.pptx')
      await writeFile(path, pptx!.bytes)
      const process = Bun.spawn(['unzip', '-Z1', path], { stdout: 'pipe', stderr: 'pipe' })
      const entries = (await new Response(process.stdout).text()).split('\n')
      expect(await process.exited).toBe(0)
      expect(entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

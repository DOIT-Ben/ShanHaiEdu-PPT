import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  FixedClock,
  MockArtifactPort,
  MockBudgetPort,
  MockDeckReviewPort,
  MockImageGenerationPort,
  MockPresentationRendererPort,
  MockRevisionApplicationPort,
  MockRevisionPlanningPort,
  MockStructuredModelPort,
  MockVisualReviewPort,
} from '../src/adapters/mock-ports'
import { DeckReviewRunner } from '../src/core/deck-review-runner'
import { DeliveryRunner } from '../src/core/delivery-runner'
import { MediaStepRunner } from '../src/core/media-step-runner'
import { PageReviewCoordinator } from '../src/core/page-review-coordinator'
import { PlanningRunner } from '../src/core/planning-runner'
import type { DocumentPort, DocumentResult } from '../src/core/ports'
import { RunService } from '../src/core/run-service'
import { RevisionApplicationRunner } from '../src/core/revision-application-runner'
import { RevisionMediaCoordinator } from '../src/core/revision-media-coordinator'
import { RevisionPlanningRunner } from '../src/core/revision-planning-runner'
import { SlideGenerationCoordinator } from '../src/core/slide-generation-coordinator'
import { VisualReviewRunner } from '../src/core/visual-review-runner'

const host = { tenantId: 'frameflow', externalUserId: 'teacher-1', externalProjectId: 'lesson-1' }

function document(): DocumentResult {
  return {
    name: '七年级生物教材.txt',
    chunks: Array.from({ length: 15 }, (_, index) => ({
      id: `chunk-${index + 1}`,
      text: `教材第 ${index + 1} 个知识片段，限定在七年级生物课程范围内。`,
      sha256: `sha-${index + 1}`,
      pageStart: index + 1,
      pageEnd: index + 1,
    })),
    isComplete: true,
    missingRanges: [],
  }
}

function blueprintDraft() {
  return {
    title: '绿色植物的生命活动',
    curriculum: {
      subject: '生物',
      grade: '七年级',
      lessonTitle: '绿色植物的生命活动',
      sourceSummary: '教材按十五个连续知识片段介绍绿色植物的结构、光合作用和生命活动。',
      learningObjectives: ['理解绿色植物生命活动的核心概念', '能够按教材顺序解释主要过程'],
      scopeBoundaries: ['只使用给定十五个教材片段中的内容'],
      prohibitedExtensions: ['不扩展高中阶段生化机理'],
      sourceChunkIds: Array.from({ length: 15 }, (_, index) => `chunk-${index + 1}`),
    },
    slides: Array.from({ length: 15 }, (_, index) => {
      const pageNumber = index + 1
      return {
        pageNumber,
        title: `知识点 ${pageNumber}`,
        body: [`教材第 ${pageNumber} 个知识片段的课堂要点`],
        layout: pageNumber === 1 ? 'HERO' : pageNumber % 2 === 0 ? 'SPLIT' : 'EDITORIAL',
        visualIntent: `用适龄的课堂科学画面支持第 ${pageNumber} 个教材知识片段`,
        visualPrompt: `A clean educational biology illustration for lesson page ${pageNumber}, no text or symbols`,
        sourceChunkIds: [`chunk-${pageNumber}`],
      }
    }),
  }
}

class StaticDocumentPort implements DocumentPort {
  async resolve() { return structuredClone(document()) }
}

describe('PPT Agent mock end-to-end', () => {
  test('delivers a 12-page approved design sequentially without replanning', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    const pageCount = 12
    const source = {
      kind: 'APPROVED_PAGE_DESIGN' as const,
      schemaVersion: CONTRACT_VERSION,
      artifactVersionId: 'approved-page-design-version-12',
      artifactContentHash: 'a'.repeat(64),
      title: '百分数的意义',
      subject: '数学',
      gradeBand: '六年级',
      lessonDurationMinutes: 40,
      audience: '六年级学生',
      objectives: ['理解百分数表示两个量之间的关系'],
      pages: Array.from({ length: pageCount }, (_, index) => ({
        pageNumber: index + 1,
        title: `百分数课堂第 ${index + 1} 页`,
        teachingPurpose: `完成第 ${index + 1} 个课堂教学环节`,
        editableCopy: [`第 ${index + 1} 页经教师审核的核心文案`],
        layoutIntent: index === 0 ? '沉浸式封面' : '左侧文字、右侧课堂情境图',
        visualRequirements: ['真实课堂、清晰主体、适合六年级学生'],
        teacherNotes: '引导学生观察并表达数量关系',
        teacherScript: '请观察画面中的数量关系，并说说百分数表达了什么。',
        studentActivity: '独立思考后与同伴交流',
        animationSequence: ['先呈现情境', '再呈现核心问题'],
        boardPlan: '板书百分数及其对应数量关系',
        evidence: [{ type: 'FACT' as const, text: '百分数表示一个数是另一个数的百分之几', source: '六年级数学教材' }],
      })),
    }
    const approvedDocument: DocumentResult = {
      name: source.title,
      chunks: source.pages.map((page) => ({
        id: `approved-page-${page.pageNumber}`,
        text: page.editableCopy.join('\n'),
        sha256: String(page.pageNumber).padStart(64, '0'),
        pageStart: page.pageNumber,
        pageEnd: page.pageNumber,
      })),
      sources: [{ id: source.artifactVersionId, name: source.title, kind: 'MARKDOWN', status: 'READY', pageCount }],
      assets: [],
      isComplete: true,
      missingRanges: [],
    }
    const documents: DocumentPort = { async resolve() { return structuredClone(approvedDocument) } }
    const planningModel = new MockStructuredModelPort(blueprintDraft())
    const budget = new MockBudgetPort()
    const images = new MockImageGenerationPort()
    const artifacts = new MockArtifactPort()
    const renderer = new MockPresentationRendererPort()
    const runs = new RunService({ repository, clock })
    const created = await runs.create({
      schemaVersion: CONTRACT_VERSION,
      host,
      source,
      slideCount: pageCount,
      visualDirection: '第一页导入百分数；第二页比较数量；其余十页逐页展开整套教学流程',
      imageModel: 'mock-image',
      automationLevel: 'BOUNDED_AUTO',
      budgetUnits: pageCount,
      maxRevisionRounds: 2,
      presentationMode: 'SLIDE_IMAGE_V2',
    }, 'e2e-approved-create-run-0001')
    const runId = created.run.id
    const planning = new PlanningRunner({ repository, documents, model: planningModel, clock })
    const planned = await planning.plan({
      runId,
      stepId: `step-${runId}-plan`,
      idempotencyKey: `${runId}:blueprint:v1`,
      source,
      slideCount: pageCount,
      visualDirection: created.run.visualDirection,
      presentationMode: 'SLIDE_IMAGE_V2',
    })
    expect(planned.blueprint?.slides).toHaveLength(pageCount)
    expect(planningModel.executions.size).toBe(0)
    expect(await repository.getRun(runId)).toMatchObject({ status: 'EXECUTING' })

    const media = new MediaStepRunner({ repository, budget, images, clock })
    const generation = new SlideGenerationCoordinator({ repository, media, documents, artifacts, clock })
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      expect(await generation.submitBlueprintImages(runId, 1)).toMatchObject({ submitted: pageNumber, total: pageCount })
      expect(images.operations.size).toBe(pageNumber)
      const key = `${runId}:slide:${pageNumber}:image:r0:v1`
      const artifact = await artifacts.put({
        tenantId: host.tenantId,
        runId,
        name: `slide-${pageNumber}.png`,
        mimeType: 'image/png',
        bytes: new TextEncoder().encode(`approved-slide-${pageNumber}`),
        idempotencyKey: `${key}:source-artifact`,
      })
      images.complete(key, artifact.artifactId)
      const refreshed = await generation.refreshBlueprintImages(runId)
      expect(refreshed.completed).toBe(pageNumber)
    }
    expect(await repository.getRun(runId)).toMatchObject({ status: 'PAGE_REVIEW' })

    const visualReviewer = new MockVisualReviewPort({
      approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null,
    })
    const visual = new VisualReviewRunner({ repository, reviewer: visualReviewer, clock })
    const pages = new PageReviewCoordinator({ repository, reviewer: visual, artifacts, renderer, clock })
    expect(await pages.reviewAll(runId)).toMatchObject({ status: 'DECK_REVIEW', rejected: 0 })
    expect(planned.blueprint?.visualDirection).toContain('统一儿童友好教育插画风格')
    expect(planned.blueprint?.visualDirection).not.toContain('第一页导入百分数')
    expect([...visualReviewer.requests.values()].every((request) => (
      request.visualDirection === planned.blueprint?.visualDirection
      && !request.visualDirection.includes('第一页导入百分数')
    ))).toBe(true)
    const deck = new DeckReviewRunner({
      repository,
      documents,
      reviewer: new MockDeckReviewPort({
        qualityScore: 92,
        curriculumCoverageScore: 94,
        narrativeCoherenceScore: 91,
        visualConsistencyScore: 90,
        compositionScore: 92,
        summary: '十二页审核稿按顺序完整生成，内容与视觉均达到课堂交付标准。',
        reviewedSourceChunkIds: approvedDocument.chunks.map((chunk) => chunk.id),
        issues: [],
      }),
      artifacts,
      renderer,
      clock,
    })
    expect(await deck.review(runId)).toMatchObject({ passed: true })
    const delivered = await new DeliveryRunner({ repository, artifacts, renderer, clock }).deliver(runId)
    expect(delivered).toMatchObject({ status: 'COMPLETED' })
    expect(await repository.listDeliveries(runId)).toHaveLength(1)
    expect(renderer).toMatchObject({ previewCalls: 1, pptxCalls: 1 })
  })

  test('revises one rejected page before delivery without a real provider call', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock()
    const documents = new StaticDocumentPort()
    const planningModel = new MockStructuredModelPort(blueprintDraft())
    const budget = new MockBudgetPort()
    const images = new MockImageGenerationPort()
    const artifacts = new MockArtifactPort()
    const visualReviewer = new MockVisualReviewPort({
      approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null,
    })
    const passingDeckReview = {
      qualityScore: 90, curriculumCoverageScore: 94, narrativeCoherenceScore: 89,
      visualConsistencyScore: 88, compositionScore: 90,
      summary: '十五页课件完整覆盖教材片段，局部修订后达到交付门禁。',
      reviewedSourceChunkIds: Array.from({ length: 15 }, (_, index) => `chunk-${index + 1}`),
      issues: [],
    }
    const deckReviewer = new MockDeckReviewPort({
      ...passingDeckReview,
      qualityScore: 74,
      visualConsistencyScore: 68,
      summary: '整体内容完整，但第八页视觉素材与课程风格不一致，需要局部重绘。',
      issues: [{
        id: 'issue-slide-8', category: 'VISUAL_CONSISTENCY', severity: 'WARNING',
        summary: '第八页视觉素材与整套课程风格不一致。',
        slideIds: [`run-placeholder:slide:8`], sourceChunkIds: [], status: 'OPEN', repairDomain: 'ASSET',
      }],
    })
    const renderer = new MockPresentationRendererPort()
    const runs = new RunService({ repository, clock })
    const created = await runs.create({
      schemaVersion: CONTRACT_VERSION,
      host,
      source: { kind: 'TEXT', name: '七年级生物教材.txt', text: '这是十五页 Mock E2E 使用的完整教材正文。'.repeat(8) },
      slideCount: 15,
      visualDirection: '清晰、克制、适合七年级课堂的科学信息图风格',
      imageModel: 'mock-image',
      automationLevel: 'BOUNDED_AUTO',
      budgetUnits: 60,
      maxRevisionRounds: 2,
    }, 'e2e-create-run-0001')
    const runId = created.run.id
    deckReviewer.response = {
      ...(deckReviewer.response as Record<string, unknown>),
      issues: [{
        id: 'issue-slide-8', category: 'VISUAL_CONSISTENCY', severity: 'WARNING',
        summary: '第八页视觉素材与整套课程风格不一致。',
        slideIds: [`${runId}:slide:8`], sourceChunkIds: [], status: 'OPEN', repairDomain: 'ASSET',
      }],
    }

    const planning = new PlanningRunner({ repository, documents, model: planningModel, clock })
    const planned = await planning.plan({
      runId,
      stepId: `step-${runId}-plan`,
      idempotencyKey: `${runId}:blueprint:v1`,
      source: created.run.source,
      slideCount: 15,
      visualDirection: created.run.visualDirection,
    })
    expect(planned.blueprint?.slides).toHaveLength(15)

    const approved = await runs.act(runId, host, {
      schemaVersion: CONTRACT_VERSION,
      type: 'APPROVE_BLUEPRINT',
      expectedVersion: 1,
    }, 'e2e-approve-blueprint-0001')
    expect(approved.status).toBe('EXECUTING')

    const media = new MediaStepRunner({ repository, budget, images, clock })
    const generation = new SlideGenerationCoordinator({ repository, media, documents, artifacts, clock })
    const submitted = await generation.submitBlueprintImages(runId, 2)
    expect(submitted).toMatchObject({ submitted: 15, total: 15 })
    expect(images.operations.size).toBe(15)

    for (let pageNumber = 1; pageNumber <= 15; pageNumber += 1) {
      const key = `${runId}:slide:${pageNumber}:image:r0:v1`
      const sourceArtifact = await artifacts.put({
        tenantId: host.tenantId,
        runId,
        name: `slide-${pageNumber}.png`,
        mimeType: 'image/png',
        bytes: new TextEncoder().encode(`mock-controlled-image-${pageNumber}`),
        idempotencyKey: `${key}:source-artifact`,
      })
      images.complete(key, sourceArtifact.artifactId)
    }
    const generated = await generation.refreshBlueprintImages(runId)
    expect(generated).toMatchObject({ status: 'PAGE_REVIEW', completed: 15, total: 15 })

    const visual = new VisualReviewRunner({ repository, reviewer: visualReviewer, clock })
    const pages = new PageReviewCoordinator({ repository, reviewer: visual, artifacts, renderer, clock })
    const pageReview = await pages.reviewAll(runId)
    expect(pageReview).toMatchObject({ status: 'DECK_REVIEW', approved: 30, rejected: 0 })

    const deck = new DeckReviewRunner({ repository, documents, reviewer: deckReviewer, artifacts, renderer, clock })
    const firstDeckReview = await deck.review(runId)
    expect(firstDeckReview).toMatchObject({ passed: false, review: { qualityScore: 74 } })

    const revisionPlannerPort = new MockRevisionPlanningPort({
      summary: '仅重绘第八页不一致的视觉素材，其他十四页保持不变。',
      operations: [{
        id: 'operation-slide-8', slideId: `${runId}:slide:8`, kind: 'REGENERATE_IMAGE',
        issueIds: ['issue-slide-8'],
        instruction: 'Use the established classroom biology style and preserve a clean text-safe area.',
        sourceChunkIds: ['chunk-8'],
      }],
    })
    const revisionPlanner = new RevisionPlanningRunner({
      repository, documents, planner: revisionPlannerPort, clock,
    })
    expect(await revisionPlanner.plan(runId)).toMatchObject({ status: 'REVISING', plan: { revisionRound: 1 } })

    const revisedDraft = blueprintDraft()
    revisedDraft.slides[7]!.visualPrompt = 'A corrected classroom biology illustration matching the established deck style, no text or symbols'
    const revisionApplicationPort = new MockRevisionApplicationPort(revisedDraft)
    const revisionApplication = new RevisionApplicationRunner({
      repository, documents, application: revisionApplicationPort, clock,
    })
    expect(await revisionApplication.apply(runId)).toMatchObject({ status: 'REVISING', requiresMedia: true })

    const revisionMedia = new RevisionMediaCoordinator({ repository, media, clock })
    expect(await revisionMedia.submit(runId, 2)).toMatchObject({ submitted: 1, total: 1 })
    const revisedImageKey = `${runId}:slide:8:image:r1:v1`
    const revisedSourceArtifact = await artifacts.put({
      tenantId: host.tenantId, runId, name: 'slide-8-r1.png', mimeType: 'image/png',
      bytes: new TextEncoder().encode('mock-controlled-image-8-r1'),
      idempotencyKey: `${revisedImageKey}:source-artifact`,
    })
    images.complete(revisedImageKey, revisedSourceArtifact.artifactId)
    expect(await revisionMedia.refresh(runId)).toMatchObject({ status: 'PAGE_REVIEW', completed: 1 })
    expect(await pages.reviewAll(runId)).toMatchObject({ status: 'DECK_REVIEW', approved: 30, rejected: 0 })

    deckReviewer.response = passingDeckReview
    const finalDeckReview = await deck.review(runId)
    expect(finalDeckReview).toMatchObject({ passed: true, review: { qualityScore: 90 } })

    const delivery = new DeliveryRunner({ repository, artifacts, renderer, clock })
    const delivered = await delivery.deliver(runId)
    expect(delivered).toMatchObject({ status: 'COMPLETED', delivery: { qualityOverride: false } })
    expect(await repository.getRun(runId)).toMatchObject({
      status: 'COMPLETED',
      slideCount: 15,
      committedBudgetUnits: 32,
      revisionRound: 1,
      qualityScore: 90,
    })
    expect(await repository.listDeliveries(runId)).toHaveLength(1)
    expect(planningModel.executions.size).toBe(1)
    expect(visualReviewer.reviews.size).toBe(46)
    expect(deckReviewer.evaluations.size).toBe(2)
    expect(revisionPlannerPort.plans.size).toBe(1)
    expect(revisionApplicationPort.applications.size).toBe(1)
    expect(renderer).toMatchObject({ previewCalls: 1, pptxCalls: 1 })
  })
})

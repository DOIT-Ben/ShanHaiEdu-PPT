import { describe, expect, test } from 'bun:test'
import {
  blueprintDraftSchema,
  blueprintReflectionSchema,
  deckReviewDraftSchema,
  deliveryRecordSchema,
  revisionPlanSchema,
} from '../src/presentation-contracts'

function draft() {
  return {
    title: '光合作用',
    curriculum: {
      subject: '生物',
      grade: '七年级',
      lessonTitle: '绿色植物的光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
      learningObjectives: ['理解光合作用的基本条件和主要产物'],
      scopeBoundaries: ['只覆盖教材给出的定性过程'],
      prohibitedExtensions: ['不扩展到高中阶段的复杂反应式'],
      sourceChunkIds: ['chunk-0001'],
    },
    slides: [
      {
        pageNumber: 1,
        title: '认识光合作用',
        body: ['绿色植物能够利用光能制造有机物'],
        layout: 'HERO',
        visualIntent: '用绿色叶片和阳光建立课程主题视觉',
        visualPrompt: 'A clean classroom illustration of green leaves receiving sunlight, no text or symbols',
        sourceChunkIds: ['chunk-0001'],
      },
      {
        pageNumber: 2,
        title: '条件与产物',
        body: ['需要光和叶绿体', '产生有机物并释放氧气'],
        layout: 'SPLIT',
        visualIntent: '使用左右构图区分反应条件与结果',
        visualPrompt: 'A balanced botanical science illustration with clear empty areas, no text or symbols',
        sourceChunkIds: ['chunk-0001'],
      },
    ],
  }
}

describe('presentation blueprint contract', () => {
  test('accepts continuous pages with source references', () => {
    expect(blueprintDraftSchema.parse(draft()).slides).toHaveLength(2)
  })

  test('rejects page gaps and unbounded layouts', () => {
    const pageGap = draft()
    pageGap.slides[1]!.pageNumber = 3
    expect(() => blueprintDraftSchema.parse(pageGap)).toThrow('slide page numbers must be continuous')

    const invalidLayout = draft()
    invalidLayout.slides[0]!.layout = 'FREEFORM'
    expect(() => blueprintDraftSchema.parse(invalidLayout)).toThrow()
  })

  test('requires every curriculum and slide section to cite source chunks', () => {
    const missingSources = draft()
    missingSources.slides[0]!.sourceChunkIds = []
    expect(() => blueprintDraftSchema.parse(missingSources)).toThrow()
  })

  test('requires reflection to cover every quality dimension exactly once', () => {
    const dimensions = [
      'AUDIENCE_FIT',
      'GOAL_ALIGNMENT',
      'NARRATIVE',
      'INFORMATION_HIERARCHY',
      'COMPOSITION',
      'VISUAL_COHERENCE',
      'PROMPT_EXECUTABILITY',
    ] as const
    const reflection = {
      deckBrief: {
        targetAudience: '七年级学生',
        presentationGoal: '帮助学生建立光合作用条件与产物的基本心智模型',
        useContext: '教师在课堂上配合讲解使用',
        audienceNeeds: ['先建立直观情境，再区分条件和产物'],
        narrativeArc: ['用生活化主视觉引出主题', '比较条件与产物并形成结论'],
        visualSystem: {
          artDirection: '自然科学编辑插画，以真实叶片结构和柔和日光建立清晰焦点',
          palette: '叶绿、日光黄、氧气蓝和中性白',
          compositionRules: ['每页只保留一个主要视觉焦点', '文字安全区保持自然留白'],
          continuityRules: ['统一光线方向和插画材质', '相邻页面改变构图但复用核心色彩'],
        },
      },
      findings: dimensions.map((dimension) => ({
        dimension,
        score: 4,
        diagnosis: '当前方案方向正确，但还需要更具体地约束本维度的设计选择。',
        revisionInstruction: '在修订稿中加入可执行的页面级约束并保持教材引用不变。',
      })),
      revisedBlueprint: draft(),
    }

    expect(blueprintReflectionSchema.parse(reflection).findings).toHaveLength(7)
    expect(blueprintReflectionSchema.safeParse({
      ...reflection,
      findings: reflection.findings.map((finding) => ({ ...finding, dimension: 'AUDIENCE_FIT' })),
    }).success).toBe(false)
  })
})

describe('deck review and revision contracts', () => {
  const issue = {
    id: 'issue-1',
    category: 'FACTUAL_RISK',
    severity: 'CRITICAL',
    summary: '第二页中的产物描述缺少教材限定条件。',
    slideIds: ['run-1:slide:2'],
    sourceChunkIds: ['chunk-2'],
    status: 'OPEN',
  } as const

  test('accepts a strict source-grounded deck review', () => {
    const parsed = deckReviewDraftSchema.parse({
      qualityScore: 76,
      curriculumCoverageScore: 82,
      narrativeCoherenceScore: 78,
      visualConsistencyScore: 74,
      compositionScore: 70,
      summary: '整套课件结构完整，但存在一处事实限定和视觉一致性问题。',
      reviewedSourceChunkIds: ['chunk-1', 'chunk-2'],
      issues: [issue],
    })

    expect(parsed.issues[0]?.sourceChunkIds).toEqual(['chunk-2'])
  })

  test('rejects factual issues without source references and unknown fields', () => {
    expect(deckReviewDraftSchema.safeParse({
      qualityScore: 76,
      curriculumCoverageScore: 82,
      narrativeCoherenceScore: 78,
      visualConsistencyScore: 74,
      compositionScore: 70,
      summary: '整套课件结构完整，但存在一处事实限定和视觉一致性问题。',
      reviewedSourceChunkIds: ['chunk-1'],
      issues: [{ ...issue, sourceChunkIds: [] }],
      modelThreshold: 80,
    }).success).toBe(false)
  })

  test('requires revision operations to target concrete issues within two rounds', () => {
    const plan = revisionPlanSchema.parse({
      id: 'revision-plan-1',
      reviewId: 'deck-review-1',
      revisionRound: 1,
      createdAt: '2026-07-21T00:00:00.000Z',
      summary: '仅修订第二页的事实表述和对应视觉素材。',
      operations: [{
        id: 'operation-1',
        slideId: 'run-1:slide:2',
        kind: 'UPDATE_CONTENT',
        issueIds: ['issue-1'],
        instruction: '依据教材限定条件重写第二页产物描述，不增加教材外知识。',
        sourceChunkIds: ['chunk-2'],
      }],
    })

    expect(plan.operations).toHaveLength(1)
    expect(revisionPlanSchema.safeParse({ ...plan, revisionRound: 5 }).success).toBe(false)
    expect(revisionPlanSchema.safeParse({
      ...plan,
      operations: [{ ...plan.operations[0], issueIds: [] }],
    }).success).toBe(false)
  })
})

test('delivery contract requires one PNG preview and one PPTX artifact', () => {
  const delivery = deliveryRecordSchema.parse({
    id: 'delivery-1',
    runId: 'run-1',
    revisionRound: 1,
    qualityScore: 88,
    qualityOverride: false,
    preview: {
      artifactId: 'artifact-preview',
      name: 'preview.png',
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      byteLength: 128,
    },
    pptx: {
      artifactId: 'artifact-pptx',
      name: 'lesson.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      sha256: 'b'.repeat(64),
      byteLength: 1024,
    },
    sources: {
      artifactId: 'artifact-sources', name: 'asset-sources.json', mimeType: 'application/json',
      sha256: 'c'.repeat(64), byteLength: 256,
    },
    createdAt: '2026-07-21T00:00:00.000Z',
  })

  expect(delivery.preview.mimeType).toBe('image/png')
  expect(delivery.sources?.mimeType).toBe('application/json')
  expect(deliveryRecordSchema.safeParse({
    ...delivery,
    pptx: { ...delivery.pptx, mimeType: 'application/zip' },
  }).success).toBe(false)
})

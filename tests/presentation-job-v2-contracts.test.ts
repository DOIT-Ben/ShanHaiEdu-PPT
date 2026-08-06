import { describe, expect, test } from 'bun:test'
import {
  PRESENTATION_JOB_V2_CONTRACT_VERSION,
  approvedPageDesignSnapshotHash,
  presentationJobV2PublicJobSchema,
  presentationJobV2UsageSchema,
  presentationJobV2CreateRequestSchema,
} from '../src/presentation-job-v2-contracts'

const snapshot = {
  schemaVersion: '1',
  title: '认识三角形',
  subject: '数学',
  gradeBand: '小学一年级',
  lessonDurationMinutes: 40,
  audience: '小学一年级学生',
  objectives: ['辨认三角形的基本特征', '在生活场景中寻找三角形'],
  pages: [
    {
      pageNumber: 1,
      title: '三角形在哪里',
      teachingPurpose: '从熟悉物体中建立三角形的直观印象。',
      editableCopy: ['观察屋顶、路标和积木的边。'],
      layoutIntent: '左侧展示物体，右侧突出三条边围成的形状。',
      visualRequirements: ['展示三个日常物体'],
      teacherNotes: '引导学生描述看到的边和角。',
      teacherScript: '请大家找一找，哪些物体上藏着三角形？',
      studentActivity: '圈出图片中的三角形。',
      animationSequence: ['依次高亮三个物体', '描出三角形轮廓'],
      boardPlan: '板书三条线段首尾相连。',
      evidence: [{ type: 'FACT', text: '三角形由三条线段首尾相连围成。', source: '课程标准材料' }],
    },
    {
      pageNumber: 2,
      title: '三角形的特征',
      teachingPurpose: '归纳三条边和三个角的结构特征。',
      editableCopy: ['三条边', '三个角'],
      layoutIntent: '中心为大三角形，周围标注边和角。',
      visualRequirements: ['使用高对比标注'],
      teacherNotes: '让学生跟读结构名称。',
      teacherScript: '数一数，三角形有几条边、几个角？',
      studentActivity: '用手指沿着三条边比划。',
      animationSequence: ['出现三条边', '出现三个角'],
      boardPlan: '画一个三角形并标出三条边。',
      evidence: [{ type: 'FACT', text: '三角形有三条边和三个角。', source: '课程标准材料' }],
    },
  ],
} as const

describe('Presentation Job V2 contract', () => {
  test('requires an immutable approved-page-design snapshot with a recomputable canonical hash', () => {
    const sha256 = approvedPageDesignSnapshotHash(snapshot)
    expect(sha256).toBe('ce6f1c9e7f3ad42ba0231ea8638739c94116abb938bea5d73b1e945580400f92')
    const request = {
      source: {
        kind: 'APPROVED_PAGE_DESIGN',
        artifactVersionId: 'approved-design-v17',
        sha256,
        snapshot,
      },
    }

    expect(PRESENTATION_JOB_V2_CONTRACT_VERSION).toBe('2.0')
    expect(presentationJobV2CreateRequestSchema.parse(request)).toMatchObject({
      source: { kind: 'APPROVED_PAGE_DESIGN', artifactVersionId: 'approved-design-v17', sha256 },
    })
    expect(presentationJobV2CreateRequestSchema.safeParse({
      ...request,
      budgetUnits: 10,
    }).success).toBe(false)
    expect(presentationJobV2CreateRequestSchema.safeParse({
      ...request,
      source: { ...request.source, sha256: '0'.repeat(64) },
    }).success).toBe(false)
  })

  test('limits public Job and Usage projections to stable delivery and reconciliation facts', () => {
    const artifact = {
      artifactId: 'artifact-a',
      name: 'lesson.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      sha256: 'a'.repeat(64),
      byteLength: 100,
    }
    const completed = {
      contractVersion: '2.0', jobId: 'job-a', status: 'COMPLETED', phase: 'COMPLETE',
      progress: { percent: 100 }, usagePolicy: { maximumBillableImageOperationsPerPage: 5 },
      quality: 'PASSED', artifact,
      createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:01.000Z',
    }
    expect(presentationJobV2PublicJobSchema.parse(completed)).toMatchObject(completed)
    expect(presentationJobV2PublicJobSchema.safeParse({ ...completed, generationPlan: {} }).success).toBe(false)
    expect(presentationJobV2PublicJobSchema.safeParse({ ...completed, artifact: null }).success).toBe(false)
    expect(presentationJobV2UsageSchema.safeParse({
      contractVersion: '2.0', jobId: 'job-a', usageVersion: 1, status: 'FINALIZED', action: 'NONE',
      usagePolicy: { maximumBillableImageOperationsPerPage: 5 },
      billableImageOperations: 2, notChargedImageOperations: 0, unknownImageOperations: 0,
      byModel: [{
        model: 'gemini-3-pro-image-preview', billableImageOperations: 2,
        notChargedImageOperations: 0, unknownImageOperations: 0,
      }],
      finalizedAt: '2026-08-05T00:00:02.000Z',
    }).success).toBe(true)
    expect(presentationJobV2UsageSchema.safeParse({
      contractVersion: '2.0', jobId: 'job-a', usageVersion: 1, status: 'FINALIZED', action: 'NONE',
      usagePolicy: { maximumBillableImageOperationsPerPage: 5 },
      billableImageOperations: 1, notChargedImageOperations: 0, unknownImageOperations: 1,
      byModel: [{
        model: 'gemini-3-pro-image-preview', billableImageOperations: 1,
        notChargedImageOperations: 0, unknownImageOperations: 1,
      }],
      finalizedAt: '2026-08-05T00:00:02.000Z',
    }).success).toBe(false)
    expect(presentationJobV2UsageSchema.safeParse({
      contractVersion: '2.0', jobId: 'job-a', usageVersion: 1, status: 'FINALIZED', action: 'NONE',
      usagePolicy: { maximumBillableImageOperationsPerPage: 5 },
      billableImageOperations: 2, notChargedImageOperations: 0, unknownImageOperations: 0,
      byModel: [{
        model: 'gemini-3-pro-image-preview', billableImageOperations: 1,
        notChargedImageOperations: 0, unknownImageOperations: 0,
      }],
      finalizedAt: '2026-08-05T00:00:02.000Z',
    }).success).toBe(false)
  })
})

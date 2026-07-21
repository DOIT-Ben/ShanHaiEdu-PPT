import { z } from 'zod'

const identifierSchema = z.string().trim().min(1).max(160)
const sourceChunkIdsSchema = z.array(identifierSchema).min(1).max(200)
const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/)

export const slideElementPlacementSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().superRefine((value, context) => {
  if (value.x + value.width > 1.000_001 || value.y + value.height > 1.000_001) {
    context.addIssue({ code: 'custom', message: 'element placement must stay inside the slide' })
  }
})

export const layeredImageElementSchema = z.object({
  kind: z.literal('IMAGE'),
  elementId: identifierSchema,
  role: z.enum(['BASE_LAYER', 'KNOWLEDGE_VISUAL', 'DIAGRAM', 'CHARACTER']),
  knowledgePoint: z.string().trim().min(3).max(500),
  prompt: z.string().trim().min(20).max(3_000),
  negativePrompt: z.string().trim().min(3).max(1_000),
  sourceChunkIds: sourceChunkIdsSchema,
  placement: slideElementPlacementSchema,
  zIndex: z.number().int().min(0).max(100),
  fit: z.enum(['COVER', 'CONTAIN']),
  aspectRatio: z.enum(['16:9', '4:3', '1:1', '3:4']),
  backgroundMode: z.enum(['OPAQUE', 'TRANSPARENT']),
  reuseKey: identifierSchema.optional(),
}).strict()

export const layeredTextElementSchema = z.object({
  kind: z.literal('TEXT'),
  elementId: identifierSchema,
  role: z.enum(['TITLE', 'SUBTITLE', 'BODY', 'CAPTION', 'QUESTION']),
  text: z.string().trim().min(1).max(1_500),
  sourceChunkIds: sourceChunkIdsSchema,
  placement: slideElementPlacementSchema,
  zIndex: z.number().int().min(0).max(100),
  style: z.object({
    fontSize: z.number().int().min(10).max(60),
    bold: z.boolean(),
    color: hexColorSchema,
    align: z.enum(['LEFT', 'CENTER', 'RIGHT']),
  }).strict(),
}).strict()

export const layeredShapeElementSchema = z.object({
  kind: z.literal('SHAPE'),
  elementId: identifierSchema,
  role: z.enum(['CONTENT_PANEL', 'HIGHLIGHT', 'ARROW', 'DIVIDER']),
  shape: z.enum(['RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE', 'LINE', 'ARROW']),
  placement: slideElementPlacementSchema,
  zIndex: z.number().int().min(0).max(100),
  fillColor: hexColorSchema,
  transparency: z.number().int().min(0).max(100),
}).strict()

export const layeredSlideElementSchema = z.discriminatedUnion('kind', [
  layeredImageElementSchema,
  layeredTextElementSchema,
  layeredShapeElementSchema,
])

export const layeredSlideDesignSchema = z.object({
  designKind: z.enum(['COVER', 'CONTENT']),
  backgroundColor: hexColorSchema,
  elements: z.array(layeredSlideElementSchema).min(3).max(16),
}).strict().superRefine((value, context) => {
  const ids = value.elements.map((element) => element.elementId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['elements'], message: 'layer element ids must be unique' })
  }
  const images = value.elements.filter((element) => element.kind === 'IMAGE')
  if (images.filter((element) => element.role === 'BASE_LAYER').length !== 1) {
    context.addIssue({ code: 'custom', path: ['elements'], message: 'layered slide requires exactly one base layer image' })
  }
  if (images.filter((element) => element.role !== 'BASE_LAYER').length > 4) {
    context.addIssue({ code: 'custom', path: ['elements'], message: 'layered slide allows at most four knowledge visual assets' })
  }
  if (!value.elements.some((element) => element.kind === 'TEXT')) {
    context.addIssue({ code: 'custom', path: ['elements'], message: 'layered slide requires editable text' })
  }
})

export const presentationLayoutSchema = z.enum([
  'HERO',
  'SPLIT',
  'EDITORIAL',
  'STATEMENT',
  'IMAGE_FULL',
])

export const curriculumBriefSchema = z.object({
  subject: z.string().trim().min(1).max(100).nullable(),
  grade: z.string().trim().min(1).max(100).nullable(),
  lessonTitle: z.string().trim().min(1).max(200),
  sourceSummary: z.string().trim().min(20).max(4_000),
  learningObjectives: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
  scopeBoundaries: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  prohibitedExtensions: z.array(z.string().trim().min(1).max(300)).max(20),
  sourceChunkIds: sourceChunkIdsSchema,
}).strict()

export const blueprintSlideSchema = z.object({
  pageNumber: z.number().int().positive().max(50),
  title: z.string().trim().min(1).max(120),
  body: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  layout: presentationLayoutSchema,
  visualIntent: z.string().trim().min(10).max(1_000),
  visualPrompt: z.string().trim().min(20).max(3_000),
  sourceChunkIds: sourceChunkIdsSchema,
  layeredDesign: layeredSlideDesignSchema.optional(),
}).strict()

export const blueprintDraftSchema = z.object({
  title: z.string().trim().min(1).max(160),
  curriculum: curriculumBriefSchema,
  slides: z.array(blueprintSlideSchema).min(2).max(50),
}).strict().superRefine((value, context) => {
  value.slides.forEach((slide, index) => {
    if (slide.pageNumber !== index + 1) {
      context.addIssue({
        code: 'custom',
        path: ['slides', index, 'pageNumber'],
        message: 'slide page numbers must be continuous and start at 1',
      })
    }
  })
})

const layeredBlueprintSlideSchema = blueprintSlideSchema.extend({
  layeredDesign: layeredSlideDesignSchema,
}).strict()

export const layeredBlueprintDraftSchema = blueprintDraftSchema.safeExtend({
  slides: z.array(layeredBlueprintSlideSchema).min(2).max(50),
}).strict().superRefine((value, context) => {
  value.slides.forEach((slide, index) => {
    const expected = index === 0 ? 'COVER' : 'CONTENT'
    if (slide.layeredDesign.designKind !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['slides', index, 'layeredDesign', 'designKind'],
        message: index === 0 ? 'first layered slide must be COVER' : 'only the first layered slide may be COVER',
      })
    }
  })
})

export const presentationBlueprintSchema = blueprintDraftSchema.extend({
  id: identifierSchema,
  visualDirection: z.string().trim().min(3).max(1_000),
  renderMode: z.enum(['SLIDE_IMAGE_V2', 'LAYERED_COURSEWARE_V3']).optional(),
  coverDesignMode: z.enum(['INDEPENDENT', 'FOLLOW_TEMPLATE']).optional(),
  createdAt: z.string().datetime(),
}).strict().transform((value) => value.renderMode === 'LAYERED_COURSEWARE_V3' && value.coverDesignMode === undefined
  ? { ...value, coverDesignMode: 'INDEPENDENT' as const }
  : value).superRefine((value, context) => {
  if (value.renderMode !== 'LAYERED_COURSEWARE_V3') return
  value.slides.forEach((slide, index) => {
    if (!slide.layeredDesign) {
      context.addIssue({ code: 'custom', path: ['slides', index, 'layeredDesign'], message: 'layered mode requires a design for every slide' })
      return
    }
    const expected = index === 0 ? 'COVER' : 'CONTENT'
    if (slide.layeredDesign.designKind !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['slides', index, 'layeredDesign', 'designKind'],
        message: index === 0 ? 'first layered slide must be COVER' : 'only the first layered slide may be COVER',
      })
    }
    if (index === 0 && value.coverDesignMode === 'INDEPENDENT') {
      const hasBody = slide.layeredDesign.elements.some((element) => element.kind === 'TEXT' && element.role === 'BODY')
      const hasContentPanel = slide.layeredDesign.elements.some((element) => element.kind === 'SHAPE' && element.role === 'CONTENT_PANEL')
      const hasTitle = slide.layeredDesign.elements.some((element) => element.kind === 'TEXT' && element.role === 'TITLE')
      const hasHeroVisual = slide.layeredDesign.elements.some((element) => element.kind === 'IMAGE' && element.role !== 'BASE_LAYER')
      if (hasBody || hasContentPanel || !hasTitle || !hasHeroVisual) {
        context.addIssue({
          code: 'custom',
          path: ['slides', index, 'layeredDesign', 'elements'],
          message: 'independent cover requires title and hero visual without body copy or content panel',
        })
      }
    }
  })
})

export const slideVisualReviewSchema = z.object({
  approved: z.boolean(),
  textDetected: z.boolean(),
  visualScore: z.number().int().min(0).max(100),
  reasons: z.array(z.string().trim().min(1).max(300)).max(6),
  retryInstruction: z.string().trim().min(10).max(1_000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.approved && value.textDetected) {
    context.addIssue({ code: 'custom', path: ['approved'], message: 'an image with detected text cannot be approved' })
  }
  if (!value.approved && value.retryInstruction === null) {
    context.addIssue({ code: 'custom', path: ['retryInstruction'], message: 'rejected image requires a retry instruction' })
  }
})

export const deckReviewIssueCategorySchema = z.enum([
  'CURRICULUM_GAP',
  'FACTUAL_RISK',
  'SEQUENCE_BREAK',
  'DUPLICATION',
  'COVER_IMPACT',
  'VISUAL_CONSISTENCY',
  'COMPOSITION_CONFLICT',
  'IMAGE_QUALITY',
  'ASSET_RELEVANCE',
  'LAYERING_CONFLICT',
  'CHILD_READABILITY',
])

export const deckReviewIssueSchema = z.object({
  id: identifierSchema,
  category: deckReviewIssueCategorySchema,
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  summary: z.string().trim().min(1).max(500),
  slideIds: z.array(identifierSchema).min(1).max(50),
  sourceChunkIds: z.array(identifierSchema).max(200),
  status: z.literal('OPEN'),
  repairDomain: z.enum(['KNOWLEDGE', 'ASSET', 'LAYOUT']).optional(),
}).strict().superRefine((value, context) => {
  if (['CURRICULUM_GAP', 'FACTUAL_RISK'].includes(value.category) && value.sourceChunkIds.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['sourceChunkIds'],
      message: 'curriculum and factual issues require source references',
    })
  }
})

export const deckReviewDraftSchema = z.object({
  qualityScore: z.number().int().min(0).max(100),
  curriculumCoverageScore: z.number().int().min(0).max(100),
  narrativeCoherenceScore: z.number().int().min(0).max(100),
  visualConsistencyScore: z.number().int().min(0).max(100),
  compositionScore: z.number().int().min(0).max(100),
  summary: z.string().trim().min(10).max(1_000),
  reviewedSourceChunkIds: z.array(identifierSchema).min(1).max(200),
  issues: z.array(deckReviewIssueSchema).max(100),
}).strict()

export const deckReviewSchema = deckReviewDraftSchema.extend({
  id: identifierSchema,
  revisionRound: z.number().int().min(0).max(2),
  createdAt: z.string().datetime(),
}).strict()

export const revisionOperationSchema = z.object({
  id: identifierSchema,
  slideId: identifierSchema,
  kind: z.enum(['UPDATE_CONTENT', 'REGENERATE_IMAGE', 'RELAYOUT']),
  issueIds: z.array(identifierSchema).min(1).max(20),
  instruction: z.string().trim().min(10).max(2_000),
  sourceChunkIds: z.array(identifierSchema).max(200),
  targetElementId: identifierSchema.optional(),
}).strict()

export const revisionPlanDraftSchema = z.object({
  summary: z.string().trim().min(10).max(1_000),
  operations: z.array(revisionOperationSchema).min(1).max(50),
}).strict()

export const revisionPlanSchema = revisionPlanDraftSchema.extend({
  id: identifierSchema,
  reviewId: identifierSchema,
  revisionRound: z.number().int().min(1).max(2),
  createdAt: z.string().datetime(),
}).strict()

export const deliveryArtifactSchema = z.object({
  artifactId: identifierSchema,
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(160),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive(),
}).strict()

export const deliveryRecordSchema = z.object({
  id: identifierSchema,
  runId: identifierSchema,
  revisionRound: z.number().int().min(0).max(2),
  qualityScore: z.number().int().min(0).max(100).nullable(),
  qualityOverride: z.boolean(),
  qualityOverrideAudit: z.object({
    actorId: identifierSchema,
    actorRole: z.enum(['USER', 'ADMIN']),
    reason: z.string().trim().min(10).max(2_000),
    issueIds: z.array(identifierSchema).min(1).max(50),
    acceptedAt: z.string().datetime(),
  }).strict().nullable().optional(),
  preview: deliveryArtifactSchema.extend({ mimeType: z.literal('image/png') }).strict(),
  pptx: deliveryArtifactSchema.extend({
    mimeType: z.literal('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict()

export type BlueprintDraft = z.infer<typeof blueprintDraftSchema>
export type PresentationBlueprint = z.infer<typeof presentationBlueprintSchema>
export type SlideVisualReview = z.infer<typeof slideVisualReviewSchema>
export type DeckReviewIssue = z.infer<typeof deckReviewIssueSchema>
export type DeckReviewDraft = z.infer<typeof deckReviewDraftSchema>
export type DeckReview = z.infer<typeof deckReviewSchema>
export type RevisionPlanDraft = z.infer<typeof revisionPlanDraftSchema>
export type RevisionPlan = z.infer<typeof revisionPlanSchema>
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>

export function revisionRepairDomain(operation: z.infer<typeof revisionOperationSchema>) {
  if (operation.kind === 'UPDATE_CONTENT') return 'KNOWLEDGE' as const
  if (operation.kind === 'REGENERATE_IMAGE') return 'ASSET' as const
  return 'LAYOUT' as const
}

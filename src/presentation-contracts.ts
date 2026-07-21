import { z } from 'zod'

const identifierSchema = z.string().trim().min(1).max(160)
const sourceChunkIdsSchema = z.array(identifierSchema).min(1).max(200)

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

export const presentationBlueprintSchema = blueprintDraftSchema.extend({
  id: identifierSchema,
  visualDirection: z.string().trim().min(3).max(1_000),
  createdAt: z.string().datetime(),
}).strict()

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
])

export const deckReviewIssueSchema = z.object({
  id: identifierSchema,
  category: deckReviewIssueCategorySchema,
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  summary: z.string().trim().min(1).max(500),
  slideIds: z.array(identifierSchema).min(1).max(50),
  sourceChunkIds: z.array(identifierSchema).max(200),
  status: z.literal('OPEN'),
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

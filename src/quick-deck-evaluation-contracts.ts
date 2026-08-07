import { z } from 'zod'
import { CONTRACT_VERSION } from './contracts'

export const QUICK_DECK_EVALUATION_ARTIFACT_PREFIX = 'quick-deck-evaluation'
export const QUICK_DECK_EVALUATION_MAX_SLIDES = 10

const identifierSchema = z.string().trim().min(1).max(160)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const dateTimeSchema = z.string().datetime()

export const quickDeckEvaluationRequestSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  source: z.object({
    kind: z.literal('TEXT'),
    name: z.string().trim().min(1).max(240).optional(),
    text: z.string().trim().min(20).max(200_000),
  }).strict(),
  slideCount: z.number().int().min(1).max(QUICK_DECK_EVALUATION_MAX_SLIDES),
  visualDirection: z.string().trim().min(3).max(1_000),
  imageModel: z.string().trim().min(1).max(120),
  audience: z.string().trim().min(3).max(500).optional(),
}).strict()

export const quickDeckEvaluationStatusSchema = z.enum([
  'QUEUED',
  'PLANNING',
  'SUBMITTING_IMAGES',
  'GENERATING',
  'PACKAGING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
])

export const quickDeckEvaluationPhaseSchema = z.enum([
  'ACCEPTED',
  'CREATIVE_PLANNING',
  'IMAGE_GENERATION',
  'PPTX_PACKAGING',
  'COMPLETE',
  'FAILED',
  'EXPIRED',
])

export const quickDeckEvaluationFailureCodeSchema = z.enum([
  'EVALUATION_INTERRUPTED',
  'EVALUATION_MODEL_PROTOCOL_INVALID',
  'EVALUATION_PLANNING_FAILED',
  'EVALUATION_IMAGE_SUBMISSION_FAILED',
  'EVALUATION_IMAGE_SUBMISSION_PARTIAL',
  'EVALUATION_IMAGE_SUBMISSION_UNKNOWN',
  'EVALUATION_IMAGE_DRAIN_TIMEOUT',
  'EVALUATION_IMAGE_TASK_FAILED',
  'EVALUATION_IMAGE_RATIO_INVALID',
  'EVALUATION_IMAGE_ARTIFACT_INVALID',
  'EVALUATION_PACKAGING_FAILED',
])

export const quickDeckEvaluationPageSchema = z.object({
  pageNumber: z.number().int().min(1).max(QUICK_DECK_EVALUATION_MAX_SLIDES),
  status: z.enum(['PENDING', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED']),
  width: z.number().int().positive().max(20_000).nullable(),
  height: z.number().int().positive().max(20_000).nullable(),
  aspectRatioValidated: z.boolean(),
  sha256: sha256Schema.nullable(),
}).strict()

export const quickDeckEvaluationArtifactSchema = z.object({
  mimeType: z.enum([
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png',
  ]),
  sha256: sha256Schema,
  byteLength: z.number().int().positive(),
}).strict()

const quickDeckEvaluationArtifactsSchema = z.object({
  pptx: quickDeckEvaluationArtifactSchema.nullable(),
  preview: quickDeckEvaluationArtifactSchema.nullable(),
}).strict()

const quickDeckEvaluationQualitySchema = z.object({
  state: z.literal('NOT_ASSESSED'),
  score: z.null(),
  rubric: z.null(),
}).strict()

export const quickDeckEvaluationPublicJobSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  jobId: identifierSchema,
  status: quickDeckEvaluationStatusSchema,
  phase: quickDeckEvaluationPhaseSchema,
  slideCount: z.number().int().min(1).max(QUICK_DECK_EVALUATION_MAX_SLIDES),
  aspectRatio: z.literal('16:9'),
  models: z.object({
    text: z.string().trim().min(1).max(120),
    image: z.string().trim().min(1).max(120),
  }).strict(),
  progress: z.object({
    planned: z.boolean(),
    submittedPages: z.number().int().min(0).max(QUICK_DECK_EVALUATION_MAX_SLIDES),
    completedPages: z.number().int().min(0).max(QUICK_DECK_EVALUATION_MAX_SLIDES),
    totalPages: z.number().int().min(1).max(QUICK_DECK_EVALUATION_MAX_SLIDES),
  }).strict(),
  pages: z.array(quickDeckEvaluationPageSchema).min(1).max(QUICK_DECK_EVALUATION_MAX_SLIDES),
  artifacts: quickDeckEvaluationArtifactsSchema,
  quality: quickDeckEvaluationQualitySchema,
  failure: z.object({ code: quickDeckEvaluationFailureCodeSchema }).strict().nullable(),
  createdAt: dateTimeSchema,
  startedAt: dateTimeSchema.nullable(),
  completedAt: dateTimeSchema.nullable(),
  expiresAt: dateTimeSchema,
  durationMs: z.number().int().nonnegative().nullable(),
}).strict().superRefine((value, context) => {
  const completed = value.status === 'COMPLETED'
  if (completed && (value.phase !== 'COMPLETE' || value.completedAt === null || value.failure !== null
    || value.progress.completedPages !== value.progress.totalPages || !value.artifacts.pptx || !value.artifacts.preview)) {
    context.addIssue({ code: 'custom', message: 'completed evaluation requires complete artifacts and page progress' })
  }
  if (value.status === 'FAILED' && (value.phase !== 'FAILED' || value.failure === null || value.completedAt === null)) {
    context.addIssue({ code: 'custom', message: 'failed evaluation requires a stable failure code and completion time' })
  }
  if (value.status === 'EXPIRED' && value.phase !== 'EXPIRED') {
    context.addIssue({ code: 'custom', message: 'expired evaluation requires expired phase' })
  }
  if (value.status !== 'COMPLETED' && (value.artifacts.pptx || value.artifacts.preview)) {
    context.addIssue({ code: 'custom', path: ['artifacts'], message: 'only completed evaluations expose artifacts' })
  }
  if (value.pages.length !== value.slideCount || value.pages.some((page, index) => page.pageNumber !== index + 1)) {
    context.addIssue({ code: 'custom', path: ['pages'], message: 'evaluation page records must be continuous and match slide count' })
  }
})

export const quickDeckEvaluationEnvelopeSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  requestId: identifierSchema,
  data: quickDeckEvaluationPublicJobSchema,
}).strict()

const eventBase = {
  schemaVersion: z.literal(CONTRACT_VERSION),
  jobId: identifierSchema,
  sequence: z.number().int().positive(),
  eventId: identifierSchema,
  occurredAt: dateTimeSchema,
}

export const quickDeckEvaluationEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('evaluation.accepted'), payload: z.object({ slideCount: z.number().int().min(1).max(10) }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('planning.started'), payload: z.object({}).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('planning.completed'), payload: z.object({ slideCount: z.number().int().min(1).max(10) }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('images.submitted'), payload: z.object({ submittedPages: z.number().int().min(0).max(10), totalPages: z.number().int().min(1).max(10) }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('images.draining'), payload: z.object({ pendingPages: z.number().int().min(0).max(10), failedPages: z.number().int().min(0).max(10), totalPages: z.number().int().min(1).max(10), drainDeadline: dateTimeSchema }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('images.progress'), payload: z.object({ completedPages: z.number().int().min(0).max(10), totalPages: z.number().int().min(1).max(10) }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('packaging.started'), payload: z.object({}).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('packaging.completed'), payload: z.object({}).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('evaluation.failed'), payload: z.object({ code: quickDeckEvaluationFailureCodeSchema }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('evaluation.expired'), payload: z.object({}).strict() }).strict(),
])

export const quickDeckContentFormatSchema = z.enum(['pptx', 'preview'])

type WithoutSequence<T> = T extends unknown ? Omit<T, 'sequence'> : never

export type QuickDeckEvaluationRequest = z.output<typeof quickDeckEvaluationRequestSchema>
export type QuickDeckEvaluationStatus = z.output<typeof quickDeckEvaluationStatusSchema>
export type QuickDeckEvaluationPhase = z.output<typeof quickDeckEvaluationPhaseSchema>
export type QuickDeckEvaluationFailureCode = z.output<typeof quickDeckEvaluationFailureCodeSchema>
export type QuickDeckEvaluationPage = z.output<typeof quickDeckEvaluationPageSchema>
export type QuickDeckEvaluationArtifact = z.output<typeof quickDeckEvaluationArtifactSchema>
export type QuickDeckEvaluationPublicJob = z.output<typeof quickDeckEvaluationPublicJobSchema>
export type QuickDeckEvaluationEvent = z.output<typeof quickDeckEvaluationEventSchema>
export type QuickDeckEvaluationEventInput = WithoutSequence<QuickDeckEvaluationEvent>
export type QuickDeckContentFormat = z.output<typeof quickDeckContentFormatSchema>

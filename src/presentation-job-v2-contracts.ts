import { createHash } from 'node:crypto'
import { z } from 'zod'

export const PRESENTATION_JOB_V2_CONTRACT_VERSION = '2.0' as const
export const PRESENTATION_JOB_V2_MAX_BILLABLE_IMAGE_OPERATIONS_PER_PAGE = 5 as const
export const PRESENTATION_JOB_V2_USAGE_POLICY = Object.freeze({
  maximumBillableImageOperationsPerPage: PRESENTATION_JOB_V2_MAX_BILLABLE_IMAGE_OPERATIONS_PER_PAGE,
})

const identifierSchema = z.string().trim().min(1).max(160)
const nonEmptyTextSchema = z.string().trim().min(1)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

const approvedEvidenceSchema = z.object({
  type: z.enum(['FACT', 'INFERENCE', 'SUGGESTION']),
  text: nonEmptyTextSchema.max(2_000),
  source: nonEmptyTextSchema.max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.type === 'FACT' && !value.source) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'facts require a source' })
  }
})

const approvedPageDesignPageSchema = z.object({
  pageNumber: z.number().int().min(1).max(50),
  title: nonEmptyTextSchema.max(120),
  teachingPurpose: nonEmptyTextSchema.max(900),
  editableCopy: z.array(nonEmptyTextSchema.max(300)).min(1).max(8),
  layoutIntent: nonEmptyTextSchema.max(500),
  visualRequirements: z.array(nonEmptyTextSchema.max(200)).max(4),
  teacherNotes: nonEmptyTextSchema.max(2_000),
  teacherScript: nonEmptyTextSchema.max(4_000),
  studentActivity: nonEmptyTextSchema.max(2_000),
  animationSequence: z.array(nonEmptyTextSchema.max(500)).min(1).max(20),
  boardPlan: nonEmptyTextSchema.max(2_000),
  evidence: z.array(approvedEvidenceSchema).max(50),
}).strict()

export const approvedPageDesignSnapshotSchema = z.object({
  schemaVersion: z.literal('1'),
  title: nonEmptyTextSchema.max(160),
  subject: nonEmptyTextSchema.max(100),
  gradeBand: nonEmptyTextSchema.max(100),
  lessonDurationMinutes: z.number().int().min(1).max(300),
  audience: nonEmptyTextSchema.max(300),
  objectives: z.array(nonEmptyTextSchema.max(300)).min(1).max(10),
  pages: z.array(approvedPageDesignPageSchema).min(2).max(50),
}).strict().superRefine((value, context) => {
  value.pages.forEach((page, index) => {
    if (page.pageNumber !== index + 1) {
      context.addIssue({
        code: 'custom',
        path: ['pages', index, 'pageNumber'],
        message: 'page numbers must be continuous and start at 1',
      })
    }
  })
})

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function canonicalPresentationJobV2Json(value: unknown) {
  return JSON.stringify(canonicalize(value))
}

export function approvedPageDesignSnapshotHash(snapshot: unknown) {
  const parsed = approvedPageDesignSnapshotSchema.parse(snapshot)
  return createHash('sha256').update(canonicalPresentationJobV2Json(parsed), 'utf8').digest('hex')
}

export const approvedPageDesignSnapshotSourceSchema = z.object({
  kind: z.literal('APPROVED_PAGE_DESIGN'),
  artifactVersionId: identifierSchema,
  sha256: sha256Schema,
  snapshot: approvedPageDesignSnapshotSchema,
}).strict().superRefine((value, context) => {
  if (value.sha256 !== approvedPageDesignSnapshotHash(value.snapshot)) {
    context.addIssue({
      code: 'custom',
      path: ['sha256'],
      message: 'sha256 must match the canonical approved-page-design snapshot',
    })
  }
})

export const presentationJobV2CreateRequestSchema = z.object({
  source: approvedPageDesignSnapshotSourceSchema,
}).strict()

export const presentationJobV2ArtifactSchema = z.object({
  artifactId: identifierSchema,
  name: z.string().trim().min(1).max(240),
  mimeType: z.literal('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  sha256: sha256Schema,
  byteLength: z.number().int().positive(),
}).strict()

export const presentationJobV2UsagePolicySchema = z.object({
  maximumBillableImageOperationsPerPage: z.literal(
    PRESENTATION_JOB_V2_MAX_BILLABLE_IMAGE_OPERATIONS_PER_PAGE,
  ),
}).strict()

export const presentationJobV2PublicJobSchema = z.object({
  contractVersion: z.literal(PRESENTATION_JOB_V2_CONTRACT_VERSION),
  jobId: identifierSchema,
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
  phase: z.enum(['ACCEPTED', 'GENERATING', 'DELIVERING', 'COMPLETE', 'FAILED']),
  progress: z.object({ percent: z.number().int().min(0).max(100) }).strict(),
  usagePolicy: presentationJobV2UsagePolicySchema,
  quality: z.enum(['PASSED', 'BEST_EFFORT']).nullable(),
  artifact: presentationJobV2ArtifactSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.status === 'COMPLETED') {
    if (value.phase !== 'COMPLETE' || value.progress.percent !== 100 || !value.artifact || !value.quality) {
      context.addIssue({ code: 'custom', message: 'completed jobs require a complete phase, quality and artifact' })
    }
  }
  if (value.status === 'FAILED' && (value.phase !== 'FAILED' || value.quality !== null || value.artifact !== null)) {
    context.addIssue({ code: 'custom', message: 'failed jobs cannot publish a quality or artifact' })
  }
})

export const presentationJobV2UsageByModelSchema = z.object({
  model: identifierSchema,
  billableImageOperations: z.number().int().nonnegative(),
  notChargedImageOperations: z.number().int().nonnegative(),
  unknownImageOperations: z.number().int().nonnegative(),
}).strict()

export const presentationJobV2UsageSummarySchema = z.object({
  billableImageOperations: z.number().int().nonnegative(),
  notChargedImageOperations: z.number().int().nonnegative(),
  unknownImageOperations: z.number().int().nonnegative(),
  byModel: z.array(presentationJobV2UsageByModelSchema).max(20),
}).strict().superRefine((value, context) => {
  const models = new Set<string>()
  const totals = value.byModel.reduce((result, item, index) => {
    if (models.has(item.model)) {
      context.addIssue({ code: 'custom', path: ['byModel', index, 'model'], message: 'usage models must be unique' })
    }
    models.add(item.model)
    return {
      billableImageOperations: result.billableImageOperations + item.billableImageOperations,
      notChargedImageOperations: result.notChargedImageOperations + item.notChargedImageOperations,
      unknownImageOperations: result.unknownImageOperations + item.unknownImageOperations,
    }
  }, { billableImageOperations: 0, notChargedImageOperations: 0, unknownImageOperations: 0 })
  for (const field of ['billableImageOperations', 'notChargedImageOperations', 'unknownImageOperations'] as const) {
    if (totals[field] !== value[field]) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} must equal the byModel total` })
    }
  }
})

export const presentationJobV2UsageSchema = z.object({
  contractVersion: z.literal(PRESENTATION_JOB_V2_CONTRACT_VERSION),
  jobId: identifierSchema,
  usageVersion: z.literal(1),
  usagePolicy: presentationJobV2UsagePolicySchema,
  status: z.enum(['PENDING', 'RECONCILING', 'FINALIZED']),
  action: z.enum(['WAIT', 'NONE']),
  billableImageOperations: z.number().int().nonnegative(),
  notChargedImageOperations: z.number().int().nonnegative(),
  unknownImageOperations: z.number().int().nonnegative(),
  byModel: z.array(presentationJobV2UsageByModelSchema).max(20),
  finalizedAt: z.string().datetime().nullable(),
}).strict().superRefine((value, context) => {
  const summary = presentationJobV2UsageSummarySchema.safeParse({
    billableImageOperations: value.billableImageOperations,
    notChargedImageOperations: value.notChargedImageOperations,
    unknownImageOperations: value.unknownImageOperations,
    byModel: value.byModel,
  })
  if (!summary.success) {
    for (const issue of summary.error.issues) {
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
    }
  }
  if (value.status === 'RECONCILING'
    && (value.action !== 'WAIT' || value.unknownImageOperations < 1 || value.finalizedAt !== null)) {
    context.addIssue({ code: 'custom', message: 'reconciling usage must wait with unknown operations' })
  }
  if (value.status === 'FINALIZED'
    && (value.action !== 'NONE' || value.unknownImageOperations !== 0 || value.finalizedAt === null)) {
    context.addIssue({ code: 'custom', message: 'finalized usage must be immutable and fully known' })
  }
})

export const presentationJobV2EnvelopeSchema = z.object({
  contractVersion: z.literal(PRESENTATION_JOB_V2_CONTRACT_VERSION),
  requestId: identifierSchema,
  data: presentationJobV2PublicJobSchema,
  replayed: z.boolean().optional(),
}).strict()

export const presentationJobV2UsageEnvelopeSchema = z.object({
  contractVersion: z.literal(PRESENTATION_JOB_V2_CONTRACT_VERSION),
  requestId: identifierSchema,
  data: presentationJobV2UsageSchema,
}).strict()

export type ApprovedPageDesignSnapshot = z.infer<typeof approvedPageDesignSnapshotSchema>
export type ApprovedPageDesignSnapshotSource = z.infer<typeof approvedPageDesignSnapshotSourceSchema>
export type PresentationJobV2CreateRequest = z.infer<typeof presentationJobV2CreateRequestSchema>
export type PresentationJobV2Artifact = z.infer<typeof presentationJobV2ArtifactSchema>
export type PresentationJobV2UsagePolicy = z.infer<typeof presentationJobV2UsagePolicySchema>
export type PresentationJobV2PublicJob = z.infer<typeof presentationJobV2PublicJobSchema>
export type PresentationJobV2UsageSummary = z.infer<typeof presentationJobV2UsageSummarySchema>
export type PresentationJobV2Usage = z.infer<typeof presentationJobV2UsageSchema>

import { z } from 'zod'
import { visualDeckV4ConfigSchema, visualDeckV4SourceRoleSchema } from './visual-deck-v4-contracts'
import { releaseIdentitySchema } from './release-identity'

export const CONTRACT_VERSION = '1' as const
export const MAX_PLANNING_RETRIES = 2

const identifierSchema = z.string().trim().min(1).max(160)
const nonEmptyTextSchema = z.string().trim().min(1)

export const hostContextSchema = z.object({
  tenantId: identifierSchema,
  externalUserId: identifierSchema,
  externalProjectId: identifierSchema.optional(),
  role: z.enum(['USER', 'ADMIN']).optional(),
}).strict()

export const runStatusSchema = z.enum([
  'PLANNING',
  'AWAITING_BLUEPRINT_APPROVAL',
  'EXECUTING',
  'PAGE_REVIEW',
  'DECK_REVIEW',
  'AWAITING_REVISION_APPROVAL',
  'REVISING',
  'PAUSED',
  'NEEDS_HUMAN',
  'DELIVERING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])

export const automationLevelSchema = z.enum(['SUPERVISED', 'BOUNDED_AUTO'])
export const presentationModeSchema = z.enum([
  'SLIDE_IMAGE_V2',
  'SLIDE_IMAGE_V2_1',
  'LAYERED_COURSEWARE_V3',
  'VISUAL_DECK_V4',
])
export const coverDesignModeSchema = z.enum(['INDEPENDENT', 'FOLLOW_TEMPLATE'])
export const assetAcquisitionPolicySchema = z.enum(['AI_FIRST', 'SEARCH_FIRST'])

const approvedEvidenceSchema = z.object({
  type: z.enum(['FACT', 'INFERENCE', 'SUGGESTION']),
  text: z.string().trim().min(1).max(2_000),
  source: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.type === 'FACT' && !value.source) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'facts require a source' })
  }
})

const approvedPageDesignPageSchema = z.object({
  pageNumber: z.number().int().min(1).max(50),
  title: z.string().trim().min(1).max(120),
  teachingPurpose: z.string().trim().min(1).max(900),
  editableCopy: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  layoutIntent: z.string().trim().min(1).max(500),
  visualRequirements: z.array(z.string().trim().min(1).max(200)).max(4),
  teacherNotes: z.string().trim().min(1).max(2_000),
  teacherScript: z.string().trim().min(1).max(4_000),
  studentActivity: z.string().trim().min(1).max(2_000),
  animationSequence: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  boardPlan: z.string().trim().min(1).max(2_000),
  evidence: z.array(approvedEvidenceSchema).max(50),
}).strict()

export const approvedPageDesignSourceSchema = z.object({
  kind: z.literal('APPROVED_PAGE_DESIGN'),
  schemaVersion: z.literal(CONTRACT_VERSION),
  artifactVersionId: identifierSchema,
  artifactContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(160),
  subject: z.string().trim().min(1).max(100),
  gradeBand: z.string().trim().min(1).max(100),
  lessonDurationMinutes: z.number().int().min(1).max(300),
  audience: z.string().trim().min(1).max(300),
  objectives: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
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

export const documentSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('TEXT'),
    name: z.string().trim().min(1).max(240).optional(),
    text: z.string().trim().min(20).max(2_000_000),
    roleHint: visualDeckV4SourceRoleSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('HOST_ATTACHMENT'),
    attachmentId: identifierSchema,
    roleHint: visualDeckV4SourceRoleSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('SOURCE_PACKAGE'),
    name: z.string().trim().min(1).max(240).optional(),
    sources: z.array(z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('TEXT'),
        sourceId: identifierSchema,
        name: z.string().trim().min(1).max(240).optional(),
        text: z.string().trim().min(20).max(2_000_000),
        roleHint: visualDeckV4SourceRoleSchema.optional(),
      }).strict(),
      z.object({
        kind: z.literal('HOST_ATTACHMENT'),
        sourceId: identifierSchema,
        attachmentId: identifierSchema,
        roleHint: visualDeckV4SourceRoleSchema.optional(),
      }).strict(),
    ])).min(1).max(7),
  }).strict().superRefine((value, context) => {
    const sourceIds = value.sources.map((source) => source.sourceId)
    if (new Set(sourceIds).size !== sourceIds.length) {
      context.addIssue({ code: 'custom', path: ['sources'], message: 'source ids must be unique' })
    }
    const attachmentIds = value.sources
      .filter((source) => source.kind === 'HOST_ATTACHMENT')
      .map((source) => source.attachmentId)
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      context.addIssue({ code: 'custom', path: ['sources'], message: 'attachment ids must be unique' })
    }
  }),
  approvedPageDesignSourceSchema,
])

export const createRunRequestSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  host: hostContextSchema,
  source: documentSourceSchema,
  slideCount: z.number().int().min(2).max(50),
  visualDirection: z.string().trim().min(3).max(1_000),
  targetAudience: z.string().trim().min(3).max(500).optional(),
  presentationGoal: z.string().trim().min(3).max(1_000).optional(),
  imageModel: z.string().trim().min(1).max(120),
  automationLevel: automationLevelSchema,
  budgetUnits: z.number().int().positive().max(1_000_000),
  maxRevisionRounds: z.number().int().min(0).max(4).default(2),
  presentationMode: presentationModeSchema.default('SLIDE_IMAGE_V2'),
  coverDesignMode: coverDesignModeSchema.default('INDEPENDENT'),
  assetAcquisitionPolicy: assetAcquisitionPolicySchema.default('AI_FIRST'),
  maxVisualAssetsPerSlide: z.number().int().min(1).max(4).default(4),
  visualDeckV4: visualDeckV4ConfigSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.presentationMode === 'VISUAL_DECK_V4' && !value.visualDeckV4) {
    context.addIssue({ code: 'custom', path: ['visualDeckV4'], message: 'visual deck v4 requires mode configuration' })
  }
  if (value.presentationMode !== 'VISUAL_DECK_V4' && value.visualDeckV4) {
    context.addIssue({ code: 'custom', path: ['visualDeckV4'], message: 'visual deck v4 configuration is only valid for v4' })
  }
  const length = value.visualDeckV4?.deckOptions.length
  if (typeof length === 'object' && length.slideCount !== value.slideCount) {
    context.addIssue({ code: 'custom', path: ['visualDeckV4', 'deckOptions', 'length', 'slideCount'], message: 'v4 length must match slideCount' })
  }
})

export const adminRevisionRoundsSettingsSchema = z.object({
  maxRevisionRounds: z.number().int().min(0).max(4),
  version: z.number().int().nonnegative(),
  isConfigured: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
}).strict()

export const adminRevisionRoundsUpdateSchema = z.object({
  maxRevisionRounds: z.number().int().min(0).max(4),
  expectedVersion: z.number().int().nonnegative(),
}).strict()

const actionBase = {
  schemaVersion: z.literal(CONTRACT_VERSION),
  expectedVersion: z.number().int().nonnegative(),
}

export const runActionSchema = z.discriminatedUnion('type', [
  z.object({ ...actionBase, type: z.literal('APPROVE_BLUEPRINT') }).strict(),
  z.object({ ...actionBase, type: z.literal('RETRY_PLANNING') }).strict(),
  z.object({ ...actionBase, type: z.literal('RETRY_DELIVERY') }).strict(),
  z.object({
    ...actionBase,
    type: z.literal('REPLAN'),
    slideCount: z.number().int().min(2).max(50),
    visualDirection: z.string().trim().min(3).max(1_000),
  }).strict(),
  z.object({
    ...actionBase,
    type: z.literal('REQUEST_BLUEPRINT_REVISION'),
    instruction: z.string().trim().min(3).max(2_000),
  }).strict(),
  z.object({ ...actionBase, type: z.literal('PAUSE') }).strict(),
  z.object({ ...actionBase, type: z.literal('RESUME') }).strict(),
  z.object({
    ...actionBase,
    type: z.literal('CANCEL'),
    mode: z.literal('STOP_NEW_SUBMISSIONS').optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  }).strict(),
  z.object({
    ...actionBase,
    type: z.literal('ADD_BUDGET'),
    additionalBudgetUnits: z.number().int().positive().max(1_000_000),
  }).strict(),
  z.object({ ...actionBase, type: z.literal('APPROVE_REVISION') }).strict(),
  z.object({
    ...actionBase,
    type: z.literal('SUBMIT_LIMITED_REVISION'),
    slideId: identifierSchema,
    repairDomain: z.enum(['KNOWLEDGE', 'ASSET', 'LAYOUT']),
    instruction: z.string().trim().min(10).max(2_000),
    targetElementId: identifierSchema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.repairDomain === 'ASSET' && !value.targetElementId) {
      context.addIssue({ code: 'custom', path: ['targetElementId'], message: 'asset revision requires targetElementId' })
    }
    if (value.repairDomain !== 'ASSET' && value.targetElementId) {
      context.addIssue({ code: 'custom', path: ['targetElementId'], message: 'only asset revision may target an element' })
    }
  }),
  z.object({
    ...actionBase,
    type: z.literal('REJECT_REVISION'),
    reason: z.string().trim().min(3).max(1_000),
  }).strict(),
  z.object({
    ...actionBase,
    type: z.literal('ACCEPT_WITH_OVERRIDE'),
    reason: z.string().trim().min(10).max(2_000),
    issueIds: z.array(identifierSchema).min(1).max(50).refine((value) => new Set(value).size === value.length),
  }).strict(),
])

export const planningFailureSchema = z.object({
  errorCode: z.enum([
    'SOURCE_INCOMPLETE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_RATE_LIMIT',
    'PROVIDER_UNAVAILABLE',
    'MODEL_JSON_INVALID',
    'BLUEPRINT_SCHEMA_INVALID',
    'BLUEPRINT_SLIDE_COUNT_MISMATCH',
    'BLUEPRINT_SOURCE_REFERENCE_INVALID',
    'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID',
    'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE',
    'V3_LAYER_CONTRACT_INVALID',
    'VISUAL_ASSET_LIMIT_EXCEEDED',
  ]),
  terminalCode: z.literal('CONTRACT_REPAIR_EXHAUSTED').optional(),
  retryable: z.boolean(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().nonnegative(),
  suggestedAction: z.enum(['RETRY', 'MODIFY_SOURCE', 'CONTACT_ADMIN']),
  diagnosticCode: z.string().trim().min(1).max(100),
  fieldPaths: z.array(z.string().trim().min(1).max(160)).max(20),
  correlationId: identifierSchema,
  requestId: identifierSchema.nullable(),
  model: z.string().trim().min(1).max(120).nullable(),
  contractVersion: z.string().trim().min(1).max(40),
}).strict()

export const issueSummarySchema = z.object({
  id: identifierSchema,
  category: z.enum([
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
    'SOURCE_INCOMPLETE',
    'PLANNING_FAILED',
    'BUDGET_RESERVATION_UNKNOWN',
    'PROVIDER_SUBMISSION_UNKNOWN',
    'PROVIDER_RESULT_FAILED',
  ]),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  summary: z.string().trim().min(1).max(500),
  slideIds: z.array(identifierSchema).max(50),
  sourceChunkIds: z.array(identifierSchema).max(200),
  status: z.enum(['OPEN', 'RESOLVED', 'ACCEPTED']),
  repairDomain: z.enum(['KNOWLEDGE', 'ASSET', 'LAYOUT']).optional(),
  planningFailure: planningFailureSchema.optional(),
}).strict()

export const runSnapshotSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  runId: identifierSchema,
  host: hostContextSchema,
  status: runStatusSchema,
  resumeState: runStatusSchema.nullable(),
  version: z.number().int().nonnegative(),
  slideCount: z.number().int().min(2).max(50),
  revisionRound: z.number().int().nonnegative(),
  maxRevisionRounds: z.number().int().min(0).max(4),
  planningAttempt: z.number().int().min(0).max(MAX_PLANNING_RETRIES),
  maxPlanningRetries: z.literal(MAX_PLANNING_RETRIES),
  budgetUnits: z.number().int().nonnegative(),
  committedBudgetUnits: z.number().int().nonnegative(),
  qualityScore: z.number().int().min(0).max(100).nullable(),
  qualityOverride: z.boolean(),
  presentationMode: presentationModeSchema.default('SLIDE_IMAGE_V2'),
  coverDesignMode: coverDesignModeSchema.default('INDEPENDENT'),
  assetAcquisitionPolicy: assetAcquisitionPolicySchema.default('AI_FIRST'),
  maxVisualAssetsPerSlide: z.number().int().min(1).max(4).default(4),
  release: releaseIdentitySchema.optional(),
  issues: z.array(issueSummarySchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.committedBudgetUnits > value.budgetUnits) {
    context.addIssue({ code: 'custom', path: ['committedBudgetUnits'], message: 'committed budget exceeds run budget' })
  }
  if (value.revisionRound > value.maxRevisionRounds) {
    context.addIssue({ code: 'custom', path: ['revisionRound'], message: 'revision round exceeds configured maximum' })
  }
  if (value.status === 'PAUSED' && value.resumeState === null) {
    context.addIssue({ code: 'custom', path: ['resumeState'], message: 'paused run requires resumeState' })
  }
  if (value.status !== 'PAUSED' && value.resumeState !== null) {
    context.addIssue({ code: 'custom', path: ['resumeState'], message: 'resumeState is only valid while paused' })
  }
})

const eventBase = {
  schemaVersion: z.literal(CONTRACT_VERSION),
  id: identifierSchema,
  eventId: identifierSchema,
  runId: identifierSchema,
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
}

export const v4LifecycleStageSchema = z.enum([
  'PLANNING',
  'GENERATION',
  'PAGE_REVIEW',
  'REVISION',
  'DECK_REVIEW',
  'DELIVERY',
  'RUN',
])

export const v4RevisionKindSchema = z.enum(['PAGE_VISUAL', 'DECK_CONTENT', 'DECK_VISUAL'])

export const v4LifecycleReasonSchema = z.enum([
  'BUDGET_INSUFFICIENT',
  'PROVIDER_TEMPORARILY_UNAVAILABLE',
  'REVISION_LIMIT_REACHED',
  'USER_CONFIRMATION_REQUIRED',
  'PLANNING_FAILED',
  'PAGE_REVIEW_REJECTED',
  'PAGE_REVIEW_FAILED',
  'DECK_REVIEW_REJECTED',
  'DECK_REVIEW_FAILED',
  'REVISION_FAILED',
  'REVISION_REJECTED_BY_USER',
  'DELIVERY_FAILED',
  'INTERNAL_FAILURE',
  'PAUSED_BY_USER',
  'CANCELLED_BY_USER',
])

export const v4LifecycleNextActionSchema = z.enum([
  'APPROVE_BLUEPRINT',
  'ADD_BUDGET',
  'APPROVE_REVISION',
  'RETRY',
  'REVIEW_RESULT',
  'CONTACT_SUPPORT',
])

export const v4RunFailureCodeSchema = z.enum(['WORKER_FATAL'])

function v4LifecyclePayloadSchema<T extends z.ZodRawShape = Record<never, never>>(
  stage: z.infer<typeof v4LifecycleStageSchema>,
  extension?: T,
) {
  return z.object({
    presentationMode: z.literal('VISUAL_DECK_V4'),
    stage: z.literal(stage),
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    pageNumbers: z.array(z.number().int().min(1).max(50)).max(50)
      .refine((value) => new Set(value).size === value.length, 'page numbers must be unique'),
    revisionKind: v4RevisionKindSchema.nullable(),
    revisionRound: z.number().int().nonnegative(),
    maxRevisionRounds: z.number().int().min(0).max(4),
    budgetUnits: z.number().int().nonnegative(),
    committedBudgetUnits: z.number().int().nonnegative(),
    reason: v4LifecycleReasonSchema.nullable(),
    retryable: z.boolean().nullable(),
    requiresUserAction: z.boolean(),
    nextAction: v4LifecycleNextActionSchema.nullable(),
    ...(extension ?? {} as T),
  }).strict().superRefine((value, context) => {
    const lifecycle = value as {
      completed: number
      total: number
      budgetUnits: number
      committedBudgetUnits: number
      requiresUserAction: boolean
      nextAction: string | null
    }
    if (lifecycle.completed > lifecycle.total) {
      context.addIssue({ code: 'custom', path: ['completed'], message: 'completed exceeds total' })
    }
    if (lifecycle.committedBudgetUnits > lifecycle.budgetUnits) {
      context.addIssue({ code: 'custom', path: ['committedBudgetUnits'], message: 'committed budget exceeds run budget' })
    }
    const revision = value as { revisionRound: number; maxRevisionRounds: number }
    if (revision.revisionRound > revision.maxRevisionRounds) {
      context.addIssue({ code: 'custom', path: ['revisionRound'], message: 'revision round exceeds configured maximum' })
    }
    if (lifecycle.requiresUserAction !== (lifecycle.nextAction !== null)) {
      context.addIssue({ code: 'custom', path: ['nextAction'], message: 'next action must match requiresUserAction' })
    }
  })
}

const legacyRunPausedPayloadSchema = z.object({ reason: z.string().min(1).max(500), resumeState: runStatusSchema }).strict()
const legacyRunCancelledPayloadSchema = z.object({
  reason: z.string().max(500).nullable(),
  mode: z.literal('STOP_NEW_SUBMISSIONS').optional(),
}).strict()
const legacyRunCompletedPayloadSchema = z.object({ deliveryId: identifierSchema, qualityOverride: z.boolean() }).strict()
const legacyRunFailedPayloadSchema = z.object({ errorCode: z.string().min(1).max(100) }).strict()

const knownAgentEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('run.started'), payload: z.object({ status: z.literal('PLANNING') }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('phase.changed'), payload: z.object({ from: runStatusSchema, to: runStatusSchema, reason: z.string().max(500).optional() }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('approval.required'), payload: z.object({ kind: z.enum(['BLUEPRINT', 'REVISION', 'BUDGET', 'HUMAN_REVIEW']), summary: z.string().min(1).max(1_000) }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('approval.resolved'), payload: z.object({
    kind: z.enum(['BLUEPRINT', 'REVISION', 'BUDGET', 'HUMAN_REVIEW']),
    actionType: z.string().min(1).max(80),
    actorId: identifierSchema.optional(),
    actorRole: z.enum(['USER', 'ADMIN']).optional(),
    issueIds: z.array(identifierSchema).max(50).optional(),
    reason: z.string().trim().min(10).max(2_000).optional(),
  }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('tool.started'), payload: z.object({ stepId: identifierSchema, tool: z.string().min(1).max(100), label: z.string().min(1).max(240) }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('tool.progress'), payload: z.object({ stepId: identifierSchema, completed: z.number().int().nonnegative(), total: z.number().int().positive(), summary: z.string().max(500).optional() }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('tool.completed'), payload: z.object({ stepId: identifierSchema, summary: z.string().min(1).max(1_000) }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('tool.failed'), payload: z.object({ stepId: identifierSchema, errorCode: z.string().min(1).max(100), retryable: z.boolean() }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('issue.detected'), payload: issueSummarySchema }).strict(),
  z.object({ ...eventBase, type: z.literal('issue.resolved'), payload: z.object({ issueId: identifierSchema, resolution: z.enum(['FIXED', 'ACCEPTED']) }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('budget.updated'), payload: z.object({ budgetUnits: z.number().int().nonnegative(), committedBudgetUnits: z.number().int().nonnegative() }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('planning.started'), payload: v4LifecyclePayloadSchema('PLANNING') }).strict(),
  z.object({ ...eventBase, type: z.literal('planning.completed'), payload: v4LifecyclePayloadSchema('PLANNING') }).strict(),
  z.object({ ...eventBase, type: z.literal('generation.started'), payload: v4LifecyclePayloadSchema('GENERATION') }).strict(),
  z.object({ ...eventBase, type: z.literal('generation.progress'), payload: v4LifecyclePayloadSchema('GENERATION') }).strict(),
  z.object({ ...eventBase, type: z.literal('generation.completed'), payload: v4LifecyclePayloadSchema('GENERATION') }).strict(),
  z.object({ ...eventBase, type: z.literal('page_review.started'), payload: v4LifecyclePayloadSchema('PAGE_REVIEW') }).strict(),
  z.object({ ...eventBase, type: z.literal('page_review.completed'), payload: v4LifecyclePayloadSchema('PAGE_REVIEW') }).strict(),
  z.object({ ...eventBase, type: z.literal('revision.started'), payload: v4LifecyclePayloadSchema('REVISION') }).strict(),
  z.object({ ...eventBase, type: z.literal('revision.progress'), payload: v4LifecyclePayloadSchema('REVISION') }).strict(),
  z.object({ ...eventBase, type: z.literal('revision.completed'), payload: v4LifecyclePayloadSchema('REVISION') }).strict(),
  z.object({ ...eventBase, type: z.literal('deck_review.started'), payload: v4LifecyclePayloadSchema('DECK_REVIEW') }).strict(),
  z.object({ ...eventBase, type: z.literal('deck_review.completed'), payload: v4LifecyclePayloadSchema('DECK_REVIEW') }).strict(),
  z.object({ ...eventBase, type: z.literal('delivery.started'), payload: v4LifecyclePayloadSchema('DELIVERY') }).strict(),
  z.object({ ...eventBase, type: z.literal('delivery.completed'), payload: v4LifecyclePayloadSchema('DELIVERY') }).strict(),
  z.object({ ...eventBase, type: z.literal('run.paused'), payload: z.union([
    legacyRunPausedPayloadSchema,
    v4LifecyclePayloadSchema('RUN', { resumeState: runStatusSchema }),
  ]) }).strict(),
  z.object({ ...eventBase, type: z.literal('run.resumed'), payload: z.object({ status: runStatusSchema }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('run.cancelled'), payload: z.union([
    legacyRunCancelledPayloadSchema,
    v4LifecyclePayloadSchema('RUN', { mode: z.literal('STOP_NEW_SUBMISSIONS') }),
  ]) }).strict(),
  z.object({ ...eventBase, type: z.literal('run.completed'), payload: z.union([
    legacyRunCompletedPayloadSchema,
    v4LifecyclePayloadSchema('RUN', { deliveryId: identifierSchema, qualityOverride: z.boolean() }),
  ]) }).strict(),
  z.object({ ...eventBase, type: z.literal('run.failed'), payload: z.union([
    legacyRunFailedPayloadSchema,
    v4LifecyclePayloadSchema('RUN', { errorCode: v4RunFailureCodeSchema }),
  ]) }).strict(),
])

const knownAgentEventTypes = new Set<string>(knownAgentEventSchema.options.map((option) => option.shape.type.value))
const unknownAgentEventSchema = z.object({
  ...eventBase,
  type: nonEmptyTextSchema.max(100),
  payload: z.record(z.string(), z.unknown()),
}).strict().refine((value) => !knownAgentEventTypes.has(value.type), {
  path: ['type'],
  message: 'known event types must use their typed payload contract',
})

export const agentEventSchema = z.union([knownAgentEventSchema, unknownAgentEventSchema])

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().trim().min(1).max(100),
    message: nonEmptyTextSchema.max(1_000),
    requestId: identifierSchema,
    details: z.unknown().optional(),
  }).strict(),
}).strict()

export type HostContext = z.infer<typeof hostContextSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type PresentationMode = z.infer<typeof presentationModeSchema>
export type CoverDesignMode = z.infer<typeof coverDesignModeSchema>
export type AssetAcquisitionPolicy = z.infer<typeof assetAcquisitionPolicySchema>
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>
export type RunAction = z.infer<typeof runActionSchema>
export type PlanningFailure = z.infer<typeof planningFailureSchema>
export type RunSnapshot = z.infer<typeof runSnapshotSchema>
export type V4LifecycleStage = z.infer<typeof v4LifecycleStageSchema>
export type V4RevisionKind = z.infer<typeof v4RevisionKindSchema>
export type V4LifecycleReason = z.infer<typeof v4LifecycleReasonSchema>
export type V4LifecycleNextAction = z.infer<typeof v4LifecycleNextActionSchema>
export type V4RunFailureCode = z.infer<typeof v4RunFailureCodeSchema>
export type KnownAgentEvent = z.infer<typeof knownAgentEventSchema>
export type AgentEvent = z.infer<typeof agentEventSchema>
export type AgentEventEnvelope = AgentEvent

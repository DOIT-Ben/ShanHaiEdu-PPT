import { z } from 'zod'

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
export const presentationModeSchema = z.enum(['SLIDE_IMAGE_V2', 'LAYERED_COURSEWARE_V3'])
export const coverDesignModeSchema = z.enum(['INDEPENDENT', 'FOLLOW_TEMPLATE'])

export const documentSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('TEXT'),
    name: z.string().trim().min(1).max(240).optional(),
    text: z.string().trim().min(20).max(2_000_000),
  }).strict(),
  z.object({
    kind: z.literal('HOST_ATTACHMENT'),
    attachmentId: identifierSchema,
  }).strict(),
])

export const createRunRequestSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  host: hostContextSchema,
  source: documentSourceSchema,
  slideCount: z.number().int().min(2).max(50),
  visualDirection: z.string().trim().min(3).max(1_000),
  imageModel: z.string().trim().min(1).max(120),
  automationLevel: automationLevelSchema,
  budgetUnits: z.number().int().positive().max(1_000_000),
  maxRevisionRounds: z.number().int().min(0).max(2).default(2),
  presentationMode: presentationModeSchema.default('SLIDE_IMAGE_V2'),
  coverDesignMode: coverDesignModeSchema.default('INDEPENDENT'),
  maxVisualAssetsPerSlide: z.number().int().min(1).max(4).default(4),
}).strict()

const actionBase = {
  schemaVersion: z.literal(CONTRACT_VERSION),
  expectedVersion: z.number().int().nonnegative(),
}

export const runActionSchema = z.discriminatedUnion('type', [
  z.object({ ...actionBase, type: z.literal('APPROVE_BLUEPRINT') }).strict(),
  z.object({ ...actionBase, type: z.literal('RETRY_PLANNING') }).strict(),
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
  maxRevisionRounds: z.number().int().min(0).max(2),
  planningAttempt: z.number().int().min(0).max(MAX_PLANNING_RETRIES),
  maxPlanningRetries: z.literal(MAX_PLANNING_RETRIES),
  budgetUnits: z.number().int().nonnegative(),
  committedBudgetUnits: z.number().int().nonnegative(),
  qualityScore: z.number().int().min(0).max(100).nullable(),
  qualityOverride: z.boolean(),
  presentationMode: presentationModeSchema.default('SLIDE_IMAGE_V2'),
  coverDesignMode: coverDesignModeSchema.default('INDEPENDENT'),
  maxVisualAssetsPerSlide: z.number().int().min(1).max(4).default(4),
  issues: z.array(issueSummarySchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.committedBudgetUnits > value.budgetUnits) {
    context.addIssue({ code: 'custom', path: ['committedBudgetUnits'], message: 'committed budget exceeds run budget' })
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
  runId: identifierSchema,
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
}

export const agentEventSchema = z.discriminatedUnion('type', [
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
  z.object({ ...eventBase, type: z.literal('run.paused'), payload: z.object({ reason: z.string().min(1).max(500), resumeState: runStatusSchema }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('run.resumed'), payload: z.object({ status: runStatusSchema }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('run.cancelled'), payload: z.object({
    reason: z.string().max(500).nullable(),
    mode: z.literal('STOP_NEW_SUBMISSIONS').optional(),
  }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('run.completed'), payload: z.object({ deliveryId: identifierSchema, qualityOverride: z.boolean() }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('run.failed'), payload: z.object({ errorCode: z.string().min(1).max(100) }).strict() }).strict(),
])

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
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>
export type RunAction = z.infer<typeof runActionSchema>
export type PlanningFailure = z.infer<typeof planningFailureSchema>
export type RunSnapshot = z.infer<typeof runSnapshotSchema>
export type AgentEvent = z.infer<typeof agentEventSchema>

import { z } from 'zod'
import { hashInput } from '../hash'

export const reflectionStageSchema = z.enum(['DECK_CONSISTENCY', 'SLIDE_BRIEFS'])
export const reflectionStatusSchema = z.enum(['NO_ISSUES', 'APPLIED', 'REFLECTION_SKIPPED'])
export const reflectionSkipReasonSchema = z.enum([
  'CONTRACT_INVALID',
  'PROVIDER_UNAVAILABLE',
  'PATCH_REJECTED',
])
export const reflectionFailureLayerSchema = z.enum([
  'JSON_PARSE', 'JSON_SCHEMA', 'ZOD_SEMANTIC', 'SCOPE_VIOLATION', 'PROVIDER',
])

export const reflectionDispositionSchema = z.object({
  schemaVersion: z.literal('1'),
  stage: reflectionStageSchema,
  status: reflectionStatusSchema,
  reason: reflectionSkipReasonSchema.nullable(),
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  criticCallCount: z.number().int().min(0).max(1),
  optimizerCallCount: z.number().int().min(0).max(1),
  transportAttemptCount: z.number().int().min(0).max(4),
  issueCount: z.number().int().nonnegative().max(100),
  patchCount: z.number().int().nonnegative().max(100),
  failureLayer: reflectionFailureLayerSchema.nullable(),
  errorFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  criticKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
  optimizerKeyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  outputArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  contractVersion: z.string().min(1).max(160),
  createdAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.status === 'REFLECTION_SKIPPED' && value.reason === null) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'skipped reflection requires a reason' })
  }
  if (value.status !== 'REFLECTION_SKIPPED' && value.reason !== null) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'successful reflection cannot have a skip reason' })
  }
})

export type ReflectionStage = z.infer<typeof reflectionStageSchema>
export type ReflectionDisposition = z.infer<typeof reflectionDispositionSchema>
export type ReflectionFailureLayer = z.infer<typeof reflectionFailureLayerSchema>

type ReflectionKeyInput = Readonly<{
  runId: string
  planningAttempt: number
  stage: ReflectionStage
  candidateHash: string
  compilerVersion: string
}>

export function reflectionStageKey(input: ReflectionKeyInput) {
  const identity = hashInput({
    planningAttempt: input.planningAttempt,
    stage: input.stage,
    candidateHash: input.candidateHash,
    compilerVersion: input.compilerVersion,
  }).slice(0, 24)
  return `${input.runId}:v4:chain-3:${input.stage.toLowerCase()}:${identity}`
}

export function reflectionCriticStepKey(input: ReflectionKeyInput) {
  return `${reflectionStageKey(input)}:critic`
}

export function reflectionOptimizerStepKey(input: ReflectionKeyInput & Readonly<{ issueHash: string }>) {
  return `${reflectionStageKey(input)}:optimizer:${input.issueHash.slice(0, 24)}`
}

export function reflectionDispositionStepKey(input: ReflectionKeyInput) {
  return `${reflectionStageKey(input)}:disposition`
}

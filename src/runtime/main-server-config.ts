import { z } from 'zod'
import type { V4ConfiguredModel, V4ModelReadinessRecord, V4ModelRole } from '../core/v4-model-policy'

type Environment = Readonly<Record<string, string | undefined>>

function required(env: Environment, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

/** Keeps the evaluator's narrow ingress credential out of the host trust boundary. */
export function assertQuickDeckEvaluationTokenIsolation(
  evaluationApiToken: string | undefined,
  frameFlowInternalToken: string | undefined,
) {
  if (evaluationApiToken && frameFlowInternalToken && evaluationApiToken === frameFlowInternalToken) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN_NOT_ISOLATED')
  }
}

export function resolveMainServerConfig(env: Environment = process.env) {
  const hostname = env.PPT_AGENT_HOST?.trim() || '127.0.0.1'
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('PPT_AGENT_HOST_MUST_BE_LOOPBACK')
  }
  const port = Number(env.PPT_AGENT_PORT ?? 4310)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PPT_AGENT_PORT_INVALID')
  }
  const apiToken = required(env, 'PPT_AGENT_API_TOKEN')
  const adminApiToken = env.PPT_AGENT_ADMIN_API_TOKEN?.trim()
  const presentationJobV2ApiToken = env.PPT_AGENT_V2_API_TOKEN?.trim() || undefined
  const quickDeckEvaluationApiToken = env.PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN?.trim() || undefined
  return {
    hostname,
    port,
    apiToken,
    ...(adminApiToken ? { adminApiToken } : {}),
    ...(presentationJobV2ApiToken ? { presentationJobV2ApiToken } : {}),
    ...(quickDeckEvaluationApiToken ? { quickDeckEvaluationApiToken } : {}),
  }
}

export function resolveGatewayCoursewareModelsConfig(env: Environment = process.env) {
  const fallbackModelValue = env.PPT_AGENT_FALLBACK_MODEL_ENABLED?.trim()
  if (fallbackModelValue && fallbackModelValue !== 'true' && fallbackModelValue !== 'false') {
    throw new Error('PPT_AGENT_FALLBACK_MODEL_ENABLED_INVALID')
  }
  const baseUrl = env.MODEL_GATEWAY_BASE_URL?.trim() || ''
  const apiKey = env.MODEL_GATEWAY_TEXT_KEY?.trim() || ''
  return {
    primary: {
      baseUrl,
      apiKey,
      textModel: env.PPT_AGENT_TEXT_MODEL?.trim() || 'gpt-5.6-terra',
      visionModel: env.PPT_AGENT_VISION_MODEL?.trim() || 'gpt-5.6-terra',
    },
    ...(fallbackModelValue === 'true' ? {
      fallback: {
        baseUrl,
        apiKey,
        textModel: env.PPT_AGENT_FALLBACK_TEXT_MODEL?.trim() || 'MiniMax-M3',
        visionModel: env.PPT_AGENT_FALLBACK_VISION_MODEL?.trim() || 'MiniMax-M3',
        transport: 'CHAT_COMPLETIONS' as const,
      },
    } : {}),
  }
}

/**
 * Image edits are opt-in because an edit route must prove both its request
 * contract and its delivered-pixel contract before V4 may spend against it.
 */
export function resolveV4ImageEditAsyncTaskEnabled(env: Environment = process.env) {
  const enabled = env.PPT_AGENT_V4_IMAGE_EDIT_ASYNC_TASK_ENABLED?.trim()
  if (enabled && enabled !== 'true' && enabled !== 'false') {
    throw new Error('PPT_AGENT_V4_IMAGE_EDIT_ASYNC_TASK_ENABLED_INVALID')
  }
  return enabled === 'true'
}

/**
 * Multipart async edits must target the media-router task API directly. The
 * public NewAPI relay may normalize this endpoint to a synchronous response.
 */
export function resolveV4ImageEditGatewayBaseUrl(env: Environment = process.env) {
  const value = env.PPT_AGENT_V4_IMAGE_EDIT_GATEWAY_BASE_URL?.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('PPT_AGENT_V4_IMAGE_EDIT_GATEWAY_BASE_URL_INVALID')
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('PPT_AGENT_V4_IMAGE_EDIT_GATEWAY_BASE_URL_INSECURE')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('PPT_AGENT_V4_IMAGE_EDIT_GATEWAY_BASE_URL_INVALID')
  }
  return url.toString().replace(/\/$/, '')
}

export function resolveV4RevisionImageModel(env: Environment = process.env) {
  const enabled = env.PPT_AGENT_V4_IMAGE_EDIT_ENABLED?.trim()
  if (enabled && enabled !== 'true' && enabled !== 'false') {
    throw new Error('PPT_AGENT_V4_IMAGE_EDIT_ENABLED_INVALID')
  }
  if (enabled !== 'true' || !resolveV4ImageEditAsyncTaskEnabled(env)) return null
  const model = required(env, 'PPT_AGENT_V4_REVISION_IMAGE_MODEL')
  if (!resolveV4ImageEditGatewayBaseUrl(env)) {
    throw new Error('PPT_AGENT_V4_IMAGE_EDIT_GATEWAY_BASE_URL_REQUIRED')
  }
  return model
}

function configuredModelList(value: string | undefined, fallback: readonly string[], name: string) {
  const models = (value?.trim() ? value : fallback.join(','))
    .split(',')
    .map((model) => model.trim())
  if (models.length < 1 || models.length > 20
    || models.some((model) => model.length < 1 || model.length > 120)
    || new Set(models).size !== models.length) {
    throw new Error(`${name}_INVALID`)
  }
  return models
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const parsed = Number(value?.trim() || fallback)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}_INVALID`)
  return parsed
}

export function resolveQuickDeckEvaluationConfig(
  env: Environment,
  input: Readonly<{
    textModels: readonly string[]
    imageModels: readonly string[]
  }>,
) {
  const apiToken = required(env, 'PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN')
  const dataRoot = required(env, 'PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT')
  const gatewayTextKey = required(env, 'PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_TEXT_KEY')
  const gatewayImageKey = required(env, 'PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_IMAGE_KEY')
  const formalGatewayKeys = new Set([
    env.MODEL_GATEWAY_TEXT_KEY?.trim(),
    env.MODEL_GATEWAY_IMAGE_KEY?.trim(),
  ].filter((value): value is string => Boolean(value)))
  if (formalGatewayKeys.has(gatewayTextKey)) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_KEY_NOT_ISOLATED')
  }
  if (formalGatewayKeys.has(gatewayImageKey)) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_KEY_NOT_ISOLATED')
  }
  const textModel = env.PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_MODEL?.trim() || input.textModels[0]
  if (!textModel || !input.textModels.includes(textModel)) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_MODEL_NOT_ALLOWED')
  }
  const allowedImageModels = configuredModelList(
    env.PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODELS,
    input.imageModels,
    'PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODELS',
  )
  if (allowedImageModels.some((model) => !input.imageModels.includes(model))) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODEL_NOT_ALLOWED')
  }
  const ttlHours = boundedInteger(
    env.PPT_AGENT_QUICK_DECK_EVALUATION_TTL_HOURS,
    24,
    1,
    30 * 24,
    'PPT_AGENT_QUICK_DECK_EVALUATION_TTL_HOURS',
  )
  return {
    apiToken,
    dataRoot,
    gatewayTextKey,
    gatewayImageKey,
    textModel,
    allowedImageModels,
    maxActiveJobs: boundedInteger(
      env.PPT_AGENT_QUICK_DECK_EVALUATION_MAX_ACTIVE_JOBS,
      2,
      1,
      50,
      'PPT_AGENT_QUICK_DECK_EVALUATION_MAX_ACTIVE_JOBS',
    ),
    maxDailyJobs: boundedInteger(
      env.PPT_AGENT_QUICK_DECK_EVALUATION_MAX_DAILY_JOBS,
      10,
      1,
      10_000,
      'PPT_AGENT_QUICK_DECK_EVALUATION_MAX_DAILY_JOBS',
    ),
    ttlMs: ttlHours * 60 * 60_000,
    tickBatchSize: boundedInteger(
      env.PPT_AGENT_QUICK_DECK_EVALUATION_TICK_BATCH_SIZE,
      10,
      1,
      100,
      'PPT_AGENT_QUICK_DECK_EVALUATION_TICK_BATCH_SIZE',
    ),
  }
}

const configuredReadinessSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('PASSED'),
    evaluationRelease: z.string().trim().min(1).max(120),
    gatewayContractVersion: z.string().trim().min(1).max(160),
    structuredGenerationProtocol: z.literal('RESPONSES_JSON_SCHEMA').nullable(),
    evaluatedAt: z.string().datetime(),
    evaluationSuite: z.string().trim().min(1).max(160),
    expiresAt: z.string().datetime(),
  }).strict(),
  z.object({ status: z.literal('NOT_EVALUATED') }).strict(),
  z.object({ status: z.literal('FAILED') }).strict(),
])

const configuredModelRegistrySchema = z.object({
  schemaVersion: z.literal('1'),
  models: z.array(z.object({
    model: z.string().trim().min(1).max(120),
    evaluationEnabled: z.boolean(),
    published: z.boolean(),
    readiness: configuredReadinessSchema,
  }).strict()).max(20)
    .refine((models) => new Set(models.map((model) => model.model)).size === models.length, 'models must be unique'),
}).strict()

function configuredReadiness(value: z.output<typeof configuredReadinessSchema>): V4ModelReadinessRecord {
  if (value.status !== 'PASSED') {
    return {
      status: value.status,
      evaluationRelease: null,
      gatewayContractVersion: null,
      structuredGenerationProtocol: null,
      evaluatedAt: null,
      evaluationSuite: null,
      expiresAt: null,
    }
  }
  const evaluatedAt = Date.parse(value.evaluatedAt)
  const expiresAt = Date.parse(value.expiresAt)
  if (!Number.isFinite(evaluatedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= evaluatedAt || evaluatedAt > Date.now()) {
    throw new Error('PPT_AGENT_V4_MODEL_REGISTRY_READINESS_TIME_INVALID')
  }
  return { ...value }
}

function configuredModelRegistry(env: Environment) {
  const raw = env.PPT_AGENT_V4_MODEL_REGISTRY_JSON?.trim()
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new Error('PPT_AGENT_V4_MODEL_REGISTRY_INVALID')
  }
  const parsed = configuredModelRegistrySchema.safeParse(value)
  if (!parsed.success) throw new Error('PPT_AGENT_V4_MODEL_REGISTRY_INVALID')
  return parsed.data.models
}

/**
 * Configuration, evaluation permission, publication and live availability are
 * intentionally separate. This resolver never returns a gateway URL or key.
 */
export function resolveV4ModelPolicyConfig(
  env: Environment,
  coursewareModels: ReturnType<typeof resolveGatewayCoursewareModelsConfig>,
  revisionImageModel: string | null,
) {
  const byModel = new Map<string, Set<V4ModelRole>>()
  const register = (model: string, role: V4ModelRole) => {
    const roles = byModel.get(model) ?? new Set<V4ModelRole>()
    roles.add(role)
    byModel.set(model, roles)
  }
  register(coursewareModels.primary.textModel, 'TEXT')
  register(coursewareModels.primary.visionModel, 'VISION')
  for (const model of configuredModelList(
    env.PPT_AGENT_V4_INITIAL_IMAGE_MODELS,
    ['gemini-3-pro-image-preview'],
    'PPT_AGENT_V4_INITIAL_IMAGE_MODELS',
  )) register(model, 'IMAGE')
  if (revisionImageModel) register(revisionImageModel, 'IMAGE_EDIT')

  const registry = configuredModelRegistry(env)
  const configuredNames = new Set(byModel.keys())
  if (registry.some((model) => !configuredNames.has(model.model))) {
    throw new Error('PPT_AGENT_V4_MODEL_REGISTRY_UNKNOWN_MODEL')
  }
  const registered = new Map(registry.map((model) => [model.model, model]))
  const defaultReadiness: V4ModelReadinessRecord = {
    status: 'NOT_EVALUATED',
    evaluationRelease: null,
    gatewayContractVersion: null,
    structuredGenerationProtocol: null,
    evaluatedAt: null,
    evaluationSuite: null,
    expiresAt: null,
  }
  const models: V4ConfiguredModel[] = [...byModel.entries()].map(([model, roles]) => {
    const record = registered.get(model)
    if (record?.published && record.readiness.status !== 'PASSED') {
      throw new Error('PPT_AGENT_V4_MODEL_REGISTRY_PUBLISHED_NOT_READY')
    }
    return {
      model,
      roles: [...roles],
      evaluationEnabled: record?.evaluationEnabled ?? false,
      published: record?.published ?? false,
      readiness: record ? configuredReadiness(record.readiness) : defaultReadiness,
    }
  })
  return {
    models,
    availabilityTtlMs: boundedInteger(
      env.PPT_AGENT_V4_MODEL_AVAILABILITY_TTL_SECONDS,
      120,
      10,
      60 * 60,
      'PPT_AGENT_V4_MODEL_AVAILABILITY_TTL_SECONDS',
    ) * 1_000,
  }
}

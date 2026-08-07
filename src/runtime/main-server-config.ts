type Environment = Readonly<Record<string, string | undefined>>

function required(env: Environment, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
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
export function resolveV4RevisionImageModel(env: Environment = process.env) {
  const enabled = env.PPT_AGENT_V4_IMAGE_EDIT_ENABLED?.trim()
  if (enabled && enabled !== 'true' && enabled !== 'false') {
    throw new Error('PPT_AGENT_V4_IMAGE_EDIT_ENABLED_INVALID')
  }
  if (enabled !== 'true') return null
  return required(env, 'PPT_AGENT_V4_REVISION_IMAGE_MODEL')
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
  if (gatewayTextKey === env.MODEL_GATEWAY_TEXT_KEY?.trim()) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_KEY_NOT_ISOLATED')
  }
  if (gatewayImageKey === env.MODEL_GATEWAY_IMAGE_KEY?.trim()) {
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

/** Public model names are tenant-safe capability data, never credentials or route details. */
export function resolvePublicV4CapabilitiesConfig(
  env: Environment,
  coursewareModels: ReturnType<typeof resolveGatewayCoursewareModelsConfig>,
  revisionImageModel: string | null,
) {
  const unique = (models: readonly string[]) => [...new Set(models)]
  // V4 capabilities describe new strict Chain-4 Runs. Compatibility fallback
  // models remain available to historical chains but are not selectable here.
  const textModels = unique([coursewareModels.primary.textModel])
  const visionModels = unique([coursewareModels.primary.visionModel])
  return {
    textModels: configuredModelList(textModels.join(','), ['gpt-5.6-terra'], 'PPT_AGENT_CAPABILITY_TEXT_MODELS'),
    visionModels: configuredModelList(visionModels.join(','), ['gpt-5.6-terra'], 'PPT_AGENT_CAPABILITY_VISION_MODELS'),
    imageModels: configuredModelList(
      env.PPT_AGENT_V4_INITIAL_IMAGE_MODELS,
      ['gemini-3-pro-image-preview'],
      'PPT_AGENT_V4_INITIAL_IMAGE_MODELS',
    ),
    imageEditModels: revisionImageModel
      ? configuredModelList(revisionImageModel, [], 'PPT_AGENT_V4_REVISION_IMAGE_MODEL')
      : [],
  }
}

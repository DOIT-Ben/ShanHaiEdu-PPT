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
  return {
    hostname,
    port,
    apiToken,
    ...(adminApiToken ? { adminApiToken } : {}),
    ...(presentationJobV2ApiToken ? { presentationJobV2ApiToken } : {}),
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

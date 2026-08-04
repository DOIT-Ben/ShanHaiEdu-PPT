import path from 'node:path'

type Environment = Readonly<Record<string, string | undefined>>

function boundedInteger(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number(env[name]?.trim() || fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`)
  }
  return value
}

function required(env: Environment, name: string) {
  const value = env[name]?.trim().replace(/\r$/, '')
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

function validIdentifier(value: string) {
  return value.length >= 1 && value.length <= 160 && value === value.trim()
}

export function resolvePresentationJobV2ServerConfig(env: Environment = process.env) {
  const hostname = env.PPT_AGENT_V2_HOST?.trim() || '127.0.0.1'
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('PPT_AGENT_V2_HOST_MUST_BE_LOOPBACK')
  }
  const tenantId = required(env, 'PPT_AGENT_V2_TENANT_ID')
  if (!validIdentifier(tenantId)) throw new Error('PPT_AGENT_V2_TENANT_ID_INVALID')
  const apiToken = required(env, 'PPT_AGENT_V2_API_TOKEN')
  if (apiToken.length < 16 || apiToken.length > 512 || apiToken !== apiToken.trim()) {
    throw new Error('PPT_AGENT_V2_API_TOKEN_INVALID')
  }
  const dataRoot = path.resolve(
    env.PPT_AGENT_V2_DATA_ROOT?.trim() || '.private/presentation-job-v2-runtime',
  )
  return {
    hostname,
    port: boundedInteger(env, 'PPT_AGENT_V2_PORT', 4320, 1, 65_535),
    tenantId,
    apiToken,
    dataRoot,
    tickIntervalMs: boundedInteger(env, 'PPT_AGENT_V2_TICK_INTERVAL_MS', 500, 50, 60_000),
    tickBatchSize: boundedInteger(env, 'PPT_AGENT_V2_TICK_BATCH_SIZE', 25, 1, 100),
  }
}

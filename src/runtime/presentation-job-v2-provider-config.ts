import { HttpPresentationJobV2Provider } from '../adapters/http-presentation-job-v2-provider'
import { DeterministicPresentationJobV2Provider } from '../adapters/presentation-job-v2-ports'
import type { PresentationJobV2ProviderPort } from '../core/presentation-job-v2-ports'

function optionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
) {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`)
  }
  return value
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

export function createPresentationJobV2ProviderFromEnv(
  env: NodeJS.ProcessEnv,
  dependencies: Readonly<{ internalProvider?: PresentationJobV2ProviderPort }> = {},
) {
  const mode = env.PPT_AGENT_V2_PROVIDER_MODE?.trim()
    || (dependencies.internalProvider ? 'internal' : '')
  if (!mode) throw new Error('PPT_AGENT_V2_PROVIDER_MODE_REQUIRED')
  if (mode === 'internal') {
    if (!dependencies.internalProvider) throw new Error('PPT_AGENT_V2_INTERNAL_PROVIDER_REQUIRED')
    return dependencies.internalProvider
  }
  if (mode === 'deterministic') return new DeterministicPresentationJobV2Provider()
  if (mode !== 'http') throw new Error('PPT_AGENT_V2_PROVIDER_MODE_INVALID')
  const timeoutMs = optionalInteger(env, 'PPT_AGENT_V2_PROVIDER_TIMEOUT_MS', 100, 600_000)
  const maximumArtifactBytes = optionalInteger(
    env,
    'PPT_AGENT_V2_PROVIDER_MAX_ARTIFACT_BYTES',
    1,
    1024 * 1024 * 1024,
  )
  return new HttpPresentationJobV2Provider({
    baseUrl: required(env, 'PPT_AGENT_V2_PROVIDER_BASE_URL'),
    apiKey: required(env, 'PPT_AGENT_V2_PROVIDER_API_KEY'),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maximumArtifactBytes === undefined ? {} : { maximumArtifactBytes }),
  })
}

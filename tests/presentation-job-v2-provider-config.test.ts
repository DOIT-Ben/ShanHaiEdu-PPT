import { describe, expect, test } from 'bun:test'
import { HttpPresentationJobV2Provider } from '../src/adapters/http-presentation-job-v2-provider'
import { DeterministicPresentationJobV2Provider } from '../src/adapters/presentation-job-v2-ports'
import { createPresentationJobV2ProviderFromEnv } from '../src/runtime/presentation-job-v2-provider-config'

describe('Presentation Job V2 provider configuration', () => {
  test('keeps the deterministic provider as the safe default', () => {
    expect(createPresentationJobV2ProviderFromEnv({})).toBeInstanceOf(DeterministicPresentationJobV2Provider)
  })

  test('constructs the HTTP provider only when explicitly selected', () => {
    expect(createPresentationJobV2ProviderFromEnv({
      PPT_AGENT_V2_PROVIDER_MODE: 'http',
      PPT_AGENT_V2_PROVIDER_BASE_URL: 'https://provider.example/v1',
      PPT_AGENT_V2_PROVIDER_API_KEY: 'provider-token-for-contract-tests',
      PPT_AGENT_V2_PROVIDER_TIMEOUT_MS: '45000',
      PPT_AGENT_V2_PROVIDER_MAX_ARTIFACT_BYTES: '1048576',
    })).toBeInstanceOf(HttpPresentationJobV2Provider)
  })

  test('fails closed for incomplete or unknown provider configuration', () => {
    expect(() => createPresentationJobV2ProviderFromEnv({
      PPT_AGENT_V2_PROVIDER_MODE: 'http',
      PPT_AGENT_V2_PROVIDER_API_KEY: 'provider-token-for-contract-tests',
    })).toThrow('PPT_AGENT_V2_PROVIDER_BASE_URL_REQUIRED')
    expect(() => createPresentationJobV2ProviderFromEnv({
      PPT_AGENT_V2_PROVIDER_MODE: 'http',
      PPT_AGENT_V2_PROVIDER_BASE_URL: 'https://provider.example/v1',
    })).toThrow('PPT_AGENT_V2_PROVIDER_API_KEY_REQUIRED')
    expect(() => createPresentationJobV2ProviderFromEnv({
      PPT_AGENT_V2_PROVIDER_MODE: 'other',
    })).toThrow('PPT_AGENT_V2_PROVIDER_MODE_INVALID')
  })
})

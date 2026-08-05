import { describe, expect, test } from 'bun:test'
import { resolveMainServerConfig } from '../src/runtime/main-server-config'

describe('main PPT Agent server configuration', () => {
  test('allows a V1-only process without a V2 credential', () => {
    const v1Only = resolveMainServerConfig({
      PPT_AGENT_API_TOKEN: 'v1-server-token-0001',
      PPT_AGENT_RUNTIME_MODE: 'mock',
    })
    expect(v1Only).toMatchObject({
      hostname: '127.0.0.1',
      port: 4310,
      apiToken: 'v1-server-token-0001',
    })
    expect(v1Only.presentationJobV2ApiToken).toBeUndefined()
    expect(resolveMainServerConfig({
      PPT_AGENT_API_TOKEN: 'v1-server-token-0001',
      PPT_AGENT_V2_API_TOKEN: 'v2-server-token-0001',
    }).presentationJobV2ApiToken).toBe('v2-server-token-0001')
  })
})

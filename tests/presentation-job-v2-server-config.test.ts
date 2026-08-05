import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { resolvePresentationJobV2ServerConfig } from '../src/runtime/presentation-job-v2-server-config'

describe('Presentation Job V2 server configuration', () => {
  test('requires dedicated tenant-bound credentials and uses loopback-safe defaults', () => {
    expect(resolvePresentationJobV2ServerConfig({
      PPT_AGENT_V2_TENANT_ID: 'host-a',
      PPT_AGENT_V2_API_TOKEN: 'presentation-job-v2-token-0001',
      PPT_AGENT_TENANT_ID: 'frameflow',
      PPT_AGENT_API_TOKEN: 'v1-token-must-not-be-used-0001',
      FRAMEFLOW_INTERNAL_TOKEN: 'frameflow-token-must-not-be-used-0001',
    })).toEqual({
      hostname: '127.0.0.1',
      port: 4320,
      tenantId: 'host-a',
      apiToken: 'presentation-job-v2-token-0001',
      dataRoot: path.resolve('.private/presentation-job-v2-runtime'),
      tickIntervalMs: 500,
      tickBatchSize: 25,
    })
  })

  test('accepts explicit isolated storage and bounded worker settings', () => {
    expect(resolvePresentationJobV2ServerConfig({
      PPT_AGENT_V2_HOST: 'localhost',
      PPT_AGENT_V2_PORT: '4321',
      PPT_AGENT_V2_TENANT_ID: 'host-b',
      PPT_AGENT_V2_API_TOKEN: 'presentation-job-v2-token-0002',
      PPT_AGENT_V2_DATA_ROOT: './.private/v2-host-b',
      PPT_AGENT_V2_TICK_INTERVAL_MS: '1000',
      PPT_AGENT_V2_TICK_BATCH_SIZE: '50',
    })).toMatchObject({
      hostname: 'localhost',
      port: 4321,
      tenantId: 'host-b',
      dataRoot: path.resolve('./.private/v2-host-b'),
      tickIntervalMs: 1000,
      tickBatchSize: 50,
    })
  })

  test('fails closed for missing credentials, public binding and invalid bounds', () => {
    expect(() => resolvePresentationJobV2ServerConfig({})).toThrow('PPT_AGENT_V2_TENANT_ID_REQUIRED')
    expect(() => resolvePresentationJobV2ServerConfig({
      PPT_AGENT_V2_TENANT_ID: 'host-a',
    })).toThrow('PPT_AGENT_V2_API_TOKEN_REQUIRED')
    expect(() => resolvePresentationJobV2ServerConfig({
      PPT_AGENT_V2_HOST: '0.0.0.0',
      PPT_AGENT_V2_TENANT_ID: 'host-a',
      PPT_AGENT_V2_API_TOKEN: 'presentation-job-v2-token-0001',
    })).toThrow('PPT_AGENT_V2_HOST_MUST_BE_LOOPBACK')
    expect(() => resolvePresentationJobV2ServerConfig({
      PPT_AGENT_V2_PORT: '70000',
      PPT_AGENT_V2_TENANT_ID: 'host-a',
      PPT_AGENT_V2_API_TOKEN: 'presentation-job-v2-token-0001',
    })).toThrow('PPT_AGENT_V2_PORT_INVALID')
    expect(() => resolvePresentationJobV2ServerConfig({
      PPT_AGENT_V2_TENANT_ID: 'host-a',
      PPT_AGENT_V2_API_TOKEN: 'short',
    })).toThrow('PPT_AGENT_V2_API_TOKEN_INVALID')
    expect(() => resolvePresentationJobV2ServerConfig({
      PPT_AGENT_V2_TENANT_ID: 'host-a',
      PPT_AGENT_V2_API_TOKEN: 'presentation-job-v2-token-0001',
      PPT_AGENT_V2_TICK_BATCH_SIZE: '0',
    })).toThrow('PPT_AGENT_V2_TICK_BATCH_SIZE_INVALID')
    expect(() => resolvePresentationJobV2ServerConfig({
      PPT_AGENT_V2_TENANT_ID: 'host-a',
      PPT_AGENT_V2_API_TOKEN: 'presentation-job-v2-token-0001',
      PPT_AGENT_V2_TICK_BATCH_SIZE: '101',
    })).toThrow('PPT_AGENT_V2_TICK_BATCH_SIZE_INVALID')
  })
})

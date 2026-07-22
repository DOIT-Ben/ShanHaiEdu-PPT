import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const filename = new URL('../docs/openapi-v1.json', import.meta.url)

describe('OpenAPI v1 contract', () => {
  test('publishes the implemented versioned resources and security boundary', async () => {
    const document = JSON.parse(await readFile(filename, 'utf8')) as {
      openapi: string
      info: { version: string }
      security: unknown[]
      paths: Record<string, Record<string, unknown>>
      components: {
        parameters: Record<string, { required?: boolean }>
        schemas: Record<string, { oneOf?: Array<{ properties?: Record<string, { const?: string }> }>; properties?: Record<string, { enum?: string[] }> }>
      }
    }

    expect(document.openapi).toBe('3.1.0')
    expect(document.info.version).toBe('1.0.0')
    expect(document.security).toEqual([{ bearerAuth: [] }])
    expect(Object.keys(document.paths).sort()).toEqual([
      '/health/live',
      '/health/ready',
      '/v1/admin/operations',
      '/v1/admin/operations/{runId}/actions',
      '/v1/admin/planning-failures',
      '/v1/runs',
      '/v1/runs/{runId}',
      '/v1/runs/{runId}/actions',
      '/v1/runs/{runId}/deliveries/{deliveryId}/content',
      '/v1/runs/{runId}/events',
      '/v1/runs/{runId}/events/history',
    ])
    expect(document.paths['/v1/runs/{runId}/events']?.get).toBeDefined()
    expect(document.paths['/v1/runs/{runId}/events/history']?.get).toBeDefined()
    expect(JSON.stringify(document.paths['/v1/runs/{runId}/events'])).toContain('100 events')
    expect(JSON.stringify(document.paths['/v1/runs/{runId}/events'])).toContain('terminal')
    expect(document.paths['/v1/admin/planning-failures']?.get).toBeDefined()
    expect(document.paths['/v1/admin/operations']?.get).toBeDefined()
    expect(document.paths['/v1/admin/operations/{runId}/actions']?.post).toBeDefined()
    expect(document.paths['/health/live']?.get).toBeDefined()
    expect(document.paths['/health/ready']?.get).toBeDefined()
    expect(document.components.parameters.IdempotencyKey?.required).toBe(true)
    expect(document.components.schemas.HostContext?.properties?.role?.enum).toEqual(['USER', 'ADMIN'])
    expect(document.components.schemas.PublicRun?.properties?.progress).toBeDefined()
    expect(document.components.schemas.CreateRunRequest?.properties?.assetAcquisitionPolicy?.enum)
      .toEqual(['AI_FIRST', 'SEARCH_FIRST'])
    expect(document.components.schemas.PublicRun?.properties?.assetAcquisitionPolicy?.enum)
      .toEqual(['AI_FIRST', 'SEARCH_FIRST'])
    expect(document.components.schemas.RunAction?.properties?.type?.enum).toEqual(expect.arrayContaining([
      'RETRY_PLANNING', 'RETRY_DELIVERY', 'REPLAN', 'ACCEPT_WITH_OVERRIDE', 'CANCEL',
    ]))
    expect(document.components.schemas.DocumentSource?.oneOf?.map((source) => source.properties?.kind?.const)).toContain('SOURCE_PACKAGE')
    expect(document.components.schemas.BlueprintSourceManifestEntry).toBeDefined()
    expect(document.components.schemas.BlueprintSourceAsset).toBeDefined()
    expect(document.components.schemas.PlanningFailure?.properties?.errorCode?.enum).toEqual(expect.arrayContaining([
      'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID', 'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE',
    ]))
  })
})

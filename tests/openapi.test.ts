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
        schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }>
      }
    }

    expect(document.openapi).toBe('3.1.0')
    expect(document.info.version).toBe('1.0.0')
    expect(document.security).toEqual([{ bearerAuth: [] }])
    expect(Object.keys(document.paths).sort()).toEqual([
      '/v1/admin/planning-failures',
      '/v1/runs',
      '/v1/runs/{runId}',
      '/v1/runs/{runId}/actions',
      '/v1/runs/{runId}/deliveries/{deliveryId}/content',
      '/v1/runs/{runId}/events',
    ])
    expect(document.paths['/v1/runs/{runId}/events']?.get).toBeDefined()
    expect(document.paths['/v1/admin/planning-failures']?.get).toBeDefined()
    expect(document.components.parameters.IdempotencyKey?.required).toBe(true)
    expect(document.components.schemas.HostContext?.properties?.role?.enum).toEqual(['USER', 'ADMIN'])
    expect(document.components.schemas.RunAction?.properties?.type?.enum).toEqual(expect.arrayContaining([
      'RETRY_PLANNING', 'REPLAN', 'ACCEPT_WITH_OVERRIDE', 'CANCEL',
    ]))
  })
})

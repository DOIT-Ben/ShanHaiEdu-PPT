import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const filename = new URL('../docs/openapi-v2.json', import.meta.url)

describe('Presentation Job V2 OpenAPI contract', () => {
  test('publishes only the host-neutral V2 resources and strict immutable input schema', async () => {
    const document = JSON.parse(await readFile(filename, 'utf8')) as {
      openapi: string
      info: { title: string; version: string; description: string }
      paths: Record<string, unknown>
      components: {
        parameters: Record<string, { name?: string; required?: boolean }>
        schemas: Record<string, { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> }>
      }
    }

    expect(document.openapi).toBe('3.1.0')
    expect(document.info).toEqual({ title: 'PPT Agent Presentation Job API', version: '2.0', description: expect.any(String) })
    expect(Object.keys(document.paths).sort()).toEqual([
      '/v2/presentation-jobs',
      '/v2/presentation-jobs/{jobId}',
      '/v2/presentation-jobs/{jobId}/artifacts/{artifactId}',
      '/v2/presentation-jobs/{jobId}/usage',
    ])
    expect(document.components.parameters.ExternalUserId).toMatchObject({ name: 'X-PPT-Agent-User', required: true })
    expect(document.components.parameters.ExternalProjectId).toMatchObject({ name: 'X-PPT-Agent-Project', required: false })
    expect(document.components.parameters.TenantId).toBeUndefined()
    expect(document.components.schemas.PresentationJobCreateRequest).toMatchObject({
      additionalProperties: false,
      required: ['source'],
    })
    expect(document.components.schemas.ApprovedPageDesignSnapshotSource).toMatchObject({
      additionalProperties: false,
      required: ['kind', 'artifactVersionId', 'sha256', 'snapshot'],
    })
    expect(document.components.schemas.PresentationJob).toMatchObject({ additionalProperties: false })
    expect(document.components.schemas.PresentationJobUsage).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        'billableImageOperations',
        'notChargedImageOperations',
        'unknownImageOperations',
        'byModel',
      ]),
    })
    const source = JSON.stringify(document)
    expect(source).not.toContain('budgetUnits')
    expect(source).not.toContain('maxRevisionRounds')
    expect(source).not.toContain('generationPlan')
    expect(source).not.toContain('blueprint')
    expect(source).toContain('Range requests are not supported in V2.0')
    expect(source).toContain('RECONCILING')
    expect(source).toContain('X-PPT-Agent-Artifact-ID')
  })
})

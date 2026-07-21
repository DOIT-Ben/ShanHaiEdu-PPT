import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { MockArtifactPort, MockPresentationRendererPort } from '../src/adapters/mock-ports'
import { createMockRuntime } from '../src/runtime/mock-runtime'

const token = 'test-runtime-token-0001'

function request(path: string, init: RequestInit = {}, user = 'user-1') {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-PPT-Agent-Tenant', 'frameflow')
  headers.set('X-PPT-Agent-User', user)
  return new Request(`http://127.0.0.1:4310${path}`, { ...init, headers })
}

describe('mock runtime', () => {
  test('runs an authenticated approved deck through delivery with zero provider calls', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const renderer = new MockPresentationRendererPort()
    const runtime = createMockRuntime({ repository, artifacts, renderer, apiToken: token })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-create-0001' },
      body: JSON.stringify({
        schemaVersion: '1',
        host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: { kind: 'TEXT', name: '光合作用教材.txt', text: '绿色植物利用光能制造有机物，并释放氧气。这是完整的课堂教材内容。' },
        slideCount: 2,
        visualDirection: '清晰的课堂科学信息图',
        imageModel: 'mock-image',
        automationLevel: 'SUPERVISED',
        budgetUnits: 10,
        maxRevisionRounds: 2,
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id
    expect(created.status).toBe(201)

    await runtime.tick()
    expect(await repository.getRun(runId)).toMatchObject({ status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
    const hidden = await runtime.handler(request(`/v1/runs/${runId}`, {}, 'user-2'))
    expect(hidden.status).toBe(404)

    const approved = await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-approve-0001' },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_BLUEPRINT', expectedVersion: 1 }),
    }))
    expect(approved.status).toBe(200)

    for (let index = 0; index < 4; index += 1) await runtime.tick()
    expect(await repository.getRun(runId)).toMatchObject({
      status: 'COMPLETED', qualityScore: 90, committedBudgetUnits: 2,
    })
    expect(await repository.listDeliveries(runId)).toHaveLength(1)
    expect(renderer).toMatchObject({ previewCalls: 1, pptxCalls: 1 })
  })

  test('rejects missing or mismatched service credentials', async () => {
    const runtime = createMockRuntime({
      repository: new InMemoryAgentRepository(),
      artifacts: new MockArtifactPort(),
      renderer: new MockPresentationRendererPort(),
      apiToken: token,
    })
    expect((await runtime.handler(new Request('http://127.0.0.1:4310/v1/runs'))).status).toBe(401)
    expect((await runtime.handler(new Request('http://127.0.0.1:4310/v1/runs', { headers: {
      Authorization: 'Bearer wrong-token-value',
      'X-PPT-Agent-Tenant': 'frameflow',
      'X-PPT-Agent-User': 'user-1',
    } }))).status).toBe(401)
  })
})

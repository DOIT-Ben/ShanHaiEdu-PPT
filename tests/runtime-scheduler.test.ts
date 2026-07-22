import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  MockArtifactPort,
  MockDeckReviewPort,
  MockRevisionApplicationPort,
  MockRevisionPlanningPort,
  MockVisualReviewPort,
} from '../src/adapters/mock-ports'
import type { StructuredModelPort } from '../src/core/ports'
import { createAgentRuntime } from '../src/runtime/mock-runtime'

const token = 'scheduler-test-token-0001'

function blueprint(input: Parameters<StructuredModelPort['execute']>[0]) {
  const payload = input.payload as {
    slideCount: number
    document: { name: string; chunks: { id: string }[] }
  }
  const sourceChunkIds = [payload.document.chunks[0]!.id]
  return {
    title: payload.document.name,
    curriculum: {
      subject: '数学', grade: '小学', lessonTitle: payload.document.name,
      sourceSummary: '根据完整教材内容创建课堂讲解，并严格覆盖其中的核心知识点。', learningObjectives: ['理解教材知识点'],
      scopeBoundaries: ['仅覆盖教材内容'], prohibitedExtensions: [], sourceChunkIds, sourceAssetIds: [],
    },
    slides: Array.from({ length: payload.slideCount }, (_, index) => ({
      pageNumber: index + 1,
      title: `${payload.document.name} ${index + 1}`,
      body: ['根据教材讲解当前知识点。'],
      layout: index === 0 ? 'HERO' as const : 'SPLIT' as const,
      visualIntent: '使用清晰课堂视觉支持知识讲解',
      visualPrompt: 'A clear educational classroom illustration without text or logos',
      sourceChunkIds, sourceAssetIds: [],
    })),
  }
}

function runtime(repository: InMemoryAgentRepository, model: StructuredModelPort, workerId: string) {
  return createAgentRuntime({
    repository,
    artifacts: new MockArtifactPort(),
    apiToken: token,
    model,
    visualReviewer: new MockVisualReviewPort({
      approved: true, textDetected: false, visualScore: 90, reasons: [], retryInstruction: null,
    }),
    deckReviewer: new MockDeckReviewPort({}),
    revisionPlanner: new MockRevisionPlanningPort({}),
    revisionApplication: new MockRevisionApplicationPort({}),
    workerId,
    workerConcurrency: 2,
  })
}

async function createRun(agent: ReturnType<typeof runtime>, name: string, key: string) {
  const response = await agent.handler(new Request('http://127.0.0.1:4310/v1/runs', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-PPT-Agent-Tenant': 'frameflow',
      'X-PPT-Agent-User': 'teacher-1',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      schemaVersion: '1',
      host: { tenantId: 'frameflow', externalUserId: 'teacher-1' },
      source: { kind: 'TEXT', name: `${name}.txt`, text: `${name} 教材正文包含足够长度的完整课堂知识内容。` },
      slideCount: 2,
      visualDirection: '清晰的课堂信息图',
      imageModel: 'mock-image',
      automationLevel: 'SUPERVISED',
      budgetUnits: 10,
    }),
  }))
  expect(response.status).toBe(201)
  return (await response.json() as { data: { id: string } }).data.id
}

async function waitForStatus(repository: InMemoryAgentRepository, runId: string, status: string) {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if ((await repository.getRun(runId))?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`status ${status} was not reached`)
}

describe('runtime scheduler', () => {
  test('lets a second Run finish planning while the first model call is slow', async () => {
    const repository = new InMemoryAgentRepository()
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    const model: StructuredModelPort = {
      async execute(input) {
        const name = (input.payload as { document: { name: string } }).document.name
        if (name.startsWith('慢任务')) await slowGate
        return blueprint(input)
      },
    }
    const agent = runtime(repository, model, 'worker-concurrent')
    const slowRunId = await createRun(agent, '慢任务', 'scheduler-slow-run')
    const fastRunId = await createRun(agent, '快任务', 'scheduler-fast-run')

    const ticking = agent.tick()
    await waitForStatus(repository, fastRunId, 'AWAITING_BLUEPRINT_APPROVAL')
    expect((await repository.getRun(slowRunId))?.status).toBe('PLANNING')
    releaseSlow()
    await ticking
    expect((await repository.getRun(slowRunId))?.status).toBe('AWAITING_BLUEPRINT_APPROVAL')
  })

  test('does not let two workers plan the same Run', async () => {
    const repository = new InMemoryAgentRepository()
    let releaseModel!: () => void
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
    let calls = 0
    const model: StructuredModelPort = {
      async execute(input) {
        calls += 1
        await modelGate
        return blueprint(input)
      },
    }
    const first = runtime(repository, model, 'worker-a')
    const second = runtime(repository, model, 'worker-b')
    const runId = await createRun(first, '双 Worker', 'scheduler-two-workers')

    const ticks = Promise.all([first.tick(), second.tick()])
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(calls).toBe(1)
    releaseModel()
    await ticks
    expect((await repository.getRun(runId))?.status).toBe('AWAITING_BLUEPRINT_APPROVAL')
    expect(calls).toBe(1)
  })
})

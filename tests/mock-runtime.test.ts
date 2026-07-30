import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  MockArtifactPort,
  MockPresentationRendererPort,
  MockVisualReviewPort,
} from '../src/adapters/mock-ports'
import type { DeckReviewPort, RevisionApplicationPort, RevisionPlanningPort } from '../src/core/ports'
import { createAgentRuntime, createMockRuntime } from '../src/runtime/mock-runtime'

const token = 'test-runtime-token-0001'

function request(path: string, init: RequestInit = {}, user = 'user-1') {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-PPT-Agent-Tenant', 'frameflow')
  headers.set('X-PPT-Agent-User', user)
  return new Request(`http://127.0.0.1:4310${path}`, { ...init, headers })
}

describe('mock runtime', () => {
  test('runs a notebooklm-style v4 request through approval to a raster-only pptx', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const runtime = createMockRuntime({ repository, artifacts, apiToken: token })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-create-v4-chain-0001' },
      body: JSON.stringify({
        schemaVersion: '1',
        host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: {
          kind: 'TEXT', name: '分数教材.txt', roleHint: 'CONTENT_SOURCE',
          text: '把一个蛋糕平均分成两份，其中一份就是这个蛋糕的二分之一。判断分数前必须先判断是否平均分。'.repeat(4),
        },
        slideCount: 3,
        visualDirection: '温暖、清晰、有故事感的小学课堂绘本视觉',
        imageModel: 'nanobanana',
        automationLevel: 'SUPERVISED',
        budgetUnits: 3,
        maxRevisionRounds: 2,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: {
          instruction: '制作一套让三年级学生理解平均分和二分之一的完整视觉演示',
          sourceMode: 'SOURCE_GROUNDED',
          deckOptions: {
            deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 3 }, aspectRatio: '16:9',
            audience: '小学三年级学生', focus: '平均分与二分之一', styleHint: '温暖的儿童绘本课堂视觉',
          },
        },
      }),
    }))
    expect(created.status).toBe(201)
    const runId = (await created.json() as { data: { id: string } }).data.id

    await runtime.tick()
    const plannedResponse = await runtime.handler(request(`/v1/runs/${runId}`))
    const planned = await plannedResponse.json() as { data: {
      status: string
      version: number
      blueprint?: { visualDeckV4Proposal?: { slideBriefs: unknown[] } }
      generationPlan?: { title: string; slideCount: number; pages: unknown[]; output: { editable: boolean } }
    } }
    expect(planned.data.status).toBe('AWAITING_BLUEPRINT_APPROVAL')
    expect(planned.data.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(3)
    expect(planned.data.generationPlan).toMatchObject({ slideCount: 3, output: { editable: false } })
    expect(planned.data.generationPlan?.pages).toHaveLength(3)

    const approved = await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-approve-v4-chain-0001' },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_BLUEPRINT', expectedVersion: planned.data.version }),
    }))
    expect(approved.status).toBe(200)
    for (let index = 0; index < 4; index += 1) await runtime.tick()

    expect(await repository.getRun(runId)).toMatchObject({
      status: 'COMPLETED', presentationMode: 'VISUAL_DECK_V4', committedBudgetUnits: 3, qualityScore: 90,
    })
    const reviewSteps = (await repository.listSteps(runId)).filter((step) => step.tool === 'review_slide_image')
    expect(reviewSteps).toHaveLength(3)
    const delivery = (await repository.listDeliveries(runId))[0]!
    const artifact = artifacts.artifacts.get(delivery.pptx.artifactId)
    expect(artifact?.bytes.length).toBeGreaterThan(10_000)

    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-v4-chain-'))
    try {
      const path = join(directory, 'visual-deck.pptx')
      await writeFile(path, artifact!.bytes)
      for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
        const process = Bun.spawn(['unzip', '-p', path, `ppt/slides/slide${pageNumber}.xml`], { stdout: 'pipe', stderr: 'pipe' })
        const xml = await new Response(process.stdout).text()
        expect(await process.exited).toBe(0)
        expect(xml.match(/<p:pic>/g)).toHaveLength(1)
        expect(xml).toContain(`visual-deck-page-${pageNumber}`)
        expect(xml).not.toContain('<a:t>')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('routes a failed deck review through approved local revision and re-review', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const renderer = new MockPresentationRendererPort()
    const blueprint = {
      title: '光合作用',
      curriculum: {
        subject: '生物', grade: '七年级', lessonTitle: '光合作用',
        sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
        learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
        prohibitedExtensions: [], sourceChunkIds: ['chunk-0001-8c189f673e93'],
      },
      slides: [1, 2].map((pageNumber) => ({
        pageNumber, title: pageNumber === 1 ? '光合作用' : '条件与产物', body: ['绿色植物利用光能制造有机物'],
        layout: pageNumber === 1 ? 'HERO' as const : 'SPLIT' as const,
        visualIntent: `用科学课堂画面解释第 ${pageNumber} 页知识`,
        visualPrompt: `A text-free science classroom illustration for page ${pageNumber}`,
        sourceChunkIds: ['chunk-0001-8c189f673e93'],
      })),
    }
    const deckReviewer: DeckReviewPort = {
      async evaluate(input) {
        const revised = input.blueprint.id.includes(':r1')
        return {
          qualityScore: revised ? 91 : 72,
          curriculumCoverageScore: 90, narrativeCoherenceScore: 88,
          visualConsistencyScore: 86, compositionScore: revised ? 90 : 68,
          summary: revised ? '局部修订后布局冲突已消除，整套课件达到交付标准。' : '第二页布局冲突，需要只调整该页元素位置。',
          reviewedSourceChunkIds: input.sourceChunks.map((chunk) => chunk.id),
          issues: revised ? [] : [{
            id: 'issue-layout-2', category: 'COMPOSITION_CONFLICT', severity: 'WARNING',
            summary: '第二页素材与文字区发生布局冲突。', slideIds: [input.slides[1]!.slideId],
            sourceChunkIds: [], status: 'OPEN', repairDomain: 'LAYOUT',
          }],
        }
      },
    }
    const revisionPlanner: RevisionPlanningPort = {
      async plan(input) {
        return {
          summary: '只重新组装第二页，不重新生成图片素材。',
          operations: [{
            id: 'relayout-slide-2', slideId: input.review.issues[0]!.slideIds[0]!,
            kind: 'RELAYOUT', issueIds: ['issue-layout-2'],
            instruction: 'Move the visual away from the editable text area without changing any image prompt.',
            sourceChunkIds: [],
          }],
        }
      },
    }
    const revisionApplication: RevisionApplicationPort = {
      async apply(input) {
        return {
          title: input.blueprint.title,
          curriculum: input.blueprint.curriculum,
          slides: input.blueprint.slides.map((slide) => slide.pageNumber === 2 ? { ...slide, layout: 'EDITORIAL' } : slide),
        }
      },
    }
    const runtime = createAgentRuntime({
      repository, artifacts, renderer, apiToken: token,
      model: {
        async execute(input) {
          const payload = input.payload as { document: { chunks: { id: string }[] } }
          const sourceChunkIds = [payload.document.chunks[0]!.id]
          return {
            ...blueprint,
            curriculum: { ...blueprint.curriculum, sourceChunkIds },
            slides: blueprint.slides.map((slide) => ({ ...slide, sourceChunkIds })),
          }
        },
      },
      visualReviewer: new MockVisualReviewPort({
        approved: true, textDetected: false, visualScore: 92, reasons: [], retryInstruction: null,
      }),
      deckReviewer, revisionPlanner, revisionApplication,
    })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-revision-create' },
      body: JSON.stringify({
        schemaVersion: '1', host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: { kind: 'TEXT', name: '光合作用.txt', text: '绿色植物利用光能制造有机物，并释放氧气。这是完整教材内容。' },
        slideCount: 2, visualDirection: '课堂科学信息图', imageModel: 'mock-image',
        automationLevel: 'SUPERVISED', budgetUnits: 10, maxRevisionRounds: 2,
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id
    await runtime.tick()
    await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-revision-approve-blueprint' },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_BLUEPRINT', expectedVersion: 1 }),
    }))
    for (let index = 0; index < 3; index += 1) await runtime.tick()
    const awaiting = (await repository.getRun(runId))!
    expect(awaiting.status).toBe('AWAITING_REVISION_APPROVAL')

    await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-revision-approve-plan' },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_REVISION', expectedVersion: awaiting.version }),
    }))
    for (let index = 0; index < 4; index += 1) await runtime.tick()
    expect(await repository.getRun(runId)).toMatchObject({ status: 'COMPLETED', revisionRound: 1, qualityScore: 91 })
  })

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

  test('reuses generated knowledge assets across v3 pages and exports independent page objects', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const runtime = createMockRuntime({ repository, artifacts, apiToken: token })
    const created = await runtime.handler(request('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-create-v3-0001' },
      body: JSON.stringify({
        schemaVersion: '1',
        host: { tenantId: 'frameflow', externalUserId: 'user-1' },
        source: { kind: 'TEXT', name: '数量认识.txt', text: '教材通过三个苹果帮助学生建立数量三与具体物体之间的对应关系。' },
        slideCount: 3,
        visualDirection: '纸黏土儿童课堂插画，明亮清晰，知识对象准确',
        imageModel: 'mock-image',
        automationLevel: 'SUPERVISED',
        budgetUnits: 15,
        presentationMode: 'LAYERED_COURSEWARE_V3',
      }),
    }))
    const runId = (await created.json() as { data: { id: string } }).data.id
    await runtime.tick()
    await runtime.handler(request(`/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mock-approve-v3-0001' },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_BLUEPRINT', expectedVersion: 1 }),
    }))
    for (let index = 0; index < 4; index += 1) await runtime.tick()

    expect(await repository.getRun(runId)).toMatchObject({
      status: 'COMPLETED', presentationMode: 'LAYERED_COURSEWARE_V3', committedBudgetUnits: 8,
    })
    const mediaSteps = (await repository.listSteps(runId)).filter((step) => step.tool === 'generate_slide_image')
    expect(mediaSteps).toHaveLength(8)
    const delivery = (await repository.listDeliveries(runId))[0]!
    const artifact = artifacts.artifacts.get(delivery.pptx.artifactId)
    expect(artifact?.bytes.length).toBeGreaterThan(20_000)

    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-v3-e2e-'))
    try {
      const path = join(directory, 'delivery.pptx')
      await writeFile(path, artifact!.bytes)
      const process = Bun.spawn(['unzip', '-p', path, 'ppt/slides/slide3.xml'], { stdout: 'pipe', stderr: 'pipe' })
      const xml = await new Response(process.stdout).text()
      expect(await process.exited).toBe(0)
      expect(xml.match(/<p:pic>/g)).toHaveLength(5)
      expect(xml).toContain('base-3')
      expect(xml).toContain('knowledge-3-1')
      expect(xml).toContain('knowledge-3-4')
      expect(xml).toContain('title-3')
      expect(xml).toContain('body-3')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

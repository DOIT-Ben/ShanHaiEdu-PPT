import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockStructuredModelPort } from '../src/adapters/mock-ports'
import { PlanningRunner } from '../src/core/planning-runner'
import type { DocumentPort, DocumentResult, RunRecord } from '../src/core/ports'
import type { StructuredModelPort } from '../src/core/ports'
import { StructuredModelError } from '../src/core/ports'

const source = {
  kind: 'TEXT',
  name: '光合作用教材.txt',
  text: '绿色植物通过光合作用制造有机物并释放氧气。'.repeat(10),
} as const

const request = {
  runId: 'run-1',
  stepId: 'step-plan-1',
  idempotencyKey: 'run-1:blueprint:v1',
  source,
  slideCount: 2,
  visualDirection: '清晰的课堂科学信息图风格',
} as const

function run(): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source,
    slideCount: 2,
    visualDirection: request.visualDirection,
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'PLANNING',
    resumeState: null,
    version: 0,
    budgetUnits: 100,
    committedBudgetUnits: 0,
    qualityOverride: false,
    qualityOverrideReason: null,
    qualityOverrideBy: null,
    leaseToken: null,
    leaseUntil: null,
    leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function document(overrides: Partial<DocumentResult> = {}): DocumentResult {
  return {
    name: '光合作用教材.txt',
    chunks: [
      { id: 'chunk-0001', text: '绿色植物利用光能制造有机物。', sha256: 'sha-1' },
      { id: 'chunk-0002', text: '这个过程释放氧气，需要叶绿体。', sha256: 'sha-2' },
    ],
    isComplete: true,
    missingRanges: [],
    ...overrides,
  }
}

function documentWithAsset() {
  const bytes = new Uint8Array([137, 80, 78, 71])
  return document({
    sources: [
      { id: 'outline', name: '课程说明', kind: 'TEXT', status: 'READY' },
      { id: 'source-image-1', name: '叶片.png', kind: 'IMAGE', mimeType: 'image/png', status: 'READY' },
    ],
    assets: [{
      id: 'source-asset-1', sourceId: 'source-image-1', name: '叶片.png', mimeType: 'image/png',
      byteLength: bytes.length, sha256: 'a'.repeat(64), width: 640, height: 480, bytes,
    }],
  })
}

function draftWithAsset(assetId = 'source-asset-1', mapToSlide = true) {
  const value = draft()
  return {
    ...value,
    curriculum: { ...value.curriculum, sourceAssetIds: [assetId] },
    slides: value.slides.map((slide, index) => ({
      ...slide,
      sourceAssetIds: mapToSlide && index === 0 ? [assetId] : [],
    })),
  }
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    title: '绿色植物的光合作用',
    curriculum: {
      subject: '生物',
      grade: '七年级',
      lessonTitle: '绿色植物的光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
      learningObjectives: ['理解光合作用的基本条件和产物'],
      scopeBoundaries: ['仅覆盖教材中的定性知识'],
      prohibitedExtensions: ['不扩展复杂化学反应机理'],
      sourceChunkIds: ['chunk-0001', 'chunk-0002'],
    },
    slides: [
      {
        pageNumber: 1,
        title: '认识光合作用',
        body: ['绿色植物能够利用光能制造有机物'],
        layout: 'HERO',
        visualIntent: '以阳光照射绿色叶片建立主题视觉',
        visualPrompt: 'A classroom illustration of green leaves receiving sunlight, no text or symbols',
        sourceChunkIds: ['chunk-0001'],
      },
      {
        pageNumber: 2,
        title: '条件与产物',
        body: ['需要叶绿体', '释放氧气'],
        layout: 'SPLIT',
        visualIntent: '左右构图呈现反应条件和主要产物',
        visualPrompt: 'A balanced botanical science scene with open text-safe areas, no text or symbols',
        sourceChunkIds: ['chunk-0002'],
      },
    ],
    ...overrides,
  }
}

function layeredDraft(knowledgeAssets = 1) {
  const value = draft()
  return {
    ...value,
    slides: value.slides.map((slide, index) => {
      const sourceChunkId = index === 0 ? 'chunk-0001' : 'chunk-0002'
      const image = (role: 'BASE_LAYER' | 'KNOWLEDGE_VISUAL', imageIndex: number) => ({
        kind: 'IMAGE' as const,
        elementId: `${role.toLowerCase()}-${index}-${imageIndex}`,
        role,
        knowledgePoint: '呈现光合作用的教材知识点',
        prompt: 'A child friendly botanical science illustration without text or logos',
        negativePrompt: 'text, watermark, logo',
        sourceChunkIds: [sourceChunkId],
        placement: { x: 0, y: 0, width: 1, height: 1 },
        zIndex: imageIndex,
        fit: 'COVER' as const,
        aspectRatio: '16:9' as const,
        backgroundMode: 'OPAQUE' as const,
      })
      return {
        ...slide,
        layeredDesign: {
          designKind: index === 0 ? 'COVER' as const : 'CONTENT' as const,
          backgroundColor: '#F5F8FF',
          elements: [
            image('BASE_LAYER', 0),
            ...Array.from({ length: knowledgeAssets }, (_, imageIndex) => image('KNOWLEDGE_VISUAL', imageIndex + 1)),
            {
              kind: 'TEXT' as const,
              elementId: `title-${index}`,
              role: 'TITLE' as const,
              text: slide.title,
              sourceChunkIds: [sourceChunkId],
              placement: { x: 0.08, y: 0.12, width: 0.42, height: 0.16 },
              zIndex: 20,
              style: { fontSize: 36, bold: true, color: '#172033', align: 'LEFT' as const },
            },
          ],
        },
      }
    }),
  }
}

class MutableDocumentPort implements DocumentPort {
  constructor(public result: DocumentResult) {}
  async resolve() { return structuredClone(this.result) }
}

async function fixture(documentResult = document(), modelResponse: unknown = draft()) {
  const repository = new InMemoryAgentRepository()
  const documents = new MutableDocumentPort(documentResult)
  const model = new MockStructuredModelPort(modelResponse)
  await repository.createRun(run())
  const runner = new PlanningRunner({ repository, documents, model, clock: new FixedClock() })
  return { repository, documents, model, runner }
}

describe('planning runner', () => {
  test('plans a source-grounded blueprint and waits for approval', async () => {
    const { repository, model, runner } = await fixture()
    const result = await runner.plan(request)

    expect(result).toMatchObject({ replayed: false, step: { status: 'COMPLETED' } })
    expect(result.blueprint?.slides).toHaveLength(2)
    expect(result.blueprint?.curriculum.sourceChunkIds).toEqual(['chunk-0001', 'chunk-0002'])
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'AWAITING_BLUEPRINT_APPROVAL', version: 1 })
    expect(model.executions.size).toBe(1)
    expect((await repository.listEvents('run-1')).map((event) => event.type)).toEqual([
      'tool.started',
      'tool.completed',
      'phase.changed',
      'approval.required',
    ])
  })

  test('replays the persisted blueprint without another model execution', async () => {
    const { model, runner } = await fixture()
    const first = await runner.plan(request)
    const replay = await runner.plan(request)

    expect(replay.replayed).toBe(true)
    expect(replay.blueprint).toEqual(first.blueprint)
    expect(model.executions.size).toBe(1)
  })

  test('uses a new planning key after failure and resolves the previous planning issue on success', async () => {
    const { repository, runner } = await fixture()
    await repository.transact('run-1', (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'PLANNING', planningAttempt: 1, version: 2 })
      transaction.putStep({
        id: 'step-plan-failed-0',
        runId: 'run-1',
        idempotencyKey: 'run-1:blueprint:v1',
        inputHash: 'failed-input-0',
        tool: 'create_blueprint',
        status: 'FAILED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: 'BLUEPRINT_MODEL_OUTPUT_INVALID',
        output: null,
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })

    const result = await runner.plan({
      ...request,
      stepId: 'step-plan-retry-1',
      idempotencyKey: 'run-1:blueprint:retry:1',
      attempt: 1,
    })

    expect(result.step.status).toBe('COMPLETED')
    expect((await repository.listSteps('run-1')).map((step) => step.idempotencyKey)).toEqual([
      'run-1:blueprint:v1',
      'run-1:blueprint:retry:1',
    ])
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'issue.resolved' && event.payload.issueId === 'step-plan-failed-0:planning-failed')).toBe(true)
  })

  test('repairs dynamic source-reference failures before persisting the blueprint', async () => {
    const repository = new InMemoryAgentRepository()
    const documents = new MutableDocumentPort(document())
    const invalid = draft()
    invalid.slides[1]!.sourceChunkIds = ['chunk-invented']
    const executions: Parameters<StructuredModelPort['execute']>[0][] = []
    const model: StructuredModelPort = {
      async execute(input) {
        executions.push(structuredClone(input))
        return structuredClone(executions.length === 1 ? invalid : draft())
      },
    }
    await repository.createRun(run())
    const runner = new PlanningRunner({ repository, documents, model, clock: new FixedClock() })

    const result = await runner.plan(request)

    expect(result.step.status).toBe('COMPLETED')
    expect(executions).toHaveLength(2)
    expect(executions[1]!.idempotencyKey).toMatch(/^blueprint-repair-[a-f0-9]{64}$/)
    expect(executions[1]!.payload).toMatchObject({
      contractRepairIssues: [{ path: 'blueprint', message: 'BLUEPRINT_SOURCE_REFERENCE_INVALID' }],
    })
  })

  test('persists a blueprint only when every adopted source asset maps to a real target page', async () => {
    const { runner } = await fixture(documentWithAsset(), draftWithAsset())
    const result = await runner.plan(request)

    expect(result.step.status).toBe('COMPLETED')
    expect(result.blueprint?.curriculum.sourceAssetIds).toEqual(['source-asset-1'])
    expect(result.blueprint?.slides[0]?.sourceAssetIds).toEqual(['source-asset-1'])
    expect(result.blueprint?.sourceManifest).toHaveLength(2)
    expect(result.blueprint?.sourceAssets).toEqual([expect.objectContaining({ id: 'source-asset-1', sha256: 'a'.repeat(64) })])
    expect(result.blueprint?.sourceAssets[0]).not.toHaveProperty('bytes')
  })

  test.each([
    ['BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID', draftWithAsset('invented-asset')],
    ['BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE', draftWithAsset('source-asset-1', false)],
  ])('rejects invalid source asset lineage with %s', async (errorCode, response) => {
    const { repository, runner } = await fixture(documentWithAsset(), response)
    const result = await runner.plan(request)

    expect(result.step).toMatchObject({ status: 'FAILED' })
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'phase.changed' && event.payload.reason === errorCode)).toBe(true)
  })

  test('stops before the model when document extraction is incomplete', async () => {
    const { repository, model, runner } = await fixture(document({
      isComplete: false,
      missingRanges: ['附件文本提取已截断，原文件共 80 页'],
    }))
    const result = await runner.plan(request)

    expect(result).toMatchObject({ blueprint: null, step: { status: 'FAILED', errorCode: 'SOURCE_INCOMPLETE' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
    expect(model.executions.size).toBe(0)
    const issue = (await repository.listEvents('run-1')).find((event) => event.type === 'issue.detected')
    expect(issue?.type === 'issue.detected' && issue.payload.planningFailure).toMatchObject({
      errorCode: 'SOURCE_INCOMPLETE', retryable: false, suggestedAction: 'MODIFY_SOURCE',
      attempt: 0, maxAttempts: 0, fieldPaths: ['source'], contractVersion: '1',
    })
  })

  test('automatically retries a transient provider failure with the same model request key', async () => {
    const repository = new InMemoryAgentRepository()
    const documents = new MutableDocumentPort(document())
    const executions: Parameters<StructuredModelPort['execute']>[0][] = []
    const delays: number[] = []
    const model: StructuredModelPort = {
      modelName: 'gpt-5.6',
      async execute(input) {
        executions.push(structuredClone(input))
        if (executions.length === 1) {
          throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6', 'request-transient-1')
        }
        return draft()
      },
    }
    await repository.createRun(run())
    const runner = new PlanningRunner({
      repository,
      documents,
      model,
      clock: new FixedClock(),
      sleep: async (milliseconds) => { delays.push(milliseconds) },
    })

    const result = await runner.plan(request)

    expect(result.step.status).toBe('COMPLETED')
    expect(executions).toHaveLength(2)
    expect(executions[0]!.idempotencyKey).toBe(executions[1]!.idempotencyKey)
    expect(delays).toEqual([250])
    expect((await repository.listEvents('run-1')).some((event) =>
      event.type === 'tool.progress' && event.payload.summary?.includes('自动重试 2/3'))).toBe(true)
  })

  test.each([
    'PROVIDER_TIMEOUT',
    'PROVIDER_RATE_LIMIT',
    'PROVIDER_UNAVAILABLE',
  ] as const)('persists retry diagnostics when %s exhausts automatic attempts', async (errorCode) => {
    const repository = new InMemoryAgentRepository()
    const model: StructuredModelPort = {
      modelName: 'gpt-5.6',
      async execute() {
        throw new StructuredModelError(errorCode, true, 'gpt-5.6', 'request-safe-1')
      },
    }
    await repository.createRun(run())
    const runner = new PlanningRunner({
      repository,
      documents: new MutableDocumentPort(document()),
      model,
      clock: new FixedClock(),
      sleep: async () => {},
    })

    const result = await runner.plan(request)
    const issue = (await repository.listEvents('run-1')).find((event) => event.type === 'issue.detected')

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode })
    expect(issue?.type === 'issue.detected' && issue.payload.planningFailure).toMatchObject({
      errorCode, retryable: true, suggestedAction: 'RETRY', attempt: 3, maxAttempts: 3,
      requestId: 'request-safe-1', model: 'gpt-5.6', contractVersion: '1',
    })
  })

  test('repairs malformed model JSON with a new contract-repair key', async () => {
    const repository = new InMemoryAgentRepository()
    const executions: Parameters<StructuredModelPort['execute']>[0][] = []
    const model: StructuredModelPort = {
      modelName: 'gpt-5.6',
      async execute(input) {
        executions.push(structuredClone(input))
        if (executions.length === 1) {
          throw new StructuredModelError('MODEL_JSON_INVALID', true, 'gpt-5.6', 'request-invalid-json-1')
        }
        return draft()
      },
    }
    await repository.createRun(run())
    const runner = new PlanningRunner({
      repository, documents: new MutableDocumentPort(document()), model, clock: new FixedClock(), sleep: async () => {},
    })

    const result = await runner.plan(request)

    expect(result.step.status).toBe('COMPLETED')
    expect(executions).toHaveLength(2)
    expect(executions[0]!.idempotencyKey).toBe(request.idempotencyKey)
    expect(executions[1]!.idempotencyKey).toMatch(/^blueprint-repair-[a-f0-9]{64}$/)
    expect(executions[1]!.payload).toMatchObject({
      contractRepairIssues: [{ path: 'blueprint', message: 'MODEL_JSON_INVALID' }],
    })
  })

  test('persists the final malformed-JSON diagnosis after contract repair is exhausted', async () => {
    const repository = new InMemoryAgentRepository()
    const model: StructuredModelPort = {
      modelName: 'gpt-5.6',
      async execute() {
        throw new StructuredModelError('MODEL_JSON_INVALID', true, 'gpt-5.6', 'request-invalid-json-final')
      },
    }
    await repository.createRun(run())
    const runner = new PlanningRunner({
      repository, documents: new MutableDocumentPort(document()), model, clock: new FixedClock(), sleep: async () => {},
    })

    const result = await runner.plan(request)
    const issue = (await repository.listEvents('run-1')).find((event) => event.type === 'issue.detected')
    const diagnostics = issue?.type === 'issue.detected' ? issue.payload.planningFailure : undefined

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'MODEL_JSON_INVALID' })
    expect(diagnostics).toMatchObject({
      errorCode: 'MODEL_JSON_INVALID', terminalCode: 'CONTRACT_REPAIR_EXHAUSTED',
      retryable: true, attempt: 5, maxAttempts: 5, fieldPaths: ['blueprint'],
      requestId: 'request-invalid-json-final', model: 'gpt-5.6',
    })
  })

  test.each([
    {
      errorCode: 'BLUEPRINT_SCHEMA_INVALID',
      response: { ...draft(), title: '' },
      input: {},
      fieldPath: 'title',
    },
    {
      errorCode: 'BLUEPRINT_SLIDE_COUNT_MISMATCH',
      response: (() => {
        const value = draft()
        return { ...value, slides: [...value.slides, { ...value.slides[1]!, pageNumber: 3 }] }
      })(),
      input: {},
    },
    {
      errorCode: 'BLUEPRINT_SOURCE_REFERENCE_INVALID',
      response: (() => {
        const value = draft()
        value.slides[1]!.sourceChunkIds = ['chunk-invented']
        return value
      })(),
      input: {},
    },
    {
      errorCode: 'V3_LAYER_CONTRACT_INVALID',
      response: draft(),
      input: { presentationMode: 'LAYERED_COURSEWARE_V3' as const },
    },
    {
      errorCode: 'VISUAL_ASSET_LIMIT_EXCEEDED',
      response: layeredDraft(3),
      input: { presentationMode: 'LAYERED_COURSEWARE_V3' as const, maxVisualAssetsPerSlide: 2 },
    },
  ])('classifies exhausted contract repair as $errorCode', async ({ errorCode, response, input, fieldPath }) => {
    const { repository, runner } = await fixture(document(), response)

    const result = await runner.plan({ ...request, ...input })
    const issue = (await repository.listEvents('run-1')).find((event) => event.type === 'issue.detected')
    const diagnostics = issue?.type === 'issue.detected' ? issue.payload.planningFailure : undefined

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode })
    expect(diagnostics).toMatchObject({
      errorCode,
      terminalCode: 'CONTRACT_REPAIR_EXHAUSTED',
      attempt: 5,
      maxAttempts: 5,
      diagnosticCode: errorCode,
      contractVersion: '1',
    })
    if (fieldPath) expect(diagnostics?.fieldPaths).toContain(fieldPath)
  })

  test('rejects invented source references from model output', async () => {
    const invalid = draft()
    invalid.slides[1]!.sourceChunkIds = ['chunk-invented']
    const { repository, runner } = await fixture(document(), invalid)
    const result = await runner.plan(request)

    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'BLUEPRINT_SOURCE_REFERENCE_INVALID' })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
  })

  test('rejects the same planning key when resolved document content changes', async () => {
    const { documents, runner } = await fixture()
    await runner.plan(request)
    documents.result = document({
      chunks: [{ id: 'chunk-0001', text: '宿主附件已经改变。', sha256: 'changed-sha' }],
    })

    await expect(runner.plan(request)).rejects.toThrow('STEP_IDEMPOTENCY_CONFLICT')
  })
})

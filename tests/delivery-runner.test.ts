import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockArtifactPort, MockPresentationRendererPort } from '../src/adapters/mock-ports'
import { DeliveryRunner } from '../src/core/delivery-runner'
import { planningStepKey } from '../src/core/planning-runner'
import type { RunRecord } from '../src/core/ports'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    creationKey: 'create-run-1',
    requestHash: 'request-hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是用于交付测试的完整教材内容。' },
    slideCount: 2,
    visualDirection: '清晰的课堂科学信息图风格',
    imageModel: 'image-2',
    automationLevel: 'SUPERVISED',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: 88,
    status: 'DELIVERING',
    resumeState: null,
    version: 6,
    budgetUnits: 100,
    committedBudgetUnits: 20,
    qualityOverride: false,
    qualityOverrideReason: null,
    qualityOverrideBy: null,
    leaseToken: null,
    leaseUntil: null,
    leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  }
}

function blueprint() {
  return {
    id: 'blueprint-1',
    title: '光合作用',
    visualDirection: '清晰的课堂科学信息图风格',
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: `第 ${pageNumber} 页`,
      body: ['教学内容'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: `第 ${pageNumber} 页对应的教材视觉目标`,
      visualPrompt: `A clean science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: ['chunk-1'],
    })),
  }
}

async function fixture(runOverrides: Partial<RunRecord> = {}) {
  const repository = new InMemoryAgentRepository()
  const artifacts = new MockArtifactPort()
  const renderer = new MockPresentationRendererPort()
  await repository.createRun(run(runOverrides))
  const imageArtifacts: { artifactId: string; sha256: string }[] = []
  for (const pageNumber of [1, 2]) {
    imageArtifacts.push(await artifacts.put({
      tenantId: 'frameflow',
      runId: 'run-1',
      name: `slide-${pageNumber}.png`,
      mimeType: 'image/png',
      bytes: new TextEncoder().encode(`source-image-${pageNumber}`),
      idempotencyKey: `source-image-${pageNumber}`,
    }))
  }
  await repository.transact('run-1', (transaction) => {
    transaction.putStep({
      id: 'step-plan', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'plan-hash',
      tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: blueprint(),
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    for (const [index, artifact] of imageArtifacts.entries()) {
      const pageNumber = index + 1
      transaction.putStep({
        id: `step-image-${pageNumber}`,
        runId: 'run-1',
        idempotencyKey: `run-1:slide:${pageNumber}:image:r0:v1`,
        inputHash: `image-hash-${pageNumber}`,
        tool: 'generate_slide_image',
        status: 'COMPLETED',
        budgetUnits: 10,
        budgetReservationId: `budget-${pageNumber}`,
        externalOperationId: `operation-${pageNumber}`,
        errorCode: null,
        output: {
          slideId: `run-1:slide:${pageNumber}`,
          versionId: `run-1:slide:${pageNumber}:r0:v1`,
          artifactId: artifact.artifactId,
          ...(pageNumber === 1 ? { provenance: {
            provider: 'OPENVERSE', providerAssetId: 'earth-1', title: 'Earth from space',
            sourceUrl: 'https://example.org/earth', creator: 'Example Author', license: 'CC_BY',
            licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
            attribution: 'Earth from space by Example Author', sha256: 'c'.repeat(64),
          } } : {}),
        },
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    }
  })
  return {
    repository,
    artifacts,
    renderer,
    runner: new DeliveryRunner({ repository, artifacts, renderer, clock: new FixedClock() }),
    imageArtifacts,
  }
}

describe('delivery runner', () => {
  test('stores PNG and PPTX artifacts before atomically completing the run', async () => {
    const { repository, artifacts, renderer, runner } = await fixture()
    const result = await runner.deliver('run-1')

    expect(result).toMatchObject({ status: 'COMPLETED', replayed: false, delivery: { qualityScore: 88 } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'COMPLETED', version: 7 })
    expect(await repository.listDeliveries('run-1')).toHaveLength(1)
    expect(result.delivery?.preview.mimeType).toBe('image/png')
    expect(result.delivery?.pptx.mimeType).toContain('presentationml.presentation')
    expect(result.delivery?.sources?.mimeType).toBe('application/json')
    expect(artifacts.artifacts.has(result.delivery!.preview.artifactId)).toBe(true)
    const sources = await artifacts.get({ tenantId: 'frameflow', artifactId: result.delivery!.sources!.artifactId })
    expect(JSON.parse(new TextDecoder().decode(sources!.bytes))).toMatchObject({
      assets: [{ provider: 'OPENVERSE', license: 'CC_BY', title: 'Earth from space' }],
    })
    expect(renderer).toMatchObject({ previewCalls: 1, pptxCalls: 1 })
  })

  test('replays a completed delivery without rendering or storing another artifact', async () => {
    const { artifacts, renderer, runner } = await fixture()
    const first = await runner.deliver('run-1')
    const artifactCount = artifacts.artifacts.size
    const replay = await runner.deliver('run-1')

    expect(replay).toMatchObject({ status: 'COMPLETED', replayed: true })
    expect(replay.delivery).toEqual(first.delivery)
    expect(renderer).toMatchObject({ previewCalls: 1, pptxCalls: 1 })
    expect(artifacts.artifacts.size).toBe(artifactCount)
  })

  test('carries quality override actor, role, issues and time into delivery metadata', async () => {
    const { runner } = await fixture({
      qualityOverride: true,
      qualityOverrideBy: 'admin-1',
      qualityOverrideRole: 'ADMIN',
      qualityOverrideReason: '管理员已逐项复核并接受当前教学风险。',
      qualityOverrideIssueIds: ['issue-factual-1'],
      qualityOverrideAt: '2026-07-21T00:00:00.000Z',
    })
    const result = await runner.deliver('run-1')
    expect(result.delivery?.qualityOverrideAudit).toEqual({
      actorId: 'admin-1',
      actorRole: 'ADMIN',
      reason: '管理员已逐项复核并接受当前教学风险。',
      issueIds: ['issue-factual-1'],
      acceptedAt: '2026-07-21T00:00:00.000Z',
    })
  })

  test('moves to human review when a controlled source artifact is unavailable', async () => {
    const { repository, artifacts, renderer, runner, imageArtifacts } = await fixture()
    artifacts.artifacts.delete(imageArtifacts[1]!.artifactId)
    const result = await runner.deliver('run-1')

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', delivery: null, step: { errorCode: 'DELIVERY_FAILED' } })
    expect(await repository.listDeliveries('run-1')).toEqual([])
    expect(renderer).toMatchObject({ previewCalls: 0, pptxCalls: 0 })
  })

  test('does not complete the run when rendering fails', async () => {
    const { repository, renderer, runner } = await fixture()
    renderer.nextFailure = new Error('injected render failure')
    const result = await runner.deliver('run-1')

    expect(result.status).toBe('NEEDS_HUMAN')
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
    expect(await repository.listDeliveries('run-1')).toEqual([])
  })
})

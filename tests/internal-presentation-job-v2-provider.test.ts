import { describe, expect, test } from 'bun:test'
import { ExternallyAuthorizedBudgetPort } from '../src/adapters/external-budget'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import {
  InternalPresentationJobV2Provider,
  presentationJobV2InternalTenantId,
} from '../src/adapters/internal-presentation-job-v2-provider'
import { InMemoryPresentationJobV2Repository } from '../src/adapters/presentation-job-v2-in-memory-repository'
import { FixedServicePresentationJobBudgetPolicy } from '../src/adapters/presentation-job-v2-ports'
import { FixedClock, MockArtifactPort, MockBudgetPort, MockImageGenerationPort } from '../src/adapters/mock-ports'
import { TenantRoutingBudgetPort } from '../src/adapters/tenant-routing-budget'
import { ensureGenerationBatch, finalizeGenerationBatch, reserveGenerationBatch } from '../src/core/generation-batch'
import { MediaStepRunner } from '../src/core/media-step-runner'
import type { RunRecord } from '../src/core/ports'
import { RunService } from '../src/core/run-service'
import { approvedPageDesignSnapshotHash } from '../src/presentation-job-v2-contracts'
import { presentationBlueprintSchema } from '../src/presentation-contracts'
import { createMockRuntime } from '../src/runtime/mock-runtime'

const apiToken = 'internal-presentation-job-v2-test-token'
const snapshot = {
  schemaVersion: '1',
  title: '植物生长条件',
  subject: '科学',
  gradeBand: '小学二年级',
  lessonDurationMinutes: 40,
  audience: '小学二年级学生',
  objectives: ['说出植物生长需要水、空气和适宜光照'],
  pages: [1, 2].map((pageNumber) => ({
    pageNumber,
    title: `第 ${pageNumber} 页`,
    teachingPurpose: '建立植物生长条件的科学认识。',
    editableCopy: ['阳光', '水', '空气'],
    layoutIntent: '中心植物与周围条件形成清晰关系。',
    visualRequirements: ['完整课堂页面', '不生成文字'],
    teacherNotes: '引导学生观察并归纳。',
    teacherScript: '请说出植物生长需要什么。',
    studentActivity: '选择正确的生长条件。',
    animationSequence: ['植物出现', '条件依次出现'],
    boardPlan: '写出三个生长条件。',
    evidence: [{ type: 'FACT' as const, text: '植物生长需要水、空气和适宜光照。', source: '科学教材' }],
  })),
} as const

const createdAt = '2026-08-05T00:00:00.000Z'

function batchRun(tenantId: string): RunRecord {
  return {
    id: 'internal-provider-billing-run',
    creationKey: 'internal-provider-billing-create',
    requestHash: 'internal-provider-billing-request',
    host: { tenantId, externalUserId: 'frameflow-user' },
    source: { kind: 'TEXT', text: '用于验证批量图片费用归属的完整教材内容。' },
    slideCount: 2,
    visualDirection: '课堂信息图',
    imageModel: 'nanobanana',
    automationLevel: 'BOUNDED_AUTO',
    presentationMode: 'VISUAL_DECK_V4',
    maxRevisionRounds: 2,
    revisionRound: 0,
    qualityScore: null,
    status: 'EXECUTING',
    resumeState: null,
    version: 0,
    budgetUnits: 10,
    committedBudgetUnits: 0,
    qualityOverride: false,
    qualityOverrideReason: null,
    qualityOverrideBy: null,
    leaseToken: null,
    leaseUntil: null,
    leaseVersion: 0,
    createdAt,
    updatedAt: createdAt,
  }
}

function batchBlueprint() {
  return presentationBlueprintSchema.parse({
    id: 'internal-provider-billing-blueprint',
    title: '批量费用归属',
    visualDirection: '课堂信息图',
    sourceManifest: [],
    sourceAssets: [],
    createdAt,
    curriculum: {
      subject: '科学',
      grade: '小学二年级',
      lessonTitle: '植物生长',
      sourceSummary: '本节课用于验证批量图片生成失败后的费用归属。',
      learningObjectives: ['理解植物生长条件'],
      scopeBoundaries: ['教材范围'],
      prohibitedExtensions: [],
      sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: `第 ${pageNumber} 页`,
      body: ['课堂内容'],
      layout: 'HERO',
      visualIntent: '用清晰的课堂信息图表达核心概念',
      visualPrompt: `A classroom science visual for page ${pageNumber}, no text`,
      sourceChunkIds: ['chunk-1'],
    })),
  })
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${apiToken}`)
  headers.set('X-PPT-Agent-User', 'frameflow-user')
  headers.set('X-PPT-Agent-Project', 'frameflow-project')
  return new Request(`http://ppt-agent.test${path}`, { ...init, headers })
}

describe('internal Presentation Job V2 provider', () => {
  test('runs the frozen V2 source through the existing intelligent-agent pipeline', async () => {
    const repository = new InMemoryAgentRepository()
    const presentationJobs = new InMemoryPresentationJobV2Repository()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock()
    const internalTenantId = presentationJobV2InternalTenantId('frameflow')
    const provider = new InternalPresentationJobV2Provider({
      runs: new RunService({ repository, artifacts, clock }),
      repository,
      artifacts,
      internalTenantId,
    })
    const runtime = createMockRuntime({
      repository,
      artifacts,
      clock,
      apiToken,
      budget: new TenantRoutingBudgetPort({
        routedTenantId: internalTenantId,
        routed: new ExternallyAuthorizedBudgetPort(internalTenantId),
        fallback: new MockBudgetPort(),
      }),
      presentationJobV2: {
        repository: presentationJobs,
        provider,
        budget: new FixedServicePresentationJobBudgetPolicy(1),
      },
    })
    const created = await runtime.handler(request('/v2/presentation-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'internal-v2-provider-job' },
      body: JSON.stringify({
        source: {
          kind: 'APPROVED_PAGE_DESIGN',
          artifactVersionId: 'approved-page-design-v1',
          sha256: approvedPageDesignSnapshotHash(snapshot),
          snapshot,
        },
      }),
    }))
    const createdBody = await created.json() as { data: { jobId: string } }

    type JobEnvelope = { data: { status: string; artifact: null | { artifactId: string } } }
    let job: JobEnvelope | null = null
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await runtime.tick()
      const response = await runtime.handler(request(`/v2/presentation-jobs/${createdBody.data.jobId}`))
      job = await response.json() as JobEnvelope
      if (job?.data.status === 'COMPLETED' || job?.data.status === 'FAILED') break
      clock.advance(1_000)
    }

    expect(created.status).toBe(201)
    expect(job?.data.status).toBe('COMPLETED')
    if (!job?.data.artifact) throw new Error('completed Presentation Job V2 did not expose an Artifact')
    const artifactId = job.data.artifact.artifactId
    expect(job).toMatchObject({
      data: {
        status: 'COMPLETED',
        usagePolicy: { maximumBillableImageOperationsPerPage: 5 },
        artifact: { artifactId },
      },
    })
    const [run] = await repository.listRuns()
    expect(run).toMatchObject({
      host: { tenantId: internalTenantId },
      source: { kind: 'APPROVED_PAGE_DESIGN', artifactVersionId: 'approved-page-design-v1' },
      presentationMode: 'VISUAL_DECK_V4',
      automationLevel: 'BOUNDED_AUTO',
      maxRevisionRounds: 4,
      budgetUnits: 10,
    })
    const usage = await runtime.handler(request(`/v2/presentation-jobs/${createdBody.data.jobId}/usage`))
    expect(await usage.json()).toMatchObject({
      data: {
        status: 'FINALIZED',
        usagePolicy: { maximumBillableImageOperationsPerPage: 5 },
        billableImageOperations: 2,
        unknownImageOperations: 0,
      },
    })
    const artifact = await runtime.handler(request(
      `/v2/presentation-jobs/${createdBody.data.jobId}/artifacts/${artifactId}`,
    ))
    expect(artifact.status).toBe(200)
    expect(new Uint8Array(await artifact.arrayBuffer()).slice(0, 2))
      .toEqual(new Uint8Array([0x50, 0x4b]))
  })

  test('maps a batch-released ordinary failed image to not-charged Usage', async () => {
    const repository = new InMemoryAgentRepository()
    const artifacts = new MockArtifactPort()
    const clock = new FixedClock(new Date(createdAt))
    const budget = new MockBudgetPort()
    const images = new MockImageGenerationPort()
    const internalTenantId = presentationJobV2InternalTenantId('frameflow-billing')
    const run = batchRun(internalTenantId)
    await repository.createRun(run)
    const requirements = [1, 2].map((pageNumber) => ({
      pageNumber,
      idempotencyKey: `internal-provider-billing-run:slide:${pageNumber}:image:r0:v1`,
      prompt: `A classroom science visual for page ${pageNumber}, no text`,
    }))
    const batch = await ensureGenerationBatch({
      repository,
      clock,
      run,
      blueprint: batchBlueprint(),
      requirements,
      unitBudgetUnits: 5,
      accountingModel: run.imageModel,
      operationMode: 'TEXT_TO_IMAGE',
    })
    const reservation = await reserveGenerationBatch({
      repository,
      budget,
      clock,
      runId: run.id,
      revisionRound: 0,
    })
    expect(reservation).toEqual({ batchId: batch.batchId, reservationId: expect.any(String) })
    const runner = new MediaStepRunner({ repository, budget, images, clock })

    await runner.submitSlideImage({
      runId: run.id,
      stepId: 'internal-provider-billing-image-1',
      idempotencyKey: requirements[0]!.idempotencyKey,
      batchReservation: reservation!,
      pageNumber: 1,
      revisionRound: 0,
      slideId: 'slide-1',
      versionId: 'slide-1:v1',
      prompt: requirements[0]!.prompt,
      model: run.imageModel,
      budgetUnits: 5,
    })
    images.fail(requirements[0]!.idempotencyKey, 'PROVIDER_REJECTED', 'NOT_CHARGED')
    const failed = await runner.refreshSlideImage(run.id, requirements[0]!.idempotencyKey)
    expect(failed.step).toMatchObject({ status: 'FAILED', externalOperationId: expect.any(String) })

    await runner.submitSlideImage({
      runId: run.id,
      stepId: 'internal-provider-billing-image-2',
      idempotencyKey: requirements[1]!.idempotencyKey,
      batchReservation: reservation!,
      pageNumber: 2,
      revisionRound: 0,
      slideId: 'slide-2',
      versionId: 'slide-2:v1',
      prompt: requirements[1]!.prompt,
      model: run.imageModel,
      budgetUnits: 5,
    })
    images.complete(requirements[1]!.idempotencyKey, 'artifact-slide-2')
    await runner.refreshSlideImage(run.id, requirements[1]!.idempotencyKey)
    await expect(finalizeGenerationBatch({
      repository,
      budget,
      clock,
      runId: run.id,
      revisionRound: 0,
    })).resolves.toBe(true)
    expect((await repository.listSteps(run.id)).find((step) => step.tool === 'generate_image_batch'))
      .toMatchObject({ output: { accounting: { settlement: 'SETTLED', releasedUnits: 5 } } })
    await repository.transact(run.id, (transaction) => {
      transaction.putRun({ ...transaction.run, status: 'FAILED', version: transaction.run.version + 1 })
    })

    const provider = new InternalPresentationJobV2Provider({
      runs: new RunService({ repository, artifacts, clock }),
      repository,
      artifacts,
      internalTenantId,
    })
    await expect(provider.inspect({
      jobId: 'presentation-job-billing',
      operationId: run.id,
      idempotencyKey: 'presentation-job-billing-operation',
    })).resolves.toMatchObject({
      state: 'FAILED',
      usage: {
        billableImageOperations: 1,
        notChargedImageOperations: 1,
        unknownImageOperations: 0,
      },
    })
  })
})

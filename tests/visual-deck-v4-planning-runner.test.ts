import { describe, expect, test } from 'bun:test'
import { FrameFlowHostAdapter } from '../src/adapters/frameflow-host'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { CONTRACT_VERSION } from '../src/contracts'
import { PlanningRunner, planningStepKey } from '../src/core/planning-runner'
import { blueprintImageRequirements } from '../src/core/blueprint-assets'
import { hashInput } from '../src/core/hash'
import { RunService } from '../src/core/run-service'
import { V4ModelPolicy } from '../src/core/v4-model-policy'
import {
  compileVisualDeckV4Proposal,
  V4_PLANNING_STAGES,
  visualDeckV4PlanningStageStepKey,
  type VisualDeckV4PlanningStage,
} from '../src/core/visual-deck-v4-planner'
import {
  StructuredModelError,
  type StructuredGenerationRequestContractPort,
  type StructuredModelMetricsPort,
  type StructuredModelPort,
} from '../src/core/ports'
import { resumeTechnicalRecovery } from '../src/core/technical-recovery'
import { presentationBlueprintSchema } from '../src/presentation-contracts'
import { reflectionDispositionStepKey } from '../src/core/v4-reflection/records'
import {
  CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION,
  CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION,
  LEGACY_VISUAL_DECK_V4_COMPILER_VERSION,
  VISUAL_DECK_V4_COMPILER_VERSION,
} from '../src/release-identity'
import { VISUAL_DECK_V4_REFLECTION_DIMENSIONS } from '../src/visual-deck-v4-contracts'

const baseStages: readonly VisualDeckV4PlanningStage[] = [
  'source-spec', 'deck-visual', 'slide-briefs',
]

function runService(repository: InMemoryAgentRepository, clock: FixedClock) {
  const readiness = {
    status: 'PASSED' as const,
    evaluationRelease: 'test', gatewayContractVersion: 'test', structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA' as const,
    evaluatedAt: '2026-08-07T00:00:00.000Z', evaluationSuite: 'test',
    expiresAt: '9999-12-31T23:59:59.999Z',
  }
  return new RunService({
    repository,
    clock,
    v4ModelPolicy: new V4ModelPolicy({
      runtimeMode: 'MOCK',
      models: [
        { model: 'gpt-5.6-terra', roles: ['TEXT', 'VISION'], evaluationEnabled: true, published: true, readiness },
        { model: 'gpt-image-2', roles: ['IMAGE', 'IMAGE_EDIT'], evaluationEnabled: true, published: true, readiness },
      ],
    }),
  })
}

function planningStageAuditKey(runId: string, stage: VisualDeckV4PlanningStage) {
  return `${visualDeckV4PlanningStageStepKey(runId, stage)}:attempt-audit`
}

function request(options: Readonly<{ presentationGoal?: string }> = {}) {
  return {
    schemaVersion: CONTRACT_VERSION,
    host: { tenantId: 'frameflow', externalUserId: 'v4-user' },
    source: {
      kind: 'SOURCE_PACKAGE' as const,
      name: '百分数课程资料',
      sources: [
        { kind: 'TEXT' as const, sourceId: 'textbook', name: '教材.md', roleHint: 'CONTENT_SOURCE' as const, text: '教材解释百分数表示一个数是另一个数的百分之几，并提供生活比较案例。'.repeat(8) },
        { kind: 'TEXT' as const, sourceId: 'design', name: '设计稿.md', roleHint: 'DESIGN_REFERENCE' as const, text: '设计稿要求用清晰视觉层级、统一配色和逐步展开的课堂叙事。'.repeat(8) },
      ],
    },
    slideCount: 10,
    visualDirection: '成熟清晰的资料驱动课堂视觉叙事',
    imageModel: 'gpt-image-2',
    automationLevel: 'SUPERVISED' as const,
    budgetUnits: 10,
    ...(options.presentationGoal ? { presentationGoal: options.presentationGoal } : {}),
    presentationMode: 'VISUAL_DECK_V4' as const,
    visualDeckV4: {
      instruction: '为六年级学生制作一套理解百分数的视觉演示',
      sourceMode: 'SOURCE_GROUNDED' as const,
      deckOptions: {
        deckType: 'DETAILED_DECK' as const, language: 'zh-CN', length: { slideCount: 10 }, aspectRatio: '16:9' as const,
        audience: '小学六年级学生', focus: '理解统一比较标准', styleHint: '成熟清晰的课堂信息图',
      },
    },
  }
}

// The following matrix exercises persisted chain-1/2/3 recovery behavior.
// New V4 Run defaults are covered by the dedicated chain-4 test below.
async function createChain3Run(
  service: RunService,
  repository: InMemoryAgentRepository,
  input: ReturnType<typeof request>,
  idempotencyKey: string,
) {
  const created = await service.create(input, idempotencyKey)
  const run = await repository.transact(created.run.id, (transaction) => {
    const updated = {
      ...transaction.run,
      release: { ...transaction.run.release!, compilerVersion: CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION },
    }
    transaction.putRun(updated)
    return updated
  })
  return { ...created, run }
}

function documents() {
  return new FrameFlowHostAdapter({
    async getDocumentAttachment(): Promise<never> { throw new Error('attachment access is not expected') },
    async reserveCredits(): Promise<never> { throw new Error('budget access is not expected') },
    async settleCredits(): Promise<never> { throw new Error('budget access is not expected') },
    async releaseCredits(): Promise<never> { throw new Error('budget access is not expected') },
    async finalizeCredits(): Promise<never> { throw new Error('budget access is not expected') },
    async preflightBatchFinalization(): Promise<never> { throw new Error('budget access is not expected') },
  })
}

function proposalFromSourceStage(
  created: Awaited<ReturnType<RunService['create']>>,
  input: ReturnType<typeof request>,
  clock: FixedClock,
  payload: any,
) {
  const document = payload.document ?? {
    name: 'evidence-window',
    chunks: payload.trustedEvidence.sourceChunks.map((chunk: any) => ({
      ...chunk,
      sha256: chunk.sha256 ?? hashInput(chunk.text),
      ...(chunk.sourceId ? { sourceId: chunk.sourceId } : {}),
    })),
    sources: payload.trustedEvidence.sources.map((source: any, index: number) => ({
      id: payload.sourceReferences[index]?.sourceId ?? `source-${index + 1}`,
      name: source.name,
      kind: source.kind,
      status: source.status,
    })),
    assets: [],
    missingRanges: payload.trustedEvidence.missingRanges,
  }
  return compileVisualDeckV4Proposal({
    runId: created.run.id,
    inputHash: 'model-v4-plan',
    source: created.run.source,
    document: { ...document, isComplete: true },
    config: input.visualDeckV4,
    slideCount: input.slideCount,
    visualDirection: input.visualDirection,
    ...(input.presentationGoal ? { presentationGoal: input.presentationGoal } : {}),
    createdAt: clock.now().toISOString(),
  })
}

function stagedModel(
  created: Awaited<ReturnType<RunService['create']>>,
  input: ReturnType<typeof request>,
  clock: FixedClock,
  failSlideBriefsOnce = false,
  slideBriefMutation: 'NONE' | 'INVISIBLE_REFERENCES' | 'INVALID_SOURCE_CHUNK' = 'NONE',
  splitSourceFocus = false,
  semanticRiskMode = false,
) {
  let proposal: ReturnType<typeof compileVisualDeckV4Proposal> | null = null
  let creativeManuscript: unknown = null
  let shouldFail = failSlideBriefsOnce
  const operations: string[] = []
  const modelInputs: Array<Pick<Parameters<StructuredModelPort['execute']>[0], 'operation' | 'modelOverride'>> = []
  let preflightCalls = 0
  const repairPayloads: unknown[] = []
  const reflectionPayloads: unknown[] = []
  const model: StructuredModelPort & {
    preflightStructuredGeneration: () => Promise<{ protocol: 'RESPONSES_JSON_SCHEMA' }>
    describeStructuredGenerationRequest: StructuredGenerationRequestContractPort['describeStructuredGenerationRequest']
    takeExecutionMetrics: StructuredModelMetricsPort['takeExecutionMetrics']
  } = {
    async preflightStructuredGeneration() {
      preflightCalls += 1
      return { protocol: 'RESPONSES_JSON_SCHEMA' }
    },
    async describeStructuredGenerationRequest(modelInput) {
      return {
        protocol: 'RESPONSES_JSON_SCHEMA',
        transport: 'RESPONSES',
        responseFormat: 'JSON_SCHEMA',
        stream: true,
        promptContractHash: hashInput({ adapter: 'staged-model', operation: modelInput.operation, payload: modelInput.payload }),
        responseSchemaHash: hashInput({ adapter: 'staged-model', schemaName: modelInput.schemaName }),
      }
    },
    takeExecutionMetrics(idempotencyKey) {
      return {
        outcome: 'SUCCEEDED',
        errorCode: null,
        requestId: `request-${hashInput(idempotencyKey).slice(0, 12)}`,
        status: 200,
        responseAccepted: true,
        sseEventCount: 1,
        lastActivityAt: clock.now().toISOString(),
        durationMs: 1,
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
      }
    },
    async execute(modelInput) {
      operations.push(modelInput.operation)
      modelInputs.push({
        operation: modelInput.operation,
        ...(modelInput.modelOverride ? { modelOverride: modelInput.modelOverride } : {}),
      })
      if (modelInput.operation === 'create_visual_deck_v4_creative_manuscript') {
        proposal = proposalFromSourceStage(created, input, clock, modelInput.payload)
        const payload = modelInput.payload as { trustedEvidence: { sourceChunks: { text: string }[] } }
        const excerpt = payload.trustedEvidence.sourceChunks[0]!.text.slice(0, 80)
        creativeManuscript = {
          title: proposal.deckPlan.title,
          narrative: proposal.deckPlan.narrativeArc,
          slides: proposal.slideBriefs.map((slide) => ({
            title: slide.title,
            narrative: slide.keyClaim,
            userVisibleCopy: slide.lockedCopy,
            factualStatements: slide.facts,
            visualDescription: slide.visualMetaphor,
            sourceEvidence: [{ excerpt }],
          })),
        }
        return creativeManuscript
      }
      if (modelInput.operation === 'review_visual_deck_v4_manuscript') {
        if (!creativeManuscript) throw new Error('TEST_CREATIVE_MANUSCRIPT_REQUIRED')
        return { ...(creativeManuscript as object), revisionSuggestions: [] }
      }
      if (modelInput.operation === 'create_visual_deck_v4_source_spec') {
        proposal = proposalFromSourceStage(created, input, clock, modelInput.payload)
        return {
          sourceUnderstanding: proposal.sourceUnderstanding,
          presentationSpec: {
            ...proposal.presentationSpec,
            focus: splitSourceFocus ? ['理解统一比较', '建立统一标准'] : proposal.presentationSpec.focus,
          },
        }
      }
      if (!proposal) throw new Error('TEST_SOURCE_SPEC_REQUIRED')
      if (modelInput.operation === 'create_visual_deck_v4_deck_visual') {
        return { deckPlan: proposal.deckPlan, visualContract: proposal.visualContract }
      }
      if (modelInput.operation === 'critique_v4_deck_consistency') {
        reflectionPayloads.push(structuredClone(modelInput.payload))
        return { issues: [] }
      }
      if (modelInput.operation === 'create_visual_deck_v4_slide_briefs') {
        if (shouldFail) {
          shouldFail = false
          throw new Error('TEST_SLIDE_BRIEFS_FAILURE')
        }
        const slideBriefs = structuredClone(proposal.slideBriefs)
        if (slideBriefMutation === 'INVISIBLE_REFERENCES') {
          slideBriefs[4]!.title = '互动练习：百分数小达人'
          slideBriefs[4]!.lockedCopy = [
            '第1关：读写——把“百分之四十点五”写成百分数；把72%读出来。',
            '第2关：说意义——一件商品降价20%，这里的20%表示什么？',
            '第3关：互化——0.35=（ ）%；4/5=（ ）%。',
            '第4关：判断——“六（1）班今天来了48人，出勤率是48%。”这句话对吗？为什么？',
          ]
          slideBriefs[4]!.numbers = ['40.5', '72%', '20%', '0.35', '4/5', '48', '48%', '4']
          slideBriefs[4]!.formulas = ['0.35=（ ）%', '40.5%']
        }
        if (slideBriefMutation === 'INVALID_SOURCE_CHUNK') {
          const payload = modelInput.payload as { contractRepairIssues?: unknown }
          if (!payload.contractRepairIssues) {
            slideBriefs[1]!.sourceChunkIds = ['invented']
          } else {
            repairPayloads.push(payload.contractRepairIssues)
          }
        }
        if (semanticRiskMode) {
          slideBriefs[5] = {
            ...slideBriefs[5]!,
            title: '5可以分成3和2',
            keyClaim: '把恰好5个圆片分成3个和2个两个非空组',
            lockedCopy: ['5可以分成3和2'],
            facts: ['全页恰好5个圆片；分成两个非空组；本页只呈现3和2这一种分法'],
            numbers: ['5', '3', '2'],
            formulas: [],
            visualMetaphor: '用圆片展示5分成3和2的结果',
            composition: '上方一条3个圆片展示带，下方一条2个圆片展示带，底部再加入聚拢的圆片视觉提示',
          }
          slideBriefs[11] = {
            ...slideBriefs[11]!,
            title: '回顾我们的学习',
            keyClaim: '回顾观察、分组和表达的学习过程',
            lockedCopy: ['回顾我们的学习'],
            facts: ['只总结教材已经呈现的学习过程'],
            numbers: [],
            formulas: [],
            visualMetaphor: '用一条学习足迹串联课堂回顾',
            composition: '用一条学习足迹组织3个素材场景，沿路径依次布置并形成收束',
          }
        }
        return { slideBriefs }
      }
      if (modelInput.operation === 'critique_v4_slide_briefs') {
        reflectionPayloads.push(structuredClone(modelInput.payload))
        if (semanticRiskMode) {
          return {
            issues: [
              {
                pageNumber: 6, category: 'COUNTABILITY_RISK', field: 'composition',
                problem: '底部聚拢提示可能形成第三组圆片',
                desiredChange: '只保留3个和2个两条圆片展示带',
              },
              {
                pageNumber: 12, category: 'UNAUTHORIZED_TEXT_RISK', field: 'composition',
                problem: '三个素材场景可能诱导模型绘制步骤编号',
                desiredChange: '使用无编号的连续学习路径',
              },
            ],
          }
        }
        return { issues: [] }
      }
      if (modelInput.operation === 'optimize_v4_slide_briefs') {
        reflectionPayloads.push(structuredClone(modelInput.payload))
        const issues = (modelInput.payload as { issues: { issueId: string; pageNumber: number }[] }).issues
        return {
          roleChanges: [], visualMetaphorChanges: [], informationHierarchyChanges: [],
          previousSlideRelationChanges: [], nextSlideRelationChanges: [],
          compositionChanges: issues.map((issue) => ({
            issueIds: [issue.issueId],
            pageNumber: issue.pageNumber,
            value: issue.pageNumber === 6
              ? '只保留一条3个圆片展示带和一条2个圆片展示带；底部禁止出现任何圆片或圆片轮廓'
              : '用一条连续且不分步编号的学习路径串联三个抽象图形；禁止任何步骤编号或数字徽章',
          })),
        }
      }
      if (modelInput.operation === 'review_visual_deck_v4_coherence') {
        return {
          decision: 'APPROVED',
          summary: '请求、来源、叙事、页面覆盖和视觉系统保持一致。',
          checks: [
            'REQUEST_BINDING',
            'SOURCE_GROUNDING',
            'NARRATIVE_COHERENCE',
            'SLIDE_COVERAGE',
            'VISUAL_COHERENCE',
          ].map((dimension) => ({ dimension, passed: true, evidence: `${dimension} 已通过。` })),
        }
      }
      throw new Error(`TEST_OPERATION_UNEXPECTED:${modelInput.operation}`)
    },
  }
  return { model, operations, modelInputs, preflightCalls: () => preflightCalls, repairPayloads, reflectionPayloads }
}

describe('visual deck v4 planning runner', () => {
  test('uses the chain-4 semantic manuscript contract for a new V4 Run', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-manuscript-0001')
    const { model, operations, modelInputs } = stagedModel(created, inputRequest, clock)
    const runner = new PlanningRunner({ repository, documents: documents(), model, clock })
    const result = await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(created.run.release?.compilerVersion).toBe(VISUAL_DECK_V4_COMPILER_VERSION)
    expect(operations).toEqual([
      'create_visual_deck_v4_creative_manuscript',
      'review_visual_deck_v4_manuscript',
    ])
    expect(modelInputs).toEqual([
      { operation: 'create_visual_deck_v4_creative_manuscript', modelOverride: 'gpt-5.6-terra' },
      { operation: 'review_visual_deck_v4_manuscript', modelOverride: 'gpt-5.6-terra' },
    ])
    expect(result.blueprint?.visualDeckV4Proposal?.compilerVersion).toBe(VISUAL_DECK_V4_COMPILER_VERSION)
    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs[0]).toMatchObject({ pageNumber: 1, role: 'COVER' })
    const stages = await repository.listSteps(created.run.id)
    const creative = stages.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(
      created.run.id, 'creative-manuscript',
    ))
    const review = stages.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(
      created.run.id, 'review-manuscript',
    ))
    expect(creative?.output).not.toHaveProperty('slides.0.pageNumber')
    expect(review?.output).not.toHaveProperty('slides.0.sourceChunkId')
    const requestEvidence = stages.filter((step) => step.tool === 'audit_v4_planning_request')
    expect(requestEvidence).toHaveLength(2)
    expect(requestEvidence.map((step) => step.output)).toEqual([
      expect.objectContaining({
        schemaVersion: '1',
        stage: 'creative-manuscript',
        operation: 'create_visual_deck_v4_creative_manuscript',
        compilerVersion: VISUAL_DECK_V4_COMPILER_VERSION,
        model: 'gpt-5.6-terra',
        protocol: 'RESPONSES_JSON_SCHEMA',
        transport: 'RESPONSES',
        responseFormat: 'JSON_SCHEMA',
        stream: true,
        promptContractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        responseSchemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        payloadCharacterCount: expect.any(Number),
        evidenceWindow: expect.objectContaining({
          selectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          chunks: expect.arrayContaining([expect.objectContaining({
            id: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            includedCharacterCount: expect.any(Number),
          })]),
        }),
        sourceAssetInputs: [],
      }),
      expect.objectContaining({
        stage: 'review-manuscript',
        sourceAssetInputs: [],
        promptContractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        responseSchemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ])
    const serializedEvidence = JSON.stringify(requestEvidence.map((step) => step.output))
    expect(serializedEvidence).not.toContain('教材解释百分数表示一个数是另一个数的百分之几')
    expect(serializedEvidence).not.toContain('你是一位拥有 20 年经验的演示文稿创意作者')
    expect((await repository.listEvents(created.run.id))
      .filter((event) => event.type === 'tool.progress')
      .map((event) => event.type === 'tool.progress' ? event.payload.completed : null)).toEqual([1, 2])
  })

  test('fails closed before replaying a chain-4 request whose source asset summary drifted', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-request-drift-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    let assetHash = 'a'.repeat(64)
    let creativeCalls = 0
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation === 'create_visual_deck_v4_creative_manuscript') {
        creativeCalls += 1
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6-terra', null, null, 'UNKNOWN')
      }
      return execute(modelInput)
    }
    const sourceDocument = {
      name: '含图片来源的教材包',
      chunks: [{
        id: 'source-chunk', sourceId: 'source', text: '百分数表示一个数是另一个数的百分之几。', sha256: 'c'.repeat(64),
      }],
      sources: [{ id: 'source', name: '教材.pdf', kind: 'PDF' as const, status: 'READY' as const }],
      isComplete: true,
      missingRanges: [],
    }
    const runner = new PlanningRunner({
      repository,
      documents: {
        async resolve() {
          return {
            ...sourceDocument,
            assets: [{
              id: 'asset-1', sourceId: 'source', name: '教材插图.png', mimeType: 'image/png' as const,
              byteLength: 1, sha256: assetHash, width: 1, height: 1, bytes: new Uint8Array([1]),
            }],
          }
        },
      },
      model: staged.model,
      clock,
    })
    const planInput = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    }

    await expect(runner.plan(planInput)).resolves.toMatchObject({
      blueprint: null,
      step: { status: 'FAILED', errorCode: 'PROVIDER_UNAVAILABLE' },
    })
    expect(creativeCalls).toBe(1)
    const initialEvidence = (await repository.listSteps(created.run.id))
      .find((step) => step.tool === 'audit_v4_planning_request')
    expect(initialEvidence?.output).toMatchObject({
      sourceAssetInputs: [{ id: 'asset-1', sha256: 'a'.repeat(64), mimeType: 'image/png', byteLength: 1 }],
    })

    assetHash = 'b'.repeat(64)
    clock.advance(2_000)
    await repository.transact(created.run.id, (transaction) => resumeTechnicalRecovery(transaction, clock))
    await expect(runner.plan(planInput)).resolves.toMatchObject({
      blueprint: null,
      step: { status: 'FAILED', errorCode: 'V4_PLANNING_REQUEST_REPLAY_MISMATCH' },
    })

    expect(creativeCalls).toBe(1)
    expect(await repository.getRun(created.run.id)).toMatchObject({ status: 'FAILED' })
  })

  test('fails closed before a second model call when the chain-4 request contract drifts', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-adapter-drift-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    let creativeCalls = 0
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation === 'create_visual_deck_v4_creative_manuscript') {
        creativeCalls += 1
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6-terra', null, null, 'UNKNOWN')
      }
      return execute(modelInput)
    }
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })
    const planInput = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    }

    await expect(runner.plan(planInput)).resolves.toMatchObject({
      blueprint: null,
      step: { status: 'FAILED', errorCode: 'PROVIDER_UNAVAILABLE' },
    })
    expect(creativeCalls).toBe(1)

    const describe = staged.model.describeStructuredGenerationRequest.bind(staged.model)
    staged.model.describeStructuredGenerationRequest = async (modelInput) => ({
      ...await describe(modelInput),
      promptContractHash: 'f'.repeat(64),
    })
    clock.advance(2_000)
    await repository.transact(created.run.id, (transaction) => resumeTechnicalRecovery(transaction, clock))
    await expect(runner.plan(planInput)).resolves.toMatchObject({
      blueprint: null,
      step: { status: 'FAILED', errorCode: 'V4_PLANNING_REQUEST_REPLAY_MISMATCH' },
    })

    expect(creativeCalls).toBe(1)
  })

  test('fails closed before model submission when the chain-4 request descriptor is unavailable or invalid', async () => {
    for (const kind of ['MISSING', 'NON_RESPONSES', 'NON_STREAMING'] as const) {
      const repository = new InMemoryAgentRepository()
      const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
      const service = runService(repository, clock)
      const inputRequest = request()
      const created = await service.create(inputRequest, `create-v4-chain-4-descriptor-${kind.toLowerCase()}-0001`)
      const staged = stagedModel(created, inputRequest, clock)
      const execute = staged.model.execute.bind(staged.model)
      let executeCalls = 0
      staged.model.execute = async (modelInput) => {
        executeCalls += 1
        return execute(modelInput)
      }
      if (kind === 'MISSING') {
        delete (staged.model as StructuredModelPort & Partial<StructuredGenerationRequestContractPort>)
          .describeStructuredGenerationRequest
      } else {
        const describe = staged.model.describeStructuredGenerationRequest.bind(staged.model)
        staged.model.describeStructuredGenerationRequest = async (modelInput) => ({
          ...await describe(modelInput),
          ...(kind === 'NON_RESPONSES' ? { transport: 'CHAT_COMPLETIONS' as never } : { stream: false as never }),
        })
      }
      const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })
      const result = await runner.plan({
        runId: created.run.id,
        stepId: `step-${created.run.id}-plan`,
        idempotencyKey: planningStepKey(created.run.id),
        source: created.run.source,
        slideCount: created.run.slideCount,
        visualDirection: created.run.visualDirection,
        presentationMode: inputRequest.presentationMode,
        visualDeckV4: inputRequest.visualDeckV4,
      })

      expect(result).toMatchObject({
        blueprint: null,
        step: { status: 'FAILED', errorCode: 'V4_CHAIN4_PROTOCOL_UNSUPPORTED' },
      })
      expect(executeCalls).toBe(0)
      expect((await repository.listSteps(created.run.id)).find((step) => step.idempotencyKey ===
        visualDeckV4PlanningStageStepKey(created.run.id, 'creative-manuscript'))).toMatchObject({
        status: 'FAILED', errorCode: 'V4_CHAIN4_PROTOCOL_UNSUPPORTED',
      })
    }
  })

  test('fails closed before a second model call when the chain-4 response Schema contract drifts', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-schema-drift-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    let creativeCalls = 0
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation === 'create_visual_deck_v4_creative_manuscript') {
        creativeCalls += 1
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6-terra', null, null, 'UNKNOWN')
      }
      return execute(modelInput)
    }
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })
    const planInput = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    }

    await expect(runner.plan(planInput)).resolves.toMatchObject({
      blueprint: null,
      step: { status: 'FAILED', errorCode: 'PROVIDER_UNAVAILABLE' },
    })
    expect(creativeCalls).toBe(1)

    const describe = staged.model.describeStructuredGenerationRequest.bind(staged.model)
    staged.model.describeStructuredGenerationRequest = async (modelInput) => ({
      ...await describe(modelInput),
      responseSchemaHash: 'e'.repeat(64),
    })
    clock.advance(2_000)
    await repository.transact(created.run.id, (transaction) => resumeTechnicalRecovery(transaction, clock))
    await expect(runner.plan(planInput)).resolves.toMatchObject({
      blueprint: null,
      step: { status: 'FAILED', errorCode: 'V4_PLANNING_REQUEST_REPLAY_MISMATCH' },
    })

    expect(creativeCalls).toBe(1)
  })

  test('plans with a 200-chunk evidence window without demanding omitted chunk coverage', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-window-0001')
    const { model } = stagedModel(created, inputRequest, clock)
    const outsideMarker = 'WINDOW_OUTSIDE_MARKER_MUST_NOT_REACH_THE_BLUEPRINT'
    const chunks = Array.from({ length: 201 }, (_, index) => ({
      id: `chunk-${String(index + 1).padStart(3, '0')}`,
      sourceId: index % 2 === 0 ? 'textbook' : 'design',
      text: index === 200
        ? outsideMarker
        : `唯一编号 ${String(index + 1).padStart(3, '0')} 的普通短来源块内容。`,
      sha256: hashInput(`chunk-${index + 1}`),
    }))
    const runner = new PlanningRunner({
      repository,
      documents: {
        async resolve() {
          return {
            name: '大规模来源窗口', chunks, assets: [], isComplete: true, missingRanges: [],
            sources: [
              { id: 'textbook', name: '教材.md', kind: 'TEXT' as const, status: 'READY' as const },
              { id: 'design', name: '设计稿.md', kind: 'TEXT' as const, status: 'READY' as const },
            ],
          }
        },
      },
      model,
      clock,
    })

    const result = await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.step).toMatchObject({ status: 'COMPLETED' })
    expect(result.blueprint?.visualDeckV4Proposal?.sourceUnderstanding.sources
      .flatMap((source) => source.sourceChunkIds)).toHaveLength(200)
    expect(result.blueprint?.curriculum.sourceSummary).not.toContain(outsideMarker)
    const audit = (await repository.listSteps(created.run.id))
      .find((step) => step.idempotencyKey === `${created.run.id}:v4:evidence-window`)
    expect(audit?.output).toMatchObject({ omittedChunkCount: 1 })
  })

  test('bounds CJK review payloads by characters before the gateway boundary', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-cjk-budget-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    let reviewPayload: unknown = null
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation === 'review_visual_deck_v4_manuscript') {
        reviewPayload = structuredClone(modelInput.payload)
        return execute(modelInput)
      }
      const result = await execute(modelInput)
      if (modelInput.operation !== 'create_visual_deck_v4_creative_manuscript') return result
      const manuscript = structuredClone(result) as { slides: Record<string, unknown>[] }
      manuscript.slides = manuscript.slides.map((slide) => ({
        ...slide,
        narrative: '汉'.repeat(500),
        userVisibleCopy: Array.from({ length: 8 }, () => '汉'.repeat(300)),
        factualStatements: Array.from({ length: 20 }, (_, index) => `${index}${'汉'.repeat(148)}`),
        visualDescription: '汉'.repeat(900),
      }))
      return manuscript
    }
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })

    await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    })

    const payload = reviewPayload as { creativeManuscript: unknown }
    expect(JSON.stringify(payload.creativeManuscript).length).toBeLessThanOrEqual(80_000)
    expect(JSON.stringify(payload.creativeManuscript).length).toBeGreaterThan(70_000)
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(220_000)
    expect(Buffer.byteLength(JSON.stringify(payload.creativeManuscript), 'utf8')).toBeGreaterThan(80_000)
  })

  test('fails before persisting an oversized CreativeManuscript', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-oversized-manuscript-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    let creativeCalls = 0
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation !== 'create_visual_deck_v4_creative_manuscript') return await execute(modelInput)
      creativeCalls += 1
      return {
        title: '标题'.repeat(80),
        narrative: Array.from({ length: 20 }, () => '叙事'.repeat(250)),
        slides: Array.from({ length: 5 }, () => ({
          title: '页'.repeat(160), narrative: '叙'.repeat(1_200),
          userVisibleCopy: Array.from({ length: 8 }, () => '文'.repeat(500)),
          factualStatements: Array.from({ length: 20 }, () => '事'.repeat(500)),
          visualDescription: '视'.repeat(1_500),
          sourceEvidence: Array.from({ length: 8 }, () => ({ excerpt: '证'.repeat(1_200) })),
        })),
      }
    }
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })

    const result = await runner.plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result).toMatchObject({ blueprint: null, step: { errorCode: 'V4_MANUSCRIPT_CONTEXT_TOO_LARGE' } })
    expect(creativeCalls).toBe(1)
    const manuscript = (await repository.listSteps(created.run.id))
      .find((step) => step.tool === 'compile_v4_creative_manuscript')
    expect(manuscript).toMatchObject({ status: 'FAILED', output: null })
  })

  test('fails a new chain-4 run closed when preflight is not Responses JSON Schema', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-protocol-0001')
    await repository.transact(created.run.id, (transaction) => {
      const { v4StructuredGenerationProtocol: _protocol, ...withoutProtocol } = transaction.run
      transaction.putRun(withoutProtocol)
    })
    const staged = stagedModel(created, inputRequest, clock)
    let preflightCalls = 0
    staged.model.preflightStructuredGeneration = async () => {
      preflightCalls += 1
      return { protocol: 'CHAT_LEGACY' as never }
    }
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })

    const result = await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
      attempt: 1,
    })

    expect(result.blueprint).toBeNull()
    expect(result.step).toMatchObject({ status: 'FAILED', errorCode: 'V4_CHAIN4_PROTOCOL_UNSUPPORTED' })
    expect(preflightCalls).toBe(1)
    expect(staged.operations).toEqual([])
    expect(await repository.getRun(created.run.id)).toMatchObject({ status: 'FAILED', committedBudgetUnits: 0 })
    const steps = await repository.listSteps(created.run.id)
    expect(steps.find((step) => step.idempotencyKey === `${created.run.id}:v4:structured-generation-preflight:planning:1`))
      .toMatchObject({ status: 'FAILED', errorCode: 'V4_CHAIN4_PROTOCOL_UNSUPPORTED' })
    expect(steps.some((step) => step.tool === 'generate_slide_image'
      || step.tool === 'generate_image_batch'
      || step.tool.includes('usage'))).toBe(false)
  })

  test('fails a chain-4 V4 Run without a model snapshot before any model submission', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-legacy-snapshot-missing-0001')
    await repository.transact(created.run.id, (transaction) => {
      const { v4ModelSnapshot: _snapshot, ...legacy } = transaction.run
      transaction.putRun(legacy)
    })
    const staged = stagedModel(created, inputRequest, clock)
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })

    const result = await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result).toMatchObject({ blueprint: null, step: { errorCode: 'V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE' } })
    expect(staged.preflightCalls()).toBe(0)
    expect(staged.operations).toEqual([])
    expect(await repository.getRun(created.run.id)).toMatchObject({ status: 'FAILED' })
  })

  test('resumes a historical chain-3 V4 Run without recomputing missing model or protocol snapshots', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-chain-3-snapshot-missing-0001')
    await repository.transact(created.run.id, (transaction) => {
      const { v4ModelSnapshot: _snapshot, ...legacy } = transaction.run
      transaction.putRun(legacy)
    })
    const staged = stagedModel(created, inputRequest, clock)
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })

    const result = await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal?.compilerVersion).toBe(CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION)
    expect(staged.preflightCalls()).toBe(0)
    expect(staged.modelInputs.every((input) => input.modelOverride === undefined)).toBe(true)
    const resumed = await repository.getRun(created.run.id)
    expect(resumed?.v4ModelSnapshot).toBeUndefined()
    expect(resumed?.v4StructuredGenerationProtocol).toBeUndefined()
    expect((await repository.listSteps(created.run.id)).some((step) =>
      step.tool === 'audit_v4_planning_request')).toBe(false)
  })

  test('fails a recovered chain-4 run closed when its persisted preflight protocol is legacy', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-persisted-protocol-0001')
    const key = `${created.run.id}:v4:structured-generation-preflight:planning:0`
    await repository.transact(created.run.id, (transaction) => transaction.putStep({
      id: `step-${hashInput({ key }).slice(0, 28)}`, runId: created.run.id, idempotencyKey: key,
      inputHash: hashInput({
        tool: 'preflight_v4_structured_generation',
        model: created.run.v4ModelSnapshot!.textModel,
      }),
      tool: 'preflight_v4_structured_generation', status: 'COMPLETED', budgetUnits: 0,
      budgetReservationId: null, externalOperationId: null, errorCode: null,
      output: { protocol: 'RESPONSES_FUNCTION' },
      createdAt: clock.now().toISOString(), updatedAt: clock.now().toISOString(),
    }))
    const staged = stagedModel(created, inputRequest, clock)
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })
    const result = await runner.plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id), source: created.run.source,
      slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })
    expect(result).toMatchObject({ blueprint: null, step: { errorCode: 'V4_CHAIN4_PROTOCOL_UNSUPPORTED' } })
    expect(staged.operations).toEqual([])
  })

  test('allows exactly one semantic completion to disambiguate repeated source evidence', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-evidence-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    let reviewCalls = 0
    staged.model.execute = async (modelInput) => {
      const result = await execute(modelInput)
      if (modelInput.operation !== 'review_visual_deck_v4_manuscript') return result
      reviewCalls += 1
      if (!(modelInput.payload as { sourceEvidenceDisambiguation?: string }).sourceEvidenceDisambiguation) return result
      return {
        ...(result as any),
        slides: (result as any).slides.map((slide: any) => ({
          ...slide,
          sourceEvidence: [{ excerpt: '第一来源唯一证据段落说明百分数统一比较。' }],
        })),
      }
    }
    const common = '共同教材摘录用于制造歧义。'.repeat(8)
    const document = {
      name: '重复来源',
      sources: [
        { id: 'textbook', name: '教材.md', kind: 'TEXT' as const, status: 'READY' as const },
        { id: 'design', name: '设计稿.md', kind: 'TEXT' as const, status: 'READY' as const },
      ],
      chunks: [
        { id: 'chunk-a', sourceId: 'textbook', text: `${common}第一来源唯一证据段落说明百分数统一比较。`, sha256: 'a'.repeat(64) },
        { id: 'chunk-b', sourceId: 'design', text: `${common}第二来源唯一证据段落说明课堂视觉。`, sha256: 'b'.repeat(64) },
      ],
      assets: [], isComplete: true, missingRanges: [],
    }
    const runner = new PlanningRunner({
      repository,
      documents: { async resolve() { return document } },
      model: staged.model,
      clock,
    })

    const result = await runner.plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id), source: created.run.source,
      slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs.every((slide) =>
      slide.sourceChunkIds.includes('chunk-a'))).toBe(true)
    expect(reviewCalls).toBe(2)
  })

  test('permits exactly one chain-4 content-slot completion after a semantic schema failure', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-slot-completion-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    let creativeCalls = 0
    const completionPayloads: unknown[] = []
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation === 'create_visual_deck_v4_creative_manuscript') {
        creativeCalls += 1
        if (creativeCalls === 1) {
          throw new StructuredModelError('MODEL_JSON_INVALID', true, 'test-model', 'request-invalid', 200)
        }
        completionPayloads.push(modelInput.payload)
      }
      return execute(modelInput)
    }
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })
    const result = await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal?.compilerVersion).toBe(VISUAL_DECK_V4_COMPILER_VERSION)
    expect(creativeCalls).toBe(2)
    expect(completionPayloads).toEqual([expect.objectContaining({ contentSlotCompletion: true })])
  })

  test('does not grant a second semantic completion after repaired review evidence remains ambiguous', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-07T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await service.create(inputRequest, 'create-v4-chain-4-combined-repair-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    let reviewCalls = 0
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation === 'review_visual_deck_v4_manuscript') {
        reviewCalls += 1
        if (reviewCalls === 1) {
          throw new StructuredModelError('MODEL_JSON_INVALID', true, 'test-model', 'request-invalid', 200)
        }
      }
      return execute(modelInput)
    }
    const common = '共同教材摘录用于制造歧义。'.repeat(8)
    const runner = new PlanningRunner({
      repository,
      documents: { async resolve() { return {
        name: '重复来源', isComplete: true, missingRanges: [], assets: [],
        sources: [
          { id: 'textbook', name: '教材.md', kind: 'TEXT' as const, status: 'READY' as const },
          { id: 'design', name: '设计稿.md', kind: 'TEXT' as const, status: 'READY' as const },
        ],
        chunks: [
          { id: 'chunk-a', sourceId: 'textbook', text: `${common}第一来源。`, sha256: 'a'.repeat(64) },
          { id: 'chunk-b', sourceId: 'design', text: `${common}第二来源。`, sha256: 'b'.repeat(64) },
        ],
      } } },
      model: staged.model, clock,
    })
    const result = await runner.plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id), source: created.run.source,
      slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })
    expect(result).toMatchObject({ blueprint: null, step: { errorCode: 'V4_MANUSCRIPT_SOURCE_EVIDENCE_AMBIGUOUS' } })
    expect(reviewCalls).toBe(2)
  })

  test('persists a real ten-page plan as five recoverable structured stages', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-planning-0001')
    const { model, operations, reflectionPayloads } = stagedModel(created, inputRequest, clock)
    const runner = new PlanningRunner({ repository, documents: documents(), model, clock })
    const input = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
      ...(inputRequest.presentationGoal ? { presentationGoal: inputRequest.presentationGoal } : {}),
    } as const

    await expect(runner.plan({ ...input, presentationMode: 'SLIDE_IMAGE_V2' }))
      .rejects.toThrow('RUN_PRESENTATION_MODE_MISMATCH')
    const first = await runner.plan(input)
    const replay = await runner.plan(input)

    expect(operations).toEqual([
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'critique_v4_deck_consistency',
      'create_visual_deck_v4_slide_briefs',
      'critique_v4_slide_briefs',
    ])
    expect(operations).not.toContain('review_visual_deck_v4_coherence')
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(first.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'EXECUTING', committedBudgetUnits: 0,
    })
    const steps = await repository.listSteps(created.run.id)
    expect(steps).toHaveLength(11)
    for (const stage of baseStages) {
      expect(steps.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(created.run.id, stage)))
        .toMatchObject({ status: 'COMPLETED' })
      expect(steps.find((step) => step.idempotencyKey === planningStageAuditKey(created.run.id, stage)))
        .toMatchObject({
          tool: 'audit_v4_planning_stage', status: 'COMPLETED', budgetUnits: 0,
          output: {
            schemaVersion: '1', stage, stageKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            totalDurationMs: expect.any(Number),
            attempts: [expect.objectContaining({ attempt: 1, outcome: 'SUCCEEDED' })],
          },
        })
    }
    const proposal = first.blueprint!.visualDeckV4Proposal!
    const reflectionKeyInput = {
      runId: created.run.id, planningAttempt: 0, compilerVersion: proposal.compilerVersion,
    }
    expect(steps.find((step) => step.idempotencyKey === reflectionDispositionStepKey({
      ...reflectionKeyInput,
      stage: 'DECK_CONSISTENCY',
      candidateHash: hashInput({ deckPlan: proposal.deckPlan, visualContract: proposal.visualContract }),
    }))).toMatchObject({
      status: 'COMPLETED',
      output: {
        stage: 'DECK_CONSISTENCY', status: 'NO_ISSUES', reason: null,
        criticCallCount: 1, optimizerCallCount: 0, transportAttemptCount: 1,
      },
    })
    expect(steps.find((step) => step.idempotencyKey === reflectionDispositionStepKey({
      ...reflectionKeyInput,
      stage: 'SLIDE_BRIEFS',
      candidateHash: hashInput({ slideBriefs: proposal.slideBriefs }),
    }))).toMatchObject({
      status: 'COMPLETED',
      output: {
        stage: 'SLIDE_BRIEFS', status: 'NO_ISSUES', reason: null,
        criticCallCount: 1, optimizerCallCount: 0, transportAttemptCount: 1,
      },
    })
    expect(reflectionPayloads).toHaveLength(2)
    expect(reflectionPayloads[0]).toMatchObject({
      presentationSpec: proposal.presentationSpec,
      candidate: { deckPlan: proposal.deckPlan, visualContract: proposal.visualContract },
      sourceSummary: expect.any(String),
    })
    expect(reflectionPayloads[1]).toMatchObject({
      presentationSpec: proposal.presentationSpec,
      deckVisual: { deckPlan: proposal.deckPlan, visualContract: proposal.visualContract },
      candidate: { slideBriefs: proposal.slideBriefs },
      sourceSummary: expect.any(String),
    })
    expect(JSON.stringify(reflectionPayloads)).not.toContain('candidateArtifactHash')
    const events = await repository.listEvents(created.run.id)
    expect(events.filter((event) => event.type === 'tool.progress').map((event) =>
      event.type === 'tool.progress' ? event.payload.completed : null)).toEqual([1, 2, 3, 4, 5])
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
    expect(events.find((event) => event.type === 'planning.completed')).toMatchObject({
      payload: {
        completed: V4_PLANNING_STAGES.length, total: V4_PLANNING_STAGES.length,
        reason: null, requiresUserAction: false, nextAction: null,
      },
    })
    expect(events.some((event) => event.type === 'generation.started')).toBe(true)
  })

  test('deterministically restores source roles and the explicit presentation goal before reflection', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request({ presentationGoal: '让学生解释为什么百分数便于统一比较' })
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-source-binding-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    staged.model.execute = async (modelInput) => {
      const value = await execute(modelInput) as any
      if (modelInput.operation !== 'create_visual_deck_v4_source_spec') return value
      return {
        ...value,
        sourceUnderstanding: {
          ...value.sourceUnderstanding,
          sources: value.sourceUnderstanding.sources.map((source: any) => ({
            ...source,
            role: source.role === 'CONTENT_SOURCE' ? 'DESIGN_REFERENCE' : 'CONTENT_SOURCE',
          })),
        },
        presentationSpec: { ...value.presentationSpec, goal: '与用户明确目标无关的模型自拟目标' },
      }
    }
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })

    const result = await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      ...(inputRequest.presentationGoal ? { presentationGoal: inputRequest.presentationGoal } : {}),
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal).toMatchObject({
      presentationSpec: { goal: inputRequest.presentationGoal },
      sourceUnderstanding: {
        sources: [
          { sourceId: 'textbook', role: 'CONTENT_SOURCE' },
          { sourceId: 'design', role: 'DESIGN_REFERENCE' },
        ],
      },
    })
  })

  test('keeps a persisted chain-2 Run on its original reflection contract', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-chain-2-compatibility-0001')
    await repository.transact(created.run.id, (transaction) => {
      transaction.putRun({
        ...transaction.run,
        release: { ...transaction.run.release!, compilerVersion: CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION },
      })
    })
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    const calls: string[] = []
    staged.model.execute = async (modelInput) => {
      calls.push(modelInput.operation)
      if (modelInput.operation === 'reflect_and_revise_deck_visual') {
        const payload = modelInput.payload as { candidateArtifact: any; reviewContextHash: string }
        return {
          decision: 'UNCHANGED',
          checks: VISUAL_DECK_V4_REFLECTION_DIMENSIONS.map((dimension) => ({
            dimension, passed: true, evidence: `${dimension} 已通过。`,
          })),
          findings: [], baseArtifactHash: hashInput(payload.candidateArtifact),
          reviewContextHash: payload.reviewContextHash, appliedFindingIds: [],
          revisedArtifact: payload.candidateArtifact,
        }
      }
      if (modelInput.operation === 'reflect_and_revise_slide_briefs') {
        const payload = modelInput.payload as { candidateArtifact: any; reviewContextHash: string }
        return {
          decision: 'UNCHANGED',
          checks: VISUAL_DECK_V4_REFLECTION_DIMENSIONS.map((dimension) => ({
            dimension, passed: true, evidence: `${dimension} 已通过。`,
          })),
          findings: [], baseArtifactHash: hashInput(payload.candidateArtifact),
          reviewContextHash: payload.reviewContextHash, appliedFindingIds: [], revisedSlides: [],
        }
      }
      return execute(modelInput)
    }

    const result = await new PlanningRunner({
      repository, documents: documents(), model: staged.model, clock,
    }).plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal?.compilerVersion)
      .toBe(CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION)
    expect(calls).toContain('reflect_and_revise_deck_visual')
    expect(calls).toContain('reflect_and_revise_slide_briefs')
    expect(calls).not.toContain('critique_v4_deck_consistency')
    expect(calls).not.toContain('critique_v4_slide_briefs')
  })

  test('routes a historical V4 Run without release evidence through the chain-1 final coherence contract', async () => {
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const inputRequest = request()
    const seedRepository = new InMemoryAgentRepository()
    const created = await runService(seedRepository, clock)
      .create(inputRequest, 'create-v4-chain-1-missing-release-0001')
    const { release: _release, ...legacyRun } = created.run
    const repository = new InMemoryAgentRepository()
    await repository.createRun(legacyRun)
    const staged = stagedModel({ ...created, run: legacyRun }, inputRequest, clock)

    const result = await new PlanningRunner({
      repository, documents: documents(), model: staged.model, clock,
    }).plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal?.compilerVersion)
      .toBe(LEGACY_VISUAL_DECK_V4_COMPILER_VERSION)
    expect(staged.operations).toEqual([
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'create_visual_deck_v4_slide_briefs',
      'review_visual_deck_v4_coherence',
    ])
    expect(staged.operations).not.toContain('reflect_and_revise_deck_visual')
    expect(staged.operations).not.toContain('critique_v4_deck_consistency')
    const events = await repository.listEvents(created.run.id)
    expect(events.find((event) => event.type === 'planning.started'))
      .toMatchObject({ payload: { completed: 0, total: 4 } })
    expect(events.filter((event) => event.type === 'tool.progress').map((event) =>
      event.type === 'tool.progress' ? { completed: event.payload.completed, total: event.payload.total } : null))
      .toEqual([1, 2, 3, 4].map((completed) => ({ completed, total: 4 })))
    expect(events.find((event) => event.type === 'planning.completed'))
      .toMatchObject({ payload: { completed: 4, total: 4 } })
  })

  test('reports a failed historical chain-1 planning lifecycle against four stages', async () => {
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const inputRequest = request()
    const seedRepository = new InMemoryAgentRepository()
    const created = await runService(seedRepository, clock)
      .create(inputRequest, 'create-v4-chain-1-failed-lifecycle-0001')
    const { release: _release, ...legacyRun } = created.run
    const repository = new InMemoryAgentRepository()
    await repository.createRun(legacyRun)

    const result = await new PlanningRunner({
      repository,
      documents: {
        async resolve() {
          return { name: '历史教材.md', chunks: [], isComplete: false, missingRanges: ['正文缺失'] }
        },
      },
      model: { async execute() { throw new Error('MODEL_MUST_NOT_RUN_FOR_INCOMPLETE_SOURCE') } },
      clock,
    }).plan({
      runId: legacyRun.id, stepId: `step-${legacyRun.id}-plan`, idempotencyKey: planningStepKey(legacyRun.id),
      source: legacyRun.source, slideCount: legacyRun.slideCount, visualDirection: legacyRun.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint).toBeNull()
    const events = await repository.listEvents(legacyRun.id)
    expect(events.find((event) => event.type === 'planning.started'))
      .toMatchObject({ payload: { completed: 0, total: 4 } })
    expect(events.find((event) => event.type === 'planning.completed'))
      .toMatchObject({ payload: { completed: 0, total: 4, reason: 'PLANNING_FAILED' } })
  })

  test('infers chain-2 from a persisted legacy reflection marker when release metadata is missing', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-chain-2-marker-0001')
    await repository.transact(created.run.id, (transaction) => {
      const { release: _release, ...legacyRun } = transaction.run
      transaction.putRun(legacyRun)
      transaction.putStep({
        id: 'step-chain-2-marker', runId: created.run.id,
        idempotencyKey: `${created.run.id}:v4:reflect:deck-visual:historical`,
        inputHash: 'historical-chain-2-marker', tool: 'reflect_v4_deck_visual', status: 'COMPLETED',
        budgetUnits: 0, budgetReservationId: null, externalOperationId: null, errorCode: null,
        output: null, createdAt: clock.now().toISOString(), updatedAt: clock.now().toISOString(),
      })
    })
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    const calls: string[] = []
    staged.model.execute = async (modelInput) => {
      calls.push(modelInput.operation)
      if (modelInput.operation === 'reflect_and_revise_deck_visual') {
        const payload = modelInput.payload as { candidateArtifact: any; reviewContextHash: string }
        return {
          decision: 'UNCHANGED',
          checks: VISUAL_DECK_V4_REFLECTION_DIMENSIONS.map((dimension) => ({
            dimension, passed: true, evidence: `${dimension} 已通过。`,
          })),
          findings: [], baseArtifactHash: hashInput(payload.candidateArtifact),
          reviewContextHash: payload.reviewContextHash, appliedFindingIds: [],
          revisedArtifact: payload.candidateArtifact,
        }
      }
      if (modelInput.operation === 'reflect_and_revise_slide_briefs') {
        const payload = modelInput.payload as { candidateArtifact: any; reviewContextHash: string }
        return {
          decision: 'UNCHANGED',
          checks: VISUAL_DECK_V4_REFLECTION_DIMENSIONS.map((dimension) => ({
            dimension, passed: true, evidence: `${dimension} 已通过。`,
          })),
          findings: [], baseArtifactHash: hashInput(payload.candidateArtifact),
          reviewContextHash: payload.reviewContextHash, appliedFindingIds: [], revisedSlides: [],
        }
      }
      return execute(modelInput)
    }

    const result = await new PlanningRunner({
      repository, documents: documents(), model: staged.model, clock,
    }).plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal?.compilerVersion)
      .toBe(CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION)
    expect(calls).toContain('reflect_and_revise_deck_visual')
    expect(calls).not.toContain('review_visual_deck_v4_coherence')
    expect(calls).not.toContain('critique_v4_deck_consistency')
  })

  test('fails closed before model submission when historical compiler markers conflict', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-compiler-conflict-0001')
    await repository.transact(created.run.id, (transaction) => {
      const { release: _release, ...legacyRun } = transaction.run
      transaction.putRun(legacyRun)
      for (const marker of [
        { suffix: 'v4:final-coherence:planning:historical', tool: 'review_v4_final_coherence' },
        { suffix: 'v4:reflect:deck-visual:historical', tool: 'reflect_v4_deck_visual' },
      ]) {
        transaction.putStep({
          id: `step-${marker.tool}`, runId: created.run.id,
          idempotencyKey: `${created.run.id}:${marker.suffix}`,
          inputHash: marker.tool, tool: marker.tool, status: 'COMPLETED',
          budgetUnits: 0, budgetReservationId: null, externalOperationId: null, errorCode: null,
          output: null, createdAt: clock.now().toISOString(), updatedAt: clock.now().toISOString(),
        })
      }
    })
    const staged = stagedModel(created, inputRequest, clock)

    const result = await new PlanningRunner({
      repository, documents: documents(), model: staged.model, clock,
    }).plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint).toBeNull()
    expect(staged.operations).toEqual([])
    expect((await repository.listSteps(created.run.id)).find((step) =>
      step.idempotencyKey === planningStepKey(created.run.id))).toMatchObject({ status: 'FAILED' })
  })

  test('resumes only the failed Slide Briefs stage with its original idempotency key', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-planning-recovery-0001')
    const { model, operations } = stagedModel(created, inputRequest, clock, true)
    const runner = new PlanningRunner({ repository, documents: documents(), model, clock })
    const input = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    } as const

    const failed = await runner.plan(input)
    expect(failed.blueprint).toBeNull()
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'RECOVERING',
      technicalRecovery: { reason: 'V4_PLANNING_STAGE_FAILED', active: true, retryable: true },
    })
    const failedEvents = await repository.listEvents(created.run.id)
    expect(failedEvents.some((event) => event.type === 'approval.required')).toBe(false)
    expect(failedEvents.some((event) => event.type === 'run.failed')).toBe(false)
    const beforeRetry = await repository.listSteps(created.run.id)
    expect(beforeRetry.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(created.run.id, 'source-spec')))
      .toMatchObject({ status: 'COMPLETED' })
    expect(beforeRetry.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(created.run.id, 'slide-briefs')))
      .toMatchObject({ status: 'FAILED' })

    clock.advance(2_000)
    await repository.transact(created.run.id, (transaction) => resumeTechnicalRecovery(transaction, clock))
    expect(await repository.getRun(created.run.id)).toMatchObject({ status: 'PLANNING', planningAttempt: 0 })
    const resumed = await runner.plan(input)
    expect(resumed.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect((await repository.getRunEventSnapshot(created.run.id)).openIssues).toEqual([])
    expect(operations).toEqual([
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'critique_v4_deck_consistency',
      'create_visual_deck_v4_slide_briefs',
      'create_visual_deck_v4_slide_briefs',
      'critique_v4_slide_briefs',
    ])
  })

  test('keeps one planning lifecycle open while source resolution recovers', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-source-recovery-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const resolvedDocuments = documents()
    let sourceAttempts = 0
    const runner = new PlanningRunner({
      repository,
      documents: {
        async resolve(input) {
          sourceAttempts += 1
          if (sourceAttempts === 1) throw new Error('NETWORK_TIMEOUT')
          return resolvedDocuments.resolve(input)
        },
      },
      model: staged.model,
      clock,
    })
    const input = {
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    } as const

    expect(await runner.plan(input)).toMatchObject({
      blueprint: null, step: { tool: 'resolve_source', status: 'FAILED', errorCode: 'NETWORK_TIMEOUT' },
    })
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'RECOVERING', technicalRecovery: { attempt: 1, retryable: true },
    })
    expect((await repository.listEvents(created.run.id)).filter((event) =>
      event.type === 'planning.started' || event.type === 'planning.completed').map((event) => event.type))
      .toEqual(['planning.started'])

    clock.advance(60_000)
    await repository.transact(created.run.id, (transaction) => resumeTechnicalRecovery(transaction, clock))
    const resumed = await runner.plan(input)

    expect(resumed.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect(sourceAttempts).toBe(2)
    expect((await repository.listSteps(created.run.id)).filter((step) => step.tool === 'resolve_source'))
      .toEqual([expect.objectContaining({ status: 'COMPLETED', errorCode: null })])
    const lifecycle = (await repository.listEvents(created.run.id)).filter((event) =>
      event.type === 'planning.started' || event.type === 'planning.completed')
    expect(lifecycle.map((event) => event.type)).toEqual(['planning.started', 'planning.completed'])
    expect((await repository.listEvents(created.run.id)).some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('closes source resolution lifecycle once after the fifth recoverable failure', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-source-exhaustion-0001')
    let sourceAttempts = 0
    const runner = new PlanningRunner({
      repository,
      documents: { async resolve(): Promise<never> { sourceAttempts += 1; throw new Error('NETWORK_TIMEOUT') } },
      model: { async execute(): Promise<never> { throw new Error('MODEL_MUST_NOT_RUN') } },
      clock,
    })
    const input = {
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    } as const

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await runner.plan(input)).toMatchObject({
        blueprint: null, step: { tool: 'resolve_source', status: 'FAILED', errorCode: 'NETWORK_TIMEOUT' },
      })
      expect(await repository.getRun(created.run.id)).toMatchObject(attempt < 5
        ? { status: 'RECOVERING', technicalRecovery: { attempt, retryable: true } }
        : {
            status: 'FAILED', technicalRecovery: { attempt: 5, retryable: false, active: false },
            committedBudgetUnits: 0,
            terminalAccounting: { accountingStatus: 'FINAL', submittedUnits: 0, settledUnits: 0 },
          })
      if (attempt < 5) {
        clock.advance(60_000)
        await repository.transact(created.run.id, (transaction) => resumeTechnicalRecovery(transaction, clock))
      }
    }

    expect(sourceAttempts).toBe(5)
    const events = await repository.listEvents(created.run.id)
    expect(events.filter((event) => event.type === 'planning.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'planning.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'run.failed')).toHaveLength(1)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('closes source resolution lifecycle once on a non-retryable configuration failure', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-source-forbidden-0001')
    const runner = new PlanningRunner({
      repository,
      documents: { async resolve(): Promise<never> { throw new Error('MODEL_FORBIDDEN') } },
      model: { async execute(): Promise<never> { throw new Error('MODEL_MUST_NOT_RUN') } },
      clock,
    })
    const input = {
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    } as const

    expect(await runner.plan(input)).toMatchObject({
      blueprint: null, step: { tool: 'resolve_source', status: 'FAILED', errorCode: 'MODEL_FORBIDDEN' },
    })
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'FAILED', technicalRecovery: { attempt: 1, retryable: false, active: false },
      committedBudgetUnits: 0,
      terminalAccounting: { accountingStatus: 'FINAL', submittedUnits: 0, settledUnits: 0 },
    })
    const events = await repository.listEvents(created.run.id)
    expect(events.filter((event) => event.type === 'planning.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'planning.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'run.failed')).toHaveLength(1)
    expect(events.some((event) => event.type === 'approval.required')).toBe(false)
  })

  test('continues the same Run after an accepted invalid Slide Critic contract', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-reflection-contract-skip-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    let criticCalls = 0
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation === 'critique_v4_slide_briefs') {
        criticCalls += 1
        throw new StructuredModelError(
          'MODEL_JSON_INVALID', true, 'gpt-5.6-terra', 'request-slide-contract-invalid', 200, 'ACCEPTED',
          { layer: 'JSON_SCHEMA', safeIssues: [], responseHash: 'a'.repeat(64), byteLength: 20 },
        )
      }
      return execute(modelInput)
    }

    const result = await new PlanningRunner({
      repository, documents: documents(), model: staged.model, clock,
    }).plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect(await repository.getRun(created.run.id)).toMatchObject({
      id: created.run.id, status: 'EXECUTING', committedBudgetUnits: 0,
    })
    expect((await repository.getRun(created.run.id))?.technicalRecovery).toBeUndefined()
    expect(criticCalls).toBe(1)
    expect(staged.operations).not.toContain('optimize_v4_slide_briefs')
    const disposition = (await repository.listSteps(created.run.id)).find((step) =>
      step.tool === 'record_v4_slide_briefs_reflection')
    expect(disposition?.output).toMatchObject({
      status: 'REFLECTION_SKIPPED', reason: 'CONTRACT_INVALID', failureLayer: 'JSON_SCHEMA',
      criticCallCount: 1, optimizerCallCount: 0,
    })
  })

  test('reuses one Slide Critic key for one UNKNOWN recovery and never submits a third time', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-reflection-unknown-skip-0001')
    const staged = stagedModel(created, inputRequest, clock)
    const execute = staged.model.execute.bind(staged.model)
    const keys: string[] = []
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation === 'critique_v4_slide_briefs') {
        keys.push(modelInput.idempotencyKey)
        throw new StructuredModelError('PROVIDER_TIMEOUT', true, 'gpt-5.6-terra', null, null, 'UNKNOWN')
      }
      return execute(modelInput)
    }
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })
    const input = {
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    } as const

    const first = await runner.plan(input)
    const replay = await runner.plan(input)

    expect(first.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect(replay.replayed).toBe(true)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
    expect(await repository.getRun(created.run.id)).toMatchObject({ status: 'EXECUTING', committedBudgetUnits: 0 })
    expect((await repository.listSteps(created.run.id)).find((step) =>
      step.tool === 'record_v4_slide_briefs_reflection')?.output).toMatchObject({
        status: 'REFLECTION_SKIPPED', reason: 'PROVIDER_UNAVAILABLE', transportAttemptCount: 2,
      })
  })

  test('normalizes invisible Slide Brief references without an extra model repair', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-slide-brief-contract-repair-0001')
    const { model, operations, repairPayloads } = stagedModel(
      created, inputRequest, clock, false, 'INVISIBLE_REFERENCES',
    )
    const runner = new PlanningRunner({ repository, documents: documents(), model, clock })
    const input = {
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    } as const

    const result = await runner.plan(input)

    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs[4]?.numbers).toEqual([
      '72%', '20%', '0.35', '4/5', '48', '48%', '4',
    ])
    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs[4]?.formulas).toEqual(['0.35=（ ）%'])
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'EXECUTING', committedBudgetUnits: 0,
    })
    expect(operations).toEqual([
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'critique_v4_deck_consistency',
      'create_visual_deck_v4_slide_briefs',
      'critique_v4_slide_briefs',
    ])
    expect(repairPayloads).toEqual([])
    const steps = await repository.listSteps(created.run.id)
    expect(steps.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(
      created.run.id, 'slide-briefs', 0, 1,
    ))).toBeUndefined()
  })

  test('still repairs unrelated Slide Brief contract failures', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-slide-brief-source-repair-0001')
    const { model, operations, repairPayloads } = stagedModel(
      created, inputRequest, clock, false, 'INVALID_SOURCE_CHUNK',
    )
    const runner = new PlanningRunner({ repository, documents: documents(), model, clock })

    const result = await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs).toHaveLength(10)
    expect(operations).toEqual([
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'critique_v4_deck_consistency',
      'create_visual_deck_v4_slide_briefs',
      'create_visual_deck_v4_slide_briefs',
      'critique_v4_slide_briefs',
    ])
    expect(repairPayloads).toEqual([[
      { path: 'slideBriefs.1.sourceChunkIds', message: 'grounded v4 slides require valid source chunks' },
    ]])
    const steps = await repository.listSteps(created.run.id)
    expect(steps.find((step) => step.idempotencyKey === planningStageAuditKey(created.run.id, 'slide-briefs')))
      .toMatchObject({
        output: {
          attempts: [
            expect.objectContaining({ attempt: 1, outcome: 'SUCCEEDED' }),
            expect.objectContaining({ attempt: 2, outcome: 'SUCCEEDED' }),
          ],
        },
      })
    expect(steps.find((step) => step.idempotencyKey === `${visualDeckV4PlanningStageStepKey(
      created.run.id, 'slide-briefs', 0, 1,
    )}:attempt-audit`)).toBeUndefined()
  })

  test('does not grant a sixth provider submission to a Slide Brief contract repair', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-slide-brief-shared-budget-0001')
    const staged = stagedModel(created, inputRequest, clock, false, 'INVALID_SOURCE_CHUNK')
    const execute = staged.model.execute.bind(staged.model)
    let slideCalls = 0
    staged.model.execute = async (modelInput) => {
      if (modelInput.operation === 'create_visual_deck_v4_slide_briefs') {
        slideCalls += 1
        if (slideCalls < 5) {
          throw new StructuredModelError('PROVIDER_TIMEOUT', true, 'gpt-5.6-terra', `request-slide-${slideCalls}`)
        }
      }
      return execute(modelInput)
    }
    const input = {
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    } as const
    const runner = () => new PlanningRunner({
      repository, documents: documents(), model: staged.model, clock,
    })

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await runner().plan(input)).toMatchObject({ blueprint: null, step: { status: 'FAILED' } })
      clock.advance(60_000)
      await repository.transact(created.run.id, (transaction) => resumeTechnicalRecovery(transaction, clock))
    }
    expect(await runner().plan(input)).toMatchObject({
      blueprint: null, step: { status: 'FAILED', errorCode: 'BLUEPRINT_SCHEMA_INVALID' },
    })
    expect(slideCalls).toBe(5)
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'RECOVERING', technicalRecovery: { attempt: 1, reason: 'V4_PLANNING_STAGE_FAILED' },
    })
    expect((await repository.listSteps(created.run.id)).find((step) =>
      step.idempotencyKey === planningStageAuditKey(created.run.id, 'slide-briefs')))
      .toMatchObject({
        output: {
          attempts: [
            expect.objectContaining({ attempt: 1, outcome: 'FAILED' }),
            expect.objectContaining({ attempt: 2, outcome: 'FAILED' }),
            expect.objectContaining({ attempt: 3, outcome: 'FAILED' }),
            expect.objectContaining({ attempt: 4, outcome: 'FAILED' }),
            expect.objectContaining({ attempt: 5, outcome: 'SUCCEEDED' }),
          ],
        },
      })
    expect((await repository.listEvents(created.run.id)).some((event) => event.type === 'approval.required')).toBe(false)

    clock.advance(60_000)
    await repository.transact(created.run.id, (transaction) => resumeTechnicalRecovery(transaction, clock))
    expect(await runner().plan(input)).toMatchObject({ blueprint: null, step: { status: 'FAILED' } })
    expect(slideCalls).toBe(5)
  })

  test('restores an exact request focus after the model splits it into separate items', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const inputRequest = request()
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-split-focus-0001')
    const { model, operations } = stagedModel(created, inputRequest, clock, false, 'NONE', true)
    const runner = new PlanningRunner({ repository, documents: documents(), model, clock })

    const result = await runner.plan({
      runId: created.run.id,
      stepId: `step-${created.run.id}-plan`,
      idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source,
      slideCount: created.run.slideCount,
      visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode,
      visualDeckV4: inputRequest.visualDeckV4,
    })

    expect(result.blueprint?.visualDeckV4Proposal?.presentationSpec.focus[0])
      .toBe(inputRequest.visualDeckV4.deckOptions.focus)
    expect(operations).toEqual([
      'create_visual_deck_v4_source_spec',
      'create_visual_deck_v4_deck_visual',
      'critique_v4_deck_consistency',
      'create_visual_deck_v4_slide_briefs',
      'critique_v4_slide_briefs',
    ])
  })

  test('removes page 6 duplicate-count and page 12 numbering risks before prompt compilation', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-08-01T00:00:00.000Z'))
    const service = runService(repository, clock)
    const baseRequest = request()
    const inputRequest = {
      ...baseRequest,
      slideCount: 12,
      visualDeckV4: {
        ...baseRequest.visualDeckV4,
        deckOptions: { ...baseRequest.visualDeckV4.deckOptions, length: { slideCount: 12 } },
      },
    }
    const created = await createChain3Run(service, repository, inputRequest, 'create-v4-semantic-reflection-0001')
    const staged = stagedModel(created, inputRequest, clock, false, 'NONE', false, true)
    const runner = new PlanningRunner({ repository, documents: documents(), model: staged.model, clock })

    const result = await runner.plan({
      runId: created.run.id, stepId: `step-${created.run.id}-plan`, idempotencyKey: planningStepKey(created.run.id),
      source: created.run.source, slideCount: created.run.slideCount, visualDirection: created.run.visualDirection,
      presentationMode: inputRequest.presentationMode, visualDeckV4: inputRequest.visualDeckV4,
    })

    const steps = await repository.listSteps(created.run.id)
    const candidate = steps.find((step) => step.idempotencyKey === visualDeckV4PlanningStageStepKey(
      created.run.id, 'slide-briefs',
    ))?.output as { slideBriefs: any[] }
    const reflected = steps.find((step) => step.tool === 'v4_slide_briefs_optimizer')?.output as {
      artifact: { slideBriefs: any[] }
    }
    const optimizerPayload = staged.reflectionPayloads.find((payload) =>
      payload && typeof payload === 'object' && 'issues' in payload) as {
        issues: { issueId: string; pageNumber: number }[]
      }
    const finalBlueprint = result.blueprint!
    const beforeBlueprint = presentationBlueprintSchema.parse({
      ...finalBlueprint,
      visualDeckV4Proposal: { ...finalBlueprint.visualDeckV4Proposal!, slideBriefs: candidate.slideBriefs },
    })
    const beforeRequirements = blueprintImageRequirements({ id: created.run.id, revisionRound: 0 }, beforeBlueprint)
    const afterRequirements = blueprintImageRequirements({ id: created.run.id, revisionRound: 0 }, finalBlueprint)

    expect(candidate.slideBriefs[5].composition).toContain('底部再加入聚拢的圆片视觉提示')
    expect(candidate.slideBriefs[11].composition).toContain('3个素材场景')
    expect(optimizerPayload.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: expect.stringMatching(/^reflection-issue-/), pageNumber: 6 }),
      expect.objectContaining({ issueId: expect.stringMatching(/^reflection-issue-/), pageNumber: 12 }),
    ]))
    expect(hashInput(reflected.artifact.slideBriefs)).not.toBe(hashInput(candidate.slideBriefs))
    expect(reflected.artifact.slideBriefs[5].lockedCopy).toEqual(candidate.slideBriefs[5].lockedCopy)
    expect(reflected.artifact.slideBriefs[5].facts).toEqual(candidate.slideBriefs[5].facts)
    expect(reflected.artifact.slideBriefs[5].numbers).toEqual(candidate.slideBriefs[5].numbers)
    for (const pageNumber of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
      expect(reflected.artifact.slideBriefs[pageNumber - 1]).toEqual(candidate.slideBriefs[pageNumber - 1])
    }
    expect(beforeRequirements[5]?.prompt).toContain('底部再加入聚拢的圆片视觉提示')
    expect(afterRequirements[5]?.prompt).toContain('底部禁止出现任何圆片或圆片轮廓')
    expect(beforeRequirements[11]?.prompt).toContain('3个素材场景')
    expect(afterRequirements[11]?.prompt).toContain('禁止任何步骤编号或数字徽章')
    expect(afterRequirements[11]?.prompt).not.toContain('1、2、3')
    expect(afterRequirements[11]?.prompt).not.toContain('3个素材场景')
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { SqliteAgentRepository } from '../src/adapters/sqlite-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { CONTRACT_VERSION } from '../src/contracts'
import {
  StructuredModelError,
  type AgentRepository,
  type AgentTransaction,
  type StructuredModelPort,
} from '../src/core/ports'
import { RunService } from '../src/core/run-service'
import { V4ReflectionCoordinator } from '../src/core/v4-reflection/coordinator'
import { deckOptimizerResultSchema } from '../src/core/v4-reflection/contracts'
import { bindDeckCriticIssues } from '../src/core/v4-reflection/deck'
import {
  reflectionCriticStepKey,
  reflectionDispositionStepKey,
  reflectionOptimizerStepKey,
} from '../src/core/v4-reflection/records'
import { compileVisualDeckV4Proposal } from '../src/core/visual-deck-v4-planner'
import { hashInput } from '../src/core/hash'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function sqlitePath() {
  const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-v4-reflection-'))
  cleanupPaths.push(directory)
  return join(directory, 'agent.sqlite')
}

function fixture() {
  const source = {
    kind: 'TEXT' as const,
    name: '分与合教材.txt',
    text: '把五个圆片分成两个非空组，可以分成一和四，也可以分成二和三。',
  }
  const document = {
    name: source.name,
    chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
    isComplete: true,
    missingRanges: [] as string[],
  }
  const config = {
    instruction: '为一年级学生制作五以内数的分与合课堂演示',
    sourceMode: 'SOURCE_GROUNDED' as const,
    deckOptions: {
      deckType: 'DETAILED_DECK' as const,
      language: 'zh-CN',
      length: { slideCount: 3 },
      aspectRatio: '16:9' as const,
      audience: '小学一年级学生',
      focus: '五个圆片分成两个非空组',
      styleHint: '清晰活泼的课堂信息图',
    },
  }
  const proposal = compileVisualDeckV4Proposal({
    runId: 'run-reflection-fixture', inputHash: 'reflection-fixture', source, document, config,
    slideCount: 3, visualDirection: '清晰活泼的课堂信息图', compilerVersion: 'visual-deck-v4-chain-2',
    createdAt: '2026-08-03T00:00:00.000Z',
  })
  return { source, document, config, proposal }
}

async function setup(
  model: StructuredModelPort,
  repository: AgentRepository = new InMemoryAgentRepository(),
) {
  const clock = new FixedClock(new Date('2026-08-03T00:00:00.000Z'))
  const data = fixture()
  const created = await new RunService({ repository, clock }).create({
    schemaVersion: CONTRACT_VERSION,
    host: { tenantId: 'frameflow', externalUserId: 'reflection-user' },
    source: data.source,
    slideCount: 3,
    visualDirection: '清晰活泼的课堂信息图',
    imageModel: 'gpt-image-2',
    automationLevel: 'SUPERVISED',
    budgetUnits: 3,
    presentationMode: 'VISUAL_DECK_V4',
    visualDeckV4: data.config,
  }, `create-${Math.random()}`)
  const coordinator = new V4ReflectionCoordinator({ repository, model, clock })
  const common = {
    runId: created.run.id,
    tenantId: created.run.host.tenantId,
    planningAttempt: 0,
    compilerVersion: 'visual-deck-v4-chain-3',
    protocol: 'RESPONSES_JSON_SCHEMA' as const,
    sourceSummary: data.source.text,
  }
  return { repository, clock, coordinator, common, ...data }
}

function emptyDeckOptimizer() {
  return {
    titleChanges: [], narrativeArcChanges: [], artDirectionChanges: [], paletteChanges: [],
    typographyChanges: [], mediumChanges: [], visualDensityChanges: [], compositionRuleChanges: [],
    continuityRuleChanges: [], forbiddenChanges: [],
  }
}

function emptySlideOptimizer() {
  return {
    roleChanges: [], visualMetaphorChanges: [], compositionChanges: [], informationHierarchyChanges: [],
    previousSlideRelationChanges: [], nextSlideRelationChanges: [],
  }
}

function callInputHash(operation: string, schemaName: string, payload: unknown) {
  return hashInput({ input: payload, operation, schemaName })
}

function persistedCallStep(input: Readonly<{
  runId: string
  key: string
  inputHash: string
  tool: string
  stage: 'DECK_CONSISTENCY'
  phase: 'CRITIC' | 'OPTIMIZER'
  candidateHash: string
  status: 'RUNNING' | 'COMPLETED'
  attempts: number
  result?: unknown
}>) {
  return {
    id: `step-${hashInput(input.key).slice(0, 28)}`,
    runId: input.runId,
    idempotencyKey: input.key,
    inputHash: input.inputHash,
    tool: input.tool,
    status: input.status,
    budgetUnits: 0,
    budgetReservationId: null,
    externalOperationId: null,
    errorCode: null,
    output: {
      schemaVersion: '1', stage: input.stage, phase: input.phase, candidateHash: input.candidateHash,
      businessCallCount: 1, transportAttemptCount: input.attempts,
      submissionState: input.status === 'COMPLETED' ? 'ACCEPTED' : 'UNKNOWN',
      ...(input.result === undefined ? {} : { result: input.result }),
    },
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  } as const
}

describe('V4 chain-3 reflection coordinator', () => {
  test('fails a Deck slide-count mismatch before any quality reflection call', async () => {
    let calls = 0
    const context = await setup({ async execute() { calls += 1; return { issues: [] } } })
    const candidate = {
      deckPlan: { ...context.proposal.deckPlan, slideCount: 4 },
      visualContract: context.proposal.visualContract,
    }

    await expect(context.coordinator.enhanceDeck({
      ...context.common,
      presentationSpec: context.proposal.presentationSpec,
      candidate,
    })).rejects.toMatchObject({ message: 'DECK_SLIDE_COUNT_MISMATCH' })
    expect(calls).toBe(0)
  })

  test('runs one Deck Critic and no Optimizer when there are no issues', async () => {
    const calls: Parameters<StructuredModelPort['execute']>[0][] = []
    const context = await setup({ async execute(input) { calls.push(input); return { issues: [] } } })
    const candidate = { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract }

    const result = await context.coordinator.enhanceDeck({
      ...context.common,
      presentationSpec: context.proposal.presentationSpec,
      candidate,
    })

    expect(result.artifact).toEqual(candidate)
    expect(result.disposition).toMatchObject({
      stage: 'DECK_CONSISTENCY', status: 'NO_ISSUES', reason: null,
      criticCallCount: 1, optimizerCallCount: 0, transportAttemptCount: 1,
    })
    expect(calls.map((call) => call.operation)).toEqual(['critique_v4_deck_consistency'])
  })

  test('runs one Deck Optimizer only when the Critic reports an issue', async () => {
    const calls: Parameters<StructuredModelPort['execute']>[0][] = []
    let issueId = ''
    const context = await setup({
      async execute(input) {
        calls.push(input)
        if (input.operation === 'critique_v4_deck_consistency') {
          return { issues: [{
            pageNumbers: [1, 2, 3], category: 'CROSS_SLIDE_REPETITION',
            field: 'deckPlan.narrativeArc', problem: '叙事重复', desiredChange: '按概念、对比、应用推进',
          }] }
        }
        issueId = (input.payload as { issues: { issueId: string }[] }).issues[0]!.issueId
        return {
          ...emptyDeckOptimizer(),
          narrativeArcChanges: [{ issueIds: [issueId], value: ['情境', '解释', '应用'] }],
        }
      },
    })
    const candidate = { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract }

    const result = await context.coordinator.enhanceDeck({
      ...context.common,
      presentationSpec: context.proposal.presentationSpec,
      candidate,
    })

    expect(issueId).toMatch(/^reflection-issue-[a-f0-9]{24}$/)
    expect(result.artifact.deckPlan.narrativeArc).toEqual(['情境', '解释', '应用'])
    expect(result.disposition).toMatchObject({
      status: 'APPLIED', reason: null, criticCallCount: 1, optimizerCallCount: 1,
      transportAttemptCount: 2, issueCount: 1, patchCount: 1,
    })
    expect(calls.map((call) => call.operation)).toEqual([
      'critique_v4_deck_consistency', 'optimize_v4_deck_consistency',
    ])
  })

  test('skips an invalid Critic contract and preserves the original Deck', async () => {
    const calls: Parameters<StructuredModelPort['execute']>[0][] = []
    const context = await setup({
      async execute(input) {
        calls.push(input)
        throw new StructuredModelError(
          'MODEL_JSON_INVALID', true, 'gpt-5.6-terra', 'request-invalid', 200, 'ACCEPTED',
          { layer: 'JSON_SCHEMA', safeIssues: [], responseHash: 'a'.repeat(64), byteLength: 20 },
        )
      },
    })
    const candidate = { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract }

    const result = await context.coordinator.enhanceDeck({
      ...context.common,
      presentationSpec: context.proposal.presentationSpec,
      candidate,
    })

    expect(result.artifact).toEqual(candidate)
    expect(result.disposition).toMatchObject({
      status: 'REFLECTION_SKIPPED', reason: 'CONTRACT_INVALID',
      failureLayer: 'JSON_SCHEMA', criticCallCount: 1, optimizerCallCount: 0,
    })
    expect(calls).toHaveLength(1)
    expect((await context.repository.listSteps(context.common.runId)).find((step) =>
      step.tool === 'v4_deck_consistency_critic')?.output).toMatchObject({ submissionState: 'ACCEPTED' })
  })

  test('recovers one UNKNOWN transport with the same Critic key and never submits a third time', async () => {
    const keys: string[] = []
    const context = await setup({
      async execute(input) {
        keys.push(input.idempotencyKey)
        throw new StructuredModelError('PROVIDER_TIMEOUT', true, 'gpt-5.6-terra', null, null, 'UNKNOWN')
      },
    })
    const candidate = { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract }
    const input = { ...context.common, presentationSpec: context.proposal.presentationSpec, candidate }

    const first = await context.coordinator.enhanceDeck(input)
    const replay = await context.coordinator.enhanceDeck(input)

    expect(first.artifact).toEqual(candidate)
    expect(replay).toEqual(first)
    expect(first.disposition).toMatchObject({
      status: 'REFLECTION_SKIPPED', reason: 'PROVIDER_UNAVAILABLE',
      criticCallCount: 1, optimizerCallCount: 0, transportAttemptCount: 2,
    })
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
    expect((await context.repository.listSteps(context.common.runId)).find((step) =>
      step.tool === 'v4_deck_consistency_critic')?.output).toMatchObject({ submissionState: 'UNKNOWN' })
    const dispositionKey = reflectionDispositionStepKey({
      ...context.common, stage: 'DECK_CONSISTENCY', candidateHash: first.disposition.candidateHash,
    })
    expect((await context.repository.listSteps(context.common.runId)).find((step) =>
      step.idempotencyKey === dispositionKey)).toMatchObject({ status: 'COMPLETED' })
  })

  test('resumes from a persisted Critic result without calling the Critic again', async () => {
    const calls: Parameters<StructuredModelPort['execute']>[0][] = []
    const context = await setup({
      async execute(input) {
        calls.push(input)
        const issueId = (input.payload as { issues: { issueId: string }[] }).issues[0]!.issueId
        return {
          ...emptyDeckOptimizer(),
          narrativeArcChanges: [{ issueIds: [issueId], value: ['情境', '解释', '应用'] }],
        }
      },
    })
    const candidate = { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract }
    const candidateHash = hashInput(candidate)
    const keyInput = { ...context.common, stage: 'DECK_CONSISTENCY' as const, candidateHash }
    const criticPayload = {
      presentationSpec: context.proposal.presentationSpec,
      candidate,
      sourceSummary: context.common.sourceSummary,
    }
    const criticResult = { issues: [{
      pageNumbers: [1, 2, 3], category: 'CROSS_SLIDE_REPETITION' as const,
      field: 'deckPlan.narrativeArc' as const, problem: '叙事重复', desiredChange: '按概念、对比、应用推进',
    }] }
    const criticKey = reflectionCriticStepKey(keyInput)
    await context.repository.transact(context.common.runId, (transaction) => {
      transaction.putStep(persistedCallStep({
        runId: context.common.runId, key: criticKey,
        inputHash: callInputHash(
          'critique_v4_deck_consistency', 'ppt_agent_v4_deck_consistency_critic_v1', criticPayload,
        ),
        tool: 'v4_deck_consistency_critic', stage: 'DECK_CONSISTENCY', phase: 'CRITIC',
        candidateHash, status: 'COMPLETED', attempts: 1, result: criticResult,
      }))
    })

    const result = await context.coordinator.enhanceDeck({
      ...context.common, presentationSpec: context.proposal.presentationSpec, candidate,
    })

    expect(result.disposition.status).toBe('APPLIED')
    expect(calls.map((call) => call.operation)).toEqual(['optimize_v4_deck_consistency'])
  })

  test('writes a deterministic skip when an UNKNOWN Critic exhausted before disposition persistence', async () => {
    let calls = 0
    const context = await setup({ async execute() { calls += 1; return { issues: [] } } })
    const candidate = { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract }
    const candidateHash = hashInput(candidate)
    const keyInput = { ...context.common, stage: 'DECK_CONSISTENCY' as const, candidateHash }
    const payload = {
      presentationSpec: context.proposal.presentationSpec,
      candidate,
      sourceSummary: context.common.sourceSummary,
    }
    const criticKey = reflectionCriticStepKey(keyInput)
    await context.repository.transact(context.common.runId, (transaction) => {
      transaction.putStep(persistedCallStep({
        runId: context.common.runId, key: criticKey,
        inputHash: callInputHash(
          'critique_v4_deck_consistency', 'ppt_agent_v4_deck_consistency_critic_v1', payload,
        ),
        tool: 'v4_deck_consistency_critic', stage: 'DECK_CONSISTENCY', phase: 'CRITIC',
        candidateHash, status: 'RUNNING', attempts: 2,
      }))
    })

    const result = await context.coordinator.enhanceDeck({
      ...context.common, presentationSpec: context.proposal.presentationSpec, candidate,
    })

    expect(calls).toBe(0)
    expect(result.disposition).toMatchObject({
      status: 'REFLECTION_SKIPPED', reason: 'PROVIDER_UNAVAILABLE', transportAttemptCount: 2,
    })
  })

  test('recovers an in-flight Optimizer with its original key and one remaining transport attempt', async () => {
    const submittedKeys: string[] = []
    const context = await setup({
      async execute(input) {
        submittedKeys.push(input.idempotencyKey)
        const issueId = (input.payload as { issues: { issueId: string }[] }).issues[0]!.issueId
        return {
          ...emptyDeckOptimizer(),
          narrativeArcChanges: [{ issueIds: [issueId], value: ['情境', '解释', '应用'] }],
        }
      },
    })
    const candidate = { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract }
    const candidateHash = hashInput(candidate)
    const keyInput = { ...context.common, stage: 'DECK_CONSISTENCY' as const, candidateHash }
    const criticPayload = {
      presentationSpec: context.proposal.presentationSpec,
      candidate,
      sourceSummary: context.common.sourceSummary,
    }
    const criticResult = { issues: [{
      pageNumbers: [1, 2, 3], category: 'CROSS_SLIDE_REPETITION' as const,
      field: 'deckPlan.narrativeArc' as const, problem: '叙事重复', desiredChange: '按概念、对比、应用推进',
    }] }
    const issues = bindDeckCriticIssues({ candidate, result: criticResult })
    const criticKey = reflectionCriticStepKey(keyInput)
    const optimizerKey = reflectionOptimizerStepKey({ ...keyInput, issueHash: hashInput(issues) })
    await context.repository.transact(context.common.runId, (transaction) => {
      transaction.putStep(persistedCallStep({
        runId: context.common.runId, key: criticKey,
        inputHash: callInputHash(
          'critique_v4_deck_consistency', 'ppt_agent_v4_deck_consistency_critic_v1', criticPayload,
        ),
        tool: 'v4_deck_consistency_critic', stage: 'DECK_CONSISTENCY', phase: 'CRITIC',
        candidateHash, status: 'COMPLETED', attempts: 1, result: criticResult,
      }))
      transaction.putStep(persistedCallStep({
        runId: context.common.runId, key: optimizerKey,
        inputHash: callInputHash(
          'optimize_v4_deck_consistency', 'ppt_agent_v4_deck_consistency_optimizer_v1',
          { candidate, issues },
        ),
        tool: 'v4_deck_consistency_optimizer', stage: 'DECK_CONSISTENCY', phase: 'OPTIMIZER',
        candidateHash, status: 'RUNNING', attempts: 1,
      }))
    })

    const result = await context.coordinator.enhanceDeck({
      ...context.common, presentationSpec: context.proposal.presentationSpec, candidate,
    })

    expect(result.disposition).toMatchObject({ status: 'APPLIED', transportAttemptCount: 3 })
    expect(submittedKeys).toEqual([optimizerKey])
    expect((await context.repository.listSteps(context.common.runId)).filter((step) =>
      step.tool === 'v4_deck_consistency_optimizer')).toHaveLength(1)
  })

  test('discards an invalid Slide Optimizer patch and keeps all original briefs', async () => {
    const calls: Parameters<StructuredModelPort['execute']>[0][] = []
    const context = await setup({
      async execute(input) {
        calls.push(input)
        if (input.operation === 'critique_v4_slide_briefs') {
          return { issues: [{
            pageNumber: 2, category: 'COUNTABILITY_RISK', field: 'composition',
            problem: '可能形成第三组圆片', desiredChange: '只保留两个组',
          }] }
        }
        return emptySlideOptimizer()
      },
    })
    const candidate = { slideBriefs: context.proposal.slideBriefs }

    const result = await context.coordinator.enhanceSlides({
      ...context.common,
      sourceSpec: {
        sourceUnderstanding: context.proposal.sourceUnderstanding,
        presentationSpec: context.proposal.presentationSpec,
      },
      deckVisual: { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract },
      candidate,
    })

    expect(result.artifact).toEqual(candidate)
    expect(result.disposition).toMatchObject({
      stage: 'SLIDE_BRIEFS', status: 'REFLECTION_SKIPPED', reason: 'PATCH_REJECTED',
      criticCallCount: 1, optimizerCallCount: 1, issueCount: 1,
    })
    expect(calls.map((call) => call.operation)).toEqual([
      'critique_v4_slide_briefs', 'optimize_v4_slide_briefs',
    ])
    expect((await context.repository.listSteps(context.common.runId)).find((step) =>
      step.tool === 'v4_slide_briefs_critic')?.output).toMatchObject({
        result: { issues: [expect.objectContaining({ pageNumber: 2, field: 'composition' })] },
      })
  })

  test('groups multiple Slide Critic issues for one page field into one Optimizer patch', async () => {
    const calls: Parameters<StructuredModelPort['execute']>[0][] = []
    const context = await setup({
      async execute(input) {
        calls.push(input)
        if (input.operation === 'critique_v4_slide_briefs') {
          return {
            issues: [
              {
                pageNumber: 2, category: 'COUNTABILITY_RISK', field: 'composition',
                problem: '第三组圆片会破坏精确计数', desiredChange: '只保留两个权威分组',
              },
              {
                pageNumber: 2, category: 'COMPOSITION_AMBIGUITY', field: 'composition',
                problem: '底部装饰与第二组边界混淆', desiredChange: '删除底部装饰并拉开两组间距',
              },
            ],
          }
        }
        const issues = (input.payload as { issues: { issueId: string }[] }).issues
        return {
          ...emptySlideOptimizer(),
          compositionChanges: [{
            issueIds: issues.map((issue) => issue.issueId),
            pageNumber: 2,
            value: '只保留两个边界清晰的圆片分组，删除底部装饰并拉开组间距',
          }],
        }
      },
    })
    const candidate = { slideBriefs: context.proposal.slideBriefs }

    const result = await context.coordinator.enhanceSlides({
      ...context.common,
      sourceSpec: {
        sourceUnderstanding: context.proposal.sourceUnderstanding,
        presentationSpec: context.proposal.presentationSpec,
      },
      deckVisual: { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract },
      candidate,
    })

    expect(result.disposition).toMatchObject({
      status: 'APPLIED', criticCallCount: 1, optimizerCallCount: 1, issueCount: 2, patchCount: 1,
    })
    expect(result.artifact.slideBriefs[1]?.composition)
      .toBe('只保留两个边界清晰的圆片分组，删除底部装饰并拉开组间距')
    expect(calls.map((call) => call.operation)).toEqual([
      'critique_v4_slide_briefs', 'optimize_v4_slide_briefs',
    ])
  })

  test('rejects multiple Deck Optimizer entries for the same authorized field at the strict schema boundary', () => {
    const duplicate = {
      ...emptyDeckOptimizer(),
      narrativeArcChanges: [
        { issueIds: ['issue-1'], value: ['情境', '解释', '应用'] },
        { issueIds: ['issue-2'], value: ['提出问题', '比较', '总结'] },
      ],
    }

    expect(deckOptimizerResultSchema.safeParse(duplicate).success).toBe(false)
  })

  test('reopens SQLite after a persisted Critic and resumes only the original Optimizer step', async () => {
    const filename = await sqlitePath()
    const first = new SqliteAgentRepository(filename)
    const calls: Parameters<StructuredModelPort['execute']>[0][] = []
    const model: StructuredModelPort = {
      async execute(input) {
        calls.push(input)
        const issueId = (input.payload as { issues: { issueId: string }[] }).issues[0]!.issueId
        return {
          ...emptyDeckOptimizer(),
          narrativeArcChanges: [{ issueIds: [issueId], value: ['情境', '解释', '应用'] }],
        }
      },
    }
    const context = await setup(model, first)
    const candidate = { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract }
    const candidateHash = hashInput(candidate)
    const keyInput = { ...context.common, stage: 'DECK_CONSISTENCY' as const, candidateHash }
    const criticPayload = {
      presentationSpec: context.proposal.presentationSpec,
      candidate,
      sourceSummary: context.common.sourceSummary,
    }
    const criticResult = { issues: [{
      pageNumbers: [1, 2, 3], category: 'CROSS_SLIDE_REPETITION' as const,
      field: 'deckPlan.narrativeArc' as const, problem: '叙事重复', desiredChange: '按概念、对比、应用推进',
    }] }
    const criticKey = reflectionCriticStepKey(keyInput)
    await first.transact(context.common.runId, (transaction) => {
      transaction.putStep(persistedCallStep({
        runId: context.common.runId, key: criticKey,
        inputHash: callInputHash(
          'critique_v4_deck_consistency', 'ppt_agent_v4_deck_consistency_critic_v1', criticPayload,
        ),
        tool: 'v4_deck_consistency_critic', stage: 'DECK_CONSISTENCY', phase: 'CRITIC',
        candidateHash, status: 'COMPLETED', attempts: 1, result: criticResult,
      }))
    })
    first.close()

    const reopened = new SqliteAgentRepository(filename)
    const result = await new V4ReflectionCoordinator({
      repository: reopened, model, clock: context.clock,
    }).enhanceDeck({
      ...context.common, presentationSpec: context.proposal.presentationSpec, candidate,
    })

    expect(result.disposition.status).toBe('APPLIED')
    expect(calls.map((call) => call.operation)).toEqual(['optimize_v4_deck_consistency'])
    expect((await reopened.listSteps(context.common.runId)).filter((step) =>
      step.tool === 'v4_deck_consistency_critic')).toHaveLength(1)
    expect((await reopened.listSteps(context.common.runId)).filter((step) =>
      step.tool === 'v4_deck_consistency_optimizer')).toHaveLength(1)
    reopened.close()
  })

  test('rolls back a crashed Optimizer disposition transaction and reuses the same key after SQLite reopen', async () => {
    const filename = await sqlitePath()
    const sqlite = new SqliteAgentRepository(filename)
    const calls: Parameters<StructuredModelPort['execute']>[0][] = []
    const model: StructuredModelPort = {
      async execute(input) {
        calls.push(input)
        if (input.operation === 'critique_v4_deck_consistency') {
          return { issues: [{
            pageNumbers: [1, 2, 3], category: 'CROSS_SLIDE_REPETITION',
            field: 'deckPlan.narrativeArc', problem: '叙事重复', desiredChange: '按概念、对比、应用推进',
          }] }
        }
        const issueId = (input.payload as { issues: { issueId: string }[] }).issues[0]!.issueId
        return {
          ...emptyDeckOptimizer(),
          narrativeArcChanges: [{ issueIds: [issueId], value: ['情境', '解释', '应用'] }],
        }
      },
    }
    let injectCrash = true
    const crashingRepository = new Proxy(sqlite, {
      get(target, property) {
        if (property === 'transact') {
          return <T>(runId: string, operation: (transaction: AgentTransaction) => T) => target.transact(
            runId,
            (transaction) => {
              const result = operation(transaction)
              const hasFinalDisposition = transaction.listSteps().some((step) =>
                step.tool === 'record_v4_deck_consistency_reflection' && step.status === 'COMPLETED')
              if (injectCrash && hasFinalDisposition) {
                injectCrash = false
                throw new Error('INJECTED_REFLECTION_COMMIT_CRASH')
              }
              return result
            },
          )
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as AgentRepository
    const context = await setup(model, crashingRepository)
    const candidate = { deckPlan: context.proposal.deckPlan, visualContract: context.proposal.visualContract }
    const input = { ...context.common, presentationSpec: context.proposal.presentationSpec, candidate }

    await expect(context.coordinator.enhanceDeck(input)).rejects.toThrow('INJECTED_REFLECTION_COMMIT_CRASH')
    const afterCrash = await sqlite.listSteps(context.common.runId)
    expect(afterCrash.find((step) => step.tool === 'v4_deck_consistency_critic')).toMatchObject({ status: 'COMPLETED' })
    expect(afterCrash.find((step) => step.tool === 'v4_deck_consistency_optimizer')).toMatchObject({ status: 'RUNNING' })
    expect(afterCrash.some((step) => step.tool === 'record_v4_deck_consistency_reflection')).toBe(false)
    sqlite.close()

    const reopened = new SqliteAgentRepository(filename)
    const recovered = await new V4ReflectionCoordinator({
      repository: reopened, model, clock: context.clock,
    }).enhanceDeck(input)
    const optimizerCalls = calls.filter((call) => call.operation === 'optimize_v4_deck_consistency')
    expect(recovered.disposition.status).toBe('APPLIED')
    expect(optimizerCalls).toHaveLength(2)
    expect(new Set(optimizerCalls.map((call) => call.idempotencyKey)).size).toBe(1)
    expect((await reopened.listSteps(context.common.runId)).filter((step) =>
      step.tool === 'v4_deck_consistency_optimizer')).toHaveLength(1)
    reopened.close()

    const replayRepository = new SqliteAgentRepository(filename)
    const replay = await new V4ReflectionCoordinator({
      repository: replayRepository,
      model: { async execute() { throw new Error('MODEL_MUST_NOT_RUN_AFTER_DISPOSITION') } },
      clock: context.clock,
    }).enhanceDeck(input)
    expect(replay).toEqual(recovered)
    replayRepository.close()
  })
})

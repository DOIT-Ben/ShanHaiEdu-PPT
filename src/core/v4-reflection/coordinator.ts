import { z } from 'zod'
import { VISUAL_DECK_V4_COMPILER_VERSION } from '../../release-identity'
import type {
  VisualDeckV4DeckVisualStage,
  VisualDeckV4SlideBriefsStage,
  VisualDeckV4SourceSpecStage,
} from '../../visual-deck-v4-contracts'
import { hashInput } from '../hash'
import {
  StructuredModelError,
  type AgentRepository,
  type ClockPort,
  type StepRecord,
  type StructuredGenerationProtocol,
  type StructuredModelPort,
  type StructuredSubmissionState,
} from '../ports'
import {
  deckCriticResultSchema,
  deckOptimizerResultSchema,
  slideCriticResultSchema,
  slideOptimizerResultSchema,
} from './contracts'
import { applyDeckOptimizerResult, bindDeckCriticIssues } from './deck'
import { ReflectionContractError } from './diagnostics'
import {
  reflectionCriticStepKey,
  reflectionDispositionSchema,
  reflectionDispositionStepKey,
  reflectionOptimizerStepKey,
  type ReflectionDisposition,
  type ReflectionFailureLayer,
  type ReflectionStage,
} from './records'
import { applySlideOptimizerResult, bindSlideCriticIssues } from './slides'

const CONTRACTS = {
  DECK_CONSISTENCY: {
    criticOperation: 'critique_v4_deck_consistency',
    criticSchema: 'ppt_agent_v4_deck_consistency_critic_v1',
    optimizerOperation: 'optimize_v4_deck_consistency',
    optimizerSchema: 'ppt_agent_v4_deck_consistency_optimizer_v1',
  },
  SLIDE_BRIEFS: {
    criticOperation: 'critique_v4_slide_briefs',
    criticSchema: 'ppt_agent_v4_slide_brief_critic_v1',
    optimizerOperation: 'optimize_v4_slide_briefs',
    optimizerSchema: 'ppt_agent_v4_slide_brief_optimizer_v1',
  },
} as const

type CommonInput = Readonly<{
  runId: string
  tenantId: string
  planningAttempt: number
  compilerVersion: string
  protocol: StructuredGenerationProtocol | undefined
  modelOverride?: string
  sourceSummary: string
}>

type ModelCallFailure = Readonly<{
  layer: ReflectionFailureLayer
  fingerprint: string
  transportAttemptCount: number
  submissionState: StructuredSubmissionState
}>

type ModelCallResult<T> =
  | Readonly<{ ok: true; value: T; key: string; transportAttemptCount: number; step: StepRecord }>
  | Readonly<{ ok: false; failure: ModelCallFailure; key: string; step: StepRecord }>

export class V4ReflectionCoordinator {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    model: StructuredModelPort
    clock: ClockPort
  }>) {}

  async enhanceDeck(input: CommonInput & Readonly<{
    presentationSpec: VisualDeckV4SourceSpecStage['presentationSpec']
    candidate: VisualDeckV4DeckVisualStage
  }>) {
    const stage = 'DECK_CONSISTENCY' as const
    const candidateHash = hashInput(input.candidate)
    const replay = await this.replayDisposition(input, stage, candidateHash, input.candidate)
    if (replay) return replay
    if (input.candidate.deckPlan.slideCount !== input.presentationSpec.slideCount) {
      throw new ReflectionContractError('ZOD_SEMANTIC', 'DECK_SLIDE_COUNT_MISMATCH', ['deckPlan', 'slideCount'])
    }
    const criticPayload = {
      presentationSpec: input.presentationSpec,
      candidate: input.candidate,
      sourceSummary: input.sourceSummary,
    }
    const critic = await this.callModel({
      ...input, stage, candidateHash, phase: 'CRITIC', payload: criticPayload,
      operation: CONTRACTS[stage].criticOperation, schemaName: CONTRACTS[stage].criticSchema,
      schema: deckCriticResultSchema,
    })
    if (!critic.ok) {
      return this.skip(input, stage, candidateHash, input.candidate, critic, null,
        this.criticReason(critic.failure.layer), 0)
    }

    let issues
    try {
      issues = bindDeckCriticIssues({
        candidate: input.candidate,
        result: critic.value,
        expectedSlideCount: input.presentationSpec.slideCount,
      })
    } catch (error) {
      return this.rejectCritic(input, stage, candidateHash, input.candidate, critic, error)
    }
    if (issues.length === 0) {
      return this.finish(input, stage, candidateHash, input.candidate, critic, null, {
        status: 'NO_ISSUES', reason: null, issueCount: 0, patchCount: 0, failureLayer: null, errorFingerprint: null,
      })
    }
    await this.completeCall(critic, critic.value)

    const issueHash = hashInput(issues)
    const optimizer = await this.callModel({
      ...input, stage, candidateHash, phase: 'OPTIMIZER', issueHash,
      payload: { candidate: input.candidate, issues },
      operation: CONTRACTS[stage].optimizerOperation, schemaName: CONTRACTS[stage].optimizerSchema,
      schema: deckOptimizerResultSchema,
    })
    if (!optimizer.ok) {
      return this.skip(input, stage, candidateHash, input.candidate, critic, optimizer, 'PATCH_REJECTED', issues.length)
    }
    try {
      const artifact = applyDeckOptimizerResult({
        candidate: input.candidate,
        expectedSlideCount: input.presentationSpec.slideCount,
        issues,
        result: optimizer.value,
      })
      return this.finish(input, stage, candidateHash, artifact, critic, optimizer, {
        status: 'APPLIED', reason: null, issueCount: issues.length,
        patchCount: patchCount(optimizer.value), failureLayer: null, errorFingerprint: null,
      })
    } catch (error) {
      return this.rejectOptimizer(input, stage, candidateHash, input.candidate, critic, optimizer, issues.length, error)
    }
  }

  async enhanceSlides(input: CommonInput & Readonly<{
    sourceSpec: VisualDeckV4SourceSpecStage
    deckVisual: VisualDeckV4DeckVisualStage
    candidate: VisualDeckV4SlideBriefsStage
  }>) {
    const stage = 'SLIDE_BRIEFS' as const
    const candidateHash = hashInput(input.candidate)
    const replay = await this.replayDisposition(input, stage, candidateHash, input.candidate)
    if (replay) return replay
    const critic = await this.callModel({
      ...input, stage, candidateHash, phase: 'CRITIC',
      payload: {
        presentationSpec: input.sourceSpec.presentationSpec,
        deckVisual: input.deckVisual,
        candidate: input.candidate,
        sourceSummary: input.sourceSummary,
      },
      operation: CONTRACTS[stage].criticOperation, schemaName: CONTRACTS[stage].criticSchema,
      schema: slideCriticResultSchema,
    })
    if (!critic.ok) {
      return this.skip(input, stage, candidateHash, input.candidate, critic, null,
        this.criticReason(critic.failure.layer), 0)
    }
    let issues
    try {
      issues = bindSlideCriticIssues({ candidate: input.candidate, result: critic.value })
    } catch (error) {
      return this.rejectCritic(input, stage, candidateHash, input.candidate, critic, error)
    }
    if (issues.length === 0) {
      return this.finish(input, stage, candidateHash, input.candidate, critic, null, {
        status: 'NO_ISSUES', reason: null, issueCount: 0, patchCount: 0, failureLayer: null, errorFingerprint: null,
      })
    }
    await this.completeCall(critic, critic.value)

    const optimizer = await this.callModel({
      ...input, stage, candidateHash, phase: 'OPTIMIZER', issueHash: hashInput(issues),
      payload: { candidate: input.candidate, issues },
      operation: CONTRACTS[stage].optimizerOperation, schemaName: CONTRACTS[stage].optimizerSchema,
      schema: slideOptimizerResultSchema,
    })
    if (!optimizer.ok) {
      return this.skip(input, stage, candidateHash, input.candidate, critic, optimizer, 'PATCH_REJECTED', issues.length)
    }
    try {
      const artifact = applySlideOptimizerResult({
        candidate: input.candidate,
        proposalContext: { ...input.sourceSpec, ...input.deckVisual },
        issues,
        result: optimizer.value,
      })
      return this.finish(input, stage, candidateHash, artifact, critic, optimizer, {
        status: 'APPLIED', reason: null, issueCount: issues.length,
        patchCount: patchCount(optimizer.value), failureLayer: null, errorFingerprint: null,
      })
    } catch (error) {
      return this.rejectOptimizer(input, stage, candidateHash, input.candidate, critic, optimizer, issues.length, error)
    }
  }

  private async callModel<T>(input: CommonInput & Readonly<{
    stage: ReflectionStage
    candidateHash: string
    phase: 'CRITIC' | 'OPTIMIZER'
    issueHash?: string
    payload: unknown
    operation: string
    schemaName: string
    schema: z.ZodType<T>
  }>): Promise<ModelCallResult<T>> {
    const keyInput = { ...input, stage: input.stage, candidateHash: input.candidateHash }
    const key = input.phase === 'CRITIC'
      ? reflectionCriticStepKey(keyInput)
      : reflectionOptimizerStepKey({ ...keyInput, issueHash: input.issueHash! })
    const inputHash = hashInput({ input: input.payload, operation: input.operation, schemaName: input.schemaName })
    for (;;) {
      const prepared = await this.prepareCall(input, key, inputHash)
      if (prepared.kind === 'COMPLETED') {
        const parsed = input.schema.safeParse(prepared.step.output && (prepared.step.output as { result?: unknown }).result)
        if (parsed.success) return { ok: true, value: parsed.data, key, transportAttemptCount: prepared.attempts, step: prepared.step }
        return { ok: false, key, step: prepared.step, failure: this.failure('JSON_SCHEMA', key, prepared.attempts) }
      }
      if (prepared.kind === 'EXHAUSTED') {
        return {
          ok: false, key, step: prepared.step,
          failure: this.failure('PROVIDER', key, prepared.attempts, undefined, 'UNKNOWN'),
        }
      }
      try {
        if (input.compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION && !input.modelOverride) {
          throw new Error('V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE')
        }
        const value = await this.dependencies.model.execute({
          tenantId: input.tenantId,
          operation: input.operation,
          schemaName: input.schemaName,
          payload: input.payload,
          idempotencyKey: key,
          ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
          ...(input.protocol ? { structuredGenerationProtocol: input.protocol } : {}),
        })
        const parsed = input.schema.safeParse(value)
        if (!parsed.success) {
          return { ok: false, key, step: prepared.step, failure: this.failure('JSON_SCHEMA', key, prepared.attempts) }
        }
        return { ok: true, value: parsed.data, key, transportAttemptCount: prepared.attempts, step: prepared.step }
      } catch (error) {
        if (error instanceof Error && error.message === 'V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE') throw error
        const layer = failureLayer(error)
        const submissionState = error instanceof StructuredModelError ? error.submissionState : 'NOT_ACCEPTED'
        if (submissionState === 'UNKNOWN' && prepared.attempts < 2) continue
        return { ok: false, key, step: prepared.step, failure: this.failure(layer, key, prepared.attempts, error) }
      }
    }
  }

  private async prepareCall(input: Readonly<{
    runId: string
    stage: ReflectionStage
    phase: 'CRITIC' | 'OPTIMIZER'
    candidateHash: string
  }>, key: string, inputHash: string) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(key)
      if (existing && (existing.inputHash !== inputHash || existing.tool !== toolName(input.stage, input.phase))) {
        throw new Error('STEP_IDEMPOTENCY_CONFLICT')
      }
      const attempts = existing && existing.output && typeof existing.output === 'object'
        && 'transportAttemptCount' in existing.output
        ? Number(existing.output.transportAttemptCount)
        : 0
      if (existing?.status === 'COMPLETED') return { kind: 'COMPLETED' as const, step: existing, attempts }
      if (existing?.status === 'FAILED' || attempts >= 2) {
        return { kind: 'EXHAUSTED' as const, step: existing!, attempts }
      }
      const now = this.dependencies.clock.now().toISOString()
      const nextAttempts = attempts + 1
      const step: StepRecord = {
        id: existing?.id ?? `step-${hashInput({ key }).slice(0, 28)}`,
        runId: input.runId,
        idempotencyKey: key,
        inputHash,
        tool: toolName(input.stage, input.phase),
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: {
          schemaVersion: '1', stage: input.stage, phase: input.phase, candidateHash: input.candidateHash,
          businessCallCount: 1, transportAttemptCount: nextAttempts, submissionState: 'UNKNOWN',
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      transaction.putStep(step)
      return { kind: 'SUBMIT' as const, step, attempts: nextAttempts }
    })
  }

  private async completeCall<T>(result: Extract<ModelCallResult<T>, { ok: true }>, value: T) {
    await this.dependencies.repository.transact(result.step.runId, (transaction) => {
      const step = transaction.getStep(result.key)
      if (!step) throw new Error('STEP_NOT_FOUND')
      transaction.putStep({
        ...step, status: 'COMPLETED', errorCode: null, updatedAt: this.dependencies.clock.now().toISOString(),
        output: { ...(step.output as object), submissionState: 'ACCEPTED', result: value },
      })
    })
  }

  private async finish<T>(
    input: CommonInput,
    stage: ReflectionStage,
    candidateHash: string,
    artifact: T,
    critic: Extract<ModelCallResult<unknown>, { ok: true }>,
    optimizer: Extract<ModelCallResult<unknown>, { ok: true }> | null,
    outcome: Pick<ReflectionDisposition, 'status' | 'reason' | 'issueCount' | 'patchCount' | 'failureLayer' | 'errorFingerprint'>,
  ) {
    const disposition = this.disposition(input, stage, candidateHash, artifact, critic, optimizer, outcome)
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      for (const call of [critic, optimizer].filter((value): value is Extract<ModelCallResult<unknown>, { ok: true }> => value !== null)) {
        const step = transaction.getStep(call.key)
        if (!step) throw new Error('STEP_NOT_FOUND')
        transaction.putStep({
          ...step, status: 'COMPLETED', errorCode: null, updatedAt: disposition.createdAt,
          output: { ...(step.output as object), submissionState: 'ACCEPTED', result: call.value, ...(call === optimizer ? { artifact } : {}) },
        })
      }
      transaction.putStep(dispositionStep(input.runId, reflectionDispositionStepKey({ ...input, stage, candidateHash }), disposition))
    })
    return { artifact, disposition }
  }

  private async skip<T>(
    input: CommonInput,
    stage: ReflectionStage,
    candidateHash: string,
    artifact: T,
    critic: ModelCallResult<unknown>,
    optimizer: ModelCallResult<unknown> | null,
    reason: NonNullable<ReflectionDisposition['reason']>,
    issueCount: number,
  ) {
    const failure = optimizer && !optimizer.ok ? optimizer.failure : !critic.ok ? critic.failure : null
    const disposition = this.disposition(input, stage, candidateHash, artifact, critic, optimizer, {
      status: 'REFLECTION_SKIPPED', reason, issueCount, patchCount: 0,
      failureLayer: failure?.layer ?? 'ZOD_SEMANTIC',
      errorFingerprint: failure?.fingerprint ?? hashInput({ stage, reason, candidateHash }),
    })
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      for (const call of [critic, optimizer].filter((value): value is ModelCallResult<unknown> => value !== null)) {
        const step = transaction.getStep(call.key)
        if (!step || step.status === 'COMPLETED') continue
        transaction.putStep({
          ...step, status: 'FAILED', errorCode: reason, updatedAt: disposition.createdAt,
          output: {
            ...(step.output as object),
          submissionState: call.ok ? 'ACCEPTED' : call.failure.submissionState,
            failureLayer: call.ok ? disposition.failureLayer : call.failure.layer,
            errorFingerprint: call.ok ? disposition.errorFingerprint : call.failure.fingerprint,
          },
        })
      }
      transaction.putStep(dispositionStep(input.runId, reflectionDispositionStepKey({ ...input, stage, candidateHash }), disposition))
    })
    return { artifact, disposition }
  }

  private rejectCritic<T>(input: CommonInput, stage: ReflectionStage, candidateHash: string, artifact: T,
    critic: Extract<ModelCallResult<unknown>, { ok: true }>, error: unknown) {
    const failure = contractFailure(error, critic.key, critic.transportAttemptCount)
    const failed: ModelCallResult<unknown> = { ok: false, key: critic.key, step: critic.step, failure }
    return this.skip(input, stage, candidateHash, artifact, failed, null, 'CONTRACT_INVALID', 0)
  }

  private rejectOptimizer<T>(input: CommonInput, stage: ReflectionStage, candidateHash: string, artifact: T,
    critic: Extract<ModelCallResult<unknown>, { ok: true }>, optimizer: Extract<ModelCallResult<unknown>, { ok: true }>,
    issueCount: number, error: unknown) {
    const failure = contractFailure(error, optimizer.key, optimizer.transportAttemptCount)
    const failed: ModelCallResult<unknown> = { ok: false, key: optimizer.key, step: optimizer.step, failure }
    return this.skip(input, stage, candidateHash, artifact, critic, failed, 'PATCH_REJECTED', issueCount)
  }

  private disposition<T>(input: CommonInput, stage: ReflectionStage, candidateHash: string, artifact: T,
    critic: ModelCallResult<unknown>, optimizer: ModelCallResult<unknown> | null,
    outcome: Pick<ReflectionDisposition, 'status' | 'reason' | 'issueCount' | 'patchCount' | 'failureLayer' | 'errorFingerprint'>) {
    return reflectionDispositionSchema.parse({
      schemaVersion: '1', stage, ...outcome, candidateHash,
      criticCallCount: 1,
      optimizerCallCount: optimizer ? 1 : 0,
      transportAttemptCount: callAttempts(critic) + (optimizer ? callAttempts(optimizer) : 0),
      criticKeyHash: hashInput(critic.key),
      optimizerKeyHash: optimizer ? hashInput(optimizer.key) : null,
      outputArtifactHash: hashInput(artifact),
      contractVersion: stage === 'DECK_CONSISTENCY'
        ? 'ppt_agent_v4_deck_consistency_reflection_v1'
        : 'ppt_agent_v4_slide_brief_reflection_v1',
      createdAt: this.dependencies.clock.now().toISOString(),
    })
  }

  private async replayDisposition<T>(input: CommonInput, stage: ReflectionStage, candidateHash: string, original: T) {
    const key = reflectionDispositionStepKey({ ...input, stage, candidateHash })
    const stored = await this.dependencies.repository.transact(input.runId, (transaction) => transaction.getStep(key))
    if (!stored || stored.status !== 'COMPLETED') return null
    const disposition = reflectionDispositionSchema.parse(stored.output)
    if (disposition.status !== 'APPLIED') return { artifact: original, disposition }
    const optimizer = (await this.dependencies.repository.listSteps(input.runId)).find((step) =>
      step.tool === toolName(stage, 'OPTIMIZER') && step.status === 'COMPLETED'
      && hashInput(step.idempotencyKey) === disposition.optimizerKeyHash
      && step.output && typeof step.output === 'object' && 'artifact' in step.output)
    const artifact = optimizer && (optimizer.output as { artifact?: T }).artifact
    if (!artifact || hashInput(artifact) !== disposition.outputArtifactHash) throw new Error('REFLECTION_ARTIFACT_MISSING')
    return { artifact, disposition }
  }

  private criticReason(layer: ReflectionFailureLayer) {
    return layer === 'PROVIDER' ? 'PROVIDER_UNAVAILABLE' as const : 'CONTRACT_INVALID' as const
  }

  private failure(
    layer: ReflectionFailureLayer,
    key: string,
    attempts: number,
    error?: unknown,
    fallbackSubmissionState: StructuredSubmissionState = layer === 'PROVIDER' ? 'NOT_ACCEPTED' : 'ACCEPTED',
  ): ModelCallFailure {
    return {
      layer,
      fingerprint: hashInput({ layer, keyHash: hashInput(key), code: safeErrorCode(error) }),
      transportAttemptCount: attempts,
      submissionState: error instanceof StructuredModelError
        ? error.submissionState
        : fallbackSubmissionState,
    }
  }
}

function toolName(stage: ReflectionStage, phase: 'CRITIC' | 'OPTIMIZER') {
  return `v4_${stage.toLowerCase()}_${phase.toLowerCase()}`
}

function callAttempts(call: ModelCallResult<unknown>) {
  return call.ok ? call.transportAttemptCount : call.failure.transportAttemptCount
}

function failureLayer(error: unknown): ReflectionFailureLayer {
  if (error instanceof StructuredModelError) {
    if (error.contractFailure) return error.contractFailure.layer
    return error.code === 'MODEL_JSON_INVALID' ? 'JSON_SCHEMA' : 'PROVIDER'
  }
  return error instanceof z.ZodError ? 'JSON_SCHEMA' : 'PROVIDER'
}

function contractFailure(error: unknown, key: string, attempts: number): ModelCallFailure {
  const layer = error instanceof ReflectionContractError ? error.layer : failureLayer(error)
  return {
    layer,
    fingerprint: hashInput({ layer, keyHash: hashInput(key), code: safeErrorCode(error) }),
    transportAttemptCount: attempts,
    submissionState: error instanceof StructuredModelError ? error.submissionState : 'ACCEPTED',
  }
}

function safeErrorCode(error: unknown) {
  if (error instanceof StructuredModelError) return error.code
  if (error instanceof ReflectionContractError) return error.message
  if (error instanceof z.ZodError) return 'ZOD_INVALID'
  return 'INTERNAL_FAILURE'
}

function patchCount(value: object): number {
  return Object.values(value).reduce<number>(
    (total, entries) => total + (Array.isArray(entries) ? entries.length : 0),
    0,
  )
}

function dispositionStep(runId: string, key: string, disposition: ReflectionDisposition): StepRecord {
  return {
    id: `step-${hashInput({ key }).slice(0, 28)}`,
    runId,
    idempotencyKey: key,
    inputHash: hashInput({ candidateHash: disposition.candidateHash, contractVersion: disposition.contractVersion }),
    tool: `record_v4_${disposition.stage.toLowerCase()}_reflection`,
    status: 'COMPLETED',
    budgetUnits: 0,
    budgetReservationId: null,
    externalOperationId: null,
    errorCode: null,
    output: disposition,
    createdAt: disposition.createdAt,
    updatedAt: disposition.createdAt,
  }
}

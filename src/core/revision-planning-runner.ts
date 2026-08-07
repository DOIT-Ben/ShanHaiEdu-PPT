import { CONTRACT_VERSION } from '../contracts'
import {
  deckReviewSchema,
  openKnowledgeDeckReviewSchema,
  revisionPlanDraftSchema,
  revisionPlanSchema,
  type DeckReview,
  type PresentationBlueprint,
  type RevisionPlan,
  type RevisionPlanDraft,
} from '../presentation-contracts'
import { DECK_QUALITY_THRESHOLD, deckReviewStepKey, passesDeckQuality } from './deck-review-runner'
import { getActiveBlueprint } from './active-blueprint'
import { hashInput } from './hash'
import type {
  AgentRepository,
  AgentTransaction,
  ClockPort,
  DocumentPort,
  RevisionPlanningPort,
  RunRecord,
  SourceChunk,
  StepRecord,
  ContractRepairIssue,
} from './ports'
import { StructuredModelError } from './ports'
import { VISUAL_DECK_V4_COMPILER_VERSION } from '../release-identity'
import { transitionRun } from './policy'
import { beginTechnicalRecovery, isTechnicalFailureCode } from './technical-recovery'
import {
  MAX_REVISION_CONTRACT_ATTEMPTS,
  revisionContractAttemptKey,
  revisionContractRepairIssues,
} from './revision-contract-repair'
import { visualDeckV4RevisionInstructions } from './revision-instruction-memory'
import {
  compileVisualDeckV4RevisionIssueGroups,
  revisionRepairDomain,
} from './revision-plan-representability'
import {
  activeRevisionLifecycle,
  appendAcceptedQualityIssueResolutions,
  appendV4LifecycleEvent,
  classifyAutomatedQualityAcceptanceIssues,
  ensureAutomatedQualityAcceptanceIssue,
  failVisualDeckV4Transaction,
  isHardQualityIssue,
  markAutomatedQualityAcceptance,
  revisionDetails,
} from './v4-lifecycle'

export type RevisionPlanningResult = Readonly<{
  status: RunRecord['status']
  step: StepRecord | null
  plan: RevisionPlan | null
  replayed: boolean
}>

const MAX_REVISION_PROVIDER_ATTEMPTS = 5
const REVISION_PROVIDER_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000] as const
const DEGRADABLE_V4_REVISION_FAILURES = new Set([
  'REVISION_PLAN_OPERATION_BUDGET_EXCEEDED',
  'V4_REVISION_INSTRUCTION_BUDGET_EXCEEDED',
])

type RevisionPlanningFailure = Readonly<{
  errorCode: string
  diagnosticCode: string
  providerAttempt: number
  maxProviderAttempts: number
  contractAttempt: number
  maxContractAttempts: number
  model: string | null
  requestId: string | null
}>

class RevisionPlanningExecutionError extends Error {
  constructor(
    readonly diagnostic: RevisionPlanningFailure,
    readonly fallbackEligible: boolean,
  ) {
    super(diagnostic.errorCode)
    this.name = 'RevisionPlanningExecutionError'
  }
}

export class RevisionPlanningRunner {
  private readonly inFlight = new Map<string, Promise<RevisionPlanningResult>>()

  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    documents: DocumentPort
    planner: RevisionPlanningPort
    clock: ClockPort
    sleep?: (milliseconds: number) => Promise<void>
  }>) {}

  plan(runId: string): Promise<RevisionPlanningResult> {
    const existing = this.inFlight.get(runId)
    if (existing) return existing
    const pending = this.planOnce(runId).finally(() => {
      if (this.inFlight.get(runId) === pending) this.inFlight.delete(runId)
    })
    this.inFlight.set(runId, pending)
    return pending
  }

  private async planOnce(runId: string): Promise<RevisionPlanningResult> {
    const run = await this.requireRun(runId)
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    const completedReview = await this.requireReview(run)
    if (passesDeckQuality(completedReview)) throw new Error('DECK_REVIEW_ALREADY_PASSED')
    const review = revisionScope(completedReview)
    if (run.revisionRound >= run.maxRevisionRounds) {
      return this.requireHuman(run, 'MAX_REVISION_ROUNDS_REACHED')
    }
    if (review.issues.length === 0) return this.requireHuman(run, 'REVISION_PLAN_HAS_NO_ISSUES')
    if (!review.issues.some((issue) => issue.severity !== 'INFO')) {
      return this.requireHuman(run, 'REVISION_PLAN_HAS_NO_REPAIRABLE_ISSUES')
    }

    let sourceChunks: readonly SourceChunk[]
    try {
      const document = await this.dependencies.documents.resolve({ host: run.host, source: run.source })
      if (!document.isComplete) throw new Error('SOURCE_INCOMPLETE')
      sourceChunks = document.chunks
      const ids = new Set(sourceChunks.map((chunk) => chunk.id))
      if (review.reviewedSourceChunkIds.some((id) => !ids.has(id))) throw new Error('REVISION_SOURCE_REFERENCE_INVALID')
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : 'REVISION_INPUT_FAILED'
      if (run.presentationMode === 'VISUAL_DECK_V4' && isTechnicalFailureCode(errorCode)) {
        return this.recoverTechnicalInputFailure(run, errorCode)
      }
      return this.requireHuman(run, errorCode)
    }

    const targetRevisionRound = run.revisionRound + 1
    const idempotencyKey = revisionPlanStepKey(run.id, targetRevisionRound)
    const inputHash = hashInput({
      tool: 'plan_revision',
      blueprint,
      review,
      sourceChunks: sourceChunks.map(({ id, sha256 }) => ({ id, sha256 })),
      targetRevisionRound,
    })
    const prepared = await this.prepare(run, idempotencyKey, inputHash)
    if (prepared) return prepared
    const steps = await this.dependencies.repository.listSteps(run.id)

    try {
      const planningInput = {
        run,
        blueprint,
        review,
        sourceChunks,
        targetRevisionRound,
        idempotencyKey,
        steps,
      }
      const plan = blueprint.visualDeckV4Proposal?.compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION
        ? this.compileVisualDeckV4Fallback(planningInput)
        : await this.planWithContractRepair(planningInput)
      return this.complete(run, idempotencyKey, plan)
    } catch (error) {
      const fallbackEligible = error instanceof RevisionPlanningExecutionError
        ? error.fallbackEligible
        : false
      if (blueprint.renderMode === 'VISUAL_DECK_V4' && fallbackEligible) {
        try {
          const plan = this.compileVisualDeckV4Fallback({
            run,
            blueprint,
            review,
            sourceChunks,
            targetRevisionRound,
            steps,
          })
          return this.complete(run, idempotencyKey, plan)
        } catch (fallbackError) {
          error = fallbackError
        }
      }
      const diagnostic = error instanceof RevisionPlanningExecutionError
        ? error.diagnostic
        : revisionPlanningFailure(error, 1, 1)
      return this.fail(run, idempotencyKey, diagnostic)
    }
  }

  private compileVisualDeckV4Fallback(input: Readonly<{
    run: RunRecord
    blueprint: PresentationBlueprint
    review: DeckReview
    sourceChunks: readonly SourceChunk[]
    targetRevisionRound: number
    steps: readonly StepRecord[]
  }>) {
    const issues = input.review.issues.filter((issue) => issue.severity !== 'INFO')
    if (issues.length === 0) throw new Error('REVISION_PLAN_HAS_NO_REPAIRABLE_ISSUES')
    const operations = compileVisualDeckV4RevisionIssueGroups(issues).map((group, groupIndex) => ({
        id: `v4-fallback-${hashInput({
          reviewId: input.review.id,
          issueIds: group.issues.map((issue) => issue.id),
          slideId: group.slideId,
          kind: group.kind,
          groupIndex,
          targetRevisionRound: input.targetRevisionRound,
        }).slice(0, 48)}`,
        slideId: group.slideId,
        kind: group.kind,
        issueIds: group.issues.map((issue) => issue.id),
        instruction: group.instruction,
        sourceChunkIds: group.sourceChunkIds,
      }))
    const draft = revisionPlanDraftSchema.parse({
      summary: `根据整套审查的 ${issues.length} 个必修问题生成完整局部修订计划。`,
      operations,
    })
    this.validatePlan(
      draft,
      input.run.id,
      input.blueprint,
      input.review,
      input.sourceChunks,
      input.steps,
    )
    return revisionPlanSchema.parse({
      ...draft,
      id: `${input.run.id}:revision-plan:r${input.targetRevisionRound}`,
      reviewId: input.review.id,
      revisionRound: input.targetRevisionRound,
      createdAt: this.dependencies.clock.now().toISOString(),
    })
  }

  private async planWithContractRepair(input: Readonly<{
    run: RunRecord
    blueprint: PresentationBlueprint
    review: DeckReview
    sourceChunks: readonly SourceChunk[]
    targetRevisionRound: number
    idempotencyKey: string
    steps: readonly StepRecord[]
  }>) {
    let contractRepairIssues: readonly ContractRepairIssue[] | undefined
    let lastError: unknown = new Error('REVISION_PLAN_FAILED')
    for (let contractAttempt = 0; contractAttempt < MAX_REVISION_CONTRACT_ATTEMPTS; contractAttempt += 1) {
      for (let providerAttempt = 1; providerAttempt <= MAX_REVISION_PROVIDER_ATTEMPTS; providerAttempt += 1) {
        try {
          const raw = await this.dependencies.planner.plan({
            tenantId: input.run.host.tenantId,
            blueprint: input.blueprint,
            review: input.review,
            sourceChunks: input.sourceChunks,
            targetRevisionRound: input.targetRevisionRound,
            idempotencyKey: revisionContractAttemptKey(input.idempotencyKey, contractAttempt),
            ...(contractRepairIssues ? { contractRepairIssues } : {}),
            ...(input.run.v4StructuredGenerationProtocol ? { structuredGenerationProtocol: input.run.v4StructuredGenerationProtocol } : {}),
          })
          const draft = revisionPlanDraftSchema.parse(raw)
          this.validatePlan(draft, input.run.id, input.blueprint, input.review, input.sourceChunks, input.steps)
          return revisionPlanSchema.parse({
            ...draft,
            id: `${input.run.id}:revision-plan:r${input.targetRevisionRound}`,
            reviewId: input.review.id,
            revisionRound: input.targetRevisionRound,
            createdAt: this.dependencies.clock.now().toISOString(),
          })
        } catch (error) {
          lastError = error
          const providerRetryable = error instanceof StructuredModelError
            && error.retryable
            && error.code !== 'MODEL_JSON_INVALID'
          if (providerRetryable) {
            if (providerAttempt === MAX_REVISION_PROVIDER_ATTEMPTS) {
              throw new RevisionPlanningExecutionError(
                revisionPlanningFailure(error, providerAttempt, contractAttempt + 1),
                false,
              )
            }
            await (this.dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
              REVISION_PROVIDER_RETRY_DELAYS_MS[providerAttempt - 1]
                ?? REVISION_PROVIDER_RETRY_DELAYS_MS.at(-1)!,
            )
            continue
          }
          const issues = revisionContractRepairIssues(error)
          if (!issues || contractAttempt + 1 >= MAX_REVISION_CONTRACT_ATTEMPTS) {
            throw new RevisionPlanningExecutionError(
              revisionPlanningFailure(error, providerAttempt, contractAttempt + 1),
              Boolean(issues),
            )
          }
          contractRepairIssues = issues
          break
        }
      }
    }
    throw new RevisionPlanningExecutionError(
      revisionPlanningFailure(lastError, 1, MAX_REVISION_CONTRACT_ATTEMPTS),
      false,
    )
  }

  private async prepare(run: RunRecord, idempotencyKey: string, inputHash: string) {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const existing = transaction.getStep(idempotencyKey)
      if (existing) {
        if (existing.inputHash !== inputHash || existing.tool !== 'plan_revision') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        if (existing.status === 'COMPLETED') {
          return {
            status: transaction.run.status,
            step: existing,
            plan: revisionPlanSchema.parse(existing.output),
            replayed: true,
          }
        }
        if (existing.status === 'FAILED') {
          return { status: transaction.run.status, step: existing, plan: null, replayed: true }
        }
        if (existing.status === 'RUNNING') return null
        throw new Error('REVISION_PLAN_STEP_STATE_INVALID')
      }
      if (transaction.run.status !== 'DECK_REVIEW') throw new Error('RUN_NOT_IN_DECK_REVIEW')
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: `step-${run.id}-revision-plan-r${run.revisionRound + 1}`,
        runId: run.id,
        idempotencyKey,
        inputHash,
        tool: 'plan_revision',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: now,
        updatedAt: now,
      }
      transaction.putStep(step)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.started',
        payload: { stepId: step.id, tool: step.tool, label: '生成局部修订计划' },
      })
      return null
    })
  }

  private async complete(run: RunRecord, idempotencyKey: string, plan: RevisionPlan): Promise<RevisionPlanningResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') {
        return {
          status: transaction.run.status,
          step,
          plan: revisionPlanSchema.parse(step.output),
          replayed: true,
        }
      }
      if (step.status === 'FAILED') {
        return { status: transaction.run.status, step, plan: null, replayed: true }
      }
      if (step.status !== 'RUNNING') throw new Error('REVISION_PLAN_STEP_STATE_INVALID')
      const now = this.dependencies.clock.now().toISOString()
      const to = transaction.run.automationLevel === 'SUPERVISED' ? 'AWAITING_REVISION_APPROVAL' : 'REVISING'
      const policy = transitionRun(transaction.run, to)
      const updatedRun: RunRecord = {
        ...transaction.run,
        ...policy,
        ...(to === 'REVISING' ? { revisionRound: plan.revisionRound } : {}),
        updatedAt: now,
      }
      const updatedStep: StepRecord = { ...step, status: 'COMPLETED', output: plan, updatedAt: now }
      transaction.putStep(updatedStep)
      transaction.putRun(updatedRun)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: step.id, summary: `已生成 ${plan.operations.length} 项局部修订操作` },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'DECK_REVIEW', to },
      })
      if (to === 'AWAITING_REVISION_APPROVAL') {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'REVISION', summary: plan.summary },
        })
      } else {
        appendV4LifecycleEvent(transaction, 'revision.started', {
          completed: 0,
          total: new Set(plan.operations.map((operation) => operation.slideId)).size,
          ...revisionDetails(plan),
        })
      }
      return { status: updatedRun.status, step: updatedStep, plan, replayed: false }
    })
  }

  private async fail(
    run: RunRecord,
    idempotencyKey: string,
    diagnostic: RevisionPlanningFailure,
  ): Promise<RevisionPlanningResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') {
        return {
          status: transaction.run.status,
          step,
          plan: revisionPlanSchema.parse(step.output),
          replayed: true,
        }
      }
      if (step.status === 'FAILED') {
        return { status: transaction.run.status, step, plan: null, replayed: true }
      }
      if (step.status !== 'RUNNING') throw new Error('REVISION_PLAN_STEP_STATE_INVALID')
      const now = this.dependencies.clock.now().toISOString()
      const fromStatus = transaction.run.status
      const v4TechnicalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4' && isTechnicalFailureCode(diagnostic.errorCode)
      const v4InternalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4' && !v4TechnicalFailure
      const policy = v4TechnicalFailure || v4InternalFailure
        ? transaction.run
        : transitionRun(transaction.run, 'NEEDS_HUMAN')
      const updatedStep: StepRecord = {
        ...step,
        status: v4TechnicalFailure ? 'RUNNING' : 'FAILED',
        errorCode: diagnostic.errorCode,
        output: { diagnostic },
        updatedAt: now,
      }
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      transaction.putStep(updatedStep)
      if (!v4TechnicalFailure && !v4InternalFailure) transaction.putRun(updatedRun)
      const technicalRecovery = v4TechnicalFailure
        ? beginTechnicalRecovery(transaction, this.dependencies.clock, diagnostic.errorCode)
        : null
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode: diagnostic.errorCode, retryable: technicalRecovery?.technicalRecovery?.retryable ?? false },
      })
      if (technicalRecovery) {
        const started = activeRevisionLifecycle(transaction)
        if (started) appendV4LifecycleEvent(transaction, 'revision.completed', {
          completed: 0,
          total: started.payload.total,
          pageNumbers: started.payload.pageNumbers,
          revisionKind: started.payload.revisionKind,
          revisionRound: started.payload.revisionRound,
          reason: 'REVISION_FAILED',
          retryable: technicalRecovery.technicalRecovery?.retryable ?? false,
        })
        return { status: transaction.run.status, step: updatedStep, plan: null, replayed: false }
      }
      if (v4InternalFailure) {
        if (DEGRADABLE_V4_REVISION_FAILURES.has(diagnostic.diagnosticCode)
          && this.acceptQualityAndStartDelivery(transaction)) {
          return { status: transaction.run.status, step: updatedStep, plan: null, replayed: false }
        }
        failVisualDeckV4Transaction({
          transaction,
          clock: this.dependencies.clock,
          errorCode: 'QUALITY_REMEDIATION_EXHAUSTED',
          reason: 'REVISION_FAILED',
        })
        return { status: transaction.run.status, step: updatedStep, plan: null, replayed: false }
      }
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: fromStatus, to: 'NEEDS_HUMAN', reason: diagnostic.errorCode },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'HUMAN_REVIEW', summary: '修订规划失败，需要人工处理后重试。' },
      })
      const started = activeRevisionLifecycle(transaction)
      if (started) {
        appendV4LifecycleEvent(transaction, 'revision.completed', {
          completed: 0,
          total: started.payload.total,
          pageNumbers: started.payload.pageNumbers,
          revisionKind: started.payload.revisionKind,
          revisionRound: started.payload.revisionRound,
          reason: 'REVISION_FAILED',
          retryable: false,
          requiresUserAction: true,
          nextAction: 'REVIEW_RESULT',
        })
      }
      return { status: updatedRun.status, step: updatedStep, plan: null, replayed: false }
    })
  }

  private async requireHuman(run: RunRecord, reason: string): Promise<RevisionPlanningResult> {
    if (run.presentationMode === 'VISUAL_DECK_V4'
      && run.automationLevel === 'BOUNDED_AUTO'
      && ['MAX_REVISION_ROUNDS_REACHED', 'REVISION_PLAN_HAS_NO_ISSUES', 'REVISION_PLAN_HAS_NO_REPAIRABLE_ISSUES'].includes(reason)) {
      const delivered = await this.dependencies.repository.transact(run.id, (transaction) => {
        if (this.acceptQualityAndStartDelivery(transaction)) return true
        failVisualDeckV4Transaction({
          transaction,
          clock: this.dependencies.clock,
          errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT',
          reason: 'DECK_REVIEW_REJECTED',
        })
        return false
      })
      const latest = await this.requireRun(run.id)
      return { status: latest.status, step: null, plan: null, replayed: !delivered }
    }
    const terminalErrorCode = run.presentationMode === 'VISUAL_DECK_V4'
      && run.automationLevel === 'BOUNDED_AUTO'
      ? reason === 'MAX_REVISION_ROUNDS_REACHED'
        ? 'QUALITY_REMEDIATION_EXHAUSTED' as const
        : ['REVISION_PLAN_HAS_NO_ISSUES', 'REVISION_PLAN_HAS_NO_REPAIRABLE_ISSUES'].includes(reason)
          ? 'QUALITY_ISSUE_STATE_INCONSISTENT' as const
          : null
      : null
    if (terminalErrorCode) {
      const failed = await this.dependencies.repository.transact(run.id, (transaction) =>
        failVisualDeckV4Transaction({
          transaction,
          clock: this.dependencies.clock,
          errorCode: terminalErrorCode,
          reason: terminalErrorCode === 'QUALITY_REMEDIATION_EXHAUSTED'
            ? 'REVISION_LIMIT_REACHED'
            : 'DECK_REVIEW_REJECTED',
        }))
      const latest = await this.requireRun(run.id)
      return { status: latest.status, step: null, plan: null, replayed: !failed }
    }
    if (run.status === 'NEEDS_HUMAN') return { status: run.status, step: null, plan: null, replayed: true }
    const updated = await this.dependencies.repository.transact(run.id, (transaction) => {
      const now = this.dependencies.clock.now().toISOString()
      const fromStatus = transaction.run.status
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      const next: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      transaction.putRun(next)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: fromStatus, to: 'NEEDS_HUMAN', reason },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'HUMAN_REVIEW', summary: '自动修订无法继续，请人工确认当前结果或后续处理。' },
      })
      const started = activeRevisionLifecycle(transaction)
      const limitReached = reason === 'MAX_REVISION_ROUNDS_REACHED'
      if (started) {
        appendV4LifecycleEvent(transaction, 'revision.completed', {
          completed: 0,
          total: started.payload.total,
          pageNumbers: started.payload.pageNumbers,
          revisionKind: started.payload.revisionKind,
          revisionRound: started.payload.revisionRound,
          reason: limitReached ? 'REVISION_LIMIT_REACHED' : 'REVISION_FAILED',
          retryable: false,
          requiresUserAction: true,
          nextAction: 'REVIEW_RESULT',
        })
      }
      return next
    })
    return { status: updated.status, step: null, plan: null, replayed: false }
  }

  private acceptQualityAndStartDelivery(transaction: AgentTransaction) {
    if (transaction.run.status !== 'DECK_REVIEW'
      || transaction.run.automationLevel !== 'BOUNDED_AUTO') return false
    const disposition = appendAcceptedQualityIssueResolutions(transaction)
    if (disposition.blockingIssueIds.length > 0) return false
    if (classifyAutomatedQualityAcceptanceIssues(
      transaction,
      disposition.acceptedIssueIds,
    ).invalidIssueIds.length > 0) return false
    const now = this.dependencies.clock.now().toISOString()
    const policy = transitionRun(transaction.run, 'DELIVERING')
    const acceptedIssueIds = ensureAutomatedQualityAcceptanceIssue(transaction, disposition.acceptedIssueIds)
    transaction.putRun({
      ...markAutomatedQualityAcceptance({ ...transaction.run, ...policy }, acceptedIssueIds, now),
      updatedAt: now,
    })
    transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'phase.changed',
      payload: { from: 'DECK_REVIEW', to: 'DELIVERING', reason: 'QUALITY_POLICY_ACCEPTED' },
    })
    appendV4LifecycleEvent(transaction, 'delivery.started', {
      completed: 0,
      total: 1,
      pageNumbers: Array.from({ length: transaction.run.slideCount }, (_, index) => index + 1),
    })
    return true
  }

  private async recoverTechnicalInputFailure(run: RunRecord, errorCode: string): Promise<RevisionPlanningResult> {
    const updated = await this.dependencies.repository.transact(run.id, (transaction) =>
      beginTechnicalRecovery(transaction, this.dependencies.clock, errorCode))
    if (!updated) return this.requireHuman(run, errorCode)
    return { status: updated.status, step: null, plan: null, replayed: false }
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }

  private async requireReview(run: RunRecord): Promise<DeckReview> {
    const step = (await this.dependencies.repository.listSteps(run.id))
      .find((candidate) => candidate.idempotencyKey === deckReviewStepKey(run) && candidate.status === 'COMPLETED')
    if (!step) throw new Error('DECK_REVIEW_NOT_READY')
    return openKnowledgeDeckReviewSchema.or(deckReviewSchema).parse(step.output)
  }

  private validatePlan(
    draft: RevisionPlanDraft,
    runId: string,
    blueprint: PresentationBlueprint,
    review: DeckReview,
    sourceChunks: readonly SourceChunk[],
    steps: readonly StepRecord[],
  ) {
    const issuesById = new Map(review.issues.map((issue) => [issue.id, issue]))
    const slidesById = new Map(blueprint.slides.map((slide) => [`${runId}:slide:${slide.pageNumber}`, slide]))
    const sourceIds = new Set(sourceChunks.map((chunk) => chunk.id))
    const targetedIssueSlides = new Set(draft.operations.flatMap((operation) =>
      operation.issueIds.map((issueId) => `${issueId}\u0000${operation.slideId}`)))
    const requiredIssueSlides = review.issues
      .filter((issue) => issue.severity !== 'INFO')
      .flatMap((issue) => issue.slideIds.map((slideId) => `${issue.id}\u0000${slideId}`))
    if (requiredIssueSlides.some((target) => !targetedIssueSlides.has(target))) {
      throw new Error('REVISION_PLAN_ISSUE_COVERAGE_INCOMPLETE')
    }
    for (const operation of draft.operations) {
      const slide = slidesById.get(operation.slideId)
      if (!slide) throw new Error('REVISION_PLAN_SLIDE_REFERENCE_INVALID')
      const issues = operation.issueIds.map((issueId) => issuesById.get(issueId))
      if (issues.some((issue) => !issue)) throw new Error('REVISION_PLAN_ISSUE_REFERENCE_INVALID')
      if (issues.some((issue) => !issue!.slideIds.includes(operation.slideId))) {
        throw new Error('REVISION_PLAN_ISSUE_SLIDE_MISMATCH')
      }
      const expectedKinds = new Set(issues.map((issue) => expectedRevisionKind(issue!)))
      if (expectedKinds.size !== 1 || !expectedKinds.has(operation.kind)) {
        throw new Error('REVISION_PLAN_REPAIR_DOMAIN_MISMATCH')
      }
      if (operation.sourceChunkIds.some((id) => !sourceIds.has(id))) {
        throw new Error('REVISION_PLAN_SOURCE_REFERENCE_INVALID')
      }
      const needsSources = issues.some((issue) => revisionRepairDomain(issue!) === 'KNOWLEDGE')
      if (needsSources && operation.sourceChunkIds.length === 0) {
        throw new Error('REVISION_PLAN_SOURCE_REFERENCE_REQUIRED')
      }
      const issueSourceIds = new Set(issues.flatMap((issue) => issue!.sourceChunkIds))
      if (needsSources && operation.sourceChunkIds.some((id) => !issueSourceIds.has(id))) {
        throw new Error('REVISION_PLAN_SOURCE_MISMATCH')
      }
      if (needsSources && [...issueSourceIds].some((id) => !operation.sourceChunkIds.includes(id))) {
        throw new Error('REVISION_PLAN_SOURCE_COVERAGE_INCOMPLETE')
      }
      if (blueprint.renderMode === 'LAYERED_COURSEWARE_V3' && operation.kind === 'REGENERATE_IMAGE') {
        if (!operation.targetElementId) throw new Error('REVISION_TARGET_ELEMENT_REQUIRED')
        const target = slide.layeredDesign?.elements.find((element) =>
          element.kind === 'IMAGE' && element.elementId === operation.targetElementId)
        if (!target) throw new Error('REVISION_TARGET_ELEMENT_INVALID')
      }
    }
    if (blueprint.renderMode === 'VISUAL_DECK_V4') {
      const instructionsBySlide = new Map<string, string[]>()
      for (const operation of draft.operations) {
        const instructions = instructionsBySlide.get(operation.slideId) ?? []
        instructions.push(operation.instruction)
        instructionsBySlide.set(operation.slideId, instructions)
      }
      for (const [slideId, instructions] of instructionsBySlide) {
        const pageNumber = Number(slideId.split(':').at(-1))
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
          throw new Error('REVISION_PLAN_SLIDE_REFERENCE_INVALID')
        }
        visualDeckV4RevisionInstructions({
          runId,
          pageNumber,
          revisionRound: review.revisionRound + 1,
          steps,
          currentInstructions: instructions,
        })
      }
    }
  }
}

function revisionPlanningFailure(
  error: unknown,
  providerAttempt: number,
  contractAttempt: number,
): RevisionPlanningFailure {
  const structured = error instanceof StructuredModelError ? error : null
  const diagnosticCode = structured?.code
    ?? (error instanceof Error && /^[A-Z][A-Z0-9_]{2,99}$/.test(error.message)
      ? error.message
      : 'REVISION_PLAN_FAILED')
  return {
    errorCode: structured?.code ?? 'REVISION_PLAN_FAILED',
    diagnosticCode,
    providerAttempt,
    maxProviderAttempts: MAX_REVISION_PROVIDER_ATTEMPTS,
    contractAttempt,
    maxContractAttempts: MAX_REVISION_CONTRACT_ATTEMPTS,
    model: structured?.model ?? null,
    requestId: structured?.requestId ?? null,
  }
}

function expectedRevisionKind(issue: DeckReview['issues'][number]): RevisionPlan['operations'][number]['kind'] {
  const repairDomain = revisionRepairDomain(issue)
  if (repairDomain === 'KNOWLEDGE') return 'UPDATE_CONTENT'
  if (repairDomain === 'ASSET') return 'REGENERATE_IMAGE'
  return 'RELAYOUT'
}

function revisionScope(review: DeckReview): DeckReview {
  if (review.qualityScore < DECK_QUALITY_THRESHOLD) return review
  const issues = review.issues.filter(isHardQualityIssue)
  return issues.length === review.issues.length ? review : { ...review, issues }
}

export function revisionPlanStepKey(runId: string, revisionRound: number) {
  return `${runId}:revision-plan:r${revisionRound}`
}

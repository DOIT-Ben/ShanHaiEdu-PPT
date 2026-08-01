import { CONTRACT_VERSION } from '../contracts'
import {
  deckReviewSchema,
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
  ClockPort,
  DocumentPort,
  RevisionPlanningPort,
  RunRecord,
  SourceChunk,
  StepRecord,
  ContractRepairIssue,
} from './ports'
import { StructuredModelError } from './ports'
import { transitionRun } from './policy'
import {
  MAX_REVISION_CONTRACT_ATTEMPTS,
  revisionContractAttemptKey,
  revisionContractRepairIssues,
} from './revision-contract-repair'
import { visualDeckV4RevisionInstructions } from './revision-instruction-memory'
import {
  activeRevisionLifecycle,
  appendV4LifecycleEvent,
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
      return this.requireHuman(run, error instanceof Error ? error.message : 'REVISION_INPUT_FAILED')
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
      const plan = await this.planWithContractRepair({
        run,
        blueprint,
        review,
        sourceChunks,
        targetRevisionRound,
        idempotencyKey,
        steps,
      })
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
    const draft = revisionPlanDraftSchema.parse({
      summary: `根据整套审查的 ${issues.length} 个必修问题生成完整局部修订计划。`,
      operations: issues.flatMap((issue) => issue.slideIds.map((slideId) => ({
        id: `v4-fallback-${hashInput({
          reviewId: input.review.id,
          issueId: issue.id,
          slideId,
          targetRevisionRound: input.targetRevisionRound,
        }).slice(0, 48)}`,
        slideId,
        kind: expectedRevisionKind(issue),
        issueIds: [issue.id],
        instruction: issue.summary,
        sourceChunkIds: issue.sourceChunkIds,
      }))),
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
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      const updatedStep: StepRecord = {
        ...step,
        status: 'FAILED',
        errorCode: diagnostic.errorCode,
        output: { diagnostic },
        updatedAt: now,
      }
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      transaction.putStep(updatedStep)
      transaction.putRun(updatedRun)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode: diagnostic.errorCode, retryable: false },
      })
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

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }

  private async requireReview(run: RunRecord): Promise<DeckReview> {
    const step = (await this.dependencies.repository.listSteps(run.id))
      .find((candidate) => candidate.idempotencyKey === deckReviewStepKey(run) && candidate.status === 'COMPLETED')
    if (!step) throw new Error('DECK_REVIEW_NOT_READY')
    return deckReviewSchema.parse(step.output)
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

function revisionRepairDomain(issue: DeckReview['issues'][number]) {
  const inferredDomain = ['CURRICULUM_GAP', 'FACTUAL_RISK'].includes(issue.category)
    ? 'KNOWLEDGE'
    : ['IMAGE_QUALITY', 'ASSET_RELEVANCE'].includes(issue.category) ? 'ASSET' : 'LAYOUT'
  return issue.repairDomain ?? inferredDomain
}

function revisionScope(review: DeckReview): DeckReview {
  if (review.qualityScore < DECK_QUALITY_THRESHOLD) return review
  const issues = review.issues.filter((issue) =>
    issue.severity === 'CRITICAL' || issue.category === 'FACTUAL_RISK')
  return issues.length === review.issues.length ? review : { ...review, issues }
}

export function revisionPlanStepKey(runId: string, revisionRound: number) {
  return `${runId}:revision-plan:r${revisionRound}`
}

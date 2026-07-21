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
import { deckReviewStepKey, passesDeckQuality } from './deck-review-runner'
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
} from './ports'
import { transitionRun } from './policy'

export type RevisionPlanningResult = Readonly<{
  status: RunRecord['status']
  step: StepRecord | null
  plan: RevisionPlan | null
  replayed: boolean
}>

export class RevisionPlanningRunner {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    documents: DocumentPort
    planner: RevisionPlanningPort
    clock: ClockPort
  }>) {}

  async plan(runId: string): Promise<RevisionPlanningResult> {
    const run = await this.requireRun(runId)
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    const review = await this.requireReview(run)
    if (passesDeckQuality(review)) throw new Error('DECK_REVIEW_ALREADY_PASSED')
    if (run.revisionRound >= run.maxRevisionRounds) {
      return this.requireHuman(run, 'MAX_REVISION_ROUNDS_REACHED')
    }
    if (review.issues.length === 0) return this.requireHuman(run, 'REVISION_PLAN_HAS_NO_ISSUES')

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

    try {
      const raw = await this.dependencies.planner.plan({
        tenantId: run.host.tenantId,
        blueprint,
        review,
        sourceChunks,
        targetRevisionRound,
        idempotencyKey,
      })
      const draft = revisionPlanDraftSchema.parse(raw)
      this.validatePlan(draft, run.id, blueprint, review, sourceChunks)
      const plan = revisionPlanSchema.parse({
        ...draft,
        id: `${run.id}:revision-plan:r${targetRevisionRound}`,
        reviewId: review.id,
        revisionRound: targetRevisionRound,
        createdAt: this.dependencies.clock.now().toISOString(),
      })
      return this.complete(run, idempotencyKey, plan)
    } catch {
      return this.fail(run, idempotencyKey, 'REVISION_PLAN_FAILED')
    }
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
        throw new Error('REVISION_PLAN_ALREADY_RUNNING')
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
      }
      return { status: updatedRun.status, step: updatedStep, plan, replayed: false }
    })
  }

  private async fail(run: RunRecord, idempotencyKey: string, errorCode: string): Promise<RevisionPlanningResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      const updatedStep: StepRecord = { ...step, status: 'FAILED', errorCode, updatedAt: now }
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      transaction.putStep(updatedStep)
      transaction.putRun(updatedRun)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode, retryable: false },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: transaction.run.status, to: 'NEEDS_HUMAN', reason: errorCode },
      })
      return { status: updatedRun.status, step: updatedStep, plan: null, replayed: false }
    })
  }

  private async requireHuman(run: RunRecord, reason: string): Promise<RevisionPlanningResult> {
    if (run.status === 'NEEDS_HUMAN') return { status: run.status, step: null, plan: null, replayed: true }
    const updated = await this.dependencies.repository.transact(run.id, (transaction) => {
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      const next: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      transaction.putRun(next)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: transaction.run.status, to: 'NEEDS_HUMAN', reason },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'HUMAN_REVIEW', summary: '自动修订无法继续，请人工确认当前结果或后续处理。' },
      })
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
  ) {
    const issuesById = new Map(review.issues.map((issue) => [issue.id, issue]))
    const slideIds = new Set(blueprint.slides.map((slide) => `${runId}:slide:${slide.pageNumber}`))
    const sourceIds = new Set(sourceChunks.map((chunk) => chunk.id))
    const targetedIssueIds = new Set(draft.operations.flatMap((operation) => operation.issueIds))
    const requiredIssueIds = review.issues.filter((issue) => issue.severity !== 'INFO').map((issue) => issue.id)
    if (requiredIssueIds.some((issueId) => !targetedIssueIds.has(issueId))) {
      throw new Error('REVISION_PLAN_ISSUE_COVERAGE_INCOMPLETE')
    }
    for (const operation of draft.operations) {
      if (!slideIds.has(operation.slideId)) throw new Error('REVISION_PLAN_SLIDE_REFERENCE_INVALID')
      const issues = operation.issueIds.map((issueId) => issuesById.get(issueId))
      if (issues.some((issue) => !issue)) throw new Error('REVISION_PLAN_ISSUE_REFERENCE_INVALID')
      if (issues.every((issue) => !issue!.slideIds.includes(operation.slideId))) {
        throw new Error('REVISION_PLAN_ISSUE_SLIDE_MISMATCH')
      }
      if (operation.sourceChunkIds.some((id) => !sourceIds.has(id))) {
        throw new Error('REVISION_PLAN_SOURCE_REFERENCE_INVALID')
      }
      const needsSources = issues.some((issue) => ['CURRICULUM_GAP', 'FACTUAL_RISK'].includes(issue!.category))
      if (needsSources && operation.sourceChunkIds.length === 0) {
        throw new Error('REVISION_PLAN_SOURCE_REFERENCE_REQUIRED')
      }
    }
  }
}

export function revisionPlanStepKey(runId: string, revisionRound: number) {
  return `${runId}:revision-plan:r${revisionRound}`
}

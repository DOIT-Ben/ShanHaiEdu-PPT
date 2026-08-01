import {
  CONTRACT_VERSION,
  type AgentEvent,
  type V4LifecycleNextAction,
  type V4LifecycleReason,
  type V4LifecycleStage,
  type V4RevisionKind,
  type V4RunFailureCode,
} from '../contracts'
import type { RevisionPlan } from '../presentation-contracts'
import type { AgentRepository, AgentTransaction, ClockPort, NewAgentEvent, RunRecord } from './ports'
import { isTerminalStatus, transitionRun } from './policy'

export type V4LifecycleEventType =
  | 'planning.started' | 'planning.completed'
  | 'generation.started' | 'generation.progress' | 'generation.completed'
  | 'page_review.started' | 'page_review.completed'
  | 'revision.started' | 'revision.progress' | 'revision.completed'
  | 'deck_review.started' | 'deck_review.completed'
  | 'delivery.started' | 'delivery.completed'

const stageByType: Readonly<Record<V4LifecycleEventType, V4LifecycleStage>> = {
  'planning.started': 'PLANNING',
  'planning.completed': 'PLANNING',
  'generation.started': 'GENERATION',
  'generation.progress': 'GENERATION',
  'generation.completed': 'GENERATION',
  'page_review.started': 'PAGE_REVIEW',
  'page_review.completed': 'PAGE_REVIEW',
  'revision.started': 'REVISION',
  'revision.progress': 'REVISION',
  'revision.completed': 'REVISION',
  'deck_review.started': 'DECK_REVIEW',
  'deck_review.completed': 'DECK_REVIEW',
  'delivery.started': 'DELIVERY',
  'delivery.completed': 'DELIVERY',
}

export type V4LifecyclePayloadInput = Readonly<{
  completed: number
  total: number
  pageNumbers?: readonly number[]
  revisionKind?: V4RevisionKind | null
  revisionRound?: number
  reason?: V4LifecycleReason | null
  retryable?: boolean | null
  requiresUserAction?: boolean
  nextAction?: V4LifecycleNextAction | null
}>

export function isVisualDeckV4(run: Pick<RunRecord, 'presentationMode'>) {
  return run.presentationMode === 'VISUAL_DECK_V4'
}

export function allPageNumbers(run: Pick<RunRecord, 'slideCount'>) {
  return Array.from({ length: run.slideCount }, (_, index) => index + 1)
}

export function v4LifecyclePayload(
  run: Pick<RunRecord, 'budgetUnits' | 'committedBudgetUnits' | 'revisionRound' | 'maxRevisionRounds'>,
  stage: V4LifecycleStage,
  input: V4LifecyclePayloadInput,
) {
  const pageNumbers = [...new Set(input.pageNumbers ?? [])].sort((left, right) => left - right)
  return {
    presentationMode: 'VISUAL_DECK_V4' as const,
    stage,
    completed: input.completed,
    total: input.total,
    pageNumbers,
    revisionKind: input.revisionKind ?? null,
    revisionRound: input.revisionRound ?? run.revisionRound,
    maxRevisionRounds: run.maxRevisionRounds,
    budgetUnits: run.budgetUnits,
    committedBudgetUnits: run.committedBudgetUnits,
    reason: input.reason ?? null,
    retryable: input.retryable ?? null,
    requiresUserAction: input.requiresUserAction ?? false,
    nextAction: input.nextAction ?? null,
  }
}

export function appendV4LifecycleEvent(
  transaction: AgentTransaction,
  type: V4LifecycleEventType,
  input: V4LifecyclePayloadInput,
) {
  if (!isVisualDeckV4(transaction.run)) return null
  const payload = v4LifecyclePayload(transaction.run, stageByType[type], input)
  const events = transaction.listEvents()
  const stageName = type.split('.')[0]!
  const startedType = `${stageName}.started`
  const lastStarted = [...events].reverse().find((event) => event.type === startedType)
  const previous = [...events].reverse().find((event) => event.type === type)
  if (type.endsWith('.started')) {
    const completedType = `${stageName}.completed`
    const lastCompleted = [...events].reverse().find((event) => event.type === completedType)
    if (lastStarted && (!lastCompleted || lastStarted.sequence > lastCompleted.sequence)) return lastStarted
  } else if (previous && (!lastStarted || previous.sequence > lastStarted.sequence)
    && JSON.stringify(previous.payload) === JSON.stringify(payload)) {
    return previous
  }
  return transaction.appendEvent({
    schemaVersion: CONTRACT_VERSION,
    type,
    payload,
  } as NewAgentEvent)
}

export function activeRevisionLifecycle(transaction: AgentTransaction) {
  const events = transaction.listEvents()
  const started = [...events].reverse().find((event): event is Extract<AgentEvent, { type: 'revision.started' }> =>
    event.type === 'revision.started')
  const completed = [...events].reverse().find((event): event is Extract<AgentEvent, { type: 'revision.completed' }> =>
    event.type === 'revision.completed')
  return started && (!completed || started.sequence > completed.sequence) ? started : null
}

export function revisionDetails(
  plan: Pick<RevisionPlan, 'operations' | 'revisionRound'>,
  pageVisual = false,
) {
  const pageNumbers = [...new Set(plan.operations.map((operation) =>
    Number(operation.slideId.split(':').at(-1))))]
    .filter((pageNumber) => Number.isSafeInteger(pageNumber) && pageNumber > 0)
    .sort((left, right) => left - right)
  const revisionKind: V4RevisionKind = pageVisual
    ? 'PAGE_VISUAL'
    : plan.operations.some((operation) => operation.kind === 'UPDATE_CONTENT')
      ? 'DECK_CONTENT'
      : 'DECK_VISUAL'
  return { pageNumbers, revisionKind, revisionRound: plan.revisionRound }
}

export function appendFixedIssueResolutions(
  transaction: AgentTransaction,
  issueIds: readonly string[],
  stillOpenIssueIds: readonly string[] = [],
) {
  const openIssueIds = new Set<string>()
  for (const event of transaction.listEvents()) {
    if (event.type === 'issue.detected') openIssueIds.add(event.payload.id)
    if (event.type === 'issue.resolved') openIssueIds.delete(event.payload.issueId)
  }
  const stillOpen = new Set(stillOpenIssueIds)
  for (const issueId of new Set(issueIds)) {
    if (!openIssueIds.has(issueId) || stillOpen.has(issueId)) continue
    transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'issue.resolved',
      payload: { issueId, resolution: 'FIXED' },
    })
  }
}

const lifecycleStagePairs = [
  { started: 'planning.started', progress: null, completed: 'planning.completed' },
  { started: 'generation.started', progress: 'generation.progress', completed: 'generation.completed' },
  { started: 'page_review.started', progress: null, completed: 'page_review.completed' },
  { started: 'revision.started', progress: 'revision.progress', completed: 'revision.completed' },
  { started: 'deck_review.started', progress: null, completed: 'deck_review.completed' },
  { started: 'delivery.started', progress: null, completed: 'delivery.completed' },
] as const

export function closeActiveV4LifecycleStages(
  transaction: AgentTransaction,
  reason: Extract<V4LifecycleReason, 'INTERNAL_FAILURE' | 'CANCELLED_BY_USER'>,
) {
  const events = transaction.listEvents()
  for (const pair of lifecycleStagePairs) {
    const started = [...events].reverse().find((event) => event.type === pair.started)
    const completed = [...events].reverse().find((event) => event.type === pair.completed)
    if (!started || (completed && completed.sequence > started.sequence)) continue
    const latest = [...events].reverse().find((event) => event.sequence >= started.sequence
      && (event.type === pair.started || (pair.progress !== null && event.type === pair.progress))) ?? started
    const payload = latest.payload as ReturnType<typeof v4LifecyclePayload>
    appendV4LifecycleEvent(transaction, pair.completed, {
      completed: payload.completed,
      total: payload.total,
      pageNumbers: payload.pageNumbers,
      revisionKind: payload.revisionKind,
      revisionRound: payload.revisionRound,
      reason,
      retryable: false,
    })
  }
}

export async function failVisualDeckV4Run(input: Readonly<{
  repository: AgentRepository
  clock: ClockPort
  runId: string
  errorCode: V4RunFailureCode
}>) {
  return input.repository.transact(input.runId, (transaction) => {
    if (!isVisualDeckV4(transaction.run) || isTerminalStatus(transaction.run.status)
      || ['PAUSED', 'NEEDS_HUMAN', 'AWAITING_BLUEPRINT_APPROVAL', 'AWAITING_REVISION_APPROVAL'].includes(transaction.run.status)) {
      return false
    }
    const fromStatus = transaction.run.status
    const now = input.clock.now().toISOString()
    closeActiveV4LifecycleStages(transaction, 'INTERNAL_FAILURE')
    const policy = transitionRun(transaction.run, 'FAILED')
    const failedRun = { ...transaction.run, ...policy, updatedAt: now }
    transaction.putRun(failedRun)
    transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'phase.changed',
      payload: { from: fromStatus, to: 'FAILED', reason: input.errorCode },
    })
    transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'run.failed',
      payload: {
        ...v4LifecyclePayload(failedRun, 'RUN', {
          completed: 0,
          total: 1,
          pageNumbers: allPageNumbers(failedRun),
          reason: 'INTERNAL_FAILURE',
          retryable: false,
        }),
        errorCode: input.errorCode,
      },
    })
    return true
  })
}

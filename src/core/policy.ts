import type { RunAction, RunStatus } from '../contracts'

const TERMINAL_STATES = new Set<RunStatus>(['COMPLETED', 'FAILED', 'CANCELLED'])
const PAUSABLE_STATES = new Set<RunStatus>([
  'EXECUTING',
  'PAGE_REVIEW',
  'DECK_REVIEW',
  'AWAITING_REVISION_APPROVAL',
  'REVISING',
])

const TRANSITIONS: Readonly<Record<Exclude<RunStatus, 'PAUSED'>, ReadonlySet<RunStatus>>> = {
  PLANNING: new Set(['AWAITING_BLUEPRINT_APPROVAL', 'EXECUTING', 'NEEDS_HUMAN', 'FAILED', 'CANCELLED']),
  AWAITING_BLUEPRINT_APPROVAL: new Set(['PLANNING', 'EXECUTING', 'CANCELLED']),
  EXECUTING: new Set(['PAGE_REVIEW', 'PAUSED', 'NEEDS_HUMAN', 'FAILED', 'CANCELLED']),
  PAGE_REVIEW: new Set(['DECK_REVIEW', 'REVISING', 'PAUSED', 'NEEDS_HUMAN', 'FAILED', 'CANCELLED']),
  DECK_REVIEW: new Set(['AWAITING_REVISION_APPROVAL', 'REVISING', 'PAUSED', 'NEEDS_HUMAN', 'DELIVERING', 'FAILED', 'CANCELLED']),
  AWAITING_REVISION_APPROVAL: new Set(['REVISING', 'PAUSED', 'NEEDS_HUMAN', 'CANCELLED']),
  REVISING: new Set(['EXECUTING', 'PAGE_REVIEW', 'DECK_REVIEW', 'PAUSED', 'NEEDS_HUMAN', 'FAILED', 'CANCELLED']),
  NEEDS_HUMAN: new Set(['PLANNING', 'REVISING', 'DELIVERING', 'CANCELLED']),
  DELIVERING: new Set(['COMPLETED', 'NEEDS_HUMAN', 'CANCELLED']),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
}

export class PolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PolicyError'
  }
}

export type RunPolicyState = Readonly<{
  status: RunStatus
  resumeState: RunStatus | null
  version: number
  budgetUnits: number
  committedBudgetUnits: number
  qualityOverride: boolean
}>

export function isTerminalStatus(status: RunStatus) {
  return TERMINAL_STATES.has(status)
}

export function canTransition(from: RunStatus, to: RunStatus, resumeState: RunStatus | null = null) {
  if (from === 'PAUSED') return to === 'CANCELLED' || (resumeState !== null && to === resumeState)
  return TRANSITIONS[from].has(to)
}

export function transitionRun(state: RunPolicyState, to: RunStatus): RunPolicyState {
  if (!canTransition(state.status, to, state.resumeState)) {
    throw new PolicyError('INVALID_STATE_TRANSITION', `cannot transition from ${state.status} to ${to}`)
  }

  if (to === 'PAUSED') {
    return { ...state, status: 'PAUSED', resumeState: state.status, version: state.version + 1 }
  }

  return { ...state, status: to, resumeState: null, version: state.version + 1 }
}

export function applyRunAction(state: RunPolicyState, action: RunAction): RunPolicyState {
  if (action.expectedVersion !== state.version) {
    throw new PolicyError('RUN_VERSION_CONFLICT', 'run version does not match expectedVersion')
  }

  switch (action.type) {
    case 'APPROVE_BLUEPRINT':
      return transitionRun(state, 'EXECUTING')
    case 'RETRY_PLANNING':
    case 'REPLAN':
      if (state.status !== 'NEEDS_HUMAN') {
        throw new PolicyError('PLANNING_RETRY_NOT_ALLOWED', 'planning retry requires human-review state')
      }
      return transitionRun(state, 'PLANNING')
    case 'RETRY_DELIVERY':
      if (state.status !== 'NEEDS_HUMAN') {
        throw new PolicyError('DELIVERY_RETRY_NOT_ALLOWED', 'delivery retry requires human-review state')
      }
      return transitionRun(state, 'DELIVERING')
    case 'REQUEST_BLUEPRINT_REVISION':
      return transitionRun(state, 'PLANNING')
    case 'PAUSE':
      if (!PAUSABLE_STATES.has(state.status)) throw new PolicyError('RUN_NOT_PAUSABLE', `cannot pause ${state.status}`)
      return transitionRun(state, 'PAUSED')
    case 'RESUME':
      if (state.status !== 'PAUSED' || state.resumeState === null) {
        throw new PolicyError('RUN_NOT_RESUMABLE', 'run has no persisted resume state')
      }
      return transitionRun(state, state.resumeState)
    case 'CANCEL':
      if (isTerminalStatus(state.status)) throw new PolicyError('RUN_ALREADY_TERMINAL', `cannot cancel ${state.status}`)
      return transitionRun(state, 'CANCELLED')
    case 'ADD_BUDGET':
      if (isTerminalStatus(state.status)) throw new PolicyError('RUN_ALREADY_TERMINAL', `cannot fund ${state.status}`)
      return { ...state, budgetUnits: state.budgetUnits + action.additionalBudgetUnits, version: state.version + 1 }
    case 'APPROVE_REVISION':
      return transitionRun(state, 'REVISING')
    case 'SUBMIT_LIMITED_REVISION':
      if (state.status !== 'NEEDS_HUMAN') {
        throw new PolicyError('LIMITED_REVISION_NOT_ALLOWED', 'limited revision requires human-review state')
      }
      return transitionRun(state, 'REVISING')
    case 'REJECT_REVISION':
      return transitionRun(state, 'NEEDS_HUMAN')
    case 'ACCEPT_WITH_OVERRIDE': {
      if (state.status !== 'NEEDS_HUMAN') {
        throw new PolicyError('QUALITY_OVERRIDE_NOT_ALLOWED', 'quality override requires human-review state')
      }
      const delivering = transitionRun(state, 'DELIVERING')
      return { ...delivering, qualityOverride: true }
    }
  }
}

export type BudgetDecision =
  | { allowed: true; remainingBudgetUnits: number }
  | { allowed: false; reason: 'INVALID_AMOUNT' | 'RUN_NOT_ACTIVE' | 'BUDGET_EXCEEDED'; remainingBudgetUnits: number }

export function evaluateBudget(state: RunPolicyState, requestedBudgetUnits: number): BudgetDecision {
  const remainingBudgetUnits = state.budgetUnits - state.committedBudgetUnits
  if (!Number.isSafeInteger(requestedBudgetUnits) || requestedBudgetUnits <= 0) {
    return { allowed: false, reason: 'INVALID_AMOUNT', remainingBudgetUnits }
  }
  if (isTerminalStatus(state.status) || state.status === 'PAUSED' || state.status === 'NEEDS_HUMAN') {
    return { allowed: false, reason: 'RUN_NOT_ACTIVE', remainingBudgetUnits }
  }
  if (requestedBudgetUnits > remainingBudgetUnits) {
    return { allowed: false, reason: 'BUDGET_EXCEEDED', remainingBudgetUnits }
  }
  return { allowed: true, remainingBudgetUnits: remainingBudgetUnits - requestedBudgetUnits }
}

export function reserveBudget(state: RunPolicyState, requestedBudgetUnits: number): RunPolicyState {
  const decision = evaluateBudget(state, requestedBudgetUnits)
  if (!decision.allowed) throw new PolicyError(decision.reason, 'media budget reservation rejected')
  return {
    ...state,
    committedBudgetUnits: state.committedBudgetUnits + requestedBudgetUnits,
    version: state.version + 1,
  }
}

export function releaseBudget(state: RunPolicyState, releasedBudgetUnits: number): RunPolicyState {
  if (!Number.isSafeInteger(releasedBudgetUnits) || releasedBudgetUnits <= 0) {
    throw new PolicyError('INVALID_AMOUNT', 'released budget must be a positive integer')
  }
  if (releasedBudgetUnits > state.committedBudgetUnits) {
    throw new PolicyError('BUDGET_RELEASE_EXCEEDS_COMMITMENT', 'cannot release more than committed budget')
  }
  return {
    ...state,
    committedBudgetUnits: state.committedBudgetUnits - releasedBudgetUnits,
    version: state.version + 1,
  }
}

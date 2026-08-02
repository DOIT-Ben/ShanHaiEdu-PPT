import { CONTRACT_VERSION, type RunStatus, type TechnicalRecovery } from '../contracts'
import type { AgentTransaction, ClockPort, RunRecord } from './ports'
import { transitionRun } from './policy'

const MAX_TECHNICAL_RECOVERY_ATTEMPTS = 5
const RECOVERABLE_STATES = new Set<RunStatus>([
  'PLANNING', 'EXECUTING', 'PAGE_REVIEW', 'DECK_REVIEW', 'REVISING', 'DELIVERING',
])

export type TechnicalFailureDisposition = 'RETRYABLE' | 'NON_RETRYABLE'

/**
 * Separates transient Provider failures from configuration failures that only
 * an operator can resolve. Both are technical failures, never content review.
 */
export function technicalFailureDisposition(errorCode: string): TechnicalFailureDisposition | null {
  const normalized = errorCode.toUpperCase()
  if (/(^|_)(401|403|404)(_|$)|AUTH|PERMISSION|MODEL_(FORBIDDEN|NOT_FOUND)|CONTENT_POLICY|UNSUPPORTED/.test(normalized)) {
    return 'NON_RETRYABLE'
  }
  return /TIMEOUT|RATE_LIMIT|429|408|425|5\d\d|UNAVAILABLE|TEMPORARY|GATEWAY|NETWORK|UNKNOWN|NO_HEALTHY_ROUTE|SUBMISSION_NOT_FOUND|VISUAL_REVIEW_FAILED|PAGE_REVIEW_FAILED|DECK_REVIEW_FAILED|DELIVERY_FAILED/.test(normalized)
    ? 'RETRYABLE'
    : null
}

export function isTechnicalFailureCode(errorCode: string) {
  return technicalFailureDisposition(errorCode) !== null
}

function retryDelayMs(attempt: number) {
  return [2_000, 10_000, 30_000, 60_000, 60_000][Math.max(0, Math.min(4, attempt - 1))]!
}

function recoveryState(run: RunRecord, resumeState: TechnicalRecovery['resumeState'], reason: string, now: Date): TechnicalRecovery {
  const previous = run.technicalRecovery
  const repeated = previous?.resumeState === resumeState
  const attempt = repeated ? previous.attempt + 1 : 1
  const retryable = technicalFailureDisposition(reason) === 'RETRYABLE' && attempt < MAX_TECHNICAL_RECOVERY_ATTEMPTS
  return {
    resumeState,
    reason,
    retryable,
    attempt: Math.min(attempt, MAX_TECHNICAL_RECOVERY_ATTEMPTS),
    maxAttempts: MAX_TECHNICAL_RECOVERY_ATTEMPTS,
    nextAttemptAt: retryable ? new Date(now.getTime() + retryDelayMs(attempt)).toISOString() : null,
    active: true,
  }
}

/** Moves V4 technical failures out of the user-approval workflow. */
export function beginTechnicalRecovery(transaction: AgentTransaction, clock: ClockPort, reason: string) {
  const run = transaction.run
  if (run.presentationMode !== 'VISUAL_DECK_V4' || !RECOVERABLE_STATES.has(run.status) || !technicalFailureDisposition(reason)) return null
  const now = clock.now()
  const resumeState = run.status as TechnicalRecovery['resumeState']
  const recovery = recoveryState(run, resumeState, reason, now)
  if (!recovery.retryable) {
    const policy = transitionRun(run, 'NEEDS_HUMAN')
    const exhausted: TechnicalRecovery = { ...recovery, active: false, nextAttemptAt: null }
    const updated: RunRecord = {
      ...run,
      ...policy,
      technicalRecovery: exhausted,
      updatedAt: now.toISOString(),
    }
    transaction.putRun(updated)
    transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'phase.changed',
      payload: {
        from: run.status,
        to: 'NEEDS_HUMAN',
        reason: recovery.attempt >= MAX_TECHNICAL_RECOVERY_ATTEMPTS
          ? 'TECHNICAL_RECOVERY_EXHAUSTED'
          : 'TECHNICAL_CONFIGURATION_REQUIRED',
      },
    })
    transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'technical.recovery.completed', payload: exhausted })
    return updated
  }
  const policy = transitionRun(run, 'RECOVERING')
  const updated: RunRecord = {
    ...run,
    ...policy,
    technicalRecovery: recovery,
    updatedAt: now.toISOString(),
  }
  transaction.putRun(updated)
  transaction.appendEvent({
    schemaVersion: CONTRACT_VERSION,
    type: 'phase.changed',
    payload: { from: run.status, to: 'RECOVERING', reason },
  })
  transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'technical.recovery.started', payload: recovery })
  return updated
}

/** Restores the persisted phase after its bounded retry delay. */
export function resumeTechnicalRecovery(transaction: AgentTransaction, clock: ClockPort) {
  const run = transaction.run
  const recovery = run.technicalRecovery
  if (run.status !== 'RECOVERING' || !recovery || !recovery.active || !recovery.retryable) return null
  if (!recovery.nextAttemptAt || Date.parse(recovery.nextAttemptAt) > clock.now().getTime()) return null
  const policy = transitionRun(run, recovery.resumeState)
  const completed: TechnicalRecovery = { ...recovery, active: false, nextAttemptAt: null }
  const updated: RunRecord = {
    ...run,
    ...policy,
    technicalRecovery: completed,
    updatedAt: clock.now().toISOString(),
  }
  transaction.putRun(updated)
  transaction.appendEvent({
    schemaVersion: CONTRACT_VERSION,
    type: 'phase.changed',
    payload: { from: 'RECOVERING', to: recovery.resumeState, reason: 'TECHNICAL_RECOVERY_RETRY' },
  })
  transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'technical.recovery.completed', payload: completed })
  return updated
}

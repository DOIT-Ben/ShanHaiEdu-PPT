import {
  CONTRACT_VERSION,
  type RunStatus,
  type TechnicalRecovery,
  type V4RunFailureCode,
  type PublicErrorCategory,
} from '../contracts'
import type {
  AgentTransaction,
  ClockPort,
  RunRecord,
  StepRecord,
  TechnicalFailure,
  TechnicalFailureDisposition as FailureDisposition,
} from './ports'
import { transitionRun } from './policy'
import { failVisualDeckV4Transaction, reconcileVisualDeckV4TerminalState } from './v4-lifecycle'

const MAX_TECHNICAL_RECOVERY_ATTEMPTS = 5
const RECOVERABLE_STATES = new Set<RunStatus>([
  'PLANNING', 'EXECUTING', 'PAGE_REVIEW', 'DECK_REVIEW', 'REVISING', 'DELIVERING',
])
const RETRYABLE_PROVIDER_FAILURE_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'NO_HEALTHY_ROUTE',
  'NO_HEALTHY_ROUTE_BEFORE_SUBMIT',
  'IDEMPOTENCY_SUBMISSION_UNKNOWN',
  'PROVIDER_SUBMISSION_UNKNOWN',
  'PROVIDER_SUBMISSION_NOT_FOUND',
  'MEDIA_SUBMISSION_UNKNOWN',
])
const PROVIDER_CONTRACT_FAILURE_CODES = new Set([
  'INVALID_IMAGE_PROMPT',
  'INVALID_IMAGE_REQUEST',
])
const NON_RETRYABLE_AUTHENTICATION_FAILURE_CODES = new Set([
  'MODEL_AUTH_FAILED',
  'BATCH_BUDGET_FINALIZATION_AUTH_FAILED',
])

export type TechnicalFailureDisposition = FailureDisposition

function isTechnicalContractFailure(errorCode: string) {
  return PROVIDER_CONTRACT_FAILURE_CODES.has(errorCode)
    || /(^|_)(CONTRACT_INVALID|INVALID_IMAGE_PROMPT)(_|$)/.test(errorCode)
    || /^(DECK_REVIEW_(SOURCE_COVERAGE_INCOMPLETE|SOURCE_REFERENCE_INVALID|SLIDE_REFERENCE_INVALID)|REVISION_SOURCE_REFERENCE_INVALID|PAGE_ARTIFACTS?_INCOMPLETE|PAGE_ARTIFACT_NOT_FOUND|BLUEPRINT_SLIDE_NOT_FOUND|DELIVERY_INPUT_FAILED)$/.test(errorCode)
}

function terminalFailureCode(failure: TechnicalFailure, attempt: number): V4RunFailureCode {
  if (failure.diagnosticCode === 'V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE'
    || failure.diagnosticCode === 'V4_CHAIN4_PROTOCOL_UNSUPPORTED'
    || failure.diagnosticCode === 'V4_MANUSCRIPT_CONTEXT_TOO_LARGE'
    || failure.diagnosticCode === 'V4_PLANNING_REQUEST_REPLAY_MISMATCH') {
    return failure.diagnosticCode
  }
  if (attempt >= MAX_TECHNICAL_RECOVERY_ATTEMPTS) return 'TECHNICAL_RECOVERY_EXHAUSTED'
  return failure.category === 'CONTRACT'
    ? 'TECHNICAL_CONTRACT_INVALID'
    : 'TECHNICAL_CONFIGURATION_REQUIRED'
}

function terminalLifecycleReason(resumeState: TechnicalRecovery['resumeState']) {
  switch (resumeState) {
    case 'PLANNING': return 'PLANNING_FAILED' as const
    case 'PAGE_REVIEW': return 'PAGE_REVIEW_FAILED' as const
    case 'DECK_REVIEW': return 'DECK_REVIEW_FAILED' as const
    case 'REVISING': return 'REVISION_FAILED' as const
    case 'DELIVERING': return 'DELIVERY_FAILED' as const
    case 'EXECUTING': return 'INTERNAL_FAILURE' as const
  }
}

/**
 * Separates transient Provider failures from configuration failures that only
 * an operator can resolve. Both are technical failures, never content review.
 */
export function technicalFailureDisposition(errorCode: string): TechnicalFailureDisposition | null {
  const normalized = errorCode.toUpperCase()
  if (normalized === 'V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE'
    || normalized === 'V4_CHAIN4_PROTOCOL_UNSUPPORTED'
    || normalized === 'V4_MANUSCRIPT_CONTEXT_TOO_LARGE'
    || normalized === 'V4_PLANNING_REQUEST_REPLAY_MISMATCH') return 'NON_RETRYABLE'
  if (isTechnicalContractFailure(normalized)) return 'NON_RETRYABLE'
  if (NON_RETRYABLE_AUTHENTICATION_FAILURE_CODES.has(normalized)
    || /(^|_)(401|403|404)(_|$)|PERMISSION|MODEL_(FORBIDDEN|NOT_FOUND)|CONTENT_POLICY|UNSUPPORTED/.test(normalized)) {
    return 'NON_RETRYABLE'
  }
  if (/^(PROVIDER_REJECTED|IMAGE_TASK_FAILED)$/.test(normalized)) return 'NON_RETRYABLE'
  return /TIMEOUT|RATE_LIMIT|429|408|425|5\d\d|UNAVAILABLE|TEMPORARY|GATEWAY|NETWORK|UNKNOWN|NO_HEALTHY_ROUTE|MODEL_JSON_INVALID|SUBMISSION_NOT_FOUND|VISUAL_REVIEW_FAILED|PAGE_REVIEW_FAILED|DECK_REVIEW_FAILED|DELIVERY_FAILED|V4_PLANNING_STAGE_FAILED/.test(normalized)
    ? 'RETRYABLE'
    : null
}

export function isTechnicalFailureCode(errorCode: string) {
  return technicalFailureDisposition(errorCode) !== null
}

function boundedDiagnosticCode(errorCode: string, fallback: string) {
  const normalized = errorCode.trim()
  return (normalized || fallback).slice(0, 100)
}

function categoryForKnownCode(errorCode: string): TechnicalFailure['category'] {
  if (['V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE', 'V4_CHAIN4_PROTOCOL_UNSUPPORTED', 'V4_MANUSCRIPT_CONTEXT_TOO_LARGE', 'V4_PLANNING_REQUEST_REPLAY_MISMATCH'].includes(errorCode.toUpperCase())) return 'CONTRACT'
  if (isTechnicalContractFailure(errorCode.toUpperCase())) return 'CONTRACT'
  if (/^(HOST_|PPT_)USAGE_V2_/.test(errorCode.toUpperCase())) return 'USAGE_V2'
  if (/PROVIDER|MODEL_|GATEWAY|RATE_LIMIT|NO_HEALTHY_ROUTE/.test(errorCode.toUpperCase())) return 'PROVIDER'
  return 'INTERNAL'
}

export function technicalFailureForCode(errorCode: string): TechnicalFailure | null {
  const diagnosticCode = boundedDiagnosticCode(errorCode, 'TECHNICAL_FAILURE')
  const disposition = technicalFailureDisposition(diagnosticCode)
  return disposition
    ? { category: categoryForKnownCode(diagnosticCode), disposition, diagnosticCode }
    : null
}

export function providerTechnicalFailure(
  errorCode: string,
  options: Readonly<{
    httpStatus?: number
    disposition?: TechnicalFailureDisposition
    category?: Extract<TechnicalFailure['category'], 'PROVIDER' | 'CONTRACT'>
  }> = {},
): TechnicalFailure {
  const diagnosticCode = boundedDiagnosticCode(errorCode, 'PROVIDER_FAILURE')
  const transientStatus = options.httpStatus === 408
    || options.httpStatus === 425
    || options.httpStatus === 429
    || (options.httpStatus !== undefined && options.httpStatus >= 500)
  const disposition = options.disposition
    ?? (transientStatus
      ? 'RETRYABLE'
      : options.httpStatus !== undefined
        ? 'NON_RETRYABLE'
        : RETRYABLE_PROVIDER_FAILURE_CODES.has(diagnosticCode.toUpperCase()) ? 'RETRYABLE' : null)
    ?? 'NON_RETRYABLE'
  return {
    category: options.category
      ?? (PROVIDER_CONTRACT_FAILURE_CODES.has(diagnosticCode.toUpperCase()) ? 'CONTRACT' : 'PROVIDER'),
    disposition,
    diagnosticCode,
  }
}

export function usageV2TechnicalFailure(
  errorCode: string,
  outcome: 'REJECTED' | 'UNKNOWN',
): TechnicalFailure {
  return {
    category: 'USAGE_V2',
    disposition: outcome === 'UNKNOWN' ? 'RETRYABLE' : 'NON_RETRYABLE',
    diagnosticCode: boundedDiagnosticCode(errorCode, 'HOST_USAGE_V2_FAILURE'),
  }
}

export function hostTechnicalFailure(
  errorCode: string,
  disposition: TechnicalFailureDisposition,
): TechnicalFailure {
  return {
    category: 'HOST',
    disposition,
    diagnosticCode: boundedDiagnosticCode(errorCode, 'HOST_FAILURE'),
  }
}

export function contractTechnicalFailure(errorCode: string): TechnicalFailure {
  return {
    category: 'CONTRACT',
    disposition: 'NON_RETRYABLE',
    diagnosticCode: boundedDiagnosticCode(errorCode, 'TECHNICAL_CONTRACT_INVALID'),
  }
}

export function technicalFailureFromStep(step: Pick<StepRecord, 'errorCode' | 'output'>): TechnicalFailure | null {
  const output = step.output && typeof step.output === 'object' ? step.output as Record<string, unknown> : null
  const persisted = output?.technicalFailure
  if (persisted && typeof persisted === 'object') {
    const value = persisted as Record<string, unknown>
    const category = value.category
    const disposition = value.disposition
    const diagnosticCode = value.diagnosticCode
    if (['PROVIDER', 'CONTRACT', 'USAGE_V2', 'HOST', 'INTERNAL'].includes(String(category))
      && ['RETRYABLE', 'NON_RETRYABLE'].includes(String(disposition))
      && typeof diagnosticCode === 'string'
      && diagnosticCode.length > 0
      && diagnosticCode.length <= 100) {
      return {
        category: category as TechnicalFailure['category'],
        disposition: disposition as TechnicalFailureDisposition,
        diagnosticCode,
      }
    }
  }
  return step.errorCode ? technicalFailureForCode(step.errorCode) : null
}

function retryDelayMs(attempt: number) {
  return [2_000, 10_000, 30_000, 60_000, 60_000][Math.max(0, Math.min(4, attempt - 1))]!
}

function recoveryState(
  run: RunRecord,
  resumeState: TechnicalRecovery['resumeState'],
  failure: TechnicalFailure,
  now: Date,
): TechnicalRecovery {
  const previous = run.technicalRecovery
  const repeated = previous?.resumeState === resumeState
  const attempt = repeated ? previous.attempt + 1 : 1
  const retryable = failure.disposition === 'RETRYABLE' && attempt < MAX_TECHNICAL_RECOVERY_ATTEMPTS
  return {
    resumeState,
    reason: failure.diagnosticCode,
    category: publicCategoryForTechnicalFailure(failure.category),
    retryable,
    attempt: Math.min(attempt, MAX_TECHNICAL_RECOVERY_ATTEMPTS),
    maxAttempts: MAX_TECHNICAL_RECOVERY_ATTEMPTS,
    nextAttemptAt: retryable ? new Date(now.getTime() + retryDelayMs(attempt)).toISOString() : null,
    active: true,
  }
}

function publicCategoryForTechnicalFailure(category: TechnicalFailure['category']): PublicErrorCategory {
  switch (category) {
    case 'PROVIDER': return 'PROVIDER'
    case 'USAGE_V2': return 'USAGE_V2'
    case 'CONTRACT': return 'CONTRACT'
    case 'HOST': return 'CONTRACT'
    case 'INTERNAL': return 'INTERNAL'
  }
}

/** Moves V4 technical failures out of the user-approval workflow. */
export function beginTechnicalRecovery(
  transaction: AgentTransaction,
  clock: ClockPort,
  input: string | TechnicalFailure,
) {
  const run = transaction.run
  const failure = typeof input === 'string' ? technicalFailureForCode(input) : input
  if (run.presentationMode !== 'VISUAL_DECK_V4' || !RECOVERABLE_STATES.has(run.status) || !failure) return null
  const now = clock.now()
  const resumeState = run.status as TechnicalRecovery['resumeState']
  const recovery = recoveryState(run, resumeState, failure, now)
  if (!recovery.retryable) {
    const exhausted: TechnicalRecovery = { ...recovery, active: false, nextAttemptAt: null }
    if (run.presentationMode === 'VISUAL_DECK_V4') {
      transaction.putRun({ ...run, technicalRecovery: exhausted, updatedAt: now.toISOString() })
      transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'technical.recovery.completed', payload: exhausted })
      failVisualDeckV4Transaction({
        transaction,
        clock,
        errorCode: terminalFailureCode(failure, recovery.attempt),
        reason: terminalLifecycleReason(resumeState),
        category: publicCategoryForTechnicalFailure(failure.category),
      })
      return transaction.run
    }
    const policy = transitionRun(run, 'NEEDS_HUMAN')
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
        reason: terminalFailureCode(failure, recovery.attempt),
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
    payload: { from: run.status, to: 'RECOVERING', reason: failure.diagnosticCode },
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
  if (recovery.reason === 'TERMINAL_ACCOUNTING_PENDING' && run.pendingTerminalFailure) {
    return reconcileVisualDeckV4TerminalState(transaction, clock)
  }
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

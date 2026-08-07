import type { QuickDeckEvaluationRecord } from './quick-deck-evaluation-ports'
import { quickDeckSubmissionFailureCode } from './quick-deck-evaluation-submission-failure'

export type QuickDeckInterruptedRecovery = Readonly<{
  record: QuickDeckEvaluationRecord
  action: 'RESUMED' | 'CONTINUED' | 'DRAINING' | 'PACKAGING' | 'FAILED'
}>

function isTerminal(page: QuickDeckEvaluationRecord['pages'][number]) {
  return page.status === 'COMPLETED' || page.status === 'FAILED'
}

/**
 * A crash during submission is never retried: pages explicitly marked unknown
 * are looked up by their original key, while untouched pages are skipped.
 */
export function recoverInterruptedQuickDeckEvaluation(
  record: QuickDeckEvaluationRecord,
  input: Readonly<{ now: string; defaultDrainDeadline: string }>,
): QuickDeckInterruptedRecovery | null {
  if (record.status === 'QUEUED') return null
  if (record.status === 'PACKAGING') {
    return {
      action: 'PACKAGING',
      record: {
        ...record,
        phase: 'PPTX_PACKAGING',
        errorCode: null,
        nextAttemptAt: input.now,
        updatedAt: input.now,
      },
    }
  }
  if (record.status === 'PLANNING') {
    return {
      action: 'FAILED',
      record: {
        ...record,
        status: 'FAILED',
        phase: 'FAILED',
        errorCode: 'EVALUATION_INTERRUPTED',
        pendingFailure: null,
        completedAt: input.now,
        nextAttemptAt: null,
        updatedAt: input.now,
      },
    }
  }
  if (!['SUBMITTING_IMAGES', 'GENERATING'].includes(record.status)) return null

  const pages = record.pages.map((page) => page.status === 'PENDING' && page.submissionState === 'NOT_SUBMITTED'
    ? { ...page, status: 'FAILED' as const, errorCode: 'EVALUATION_IMAGE_SUBMISSION_SKIPPED' }
    : page)
  const fullyPersistedSuccessfulSubmission = record.status === 'SUBMITTING_IMAGES'
    && record.pendingFailure === null
    && pages.length === record.request.slideCount
    && pages.every((page) => page.submissionState === 'SUBMITTED'
      && page.operationId !== null
      && page.errorCode === null)
  if (fullyPersistedSuccessfulSubmission) {
    return {
      action: 'RESUMED',
      record: {
        ...record,
        pages,
        status: 'GENERATING',
        phase: 'IMAGE_GENERATION',
        errorCode: null,
        pendingFailure: null,
        drainStartedAt: null,
        drainDeadline: null,
        nextAttemptAt: input.now,
        updatedAt: input.now,
      },
    }
  }
  const unresolved = pages.some((page) => !isTerminal(page))
  const pendingFailure = record.pendingFailure ?? quickDeckSubmissionFailureCode(pages)
  if (!unresolved) {
    return {
      action: 'FAILED',
      record: {
        ...record,
        pages,
        status: 'FAILED',
        phase: 'FAILED',
        errorCode: pendingFailure,
        pendingFailure: null,
        completedAt: input.now,
        nextAttemptAt: null,
        updatedAt: input.now,
      },
    }
  }
  if (record.status === 'GENERATING' && record.pendingFailure === null
    && pages.every((page) => page.status !== 'PENDING' || page.submissionState !== 'UNKNOWN')) {
    return {
      action: 'CONTINUED',
      record: {
        ...record,
        pages,
        nextAttemptAt: input.now,
        updatedAt: input.now,
      },
    }
  }
  return {
    action: 'DRAINING',
    record: {
      ...record,
      pages,
      status: 'GENERATING',
      phase: 'IMAGE_GENERATION',
      errorCode: null,
      pendingFailure,
      drainStartedAt: record.drainStartedAt ?? input.now,
      drainDeadline: record.drainDeadline ?? input.defaultDrainDeadline,
      nextAttemptAt: input.now,
      updatedAt: input.now,
    },
  }
}

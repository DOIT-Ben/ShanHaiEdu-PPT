import type { QuickDeckEvaluationFailureCode } from '../quick-deck-evaluation-contracts'
import type { QuickDeckEvaluationPageRecord } from './quick-deck-evaluation-ports'

export function quickDeckSubmissionFailureCode(
  pages: readonly QuickDeckEvaluationPageRecord[],
): QuickDeckEvaluationFailureCode {
  if (pages.some((page) => page.errorCode === 'EVALUATION_MODEL_NOT_READY')) {
    return 'EVALUATION_MODEL_NOT_READY'
  }
  if (pages.some((page) => page.errorCode === 'EVALUATION_MODEL_UNAVAILABLE')) {
    return 'EVALUATION_MODEL_UNAVAILABLE'
  }
  if (pages.some((page) => page.submissionState === 'SUBMITTED')) {
    return 'EVALUATION_IMAGE_SUBMISSION_PARTIAL'
  }
  return pages.some((page) => page.submissionState === 'UNKNOWN')
    ? 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN'
    : 'EVALUATION_IMAGE_SUBMISSION_FAILED'
}

import type { StepRecord } from './ports'

export function isPendingMediaReconciliationStep(
  step: Pick<StepRecord, 'tool' | 'status' | 'externalOperationId'>,
) {
  return step.tool === 'generate_slide_image'
    && (['SUBMITTING', 'WAITING', 'RELEASING', 'SUBMISSION_UNKNOWN'].includes(step.status)
      || (step.status === 'BILLING_UNKNOWN' && typeof step.externalOperationId === 'string' && step.externalOperationId.length > 0))
}

/** A worker reconciliation lease covers either pending Provider media or V4 batch accounting. */
export function isPendingRunReconciliationStep(
  step: Pick<StepRecord, 'tool' | 'status' | 'externalOperationId'>,
) {
  return isPendingMediaReconciliationStep(step)
    || (step.tool === 'generate_image_batch' && step.status === 'BILLING_UNKNOWN')
    || (step.tool === 'report_usage_v2' && step.status === 'RUNNING')
    || (step.tool === 'finalize_usage_v2' && step.status === 'RUNNING')
}

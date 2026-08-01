import type { StepRecord } from './ports'

export function isPendingMediaReconciliationStep(
  step: Pick<StepRecord, 'tool' | 'status' | 'externalOperationId'>,
) {
  return step.tool === 'generate_slide_image'
    && (['WAITING', 'RELEASING'].includes(step.status)
      || (step.status === 'BILLING_UNKNOWN' && typeof step.externalOperationId === 'string' && step.externalOperationId.length > 0))
}

/** A worker reconciliation lease covers either pending Provider media or V4 batch accounting. */
export function isPendingRunReconciliationStep(
  step: Pick<StepRecord, 'tool' | 'status' | 'externalOperationId'>,
) {
  return isPendingMediaReconciliationStep(step)
    || (step.tool === 'generate_image_batch' && step.status === 'BILLING_UNKNOWN')
}

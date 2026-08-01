import type { StepRecord } from './ports'

export function isPendingMediaReconciliationStep(
  step: Pick<StepRecord, 'tool' | 'status' | 'externalOperationId'>,
) {
  return step.tool === 'generate_slide_image'
    && (['WAITING', 'RELEASING'].includes(step.status)
      || (step.status === 'BILLING_UNKNOWN' && typeof step.externalOperationId === 'string' && step.externalOperationId.length > 0))
}

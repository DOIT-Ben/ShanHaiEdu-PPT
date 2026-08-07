import { CONTRACT_VERSION } from '../contracts'
import type { ExactDiagramSpec } from './v4-constraint-compiler'
import { hashInput } from './hash'
import { contractTechnicalFailure } from './technical-recovery'
import type { AgentRepository, ClockPort, RunRecord, StepRecord, TechnicalFailure } from './ports'

export type ControlledRasterFailureCode =
  | 'CONTROLLED_RASTER_ASPECT_RATIO_INVALID'
  | 'CONTROLLED_RASTER_RENDER_FAILED'

function technicalFailureFor(code: ControlledRasterFailureCode): TechnicalFailure {
  if (code === 'CONTROLLED_RASTER_ASPECT_RATIO_INVALID') return contractTechnicalFailure(code)
  return { category: 'INTERNAL', disposition: 'NON_RETRYABLE', diagnosticCode: code }
}

/** Records a local raster failure as a zero-cost page result so its batch can close. */
export async function persistControlledRasterFailure(input: Readonly<{
  repository: AgentRepository
  clock: ClockPort
  run: RunRecord
  step: Readonly<{
    id: string
    idempotencyKey: string
    slideId: string
    versionId: string
  }>
  inputHash: string
  diagram: ExactDiagramSpec
  errorCode: ControlledRasterFailureCode
  observedDimensions?: Readonly<{ width: number; height: number }>
}>): Promise<StepRecord> {
  const technicalFailure = technicalFailureFor(input.errorCode)
  return input.repository.transact(input.run.id, (transaction) => {
    const existing = transaction.getStep(input.step.idempotencyKey)
    if (existing) {
      if (existing.inputHash !== input.inputHash || existing.tool !== 'generate_slide_image') {
        throw new Error('STEP_IDEMPOTENCY_CONFLICT')
      }
      if (['COMPLETED', 'FAILED'].includes(existing.status)) return existing
      if (existing.status !== 'RESERVED' || existing.externalOperationId) {
        throw new Error('CONTROLLED_RASTER_STEP_NOT_REPLACEABLE')
      }
    }
    const now = input.clock.now().toISOString()
    const step: StepRecord = {
      id: input.step.id,
      runId: input.run.id,
      idempotencyKey: input.step.idempotencyKey,
      inputHash: input.inputHash,
      tool: 'generate_slide_image',
      status: 'FAILED',
      budgetUnits: 0,
      budgetReservationId: null,
      externalOperationId: null,
      errorCode: input.errorCode,
      output: {
        slideId: input.step.slideId,
        versionId: input.step.versionId,
        renderStrategy: 'CONTROLLED_RASTER',
        diagramHash: hashInput(input.diagram),
        ...(input.observedDimensions ? {
          imageWidth: input.observedDimensions.width,
          imageHeight: input.observedDimensions.height,
        } : {}),
        technicalFailure,
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    transaction.putStep(step)
    transaction.appendEvent({
      schemaVersion: CONTRACT_VERSION,
      type: 'tool.failed',
      payload: { stepId: step.id, errorCode: input.errorCode, retryable: false },
    })
    return step
  })
}

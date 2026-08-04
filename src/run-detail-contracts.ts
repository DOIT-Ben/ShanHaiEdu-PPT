import { z } from 'zod'
import { CONTRACT_VERSION, runSnapshotSchema } from './contracts'
import { publicDeliveryRecordSchema } from './presentation-contracts'

export const runDetailSchema = runSnapshotSchema.safeExtend({
  blueprint: runSnapshotSchema.shape.blueprint.unwrap(),
  generationPlan: runSnapshotSchema.shape.generationPlan.unwrap(),
  deliveries: z.array(publicDeliveryRecordSchema).max(1),
  deliveryAvailability: runSnapshotSchema.shape.deliveryAvailability.unwrap(),
  issues: runSnapshotSchema.shape.issues.unwrap(),
  progress: runSnapshotSchema.shape.progress.unwrap(),
}).superRefine((value, context) => {
  if (value.deliveryAvailability.state === 'UNAVAILABLE') {
    if (value.deliveries.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['deliveries'],
        message: 'unavailable RunDetail cannot expose a public delivery',
      })
    }
    return
  }

  if (value.status !== 'COMPLETED') {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'available RunDetail requires completed status',
    })
  }
  if (value.deliveries.length !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['deliveries'],
      message: 'available RunDetail requires exactly one public delivery',
    })
    return
  }

  const delivery = value.deliveries[0]!
  if (delivery.runId !== value.id) {
    context.addIssue({
      code: 'custom',
      path: ['deliveries', 0, 'runId'],
      message: 'available delivery must belong to RunDetail',
    })
  }
  if (delivery.id !== value.deliveryAvailability.deliveryId) {
    context.addIssue({
      code: 'custom',
      path: ['deliveryAvailability', 'deliveryId'],
      message: 'deliveryAvailability must identify the public delivery',
    })
  }
  if (delivery.revisionRound !== value.revisionRound) {
    context.addIssue({
      code: 'custom',
      path: ['deliveries', 0, 'revisionRound'],
      message: 'available delivery must match the current Run revision',
    })
  }
})

export type RunDetail = z.output<typeof runDetailSchema>

export const runDetailEnvelopeSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  requestId: z.string().trim().min(1).max(160),
  data: runDetailSchema,
}).strict()

export const createRunEnvelopeSchema = runDetailEnvelopeSchema.extend({
  replayed: z.boolean(),
}).strict()

export type RunDetailEnvelope = z.output<typeof runDetailEnvelopeSchema>
export type CreateRunEnvelope = z.output<typeof createRunEnvelopeSchema>

import { z } from 'zod'

const identifierSchema = z.string().trim().min(1).max(200)
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const currencySchema = z.string().regex(/^[A-Z]{3}$/)
export const usageDateTimeSchema = z.string().datetime()
const nullableDateTimeSchema = usageDateTimeSchema.nullable()

export const usageAccountingProtocolSchema = z.enum([
  'LEGACY_RESERVATION_V1',
  'FRAMEFLOW_USAGE_V2',
])

export const providerBillingSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('CHARGED'),
    actualCostAmountMicros: nonnegativeSafeIntegerSchema,
    currency: currencySchema,
    pricingVersion: identifierSchema,
  }).strict(),
  z.object({
    result: z.literal('NOT_CHARGED'),
    actualCostAmountMicros: z.literal(0),
    currency: currencySchema,
    pricingVersion: identifierSchema,
  }).strict(),
  z.object({
    result: z.literal('UNKNOWN'),
    estimatedCostAmountMicros: nonnegativeSafeIntegerSchema.nullable(),
    currency: currencySchema,
    pricingVersion: identifierSchema,
  }).strict(),
])

const usageEventShape = {
  schemaVersion: z.literal('2'),
  eventId: identifierSchema,
  sequence: z.number().int().positive(),
  eventType: z.enum(['OPERATION_OBSERVED', 'BILLING_RESOLVED']),
  pptRunId: identifierSchema,
  batchId: identifierSchema,
  pageNumber: z.number().int().min(1).max(50),
  revisionRound: z.number().int().min(0).max(100),
  idempotencyKey: identifierSchema,
  providerOperationId: identifierSchema,
  model: identifierSchema,
  status: z.enum(['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  providerBilling: providerBillingSchema,
  operationCreatedAt: usageDateTimeSchema,
  operationCompletedAt: nullableDateTimeSchema,
  eventAt: usageDateTimeSchema,
} as const

export const usageOperationEventV2Schema = z.object(usageEventShape).strict().superRefine((value, context) => {
  const terminal = value.status !== 'PROCESSING'
  if (terminal !== Boolean(value.operationCompletedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['operationCompletedAt'],
      message: terminal ? 'terminal operation requires completion time' : 'processing operation cannot be completed',
    })
  }
  if (value.operationCompletedAt && Date.parse(value.operationCompletedAt) < Date.parse(value.operationCreatedAt)) {
    context.addIssue({ code: 'custom', path: ['operationCompletedAt'], message: 'completion precedes creation' })
  }
  if (value.eventType === 'BILLING_RESOLVED' && value.providerBilling.result === 'UNKNOWN') {
    context.addIssue({ code: 'custom', path: ['providerBilling'], message: 'billing resolution must be final' })
  }
})

export const usagePermitRequestSchema = z.object({
  operationIdempotencyKey: identifierSchema,
  pageNumber: z.number().int().min(1).max(50),
  revisionRound: z.number().int().min(0).max(100),
  model: identifierSchema,
}).strict()

export const usagePermitSchema = z.discriminatedUnion('allowed', [
  z.object({
    allowed: z.literal(true),
    permitId: identifierSchema,
    pricingVersion: identifierSchema,
    userPriceMilli: nonnegativeSafeIntegerSchema,
  }).strict(),
  z.object({
    allowed: z.literal(false),
    stopReason: z.enum(['AUTHORIZATION_CAP_REACHED', 'PROVIDER_SAFETY_CAP_REACHED']),
    authorizedOperations: nonnegativeSafeIntegerSchema,
    authorizationCapOperations: nonnegativeSafeIntegerSchema,
    providerSpendSafetyCapOperations: nonnegativeSafeIntegerSchema,
  }).strict(),
])

export const usageRunBillSchema = z.object({
  pptRunId: identifierSchema,
  authorizationReservationId: identifierSchema,
  accountingMode: z.enum(['USAGE_V2', 'LEGACY_BATCH']),
  status: z.enum(['ACTIVE', 'RECONCILING', 'REVIEW_REQUIRED', 'SETTLED', 'CAP_EXCEEDED', 'LEGACY_RECONCILIATION']),
  authorizationCapMilli: nonnegativeSafeIntegerSchema,
  authorizedModel: identifierSchema,
  authorizedUnits: nonnegativeSafeIntegerSchema,
  pricingVersion: identifierSchema,
  unitPriceMilli: nonnegativeSafeIntegerSchema,
  providerSpendSafetyCapOperations: nonnegativeSafeIntegerSchema,
  generatedOperations: nonnegativeSafeIntegerSchema,
  chargedOperations: nonnegativeSafeIntegerSchema,
  notChargedOperations: nonnegativeSafeIntegerSchema,
  unknownOperations: nonnegativeSafeIntegerSchema,
  chargeableMilli: nonnegativeSafeIntegerSchema,
  settledMilli: nonnegativeSafeIntegerSchema,
  releasedMilli: nonnegativeSafeIntegerSchema,
  providerCosts: z.array(z.object({
    currency: currencySchema,
    actualAmountMicros: nonnegativeSafeIntegerSchema,
    estimatedAmountMicros: nonnegativeSafeIntegerSchema,
  }).strict()).max(32),
  lastEventSequence: nonnegativeSafeIntegerSchema,
  lastEventAt: nullableDateTimeSchema,
  settledAt: nullableDateTimeSchema,
  firstUnknownAt: nullableDateTimeSchema,
  reconciliationAttempts: nonnegativeSafeIntegerSchema,
  nextReconcileAt: nullableDateTimeSchema,
  reconciliationDeadlineAt: nullableDateTimeSchema,
  reconciliationLastError: z.string().max(500).nullable(),
}).strict()

export const usagePermitEnvelopeSchema = z.object({
  data: z.object({ permit: usagePermitSchema }).strict(),
}).strict()

export const usageEventEnvelopeSchema = z.object({
  data: z.object({
    replayed: z.boolean(),
    bill: usageRunBillSchema,
  }).strict(),
}).strict()

export const usageBillEnvelopeSchema = z.object({
  data: z.object({ bill: usageRunBillSchema }).strict(),
}).strict()

export type UsageAccountingProtocol = z.infer<typeof usageAccountingProtocolSchema>
export type ProviderBilling = z.infer<typeof providerBillingSchema>
export type UsageOperationEventV2 = z.infer<typeof usageOperationEventV2Schema>
export type UsagePermit = z.infer<typeof usagePermitSchema>
export type UsageRunBill = z.infer<typeof usageRunBillSchema>

export class UsageAccountingRequestError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: 'REJECTED' | 'UNKNOWN',
    message = code,
  ) {
    super(message)
    this.name = 'UsageAccountingRequestError'
  }
}

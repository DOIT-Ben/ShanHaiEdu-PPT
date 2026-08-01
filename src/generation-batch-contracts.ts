import { z } from 'zod'

export const generationBatchSchema = z.object({
  batchId: z.string().regex(/^genbatch_[a-f0-9]{32}$/),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  revisionRound: z.number().int().min(0).max(4),
  submissionMode: z.literal('GATEWAY_INDIVIDUAL_OPERATIONS'),
  pageCount: z.number().int().positive().max(50),
  pages: z.array(z.object({
    pageNumber: z.number().int().positive().max(50),
    idempotencyKey: z.string().min(1).max(160),
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(50),
  accounting: z.object({
    estimatedUnits: z.number().int().nonnegative(),
    committedUnits: z.number().int().nonnegative(),
    settledUnits: z.number().int().nonnegative(),
    releasedUnits: z.number().int().nonnegative(),
    reconciliationUnits: z.number().int().nonnegative(),
    authorization: z.enum(['PENDING', 'RESERVED', 'UNKNOWN', 'REJECTED']),
    settlement: z.enum(['NOT_READY', 'PENDING', 'SETTLED', 'RELEASED', 'UNKNOWN']),
  }).strict(),
  progress: z.object({
    submitted: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).strict(),
  status: z.enum(['PREPARED', 'PROCESSING', 'RECONCILIATION_REQUIRED', 'COMPLETED']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.pages.length !== value.pageCount) {
    context.addIssue({ code: 'custom', path: ['pages'], message: 'generation batch must include every page exactly once' })
  }
  const pageNumbers = value.pages.map((page) => page.pageNumber)
  if (new Set(pageNumbers).size !== pageNumbers.length || pageNumbers.some((page, index) => page !== index + 1)) {
    context.addIssue({ code: 'custom', path: ['pages'], message: 'generation batch page numbers must be continuous' })
  }
  if (value.progress.completed + value.progress.failed > value.pageCount) {
    context.addIssue({ code: 'custom', path: ['progress'], message: 'completed and failed pages exceed batch size' })
  }
})

export type GenerationBatch = z.infer<typeof generationBatchSchema>

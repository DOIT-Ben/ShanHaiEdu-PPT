import { z } from 'zod'

export const terminalAccountingSchema = z.object({
  authorizedUnits: z.number().int().nonnegative(),
  submittedUnits: z.number().int().nonnegative(),
  settledUnits: z.number().int().nonnegative(),
  releasedUnits: z.number().int().nonnegative(),
  reconciliationUnits: z.number().int().nonnegative(),
  accountingStatus: z.enum(['FINAL', 'RECONCILIATION_REQUIRED']),
}).strict().superRefine((value, context) => {
  if (value.accountingStatus === 'FINAL'
    && (value.reconciliationUnits !== 0
      || value.settledUnits + value.releasedUnits !== value.authorizedUnits)) {
    context.addIssue({ code: 'custom', path: ['accountingStatus'], message: 'final accounting must fully allocate authorization' })
  }
})

export type TerminalAccounting = z.infer<typeof terminalAccountingSchema>

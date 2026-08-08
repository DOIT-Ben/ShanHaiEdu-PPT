import { ZodError } from 'zod'
import { V4_MANUSCRIPT_CONTEXT_TOO_LARGE } from '../visual-deck-v4-contracts'
import { hashInput } from './hash'
import { StructuredModelError, type ContractRepairIssue } from './ports'

export const MAX_REVISION_CONTRACT_ATTEMPTS = 2

export function revisionContractRepairIssues(error: unknown): readonly ContractRepairIssue[] | null {
  if (error instanceof StructuredModelError) {
    return error.code === 'MODEL_JSON_INVALID'
      ? [{ path: '$', message: error.code }]
      : null
  }
  if (error instanceof ZodError) {
    if (error.issues.some((issue) => issue.message === V4_MANUSCRIPT_CONTEXT_TOO_LARGE)) return null
    return error.issues.slice(0, 20).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '$'
      return { path: path.slice(0, 160), message: issue.message.slice(0, 500) }
    })
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,99}$/.test(error.message)) {
    return [{ path: '$', message: error.message }]
  }
  return null
}

export function revisionContractAttemptKey(idempotencyKey: string, attempt: number) {
  return attempt === 0
    ? idempotencyKey
    : `revision-contract-repair-${hashInput({ idempotencyKey, attempt })}`
}

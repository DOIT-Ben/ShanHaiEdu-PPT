export type ReflectionFailureLayer =
  | 'JSON_PARSE'
  | 'JSON_SCHEMA'
  | 'ZOD_SEMANTIC'
  | 'SCOPE_VIOLATION'
  | 'PROVIDER'

export type SafeContractIssue = Readonly<{
  issueCode: string
  path: readonly (string | number)[]
}>

const ISSUE_CODE = /^[A-Z0-9_]{1,120}$/

export class ReflectionContractError extends Error {
  readonly safeIssues: readonly SafeContractIssue[]

  constructor(
    readonly layer: Extract<ReflectionFailureLayer, 'ZOD_SEMANTIC' | 'SCOPE_VIOLATION'>,
    issueCode: string,
    path: readonly (string | number)[] = [],
  ) {
    const safeCode = ISSUE_CODE.test(issueCode) ? issueCode : 'REFLECTION_CONTRACT_INVALID'
    super(safeCode)
    this.name = 'ReflectionContractError'
    this.safeIssues = [{ issueCode: safeCode, path: path.slice(0, 12) }]
  }
}

export function semanticFailure(issueCode: string, path: readonly (string | number)[] = []): never {
  throw new ReflectionContractError('ZOD_SEMANTIC', issueCode, path)
}

export function scopeFailure(issueCode: string, path: readonly (string | number)[] = []): never {
  throw new ReflectionContractError('SCOPE_VIOLATION', issueCode, path)
}

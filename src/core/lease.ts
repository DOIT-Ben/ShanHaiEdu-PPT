import type { AgentRepository, ClockPort, RunRecord } from './ports'
import { isTerminalStatus } from './policy'

const RUNNABLE_STATES = new Set([
  'PLANNING',
  'EXECUTING',
  'PAGE_REVIEW',
  'DECK_REVIEW',
  'REVISING',
  'DELIVERING',
])

export type RunLease = Readonly<{
  token: string
  version: number
  until: string
}>

export class RunLeaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RunLeaseError'
  }
}

function isLeaseActive(run: RunRecord, now: Date) {
  return run.leaseToken !== null && run.leaseUntil !== null && new Date(run.leaseUntil).getTime() > now.getTime()
}

export async function acquireRunLease(input: Readonly<{
  repository: AgentRepository
  clock: ClockPort
  runId: string
  token: string
  ttlMs: number
}>): Promise<RunLease | null> {
  if (!input.token.trim()) throw new RunLeaseError('INVALID_LEASE_TOKEN', 'lease token is required')
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000) {
    throw new RunLeaseError('INVALID_LEASE_TTL', 'lease ttl must be at least 1000ms')
  }

  return input.repository.transact(input.runId, (transaction) => {
    const now = input.clock.now()
    if (isTerminalStatus(transaction.run.status) || !RUNNABLE_STATES.has(transaction.run.status)) return null
    if (isLeaseActive(transaction.run, now) && transaction.run.leaseToken !== input.token) return null
    const lease: RunLease = {
      token: input.token,
      version: transaction.run.leaseVersion + 1,
      until: new Date(now.getTime() + input.ttlMs).toISOString(),
    }
    transaction.putRun({
      ...transaction.run,
      leaseToken: lease.token,
      leaseUntil: lease.until,
      leaseVersion: lease.version,
      updatedAt: now.toISOString(),
    })
    return lease
  })
}

export async function renewRunLease(input: Readonly<{
  repository: AgentRepository
  clock: ClockPort
  runId: string
  lease: RunLease
  ttlMs: number
}>): Promise<RunLease> {
  return input.repository.transact(input.runId, (transaction) => {
    const now = input.clock.now()
    if (
      transaction.run.leaseToken !== input.lease.token ||
      transaction.run.leaseVersion !== input.lease.version ||
      !isLeaseActive(transaction.run, now)
    ) {
      throw new RunLeaseError('STALE_RUN_LEASE', 'run lease is stale or expired')
    }
    const renewed = { ...input.lease, until: new Date(now.getTime() + input.ttlMs).toISOString() }
    transaction.putRun({ ...transaction.run, leaseUntil: renewed.until, updatedAt: now.toISOString() })
    return renewed
  })
}

export async function releaseRunLease(input: Readonly<{
  repository: AgentRepository
  clock: ClockPort
  runId: string
  lease: RunLease
}>): Promise<void> {
  await input.repository.transact(input.runId, (transaction) => {
    if (
      transaction.run.leaseToken !== input.lease.token ||
      transaction.run.leaseVersion !== input.lease.version
    ) {
      throw new RunLeaseError('STALE_RUN_LEASE', 'run lease is stale')
    }
    transaction.putRun({
      ...transaction.run,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: input.clock.now().toISOString(),
    })
  })
}

export async function listRecoverableRunIds(input: Readonly<{
  repository: AgentRepository
  clock: ClockPort
  limit?: number
}>) {
  const now = input.clock.now()
  const limit = input.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RunLeaseError('INVALID_RECOVERY_LIMIT', 'recovery limit must be between 1 and 1000')
  }
  return (await input.repository.listRunnableRuns({ now: now.toISOString(), limit }))
    .map((run) => run.id)
}

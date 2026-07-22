import type { HostContext } from '../contracts'

export type PrincipalRateLimitScope = 'CREATE_RUN' | 'RUN_ACTION'

export type RateLimitDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; retryAfterSeconds: number }>

export interface PrincipalRateLimiterPort {
  consume(scope: PrincipalRateLimitScope, host: HostContext): RateLimitDecision
}

export type RateLimitPolicy = Readonly<{
  limit: number
  windowMs: number
}>

type RateLimitWindow = {
  count: number
  startedAt: number
  resetsAt: number
}

function validatePolicy(policy: RateLimitPolicy) {
  if (!Number.isSafeInteger(policy.limit) || policy.limit < 1 || policy.limit > 10_000) {
    throw new Error('RATE_LIMIT_POLICY_LIMIT_INVALID')
  }
  if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1_000 || policy.windowMs > 60 * 60_000) {
    throw new Error('RATE_LIMIT_POLICY_WINDOW_INVALID')
  }
}

function retryAfterSeconds(resetsAt: number, now: number) {
  return Math.max(1, Math.ceil((resetsAt - now) / 1_000))
}

export class InMemoryPrincipalRateLimiter implements PrincipalRateLimiterPort {
  private readonly policies: Readonly<Record<PrincipalRateLimitScope, RateLimitPolicy>>
  private readonly entries = new Map<string, RateLimitWindow>()
  private readonly now: () => number
  private readonly maxEntries: number
  private requestsSinceSweep = 0

  constructor(input: Readonly<{
    createRun: RateLimitPolicy
    runAction: RateLimitPolicy
    now?: () => number
    maxEntries?: number
  }>) {
    validatePolicy(input.createRun)
    validatePolicy(input.runAction)
    const maxEntries = input.maxEntries ?? 50_000
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000) {
      throw new Error('RATE_LIMIT_MAX_ENTRIES_INVALID')
    }
    this.policies = { CREATE_RUN: { ...input.createRun }, RUN_ACTION: { ...input.runAction } }
    this.now = input.now ?? Date.now
    this.maxEntries = maxEntries
  }

  consume(scope: PrincipalRateLimitScope, host: HostContext): RateLimitDecision {
    const now = this.now()
    if (!Number.isFinite(now)) throw new Error('RATE_LIMIT_CLOCK_INVALID')
    this.requestsSinceSweep += 1
    if (this.requestsSinceSweep >= 256) this.sweep(now)

    const policy = this.policies[scope]
    const key = JSON.stringify([scope, host.tenantId, host.externalUserId])
    let window = this.entries.get(key)
    if (window && (now < window.startedAt || now >= window.resetsAt)) {
      this.entries.delete(key)
      window = undefined
    }
    if (!window) {
      if (this.entries.size >= this.maxEntries) this.sweep(now)
      if (this.entries.size >= this.maxEntries) {
        let earliestReset = Number.POSITIVE_INFINITY
        for (const entry of this.entries.values()) earliestReset = Math.min(earliestReset, entry.resetsAt)
        return { allowed: false, retryAfterSeconds: retryAfterSeconds(earliestReset, now) }
      }
      this.entries.set(key, { count: 1, startedAt: now, resetsAt: now + policy.windowMs })
      return { allowed: true }
    }
    if (window.count >= policy.limit) {
      return { allowed: false, retryAfterSeconds: retryAfterSeconds(window.resetsAt, now) }
    }
    window.count += 1
    return { allowed: true }
  }

  private sweep(now: number) {
    for (const [key, window] of this.entries) {
      if (now < window.startedAt || now >= window.resetsAt) this.entries.delete(key)
    }
    this.requestsSinceSweep = 0
  }
}

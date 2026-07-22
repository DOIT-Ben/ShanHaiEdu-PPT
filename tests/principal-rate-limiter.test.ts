import { describe, expect, test } from 'bun:test'
import { InMemoryPrincipalRateLimiter } from '../src/http/principal-rate-limiter'

const frameflowUser = { tenantId: 'frameflow', externalUserId: 'user-1' }

function fixture(maxEntries?: number) {
  let now = 1_000
  const limiter = new InMemoryPrincipalRateLimiter({
    createRun: { limit: 2, windowMs: 60_000 },
    runAction: { limit: 1, windowMs: 30_000 },
    now: () => now,
    ...(maxEntries === undefined ? {} : { maxEntries }),
  })
  return { limiter, advance: (milliseconds: number) => { now += milliseconds } }
}

describe('in-memory principal rate limiter', () => {
  test('limits each operation scope independently and resets at the window boundary', () => {
    const { limiter, advance } = fixture()
    expect(limiter.consume('CREATE_RUN', frameflowUser)).toEqual({ allowed: true })
    expect(limiter.consume('CREATE_RUN', frameflowUser)).toEqual({ allowed: true })
    expect(limiter.consume('CREATE_RUN', frameflowUser)).toEqual({ allowed: false, retryAfterSeconds: 60 })
    expect(limiter.consume('RUN_ACTION', frameflowUser)).toEqual({ allowed: true })
    expect(limiter.consume('RUN_ACTION', frameflowUser)).toEqual({ allowed: false, retryAfterSeconds: 30 })

    advance(60_000)
    expect(limiter.consume('CREATE_RUN', frameflowUser)).toEqual({ allowed: true })
    expect(limiter.consume('RUN_ACTION', frameflowUser)).toEqual({ allowed: true })
  })

  test('isolates counters by tenant and external user', () => {
    const { limiter } = fixture()
    expect(limiter.consume('RUN_ACTION', frameflowUser)).toEqual({ allowed: true })
    expect(limiter.consume('RUN_ACTION', { ...frameflowUser, externalUserId: 'user-2' })).toEqual({ allowed: true })
    expect(limiter.consume('RUN_ACTION', { ...frameflowUser, tenantId: 'shanhaiedu' })).toEqual({ allowed: true })
    expect(limiter.consume('RUN_ACTION', frameflowUser)).toEqual({ allowed: false, retryAfterSeconds: 30 })
  })

  test('fails closed when the active principal capacity is exhausted', () => {
    const { limiter, advance } = fixture(1)
    expect(limiter.consume('CREATE_RUN', frameflowUser)).toEqual({ allowed: true })
    expect(limiter.consume('CREATE_RUN', { ...frameflowUser, externalUserId: 'user-2' }))
      .toEqual({ allowed: false, retryAfterSeconds: 60 })
    advance(60_000)
    expect(limiter.consume('CREATE_RUN', { ...frameflowUser, externalUserId: 'user-2' }))
      .toEqual({ allowed: true })
  })
})

import { randomUUID } from 'node:crypto'
import type { QuickDeckEvaluationRepository, QuickDeckEvaluationRecord } from '../core/quick-deck-evaluation-ports'
import { recoverInterruptedQuickDeckEvaluation } from '../core/quick-deck-evaluation-recovery'
import { quickDeckEvaluationEventSchema, type QuickDeckEvaluationEvent } from '../quick-deck-evaluation-contracts'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function active(status: QuickDeckEvaluationRecord['status']) {
  return ['QUEUED', 'PLANNING', 'SUBMITTING_IMAGES', 'GENERATING', 'PACKAGING'].includes(status)
}

export class InMemoryQuickDeckEvaluationRepository implements QuickDeckEvaluationRepository {
  readonly #records = new Map<string, QuickDeckEvaluationRecord>()
  readonly #events = new Map<string, QuickDeckEvaluationEvent[]>()
  readonly #leases = new Map<string, Readonly<{ token: string; until: string }>>()

  async create(input: Parameters<QuickDeckEvaluationRepository['create']>[0]) {
    const records = [...this.#records.values()]
    if (records.filter((record) => record.tenantId === input.record.tenantId && record.createdAt >= input.dayStart).length >= input.maxDailyJobs) {
      return 'DAILY_LIMIT' as const
    }
    if (records.filter((record) => record.tenantId === input.record.tenantId && active(record.status)).length >= input.maxActiveJobs) {
      return 'CONCURRENCY_LIMIT' as const
    }
    if (this.#records.has(input.record.id)) throw new Error('QUICK_DECK_EVALUATION_ALREADY_EXISTS')
    this.#records.set(input.record.id, clone(input.record))
    this.#events.set(input.record.id, [clone(quickDeckEvaluationEventSchema.parse({ ...input.event, sequence: 1 }))])
    return 'CREATED' as const
  }

  async get(jobId: string) {
    const record = this.#records.get(jobId)
    return record ? clone(record) : null
  }

  async save(input: Parameters<QuickDeckEvaluationRepository['save']>[0]) {
    if (!this.#records.has(input.record.id)) throw new Error('QUICK_DECK_EVALUATION_NOT_FOUND')
    this.#records.set(input.record.id, clone(input.record))
    if (!input.event) return
    const events = this.#events.get(input.record.id) ?? []
    events.push(clone(quickDeckEvaluationEventSchema.parse({ ...input.event, sequence: events.length + 1 })))
    this.#events.set(input.record.id, events)
  }

  async listRunnable(input: Parameters<QuickDeckEvaluationRepository['listRunnable']>[0]) {
    return [...this.#records.values()]
      .filter((record) => ['QUEUED', 'SUBMITTING_IMAGES', 'GENERATING', 'PACKAGING'].includes(record.status))
      .filter((record) => record.nextAttemptAt !== null && record.nextAttemptAt <= input.now)
      .filter((record) => record.expiresAt > input.now)
      .filter((record) => {
        const lease = this.#leases.get(record.id)
        return !lease || lease.until <= input.now
      })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map(clone)
  }

  async claimRunnable(input: Parameters<QuickDeckEvaluationRepository['claimRunnable']>[0]) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
      || !input.leaseToken.trim() || Date.parse(input.leaseUntil) <= Date.parse(input.now)) {
      throw new Error('QUICK_DECK_EVALUATION_LEASE_INPUT_INVALID')
    }
    const excluded = new Set(input.excludeJobIds ?? [])
    const claimed: QuickDeckEvaluationRecord[] = []
    for (const record of [...this.#records.values()]
      .filter((candidate) => ['QUEUED', 'SUBMITTING_IMAGES', 'GENERATING', 'PACKAGING'].includes(candidate.status))
      .filter((candidate) => candidate.nextAttemptAt !== null && candidate.nextAttemptAt <= input.now)
      .filter((candidate) => candidate.expiresAt > input.now)
      .filter((candidate) => !excluded.has(candidate.id))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))) {
      if (claimed.length >= input.limit) break
      const existing = this.#leases.get(record.id)
      if (existing && existing.until > input.now) continue
      this.#leases.set(record.id, { token: input.leaseToken, until: input.leaseUntil })
      claimed.push(clone(record))
    }
    return claimed
  }

  async saveClaimed(input: Parameters<QuickDeckEvaluationRepository['saveClaimed']>[0]) {
    const lease = this.#leases.get(input.record.id)
    if (!lease || lease.token !== input.leaseToken || lease.until <= input.now) return false
    this.#leases.set(input.record.id, { token: input.leaseToken, until: input.leaseUntil })
    await this.save({ record: input.record, ...(input.event ? { event: input.event } : {}) })
    return true
  }

  async releaseClaim(input: Parameters<QuickDeckEvaluationRepository['releaseClaim']>[0]) {
    const existing = this.#leases.get(input.jobId)
    if (!existing || existing.token !== input.leaseToken) return false
    this.#leases.delete(input.jobId)
    return true
  }

  async listExpired(input: Parameters<QuickDeckEvaluationRepository['listExpired']>[0]) {
    return [...this.#records.values()]
      .filter((record) => record.expiresAt <= input.now)
      .filter((record) => {
        const lease = this.#leases.get(record.id)
        return !lease || lease.until <= input.now
      })
      .filter((record) => record.status !== 'EXPIRED'
        || record.pages.some((page) => page.artifactId !== null)
        || record.pptx !== null
        || record.preview !== null
        || record.cleanupPending === true)
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt) || left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map(clone)
  }

  async readEvents(input: Parameters<QuickDeckEvaluationRepository['readEvents']>[0]) {
    const events = this.#events.get(input.jobId) ?? []
    const matching = events.filter((event) => event.sequence > input.afterSequence)
    const terminal = [...events].reverse().find((event) =>
      ['evaluation.failed', 'packaging.completed', 'evaluation.expired'].includes(event.type))
    return {
      events: matching.slice(0, input.limit).map(clone),
      hasMore: matching.length > input.limit,
      terminalSequence: terminal?.sequence ?? null,
    }
  }

  async recoverInterrupted(input: Parameters<QuickDeckEvaluationRepository['recoverInterrupted']>[0]) {
    for (const [jobId, lease] of this.#leases) {
      if (lease.until <= input.now) this.#leases.delete(jobId)
    }
    let changed = 0
    for (const record of [...this.#records.values()]) {
      const recovered = recoverInterruptedQuickDeckEvaluation(record, input)
      if (!recovered) continue
      await this.save({
        record: recovered.record,
        event: {
          schemaVersion: '1', jobId: recovered.record.id, eventId: `event-${randomUUID()}`,
          ...(recovered.action === 'FAILED'
            ? { type: 'evaluation.failed' as const, payload: { code: recovered.record.errorCode! } }
            : recovered.action === 'RESUMED'
              ? {
                  type: 'images.submitted' as const,
                  payload: {
                    submittedPages: recovered.record.pages.filter((page) => page.submissionState !== 'NOT_SUBMITTED').length,
                    totalPages: recovered.record.request.slideCount,
                  },
                }
              : {
                type: 'images.draining' as const,
                payload: {
                  pendingPages: recovered.record.pages.filter((page) => !['COMPLETED', 'FAILED'].includes(page.status)).length,
                  failedPages: recovered.record.pages.filter((page) => page.status === 'FAILED').length,
                  totalPages: recovered.record.request.slideCount,
                  drainDeadline: recovered.record.drainDeadline!,
                },
              }),
          occurredAt: input.now,
        },
      })
      changed += 1
    }
    return changed
  }
}

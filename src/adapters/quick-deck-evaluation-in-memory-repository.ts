import type { QuickDeckEvaluationRepository, QuickDeckEvaluationRecord } from '../core/quick-deck-evaluation-ports'
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
      .filter((record) => ['QUEUED', 'GENERATING'].includes(record.status))
      .filter((record) => record.nextAttemptAt !== null && record.nextAttemptAt <= input.now)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map(clone)
  }

  async listExpired(input: Parameters<QuickDeckEvaluationRepository['listExpired']>[0]) {
    return [...this.#records.values()]
      .filter((record) => record.expiresAt <= input.now)
      .filter((record) => record.status !== 'EXPIRED'
        || record.pages.some((page) => page.artifactId !== null)
        || record.pptx !== null
        || record.preview !== null)
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

  async failInterrupted(input: Parameters<QuickDeckEvaluationRepository['failInterrupted']>[0]) {
    let changed = 0
    for (const record of [...this.#records.values()]) {
      if (!active(record.status)) continue
      const failed: QuickDeckEvaluationRecord = {
        ...record,
        status: 'FAILED',
        phase: 'FAILED',
        errorCode: 'EVALUATION_INTERRUPTED',
        completedAt: input.now,
        nextAttemptAt: null,
        updatedAt: input.now,
      }
      await this.save({
        record: failed,
        event: {
          schemaVersion: '1', jobId: failed.id, eventId: `event-${failed.id}-interrupted`,
          type: 'evaluation.failed', payload: { code: 'EVALUATION_INTERRUPTED' }, occurredAt: input.now,
        },
      })
      changed += 1
    }
    return changed
  }
}

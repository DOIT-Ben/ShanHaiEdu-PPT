import type { AgentEvent } from '../contracts'
import type {
  AgentRepository,
  AgentTransaction,
  NewAgentEvent,
  PlanningFailureAggregate,
  PlanningFailureFilters,
  RunRecord,
  StepRecord,
} from '../core/ports'
import type { DeliveryRecord } from '../presentation-contracts'

type StoredRun = {
  run: RunRecord
  steps: Map<string, StepRecord>
  deliveries: Map<string, DeliveryRecord>
  events: AgentEvent[]
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class InMemoryAgentRepository implements AgentRepository {
  readonly #runs = new Map<string, StoredRun>()
  readonly #gates = new Map<string, Promise<void>>()

  async createRun(run: RunRecord) {
    if (this.#runs.has(run.id)) throw new Error(`run already exists: ${run.id}`)
    this.#runs.set(run.id, { run: clone(run), steps: new Map(), deliveries: new Map(), events: [] })
  }

  async getRun(runId: string) {
    return clone(this.#runs.get(runId)?.run ?? null)
  }

  async listRuns() {
    return [...this.#runs.values()].map((stored) => clone(stored.run))
  }

  async listSteps(runId: string) {
    const stored = this.#runs.get(runId)
    if (!stored) return []
    return [...stored.steps.values()].map(clone)
  }

  async listEvents(runId: string, afterSequence = 0) {
    const stored = this.#runs.get(runId)
    if (!stored) return []
    return stored.events.filter((event) => event.sequence > afterSequence).map(clone)
  }

  async listDeliveries(runId: string) {
    const stored = this.#runs.get(runId)
    if (!stored) return []
    return [...stored.deliveries.values()].map(clone)
  }

  async aggregatePlanningFailures(filters: PlanningFailureFilters) {
    const groups = new Map<string, PlanningFailureAggregate>()
    let totalFailures = 0
    for (const stored of this.#runs.values()) {
      if (stored.run.host.tenantId !== filters.tenantId) continue
      for (const event of stored.events) {
        if (event.type !== 'issue.detected' || !event.payload.planningFailure) continue
        const failure = event.payload.planningFailure
        if (filters.errorCode && failure.errorCode !== filters.errorCode) continue
        if (filters.model && failure.model !== filters.model) continue
        if (filters.contractVersion && failure.contractVersion !== filters.contractVersion) continue
        totalFailures += 1
        const key = JSON.stringify([failure.errorCode, failure.model, failure.contractVersion])
        const existing = groups.get(key)
        groups.set(key, existing
          ? {
              ...existing,
              count: existing.count + 1,
              lastOccurredAt: existing.lastOccurredAt > event.createdAt ? existing.lastOccurredAt : event.createdAt,
            }
          : {
              errorCode: failure.errorCode,
              model: failure.model,
              contractVersion: failure.contractVersion,
              count: 1,
              lastOccurredAt: event.createdAt,
            })
      }
    }
    return {
      groups: [...groups.values()]
        .sort((left, right) => right.count - left.count || right.lastOccurredAt.localeCompare(left.lastOccurredAt))
        .slice(0, 100),
      totalFailures,
    }
  }

  async transact<T>(runId: string, operation: (transaction: AgentTransaction) => T): Promise<T> {
    const previous = this.#gates.get(runId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.#gates.set(runId, current)
    await previous

    try {
      const stored = this.#runs.get(runId)
      if (!stored) throw new Error(`run not found: ${runId}`)
      let nextRun = clone(stored.run)
      const nextSteps = new Map([...stored.steps].map(([key, value]) => [key, clone(value)]))
      const nextDeliveries = new Map([...stored.deliveries].map(([key, value]) => [key, clone(value)]))
      const nextEvents = stored.events.map(clone)

      const transaction: AgentTransaction = {
        get run() { return nextRun },
        getStep(idempotencyKey) { return clone(nextSteps.get(idempotencyKey) ?? null) },
        listEvents() { return nextEvents.map(clone) },
        getDelivery(deliveryId) { return clone(nextDeliveries.get(deliveryId) ?? null) },
        putRun(run) { nextRun = clone(run) },
        putStep(step) { nextSteps.set(step.idempotencyKey, clone(step)) },
        putDelivery(delivery) { nextDeliveries.set(delivery.id, clone(delivery)) },
        appendEvent(event: NewAgentEvent) {
          const sequence = (nextEvents.at(-1)?.sequence ?? 0) + 1
          const created: AgentEvent = {
            ...clone(event),
            id: `${runId}:event:${sequence}`,
            runId,
            sequence,
            createdAt: nextRun.updatedAt,
          } as AgentEvent
          nextEvents.push(created)
          return clone(created)
        },
      }

      const result = operation(transaction)
      this.#runs.set(runId, { run: nextRun, steps: nextSteps, deliveries: nextDeliveries, events: nextEvents })
      return result
    } finally {
      release()
      if (this.#gates.get(runId) === current) this.#gates.delete(runId)
    }
  }
}

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
import { buildOperationsReport } from '../core/operations'

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

  async listOwnedRuns(input: Parameters<AgentRepository['listOwnedRuns']>[0]) {
    const candidates = [...this.#runs.values()]
      .map((stored) => stored.run)
      .filter((run) => run.host.tenantId === input.host.tenantId
        && run.host.externalUserId === input.host.externalUserId)
      .filter((run) => !input.after
        || run.updatedAt < input.after.updatedAt
        || (run.updatedAt === input.after.updatedAt && run.id < input.after.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, input.limit + 1)
    return { runs: candidates.slice(0, input.limit).map(clone), hasMore: candidates.length > input.limit }
  }

  async listRunnableRuns(input: Readonly<{ now: string; limit: number }>) {
    const now = Date.parse(input.now)
    return [...this.#runs.values()]
      .map((stored) => stored.run)
      .filter((run) => ['PLANNING', 'EXECUTING', 'PAGE_REVIEW', 'DECK_REVIEW', 'REVISING', 'DELIVERING'].includes(run.status))
      .filter((run) => run.leaseUntil === null || Date.parse(run.leaseUntil) <= now)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map(clone)
  }

  async listRunsWithPendingMedia(limit: number) {
    return [...this.#runs.values()]
      .filter((stored) => [...stored.steps.values()].some((step) =>
        step.tool === 'generate_slide_image' && ['WAITING', 'RELEASING'].includes(step.status)))
      .sort((left, right) => left.run.updatedAt.localeCompare(right.run.updatedAt) || left.run.id.localeCompare(right.run.id))
      .slice(0, limit)
      .map((stored) => stored.run.id)
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

  async readEvents(runId: string, input: Readonly<{ afterSequence: number; limit: number; maxBytes: number }>) {
    const candidates = (await this.listEvents(runId, input.afterSequence)).slice(0, input.limit + 1)
    const events: AgentEvent[] = []
    let byteLength = 0
    for (const event of candidates.slice(0, input.limit)) {
      const bytes = Buffer.byteLength(JSON.stringify(event))
      if (events.length > 0 && byteLength + bytes > input.maxBytes) break
      events.push(event)
      byteLength += bytes
    }
    return {
      events,
      nextAfter: events.at(-1)?.sequence ?? input.afterSequence,
      hasMore: candidates.length > events.length,
      byteLength,
    }
  }

  async getRunEventSnapshot(runId: string) {
    const events = await this.listEvents(runId)
    const issues = new Map<string, Extract<AgentEvent, { type: 'issue.detected' }>['payload']>()
    const progress = new Map<string, Extract<AgentEvent, { type: 'tool.progress' }>['payload']>()
    for (const event of events) {
      if (event.type === 'issue.detected') issues.set(event.payload.id, event.payload)
      else if (event.type === 'issue.resolved') issues.delete(event.payload.issueId)
      else if (event.type === 'tool.progress') progress.set(event.payload.stepId, event.payload)
      else if (event.type === 'tool.completed' || event.type === 'tool.failed') progress.delete(event.payload.stepId)
    }
    return { openIssues: [...issues.values()].map(clone), progress: [...progress.values()].map(clone) }
  }

  async getOperationsReport(filters: Parameters<AgentRepository['getOperationsReport']>[0]) {
    const runs = [...this.#runs.values()].map((stored) => clone(stored.run))
    const steps = [...this.#runs.values()].flatMap((stored) => [...stored.steps.values()].map(clone))
    const events = [...this.#runs.values()].flatMap((stored) => stored.events.map(clone))
    return buildOperationsReport({ runs, steps, events, filters })
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
        listSteps() { return [...nextSteps.values()].map(clone) },
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

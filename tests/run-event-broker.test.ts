import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION, type AgentEvent } from '../src/contracts'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import type { RunRecord } from '../src/core/ports'
import { RunEventBroker } from '../src/http/run-event-broker'

class CountingRepository extends InMemoryAgentRepository {
  readCount = 0

  override async readEvents(runId: string, input: Readonly<{ afterSequence: number; limit: number; maxBytes: number }>) {
    this.readCount += 1
    return super.readEvents(runId, input)
  }
}

function run(status: RunRecord['status'] = 'EXECUTING'): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-1', requestHash: 'hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: 'test' }, slideCount: 2, visualDirection: 'test', imageModel: 'test',
    automationLevel: 'SUPERVISED', maxRevisionRounds: 1, revisionRound: 0, qualityScore: null,
    status, resumeState: null, version: 0, budgetUnits: 10, committedBudgetUnits: 0,
    qualityOverride: false, qualityOverrideReason: null, qualityOverrideBy: null,
    leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await Bun.sleep(1)
  }
}

async function appendProgress(repository: InMemoryAgentRepository, count: number, terminal = false) {
  await repository.transact('run-1', (transaction) => {
    for (let index = 0; index < count; index++) {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.progress',
        payload: { stepId: 'step-1', completed: index + 1, total: count, summary: `progress-${index + 1}` },
      })
    }
    if (terminal) {
      transaction.putRun({ ...transaction.run, status: 'FAILED' })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.failed',
        payload: { errorCode: 'TEST_FAILURE' },
      })
    }
  })
}

describe('RunEventBroker', () => {
  test('shares one repository poll across subscribers to the same Run', async () => {
    const repository = new CountingRepository()
    await repository.createRun(run())
    await appendProgress(repository, 2, true)
    const broker = new RunEventBroker({ repository, pollMs: 5 })
    const first: AgentEvent[] = []
    const second: AgentEvent[] = []
    let closes = 0

    await broker.subscribe({ runId: 'run-1', after: 0, onEvent: (event) => Boolean(first.push(event)), onClose: () => { closes += 1 } })
    await broker.subscribe({ runId: 'run-1', after: 0, onEvent: (event) => Boolean(second.push(event)), onClose: () => { closes += 1 } })
    await waitFor(() => closes === 2)

    expect(first.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(second.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(repository.readCount).toBe(1)
    expect(broker.activePollers()).toBe(0)
  })

  test('keeps repository polling constant across 50 concurrent subscribers', async () => {
    const repository = new CountingRepository()
    await repository.createRun(run())
    await appendProgress(repository, 10, true)
    const broker = new RunEventBroker({ repository, pollMs: 5 })
    const received = Array.from({ length: 50 }, () => [] as number[])
    let closes = 0

    await Promise.all(received.map((sequences) => broker.subscribe({
      runId: 'run-1', after: 0,
      onEvent: (event) => Boolean(sequences.push(event.sequence)),
      onClose: () => { closes += 1 },
    })))
    await waitFor(() => closes === received.length)

    expect(received.every((sequences) => sequences.length === 11)).toBe(true)
    expect(repository.readCount).toBe(1)
    expect(broker.activePollers()).toBe(0)
  })

  test('drains a backlog in bounded pages and closes on the terminal event', async () => {
    const repository = new CountingRepository()
    await repository.createRun(run())
    await appendProgress(repository, 250, true)
    const broker = new RunEventBroker({ repository, pollMs: 5, eventLimit: 100 })
    const sequences: number[] = []
    let closed = false

    await broker.subscribe({
      runId: 'run-1', after: 0,
      onEvent: (event) => Boolean(sequences.push(event.sequence)),
      onClose: () => { closed = true },
    })
    await waitFor(() => closed)

    expect(sequences).toEqual(Array.from({ length: 251 }, (_, index) => index + 1))
    expect(repository.readCount).toBe(3)
  })

  test('closes immediately when reconnecting after the terminal event', async () => {
    const repository = new CountingRepository()
    await repository.createRun(run())
    await appendProgress(repository, 0, true)
    const broker = new RunEventBroker({ repository, pollMs: 5 })
    const events: AgentEvent[] = []
    let closed = false

    await broker.subscribe({
      runId: 'run-1', after: 1,
      onEvent: (event) => Boolean(events.push(event)),
      onClose: () => { closed = true },
    })
    await waitFor(() => closed)

    expect(events).toEqual([])
    expect(repository.readCount).toBe(1)
    expect(broker.activePollers()).toBe(0)
  })

  test('removes and closes a slow subscriber without affecting other subscribers', async () => {
    const repository = new CountingRepository()
    await repository.createRun(run())
    await appendProgress(repository, 2, true)
    const broker = new RunEventBroker({ repository, pollMs: 5 })
    const healthy: number[] = []
    let slowEvents = 0
    let slowClosed = false
    let healthyClosed = false

    await broker.subscribe({
      runId: 'run-1', after: 0,
      onEvent: () => { slowEvents += 1; return false },
      onClose: () => { slowClosed = true },
    })
    await broker.subscribe({
      runId: 'run-1', after: 0,
      onEvent: (event) => Boolean(healthy.push(event.sequence)),
      onClose: () => { healthyClosed = true },
    })
    await waitFor(() => slowClosed && healthyClosed)

    expect(slowEvents).toBe(1)
    expect(healthy).toEqual([1, 2, 3])
    expect(repository.readCount).toBe(1)
  })

  test('replays only events after the reconnect cursor', async () => {
    const repository = new CountingRepository()
    await repository.createRun(run())
    await appendProgress(repository, 3, true)
    const broker = new RunEventBroker({ repository, pollMs: 5 })
    const sequences: number[] = []
    let closed = false

    await broker.subscribe({
      runId: 'run-1', after: 2,
      onEvent: (event) => Boolean(sequences.push(event.sequence)),
      onClose: () => { closed = true },
    })
    await waitFor(() => closed)

    expect(sequences).toEqual([3, 4])
  })
})

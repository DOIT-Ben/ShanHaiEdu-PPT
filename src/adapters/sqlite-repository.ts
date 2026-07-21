import { Database } from 'bun:sqlite'
import type { AgentEvent } from '../contracts'
import type {
  AgentRepository,
  AgentTransaction,
  NewAgentEvent,
  RunRecord,
  StepRecord,
} from '../core/ports'
import type { DeliveryRecord } from '../presentation-contracts'

type JsonRow = { data: string }
type SequenceRow = { sequence: number | null }

function parseJson<T>(row: JsonRow | null): T | null {
  return row ? JSON.parse(row.data) as T : null
}

export class SqliteAgentRepository implements AgentRepository {
  readonly #database: Database

  constructor(filename: string) {
    this.#database = new Database(filename, { create: true, readwrite: true, strict: true })
    this.#database.exec('PRAGMA journal_mode = WAL')
    this.#database.exec('PRAGMA synchronous = FULL')
    this.#database.exec('PRAGMA foreign_keys = ON')
    this.#database.exec('PRAGMA busy_timeout = 5000')
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
        UNIQUE (run_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_steps_run_idx ON agent_steps(run_id);
      CREATE TABLE IF NOT EXISTS agent_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_deliveries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_deliveries_run_idx ON agent_deliveries(run_id);
    `)
  }

  close() {
    this.#database.close(true)
  }

  async createRun(run: RunRecord) {
    this.#database.query<unknown, [string, string]>('INSERT INTO agent_runs (id, data) VALUES (?, ?)')
      .run(run.id, JSON.stringify(run))
  }

  async getRun(runId: string) {
    const row = this.#database.query<JsonRow, [string]>('SELECT data FROM agent_runs WHERE id = ?').get(runId)
    return parseJson<RunRecord>(row)
  }

  async listRuns() {
    return this.#database.query<JsonRow, []>('SELECT data FROM agent_runs ORDER BY rowid ASC')
      .all().map((row) => JSON.parse(row.data) as RunRecord)
  }

  async listSteps(runId: string) {
    return this.#database.query<JsonRow, [string]>(
      'SELECT data FROM agent_steps WHERE run_id = ? ORDER BY rowid ASC',
    ).all(runId).map((row) => JSON.parse(row.data) as StepRecord)
  }

  async listEvents(runId: string, afterSequence = 0) {
    return this.#database.query<JsonRow, [string, number]>(
      'SELECT data FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC',
    ).all(runId, afterSequence).map((row) => JSON.parse(row.data) as AgentEvent)
  }

  async listDeliveries(runId: string) {
    return this.#database.query<JsonRow, [string]>(
      'SELECT data FROM agent_deliveries WHERE run_id = ? ORDER BY rowid ASC',
    ).all(runId).map((row) => JSON.parse(row.data) as DeliveryRecord)
  }

  async transact<T>(runId: string, operation: (transaction: AgentTransaction) => T): Promise<T> {
    const execute = this.#database.transaction(() => {
      const storedRun = parseJson<RunRecord>(
        this.#database.query<JsonRow, [string]>('SELECT data FROM agent_runs WHERE id = ?').get(runId),
      )
      if (!storedRun) throw new Error(`run not found: ${runId}`)

      let nextRun = structuredClone(storedRun)
      const touchedSteps = new Map<string, StepRecord>()
      const touchedDeliveries = new Map<string, DeliveryRecord>()
      const sequenceRow = this.#database.query<SequenceRow, [string]>(
        'SELECT MAX(sequence) AS sequence FROM agent_events WHERE run_id = ?',
      ).get(runId)
      let nextSequence = sequenceRow?.sequence ?? 0
      const appendedEvents: AgentEvent[] = []

      const transaction: AgentTransaction = {
        get run() { return nextRun },
        getStep: (idempotencyKey) => {
          const touched = touchedSteps.get(idempotencyKey)
          if (touched) return structuredClone(touched)
          const row = this.#database.query<JsonRow, [string, string]>(
            'SELECT data FROM agent_steps WHERE run_id = ? AND idempotency_key = ?',
          ).get(runId, idempotencyKey)
          return parseJson<StepRecord>(row)
        },
        listEvents: () => {
          const stored = this.#database.query<JsonRow, [string]>(
            'SELECT data FROM agent_events WHERE run_id = ? ORDER BY sequence ASC',
          ).all(runId).map((row) => JSON.parse(row.data) as AgentEvent)
          return [...stored, ...appendedEvents].map((event) => structuredClone(event))
        },
        getDelivery: (deliveryId) => {
          const touched = touchedDeliveries.get(deliveryId)
          if (touched) return structuredClone(touched)
          const row = this.#database.query<JsonRow, [string, string]>(
            'SELECT data FROM agent_deliveries WHERE run_id = ? AND id = ?',
          ).get(runId, deliveryId)
          return parseJson<DeliveryRecord>(row)
        },
        putRun(run) { nextRun = structuredClone(run) },
        putStep(step) { touchedSteps.set(step.idempotencyKey, structuredClone(step)) },
        putDelivery(delivery) { touchedDeliveries.set(delivery.id, structuredClone(delivery)) },
        appendEvent: (event: NewAgentEvent) => {
          nextSequence += 1
          const created = {
            ...structuredClone(event),
            id: `${runId}:event:${nextSequence}`,
            runId,
            sequence: nextSequence,
            createdAt: nextRun.updatedAt,
          } as AgentEvent
          appendedEvents.push(created)
          return structuredClone(created)
        },
      }

      const result = operation(transaction)
      this.#database.query<unknown, [string, string]>('UPDATE agent_runs SET data = ? WHERE id = ?')
        .run(JSON.stringify(nextRun), runId)
      const upsertStep = this.#database.query<unknown, [string, string, string, string]>(`
        INSERT INTO agent_steps (id, run_id, idempotency_key, data) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, idempotency_key) DO UPDATE SET
          id = excluded.id,
          data = excluded.data
      `)
      for (const step of touchedSteps.values()) {
        upsertStep.run(step.id, runId, step.idempotencyKey, JSON.stringify(step))
      }
      const upsertDelivery = this.#database.query<unknown, [string, string, string]>(`
        INSERT INTO agent_deliveries (id, run_id, data) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data
      `)
      for (const delivery of touchedDeliveries.values()) {
        upsertDelivery.run(delivery.id, runId, JSON.stringify(delivery))
      }
      const insertEvent = this.#database.query<unknown, [string, number, string]>(
        'INSERT INTO agent_events (run_id, sequence, data) VALUES (?, ?, ?)',
      )
      for (const event of appendedEvents) insertEvent.run(runId, event.sequence, JSON.stringify(event))
      return result
    })

    return execute.immediate()
  }
}

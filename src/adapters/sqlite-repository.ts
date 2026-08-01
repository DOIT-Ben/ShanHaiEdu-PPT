import { Database } from 'bun:sqlite'
import type { KnownAgentEvent as AgentEvent } from '../contracts'
import type {
  AgentRepository,
  AgentTransaction,
  NewAgentEvent,
  PlanningFailureAggregate,
  PlanningFailureFilters,
  RunRecord,
  StepRecord,
  TenantRevisionRoundsSettings,
} from '../core/ports'
import type { DeliveryRecord } from '../presentation-contracts'
import { buildOperationsReport, type OperationalRun, type OperationalStep } from '../core/operations'

type JsonRow = { data: string }
type SequenceRow = { sequence: number | null }
type PlanningFailureAggregateRow = {
  errorCode: string
  model: string | null
  contractVersion: string
  count: number
  lastOccurredAt: string
}
type OperationalRunRow = {
  id: string
  tenantId: string
  externalUserId: string
  status: RunRecord['status']
  version: number
  createdAt: string
  updatedAt: string
}
type OperationalStepRow = {
  id: string
  runId: string
  idempotencyKey: string
  tool: string
  status: StepRecord['status']
  budgetUnits: number
  externalOperationId: string | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
}
type CountRow = { count: number }
type TableColumnRow = { name: string }
type PlanningFailureQueryParameters = [
  string,
  string | null, string | null,
  string | null, string | null,
  string | null, string | null,
]

function parseJson<T>(row: JsonRow | null): T | null {
  return row ? JSON.parse(row.data) as T : null
}

function parseAgentEvent(data: string): AgentEvent {
  const event = JSON.parse(data) as AgentEvent & { eventId?: string }
  return event.eventId ? event : { ...event, eventId: event.id }
}

export class SqliteAgentRepository implements AgentRepository {
  readonly #database: Database

  constructor(filename: string) {
    this.#database = new Database(filename, { create: true, readwrite: true, strict: true })
    this.#database.exec('PRAGMA journal_mode = WAL')
    this.#database.exec('PRAGMA synchronous = FULL')
    this.#database.exec('PRAGMA foreign_keys = ON')
    this.#database.exec('PRAGMA busy_timeout = 5000')
    const hasEventSnapshots = Boolean(this.#database.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_open_issues'",
    ).get())
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PLANNING',
        lease_until TEXT,
        updated_at TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_tenant_settings (
        tenant_id TEXT PRIMARY KEY,
        max_revision_rounds INTEGER NOT NULL DEFAULT 2,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        updated_by TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        data TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS agent_open_issues (
        run_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (run_id, issue_id),
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_open_issues_run_idx ON agent_open_issues(run_id, sequence);
      CREATE TABLE IF NOT EXISTS agent_progress (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (run_id, step_id),
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_progress_run_idx ON agent_progress(run_id, sequence);
    `)
    this.ensureQueryColumns()
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS agent_runs_runnable_idx
        ON agent_runs(status, lease_until, updated_at, id);
      CREATE INDEX IF NOT EXISTS agent_runs_owner_page_idx
        ON agent_runs(tenant_id, external_user_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS agent_runs_tenant_status_idx
        ON agent_runs(tenant_id, status, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS agent_steps_tool_status_run_idx
        ON agent_steps(tool, status, run_id);
    `)
    if (!hasEventSnapshots) this.backfillEventSnapshots()
  }

  close() {
    this.#database.close(true)
  }

  async getTenantRevisionRoundsSettings(tenantId: string) {
    const row = this.#database.query<{
      maxRevisionRounds: number
      version: number
      updatedAt: string | null
      updatedBy: string | null
    }, [string]>(`
      SELECT max_revision_rounds AS maxRevisionRounds, version, updated_at AS updatedAt, updated_by AS updatedBy
      FROM agent_tenant_settings WHERE tenant_id = ?
    `).get(tenantId)
    return row
      ? { ...row, isConfigured: true }
      : { maxRevisionRounds: 2, version: 0, isConfigured: false, updatedAt: null, updatedBy: null }
  }

  async updateTenantRevisionRoundsSettings(input: Readonly<{
    tenantId: string
    maxRevisionRounds: number
    expectedVersion: number
    updatedBy: string
    updatedAt: string
  }>) {
    const result = this.#database.query<unknown, [string, number, string, string, number]>(`
      INSERT INTO agent_tenant_settings (tenant_id, max_revision_rounds, version, updated_at, updated_by)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        max_revision_rounds = excluded.max_revision_rounds,
        version = agent_tenant_settings.version + 1,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      WHERE agent_tenant_settings.version = ?
    `)
    const outcome = result.run(input.tenantId, input.maxRevisionRounds, input.updatedAt, input.updatedBy, input.expectedVersion)
    if (outcome.changes !== 1) return null
    return this.getTenantRevisionRoundsSettings(input.tenantId)
  }

  async createRun(run: RunRecord) {
    this.#database.query<unknown, [string, string, string, string, string, string | null, string]>(`
      INSERT INTO agent_runs (id, data, tenant_id, external_user_id, status, lease_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      JSON.stringify(run),
      run.host.tenantId,
      run.host.externalUserId,
      run.status,
      run.leaseUntil,
      run.updatedAt,
    )
  }

  async getRun(runId: string) {
    const row = this.#database.query<JsonRow, [string]>('SELECT data FROM agent_runs WHERE id = ?').get(runId)
    return parseJson<RunRecord>(row)
  }

  async listRuns() {
    return this.#database.query<JsonRow, []>('SELECT data FROM agent_runs ORDER BY rowid ASC')
      .all().map((row) => JSON.parse(row.data) as RunRecord)
  }

  async listOwnedRuns(input: Parameters<AgentRepository['listOwnedRuns']>[0]) {
    const rows = input.after
      ? this.#database.query<JsonRow, [string, string, string, string, string, number]>(`
          SELECT data
          FROM agent_runs
          WHERE tenant_id = ?
            AND external_user_id = ?
            AND (updated_at < ? OR (updated_at = ? AND id < ?))
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(
          input.host.tenantId,
          input.host.externalUserId,
          input.after.updatedAt,
          input.after.updatedAt,
          input.after.id,
          input.limit + 1,
        )
      : this.#database.query<JsonRow, [string, string, number]>(`
          SELECT data
          FROM agent_runs
          WHERE tenant_id = ?
            AND external_user_id = ?
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(input.host.tenantId, input.host.externalUserId, input.limit + 1)
    return {
      runs: rows.slice(0, input.limit).map((row) => JSON.parse(row.data) as RunRecord),
      hasMore: rows.length > input.limit,
    }
  }

  async listRunnableRuns(input: Readonly<{ now: string; limit: number }>) {
    return this.#database.query<JsonRow, [string, string, number]>(`
      SELECT data
      FROM agent_runs
      WHERE status IN ('PLANNING', 'EXECUTING', 'PAGE_REVIEW', 'DECK_REVIEW', 'REVISING', 'DELIVERING', 'RECOVERING')
        AND (
          status <> 'RECOVERING'
          OR (
            json_extract(data, '$.technicalRecovery.active') = 1
            AND json_extract(data, '$.technicalRecovery.nextAttemptAt') IS NOT NULL
            AND json_extract(data, '$.technicalRecovery.nextAttemptAt') <= ?
          )
        )
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(input.now, input.now, input.limit).map((row) => JSON.parse(row.data) as RunRecord)
  }

  async listRunsWithPendingMedia(limit: number) {
    return this.#database.query<{ id: string }, [number]>(`
      SELECT DISTINCT agent_runs.id
      FROM agent_steps
      JOIN agent_runs ON agent_runs.id = agent_steps.run_id
      WHERE (
        agent_steps.tool = 'generate_image_batch'
        AND agent_steps.status = 'BILLING_UNKNOWN'
      ) OR (
        agent_steps.tool = 'generate_slide_image'
        AND (
          agent_steps.status IN ('WAITING', 'RELEASING')
          OR (agent_steps.status = 'BILLING_UNKNOWN'
            AND json_extract(agent_steps.data, '$.externalOperationId') IS NOT NULL
            AND json_extract(agent_steps.data, '$.externalOperationId') <> '')
        )
      )
      ORDER BY agent_runs.updated_at ASC, agent_runs.id ASC
      LIMIT ?
    `).all(limit).map((row) => row.id)
  }

  async listSteps(runId: string) {
    return this.#database.query<JsonRow, [string]>(
      'SELECT data FROM agent_steps WHERE run_id = ? ORDER BY rowid ASC',
    ).all(runId).map((row) => JSON.parse(row.data) as StepRecord)
  }

  async listEvents(runId: string, afterSequence = 0) {
    return this.#database.query<JsonRow, [string, number]>(
      'SELECT data FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC',
    ).all(runId, afterSequence).map((row) => parseAgentEvent(row.data))
  }

  async getTerminalEvent(runId: string) {
    const row = this.#database.query<JsonRow, [string]>(`
      SELECT data
      FROM agent_events
      WHERE run_id = ?
        AND json_extract(data, '$.type') IN ('run.completed', 'run.failed', 'run.cancelled')
      ORDER BY sequence ASC
      LIMIT 1
    `).get(runId)
    return row ? parseAgentEvent(row.data) as Awaited<ReturnType<AgentRepository['getTerminalEvent']>> : null
  }

  async readEvents(runId: string, input: Readonly<{ afterSequence: number; limit: number; maxBytes: number }>) {
    const rows = this.#database.query<JsonRow, [string, number, number]>(
      'SELECT data FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?',
    ).all(runId, input.afterSequence, input.limit + 1)
    const events: AgentEvent[] = []
    let byteLength = 0
    for (const row of rows.slice(0, input.limit)) {
      const bytes = Buffer.byteLength(row.data)
      if (events.length > 0 && byteLength + bytes > input.maxBytes) break
      events.push(parseAgentEvent(row.data))
      byteLength += bytes
    }
    return {
      events,
      nextAfter: events.at(-1)?.sequence ?? input.afterSequence,
      hasMore: rows.length > events.length,
      byteLength,
    }
  }

  async getRunEventSnapshot(runId: string) {
    const openIssues = this.#database.query<JsonRow, [string]>(
      'SELECT data FROM agent_open_issues WHERE run_id = ? ORDER BY sequence ASC',
    ).all(runId).map((row) => (parseAgentEvent(row.data) as Extract<AgentEvent, { type: 'issue.detected' }>).payload)
    const progress = this.#database.query<JsonRow, [string]>(
      'SELECT data FROM agent_progress WHERE run_id = ? ORDER BY sequence ASC',
    ).all(runId).map((row) => (parseAgentEvent(row.data) as Extract<AgentEvent, { type: 'tool.progress' }>).payload)
    return { openIssues, progress }
  }

  async getOperationsReport(filters: Parameters<AgentRepository['getOperationsReport']>[0]) {
    const runs = this.#database.query<OperationalRunRow, [string]>(`
      SELECT
        id,
        tenant_id AS tenantId,
        external_user_id AS externalUserId,
        status,
        json_extract(data, '$.version') AS version,
        json_extract(data, '$.createdAt') AS createdAt,
        updated_at AS updatedAt
      FROM agent_runs
      WHERE tenant_id = ?
    `).all(filters.tenantId).map((row): OperationalRun => ({
      id: row.id,
      host: { tenantId: row.tenantId, externalUserId: row.externalUserId },
      status: row.status,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
    const steps = this.#database.query<OperationalStepRow, [string]>(`
      SELECT
        agent_steps.id AS id,
        agent_steps.run_id AS runId,
        agent_steps.idempotency_key AS idempotencyKey,
        agent_steps.tool AS tool,
        agent_steps.status AS status,
        json_extract(agent_steps.data, '$.budgetUnits') AS budgetUnits,
        json_extract(agent_steps.data, '$.externalOperationId') AS externalOperationId,
        json_extract(agent_steps.data, '$.errorCode') AS errorCode,
        json_extract(agent_steps.data, '$.createdAt') AS createdAt,
        json_extract(agent_steps.data, '$.updatedAt') AS updatedAt
      FROM agent_steps
      JOIN agent_runs ON agent_runs.id = agent_steps.run_id
      WHERE agent_runs.tenant_id = ?
    `).all(filters.tenantId).map((row): OperationalStep => row)
    const events = this.#database.query<JsonRow, [string]>(`
      SELECT agent_events.data
      FROM agent_events
      JOIN agent_runs ON agent_runs.id = agent_events.run_id
      WHERE agent_runs.tenant_id = ?
        AND json_extract(agent_events.data, '$.type') IN ('run.started', 'phase.changed', 'tool.started', 'tool.progress')
      ORDER BY agent_events.rowid DESC
      LIMIT 50000
    `).all(filters.tenantId).map((row) => parseAgentEvent(row.data))
    return buildOperationsReport({ runs, steps, events, filters })
  }

  async listDeliveries(runId: string) {
    return this.#database.query<JsonRow, [string]>(
      'SELECT data FROM agent_deliveries WHERE run_id = ? ORDER BY rowid ASC',
    ).all(runId).map((row) => JSON.parse(row.data) as DeliveryRecord)
  }

  async aggregatePlanningFailures(filters: PlanningFailureFilters) {
    const parameters: PlanningFailureQueryParameters = [
      filters.tenantId,
      filters.errorCode, filters.errorCode,
      filters.model, filters.model,
      filters.contractVersion, filters.contractVersion,
    ]
    const where = `
      agent_runs.tenant_id = ?
      AND json_extract(agent_events.data, '$.type') = 'issue.detected'
      AND json_type(agent_events.data, '$.payload.planningFailure') = 'object'
      AND (? IS NULL OR json_extract(agent_events.data, '$.payload.planningFailure.errorCode') = ?)
      AND (? IS NULL OR json_extract(agent_events.data, '$.payload.planningFailure.model') = ?)
      AND (? IS NULL OR json_extract(agent_events.data, '$.payload.planningFailure.contractVersion') = ?)
    `
    const count = this.#database.query<CountRow, PlanningFailureQueryParameters>(`
      SELECT COUNT(*) AS count
      FROM agent_events
      JOIN agent_runs ON agent_runs.id = agent_events.run_id
      WHERE ${where}
    `).get(...parameters)?.count ?? 0
    const groups = this.#database.query<PlanningFailureAggregateRow, PlanningFailureQueryParameters>(`
      SELECT
        json_extract(agent_events.data, '$.payload.planningFailure.errorCode') AS errorCode,
        json_extract(agent_events.data, '$.payload.planningFailure.model') AS model,
        json_extract(agent_events.data, '$.payload.planningFailure.contractVersion') AS contractVersion,
        COUNT(*) AS count,
        MAX(json_extract(agent_events.data, '$.createdAt')) AS lastOccurredAt
      FROM agent_events
      JOIN agent_runs ON agent_runs.id = agent_events.run_id
      WHERE ${where}
      GROUP BY errorCode, model, contractVersion
      ORDER BY count DESC, lastOccurredAt DESC
      LIMIT 100
    `).all(...parameters) as PlanningFailureAggregate[]
    return { groups, totalFailures: count }
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
        listSteps: () => {
          const stored = this.#database.query<JsonRow, [string]>(
            'SELECT data FROM agent_steps WHERE run_id = ? ORDER BY rowid ASC',
          ).all(runId).map((row) => JSON.parse(row.data) as StepRecord)
          const merged = new Map(stored.map((step) => [step.idempotencyKey, step]))
          for (const [key, step] of touchedSteps) merged.set(key, step)
          return [...merged.values()].map((step) => structuredClone(step))
        },
        listEvents: () => {
          const stored = this.#database.query<JsonRow, [string]>(
            'SELECT data FROM agent_events WHERE run_id = ? ORDER BY sequence ASC',
          ).all(runId).map((row) => parseAgentEvent(row.data))
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
          const eventId = `${runId}:event:${nextSequence}`
          const created = {
            ...structuredClone(event),
            id: eventId,
            eventId,
            runId,
            sequence: nextSequence,
            createdAt: nextRun.updatedAt,
          } as AgentEvent
          appendedEvents.push(created)
          return structuredClone(created)
        },
      }

      const result = operation(transaction)
      this.#database.query<unknown, [string, string, string, string, string | null, string, string]>(`
        UPDATE agent_runs
        SET data = ?, tenant_id = ?, external_user_id = ?, status = ?, lease_until = ?, updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(nextRun),
        nextRun.host.tenantId,
        nextRun.host.externalUserId,
        nextRun.status,
        nextRun.leaseUntil,
        nextRun.updatedAt,
        runId,
      )
      const upsertStep = this.#database.query<unknown, [string, string, string, string, string, string]>(`
        INSERT INTO agent_steps (id, run_id, idempotency_key, data, tool, status) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, idempotency_key) DO UPDATE SET
          id = excluded.id,
          data = excluded.data,
          tool = excluded.tool,
          status = excluded.status
      `)
      for (const step of touchedSteps.values()) {
        upsertStep.run(step.id, runId, step.idempotencyKey, JSON.stringify(step), step.tool, step.status)
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
      for (const event of appendedEvents) {
        insertEvent.run(runId, event.sequence, JSON.stringify(event))
        this.updateEventSnapshot(event)
      }
      return result
    })

    return execute.immediate()
  }

  private updateEventSnapshot(event: AgentEvent) {
    if (event.type === 'issue.detected') {
      this.#database.query<unknown, [string, string, number, string]>(`
        INSERT INTO agent_open_issues (run_id, issue_id, sequence, data) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, issue_id) DO UPDATE SET sequence = excluded.sequence, data = excluded.data
      `).run(event.runId, event.payload.id, event.sequence, JSON.stringify(event))
    } else if (event.type === 'issue.resolved') {
      this.#database.query<unknown, [string, string]>(
        'DELETE FROM agent_open_issues WHERE run_id = ? AND issue_id = ?',
      ).run(event.runId, event.payload.issueId)
    } else if (event.type === 'tool.progress') {
      this.#database.query<unknown, [string, string, number, string]>(`
        INSERT INTO agent_progress (run_id, step_id, sequence, data) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, step_id) DO UPDATE SET sequence = excluded.sequence, data = excluded.data
      `).run(event.runId, event.payload.stepId, event.sequence, JSON.stringify(event))
    } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      this.#database.query<unknown, [string, string]>(
        'DELETE FROM agent_progress WHERE run_id = ? AND step_id = ?',
      ).run(event.runId, event.payload.stepId)
    }
  }

  private ensureQueryColumns() {
    const migrate = this.#database.transaction(() => {
      const runColumns = new Set(this.#database.query<TableColumnRow, []>(
        'PRAGMA table_info(agent_runs)',
      ).all().map((row) => row.name))
      if (!runColumns.has('tenant_id')) this.#database.exec('ALTER TABLE agent_runs ADD COLUMN tenant_id TEXT')
      if (!runColumns.has('external_user_id')) this.#database.exec('ALTER TABLE agent_runs ADD COLUMN external_user_id TEXT')
      if (!runColumns.has('status')) this.#database.exec('ALTER TABLE agent_runs ADD COLUMN status TEXT')
      if (!runColumns.has('lease_until')) this.#database.exec('ALTER TABLE agent_runs ADD COLUMN lease_until TEXT')
      if (!runColumns.has('updated_at')) this.#database.exec('ALTER TABLE agent_runs ADD COLUMN updated_at TEXT')

      const stepColumns = new Set(this.#database.query<TableColumnRow, []>(
        'PRAGMA table_info(agent_steps)',
      ).all().map((row) => row.name))
      if (!stepColumns.has('tool')) this.#database.exec('ALTER TABLE agent_steps ADD COLUMN tool TEXT')
      if (!stepColumns.has('status')) this.#database.exec('ALTER TABLE agent_steps ADD COLUMN status TEXT')

      this.#database.exec(`
        UPDATE agent_runs
        SET tenant_id = json_extract(data, '$.host.tenantId'),
            external_user_id = json_extract(data, '$.host.externalUserId'),
            status = json_extract(data, '$.status'),
            lease_until = json_extract(data, '$.leaseUntil'),
            updated_at = json_extract(data, '$.updatedAt')
        WHERE tenant_id IS NULL OR tenant_id = ''
          OR external_user_id IS NULL OR external_user_id = ''
          OR status IS NULL OR status = ''
          OR updated_at IS NULL OR updated_at = '';
        UPDATE agent_steps
        SET tool = json_extract(data, '$.tool'),
            status = json_extract(data, '$.status')
        WHERE tool IS NULL OR tool = '' OR status IS NULL OR status = '';
      `)
    })
    migrate.immediate()
  }

  private backfillEventSnapshots() {
    const events = this.#database.query<JsonRow, []>(
      "SELECT data FROM agent_events WHERE json_extract(data, '$.type') IN ('issue.detected', 'issue.resolved', 'tool.progress', 'tool.completed', 'tool.failed') ORDER BY run_id, sequence",
    ).all().map((row) => parseAgentEvent(row.data))
    const backfill = this.#database.transaction(() => {
      for (const event of events) this.updateEventSnapshot(event)
    })
    backfill.immediate()
  }
}

import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { presentationBlueprintSchema } from '../presentation-contracts'
import {
  quickDeckEvaluationEventSchema,
  quickDeckEvaluationFailureCodeSchema,
  quickDeckImageAspectDiagnosticsSchema,
  QUICK_DECK_EVALUATION_MAX_IMAGE_DIMENSION,
  quickDeckEvaluationPhaseSchema,
  quickDeckEvaluationRequestSchema,
  quickDeckEvaluationRuntimeEvidenceSchema,
  quickDeckEvaluationStatusSchema,
  type QuickDeckEvaluationEvent,
} from '../quick-deck-evaluation-contracts'
import type { QuickDeckEvaluationRepository, QuickDeckEvaluationRecord } from '../core/quick-deck-evaluation-ports'
import { recoverInterruptedQuickDeckEvaluation } from '../core/quick-deck-evaluation-recovery'

type JsonRow = Readonly<{ data: string }>
type CountRow = Readonly<{ count: number }>
type SequenceRow = Readonly<{ sequence: number | null }>

const dateTimeSchema = z.string().datetime()
const identifierSchema = z.string().trim().min(1).max(160)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

const pageSchema = z.object({
  pageNumber: z.number().int().min(1).max(10),
  status: z.enum(['PENDING', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED']),
  submissionState: z.enum(['NOT_SUBMITTED', 'SUBMITTED', 'UNKNOWN']).default('NOT_SUBMITTED'),
  billingState: z.enum(['NOT_CHARGED', 'CHARGED', 'UNKNOWN']).default('UNKNOWN'),
  idempotencyKey: z.string().trim().min(1).max(512),
  operationId: z.string().trim().min(1).max(512).nullable(),
  providerRequestId: identifierSchema.nullable().default(null),
  artifactId: identifierSchema.nullable(),
  width: z.number().int().positive().max(QUICK_DECK_EVALUATION_MAX_IMAGE_DIMENSION).nullable(),
  height: z.number().int().positive().max(QUICK_DECK_EVALUATION_MAX_IMAGE_DIMENSION).nullable(),
  aspectRatioValidated: z.boolean(),
  aspectDiagnostics: quickDeckImageAspectDiagnosticsSchema.nullable().default(null),
  sha256: sha256Schema.nullable(),
  errorCode: z.string().trim().min(1).max(160).nullable(),
}).strict()

const artifactSchema = z.object({
  artifactId: identifierSchema,
  name: z.string().trim().min(1).max(240),
  mimeType: z.enum([
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png',
  ]),
  sha256: sha256Schema,
  byteLength: z.number().int().positive(),
}).strict()

const recordSchema = z.object({
  id: identifierSchema,
  tenantId: identifierSchema,
  request: quickDeckEvaluationRequestSchema,
  requestHash: sha256Schema,
  textModel: z.string().trim().min(1).max(120),
  imageModel: z.string().trim().min(1).max(120),
  evidenceContext: quickDeckEvaluationRuntimeEvidenceSchema.nullable().default(null),
  status: quickDeckEvaluationStatusSchema,
  phase: quickDeckEvaluationPhaseSchema,
  blueprint: presentationBlueprintSchema.nullable(),
  pages: z.array(pageSchema).min(1).max(10),
  pptx: artifactSchema.nullable(),
  preview: artifactSchema.nullable(),
  errorCode: quickDeckEvaluationFailureCodeSchema.nullable(),
  createdAt: dateTimeSchema,
  startedAt: dateTimeSchema.nullable(),
  completedAt: dateTimeSchema.nullable(),
  expiresAt: dateTimeSchema,
  pendingFailure: quickDeckEvaluationFailureCodeSchema.nullable().default(null),
  drainStartedAt: dateTimeSchema.nullable().default(null),
  drainDeadline: dateTimeSchema.nullable().default(null),
  nextAttemptAt: dateTimeSchema.nullable(),
  updatedAt: dateTimeSchema,
  cleanupPending: z.boolean().default(false),
  cleanupDeadline: dateTimeSchema.nullable().default(null),
  cleanupAuditRequired: z.boolean().default(false),
}).strict()

function parseRecord(row: JsonRow | null) {
  if (!row) return null
  try {
    return recordSchema.parse(JSON.parse(row.data)) as QuickDeckEvaluationRecord
  } catch {
    throw new Error('QUICK_DECK_EVALUATION_STORED_RECORD_INVALID')
  }
}

function active(status: QuickDeckEvaluationRecord['status']) {
  return ['QUEUED', 'PLANNING', 'SUBMITTING_IMAGES', 'GENERATING', 'PACKAGING'].includes(status)
}

export class SqliteQuickDeckEvaluationRepository implements QuickDeckEvaluationRepository {
  readonly #database: Database

  constructor(filename: string) {
    this.#database = new Database(filename, { create: true, readwrite: true, strict: true })
    this.#database.exec('PRAGMA journal_mode = WAL')
    this.#database.exec('PRAGMA synchronous = FULL')
    this.#database.exec('PRAGMA foreign_keys = ON')
    this.#database.exec('PRAGMA busy_timeout = 5000')
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS quick_deck_evaluations (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        status TEXT NOT NULL,
        next_attempt_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS quick_deck_evaluation_leases (
        job_id TEXT PRIMARY KEY,
        lease_token TEXT NOT NULL,
        lease_until TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES quick_deck_evaluations(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS quick_deck_evaluation_events (
        job_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (job_id, sequence),
        FOREIGN KEY (job_id) REFERENCES quick_deck_evaluations(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS quick_deck_evaluations_runnable_idx
        ON quick_deck_evaluations(status, next_attempt_at ASC, updated_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS quick_deck_evaluations_expiry_idx
        ON quick_deck_evaluations(expires_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS quick_deck_evaluations_daily_idx
        ON quick_deck_evaluations(tenant_id, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS quick_deck_evaluation_leases_expiry_idx
        ON quick_deck_evaluation_leases(lease_until ASC, job_id ASC);
    `)
  }

  close() {
    this.#database.close(true)
  }

  async create(input: Parameters<QuickDeckEvaluationRepository['create']>[0]) {
    const transaction = this.#database.transaction(() => {
      const daily = this.#database.query<CountRow, [string, string]>(`
        SELECT COUNT(*) AS count FROM quick_deck_evaluations WHERE tenant_id = ? AND created_at >= ?
      `).get(input.record.tenantId, input.dayStart)?.count ?? 0
      if (daily >= input.maxDailyJobs) return 'DAILY_LIMIT' as const
      const activeCount = this.#database.query<CountRow, [string]>(`
        SELECT COUNT(*) AS count FROM quick_deck_evaluations
        WHERE tenant_id = ? AND status IN ('QUEUED', 'PLANNING', 'SUBMITTING_IMAGES', 'GENERATING', 'PACKAGING')
      `).get(input.record.tenantId)?.count ?? 0
      if (activeCount >= input.maxActiveJobs) return 'CONCURRENCY_LIMIT' as const
      const record = recordSchema.parse(input.record)
      const event = quickDeckEvaluationEventSchema.parse({ ...input.event, sequence: 1 })
      if (event.jobId !== record.id) throw new Error('QUICK_DECK_EVALUATION_EVENT_JOB_MISMATCH')
      this.#database.query<unknown, [string, string, string, string, string | null, string, string, string]>(`
        INSERT INTO quick_deck_evaluations (id, data, tenant_id, status, next_attempt_at, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, JSON.stringify(record), record.tenantId, record.status, record.nextAttemptAt,
        record.expiresAt, record.createdAt, record.updatedAt)
      this.#database.query<unknown, [string, number, string]>(`
        INSERT INTO quick_deck_evaluation_events (job_id, sequence, data) VALUES (?, ?, ?)
      `).run(record.id, 1, JSON.stringify(event))
      return 'CREATED' as const
    })
    return transaction()
  }

  async get(jobId: string) {
    return parseRecord(this.#database.query<JsonRow, [string]>(`
      SELECT data FROM quick_deck_evaluations WHERE id = ?
    `).get(jobId))
  }

  async save(input: Parameters<QuickDeckEvaluationRepository['save']>[0]) {
    const transaction = this.#database.transaction(() => {
      const record = recordSchema.parse(input.record)
      const changed = this.#database.query<unknown, [string, string, string, string | null, string, string, string]>(`
        UPDATE quick_deck_evaluations
        SET data = ?, tenant_id = ?, status = ?, next_attempt_at = ?, expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(record), record.tenantId, record.status, record.nextAttemptAt,
        record.expiresAt, record.updatedAt, record.id).changes
      if (changed !== 1) throw new Error('QUICK_DECK_EVALUATION_NOT_FOUND')
      if (!input.event) return
      const sequence = (this.#database.query<SequenceRow, [string]>(`
        SELECT MAX(sequence) AS sequence FROM quick_deck_evaluation_events WHERE job_id = ?
      `).get(record.id)?.sequence ?? 0) + 1
      const event = quickDeckEvaluationEventSchema.parse({ ...input.event, sequence })
      if (event.jobId !== record.id) throw new Error('QUICK_DECK_EVALUATION_EVENT_JOB_MISMATCH')
      this.#database.query<unknown, [string, number, string]>(`
        INSERT INTO quick_deck_evaluation_events (job_id, sequence, data) VALUES (?, ?, ?)
      `).run(record.id, sequence, JSON.stringify(event))
    })
    transaction()
  }

  async listRunnable(input: Parameters<QuickDeckEvaluationRepository['listRunnable']>[0]) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('QUICK_DECK_EVALUATION_LIST_LIMIT_INVALID')
    }
    return this.#database.query<JsonRow, [string, string, string, number]>(`
      SELECT evaluation.data FROM quick_deck_evaluations AS evaluation
      LEFT JOIN quick_deck_evaluation_leases AS lease ON lease.job_id = evaluation.id
      WHERE evaluation.status IN ('QUEUED', 'SUBMITTING_IMAGES', 'GENERATING', 'PACKAGING')
        AND evaluation.next_attempt_at IS NOT NULL
        AND evaluation.next_attempt_at <= ?
        AND evaluation.expires_at > ?
        AND (lease.lease_until IS NULL OR lease.lease_until <= ?)
      ORDER BY evaluation.updated_at ASC, evaluation.id ASC
      LIMIT ?
    `).all(input.now, input.now, input.now, input.limit).map((row) => parseRecord(row)!)
  }

  async claimRunnable(input: Parameters<QuickDeckEvaluationRepository['claimRunnable']>[0]) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
      || !input.leaseToken.trim() || Date.parse(input.leaseUntil) <= Date.parse(input.now)) {
      throw new Error('QUICK_DECK_EVALUATION_LEASE_INPUT_INVALID')
    }
    const excluded = [...new Set(input.excludeJobIds ?? [])]
    if (excluded.length > 100 || excluded.some((jobId) => !jobId.trim() || jobId.length > 160)) {
      throw new Error('QUICK_DECK_EVALUATION_LEASE_INPUT_INVALID')
    }
    const excludedCondition = excluded.length > 0
      ? `AND evaluation.id NOT IN (${excluded.map(() => '?').join(', ')})`
      : ''
    const values = [input.leaseToken, input.leaseUntil, input.now, input.now, input.now, ...excluded, String(input.limit), input.now]
    this.#database.query<unknown, string[]>(`
      INSERT INTO quick_deck_evaluation_leases (job_id, lease_token, lease_until)
      SELECT evaluation.id, ?, ?
      FROM quick_deck_evaluations AS evaluation
      LEFT JOIN quick_deck_evaluation_leases AS lease ON lease.job_id = evaluation.id
      WHERE evaluation.status IN ('QUEUED', 'SUBMITTING_IMAGES', 'GENERATING', 'PACKAGING')
        AND evaluation.next_attempt_at IS NOT NULL
        AND evaluation.next_attempt_at <= ?
        AND evaluation.expires_at > ?
        AND (lease.lease_until IS NULL OR lease.lease_until <= ?)
        ${excludedCondition}
      ORDER BY evaluation.updated_at ASC, evaluation.id ASC
      LIMIT ?
      ON CONFLICT(job_id) DO UPDATE SET
        lease_token = excluded.lease_token,
        lease_until = excluded.lease_until
      WHERE quick_deck_evaluation_leases.lease_until <= ?
    `).run(...values)
    return this.#database.query<JsonRow, [string, string]>(`
      SELECT evaluation.data FROM quick_deck_evaluations AS evaluation
      INNER JOIN quick_deck_evaluation_leases AS lease ON lease.job_id = evaluation.id
      WHERE lease.lease_token = ? AND lease.lease_until = ?
      ORDER BY evaluation.updated_at ASC, evaluation.id ASC
    `).all(input.leaseToken, input.leaseUntil).map((row) => parseRecord(row)!)
  }

  async releaseClaim(input: Parameters<QuickDeckEvaluationRepository['releaseClaim']>[0]) {
    return this.#database.query<unknown, [string, string]>(`
      DELETE FROM quick_deck_evaluation_leases WHERE job_id = ? AND lease_token = ?
    `).run(input.jobId, input.leaseToken).changes === 1
  }

  async saveClaimed(input: Parameters<QuickDeckEvaluationRepository['saveClaimed']>[0]) {
    const transaction = this.#database.transaction(() => {
      const record = recordSchema.parse(input.record)
      const renewed = this.#database.query<unknown, [string, string, string, string]>(`
        UPDATE quick_deck_evaluation_leases
        SET lease_until = ?
        WHERE job_id = ? AND lease_token = ? AND lease_until > ?
      `).run(input.leaseUntil, record.id, input.leaseToken, input.now).changes
      if (renewed !== 1) return false
      const changed = this.#database.query<unknown, [string, string, string, string | null, string, string, string]>(`
        UPDATE quick_deck_evaluations
        SET data = ?, tenant_id = ?, status = ?, next_attempt_at = ?, expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(record), record.tenantId, record.status, record.nextAttemptAt,
        record.expiresAt, record.updatedAt, record.id).changes
      if (changed !== 1) throw new Error('QUICK_DECK_EVALUATION_NOT_FOUND')
      if (!input.event) return true
      const sequence = (this.#database.query<SequenceRow, [string]>(`
        SELECT MAX(sequence) AS sequence FROM quick_deck_evaluation_events WHERE job_id = ?
      `).get(record.id)?.sequence ?? 0) + 1
      const event = quickDeckEvaluationEventSchema.parse({ ...input.event, sequence })
      if (event.jobId !== record.id) throw new Error('QUICK_DECK_EVALUATION_EVENT_JOB_MISMATCH')
      this.#database.query<unknown, [string, number, string]>(`
        INSERT INTO quick_deck_evaluation_events (job_id, sequence, data) VALUES (?, ?, ?)
      `).run(record.id, sequence, JSON.stringify(event))
      return true
    })
    return transaction()
  }

  async listExpired(input: Parameters<QuickDeckEvaluationRepository['listExpired']>[0]) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('QUICK_DECK_EVALUATION_LIST_LIMIT_INVALID')
    }
    return this.#database.query<JsonRow, [string, string, number]>(`
      SELECT evaluation.data FROM quick_deck_evaluations AS evaluation
      LEFT JOIN quick_deck_evaluation_leases AS lease ON lease.job_id = evaluation.id
      WHERE evaluation.expires_at <= ?
        AND (lease.lease_until IS NULL OR lease.lease_until <= ?)
        AND (
        evaluation.status <> 'EXPIRED'
        OR json_extract(evaluation.data, '$.pptx') IS NOT NULL
        OR json_extract(evaluation.data, '$.preview') IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM json_each(json_extract(evaluation.data, '$.pages')) AS page
          WHERE json_extract(page.value, '$.artifactId') IS NOT NULL
        )
        OR COALESCE(json_extract(evaluation.data, '$.cleanupPending'), 0) = 1
      )
      ORDER BY evaluation.expires_at ASC, evaluation.id ASC
      LIMIT ?
    `).all(input.now, input.now, input.limit).map((row) => parseRecord(row)!)
  }

  async readEvents(input: Parameters<QuickDeckEvaluationRepository['readEvents']>[0]) {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('QUICK_DECK_EVALUATION_EVENT_CURSOR_INVALID')
    }
    const rows = this.#database.query<JsonRow, [string, number, number]>(`
      SELECT data FROM quick_deck_evaluation_events
      WHERE job_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(input.jobId, input.afterSequence, input.limit + 1)
    const events = rows.slice(0, input.limit).map((row) => quickDeckEvaluationEventSchema.parse(JSON.parse(row.data)))
    const terminal = this.#database.query<SequenceRow, [string]>(`
      SELECT MAX(sequence) AS sequence FROM quick_deck_evaluation_events
      WHERE job_id = ? AND json_extract(data, '$.type') IN ('evaluation.failed', 'packaging.completed', 'evaluation.expired')
    `).get(input.jobId)?.sequence ?? null
    return { events, hasMore: rows.length > input.limit, terminalSequence: terminal }
  }

  async recoverInterrupted(input: Parameters<QuickDeckEvaluationRepository['recoverInterrupted']>[0]) {
    const transaction = this.#database.transaction(() => {
      this.#database.query<unknown, [string]>(`
        DELETE FROM quick_deck_evaluation_leases WHERE lease_until <= ?
      `).run(input.now)
      const rows = this.#database.query<JsonRow, []>(`
        SELECT data FROM quick_deck_evaluations
        WHERE status IN ('QUEUED', 'PLANNING', 'SUBMITTING_IMAGES', 'GENERATING', 'PACKAGING')
      `).all()
      let changed = 0
      for (const row of rows) {
        const record = parseRecord(row)!
        const recovered = recoverInterruptedQuickDeckEvaluation(record, input)
        if (!recovered) continue
        const sequence = (this.#database.query<SequenceRow, [string]>(`
          SELECT MAX(sequence) AS sequence FROM quick_deck_evaluation_events WHERE job_id = ?
        `).get(recovered.record.id)?.sequence ?? 0) + 1
        const event = quickDeckEvaluationEventSchema.parse({
          schemaVersion: '1', jobId: recovered.record.id, sequence, eventId: `event-${randomUUID()}`,
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
        })
        this.#database.query<unknown, [string, string, string, string | null, string, string, string]>(`
          UPDATE quick_deck_evaluations
          SET data = ?, tenant_id = ?, status = ?, next_attempt_at = ?, expires_at = ?, updated_at = ?
          WHERE id = ?
        `).run(JSON.stringify(recovered.record), recovered.record.tenantId, recovered.record.status, recovered.record.nextAttemptAt,
          recovered.record.expiresAt, recovered.record.updatedAt, recovered.record.id)
        this.#database.query<unknown, [string, number, string]>(`
          INSERT INTO quick_deck_evaluation_events (job_id, sequence, data) VALUES (?, ?, ?)
        `).run(recovered.record.id, sequence, JSON.stringify(event))
        changed += 1
      }
      return changed
    })
    return transaction()
  }
}

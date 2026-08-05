import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type {
  PresentationJobV2Record,
  PresentationJobV2Repository,
} from '../core/presentation-job-v2-ports'
import {
  presentationJobV2ArtifactSchema,
  presentationJobV2CreateRequestSchema,
  presentationJobV2UsageSummarySchema,
  type PresentationJobV2UsageSummary,
} from '../presentation-job-v2-contracts'

type JsonRow = Readonly<{ data: string }>
type StoredJsonRow = Readonly<{ id: string; data: string }>

const dateTimeSchema = z.string().datetime()
const usageSummaryFields = {
  billableImageOperations: z.number().int().nonnegative(),
  notChargedImageOperations: z.number().int().nonnegative(),
  unknownImageOperations: z.number().int().nonnegative(),
  byModel: z.array(z.object({
    model: z.string().trim().min(1).max(160),
    billableImageOperations: z.number().int().nonnegative(),
    notChargedImageOperations: z.number().int().nonnegative(),
    unknownImageOperations: z.number().int().nonnegative(),
  }).strict()).max(20),
}

const storedUsageSummarySchema = z.object({
  ...usageSummaryFields,
  model: z.string().trim().min(1).max(160).optional(),
}).strict().transform((value) => ({
  billableImageOperations: value.billableImageOperations,
  notChargedImageOperations: value.notChargedImageOperations,
  unknownImageOperations: value.unknownImageOperations,
  byModel: value.byModel,
})).superRefine((value, context) => {
  const parsed = presentationJobV2UsageSummarySchema.safeParse(value)
  if (parsed.success) return
  for (const issue of parsed.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  }
})

const storedUsageSchema = z.object({
  ...usageSummaryFields,
  model: z.string().trim().min(1).max(160).optional(),
  usageVersion: z.literal(1),
  status: z.enum(['PENDING', 'RECONCILING', 'FINALIZED']),
  action: z.enum(['WAIT', 'NONE']),
  finalizedAt: dateTimeSchema.nullable(),
}).strict().transform((value) => ({
  billableImageOperations: value.billableImageOperations,
  notChargedImageOperations: value.notChargedImageOperations,
  unknownImageOperations: value.unknownImageOperations,
  byModel: value.byModel,
  usageVersion: value.usageVersion,
  status: value.status,
  action: value.action,
  finalizedAt: value.finalizedAt,
})).superRefine((value, context) => {
  const parsed = presentationJobV2UsageSummarySchema.safeParse({
    billableImageOperations: value.billableImageOperations,
    notChargedImageOperations: value.notChargedImageOperations,
    unknownImageOperations: value.unknownImageOperations,
    byModel: value.byModel,
  })
  if (parsed.success) return
  for (const issue of parsed.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  }
})

const providerOperationBase = {
  idempotencyKey: z.string().trim().min(1).max(512),
  operationId: z.string().trim().min(1).max(512),
  status: z.enum(['SUBMITTED', 'COMPLETED', 'FAILED']),
  createdAt: dateTimeSchema,
  completedAt: dateTimeSchema.nullable(),
}

const storedProviderOperationSchema = z.object({
  ...providerOperationBase,
  usage: storedUsageSummarySchema,
}).strict()

const legacyProviderOperationSchema = z.object({
  ...providerOperationBase,
  billingStatus: z.enum(['SETTLED', 'UNKNOWN']),
}).strict()

const legacyUsageSchema = z.object({
  usageVersion: z.literal(1),
  status: z.enum(['PENDING', 'RECONCILING', 'FINALIZED']),
  action: z.enum(['WAIT', 'NONE']),
  unknownOperationCount: z.number().int().nonnegative(),
  finalizedAt: dateTimeSchema.nullable(),
}).strict()

const storedJobBaseSchema = z.object({
  id: z.string().trim().min(1).max(160),
  creationKey: z.string().trim().min(1),
  requestHash: z.string().trim().min(1),
  owner: z.object({
    tenantId: z.string().trim().min(1).max(160),
    externalUserId: z.string().trim().min(1).max(160),
    externalProjectId: z.string().trim().min(1).max(160).nullable(),
  }).strict(),
  request: presentationJobV2CreateRequestSchema,
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
  phase: z.enum(['ACCEPTED', 'GENERATING', 'DELIVERING', 'COMPLETE', 'FAILED']),
  progressPercent: z.number().int().min(0).max(100),
  quality: z.enum(['PASSED', 'BEST_EFFORT']).nullable(),
  artifact: presentationJobV2ArtifactSchema.nullable(),
  errorCode: z.string().nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
}).strict()

const storedJobSchema = storedJobBaseSchema.extend({
  providerOperations: z.array(storedProviderOperationSchema).max(1),
  usage: storedUsageSchema,
}).strict()

const legacyStoredJobSchema = storedJobBaseSchema.extend({
  providerOperations: z.array(legacyProviderOperationSchema).max(1),
  usage: legacyUsageSchema,
}).strict()

function unknownUsage(count: number): PresentationJobV2UsageSummary {
  return {
    billableImageOperations: 0,
    notChargedImageOperations: 0,
    unknownImageOperations: count,
    byModel: [{
      model: 'unknown',
      billableImageOperations: 0,
      notChargedImageOperations: 0,
      unknownImageOperations: count,
    }],
  }
}

function emptyUsage(): PresentationJobV2UsageSummary {
  return {
    billableImageOperations: 0,
    notChargedImageOperations: 0,
    unknownImageOperations: 0,
    byModel: [],
  }
}

function migrateLegacyJob(job: z.infer<typeof legacyStoredJobSchema>): PresentationJobV2Record {
  const requiresReconciliation = job.providerOperations.length > 0
    || job.usage.status === 'RECONCILING'
    || job.usage.unknownOperationCount > 0
  const summary = requiresReconciliation
    ? unknownUsage(Math.max(1, job.providerOperations.length, job.usage.unknownOperationCount))
    : emptyUsage()
  return {
    ...job,
    providerOperations: job.providerOperations.map((operation) => ({
      idempotencyKey: operation.idempotencyKey,
      operationId: operation.operationId,
      status: operation.status,
      usage: unknownUsage(1),
      createdAt: operation.createdAt,
      completedAt: operation.completedAt,
    })),
    usage: requiresReconciliation
      ? {
          ...summary,
          usageVersion: 1,
          status: 'RECONCILING',
          action: 'WAIT',
          finalizedAt: null,
        }
      : {
          ...summary,
          usageVersion: 1,
          status: job.usage.status,
          action: job.usage.action,
          finalizedAt: job.usage.finalizedAt,
        },
  }
}

function parseStoredJob(data: string): Readonly<{ job: PresentationJobV2Record; migrated: boolean }> {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw new Error('PRESENTATION_JOB_STORED_RECORD_INVALID')
  }
  const current = storedJobSchema.safeParse(value)
  if (current.success) return { job: current.data, migrated: false }
  const legacy = legacyStoredJobSchema.safeParse(value)
  if (legacy.success) return { job: migrateLegacyJob(legacy.data), migrated: true }
  throw new Error('PRESENTATION_JOB_STORED_RECORD_INVALID')
}

function parseJob(row: JsonRow | null) {
  return row ? parseStoredJob(row.data).job : null
}

export class SqlitePresentationJobV2Repository implements PresentationJobV2Repository {
  readonly #database: Database

  constructor(filename: string) {
    this.#database = new Database(filename, { create: true, readwrite: true, strict: true })
    this.#database.exec('PRAGMA journal_mode = WAL')
    this.#database.exec('PRAGMA synchronous = FULL')
    this.#database.exec('PRAGMA foreign_keys = ON')
    this.#database.exec('PRAGMA busy_timeout = 5000')
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS presentation_jobs_v2 (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        external_project_id TEXT,
        status TEXT NOT NULL,
        usage_status TEXT NOT NULL,
        next_attempt_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS presentation_jobs_v2_owner_idx
        ON presentation_jobs_v2(tenant_id, external_user_id, external_project_id, updated_at DESC, id DESC);
    `)
    const columns = this.#database.query<{ name: string }, []>(
      'PRAGMA table_info(presentation_jobs_v2)',
    ).all()
    if (!columns.some((column) => column.name === 'next_attempt_at')) {
      this.#database.exec('ALTER TABLE presentation_jobs_v2 ADD COLUMN next_attempt_at TEXT')
    }
    this.migrateLegacyRecords()
    this.#database.exec(`
      UPDATE presentation_jobs_v2
      SET next_attempt_at = updated_at
      WHERE next_attempt_at IS NULL
        AND (status IN ('QUEUED', 'RUNNING')
          OR (status IN ('COMPLETED', 'FAILED') AND usage_status = 'RECONCILING'));
      DROP INDEX IF EXISTS presentation_jobs_v2_runnable_idx;
      CREATE INDEX presentation_jobs_v2_runnable_idx
        ON presentation_jobs_v2(status, usage_status, next_attempt_at ASC, updated_at ASC, id ASC);
    `)
  }

  close() {
    this.#database.close(true)
  }

  private migrateLegacyRecords() {
    const migrations = this.#database.query<StoredJsonRow, []>(
      'SELECT id, data FROM presentation_jobs_v2 ORDER BY id ASC',
    ).all().map((row) => ({ row, parsed: parseStoredJob(row.data) }))
      .filter(({ parsed }) => parsed.migrated)
    if (migrations.length === 0) return
    const update = this.#database.query<unknown, [string, string, string, string | null, string, string]>(`
      UPDATE presentation_jobs_v2
      SET data = ?, status = ?, usage_status = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?
    `)
    const migrate = this.#database.transaction(() => {
      for (const { row, parsed } of migrations) {
        if (parsed.job.id !== row.id) throw new Error('PRESENTATION_JOB_STORED_RECORD_INVALID')
        const runnable = parsed.job.status === 'QUEUED' || parsed.job.status === 'RUNNING'
          || (['COMPLETED', 'FAILED'].includes(parsed.job.status)
            && parsed.job.usage.status === 'RECONCILING')
        update.run(
          JSON.stringify(parsed.job),
          parsed.job.status,
          parsed.job.usage.status,
          runnable ? parsed.job.updatedAt : null,
          parsed.job.updatedAt,
          parsed.job.id,
        )
      }
    })
    migrate()
  }

  async createPresentationJob(job: PresentationJobV2Record) {
    this.#database.query<unknown, [string, string, string, string, string | null, string, string, string | null, string]>(`
      INSERT INTO presentation_jobs_v2 (
        id, data, tenant_id, external_user_id, external_project_id, status, usage_status, next_attempt_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      JSON.stringify(job),
      job.owner.tenantId,
      job.owner.externalUserId,
      job.owner.externalProjectId,
      job.status,
      job.usage.status,
      job.updatedAt,
      job.updatedAt,
    )
  }

  async getPresentationJob(jobId: string) {
    return parseJob(this.#database.query<JsonRow, [string]>(
      'SELECT data FROM presentation_jobs_v2 WHERE id = ?',
    ).get(jobId))
  }

  async savePresentationJob(job: PresentationJobV2Record, workerEligibleAt: string | null) {
    const outcome = this.#database.query<unknown, [string, string, string, string | null, string, string, string | null, string, string]>(`
      UPDATE presentation_jobs_v2
      SET data = ?, tenant_id = ?, external_user_id = ?, external_project_id = ?, status = ?, usage_status = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(job),
      job.owner.tenantId,
      job.owner.externalUserId,
      job.owner.externalProjectId,
      job.status,
      job.usage.status,
      workerEligibleAt,
      job.updatedAt,
      job.id,
    )
    if (outcome.changes !== 1) throw new Error('PRESENTATION_JOB_NOT_FOUND')
  }

  async listRunnablePresentationJobs(input: Readonly<{ limit: number; now: string }>) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('PRESENTATION_JOB_LIST_LIMIT_INVALID')
    }
    return this.#database.query<JsonRow, [string, number]>(`
      SELECT data
      FROM presentation_jobs_v2
      WHERE (status IN ('QUEUED', 'RUNNING')
        OR (status IN ('COMPLETED', 'FAILED') AND usage_status = 'RECONCILING'))
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(input.now, input.limit).map((row) => parseJob(row)!)
  }
}

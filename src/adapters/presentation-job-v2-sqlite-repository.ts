import { Database } from 'bun:sqlite'
import type {
  PresentationJobV2Record,
  PresentationJobV2Repository,
} from '../core/presentation-job-v2-ports'

type JsonRow = Readonly<{ data: string }>

function parseJob(row: JsonRow | null) {
  return row ? JSON.parse(row.data) as PresentationJobV2Record : null
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
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS presentation_jobs_v2_owner_idx
        ON presentation_jobs_v2(tenant_id, external_user_id, external_project_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS presentation_jobs_v2_runnable_idx
        ON presentation_jobs_v2(status, usage_status, updated_at ASC, id ASC);
    `)
  }

  close() {
    this.#database.close(true)
  }

  async createPresentationJob(job: PresentationJobV2Record) {
    this.#database.query<unknown, [string, string, string, string, string | null, string, string, string]>(`
      INSERT INTO presentation_jobs_v2 (
        id, data, tenant_id, external_user_id, external_project_id, status, usage_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      JSON.stringify(job),
      job.owner.tenantId,
      job.owner.externalUserId,
      job.owner.externalProjectId,
      job.status,
      job.usage.status,
      job.updatedAt,
    )
  }

  async getPresentationJob(jobId: string) {
    return parseJob(this.#database.query<JsonRow, [string]>(
      'SELECT data FROM presentation_jobs_v2 WHERE id = ?',
    ).get(jobId))
  }

  async savePresentationJob(job: PresentationJobV2Record) {
    const outcome = this.#database.query<unknown, [string, string, string, string | null, string, string, string, string]>(`
      UPDATE presentation_jobs_v2
      SET data = ?, tenant_id = ?, external_user_id = ?, external_project_id = ?, status = ?, usage_status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(job),
      job.owner.tenantId,
      job.owner.externalUserId,
      job.owner.externalProjectId,
      job.status,
      job.usage.status,
      job.updatedAt,
      job.id,
    )
    if (outcome.changes !== 1) throw new Error('PRESENTATION_JOB_NOT_FOUND')
  }

  async listRunnablePresentationJobs(input: Readonly<{ limit: number }>) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('PRESENTATION_JOB_LIST_LIMIT_INVALID')
    }
    return this.#database.query<JsonRow, [number]>(`
      SELECT data
      FROM presentation_jobs_v2
      WHERE status IN ('QUEUED', 'RUNNING')
        OR (status = 'COMPLETED' AND usage_status = 'RECONCILING')
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(input.limit).map((row) => JSON.parse(row.data) as PresentationJobV2Record)
  }
}

import type {
  PresentationJobV2Record,
  PresentationJobV2Repository,
} from '../core/presentation-job-v2-ports'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class InMemoryPresentationJobV2Repository implements PresentationJobV2Repository {
  readonly #jobs = new Map<string, PresentationJobV2Record>()
  readonly #workerEligibleAt = new Map<string, string | null>()

  async createPresentationJob(job: PresentationJobV2Record) {
    if (this.#jobs.has(job.id)) throw new Error('PRESENTATION_JOB_ALREADY_EXISTS')
    this.#jobs.set(job.id, clone(job))
    this.#workerEligibleAt.set(job.id, job.updatedAt)
  }

  async getPresentationJob(jobId: string) {
    return clone(this.#jobs.get(jobId) ?? null)
  }

  async savePresentationJob(job: PresentationJobV2Record, workerEligibleAt: string | null) {
    if (!this.#jobs.has(job.id)) throw new Error('PRESENTATION_JOB_NOT_FOUND')
    this.#jobs.set(job.id, clone(job))
    this.#workerEligibleAt.set(job.id, workerEligibleAt)
  }

  async listRunnablePresentationJobs(input: Readonly<{ limit: number; now: string }>) {
    return [...this.#jobs.values()]
      .filter((job) => job.status === 'QUEUED' || job.status === 'RUNNING'
        || (['COMPLETED', 'FAILED'].includes(job.status) && job.usage.status === 'RECONCILING'))
      .filter((job) => {
        const workerEligibleAt = this.#workerEligibleAt.get(job.id) ?? job.updatedAt
        return workerEligibleAt <= input.now
      })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map(clone)
  }
}

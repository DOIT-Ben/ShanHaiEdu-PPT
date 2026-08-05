import type {
  PresentationJobV2Record,
  PresentationJobV2Repository,
} from '../core/presentation-job-v2-ports'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class InMemoryPresentationJobV2Repository implements PresentationJobV2Repository {
  readonly #jobs = new Map<string, PresentationJobV2Record>()

  async createPresentationJob(job: PresentationJobV2Record) {
    if (this.#jobs.has(job.id)) throw new Error('PRESENTATION_JOB_ALREADY_EXISTS')
    this.#jobs.set(job.id, clone(job))
  }

  async getPresentationJob(jobId: string) {
    return clone(this.#jobs.get(jobId) ?? null)
  }

  async savePresentationJob(job: PresentationJobV2Record) {
    if (!this.#jobs.has(job.id)) throw new Error('PRESENTATION_JOB_NOT_FOUND')
    this.#jobs.set(job.id, clone(job))
  }

  async listRunnablePresentationJobs(input: Readonly<{ limit: number }>) {
    return [...this.#jobs.values()]
      .filter((job) => job.status === 'QUEUED' || job.status === 'RUNNING'
        || (['COMPLETED', 'FAILED'].includes(job.status) && job.usage.status === 'RECONCILING'))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map(clone)
  }
}

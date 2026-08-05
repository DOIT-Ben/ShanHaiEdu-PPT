import { createHash } from 'node:crypto'
import {
  canonicalPresentationJobV2Json,
  presentationJobV2CreateRequestSchema,
  presentationJobV2PublicJobSchema,
  presentationJobV2UsageSchema,
  PRESENTATION_JOB_V2_CONTRACT_VERSION,
  type PresentationJobV2CreateRequest,
  type PresentationJobV2UsageSummary,
} from '../presentation-job-v2-contracts'
import type { ArtifactPort, ClockPort } from './ports'
import {
  PRESENTATION_JOB_V2_PPTX_MIME_TYPE,
  type PresentationJobV2Artifact,
  type PresentationJobV2BudgetPolicy,
  type PresentationJobV2Owner,
  type PresentationJobV2ProviderOperation,
  type PresentationJobV2ProviderPort,
  type PresentationJobV2Record,
  type PresentationJobV2Repository,
  type PublicPresentationJobV2,
  type PublicPresentationJobV2Usage,
} from './presentation-job-v2-ports'

const MAX_PROVIDER_OPERATIONS_PER_JOB = 1

function emptyUsage(): PresentationJobV2UsageSummary {
  return {
    billableImageOperations: 0,
    notChargedImageOperations: 0,
    unknownImageOperations: 0,
    byModel: [],
  }
}

export class PresentationJobV2Error extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message)
    this.name = 'PresentationJobV2Error'
  }
}

function digest(value: unknown) {
  return createHash('sha256').update(canonicalPresentationJobV2Json(value), 'utf8').digest('hex')
}

function sameOwner(left: PresentationJobV2Owner, right: PresentationJobV2Owner) {
  return left.tenantId === right.tenantId
    && left.externalUserId === right.externalUserId
    && left.externalProjectId === right.externalProjectId
}

function isPptx(bytes: Uint8Array) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

function publicJob(job: PresentationJobV2Record): PublicPresentationJobV2 {
  return presentationJobV2PublicJobSchema.parse({
    contractVersion: PRESENTATION_JOB_V2_CONTRACT_VERSION,
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    progress: { percent: job.progressPercent },
    quality: job.quality,
    artifact: job.artifact,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  })
}

function publicUsage(job: PresentationJobV2Record): PublicPresentationJobV2Usage {
  return presentationJobV2UsageSchema.parse({
    contractVersion: PRESENTATION_JOB_V2_CONTRACT_VERSION,
    jobId: job.id,
    usageVersion: job.usage.usageVersion,
    status: job.usage.status,
    action: job.usage.action,
    billableImageOperations: job.usage.billableImageOperations,
    notChargedImageOperations: job.usage.notChargedImageOperations,
    unknownImageOperations: job.usage.unknownImageOperations,
    byModel: job.usage.byModel,
    finalizedAt: job.usage.finalizedAt,
  })
}

export class PresentationJobV2Service {
  constructor(private readonly dependencies: Readonly<{
    repository: PresentationJobV2Repository
    artifacts: ArtifactPort
    provider: PresentationJobV2ProviderPort
    budget: PresentationJobV2BudgetPolicy
    clock: ClockPort
  }>) {}

  async create(owner: PresentationJobV2Owner, request: unknown, idempotencyKey: string) {
    const parsed = presentationJobV2CreateRequestSchema.safeParse(request)
    if (!parsed.success) throw new PresentationJobV2Error(422, 'INVALID_PRESENTATION_JOB_REQUEST')
    if (!this.validOwner(owner) || !this.validIdentifier(idempotencyKey)) {
      throw new PresentationJobV2Error(422, 'INVALID_PRESENTATION_JOB_IDEMPOTENCY_KEY')
    }
    const normalized = parsed.data
    const creationKey = digest({ owner, idempotencyKey })
    const id = `presentation-job-${creationKey.slice(0, 28)}`
    const requestHash = digest(normalized)
    const existing = await this.dependencies.repository.getPresentationJob(id)
    if (existing) return this.replayOrConflict(existing, requestHash)
    const now = this.dependencies.clock.now().toISOString()
    const job: PresentationJobV2Record = {
      id,
      creationKey,
      requestHash,
      owner: structuredClone(owner),
      request: normalized,
      status: 'QUEUED',
      phase: 'ACCEPTED',
      progressPercent: 0,
      quality: null,
      artifact: null,
      providerOperations: [],
      usage: {
        ...emptyUsage(),
        usageVersion: 1,
        status: 'PENDING',
        action: 'WAIT',
        finalizedAt: null,
      },
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.dependencies.repository.createPresentationJob(job)
    } catch {
      const concurrent = await this.dependencies.repository.getPresentationJob(id)
      if (concurrent) return this.replayOrConflict(concurrent, requestHash)
      throw new PresentationJobV2Error(500, 'PRESENTATION_JOB_CREATE_FAILED')
    }
    return { job: publicJob(job), replayed: false }
  }

  async getOwned(owner: PresentationJobV2Owner, jobId: string) {
    return publicJob(await this.requireOwned(owner, jobId))
  }

  async getUsageOwned(owner: PresentationJobV2Owner, jobId: string) {
    return publicUsage(await this.requireOwned(owner, jobId))
  }

  async getArtifactOwned(owner: PresentationJobV2Owner, jobId: string, artifactId: string) {
    const job = await this.requireOwned(owner, jobId)
    if (job.status !== 'COMPLETED' || !job.artifact || job.artifact.artifactId !== artifactId) {
      throw new PresentationJobV2Error(404, 'PRESENTATION_ARTIFACT_NOT_FOUND')
    }
    return job.artifact
  }

  async tick(input: Readonly<{ limit: number }>) {
    const jobs = await this.dependencies.repository.listRunnablePresentationJobs(input)
    for (const job of jobs) await this.advance(job)
    return { scannedJobs: jobs.length }
  }

  private async advance(job: PresentationJobV2Record) {
    if (job.status === 'QUEUED') return await this.submit(job)
    if (job.status === 'RUNNING') return await this.inspect(job)
    if (job.status === 'COMPLETED' && job.usage.status === 'RECONCILING') return await this.reconcile(job)
  }

  private async submit(job: PresentationJobV2Record) {
    if (job.providerOperations.length >= MAX_PROVIDER_OPERATIONS_PER_JOB) {
      return await this.fail(job, 'SERVICE_OPERATION_CAP_REACHED', emptyUsage())
    }
    const idempotencyKey = `${job.id}:provider:1`
    const authorization = await this.dependencies.budget.authorize({
      owner: job.owner,
      jobId: job.id,
      operationIdempotencyKey: idempotencyKey,
      priorProviderOperations: job.providerOperations.length,
    })
    if (!authorization.allowed) return await this.fail(job, 'SERVICE_OPERATION_NOT_AUTHORIZED', emptyUsage())
    const submitted = await this.dependencies.provider.submit({
      jobId: job.id,
      owner: job.owner,
      source: job.request.source,
      idempotencyKey,
    })
    const now = this.dependencies.clock.now().toISOString()
    const operation: PresentationJobV2ProviderOperation = {
      idempotencyKey,
      operationId: submitted.operationId,
      status: 'SUBMITTED',
      usage: emptyUsage(),
      createdAt: now,
      completedAt: null,
    }
    await this.save({
      ...job,
      status: 'RUNNING',
      phase: 'GENERATING',
      progressPercent: 25,
      providerOperations: [operation],
      updatedAt: now,
    })
  }

  private async inspect(job: PresentationJobV2Record) {
    const operation = job.providerOperations.at(-1)
    if (!operation) return await this.fail(job, 'PROVIDER_OPERATION_MISSING', emptyUsage())
    const result = await this.dependencies.provider.inspect({
      jobId: job.id,
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
    })
    if (result.state === 'RUNNING') {
      return await this.save({ ...job, progressPercent: 75, updatedAt: this.dependencies.clock.now().toISOString() })
    }
    if (result.state === 'FAILED') return await this.fail(job, result.errorCode, result.usage)
    if (result.quality === 'BLOCKING_FAILURE') return await this.fail(job, 'DELIVERY_BLOCKED_BY_QUALITY', result.usage)
    if (result.artifact.mimeType !== PRESENTATION_JOB_V2_PPTX_MIME_TYPE || !isPptx(result.artifact.bytes)) {
      return await this.fail(job, 'PPTX_ARTIFACT_INVALID', result.usage)
    }
    const stored = await this.dependencies.artifacts.put({
      tenantId: job.owner.tenantId,
      runId: job.id,
      name: result.artifact.name,
      mimeType: result.artifact.mimeType,
      bytes: result.artifact.bytes,
      idempotencyKey: `${job.id}:artifact:pptx`,
    })
    const artifact: PresentationJobV2Artifact = {
      artifactId: stored.artifactId,
      name: result.artifact.name,
      mimeType: result.artifact.mimeType,
      sha256: stored.sha256,
      byteLength: result.artifact.bytes.length,
    }
    const now = this.dependencies.clock.now().toISOString()
    const completedOperation: PresentationJobV2ProviderOperation = {
      ...operation,
      status: 'COMPLETED',
      usage: result.usage,
      completedAt: now,
    }
    await this.save({
      ...job,
      status: 'COMPLETED',
      phase: 'COMPLETE',
      progressPercent: 100,
      quality: result.quality,
      artifact,
      providerOperations: [completedOperation],
      usage: this.usage(result.usage, now),
      updatedAt: now,
    })
  }

  private async reconcile(job: PresentationJobV2Record) {
    const operation = job.providerOperations.at(-1)
    if (!operation || operation.status !== 'COMPLETED') return
    const result = await this.dependencies.provider.inspect({
      jobId: job.id,
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
    })
    if (result.state !== 'COMPLETED' || result.usage.unknownImageOperations > 0) return
    const now = this.dependencies.clock.now().toISOString()
    await this.save({
      ...job,
      providerOperations: [{ ...operation, usage: result.usage }],
      usage: this.usage(result.usage, now),
      updatedAt: now,
    })
  }

  private async fail(job: PresentationJobV2Record, errorCode: string, usage: PresentationJobV2UsageSummary) {
    const now = this.dependencies.clock.now().toISOString()
    const operation = job.providerOperations.at(-1)
    await this.save({
      ...job,
      status: 'FAILED',
      phase: 'FAILED',
      progressPercent: 100,
      quality: null,
      artifact: null,
      providerOperations: operation ? [{ ...operation, status: 'FAILED', usage, completedAt: now }] : [],
      usage: this.usage(usage, now),
      errorCode,
      updatedAt: now,
    })
  }

  private usage(summary: PresentationJobV2UsageSummary, now: string): PresentationJobV2Record['usage'] {
    return summary.unknownImageOperations > 0
      ? { ...summary, usageVersion: 1, status: 'RECONCILING', action: 'WAIT', finalizedAt: null }
      : { ...summary, usageVersion: 1, status: 'FINALIZED', action: 'NONE', finalizedAt: now }
  }

  private async save(job: PresentationJobV2Record) {
    const current = await this.dependencies.repository.getPresentationJob(job.id)
    if (current?.usage.status === 'FINALIZED' && canonicalPresentationJobV2Json(current.usage) !== canonicalPresentationJobV2Json(job.usage)) {
      throw new PresentationJobV2Error(409, 'PRESENTATION_USAGE_FINALIZED')
    }
    await this.dependencies.repository.savePresentationJob(job)
  }

  private async requireOwned(owner: PresentationJobV2Owner, jobId: string) {
    const job = await this.dependencies.repository.getPresentationJob(jobId)
    if (!job || !sameOwner(job.owner, owner)) throw new PresentationJobV2Error(404, 'PRESENTATION_JOB_NOT_FOUND')
    return job
  }

  private replayOrConflict(existing: PresentationJobV2Record, requestHash: string) {
    if (existing.requestHash !== requestHash) {
      throw new PresentationJobV2Error(409, 'PRESENTATION_JOB_IDEMPOTENCY_CONFLICT')
    }
    return { job: publicJob(existing), replayed: true }
  }

  private validOwner(owner: PresentationJobV2Owner) {
    return this.validIdentifier(owner.tenantId)
      && this.validIdentifier(owner.externalUserId)
      && (owner.externalProjectId === null || this.validIdentifier(owner.externalProjectId))
  }

  private validIdentifier(value: string) {
    return value.length >= 1 && value.length <= 160 && value === value.trim()
  }
}

import type {
  ApprovedPageDesignSnapshotSource,
  PresentationJobV2CreateRequest,
  PresentationJobV2UsagePolicy,
  PresentationJobV2UsageSummary,
} from '../presentation-job-v2-contracts'

export const PRESENTATION_JOB_V2_PPTX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const

export type PresentationJobV2Owner = Readonly<{
  tenantId: string
  externalUserId: string
  externalProjectId: string | null
}>

export type PresentationJobV2Status = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
export type PresentationJobV2Phase = 'ACCEPTED' | 'GENERATING' | 'DELIVERING' | 'COMPLETE' | 'FAILED'
export type PresentationJobV2Quality = 'PASSED' | 'BEST_EFFORT' | null
export type PresentationJobV2UsageStatus = 'PENDING' | 'RECONCILING' | 'FINALIZED'

export type PresentationJobV2Artifact = Readonly<{
  artifactId: string
  name: string
  mimeType: typeof PRESENTATION_JOB_V2_PPTX_MIME_TYPE
  sha256: string
  byteLength: number
}>

export type PresentationJobV2ProviderOperation = Readonly<{
  idempotencyKey: string
  operationId: string
  status: 'SUBMITTED' | 'COMPLETED' | 'FAILED'
  usage: PresentationJobV2UsageSummary
  createdAt: string
  completedAt: string | null
}>

export type PresentationJobV2UsageRecord = Readonly<PresentationJobV2UsageSummary & {
  usageVersion: 1
  status: PresentationJobV2UsageStatus
  action: 'WAIT' | 'NONE'
  finalizedAt: string | null
}>

export type PresentationJobV2Record = Readonly<{
  id: string
  creationKey: string
  requestHash: string
  owner: PresentationJobV2Owner
  request: PresentationJobV2CreateRequest
  status: PresentationJobV2Status
  phase: PresentationJobV2Phase
  progressPercent: number
  quality: PresentationJobV2Quality
  artifact: PresentationJobV2Artifact | null
  providerOperations: readonly PresentationJobV2ProviderOperation[]
  usage: PresentationJobV2UsageRecord
  errorCode: string | null
  createdAt: string
  updatedAt: string
}>

export type PublicPresentationJobV2 = Readonly<{
  contractVersion: '2.0'
  jobId: string
  status: PresentationJobV2Status
  phase: PresentationJobV2Phase
  progress: Readonly<{ percent: number }>
  usagePolicy: PresentationJobV2UsagePolicy
  quality: PresentationJobV2Quality
  artifact: PresentationJobV2Artifact | null
  createdAt: string
  updatedAt: string
}>

export type PublicPresentationJobV2Usage = Readonly<{
  contractVersion: '2.0'
  jobId: string
  usageVersion: 1
  usagePolicy: PresentationJobV2UsagePolicy
  status: PresentationJobV2UsageStatus
  action: 'WAIT' | 'NONE'
  billableImageOperations: number
  notChargedImageOperations: number
  unknownImageOperations: number
  byModel: PresentationJobV2UsageSummary['byModel']
  finalizedAt: string | null
}>

export interface PresentationJobV2Repository {
  createPresentationJob(job: PresentationJobV2Record): Promise<void>
  getPresentationJob(jobId: string): Promise<PresentationJobV2Record | null>
  savePresentationJob(job: PresentationJobV2Record): Promise<void>
  listRunnablePresentationJobs(input: Readonly<{ limit: number }>): Promise<readonly PresentationJobV2Record[]>
}

export interface PresentationJobV2BudgetPolicy {
  authorize(input: Readonly<{
    owner: PresentationJobV2Owner
    jobId: string
    operationIdempotencyKey: string
    priorProviderOperations: number
  }>): Promise<Readonly<{ allowed: boolean }>>
}

export type PresentationJobV2ProviderResult =
  | Readonly<{ state: 'RUNNING' }>
  | Readonly<{
      state: 'COMPLETED'
      artifact: Readonly<{
        bytes: Uint8Array
        name: string
        mimeType: typeof PRESENTATION_JOB_V2_PPTX_MIME_TYPE
      }>
      quality: 'PASSED' | 'BEST_EFFORT' | 'BLOCKING_FAILURE'
      usage: PresentationJobV2UsageSummary
    }>
  | Readonly<{
      state: 'FAILED'
      errorCode: string
      usage: PresentationJobV2UsageSummary
    }>

export interface PresentationJobV2ProviderPort {
  submit(input: Readonly<{
    jobId: string
    owner: PresentationJobV2Owner
    source: ApprovedPageDesignSnapshotSource
    idempotencyKey: string
    maximumBillableImageOperations: number
  }>): Promise<Readonly<{ operationId: string }>>

  inspect(input: Readonly<{
    jobId: string
    operationId: string
    idempotencyKey: string
  }>): Promise<PresentationJobV2ProviderResult>
}

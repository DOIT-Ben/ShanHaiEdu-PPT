import type { PresentationBlueprint } from '../presentation-contracts'
import type {
  QuickDeckEvaluationArtifact,
  QuickDeckEvaluationEvent,
  QuickDeckEvaluationEventInput,
  QuickDeckEvaluationFailureCode,
  QuickDeckEvaluationPhase,
  QuickDeckEvaluationRequest,
  QuickDeckEvaluationRuntimeEvidence,
  QuickDeckEvaluationStatus,
} from '../quick-deck-evaluation-contracts'
import type { ImageAspectDiagnostics, MediaBillingState } from './ports'

export type QuickDeckEvaluationPageRecord = Readonly<{
  pageNumber: number
  status: 'PENDING' | 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
  submissionState: 'NOT_SUBMITTED' | 'SUBMITTED' | 'UNKNOWN'
  billingState: MediaBillingState
  idempotencyKey: string
  operationId: string | null
  providerRequestId: string | null
  artifactId: string | null
  width: number | null
  height: number | null
  aspectRatioValidated: boolean
  aspectDiagnostics: ImageAspectDiagnostics | null
  sha256: string | null
  errorCode: string | null
}>

export type QuickDeckEvaluationArtifactRecord = Readonly<{
  artifactId: string
  name: string
  mimeType: QuickDeckEvaluationArtifact['mimeType']
  sha256: string
  byteLength: number
}>

export interface QuickDeckEvaluationArtifactCleanupPort {
  remove(input: Readonly<{
    tenantId: string
    artifactId: string
  }>): Promise<void>
}

export type QuickDeckEvaluationRecord = Readonly<{
  id: string
  tenantId: string
  request: QuickDeckEvaluationRequest
  requestHash: string
  textModel: string
  imageModel: string
  evidenceContext: QuickDeckEvaluationRuntimeEvidence | null
  status: QuickDeckEvaluationStatus
  phase: QuickDeckEvaluationPhase
  blueprint: PresentationBlueprint | null
  pages: readonly QuickDeckEvaluationPageRecord[]
  pptx: QuickDeckEvaluationArtifactRecord | null
  preview: QuickDeckEvaluationArtifactRecord | null
  errorCode: QuickDeckEvaluationFailureCode | null
  /** The first terminal media fault while accepted operations are drained. */
  pendingFailure: QuickDeckEvaluationFailureCode | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  expiresAt: string
  drainStartedAt: string | null
  drainDeadline: string | null
  nextAttemptAt: string | null
  updatedAt: string
  /** Internal-only TTL cleanup queue state; never exposed by the public job projection. */
  cleanupPending?: boolean
  cleanupDeadline?: string | null
  cleanupAuditRequired?: boolean
}>

export interface QuickDeckEvaluationRepository {
  create(input: Readonly<{
    record: QuickDeckEvaluationRecord
    event: QuickDeckEvaluationEventInput
    maxActiveJobs: number
    maxDailyJobs: number
    dayStart: string
  }>): Promise<'CREATED' | 'DAILY_LIMIT' | 'CONCURRENCY_LIMIT'>
  get(jobId: string): Promise<QuickDeckEvaluationRecord | null>
  save(input: Readonly<{
    record: QuickDeckEvaluationRecord
    event?: QuickDeckEvaluationEventInput
  }>): Promise<void>
  listRunnable(input: Readonly<{ now: string; limit: number }>): Promise<readonly QuickDeckEvaluationRecord[]>
  /**
   * Atomically assigns runnable evaluations to one worker. The lease is
   * internal-only: public evaluation state never exposes worker ownership.
   */
  claimRunnable(input: Readonly<{
    now: string
    leaseToken: string
    leaseUntil: string
    limit: number
    excludeJobIds?: readonly string[]
  }>): Promise<readonly QuickDeckEvaluationRecord[]>
  /** Atomically renews the claim and writes one state transition under the same fence token. */
  saveClaimed(input: Readonly<{
    record: QuickDeckEvaluationRecord
    event?: QuickDeckEvaluationEventInput
    leaseToken: string
    now: string
    leaseUntil: string
  }>): Promise<boolean>
  releaseClaim(input: Readonly<{ jobId: string; leaseToken: string }>): Promise<boolean>
  listExpired(input: Readonly<{ now: string; limit: number }>): Promise<readonly QuickDeckEvaluationRecord[]>
  readEvents(input: Readonly<{
    jobId: string
    afterSequence: number
    limit: number
  }>): Promise<Readonly<{
    events: readonly QuickDeckEvaluationEvent[]
    hasMore: boolean
    terminalSequence: number | null
  }>>
  recoverInterrupted(input: Readonly<{
    now: string
    defaultDrainDeadline: string
  }>): Promise<number>
}

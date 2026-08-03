import type {
  KnownAgentEvent as AgentEvent,
  CreateRunRequest,
  HostContext,
  PendingTerminalFailure,
  RunStatus,
  TechnicalRecovery,
} from '../contracts'
import type {
  AssetIntent,
  DeckReview,
  DeliveryRecord,
  DeliveryRecordInput,
  PresentationBlueprint,
  RevisionPlan,
} from '../presentation-contracts'
import type { ReleaseIdentity } from '../release-identity'
import type { TerminalAccounting } from '../terminal-accounting-contracts'

export type SourceChunk = Readonly<{
  id: string
  sourceId?: string
  text: string
  sha256: string
  pageStart?: number
  pageEnd?: number
  region?: Readonly<{ x: number; y: number; width: number; height: number }>
}>

export type SourceAsset = Readonly<{
  id: string
  sourceId: string
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteLength: number
  sha256: string
  width: number
  height: number
  pageNumber?: number
  region?: Readonly<{ x: number; y: number; width: number; height: number }>
  caption?: string
  ocrText?: string
  bytes: Uint8Array
}>

export type SourceMaterial = Readonly<{
  id: string
  name: string
  kind: 'TEXT' | 'IMAGE' | 'PDF' | 'MARKDOWN'
  mimeType?: string
  pageCount?: number
  status: 'READY' | 'FAILED'
  failureCode?: string
}>

export type DocumentResult = Readonly<{
  name: string
  chunks: readonly SourceChunk[]
  sources?: readonly SourceMaterial[]
  assets?: readonly SourceAsset[]
  isComplete: boolean
  missingRanges: readonly string[]
}>

export interface DocumentPort {
  resolve(input: Readonly<{
    host: HostContext
    source: CreateRunRequest['source']
  }>): Promise<DocumentResult>
}

export interface StructuredModelPort {
  readonly modelName?: string
  execute(input: Readonly<{
    tenantId?: string
    operation: string
    schemaName: string
    payload: unknown
    sourceAssets?: readonly SourceAsset[]
    idempotencyKey: string
    structuredGenerationProtocol?: StructuredGenerationProtocol
  }>): Promise<unknown>
}

export type StructuredModelExecutionMetrics = Readonly<{
  outcome: 'SUCCEEDED' | 'FAILED'
  errorCode: string | null
  requestId: string | null
  status: number | null
  responseAccepted: boolean
  sseEventCount: number
  lastActivityAt: string | null
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  submissionState?: StructuredSubmissionState
}>

export interface StructuredModelMetricsPort {
  takeExecutionMetrics(idempotencyKey: string): StructuredModelExecutionMetrics | null
}

/** The protocol is selected once during V4 preflight and remains fixed for a run. */
export type StructuredGenerationProtocol =
  | 'RESPONSES_JSON_SCHEMA'
  | 'RESPONSES_FUNCTION'
  | 'CHAT_LEGACY'

export interface StructuredGenerationPreflightPort {
  preflightStructuredGeneration(input: Readonly<{
    tenantId?: string
    idempotencyKey: string
  }>): Promise<Readonly<{ protocol: StructuredGenerationProtocol }>>
}

export type StructuredSubmissionState = 'NOT_ACCEPTED' | 'ACCEPTED' | 'UNKNOWN'

export type StructuredContractFailure = Readonly<{
  layer: 'JSON_PARSE' | 'JSON_SCHEMA'
  safeIssues: readonly Readonly<{
    issueCode: string
    path: readonly (string | number)[]
  }>[]
  responseHash: string
  byteLength: number
}>

export class StructuredModelError extends Error {
  constructor(
    readonly code: 'PROVIDER_TIMEOUT' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_UNAVAILABLE'
      | 'MODEL_AUTH_FAILED' | 'MODEL_FORBIDDEN' | 'MODEL_NOT_FOUND' | 'MODEL_JSON_INVALID',
    readonly retryable: boolean,
    readonly model: string,
    readonly requestId: string | null,
    readonly status: number | null = null,
    readonly submissionState: StructuredSubmissionState = 'ACCEPTED',
    readonly contractFailure: StructuredContractFailure | null = null,
  ) {
    super(code)
    this.name = 'StructuredModelError'
  }
}

export type ContractRepairIssue = Readonly<{
  path: string
  message: string
}>

export type MediaSubmissionState = 'NOT_SUBMITTED' | 'SUBMITTED' | 'UNKNOWN'

export class MediaSubmissionError extends Error {
  constructor(
    readonly code: string,
    readonly submissionState: Exclude<MediaSubmissionState, 'SUBMITTED'>,
    message: string,
  ) {
    super(message)
    this.name = 'MediaSubmissionError'
  }
}

export interface ImageGenerationPort {
  submit(input: Readonly<{
    tenantId: string
    prompt: string
    negativePrompt?: string
    model: string
    aspectRatio: '16:9' | '4:3' | '1:1' | '3:4'
    backgroundMode?: 'OPAQUE' | 'TRANSPARENT'
    referenceImage?: Readonly<{
      mimeType: SourceAsset['mimeType']
      bytes: Uint8Array
      sha256: string
    }>
    idempotencyKey: string
  }>): Promise<Readonly<{
    operationId: string
    state: 'QUEUED' | 'PROCESSING' | 'COMPLETED'
  }>>

  /**
   * Recovers an asynchronous image-task submission after a process stops
   * between durable SUBMITTING state and the Provider response. The original
   * image idempotency key is the only lookup key that may be used.
   */
  lookupByIdempotency?(input: Readonly<{
    tenantId: string
    idempotencyKey: string
  }>): Promise<
    | Readonly<{ state: 'SUBMITTED'; operationId: string }>
    | Readonly<{ state: 'NOT_SUBMITTED' | 'UNKNOWN' }>
  >

  inspect(input: Readonly<{
    tenantId: string
    operationId: string
    idempotencyKey?: string
    backgroundMode?: 'OPAQUE' | 'TRANSPARENT'
  }>): Promise<
    | Readonly<{ state: 'QUEUED' | 'PROCESSING'; retryAfterMs?: number }>
    | Readonly<{ state: 'COMPLETED'; artifactId: string }>
    | Readonly<{ state: 'FAILED'; errorCode: string; billingState: 'NOT_CHARGED' | 'CHARGED' | 'UNKNOWN' }>
  >
}

export type AssetLicense = 'PUBLIC_DOMAIN' | 'CC0' | 'CC_BY'

export type AssetCandidate = Readonly<{
  provider: 'WIKIMEDIA_COMMONS' | 'OPENVERSE'
  providerAssetId: string
  title: string
  sourceUrl: string
  downloadUrl: string
  creator: string | null
  license: AssetLicense
  licenseUrl: string
  attribution: string | null
  mimeType: SourceAsset['mimeType']
  width: number
  height: number
}>

export type AcquiredWebAsset = Readonly<{
  candidate: AssetCandidate
  bytes: Uint8Array
  sha256: string
}>

export interface AssetDiscoveryPort {
  search(input: Readonly<{
    tenantId: string
    intent: AssetIntent
    aspectRatio: '16:9' | '4:3' | '1:1' | '3:4'
    idempotencyKey: string
  }>): Promise<readonly AssetCandidate[]>

  acquire(input: Readonly<{
    tenantId: string
    candidate: AssetCandidate
    idempotencyKey: string
  }>): Promise<AcquiredWebAsset>
}

export interface AssetCandidateReviewPort {
  reviewCandidate(input: Readonly<{
    tenantId: string
    candidate: AssetCandidate
    bytes: Uint8Array
    intent: AssetIntent
    knowledgePoint: string
    role: string
    visualDirection: string
    idempotencyKey: string
  }>): Promise<unknown>
}

export interface VisualReviewPort {
  review(input: Readonly<{
    tenantId: string
    artifactId: string
    visualIntent: string
    layout: string
    visualDirection: string
    idempotencyKey: string
    contractRepairIssues?: readonly ContractRepairIssue[]
    structuredGenerationProtocol?: StructuredGenerationProtocol
  }>): Promise<unknown>
}

export interface DeckReviewPort {
  evaluate(input: Readonly<{
    tenantId: string
    blueprint: PresentationBlueprint
    sourceChunks: readonly SourceChunk[]
    slides: readonly Readonly<{
      slideId: string
      pageNumber: number
      artifactId: string
      title: string
      body: readonly string[]
      layout: string
      visualIntent: string
      sourceChunkIds: readonly string[]
      assets?: readonly Readonly<{
        elementId: string
        role: string
        artifactId: string
        knowledgePoint: string
        sourceChunkIds: readonly string[]
      }>[]
    }>[]
    idempotencyKey: string
    contractRepairIssues?: readonly ContractRepairIssue[]
    structuredGenerationProtocol?: StructuredGenerationProtocol
  }>): Promise<unknown>
}

export interface RevisionPlanningPort {
  plan(input: Readonly<{
    tenantId: string
    blueprint: PresentationBlueprint
    review: DeckReview
    sourceChunks: readonly SourceChunk[]
    targetRevisionRound: number
    idempotencyKey: string
    contractRepairIssues?: readonly ContractRepairIssue[]
    structuredGenerationProtocol?: StructuredGenerationProtocol
  }>): Promise<unknown>
}

export interface RevisionApplicationPort {
  apply(input: Readonly<{
    tenantId: string
    blueprint: PresentationBlueprint
    plan: RevisionPlan
    sourceChunks: readonly SourceChunk[]
    idempotencyKey: string
    contractRepairIssues?: readonly ContractRepairIssue[]
    structuredGenerationProtocol?: StructuredGenerationProtocol
  }>): Promise<unknown>
}

export interface BudgetPort {
  reserve(input: Readonly<{
    host: HostContext
    model: string
    units: number
    idempotencyKey: string
  }>): Promise<Readonly<{ reservationId: string }>>

  settle(input: Readonly<{
    host: HostContext
    reservationId: string
    idempotencyKey: string
  }>): Promise<void>

  release(input: Readonly<{
    host: HostContext
    reservationId: string
    idempotencyKey: string
  }>): Promise<void>
}

/**
 * V4 charges an approved initial deck as one durable batch. Page steps retain
 * local allocation only; they must not create user-visible credit operations.
 */
export interface BatchBudgetPort {
  /** Verifies that the host can atomically settle and release one deck authorization. */
  preflightBatchFinalization(input: Readonly<{
    host: HostContext
  }>): Promise<void>

  reserveBatch(input: Readonly<{
    host: HostContext
    model: string
    units: number
    batchId: string
    idempotencyKey: string
  }>): Promise<Readonly<{ reservationId: string }>>

  /**
   * Atomically settles the Provider-confirmed portion and releases the rest of
   * one authorized deck. A host must not implement this as two credit calls.
   */
  finalizeBatch(input: Readonly<{
    host: HostContext
    reservationId: string
    batchId: string
    settledUnits: number
    releasedUnits: number
    idempotencyKey: string
  }>): Promise<void>
}

export class BudgetReservationError extends Error {
  constructor(
    readonly code: string,
    readonly reservationState: 'NOT_RESERVED' | 'UNKNOWN',
    message: string,
  ) {
    super(message)
    this.name = 'BudgetReservationError'
  }
}

export interface ArtifactPort {
  put(input: Readonly<{
    tenantId: string
    runId: string
    name: string
    mimeType: string
    bytes: Uint8Array
    idempotencyKey: string
  }>): Promise<Readonly<{ artifactId: string; sha256: string }>>

  get(input: Readonly<{
    tenantId: string
    artifactId: string
  }>): Promise<Readonly<{
    mimeType: string
    bytes: Uint8Array
    sha256: string
  }> | null>

  getByIdempotencyKey(input: Readonly<{
    tenantId: string
    idempotencyKey: string
  }>): Promise<Readonly<{
    artifactId: string
    mimeType: string
    bytes: Uint8Array
    sha256: string
  }> | null>
}

export interface PresentationRendererPort {
  renderSlidePreviews(input: Readonly<{
    blueprint: PresentationBlueprint
    slides: readonly Readonly<{
      pageNumber: number
      image: Uint8Array
      imageMimeType: string
      assets?: readonly Readonly<{ elementId: string; image: Uint8Array; imageMimeType: string }>[]
    }>[]
  }>): Promise<readonly Readonly<{ pageNumber: number; image: Uint8Array }>[]>

  renderPreviewFromSlidePreviews(input: Readonly<{
    slides: readonly Readonly<{ pageNumber: number; image: Uint8Array }>[]
  }>): Promise<Uint8Array>

  renderPreview(input: Readonly<{
    blueprint: PresentationBlueprint
    slides: readonly Readonly<{
      pageNumber: number
      image: Uint8Array
      imageMimeType: string
      assets?: readonly Readonly<{ elementId: string; image: Uint8Array; imageMimeType: string }>[]
    }>[]
  }>): Promise<Uint8Array>

  renderPptx(input: Readonly<{
    blueprint: PresentationBlueprint
    slides: readonly Readonly<{
      pageNumber: number
      image: Uint8Array
      imageMimeType: string
      assets?: readonly Readonly<{ elementId: string; image: Uint8Array; imageMimeType: string }>[]
    }>[]
  }>): Promise<Uint8Array>
}

export interface ClockPort {
  now(): Date
}

export type RunRecord = Readonly<{
  id: string
  creationKey: string
  requestHash: string
  host: HostContext
  source: CreateRunRequest['source']
  slideCount: number
  visualDirection: string
  targetAudience?: string
  presentationGoal?: string
  imageModel: string
  automationLevel: CreateRunRequest['automationLevel']
  presentationMode?: CreateRunRequest['presentationMode']
  coverDesignMode?: CreateRunRequest['coverDesignMode']
  assetAcquisitionPolicy?: CreateRunRequest['assetAcquisitionPolicy']
  maxVisualAssetsPerSlide?: CreateRunRequest['maxVisualAssetsPerSlide']
  visualDeckV4?: CreateRunRequest['visualDeckV4']
  release?: ReleaseIdentity
  maxRevisionRounds: number
  revisionRound: number
  planningAttempt?: number
  v4StructuredGenerationProtocol?: StructuredGenerationProtocol
  qualityScore: number | null
  status: RunStatus
  resumeState: RunStatus | null
  technicalRecovery?: TechnicalRecovery
  pendingTerminalFailure?: PendingTerminalFailure
  terminalAccounting?: TerminalAccounting
  version: number
  budgetUnits: number
  committedBudgetUnits: number
  qualityOverride: boolean
  qualityOverrideReason: string | null
  qualityOverrideBy: string | null
  qualityOverrideRole?: HostContext['role'] | null
  qualityOverrideIssueIds?: readonly string[]
  qualityOverrideAt?: string | null
  leaseToken: string | null
  leaseUntil: string | null
  leaseVersion: number
  createdAt: string
  updatedAt: string
}>

export type RunListCursor = Readonly<Pick<RunRecord, 'updatedAt' | 'id'>>

export type TenantRevisionRoundsSettings = Readonly<{
  maxRevisionRounds: number
  version: number
  isConfigured: boolean
  updatedAt: string | null
  updatedBy: string | null
}>

export type OwnedRunPage = Readonly<{
  runs: readonly RunRecord[]
  hasMore: boolean
}>

export type StepStatus =
  | 'RUNNING' | 'RESERVED' | 'SUBMITTING' | 'WAITING' | 'COMPLETED' | 'RELEASING' | 'FAILED'
  | 'RESERVATION_UNKNOWN' | 'SUBMISSION_UNKNOWN'
  | 'COMPLETED_AFTER_CANCEL' | 'FAILED_NOT_CHARGED' | 'FAILED_CHARGED' | 'BILLING_UNKNOWN'

export type StepRecord = Readonly<{
  id: string
  runId: string
  idempotencyKey: string
  inputHash: string
  tool: string
  status: StepStatus
  budgetUnits: number
  budgetReservationId: string | null
  externalOperationId: string | null
  errorCode: string | null
  output: unknown | null
  createdAt: string
  updatedAt: string
}>

export type NewAgentEvent = Omit<AgentEvent, 'id' | 'eventId' | 'runId' | 'sequence' | 'createdAt'>

export type PlanningFailureFilters = Readonly<{
  tenantId: string
  errorCode: string | null
  model: string | null
  contractVersion: string | null
}>

export type PlanningFailureAggregate = Readonly<{
  errorCode: string
  model: string | null
  contractVersion: string
  count: number
  lastOccurredAt: string
}>

export type EventPage = Readonly<{
  events: readonly AgentEvent[]
  nextAfter: number
  hasMore: boolean
  byteLength: number
}>

export type TerminalAgentEvent = Extract<AgentEvent, {
  type: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.accounting.finalized'
}>

export type RunEventSnapshot = Readonly<{
  openIssues: readonly Extract<AgentEvent, { type: 'issue.detected' }>['payload'][]
  progress: readonly Extract<AgentEvent, { type: 'tool.progress' }>['payload'][]
}>

export type OperationsFilters = Readonly<{
  tenantId: string
  status: RunStatus | null
  externalUserId: string | null
  errorCode: string | null
  createdFrom: string | null
  createdTo: string | null
  offset: number
  limit: number
  now: string
  waitingSlaMs: number
  stepSlaMs: number
}>

export type OperationsPercentiles = Readonly<{ p50: number | null; p95: number | null; p99: number | null }>

export type OperationsReport = Readonly<{
  runs: readonly Readonly<{
    id: string
    externalUserId: string
    status: RunStatus
    version: number
    lastErrorCode: string | null
    reconciliationCount: number
    createdAt: string
    updatedAt: string
  }>[]
  totalRuns: number
  totalReconciliation: number
  reconciliation: readonly Readonly<{
    id: string
    runId: string
    runVersion: number
    stepId: string
    stepKey: string
    status: StepStatus
    errorCode: string
    ageMs: number
    allowedActions: readonly ('REINSPECT' | 'MARK_NOT_CHARGED' | 'MARK_CHARGED')[]
    updatedAt: string
  }>[]
  metrics: Readonly<{
    successRate: number | null
    phaseLatencyMs: Readonly<Record<string, OperationsPercentiles>>
    queueWaitMs: OperationsPercentiles
    providerFailureRate: number | null
    unknownBillingCount: number
  }>
}>

export interface AgentTransaction {
  readonly run: RunRecord
  getStep(idempotencyKey: string): StepRecord | null
  listSteps(): readonly StepRecord[]
  listEvents(): readonly AgentEvent[]
  getDelivery(deliveryId: string): DeliveryRecord | null
  putRun(run: RunRecord): void
  putStep(step: StepRecord): void
  putDelivery(delivery: DeliveryRecordInput): void
  appendEvent(event: NewAgentEvent): AgentEvent
}

export interface AgentRepository {
  getTenantRevisionRoundsSettings(tenantId: string): Promise<TenantRevisionRoundsSettings>
  updateTenantRevisionRoundsSettings(input: Readonly<{
    tenantId: string
    maxRevisionRounds: number
    expectedVersion: number
    updatedBy: string
    updatedAt: string
  }>): Promise<TenantRevisionRoundsSettings | null>
  createRun(run: RunRecord): Promise<void>
  getRun(runId: string): Promise<RunRecord | null>
  listRuns(): Promise<readonly RunRecord[]>
  listOwnedRuns(input: Readonly<{
    host: Pick<HostContext, 'tenantId' | 'externalUserId'>
    after: RunListCursor | null
    limit: number
  }>): Promise<OwnedRunPage>
  listRunnableRuns(input: Readonly<{ now: string; limit: number }>): Promise<readonly RunRecord[]>
  listRunsWithPendingMedia(limit: number): Promise<readonly string[]>
  listSteps(runId: string): Promise<readonly StepRecord[]>
  listDeliveries(runId: string): Promise<readonly DeliveryRecord[]>
  listEvents(runId: string, afterSequence?: number): Promise<readonly AgentEvent[]>
  getTerminalEvent(runId: string): Promise<TerminalAgentEvent | null>
  readEvents(runId: string, input: Readonly<{ afterSequence: number; limit: number; maxBytes: number }>): Promise<EventPage>
  getRunEventSnapshot(runId: string): Promise<RunEventSnapshot>
  getOperationsReport(filters: OperationsFilters): Promise<OperationsReport>
  aggregatePlanningFailures(filters: PlanningFailureFilters): Promise<Readonly<{
    groups: readonly PlanningFailureAggregate[]
    totalFailures: number
  }>>
  transact<T>(runId: string, operation: (transaction: AgentTransaction) => T): Promise<T>
}

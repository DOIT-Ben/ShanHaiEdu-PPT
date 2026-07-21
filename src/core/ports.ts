import type { AgentEvent, CreateRunRequest, HostContext, RunStatus } from '../contracts'
import type { DeckReview, DeliveryRecord, PresentationBlueprint, RevisionPlan } from '../presentation-contracts'

export type SourceChunk = Readonly<{
  id: string
  text: string
  sha256: string
  pageStart?: number
  pageEnd?: number
}>

export type DocumentResult = Readonly<{
  name: string
  chunks: readonly SourceChunk[]
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
  execute(input: Readonly<{
    operation: string
    schemaName: string
    payload: unknown
    idempotencyKey: string
  }>): Promise<unknown>
}

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
    idempotencyKey: string
  }>): Promise<Readonly<{
    operationId: string
    state: 'QUEUED' | 'PROCESSING' | 'COMPLETED'
  }>>

  inspect(input: Readonly<{
    tenantId: string
    operationId: string
  }>): Promise<
    | Readonly<{ state: 'QUEUED' | 'PROCESSING' }>
    | Readonly<{ state: 'COMPLETED'; artifactId: string }>
    | Readonly<{ state: 'FAILED'; errorCode: string; billingState: 'NOT_CHARGED' | 'CHARGED' | 'UNKNOWN' }>
  >
}

export interface VisualReviewPort {
  review(input: Readonly<{
    tenantId: string
    artifactId: string
    visualIntent: string
    layout: string
    visualDirection: string
    idempotencyKey: string
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
  }>): Promise<unknown>
}

export interface RevisionApplicationPort {
  apply(input: Readonly<{
    tenantId: string
    blueprint: PresentationBlueprint
    plan: RevisionPlan
    sourceChunks: readonly SourceChunk[]
    idempotencyKey: string
  }>): Promise<unknown>
}

export interface BudgetPort {
  reserve(input: Readonly<{
    host: HostContext
    units: number
    idempotencyKey: string
  }>): Promise<Readonly<{ reservationId: string }>>

  release(input: Readonly<{
    host: HostContext
    reservationId: string
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
  imageModel: string
  automationLevel: CreateRunRequest['automationLevel']
  presentationMode?: CreateRunRequest['presentationMode']
  coverDesignMode?: CreateRunRequest['coverDesignMode']
  maxVisualAssetsPerSlide?: CreateRunRequest['maxVisualAssetsPerSlide']
  maxRevisionRounds: number
  revisionRound: number
  qualityScore: number | null
  status: RunStatus
  resumeState: RunStatus | null
  version: number
  budgetUnits: number
  committedBudgetUnits: number
  qualityOverride: boolean
  qualityOverrideReason: string | null
  qualityOverrideBy: string | null
  leaseToken: string | null
  leaseUntil: string | null
  leaseVersion: number
  createdAt: string
  updatedAt: string
}>

export type StepStatus = 'RUNNING' | 'RESERVED' | 'SUBMITTING' | 'WAITING' | 'COMPLETED' | 'RELEASING' | 'FAILED' | 'RESERVATION_UNKNOWN' | 'SUBMISSION_UNKNOWN'

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

export type NewAgentEvent = Omit<AgentEvent, 'id' | 'runId' | 'sequence' | 'createdAt'>

export interface AgentTransaction {
  readonly run: RunRecord
  getStep(idempotencyKey: string): StepRecord | null
  getDelivery(deliveryId: string): DeliveryRecord | null
  putRun(run: RunRecord): void
  putStep(step: StepRecord): void
  putDelivery(delivery: DeliveryRecord): void
  appendEvent(event: NewAgentEvent): AgentEvent
}

export interface AgentRepository {
  createRun(run: RunRecord): Promise<void>
  getRun(runId: string): Promise<RunRecord | null>
  listRuns(): Promise<readonly RunRecord[]>
  listSteps(runId: string): Promise<readonly StepRecord[]>
  listDeliveries(runId: string): Promise<readonly DeliveryRecord[]>
  listEvents(runId: string, afterSequence?: number): Promise<readonly AgentEvent[]>
  transact<T>(runId: string, operation: (transaction: AgentTransaction) => T): Promise<T>
}

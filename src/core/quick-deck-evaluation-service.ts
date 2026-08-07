import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { MediaSubmissionError, type ArtifactPort, type ClockPort, type ImageAspectDiagnostics, type ImageGenerationPort, type PresentationRendererPort, type StructuredModelPort } from './ports'
import { blueprintImageRequirements, hasVisualDeckV4AspectRatio } from './blueprint-assets'
import { hashInput } from './hash'
import { assertReadablePptxArtifact } from './pptx-artifact-validation'
import { V4PlanCompiler } from './v4-manuscript-compiler'
import { createVisualDeckV4BlueprintFromProposal, type VisualDeckV4CompilerInput } from './visual-deck-v4-planner'
import {
  QUICK_DECK_EVALUATION_ARTIFACT_PREFIX,
  QUICK_DECK_EVALUATION_MAX_IMAGE_DIMENSION,
  quickDeckImageAspectDiagnosticsSchema,
  quickDeckEvaluationPublicJobSchema,
  quickDeckEvaluationEvidenceSchema,
  quickDeckEvaluationFailureCodeSchema,
  quickDeckEvaluationRequestSchema,
  type QuickDeckContentFormat,
  type QuickDeckEvaluationEvent,
  type QuickDeckEvaluationEventInput,
  type QuickDeckEvaluationFailureCode,
  type QuickDeckEvaluationPublicJob,
  type QuickDeckEvaluationRequest,
} from '../quick-deck-evaluation-contracts'
import {
  isV4ManuscriptContextTooLargeError,
  visualDeckV4CreativeManuscriptSchema,
  visualDeckV4ReviewManuscriptSchema,
} from '../visual-deck-v4-contracts'
import type {
  QuickDeckEvaluationArtifactRecord,
  QuickDeckEvaluationArtifactCleanupPort,
  QuickDeckEvaluationRecord,
  QuickDeckEvaluationPageRecord,
  QuickDeckEvaluationRepository,
} from './quick-deck-evaluation-ports'
import { V4EvidenceWindowCompiler } from './v4-evidence-window-compiler'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const
const PREVIEW_MIME = 'image/png' as const
const QUICK_DECK_DRAIN_TIMEOUT_MS = 15 * 60_000
const QUICK_DECK_EVALUATION_LEASE_MS = 5 * 60_000

export type QuickDeckEvidenceContext = Readonly<{
  runtimeMode: 'GATEWAY' | 'MOCK'
  softwareVersion: string
  gitSha: string
  releaseId: string
  startedAt: string
}>

export class QuickDeckEvaluationError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'QuickDeckEvaluationError'
  }
}

export type QuickDeckEvaluationModelEligibility = 'READY' | 'NOT_READY' | 'UNAVAILABLE'

/**
 * Evaluator credentials are isolated from the formal Run credentials, so the
 * quick-deck service receives a narrow, current eligibility decision instead
 * of holding a startup-time model whitelist as its source of truth.
 */
export interface QuickDeckEvaluationModelEligibilityPort {
  check(input: Readonly<{
    textModel: string
    imageModels: readonly string[]
  }>): Promise<QuickDeckEvaluationModelEligibility>
}

type EventInput = QuickDeckEvaluationEventInput
type QuickDeckClaim = Readonly<{ leaseToken: string }>

class QuickDeckClaimLostError extends Error {
  constructor() {
    super('QUICK_DECK_EVALUATION_CLAIM_LOST')
    this.name = 'QuickDeckClaimLostError'
  }
}

function boundedDelay(value: number | undefined) {
  if (!Number.isFinite(value)) return 1_000
  return Math.min(60_000, Math.max(250, Math.round(value!)))
}

function durationMs(startedAt: string | null, completedAt: string | null) {
  if (!startedAt || !completedAt) return null
  const started = Date.parse(startedAt)
  const completed = Date.parse(completedAt)
  return Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : null
}

function utcDayStart(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())).toISOString()
}

function event(
  jobId: string,
  type: QuickDeckEvaluationEvent['type'],
  payload: QuickDeckEvaluationEvent['payload'],
  occurredAt: string,
): EventInput {
  return {
    schemaVersion: '1',
    jobId,
    eventId: `event-${jobId}-${randomUUID()}`,
    type,
    payload,
    occurredAt,
  } as EventInput
}

function contentConfig(request: QuickDeckEvaluationRequest) {
  const name = request.source.name ?? 'quick-deck-evaluation.txt'
  const normalizedText = request.source.text.replace(/\s+/g, ' ').trim()
  const contentCue = `开头：${normalizedText.slice(0, 100)}；结尾：${normalizedText.slice(-160)}`
  const topic = request.source.name
    ? request.source.name.replace(/\.[^.]+$/, '').trim().slice(0, 300) || '受控测试材料'
    : contentCue
  const sourceId = 'quick-deck-source'
  const chunkId = 'quick-deck-source-chunk'
  const source = { kind: 'TEXT' as const, name, text: request.source.text, roleHint: 'CONTENT_SOURCE' as const }
  const chunkSize = 12_000
  const chunks = Array.from({ length: Math.ceil(request.source.text.length / chunkSize) }, (_, index) => {
    const text = request.source.text.slice(index * chunkSize, (index + 1) * chunkSize)
    return {
      id: `${chunkId}-${String(index + 1).padStart(4, '0')}`,
      sourceId,
      text,
      sha256: hashInput(text),
    }
  })
  const document = {
    name,
    sources: [{ id: sourceId, name, kind: 'TEXT' as const, status: 'READY' as const }],
    chunks,
    assets: [],
    isComplete: true,
    missingRanges: [],
  }
  const config = {
    instruction: `基于受控测试材料《${topic}》生成一套快速视觉演示。`,
    sourceMode: 'SOURCE_GROUNDED' as const,
    deckOptions: {
      deckType: 'DETAILED_DECK' as const,
      language: 'zh-CN',
      length: { slideCount: request.slideCount },
      aspectRatio: '16:9' as const,
      audience: request.audience ?? '快速评测观察者',
      focus: `提炼《${topic}》的核心表达`,
      styleHint: request.visualDirection,
    },
  }
  return { source, document, config }
}

function isV4ResponsesProtocolError(error: unknown) {
  return error instanceof Error && error.message === 'V4_CHAIN4_PROTOCOL_UNSUPPORTED'
}

function planningPayload(input: VisualDeckV4CompilerInput) {
  const evidenceWindow = new V4EvidenceWindowCompiler().compile({
    document: input.document,
    instruction: input.config.instruction,
    ...(input.config.deckOptions.focus ? { focus: input.config.deckOptions.focus } : {}),
    ...(input.presentationGoal ? { goal: input.presentationGoal } : {}),
  })
  const sourceReferences = [{
    sourceId: 'quick-deck-source',
    name: input.document.name,
    roleHint: 'CONTENT_SOURCE' as const,
  }]
  return {
    evidenceWindow,
    payload: {
      presentationMode: 'VISUAL_DECK_V4' as const,
      instruction: input.config.instruction,
      deckOptions: input.config.deckOptions,
      sourceMode: input.config.sourceMode,
      sourceReferences,
      slideCount: input.slideCount,
      visualDirection: input.visualDirection,
      ...(input.targetAudience ? { targetAudience: input.targetAudience } : {}),
      originalRequest: {
        instruction: input.config.instruction,
        targetAudience: input.targetAudience ?? null,
        presentationGoal: input.presentationGoal ?? null,
        visualDirection: input.visualDirection,
      },
      frozenConstraints: {
        presentationMode: 'VISUAL_DECK_V4',
        sourceMode: input.config.sourceMode,
        slideCount: input.slideCount,
        deckType: input.config.deckOptions.deckType,
        language: input.config.deckOptions.language,
        aspectRatio: input.config.deckOptions.aspectRatio,
        audience: input.config.deckOptions.audience ?? input.targetAudience ?? '快速评测观察者',
        goal: input.presentationGoal ?? input.config.instruction,
      },
      trustedEvidence: {
        sources: input.document.sources?.map(({ name, kind, status }) => ({ name, kind, status })) ?? [],
        sourceChunks: evidenceWindow.chunks.map((chunk) => ({
          id: chunk.id,
          sourceId: chunk.sourceId ?? null,
          text: chunk.text,
          pageStart: chunk.pageStart ?? null,
          pageEnd: chunk.pageEnd ?? null,
        })),
        missingRanges: input.document.missingRanges,
      },
    },
  }
}

function artifactPublic(record: QuickDeckEvaluationArtifactRecord | null) {
  return record ? { mimeType: record.mimeType, sha256: record.sha256, byteLength: record.byteLength } : null
}

type StoredArtifact = Readonly<{
  artifactId: string
  mimeType: string
  bytes: Uint8Array
  sha256: string
}>

type QuickDeckSlide = Readonly<{
  pageNumber: number
  image: Uint8Array
  imageMimeType: string
}>

function quickDeckArtifactKey(record: Pick<QuickDeckEvaluationRecord, 'id'>, kind: 'preview' | 'pptx') {
  return `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}:${kind}`
}

function storedArtifactRecord(
  artifact: StoredArtifact,
  name: string,
  mimeType: QuickDeckEvaluationArtifactRecord['mimeType'],
): QuickDeckEvaluationArtifactRecord {
  if (artifact.mimeType !== mimeType) throw new Error('QUICK_DECK_ARTIFACT_MIME_INVALID')
  return {
    artifactId: artifact.artifactId,
    name,
    mimeType,
    sha256: artifact.sha256,
    byteLength: artifact.bytes.byteLength,
  }
}

function publicDiagnosticCode(value: string | null | undefined) {
  const normalized = storedDiagnosticCode(value)
  if (!normalized) return null
  if (normalized === 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID') return 'EVALUATION_IMAGE_RATIO_INVALID'
  if (normalized === 'GATEWAY_IMAGE_DIMENSIONS_INVALID') return 'EVALUATION_IMAGE_ARTIFACT_INVALID'
  return normalized
}

function storedDiagnosticCode(value: string | null | undefined) {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  if (['GATEWAY_IMAGE_ASPECT_RATIO_INVALID', 'GATEWAY_IMAGE_DIMENSIONS_INVALID', 'EVALUATION_IMAGE_SUBMISSION_SKIPPED'].includes(normalized)) {
    return normalized
  }
  return quickDeckEvaluationFailureCodeSchema.options.includes(normalized as never)
    ? normalized
    : 'EVALUATION_PROVIDER_ERROR'
}

function redactedEvidenceIdentifier(value: string | null | undefined) {
  if (!value) return null
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(normalized) || normalized.startsWith('gateway-image:')) return null
  return hashInput(`quick-deck-evidence:${normalized}`)
}

function observedAspectDiagnostics(width: number, height: number, normalization: ImageAspectDiagnostics['normalization']): ImageAspectDiagnostics {
  const relativeError = Math.abs((width / height) / (16 / 9) - 1)
  return {
    observedWidth: width,
    observedHeight: height,
    relativeError,
    normalization,
    normalizedWidth: normalization === 'PASSTHROUGH' ? width : null,
    normalizedHeight: normalization === 'PASSTHROUGH' ? height : null,
  }
}

function publicAspect(page: QuickDeckEvaluationPageRecord) {
  if (page.aspectDiagnostics) return page.aspectDiagnostics
  if (!page.width || !page.height) return null
  return observedAspectDiagnostics(page.width, page.height, 'UNKNOWN')
}

function boundedAspectDiagnostics(value: ImageAspectDiagnostics | null | undefined) {
  const parsed = quickDeckImageAspectDiagnosticsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function normalizeEvidenceContext(value: QuickDeckEvidenceContext | undefined, now: string): QuickDeckEvidenceContext {
  const fallback: QuickDeckEvidenceContext = {
    runtimeMode: 'MOCK',
    softwareVersion: 'local-mock',
    gitSha: 'local-mock',
    releaseId: 'local-mock',
    startedAt: now,
  }
  const context = value ?? fallback
  for (const [name, candidate] of Object.entries({
    softwareVersion: context.softwareVersion,
    gitSha: context.gitSha,
    releaseId: context.releaseId,
  })) {
    if (!candidate.trim() || candidate.trim().length > 160) throw new Error(`QUICK_DECK_EVIDENCE_${name.toUpperCase()}_INVALID`)
  }
  if (!Number.isFinite(Date.parse(context.startedAt))) throw new Error('QUICK_DECK_EVIDENCE_STARTED_AT_INVALID')
  return {
    runtimeMode: context.runtimeMode,
    softwareVersion: context.softwareVersion.trim(),
    gitSha: context.gitSha.trim(),
    releaseId: context.releaseId.trim(),
    startedAt: new Date(context.startedAt).toISOString(),
  }
}

function unknownEvidenceContext() {
  return {
    runtimeMode: 'UNKNOWN' as const,
    softwareVersion: 'unknown',
    gitSha: 'unknown',
    releaseId: 'unknown',
    startedAt: null,
  }
}

function publicJob(record: QuickDeckEvaluationRecord): QuickDeckEvaluationPublicJob {
  const completed = record.status === 'COMPLETED'
  const submittedPages = record.pages.filter((page) => page.submissionState !== 'NOT_SUBMITTED').length
  const completedPages = record.pages.filter((page) => page.status === 'COMPLETED').length
  return quickDeckEvaluationPublicJobSchema.parse({
    schemaVersion: '1',
    jobId: record.id,
    status: record.status,
    phase: record.phase,
    slideCount: record.request.slideCount,
    aspectRatio: '16:9',
    models: { text: record.textModel, image: record.imageModel },
    progress: { planned: record.blueprint !== null, submittedPages, completedPages, totalPages: record.request.slideCount },
    pages: record.pages.map((page) => ({
      pageNumber: page.pageNumber,
      status: page.status,
      submissionState: page.submissionState ?? 'UNKNOWN',
      billingState: page.billingState ?? 'UNKNOWN',
      errorCode: publicDiagnosticCode(page.errorCode),
      width: page.width,
      height: page.height,
      aspectRatioValidated: page.aspectRatioValidated,
      aspect: publicAspect(page),
      sha256: page.sha256,
    })),
    artifacts: {
      pptx: completed ? artifactPublic(record.pptx) : null,
      preview: completed ? artifactPublic(record.preview) : null,
    },
    quality: { state: 'NOT_ASSESSED', score: null, rubric: null },
    failure: record.errorCode ? { code: record.errorCode } : null,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    expiresAt: record.expiresAt,
    durationMs: durationMs(record.startedAt, record.completedAt),
  })
}

export class QuickDeckEvaluationService {
  readonly #allowedImageModels: ReadonlySet<string>
  readonly #evidenceContext: QuickDeckEvidenceContext

  constructor(private readonly dependencies: Readonly<{
    repository: QuickDeckEvaluationRepository
    artifacts: ArtifactPort
    model: StructuredModelPort
    images: ImageGenerationPort
    renderer: PresentationRendererPort
    clock: ClockPort
    artifactCleanup?: QuickDeckEvaluationArtifactCleanupPort
    textModel: string
    allowedImageModels: readonly string[]
    modelEligibility: QuickDeckEvaluationModelEligibilityPort
    maxActiveJobs: number
    maxDailyJobs: number
    ttlMs: number
    evidence?: QuickDeckEvidenceContext
  }>) {
    if (dependencies.textModel.trim().length < 1 || dependencies.textModel.trim().length > 120) {
      throw new Error('QUICK_DECK_TEXT_MODEL_INVALID')
    }
    if (dependencies.allowedImageModels.length < 1 || dependencies.allowedImageModels.length > 20
      || dependencies.allowedImageModels.some((model) => model.trim().length < 1 || model.trim().length > 120)) {
      throw new Error('QUICK_DECK_IMAGE_MODELS_INVALID')
    }
    if (typeof dependencies.modelEligibility?.check !== 'function') {
      throw new Error('QUICK_DECK_MODEL_ELIGIBILITY_REQUIRED')
    }
    if (!Number.isSafeInteger(dependencies.maxActiveJobs) || dependencies.maxActiveJobs < 1 || dependencies.maxActiveJobs > 50
      || !Number.isSafeInteger(dependencies.maxDailyJobs) || dependencies.maxDailyJobs < 1 || dependencies.maxDailyJobs > 10_000
      || !Number.isSafeInteger(dependencies.ttlMs) || dependencies.ttlMs < 60_000 || dependencies.ttlMs > 30 * 24 * 60 * 60_000) {
      throw new Error('QUICK_DECK_EVALUATION_LIMITS_INVALID')
    }
    this.#allowedImageModels = new Set(dependencies.allowedImageModels)
    this.#evidenceContext = normalizeEvidenceContext(dependencies.evidence, dependencies.clock.now().toISOString())
  }

  async initialize() {
    const now = this.dependencies.clock.now()
    return this.dependencies.repository.recoverInterrupted({
      now: now.toISOString(),
      defaultDrainDeadline: new Date(now.getTime() + QUICK_DECK_DRAIN_TIMEOUT_MS).toISOString(),
    })
  }

  async create(tenantId: string, request: unknown) {
    const parsed = quickDeckEvaluationRequestSchema.safeParse(request)
    if (!parsed.success) throw new QuickDeckEvaluationError(422, 'INVALID_QUICK_DECK_EVALUATION_REQUEST')
    if (!this.#allowedImageModels.has(parsed.data.imageModel)) {
      throw new QuickDeckEvaluationError(422, 'EVALUATION_MODEL_NOT_ALLOWED')
    }
    await this.assertModelEligibility({
      textModel: this.dependencies.textModel,
      imageModels: [parsed.data.imageModel],
    })
    const now = this.dependencies.clock.now()
    const timestamp = now.toISOString()
    const id = `quick-deck-evaluation-${randomUUID().replace(/-/g, '')}`
    const record: QuickDeckEvaluationRecord = {
      id,
      tenantId,
      request: parsed.data,
      requestHash: hashInput(parsed.data),
      textModel: this.dependencies.textModel,
      imageModel: parsed.data.imageModel,
      evidenceContext: this.#evidenceContext,
      status: 'QUEUED',
      phase: 'ACCEPTED',
      blueprint: null,
      pages: Array.from({ length: parsed.data.slideCount }, (_, index) => ({
        pageNumber: index + 1,
        status: 'PENDING' as const,
        submissionState: 'NOT_SUBMITTED' as const,
        billingState: 'NOT_CHARGED' as const,
        idempotencyKey: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${id}:slide:${index + 1}:image`,
        operationId: null,
        providerRequestId: null,
        artifactId: null,
        width: null,
        height: null,
        aspectRatioValidated: false,
        aspectDiagnostics: null,
        sha256: null,
        errorCode: null,
      })),
      pptx: null,
      preview: null,
      errorCode: null,
      pendingFailure: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      expiresAt: new Date(now.getTime() + this.dependencies.ttlMs).toISOString(),
      drainStartedAt: null,
      drainDeadline: null,
      nextAttemptAt: timestamp,
      updatedAt: timestamp,
    }
    const outcome = await this.dependencies.repository.create({
      record,
      event: event(id, 'evaluation.accepted', { slideCount: record.request.slideCount }, timestamp),
      maxActiveJobs: this.dependencies.maxActiveJobs,
      maxDailyJobs: this.dependencies.maxDailyJobs,
      dayStart: utcDayStart(now),
    })
    if (outcome === 'DAILY_LIMIT') throw new QuickDeckEvaluationError(429, 'EVALUATION_DAILY_LIMIT')
    if (outcome === 'CONCURRENCY_LIMIT') throw new QuickDeckEvaluationError(429, 'EVALUATION_CONCURRENCY_LIMIT')
    return publicJob(record)
  }

  async isAvailable() {
    try {
      await this.assertModelEligibility({
        textModel: this.dependencies.textModel,
        imageModels: [...this.#allowedImageModels],
      })
      return true
    } catch {
      return false
    }
  }

  async getOwned(tenantId: string, jobId: string) {
    return publicJob(await this.requireOwned(tenantId, jobId))
  }

  async readEventsOwned(tenantId: string, jobId: string, afterSequence: number, limit: number) {
    await this.requireOwned(tenantId, jobId)
    return this.dependencies.repository.readEvents({ jobId, afterSequence, limit })
  }

  async getContentOwned(tenantId: string, jobId: string, format: QuickDeckContentFormat) {
    const record = await this.requireOwned(tenantId, jobId)
    if (Date.parse(record.expiresAt) <= this.dependencies.clock.now().getTime()) {
      throw new QuickDeckEvaluationError(410, 'EVALUATION_CONTENT_EXPIRED')
    }
    if (record.status === 'EXPIRED') throw new QuickDeckEvaluationError(410, 'EVALUATION_CONTENT_EXPIRED')
    if (record.status !== 'COMPLETED') throw new QuickDeckEvaluationError(409, 'EVALUATION_CONTENT_NOT_READY')
    const artifact = format === 'pptx' ? record.pptx : record.preview
    if (!artifact) throw new QuickDeckEvaluationError(404, 'EVALUATION_CONTENT_NOT_FOUND')
    return artifact
  }

  async getEvidenceOwned(tenantId: string, jobId: string) {
    const record = await this.requireOwned(tenantId, jobId)
    if (Date.parse(record.expiresAt) <= this.dependencies.clock.now().getTime()) {
      throw new QuickDeckEvaluationError(410, 'EVALUATION_CONTENT_EXPIRED')
    }
    if (record.status === 'EXPIRED') throw new QuickDeckEvaluationError(410, 'EVALUATION_CONTENT_EXPIRED')
    const planningEvidenceCompleteness = 'UNKNOWN' as const
    const pages = record.pages.map((page) => {
      const gatewayOperationId = redactedEvidenceIdentifier(page.operationId)
      const providerRequestId = redactedEvidenceIdentifier(page.providerRequestId)
      const submissionState = page.submissionState ?? 'UNKNOWN'
      const billingState = page.billingState ?? 'UNKNOWN'
      const evidenceCompleteness = submissionState === 'NOT_SUBMITTED' && billingState === 'NOT_CHARGED'
        ? 'COMPLETE' as const
        : submissionState === 'UNKNOWN'
          ? 'UNKNOWN' as const
          : gatewayOperationId && providerRequestId
            ? 'COMPLETE' as const
            : gatewayOperationId || providerRequestId
              ? 'PARTIAL' as const
              : 'UNKNOWN' as const
      return {
        pageNumber: page.pageNumber,
        agentRequestId: hashInput(page.idempotencyKey),
        gatewayOperationId,
        providerRequestId,
        submissionState,
        billingState,
        errorCode: publicDiagnosticCode(page.errorCode),
        aspect: publicAspect(page),
        evidenceCompleteness,
      }
    })
    const completeness = [planningEvidenceCompleteness, ...pages.map((page) => page.evidenceCompleteness)]
    const evidenceCompleteness = completeness.every((value) => value === 'COMPLETE')
      ? 'COMPLETE' as const
      : completeness.every((value) => value === 'UNKNOWN')
        ? 'UNKNOWN' as const
        : 'PARTIAL' as const
    return quickDeckEvaluationEvidenceSchema.parse({
      schemaVersion: '1',
      jobId: record.id,
      runtime: record.evidenceContext ?? unknownEvidenceContext(),
      models: { text: record.textModel, image: record.imageModel },
      planning: {
        agentRequestId: hashInput(`${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}:creative-manuscript`),
        providerRequestId: null,
        evidenceCompleteness: planningEvidenceCompleteness,
      },
      pages,
      evidenceCompleteness,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      expiresAt: record.expiresAt,
    })
  }

  async tick(input: Readonly<{ limit: number }>) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('QUICK_DECK_EVALUATION_TICK_LIMIT_INVALID')
    }
    const tickStartedAt = this.dependencies.clock.now()
    const now = tickStartedAt.toISOString()
    let failedJobs = 0
    let expiredJobs = 0
    const expiredJobIds = new Set<string>()
    while (expiredJobs < input.limit) {
      const claimedAt = this.dependencies.clock.now()
      const leaseToken = `quick-deck-expiry-${randomUUID()}`
      const [record] = await this.dependencies.repository.claimExpired({
        now: claimedAt.toISOString(),
        leaseToken,
        leaseUntil: new Date(claimedAt.getTime() + QUICK_DECK_EVALUATION_LEASE_MS).toISOString(),
        limit: 1,
        excludeJobIds: [...expiredJobIds],
      })
      if (!record) break
      expiredJobs += 1
      expiredJobIds.add(record.id)
      const claim: QuickDeckClaim = { leaseToken }
      try {
        await this.expire(record, claimedAt.toISOString(), claim)
      } catch (error) {
        if (!(error instanceof QuickDeckClaimLostError)) failedJobs += 1
      } finally {
        await this.dependencies.repository.releaseClaim({ jobId: record.id, leaseToken })
      }
    }
    let scannedJobs = 0
    const processedJobIds = new Set<string>()
    while (scannedJobs < input.limit) {
      const claimedAt = this.dependencies.clock.now()
      const leaseToken = `quick-deck-worker-${randomUUID()}`
      const [record] = await this.dependencies.repository.claimRunnable({
        now: claimedAt.toISOString(),
        leaseToken,
        leaseUntil: new Date(claimedAt.getTime() + QUICK_DECK_EVALUATION_LEASE_MS).toISOString(),
        limit: 1,
        excludeJobIds: [...processedJobIds],
      })
      if (!record) break
      scannedJobs += 1
      processedJobIds.add(record.id)
      const claim: QuickDeckClaim = { leaseToken }
      try {
        if (record.status === 'QUEUED') await this.planAndSubmit(record, claim)
        else if (record.status === 'PLANNING') await this.fail(record, 'EVALUATION_INTERRUPTED', claim)
        else if (record.status === 'SUBMITTING_IMAGES') await this.recoverSubmissionPersistenceFailure(record, claim)
        else await this.inspectAndPackage(record, claim)
      } catch (error) {
        if (error instanceof QuickDeckClaimLostError) continue
        const latest = await this.dependencies.repository.get(record.id)
        if (latest && await this.recoverSubmissionPersistenceFailure(latest, claim)) continue
        failedJobs += 1
        if (latest && !['COMPLETED', 'FAILED', 'EXPIRED'].includes(latest.status)) {
          await this.fail(latest, 'EVALUATION_PACKAGING_FAILED', claim)
        }
      } finally {
        await this.dependencies.repository.releaseClaim({ jobId: record.id, leaseToken })
      }
    }
    return { scannedJobs, failedJobs, expiredJobs }
  }

  private async planAndSubmit(record: QuickDeckEvaluationRecord, claim: QuickDeckClaim) {
    const startedAt = this.dependencies.clock.now().toISOString()
    const planning: QuickDeckEvaluationRecord = {
      ...record,
      status: 'PLANNING',
      phase: 'CREATIVE_PLANNING',
      startedAt: record.startedAt ?? startedAt,
      // A stale planning lease must be reclaimable and failed without replaying
      // the model request or creating a second paid submission.
      nextAttemptAt: startedAt,
      updatedAt: startedAt,
    }
    await this.saveClaimed({
      record: planning,
      event: event(planning.id, 'planning.started', {}, startedAt),
    }, claim)
    let blueprint
    try {
      await this.assertModelEligibility({
        textModel: planning.textModel,
        imageModels: [planning.imageModel],
      })
      blueprint = await this.createBlueprint(planning)
      // The creative call can take long enough for a short attestation or
      // evaluator-directory TTL to change before any image spend occurs.
      await this.assertModelEligibility({
        textModel: planning.textModel,
        imageModels: [planning.imageModel],
      })
    } catch (error) {
      return await this.fail(
        planning,
        this.modelEligibilityFailureCode(error)
          ?? (isV4ResponsesProtocolError(error)
            ? 'EVALUATION_MODEL_PROTOCOL_INVALID'
            : isV4ManuscriptContextTooLargeError(error)
              ? 'EVALUATION_MANUSCRIPT_CONTEXT_TOO_LARGE'
              : 'EVALUATION_PLANNING_FAILED'),
        claim,
      )
    }
    const submittedAt = this.dependencies.clock.now().toISOString()
    const submitting: QuickDeckEvaluationRecord = {
      ...planning,
      status: 'SUBMITTING_IMAGES',
      phase: 'IMAGE_GENERATION',
      blueprint,
      nextAttemptAt: null,
      updatedAt: submittedAt,
    }
    await this.saveClaimed({
      record: submitting,
      event: event(submitting.id, 'planning.completed', { slideCount: submitting.request.slideCount }, submittedAt),
    }, claim)
    const requirements = blueprintImageRequirements({ id: submitting.id, revisionRound: 0 }, blueprint)
    const preflighted: QuickDeckEvaluationRecord = {
      ...submitting,
      pages: submitting.pages.map((page) => ({
        ...page,
        status: 'PENDING' as const,
        submissionState: 'UNKNOWN' as const,
        billingState: 'UNKNOWN' as const,
        operationId: null,
        providerRequestId: null,
        errorCode: null,
      })),
      nextAttemptAt: this.dependencies.clock.now().toISOString(),
      updatedAt: this.dependencies.clock.now().toISOString(),
    }
    // Persist every original idempotency key before a Provider can accept it.
    await this.saveClaimed({ record: preflighted }, claim)
    const outcomes = await Promise.all(requirements.map(async (requirement) => {
      const page = this.pageForRequirement(preflighted, requirement.pageNumber)
      try {
        const result = await this.dependencies.images.submit({
          tenantId: preflighted.tenantId,
          prompt: requirement.prompt,
          ...(requirement.negativePrompt ? { negativePrompt: requirement.negativePrompt } : {}),
          model: preflighted.imageModel,
          aspectRatio: '16:9',
          exactAspectRatio: true,
          backgroundMode: 'OPAQUE',
          operationMode: 'TEXT_TO_IMAGE',
          idempotencyKey: page.idempotencyKey,
        })
        return {
          pageNumber: page.pageNumber,
          page: {
            ...page,
            status: result.state === 'PROCESSING' ? 'PROCESSING' as const : 'SUBMITTED' as const,
            submissionState: 'SUBMITTED' as const,
            billingState: 'UNKNOWN' as const,
            operationId: result.operationId,
            providerRequestId: result.providerRequestId ?? null,
            aspectDiagnostics: boundedAspectDiagnostics(result.aspectDiagnostics) ?? page.aspectDiagnostics,
            errorCode: null,
          },
        }
      } catch (error) {
        const mediaError = error instanceof MediaSubmissionError ? error : null
        const submissionState = mediaError?.submissionState ?? 'UNKNOWN'
        const errorCode = storedDiagnosticCode(mediaError?.code) ?? 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN'
        const aspectDiagnostics = boundedAspectDiagnostics(mediaError?.aspectDiagnostics)
        return {
          pageNumber: page.pageNumber,
          page: submissionState === 'NOT_SUBMITTED'
            ? {
                ...page,
                status: 'FAILED' as const,
                submissionState,
                billingState: mediaError?.billingState ?? 'UNKNOWN',
                operationId: null,
                providerRequestId: mediaError?.providerRequestId ?? null,
                aspectDiagnostics,
                errorCode,
              }
            : {
                ...page,
                status: 'PENDING' as const,
                submissionState,
                billingState: mediaError?.billingState ?? 'UNKNOWN',
                operationId: mediaError?.operationId ?? null,
                providerRequestId: mediaError?.providerRequestId ?? null,
                aspectDiagnostics,
                errorCode,
              },
        }
      }
    }))
    let persisted = preflighted
    for (const outcome of outcomes.sort((left, right) => left.pageNumber - right.pageNumber)) {
      persisted = this.replacePage(persisted, outcome.page)
      await this.saveClaimed({ record: persisted }, claim)
    }
    const submissionFailure = outcomes.some((outcome) => outcome.page.errorCode !== null)
      ? this.submissionFailureCode(persisted.pages)
      : null
    if (submissionFailure) {
      if (!this.hasUnresolvedPages(persisted.pages)) return await this.fail(persisted, submissionFailure, claim)
      const draining = this.startDraining(persisted, submissionFailure)
      await this.saveClaimed({
        record: draining,
        event: event(draining.id, 'images.submitted', {
          submittedPages: draining.pages.filter((page) => page.submissionState !== 'NOT_SUBMITTED').length,
          totalPages: draining.request.slideCount,
        }, draining.updatedAt),
      }, claim)
      return await this.saveClaimed({
        record: draining,
        event: event(draining.id, 'images.draining', this.drainEventPayload(draining), draining.updatedAt),
      }, claim)
    }
    const generatingAt = this.dependencies.clock.now().toISOString()
    const generating: QuickDeckEvaluationRecord = {
      ...persisted,
      status: 'GENERATING',
      phase: 'IMAGE_GENERATION',
      nextAttemptAt: generatingAt,
      updatedAt: generatingAt,
    }
    await this.saveClaimed({
      record: generating,
      event: event(generating.id, 'images.submitted', {
        submittedPages: generating.pages.length,
        totalPages: generating.request.slideCount,
      }, generatingAt),
    }, claim)
  }

  private async inspectAndPackage(record: QuickDeckEvaluationRecord, claim: QuickDeckClaim) {
    if (!record.blueprint) return await this.fail(record, 'EVALUATION_PLANNING_FAILED', claim)
    const recoveredPages = await this.recoverOperationIds(record)
    const pending = recoveredPages.filter((page) => page.operationId !== null && !this.isTerminalPage(page))
    const inspected = await Promise.all(pending.map(async (page) => {
      return this.inspectPage(record, page)
    }))
    const pagesByNumber = new Map(inspected.flatMap((item) => item.next ? [[item.page.pageNumber, item.next] as const] : []))
    const pages = recoveredPages.map((page) => pagesByNumber.get(page.pageNumber) ?? page)
    const now = this.dependencies.clock.now()
    if (this.hasUnresolvedPages(pages)) {
      if (record.drainDeadline && Date.parse(record.drainDeadline) <= now.getTime()) {
        const timedOut = pages.map((page) => this.isTerminalPage(page)
          ? page
          : { ...page, status: 'FAILED' as const, errorCode: 'EVALUATION_IMAGE_DRAIN_TIMEOUT' })
        return await this.fail({ ...record, pages: timedOut, updatedAt: now.toISOString() }, 'EVALUATION_IMAGE_DRAIN_TIMEOUT', claim)
      }
      const failure = record.pendingFailure ?? this.failureFromPages(pages)
      const progressAt = this.dependencies.clock.now()
      if (failure) {
        const draining = this.startDraining({ ...record, pages, updatedAt: progressAt.toISOString() }, failure, progressAt)
        const pagesChanged = pages.some((page, index) => page !== record.pages[index])
        const publishDrain = record.pendingFailure !== draining.pendingFailure
          || record.drainDeadline !== draining.drainDeadline
          || pagesChanged
        return await this.saveClaimed({
          record: draining,
          ...(publishDrain ? {
            event: event(draining.id, 'images.draining', this.drainEventPayload(draining), draining.updatedAt),
          } : {}),
        }, claim)
      }
      const delays = inspected.flatMap((item) => item.retryAfterMs === null ? [] : [boundedDelay(item.retryAfterMs)])
      const generating: QuickDeckEvaluationRecord = {
        ...record,
        pages,
        nextAttemptAt: new Date(progressAt.getTime() + (delays.length > 0 ? Math.min(...delays) : 1_000)).toISOString(),
        updatedAt: progressAt.toISOString(),
      }
      return await this.saveClaimed({
        record: generating,
        event: event(generating.id, 'images.progress', {
          completedPages: pages.filter((page) => page.status === 'COMPLETED').length,
          totalPages: generating.request.slideCount,
        }, generating.updatedAt),
      }, claim)
    }
    const failure = record.pendingFailure ?? this.failureFromPages(pages)
    if (failure) return await this.fail({ ...record, pages, updatedAt: now.toISOString() }, failure, claim)
    const packagingAt = this.dependencies.clock.now().toISOString()
    const packaging: QuickDeckEvaluationRecord = {
      ...record,
      status: 'PACKAGING',
      phase: 'PPTX_PACKAGING',
      pages,
      // Packaging is deterministic and artifact-idempotent, so a stale lease
      // can safely resume from the existing preview/PPTX artifacts.
      nextAttemptAt: packagingAt,
      updatedAt: packagingAt,
    }
    await this.saveClaimed({
      record: packaging,
      event: event(packaging.id, 'packaging.started', {}, packagingAt),
    }, claim)
    try {
      await this.package(packaging, claim)
    } catch (error) {
      if (error instanceof QuickDeckClaimLostError) throw error
      await this.fail(packaging, 'EVALUATION_PACKAGING_FAILED', claim)
    }
  }

  /**
   * The Provider may have accepted image work before saving its page outcome
   * fails. Preserve the preflighted idempotency keys and drain by lookup only.
   */
  private async recoverSubmissionPersistenceFailure(record: QuickDeckEvaluationRecord, claim: QuickDeckClaim) {
    if (record.status !== 'SUBMITTING_IMAGES') {
      return false
    }
    const submittedPages = record.pages.filter((page) => page.submissionState === 'SUBMITTED')
    const hasOnlyPersistedSuccessfulSubmissions = record.pendingFailure === null
      && submittedPages.length === record.request.slideCount
      && submittedPages.every((page) => page.operationId !== null && page.errorCode === null)
    if (hasOnlyPersistedSuccessfulSubmissions) {
      const generatingAt = this.dependencies.clock.now().toISOString()
      const generating: QuickDeckEvaluationRecord = {
        ...record,
        status: 'GENERATING',
        phase: 'IMAGE_GENERATION',
        pendingFailure: null,
        nextAttemptAt: generatingAt,
        updatedAt: generatingAt,
      }
      await this.saveClaimed({
        record: generating,
        event: event(generating.id, 'images.submitted', {
          submittedPages: generating.pages.length,
          totalPages: generating.request.slideCount,
        }, generatingAt),
      }, claim)
      return true
    }
    const pages = record.pages.map((page) => page.status === 'PENDING' && page.submissionState === 'NOT_SUBMITTED'
      ? {
          ...page,
          status: 'FAILED' as const,
          errorCode: page.errorCode ?? 'EVALUATION_IMAGE_SUBMISSION_FAILED',
        }
      : page)
    const pendingFailure = record.pendingFailure ?? this.submissionFailureCode(pages)
    if (!this.hasUnresolvedPages(pages)) {
      await this.fail({ ...record, pages }, pendingFailure, claim)
      return true
    }
    const draining = this.startDraining({ ...record, pages }, pendingFailure)
    await this.saveClaimed({
      record: draining,
      event: event(draining.id, 'images.draining', this.drainEventPayload(draining), draining.updatedAt),
    }, claim)
    return true
  }

  private pageForRequirement(record: QuickDeckEvaluationRecord, pageNumber: number) {
    const page = record.pages.find((candidate) => candidate.pageNumber === pageNumber)
    if (!page) throw new Error('QUICK_DECK_IMAGE_PAGE_MISSING')
    return page
  }

  private replacePage(record: QuickDeckEvaluationRecord, replacement: QuickDeckEvaluationPageRecord): QuickDeckEvaluationRecord {
    return {
      ...record,
      pages: record.pages.map((page) => page.pageNumber === replacement.pageNumber ? replacement : page),
      updatedAt: this.dependencies.clock.now().toISOString(),
    }
  }

  private isTerminalPage(page: QuickDeckEvaluationPageRecord) {
    return page.status === 'COMPLETED' || page.status === 'FAILED'
  }

  private hasUnresolvedPages(pages: readonly QuickDeckEvaluationPageRecord[]) {
    return pages.some((page) => !this.isTerminalPage(page))
  }

  private submissionFailureCode(pages: readonly QuickDeckEvaluationPageRecord[]): QuickDeckEvaluationFailureCode {
    if (pages.some((page) => page.submissionState === 'SUBMITTED')) {
      return 'EVALUATION_IMAGE_SUBMISSION_PARTIAL'
    }
    return pages.some((page) => page.submissionState === 'UNKNOWN')
      ? 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN'
      : 'EVALUATION_IMAGE_SUBMISSION_FAILED'
  }

  private failureFromPages(pages: readonly QuickDeckEvaluationPageRecord[]): QuickDeckEvaluationFailureCode | null {
    const failed = pages.filter((page) => page.status === 'FAILED')
    if (failed.length === 0) return null
    if (failed.some((page) => page.errorCode === 'EVALUATION_IMAGE_DRAIN_TIMEOUT')) {
      return 'EVALUATION_IMAGE_DRAIN_TIMEOUT'
    }
    if (failed.some((page) => ['EVALUATION_IMAGE_RATIO_INVALID', 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID'].includes(page.errorCode ?? ''))) {
      return 'EVALUATION_IMAGE_RATIO_INVALID'
    }
    if (failed.some((page) => ['EVALUATION_IMAGE_ARTIFACT_INVALID', 'GATEWAY_IMAGE_DIMENSIONS_INVALID'].includes(page.errorCode ?? ''))) {
      return 'EVALUATION_IMAGE_ARTIFACT_INVALID'
    }
    return 'EVALUATION_IMAGE_TASK_FAILED'
  }

  private startDraining(
    record: QuickDeckEvaluationRecord,
    pendingFailure: QuickDeckEvaluationFailureCode,
    now = this.dependencies.clock.now(),
  ): QuickDeckEvaluationRecord {
    return {
      ...record,
      status: 'GENERATING',
      phase: 'IMAGE_GENERATION',
      errorCode: null,
      pendingFailure: record.pendingFailure ?? pendingFailure,
      drainStartedAt: record.drainStartedAt ?? now.toISOString(),
      drainDeadline: record.drainDeadline ?? new Date(now.getTime() + QUICK_DECK_DRAIN_TIMEOUT_MS).toISOString(),
      nextAttemptAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
  }

  private drainEventPayload(record: QuickDeckEvaluationRecord) {
    if (!record.drainDeadline) throw new Error('QUICK_DECK_DRAIN_DEADLINE_MISSING')
    return {
      pendingPages: record.pages.filter((page) => !this.isTerminalPage(page)).length,
      failedPages: record.pages.filter((page) => page.status === 'FAILED').length,
      totalPages: record.request.slideCount,
      drainDeadline: record.drainDeadline,
    }
  }

  private async recoverOperationIds(record: QuickDeckEvaluationRecord): Promise<readonly QuickDeckEvaluationPageRecord[]> {
    const lookup = this.dependencies.images.lookupByIdempotency?.bind(this.dependencies.images)
    if (!lookup) return record.pages
    return await Promise.all(record.pages.map(async (page) => {
      if (this.isTerminalPage(page) || page.operationId !== null
        || !['SUBMITTED', 'UNKNOWN'].includes(page.submissionState)) return page
      try {
        const result = await lookup({
          tenantId: record.tenantId,
          idempotencyKey: page.idempotencyKey,
          operationMode: 'TEXT_TO_IMAGE',
        })
        if (result.state === 'SUBMITTED') {
          return { ...page, status: 'SUBMITTED' as const, submissionState: 'SUBMITTED' as const, operationId: result.operationId }
        }
        if (result.state === 'NOT_SUBMITTED') {
          return {
            ...page,
            status: 'FAILED' as const,
            submissionState: 'NOT_SUBMITTED' as const,
            billingState: 'NOT_CHARGED' as const,
            errorCode: page.errorCode ?? 'EVALUATION_IMAGE_SUBMISSION_FAILED',
          }
        }
      } catch {
        // A lookup outage is not evidence that the provider did not accept the original key.
      }
      return page
    }))
  }

  private async inspectPage(record: QuickDeckEvaluationRecord, page: QuickDeckEvaluationPageRecord): Promise<Readonly<{
    page: QuickDeckEvaluationPageRecord
    next: QuickDeckEvaluationPageRecord | null
    retryAfterMs: number | null
  }>> {
    if (!page.operationId) throw new Error('QUICK_DECK_IMAGE_OPERATION_MISSING')
    let result: Awaited<ReturnType<ImageGenerationPort['inspect']>>
    try {
      result = await this.dependencies.images.inspect({
        tenantId: record.tenantId,
        operationId: page.operationId,
        idempotencyKey: page.idempotencyKey,
        aspectRatio: '16:9',
        exactAspectRatio: true,
        backgroundMode: 'OPAQUE',
      })
    } catch {
      return { page, next: null, retryAfterMs: 1_000 }
    }
    if (result.state !== 'COMPLETED') {
      if (result.state === 'FAILED') {
        const receivedAspectDiagnostics = result.aspectDiagnostics ?? null
        const aspectDiagnostics = boundedAspectDiagnostics(receivedAspectDiagnostics)
        const invalidAspectDiagnostics = receivedAspectDiagnostics !== null && aspectDiagnostics === null
        return {
          page,
          next: {
            ...page,
            status: 'FAILED',
            submissionState: 'SUBMITTED',
            billingState: result.billingState,
            providerRequestId: result.providerRequestId ?? page.providerRequestId,
            width: invalidAspectDiagnostics ? null : aspectDiagnostics?.observedWidth ?? page.width,
            height: invalidAspectDiagnostics ? null : aspectDiagnostics?.observedHeight ?? page.height,
            aspectRatioValidated: false,
            aspectDiagnostics: invalidAspectDiagnostics ? null : aspectDiagnostics ?? page.aspectDiagnostics,
            errorCode: invalidAspectDiagnostics ? 'EVALUATION_IMAGE_ARTIFACT_INVALID' : storedDiagnosticCode(result.errorCode) ?? 'EVALUATION_PROVIDER_ERROR',
          },
          retryAfterMs: null,
        }
      }
      return { page, next: null, retryAfterMs: result.retryAfterMs ?? 1_000 }
    }
    const artifact = await this.dependencies.artifacts.get({ tenantId: record.tenantId, artifactId: result.artifactId })
    if (!artifact) {
      return {
        page,
        next: { ...page, status: 'FAILED', submissionState: 'SUBMITTED', errorCode: 'EVALUATION_IMAGE_ARTIFACT_INVALID' },
        retryAfterMs: null,
      }
    }
    const metadata = await sharp(artifact.bytes).metadata().catch(() => null)
    if (!metadata?.width || !metadata.height) {
      return {
        page,
        next: { ...page, status: 'FAILED', submissionState: 'SUBMITTED', errorCode: 'EVALUATION_IMAGE_ARTIFACT_INVALID' },
        retryAfterMs: null,
      }
    }
    if (metadata.width > QUICK_DECK_EVALUATION_MAX_IMAGE_DIMENSION || metadata.height > QUICK_DECK_EVALUATION_MAX_IMAGE_DIMENSION) {
      return {
        page,
        next: { ...page, status: 'FAILED', submissionState: 'SUBMITTED', errorCode: 'EVALUATION_IMAGE_ARTIFACT_INVALID' },
        retryAfterMs: null,
      }
    }
    const aspectRatioValidated = hasVisualDeckV4AspectRatio(metadata.width, metadata.height)
    const aspectDiagnostics = boundedAspectDiagnostics(result.aspectDiagnostics)
      ?? observedAspectDiagnostics(metadata.width, metadata.height, aspectRatioValidated ? 'PASSTHROUGH' : 'REJECTED')
    return {
      page,
      next: {
        ...page,
        status: aspectRatioValidated ? 'COMPLETED' : 'FAILED',
        submissionState: 'SUBMITTED',
        billingState: 'UNKNOWN',
        providerRequestId: result.providerRequestId ?? page.providerRequestId,
        artifactId: result.artifactId,
        width: metadata.width,
        height: metadata.height,
        aspectRatioValidated,
        aspectDiagnostics,
        sha256: artifact.sha256,
        errorCode: aspectRatioValidated ? null : 'EVALUATION_IMAGE_RATIO_INVALID',
      },
      retryAfterMs: null,
    }
  }

  private async createBlueprint(record: QuickDeckEvaluationRecord) {
    const { source, document, config } = contentConfig(record.request)
    const compilerInput: VisualDeckV4CompilerInput = {
      runId: record.id,
      inputHash: record.requestHash,
      source,
      document,
      config,
      slideCount: record.request.slideCount,
      visualDirection: record.request.visualDirection,
      ...(record.request.audience ? { targetAudience: record.request.audience } : {}),
      compilerVersion: 'visual-deck-v4-chain-4',
      createdAt: record.createdAt,
    }
    const planning = planningPayload(compilerInput)
    const raw = await this.dependencies.model.execute({
      tenantId: record.tenantId,
      operation: 'create_visual_deck_v4_creative_manuscript',
      schemaName: 'ppt_agent_v4_creative_manuscript_v1',
      payload: planning.payload,
      idempotencyKey: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}:creative-manuscript`,
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
    })
    const creative = visualDeckV4CreativeManuscriptSchema.parse(raw)
    const review = visualDeckV4ReviewManuscriptSchema.parse({ ...creative, revisionSuggestions: [] })
    const manuscriptCompilerInput: VisualDeckV4CompilerInput = {
      ...compilerInput,
      document: { ...compilerInput.document, chunks: planning.evidenceWindow.chunks },
    }
    const draft = new V4PlanCompiler().compile(manuscriptCompilerInput, review)
    return createVisualDeckV4BlueprintFromProposal(manuscriptCompilerInput, draft)
  }

  private async package(record: QuickDeckEvaluationRecord, claim: QuickDeckClaim) {
    if (!record.blueprint) throw new Error('QUICK_DECK_BLUEPRINT_MISSING')
    const [storedPreview, storedPptx] = await Promise.all([
      this.dependencies.artifacts.getByIdempotencyKey({
        tenantId: record.tenantId,
        idempotencyKey: quickDeckArtifactKey(record, 'preview'),
      }),
      this.dependencies.artifacts.getByIdempotencyKey({
        tenantId: record.tenantId,
        idempotencyKey: quickDeckArtifactKey(record, 'pptx'),
      }),
    ])
    let preview = storedPreview
      ? storedArtifactRecord(storedPreview, 'quick-deck-preview.png', PREVIEW_MIME)
      : null
    let pptx = storedPptx
      ? storedArtifactRecord(storedPptx, 'quick-deck-evaluation.pptx', PPTX_MIME)
      : null
    if (storedPptx) await assertReadablePptxArtifact(storedPptx.bytes, record.request.slideCount)

    let slides: readonly QuickDeckSlide[] | null = null
    const loadSlides = async () => {
      if (slides) return slides
      slides = await Promise.all(record.pages.map(async (page) => {
        if (!page.artifactId) throw new Error('QUICK_DECK_PAGE_ARTIFACT_MISSING')
        const artifact = await this.dependencies.artifacts.get({ tenantId: record.tenantId, artifactId: page.artifactId })
        if (!artifact || !page.aspectRatioValidated) throw new Error('QUICK_DECK_PAGE_ARTIFACT_INVALID')
        return { pageNumber: page.pageNumber, image: artifact.bytes, imageMimeType: artifact.mimeType }
      }))
      return slides
    }
    if (!preview) {
      const previews = await this.dependencies.renderer.renderSlidePreviews({ blueprint: record.blueprint, slides: await loadSlides() })
      const previewBytes = await this.dependencies.renderer.renderPreviewFromSlidePreviews({ slides: previews })
      const stored = await this.dependencies.artifacts.put({
        tenantId: record.tenantId,
        runId: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}`,
        name: 'quick-deck-preview.png',
        mimeType: PREVIEW_MIME,
        bytes: previewBytes,
        idempotencyKey: quickDeckArtifactKey(record, 'preview'),
      })
      preview = { artifactId: stored.artifactId, name: 'quick-deck-preview.png', mimeType: PREVIEW_MIME, sha256: stored.sha256, byteLength: previewBytes.byteLength }
    }
    if (!pptx) {
      const pptxBytes = await this.dependencies.renderer.renderPptx({ blueprint: record.blueprint, slides: await loadSlides() })
      await assertReadablePptxArtifact(pptxBytes, record.request.slideCount)
      const stored = await this.dependencies.artifacts.put({
        tenantId: record.tenantId,
        runId: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}`,
        name: 'quick-deck-evaluation.pptx',
        mimeType: PPTX_MIME,
        bytes: pptxBytes,
        idempotencyKey: quickDeckArtifactKey(record, 'pptx'),
      })
      pptx = { artifactId: stored.artifactId, name: 'quick-deck-evaluation.pptx', mimeType: PPTX_MIME, sha256: stored.sha256, byteLength: pptxBytes.byteLength }
    }
    const completedAt = this.dependencies.clock.now().toISOString()
    const completed: QuickDeckEvaluationRecord = {
      ...record,
      status: 'COMPLETED',
      phase: 'COMPLETE',
      pptx,
      preview,
      completedAt,
      nextAttemptAt: null,
      updatedAt: completedAt,
    }
    await this.saveClaimed({
      record: completed,
      event: event(completed.id, 'packaging.completed', {}, completedAt),
    }, claim)
  }

  private async fail(record: QuickDeckEvaluationRecord, code: QuickDeckEvaluationFailureCode, claim: QuickDeckClaim) {
    const completedAt = this.dependencies.clock.now().toISOString()
    const failed: QuickDeckEvaluationRecord = {
      ...record,
      status: 'FAILED',
      phase: 'FAILED',
      errorCode: code,
      completedAt,
      nextAttemptAt: null,
      updatedAt: completedAt,
    }
    await this.saveClaimed({
      record: failed,
      event: event(failed.id, 'evaluation.failed', { code }, completedAt),
    }, claim)
  }

  private async assertModelEligibility(input: Readonly<{
    textModel: string
    imageModels: readonly string[]
  }>) {
    const eligibility = await this.dependencies.modelEligibility.check(input)
    if (eligibility === 'READY') return
    if (eligibility === 'NOT_READY') {
      throw new QuickDeckEvaluationError(422, 'EVALUATION_MODEL_NOT_ALLOWED')
    }
    throw new QuickDeckEvaluationError(503, 'EVALUATION_MODEL_UNAVAILABLE')
  }

  private modelEligibilityFailureCode(error: unknown): QuickDeckEvaluationFailureCode | null {
    if (!(error instanceof QuickDeckEvaluationError)) return null
    if (error.code === 'EVALUATION_MODEL_NOT_ALLOWED') return 'EVALUATION_MODEL_NOT_READY'
    if (error.code === 'EVALUATION_MODEL_UNAVAILABLE') return 'EVALUATION_MODEL_UNAVAILABLE'
    return null
  }

  private async expire(record: QuickDeckEvaluationRecord, now: string, claim: QuickDeckClaim) {
    const discoveredArtifacts = new Map<number, string>()
    const settledPages = new Map<number, QuickDeckEvaluationPageRecord>()
    let discoveredPreview: QuickDeckEvaluationArtifactRecord | null = null
    let discoveredPptx: QuickDeckEvaluationArtifactRecord | null = null
    const artifactIds = new Set([
      ...record.pages.flatMap((page) => page.artifactId ? [page.artifactId] : []),
      ...(record.pptx ? [record.pptx.artifactId] : []),
      ...(record.preview ? [record.preview.artifactId] : []),
    ])
    const cleanupDeadline = record.cleanupDeadline ?? new Date(Date.parse(now) + QUICK_DECK_DRAIN_TIMEOUT_MS).toISOString()
    const cleanupWindowOpen = Date.parse(cleanupDeadline) > Date.parse(now)
    let cleanupPending = false
    let cleanupAuditRequired = record.cleanupAuditRequired === true

    for (const [kind, name, mimeType] of [
      ['preview', 'quick-deck-preview.png', PREVIEW_MIME],
      ['pptx', 'quick-deck-evaluation.pptx', PPTX_MIME],
    ] as const) {
      try {
        const artifact = await this.dependencies.artifacts.getByIdempotencyKey({
          tenantId: record.tenantId,
          idempotencyKey: quickDeckArtifactKey(record, kind),
        })
        if (!artifact) continue
        artifactIds.add(artifact.artifactId)
        const resolved = storedArtifactRecord(artifact, name, mimeType)
        if (kind === 'preview') discoveredPreview = resolved
        else discoveredPptx = resolved
      } catch {
        if (cleanupWindowOpen) cleanupPending = true
        else cleanupAuditRequired = true
      }
    }

    const lookup = this.dependencies.images.lookupByIdempotency?.bind(this.dependencies.images)
    for (const page of record.pages.filter((candidate) => candidate.submissionState !== 'NOT_SUBMITTED'
      && candidate.artifactId === null
      && !(candidate.status === 'FAILED' && candidate.operationId !== null))) {
      if (!lookup) {
        cleanupAuditRequired = true
        continue
      }
      if (!cleanupWindowOpen) {
        cleanupAuditRequired = true
        continue
      }
      try {
        const lookupResult = await lookup({
          tenantId: record.tenantId,
          idempotencyKey: page.idempotencyKey,
          operationMode: 'TEXT_TO_IMAGE',
        })
        if (lookupResult.state !== 'SUBMITTED') {
          if (lookupResult.state === 'NOT_SUBMITTED') {
            settledPages.set(page.pageNumber, {
              ...page,
              status: 'FAILED',
              submissionState: 'NOT_SUBMITTED',
              billingState: 'NOT_CHARGED',
              errorCode: page.errorCode ?? 'EVALUATION_IMAGE_SUBMISSION_FAILED',
            })
          } else {
            cleanupPending = true
          }
          continue
        }
        const inspected = await this.dependencies.images.inspect({
          tenantId: record.tenantId,
          operationId: lookupResult.operationId,
          idempotencyKey: page.idempotencyKey,
          aspectRatio: '16:9',
          backgroundMode: 'OPAQUE',
          exactAspectRatio: true,
        })
        if (inspected.state === 'COMPLETED') {
          artifactIds.add(inspected.artifactId)
          discoveredArtifacts.set(page.pageNumber, inspected.artifactId)
        } else if (inspected.state === 'FAILED') {
          const receivedAspectDiagnostics = inspected.aspectDiagnostics ?? null
          const aspectDiagnostics = boundedAspectDiagnostics(receivedAspectDiagnostics)
          const invalidAspectDiagnostics = receivedAspectDiagnostics !== null && aspectDiagnostics === null
          settledPages.set(page.pageNumber, {
            ...page,
            status: 'FAILED',
            submissionState: 'SUBMITTED',
            billingState: inspected.billingState,
            operationId: lookupResult.operationId,
            providerRequestId: inspected.providerRequestId ?? page.providerRequestId,
            width: invalidAspectDiagnostics ? null : aspectDiagnostics?.observedWidth ?? page.width,
            height: invalidAspectDiagnostics ? null : aspectDiagnostics?.observedHeight ?? page.height,
            aspectRatioValidated: false,
            aspectDiagnostics: invalidAspectDiagnostics ? null : aspectDiagnostics ?? page.aspectDiagnostics,
            errorCode: invalidAspectDiagnostics
              ? 'EVALUATION_IMAGE_ARTIFACT_INVALID'
              : storedDiagnosticCode(inspected.errorCode) ?? 'EVALUATION_PROVIDER_ERROR',
          })
        } else {
          cleanupPending = true
        }
      } catch {
        // A failed lookup is unknown, not evidence that the Provider discarded work.
        cleanupPending = true
      }
    }

    // Known artifacts must become durably reclaimable before physical deletion.
    // A process can stop between the two writes, so this is distinct from the
    // remaining pending state calculated after cleanup completes.
    const cleanupRequiredBeforeDeletion = cleanupPending || (artifactIds.size > 0 && cleanupWindowOpen)
    const expired: QuickDeckEvaluationRecord = {
      ...record,
      pages: record.pages.map((page) => ({
        ...page,
        ...settledPages.get(page.pageNumber),
        artifactId: page.artifactId ?? discoveredArtifacts.get(page.pageNumber) ?? null,
      })),
      pptx: record.pptx ?? discoveredPptx,
      preview: record.preview ?? discoveredPreview,
      status: 'EXPIRED',
      phase: 'EXPIRED',
      errorCode: null,
      nextAttemptAt: null,
      cleanupPending: cleanupRequiredBeforeDeletion,
      cleanupDeadline: cleanupRequiredBeforeDeletion ? cleanupDeadline : null,
      cleanupAuditRequired,
      updatedAt: now,
    }
    await this.saveClaimed({
      record: expired,
      ...(record.status === 'EXPIRED' ? {} : { event: event(expired.id, 'evaluation.expired', {}, now) }),
    }, claim)
    const failedArtifactIds = new Set<string>()
    if (this.dependencies.artifactCleanup) {
      for (const artifactId of artifactIds) {
        try {
          await this.dependencies.artifactCleanup.remove({ tenantId: record.tenantId, artifactId })
        } catch {
          failedArtifactIds.add(artifactId)
        }
      }
    } else if (artifactIds.size > 0) {
      cleanupAuditRequired = true
    }
    const retainedArtifactIds = this.dependencies.artifactCleanup ? failedArtifactIds : artifactIds
    cleanupPending ||= failedArtifactIds.size > 0
    if (!cleanupWindowOpen && cleanupPending) {
      cleanupPending = false
      cleanupAuditRequired = true
    }
    await this.saveClaimed({
      record: {
        ...expired,
        pages: expired.pages.map((page) => ({
          ...page,
          artifactId: page.artifactId && retainedArtifactIds.has(page.artifactId) ? page.artifactId : null,
        })),
        pptx: expired.pptx && retainedArtifactIds.has(expired.pptx.artifactId) ? expired.pptx : null,
        preview: expired.preview && retainedArtifactIds.has(expired.preview.artifactId) ? expired.preview : null,
        cleanupPending,
        cleanupDeadline: cleanupPending ? cleanupDeadline : null,
        cleanupAuditRequired,
      },
    }, claim)
  }

  private async requireOwned(tenantId: string, jobId: string) {
    const record = await this.dependencies.repository.get(jobId)
    if (!record || record.tenantId !== tenantId) throw new QuickDeckEvaluationError(404, 'QUICK_DECK_EVALUATION_NOT_FOUND')
    return record
  }

  private async saveClaimed(
    input: Readonly<{ record: QuickDeckEvaluationRecord; event?: EventInput }>,
    claim: QuickDeckClaim,
  ) {
    const now = this.dependencies.clock.now()
    const saved = await this.dependencies.repository.saveClaimed({
      ...input,
      leaseToken: claim.leaseToken,
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + QUICK_DECK_EVALUATION_LEASE_MS).toISOString(),
    })
    if (!saved) throw new QuickDeckClaimLostError()
  }
}

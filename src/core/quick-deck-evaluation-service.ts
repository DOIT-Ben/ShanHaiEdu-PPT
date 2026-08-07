import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { ArtifactPort, ClockPort, ImageGenerationPort, PresentationRendererPort, StructuredModelPort } from './ports'
import { blueprintImageRequirements, hasVisualDeckV4AspectRatio } from './blueprint-assets'
import { hashInput } from './hash'
import { assertReadablePptxArtifact } from './pptx-artifact-validation'
import { V4PlanCompiler } from './v4-manuscript-compiler'
import { createVisualDeckV4BlueprintFromProposal, type VisualDeckV4CompilerInput } from './visual-deck-v4-planner'
import {
  QUICK_DECK_EVALUATION_ARTIFACT_PREFIX,
  quickDeckEvaluationPublicJobSchema,
  quickDeckEvaluationRequestSchema,
  type QuickDeckContentFormat,
  type QuickDeckEvaluationEvent,
  type QuickDeckEvaluationEventInput,
  type QuickDeckEvaluationFailureCode,
  type QuickDeckEvaluationPublicJob,
  type QuickDeckEvaluationRequest,
} from '../quick-deck-evaluation-contracts'
import {
  visualDeckV4CreativeManuscriptSchema,
  visualDeckV4ReviewManuscriptSchema,
} from '../visual-deck-v4-contracts'
import type {
  QuickDeckEvaluationArtifactRecord,
  QuickDeckEvaluationArtifactCleanupPort,
  QuickDeckEvaluationRecord,
  QuickDeckEvaluationRepository,
} from './quick-deck-evaluation-ports'
import { V4EvidenceWindowCompiler } from './v4-evidence-window-compiler'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const
const PREVIEW_MIME = 'image/png' as const

export class QuickDeckEvaluationError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'QuickDeckEvaluationError'
  }
}

type EventInput = QuickDeckEvaluationEventInput

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
    instruction: '基于受控测试材料生成一套快速视觉演示。',
    sourceMode: 'SOURCE_GROUNDED' as const,
    deckOptions: {
      deckType: 'DETAILED_DECK' as const,
      language: 'zh-CN',
      length: { slideCount: request.slideCount },
      aspectRatio: '16:9' as const,
      audience: request.audience ?? '快速评测观察者',
      focus: '受控测试材料的核心表达',
      styleHint: request.visualDirection,
    },
  }
  return { source, document, config }
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
  }
}

function artifactPublic(record: QuickDeckEvaluationArtifactRecord | null) {
  return record ? { mimeType: record.mimeType, sha256: record.sha256, byteLength: record.byteLength } : null
}

function publicJob(record: QuickDeckEvaluationRecord): QuickDeckEvaluationPublicJob {
  const completed = record.status === 'COMPLETED'
  const submittedPages = record.pages.filter((page) => ['SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED'].includes(page.status)).length
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
      width: page.width,
      height: page.height,
      aspectRatioValidated: page.aspectRatioValidated,
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
    maxActiveJobs: number
    maxDailyJobs: number
    ttlMs: number
  }>) {
    if (dependencies.textModel.trim().length < 1 || dependencies.textModel.trim().length > 120) {
      throw new Error('QUICK_DECK_TEXT_MODEL_INVALID')
    }
    if (dependencies.allowedImageModels.length < 1 || dependencies.allowedImageModels.length > 20
      || dependencies.allowedImageModels.some((model) => model.trim().length < 1 || model.trim().length > 120)) {
      throw new Error('QUICK_DECK_IMAGE_MODELS_INVALID')
    }
    if (!Number.isSafeInteger(dependencies.maxActiveJobs) || dependencies.maxActiveJobs < 1 || dependencies.maxActiveJobs > 50
      || !Number.isSafeInteger(dependencies.maxDailyJobs) || dependencies.maxDailyJobs < 1 || dependencies.maxDailyJobs > 10_000
      || !Number.isSafeInteger(dependencies.ttlMs) || dependencies.ttlMs < 60_000 || dependencies.ttlMs > 30 * 24 * 60 * 60_000) {
      throw new Error('QUICK_DECK_EVALUATION_LIMITS_INVALID')
    }
    this.#allowedImageModels = new Set(dependencies.allowedImageModels)
  }

  async initialize() {
    return this.dependencies.repository.failInterrupted({ now: this.dependencies.clock.now().toISOString() })
  }

  async create(tenantId: string, request: unknown) {
    const parsed = quickDeckEvaluationRequestSchema.safeParse(request)
    if (!parsed.success) throw new QuickDeckEvaluationError(422, 'INVALID_QUICK_DECK_EVALUATION_REQUEST')
    if (!this.#allowedImageModels.has(parsed.data.imageModel)) {
      throw new QuickDeckEvaluationError(422, 'EVALUATION_MODEL_NOT_ALLOWED')
    }
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
      status: 'QUEUED',
      phase: 'ACCEPTED',
      blueprint: null,
      pages: Array.from({ length: parsed.data.slideCount }, (_, index) => ({
        pageNumber: index + 1,
        status: 'PENDING' as const,
        submissionState: 'NOT_SUBMITTED' as const,
        idempotencyKey: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${id}:slide:${index + 1}:image`,
        operationId: null,
        artifactId: null,
        width: null,
        height: null,
        aspectRatioValidated: false,
        sha256: null,
        errorCode: null,
      })),
      pptx: null,
      preview: null,
      errorCode: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      expiresAt: new Date(now.getTime() + this.dependencies.ttlMs).toISOString(),
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
      await this.expire(record, this.dependencies.clock.now().toISOString()).catch(() => {})
      throw new QuickDeckEvaluationError(410, 'EVALUATION_CONTENT_EXPIRED')
    }
    if (record.status === 'EXPIRED') throw new QuickDeckEvaluationError(410, 'EVALUATION_CONTENT_EXPIRED')
    if (record.status !== 'COMPLETED') throw new QuickDeckEvaluationError(409, 'EVALUATION_CONTENT_NOT_READY')
    const artifact = format === 'pptx' ? record.pptx : record.preview
    if (!artifact) throw new QuickDeckEvaluationError(404, 'EVALUATION_CONTENT_NOT_FOUND')
    return artifact
  }

  async tick(input: Readonly<{ limit: number }>) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('QUICK_DECK_EVALUATION_TICK_LIMIT_INVALID')
    }
    const now = this.dependencies.clock.now().toISOString()
    const expired = await this.dependencies.repository.listExpired({ now, limit: input.limit })
    for (const record of expired) await this.expire(record, now)
    const runnable = await this.dependencies.repository.listRunnable({ now, limit: input.limit })
    let failedJobs = 0
    for (const record of runnable) {
      try {
        if (record.status === 'QUEUED') await this.planAndSubmit(record)
        else await this.inspectAndPackage(record)
      } catch {
        failedJobs += 1
        const latest = await this.dependencies.repository.get(record.id)
        if (latest && !['COMPLETED', 'FAILED', 'EXPIRED'].includes(latest.status)) {
          await this.fail(latest, 'EVALUATION_PACKAGING_FAILED')
        }
      }
    }
    return { scannedJobs: runnable.length, failedJobs, expiredJobs: expired.length }
  }

  private async planAndSubmit(record: QuickDeckEvaluationRecord) {
    const startedAt = this.dependencies.clock.now().toISOString()
    const planning: QuickDeckEvaluationRecord = {
      ...record,
      status: 'PLANNING',
      phase: 'CREATIVE_PLANNING',
      startedAt: record.startedAt ?? startedAt,
      nextAttemptAt: null,
      updatedAt: startedAt,
    }
    await this.dependencies.repository.save({
      record: planning,
      event: event(planning.id, 'planning.started', {}, startedAt),
    })
    let blueprint
    try {
      blueprint = await this.createBlueprint(planning)
    } catch {
      return await this.fail(planning, 'EVALUATION_PLANNING_FAILED')
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
    await this.dependencies.repository.save({
      record: submitting,
      event: event(submitting.id, 'planning.completed', { slideCount: submitting.request.slideCount }, submittedAt),
    })
    const requirements = blueprintImageRequirements({ id: submitting.id, revisionRound: 0 }, blueprint)
    const results = await Promise.allSettled(requirements.map((requirement) => this.dependencies.images.submit({
      tenantId: submitting.tenantId,
      prompt: requirement.prompt,
      ...(requirement.negativePrompt ? { negativePrompt: requirement.negativePrompt } : {}),
      model: submitting.imageModel,
      aspectRatio: '16:9',
      backgroundMode: 'OPAQUE',
      idempotencyKey: submitting.pages.find((page) => page.pageNumber === requirement.pageNumber)!.idempotencyKey,
    })))
    const nextPages = submitting.pages.map((page) => {
      const result = results[page.pageNumber - 1]!
      if (result.status !== 'fulfilled') return {
        ...page,
        status: 'FAILED' as const,
        submissionState: 'UNKNOWN' as const,
        errorCode: 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN',
      }
      return {
        ...page,
        status: result.value.state === 'PROCESSING' ? 'PROCESSING' as const : 'SUBMITTED' as const,
        submissionState: 'SUBMITTED' as const,
        operationId: result.value.operationId,
      }
    })
    const rejected = results.filter((result) => result.status === 'rejected').length
    if (rejected > 0) {
      const persisted = { ...submitting, pages: nextPages, updatedAt: this.dependencies.clock.now().toISOString() }
      await this.dependencies.repository.save({ record: persisted })
      return await this.fail(
        persisted,
        rejected === results.length
          ? 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN'
          : 'EVALUATION_IMAGE_SUBMISSION_PARTIAL',
      )
    }
    const generatingAt = this.dependencies.clock.now().toISOString()
    const generating: QuickDeckEvaluationRecord = {
      ...submitting,
      status: 'GENERATING',
      phase: 'IMAGE_GENERATION',
      pages: nextPages,
      nextAttemptAt: generatingAt,
      updatedAt: generatingAt,
    }
    await this.dependencies.repository.save({
      record: generating,
      event: event(generating.id, 'images.submitted', {
        submittedPages: nextPages.length,
        totalPages: generating.request.slideCount,
      }, generatingAt),
    })
  }

  private async inspectAndPackage(record: QuickDeckEvaluationRecord) {
    if (!record.blueprint) return await this.fail(record, 'EVALUATION_PLANNING_FAILED')
    const pending = record.pages.filter((page) => ['SUBMITTED', 'PROCESSING'].includes(page.status))
    const inspected = await Promise.all(pending.map(async (page) => {
      if (!page.operationId) throw new Error('QUICK_DECK_IMAGE_OPERATION_MISSING')
      const result = await this.dependencies.images.inspect({
        tenantId: record.tenantId,
        operationId: page.operationId,
        idempotencyKey: page.idempotencyKey,
        aspectRatio: '16:9',
        backgroundMode: 'OPAQUE',
      })
      if (result.state === 'QUEUED' || result.state === 'PROCESSING') {
        return { page, result, next: null as null | QuickDeckEvaluationRecord['pages'][number] }
      }
      if (result.state === 'FAILED') {
        return { page, result, next: { ...page, status: 'FAILED' as const, errorCode: result.errorCode } }
      }
      if (result.state !== 'COMPLETED') throw new Error('QUICK_DECK_IMAGE_INSPECTION_RESULT_INVALID')
      const artifact = await this.dependencies.artifacts.get({ tenantId: record.tenantId, artifactId: result.artifactId })
      if (!artifact) throw new Error('QUICK_DECK_IMAGE_ARTIFACT_MISSING')
      const metadata = await sharp(artifact.bytes).metadata()
      if (!metadata.width || !metadata.height) throw new Error('QUICK_DECK_IMAGE_METADATA_INVALID')
      return {
        page,
        result,
        next: {
          ...page,
          status: 'COMPLETED' as const,
          artifactId: result.artifactId,
          width: metadata.width,
          height: metadata.height,
          aspectRatioValidated: hasVisualDeckV4AspectRatio(metadata.width, metadata.height),
          sha256: artifact.sha256,
          errorCode: null,
        },
      }
    }))
    const pagesByNumber = new Map(inspected.flatMap((item) => item.next ? [[item.page.pageNumber, item.next] as const] : []))
    const pages = record.pages.map((page) => pagesByNumber.get(page.pageNumber) ?? page)
    if (pages.some((page) => page.status === 'FAILED')) {
      return await this.fail({ ...record, pages, updatedAt: this.dependencies.clock.now().toISOString() }, 'EVALUATION_IMAGE_TASK_FAILED')
    }
    if (pages.some((page) => page.status === 'COMPLETED' && !page.aspectRatioValidated)) {
      return await this.fail({ ...record, pages, updatedAt: this.dependencies.clock.now().toISOString() }, 'EVALUATION_IMAGE_RATIO_INVALID')
    }
    if (pages.some((page) => page.status !== 'COMPLETED')) {
      const delays = inspected.flatMap((item) => item.result.state === 'QUEUED' || item.result.state === 'PROCESSING'
        ? [boundedDelay(item.result.retryAfterMs)] : [])
      const progressAt = this.dependencies.clock.now()
      const generating: QuickDeckEvaluationRecord = {
        ...record,
        pages,
        nextAttemptAt: new Date(progressAt.getTime() + (delays.length > 0 ? Math.min(...delays) : 1_000)).toISOString(),
        updatedAt: progressAt.toISOString(),
      }
      return await this.dependencies.repository.save({
        record: generating,
        event: event(generating.id, 'images.progress', {
          completedPages: pages.filter((page) => page.status === 'COMPLETED').length,
          totalPages: generating.request.slideCount,
        }, generating.updatedAt),
      })
    }
    const packagingAt = this.dependencies.clock.now().toISOString()
    const packaging: QuickDeckEvaluationRecord = {
      ...record,
      status: 'PACKAGING',
      phase: 'PPTX_PACKAGING',
      pages,
      nextAttemptAt: null,
      updatedAt: packagingAt,
    }
    await this.dependencies.repository.save({
      record: packaging,
      event: event(packaging.id, 'packaging.started', {}, packagingAt),
    })
    try {
      await this.package(packaging)
    } catch {
      await this.fail(packaging, 'EVALUATION_PACKAGING_FAILED')
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
    const raw = await this.dependencies.model.execute({
      tenantId: record.tenantId,
      operation: 'create_visual_deck_v4_creative_manuscript',
      schemaName: 'ppt_agent_v4_creative_manuscript_v1',
      payload: planningPayload(compilerInput),
      idempotencyKey: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}:creative-manuscript`,
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
    })
    const creative = visualDeckV4CreativeManuscriptSchema.parse(raw)
    const review = visualDeckV4ReviewManuscriptSchema.parse({ ...creative, revisionSuggestions: [] })
    const draft = new V4PlanCompiler().compile(compilerInput, review)
    return createVisualDeckV4BlueprintFromProposal(compilerInput, draft)
  }

  private async package(record: QuickDeckEvaluationRecord) {
    if (!record.blueprint) throw new Error('QUICK_DECK_BLUEPRINT_MISSING')
    const slides = await Promise.all(record.pages.map(async (page) => {
      if (!page.artifactId) throw new Error('QUICK_DECK_PAGE_ARTIFACT_MISSING')
      const artifact = await this.dependencies.artifacts.get({ tenantId: record.tenantId, artifactId: page.artifactId })
      if (!artifact || !page.aspectRatioValidated) throw new Error('QUICK_DECK_PAGE_ARTIFACT_INVALID')
      return { pageNumber: page.pageNumber, image: artifact.bytes, imageMimeType: artifact.mimeType }
    }))
    const previews = await this.dependencies.renderer.renderSlidePreviews({ blueprint: record.blueprint, slides })
    const [previewBytes, pptxBytes] = await Promise.all([
      this.dependencies.renderer.renderPreviewFromSlidePreviews({ slides: previews }),
      this.dependencies.renderer.renderPptx({ blueprint: record.blueprint, slides }),
    ])
    await assertReadablePptxArtifact(pptxBytes, record.request.slideCount)
    const [preview, pptx] = await Promise.all([
      this.dependencies.artifacts.put({
        tenantId: record.tenantId,
        runId: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}`,
        name: 'quick-deck-preview.png',
        mimeType: PREVIEW_MIME,
        bytes: previewBytes,
        idempotencyKey: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}:preview`,
      }),
      this.dependencies.artifacts.put({
        tenantId: record.tenantId,
        runId: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}`,
        name: 'quick-deck-evaluation.pptx',
        mimeType: PPTX_MIME,
        bytes: pptxBytes,
        idempotencyKey: `${QUICK_DECK_EVALUATION_ARTIFACT_PREFIX}:${record.id}:pptx`,
      }),
    ])
    const completedAt = this.dependencies.clock.now().toISOString()
    const completed: QuickDeckEvaluationRecord = {
      ...record,
      status: 'COMPLETED',
      phase: 'COMPLETE',
      pptx: {
        artifactId: pptx.artifactId, name: 'quick-deck-evaluation.pptx', mimeType: PPTX_MIME,
        sha256: pptx.sha256, byteLength: pptxBytes.length,
      },
      preview: {
        artifactId: preview.artifactId, name: 'quick-deck-preview.png', mimeType: PREVIEW_MIME,
        sha256: preview.sha256, byteLength: previewBytes.length,
      },
      completedAt,
      nextAttemptAt: null,
      updatedAt: completedAt,
    }
    await this.dependencies.repository.save({
      record: completed,
      event: event(completed.id, 'packaging.completed', {}, completedAt),
    })
  }

  private async fail(record: QuickDeckEvaluationRecord, code: QuickDeckEvaluationFailureCode) {
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
    await this.dependencies.repository.save({
      record: failed,
      event: event(failed.id, 'evaluation.failed', { code }, completedAt),
    })
  }

  private async expire(record: QuickDeckEvaluationRecord, now: string) {
    const artifactIds = new Set([
      ...record.pages.flatMap((page) => page.artifactId ? [page.artifactId] : []),
      ...(record.pptx ? [record.pptx.artifactId] : []),
      ...(record.preview ? [record.preview.artifactId] : []),
    ])
    if (this.dependencies.images.lookupByIdempotency) {
      for (const page of record.pages.filter((candidate) => candidate.submissionState !== 'NOT_SUBMITTED')) {
        const lookup = await this.dependencies.images.lookupByIdempotency({
          tenantId: record.tenantId,
          idempotencyKey: page.idempotencyKey,
          operationMode: 'TEXT_TO_IMAGE',
        })
        if (lookup.state !== 'SUBMITTED') continue
        const inspected = await this.dependencies.images.inspect({
          tenantId: record.tenantId,
          operationId: lookup.operationId,
          idempotencyKey: page.idempotencyKey,
          aspectRatio: '16:9',
          backgroundMode: 'OPAQUE',
        })
        if (inspected.state === 'COMPLETED') artifactIds.add(inspected.artifactId)
      }
    }
    if (this.dependencies.artifactCleanup) {
      for (const artifactId of artifactIds) {
        await this.dependencies.artifactCleanup.remove({ tenantId: record.tenantId, artifactId })
      }
    }
    const expired: QuickDeckEvaluationRecord = {
      ...record,
      status: 'EXPIRED',
      phase: 'EXPIRED',
      errorCode: null,
      nextAttemptAt: null,
      updatedAt: now,
    }
    await this.dependencies.repository.save({
      record: expired,
      event: event(expired.id, 'evaluation.expired', {}, now),
    })
  }

  private async requireOwned(tenantId: string, jobId: string) {
    const record = await this.dependencies.repository.get(jobId)
    if (!record || record.tenantId !== tenantId) throw new QuickDeckEvaluationError(404, 'QUICK_DECK_EVALUATION_NOT_FOUND')
    return record
  }
}

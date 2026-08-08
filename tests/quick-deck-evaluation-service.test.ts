import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { LocalArtifactPort } from '../src/adapters/local-artifact-port'
import { SharpPptxPresentationRenderer } from '../src/adapters/presentation-renderer'
import { LocalQuickDeckEvaluationArtifactCleanupPort } from '../src/adapters/quick-deck-evaluation-local-artifact-cleanup'
import { InMemoryQuickDeckEvaluationRepository } from '../src/adapters/quick-deck-evaluation-in-memory-repository'
import { MediaSubmissionError, type ImageAspectDiagnostics, type ImageGenerationPort, type StructuredModelPort } from '../src/core/ports'
import type { QuickDeckEvaluationPageRecord } from '../src/core/quick-deck-evaluation-ports'
import {
  QuickDeckEvaluationError,
  QuickDeckEvaluationService,
  type QuickDeckEvaluationModelEligibility,
  type QuickDeckEvaluationModelEligibilityPort,
} from '../src/core/quick-deck-evaluation-service'

const sourceText = '太阳加热水面形成水汽，水汽凝结成云，降水回到地表，构成持续循环。'.repeat(4)
const oversizedProviderErrorCode = `UPSTREAM_${'X'.repeat(200)}`
const unboundedAspectDiagnostics: ImageAspectDiagnostics = {
  observedWidth: 20_001,
  observedHeight: 1,
  relativeError: 11_250,
  normalization: 'REJECTED',
  normalizedWidth: null,
  normalizedHeight: null,
}

class ControlledClock {
  constructor(private value = new Date('2026-08-07T00:00:00.000Z')) {}
  now() { return new Date(this.value) }
  advance(milliseconds: number) { this.value = new Date(this.value.getTime() + milliseconds) }
}

class ToggleModelEligibility implements QuickDeckEvaluationModelEligibilityPort {
  readonly calls: Readonly<{ textModel: string; imageModels: readonly string[] }>[] = []

  constructor(private value: QuickDeckEvaluationModelEligibility = 'READY') {}

  set(value: QuickDeckEvaluationModelEligibility) {
    this.value = value
  }

  async check(input: Readonly<{ textModel: string; imageModels: readonly string[] }>) {
    this.calls.push({ textModel: input.textModel, imageModels: [...input.imageModels] })
    return this.value
  }
}

class SequenceModelEligibility implements QuickDeckEvaluationModelEligibilityPort {
  readonly calls: Readonly<{ textModel: string; imageModels: readonly string[] }>[] = []

  constructor(private readonly values: readonly QuickDeckEvaluationModelEligibility[]) {}

  async check(input: Readonly<{ textModel: string; imageModels: readonly string[] }>) {
    this.calls.push({ textModel: input.textModel, imageModels: [...input.imageModels] })
    return this.values[this.calls.length - 1] ?? 'UNAVAILABLE'
  }
}

const readyModelEligibility: QuickDeckEvaluationModelEligibilityPort = {
  async check() { return 'READY' },
}

class CreativeModel implements StructuredModelPort {
  readonly calls: Parameters<StructuredModelPort['execute']>[0][] = []

  async execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    this.calls.push(structuredClone(input))
    const payload = input.payload as {
      frozenConstraints: { slideCount: number }
      trustedEvidence: { sourceChunks: { text: string }[] }
    }
    const excerpt = payload.trustedEvidence.sourceChunks[0]!.text.slice(0, 80)
    return {
      title: '水循环快速评测',
      narrative: ['建立水循环主题', '通过连续视觉解释水循环'],
      slides: Array.from({ length: payload.frozenConstraints.slideCount }, (_, index) => ({
        title: `水循环视觉页 ${index + 1}`,
        narrative: '水在自然环境中持续变化并形成循环。',
        userVisibleCopy: ['水在自然环境中持续变化并形成循环。'],
        factualStatements: [excerpt],
        visualDescription: '以清晰的自然科学场景和箭头展示水循环关系。',
        sourceEvidence: [{ excerpt }],
      })),
    }
  }
}

function oversizedManuscript() {
  return {
    title: '标题'.repeat(80),
    narrative: Array.from({ length: 20 }, () => '叙事'.repeat(250)),
    slides: Array.from({ length: 5 }, () => ({
      title: '页'.repeat(160),
      narrative: '叙'.repeat(1_200),
      userVisibleCopy: Array.from({ length: 8 }, () => '文'.repeat(500)),
      factualStatements: Array.from({ length: 20 }, () => '事'.repeat(500)),
      visualDescription: '视'.repeat(1_500),
      sourceEvidence: Array.from({ length: 8 }, () => ({ excerpt: '证'.repeat(1_200) })),
    })),
  }
}

class OversizedManuscriptModel extends CreativeModel {
  override async execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    await super.execute(input)
    return oversizedManuscript()
  }
}

class ResponsesProtocolRejectedModel implements StructuredModelPort {
  readonly calls: Parameters<StructuredModelPort['execute']>[0][] = []

  async execute(input: Parameters<StructuredModelPort['execute']>[0]): Promise<never> {
    this.calls.push(structuredClone(input))
    throw new Error('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
  }
}

class AsyncImages implements ImageGenerationPort {
  readonly submissions: Parameters<ImageGenerationPort['submit']>[0][] = []
  readonly inspections: Parameters<ImageGenerationPort['inspect']>[0][] = []
  readonly lookups: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0][] = []
  readonly operations = new Map<string, string>()
  failCleanupLookup = false

  constructor(
    private readonly artifacts: LocalArtifactPort,
    private readonly width = 1600,
    private readonly height = 900,
  ) {}

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]): ReturnType<ImageGenerationPort['submit']> {
    this.submissions.push(structuredClone(input))
    const existing = this.operations.get(input.idempotencyKey)
    if (existing) return { operationId: existing, state: 'QUEUED' as const }
    const bytes = await sharp({
      create: { width: this.width, height: this.height, channels: 3, background: '#2F7D8C' },
    }).png().toBuffer()
    const stored = await this.artifacts.put({
      tenantId: input.tenantId,
      runId: 'quick-deck-evaluation-test',
      name: 'generated.png',
      mimeType: 'image/png',
      bytes,
      idempotencyKey: `${input.idempotencyKey}:test-image`,
    })
    const operationId = `image-operation-${this.operations.size + 1}`
    this.operations.set(input.idempotencyKey, operationId)
    this.operations.set(operationId, stored.artifactId)
    return { operationId, state: 'QUEUED' as const }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]): ReturnType<ImageGenerationPort['inspect']> {
    this.inspections.push(structuredClone(input))
    const artifactId = this.operations.get(input.operationId)
    if (!artifactId) throw new Error('TEST_IMAGE_OPERATION_NOT_FOUND')
    return { state: 'COMPLETED' as const, artifactId }
  }

  async lookupByIdempotency(
    input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0],
  ): ReturnType<NonNullable<ImageGenerationPort['lookupByIdempotency']>> {
    this.lookups.push(structuredClone(input))
    if (this.failCleanupLookup) throw new Error('TEST_GATEWAY_LOOKUP_UNAVAILABLE')
    const operationId = this.operations.get(input.idempotencyKey)
    return operationId ? { state: 'SUBMITTED' as const, operationId } : { state: 'UNKNOWN' as const }
  }
}

class PartialImages extends AsyncImages {
  override async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    if (input.idempotencyKey.includes(':slide:2:')) {
      this.submissions.push(structuredClone(input))
      throw new Error('TEST_SUBMISSION_UNKNOWN')
    }
    return super.submit(input)
  }
}

class RejectedPageImages extends AsyncImages {
  constructor(artifacts: LocalArtifactPort, private readonly rejectedPageNumber: number) {
    super(artifacts)
  }

  override async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    if (input.idempotencyKey.includes(`:slide:${this.rejectedPageNumber}:`)) {
      this.submissions.push(structuredClone(input))
      throw new MediaSubmissionError(
        oversizedProviderErrorCode,
        'NOT_SUBMITTED',
        'the gateway rejected this page before accepting it',
        { category: 'PROVIDER', disposition: 'NON_RETRYABLE', diagnosticCode: oversizedProviderErrorCode },
        { billingState: 'NOT_CHARGED', aspectDiagnostics: unboundedAspectDiagnostics },
      )
    }
    return super.submit(input)
  }
}

class CheckpointImages extends AsyncImages {
  readonly checkpoints: Array<Readonly<{
    pageNumber: number
    status: QuickDeckEvaluationPageRecord['status']
    submissionState: QuickDeckEvaluationPageRecord['submissionState']
    billingState: QuickDeckEvaluationPageRecord['billingState']
    laterPages: Array<Pick<QuickDeckEvaluationPageRecord, 'pageNumber' | 'status' | 'submissionState' | 'billingState'>>
  }>> = []
  #jobId: string | null = null

  constructor(artifacts: LocalArtifactPort, private readonly repository: InMemoryQuickDeckEvaluationRepository) {
    super(artifacts)
  }

  setJobId(jobId: string) {
    this.#jobId = jobId
  }

  override async submit(input: Parameters<ImageGenerationPort['submit']>[0]): ReturnType<ImageGenerationPort['submit']> {
    if (!this.#jobId) throw new Error('TEST_SUBMISSION_CHECKPOINT_JOB_MISSING')
    const record = await this.repository.get(this.#jobId)
    const current = record?.pages.find((page) => page.idempotencyKey === input.idempotencyKey)
    if (!current) throw new Error('TEST_SUBMISSION_CHECKPOINT_PAGE_MISSING')
    this.checkpoints.push({
      pageNumber: current.pageNumber,
      status: current.status,
      submissionState: current.submissionState,
      billingState: current.billingState,
      laterPages: record!.pages
        .filter((page) => page.pageNumber > current.pageNumber)
        .map(({ pageNumber, status, submissionState, billingState }) => ({ pageNumber, status, submissionState, billingState })),
    })
    return await super.submit(input)
  }
}

class FailOnceOutcomeSaveRepository extends InMemoryQuickDeckEvaluationRepository {
  #failed = false

  override async save(input: Parameters<InMemoryQuickDeckEvaluationRepository['save']>[0]) {
    if (!this.#failed
      && input.record.status === 'SUBMITTING_IMAGES'
      && input.record.pages.some((page) => page.submissionState === 'SUBMITTED')) {
      this.#failed = true
      throw new Error('TEST_IMAGE_OUTCOME_PERSISTENCE_INTERRUPTED')
    }
    await super.save(input)
  }
}

class FailOnceDefiniteRejectionSaveRepository extends InMemoryQuickDeckEvaluationRepository {
  #failed = false

  override async save(input: Parameters<InMemoryQuickDeckEvaluationRepository['save']>[0]) {
    const rejected = input.record.pages.find((page) => page.pageNumber === 2)
    const unstarted = input.record.pages.find((page) => page.pageNumber === 3)
    if (!this.#failed
      && input.record.status === 'SUBMITTING_IMAGES'
      && rejected?.status === 'FAILED'
      && rejected.submissionState === 'NOT_SUBMITTED'
      && unstarted?.status === 'PENDING'
      && unstarted.submissionState === 'NOT_SUBMITTED') {
      this.#failed = true
      throw new Error('TEST_DEFINITE_REJECTION_PERSISTENCE_INTERRUPTED')
    }
    await super.save(input)
  }
}

class FailOnceGeneratingSaveRepository extends InMemoryQuickDeckEvaluationRepository {
  #failed = false

  override async save(input: Parameters<InMemoryQuickDeckEvaluationRepository['save']>[0]) {
    if (!this.#failed
      && input.record.status === 'GENERATING'
      && input.record.pendingFailure === null
      && input.record.pages.every((page) => page.submissionState === 'SUBMITTED' && page.operationId !== null && page.errorCode === null)) {
      this.#failed = true
      throw new Error('TEST_GENERATING_STATE_PERSISTENCE_INTERRUPTED')
    }
    await super.save(input)
  }
}

class UnboundedDiagnosticsImages extends AsyncImages {
  override async submit(input: Parameters<ImageGenerationPort['submit']>[0]): ReturnType<ImageGenerationPort['submit']> {
    const result = await super.submit(input)
    return { ...result, aspectDiagnostics: unboundedAspectDiagnostics }
  }

  override async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]): ReturnType<ImageGenerationPort['inspect']> {
    const result = await super.inspect(input)
    if (result.state !== 'COMPLETED') return result
    return { ...result, aspectDiagnostics: unboundedAspectDiagnostics }
  }
}

class FailedRatioImages extends AsyncImages {
  constructor(
    artifacts: LocalArtifactPort,
    private readonly failureAspectDiagnostics: ImageAspectDiagnostics = {
      observedWidth: 2048,
      observedHeight: 2048,
      relativeError: 0.4375,
      normalization: 'REJECTED',
      normalizedWidth: null,
      normalizedHeight: null,
    },
  ) {
    super(artifacts)
  }

  override async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    this.inspections.push(structuredClone(input))
    return {
      state: 'FAILED' as const,
      errorCode: 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID',
      billingState: 'UNKNOWN' as const,
      providerRequestId: 'provider-request-redacted-id',
      aspectDiagnostics: this.failureAspectDiagnostics,
      technicalFailure: {
        category: 'CONTRACT' as const,
        disposition: 'NON_RETRYABLE' as const,
        diagnosticCode: 'GATEWAY_IMAGE_ASPECT_RATIO_INVALID',
      },
    }
  }
}

class UnknownInspectionImages extends AsyncImages {
  #inspectAttempts = 0
  #lookupAttempts = 0

  override async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]): ReturnType<ImageGenerationPort['inspect']> {
    this.inspections.push(structuredClone(input))
    if (this.#inspectAttempts++ === 0) {
      return {
        state: 'FAILED' as const,
        errorCode: 'IDEMPOTENCY_SUBMISSION_UNKNOWN',
        billingState: 'UNKNOWN' as const,
        technicalFailure: {
          category: 'PROVIDER' as const,
          disposition: 'RETRYABLE' as const,
          diagnosticCode: 'IDEMPOTENCY_SUBMISSION_UNKNOWN',
        },
        requiresIdempotencyDrain: true as const,
      }
    }
    const artifactId = this.operations.get(input.operationId)
    if (!artifactId) throw new Error('TEST_IMAGE_OPERATION_NOT_FOUND')
    return { state: 'COMPLETED' as const, artifactId }
  }

  override async lookupByIdempotency(
    input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0],
  ): ReturnType<NonNullable<ImageGenerationPort['lookupByIdempotency']>> {
    this.lookups.push(structuredClone(input))
    if (this.#lookupAttempts++ === 0) return { state: 'UNKNOWN' as const }
    const operationId = this.operations.get(input.idempotencyKey)
    return operationId ? { state: 'SUBMITTED' as const, operationId } : { state: 'UNKNOWN' as const }
  }
}

class PersistentUnknownInspectionImages extends AsyncImages {
  override async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]): ReturnType<ImageGenerationPort['inspect']> {
    this.inspections.push(structuredClone(input))
    return {
      state: 'FAILED' as const,
      errorCode: 'GATEWAY_SUBMISSION_UNKNOWN',
      billingState: 'UNKNOWN' as const,
      technicalFailure: {
        category: 'PROVIDER' as const,
        disposition: 'RETRYABLE' as const,
        diagnosticCode: 'GATEWAY_SUBMISSION_UNKNOWN',
      },
      requiresIdempotencyDrain: true as const,
    }
  }
}

class FailOnceArtifactCleanup {
  #failed = false

  constructor(private readonly delegate: LocalQuickDeckEvaluationArtifactCleanupPort) {}

  async remove(input: Parameters<LocalQuickDeckEvaluationArtifactCleanupPort['remove']>[0]) {
    if (!this.#failed) {
      this.#failed = true
      throw new Error('TEST_ARTIFACT_CLEANUP_UNAVAILABLE')
    }
    await this.delegate.remove(input)
  }
}

class ProcessingAtExpiryImages extends AsyncImages {
  #cleanupInspections = 0

  override async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]): ReturnType<ImageGenerationPort['inspect']> {
    this.inspections.push(structuredClone(input))
    if (this.#cleanupInspections++ === 0) return { state: 'PROCESSING' as const, retryAfterMs: 1_000 }
    const artifactId = this.operations.get(input.operationId)
    if (!artifactId) throw new Error('TEST_IMAGE_OPERATION_NOT_FOUND')
    return { state: 'COMPLETED' as const, artifactId }
  }
}

class FailedAtExpiryImages extends AsyncImages {
  failInspection = false

  override async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]): ReturnType<ImageGenerationPort['inspect']> {
    if (!this.failInspection) return await super.inspect(input)
    this.inspections.push(structuredClone(input))
    return {
      state: 'FAILED' as const,
      errorCode: 'UPSTREAM_IMAGE_FAILED',
      billingState: 'CHARGED' as const,
      providerRequestId: 'provider-terminal-failure',
      technicalFailure: {
        category: 'PROVIDER' as const,
        disposition: 'NON_RETRYABLE' as const,
        diagnosticCode: 'UPSTREAM_IMAGE_FAILED',
      },
    }
  }
}

class FirstPageFailedAtExpiryImages extends AsyncImages {
  failInspection = false

  override async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]): ReturnType<ImageGenerationPort['inspect']> {
    if (!this.failInspection || input.operationId !== 'image-operation-1') return await super.inspect(input)
    this.inspections.push(structuredClone(input))
    return {
      state: 'FAILED' as const,
      errorCode: 'UPSTREAM_IMAGE_FAILED',
      billingState: 'CHARGED' as const,
      providerRequestId: 'provider-terminal-failure',
      technicalFailure: {
        category: 'PROVIDER' as const,
        disposition: 'NON_RETRYABLE' as const,
        diagnosticCode: 'UPSTREAM_IMAGE_FAILED',
      },
    }
  }
}

class FailOnceCompletedSaveRepository extends InMemoryQuickDeckEvaluationRepository {
  #failed = false

  override async save(input: Parameters<InMemoryQuickDeckEvaluationRepository['save']>[0]) {
    if (!this.#failed && input.record.status === 'COMPLETED' && input.record.pptx && input.record.preview) {
      this.#failed = true
      throw new Error('TEST_PACKAGING_COMPLETION_PERSISTENCE_INTERRUPTED')
    }
    await super.save(input)
  }
}

class LoseCompletedClaimRepository extends InMemoryQuickDeckEvaluationRepository {
  #lost = false

  override async saveClaimed(input: Parameters<InMemoryQuickDeckEvaluationRepository['saveClaimed']>[0]) {
    if (!this.#lost && input.record.status === 'COMPLETED') {
      this.#lost = true
      return false
    }
    return await super.saveClaimed(input)
  }
}

class CrashAfterFirstExpirySaveRepository extends InMemoryQuickDeckEvaluationRepository {
  #interrupted = false

  override async saveClaimed(input: Parameters<InMemoryQuickDeckEvaluationRepository['saveClaimed']>[0]) {
    const saved = await super.saveClaimed(input)
    if (saved && !this.#interrupted && input.record.status === 'EXPIRED') {
      this.#interrupted = true
      throw new Error('TEST_EXPIRY_CRASH_AFTER_FIRST_SAVE')
    }
    return saved
  }
}

class NotSubmittedLookupImages extends AsyncImages {
  override async lookupByIdempotency(input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0]) {
    this.lookups.push(structuredClone(input))
    return { state: 'NOT_SUBMITTED' as const }
  }
}

class UnknownLookupImages extends AsyncImages {
  override async lookupByIdempotency(input: Parameters<NonNullable<ImageGenerationPort['lookupByIdempotency']>>[0]) {
    this.lookups.push(structuredClone(input))
    return { state: 'UNKNOWN' as const }
  }
}

class LeaseExpiredCreativeModel extends CreativeModel {
  constructor(private readonly clock: ControlledClock) {
    super()
  }

  override async execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    this.clock.advance(5 * 60_000 + 1)
    return await super.execute(input)
  }
}

class LeaseExpiredPackagingRenderer extends SharpPptxPresentationRenderer {
  calls = 0

  constructor(private readonly clock: ControlledClock) {
    super()
  }

  override async renderSlidePreviews(input: Parameters<SharpPptxPresentationRenderer['renderSlidePreviews']>[0]) {
    this.calls += 1
    if (this.calls === 1) this.clock.advance(5 * 60_000 + 1)
    return await super.renderSlidePreviews(input)
  }
}

async function fixture(
  imageSize: Readonly<{ width: number; height: number }> = { width: 1600, height: 900 },
  removeExpiredArtifacts = false,
  failFirstArtifactCleanup = false,
  imageFactory?: (artifacts: LocalArtifactPort) => AsyncImages,
  modelEligibility?: QuickDeckEvaluationModelEligibilityPort,
  ttlMs = 60_000,
) {
  const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-service-'))
  const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
  const repository = new InMemoryQuickDeckEvaluationRepository()
  const clock = new ControlledClock()
  const model = new CreativeModel()
  const images = imageFactory?.(artifacts) ?? new AsyncImages(artifacts, imageSize.width, imageSize.height)
  const localCleanup = new LocalQuickDeckEvaluationArtifactCleanupPort(join(directory, 'artifacts'))
  const service = new QuickDeckEvaluationService({
    repository,
    artifacts,
    model,
    images,
    renderer: new SharpPptxPresentationRenderer(),
    clock,
    ...(removeExpiredArtifacts ? {
      artifactCleanup: failFirstArtifactCleanup ? new FailOnceArtifactCleanup(localCleanup) : localCleanup,
    } : {}),
    textModel: 'gpt-5.6-terra',
    allowedImageModels: ['gemini-3-pro-image-preview'],
    modelEligibility: modelEligibility ?? readyModelEligibility,
    maxActiveJobs: 2,
    maxDailyJobs: 3,
    ttlMs,
  })
  return { directory, artifacts, repository, clock, model, images, service }
}

function request(slideCount = 2) {
  return {
    schemaVersion: '1',
    source: { kind: 'TEXT', name: 'water-cycle.txt', text: sourceText },
    slideCount,
    visualDirection: '清晰的自然科学信息图',
    imageModel: 'gemini-3-pro-image-preview',
    audience: '小学高年级学生',
  }
}

describe('quick-deck evaluation service', () => {
  test('requires an explicit model eligibility dependency at startup', () => {
    const artifacts = new LocalArtifactPort(join(tmpdir(), 'ppt-agent-quick-deck-missing-eligibility'))
    const dependencies = {
      repository: new InMemoryQuickDeckEvaluationRepository(),
      artifacts,
      model: new CreativeModel(),
      images: new AsyncImages(artifacts),
      renderer: new SharpPptxPresentationRenderer(),
      clock: new ControlledClock(),
      textModel: 'gpt-5.6-terra',
      allowedImageModels: ['gemini-3-pro-image-preview'],
      maxActiveJobs: 2,
      maxDailyJobs: 3,
      ttlMs: 60_000,
    }

    expect(() => new QuickDeckEvaluationService(
      dependencies as unknown as ConstructorParameters<typeof QuickDeckEvaluationService>[0],
    )).toThrow('QUICK_DECK_MODEL_ELIGIBILITY_REQUIRED')
  })

  test('rejects stale evaluator models before either model or image provider work begins', async () => {
    const eligibility = new ToggleModelEligibility()
    const { directory, images, model, service } = await fixture(undefined, false, false, undefined, eligibility)
    try {
      const created = await service.create('evaluation-tenant', request(1))
      expect(eligibility.calls).toHaveLength(1)

      eligibility.set('NOT_READY')
      await service.tick({ limit: 10 })

      expect(model.calls).toHaveLength(0)
      expect(images.submissions).toHaveLength(0)
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        failure: { code: 'EVALUATION_MODEL_NOT_READY' },
      })

      eligibility.set('UNAVAILABLE')
      await expect(service.create('evaluation-tenant', request(1)))
        .rejects.toEqual(new QuickDeckEvaluationError(503, 'EVALUATION_MODEL_UNAVAILABLE'))
      expect(model.calls).toHaveLength(0)
      expect(images.submissions).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.each([
    ['NOT_READY', 'EVALUATION_MODEL_NOT_READY'],
    ['UNAVAILABLE', 'EVALUATION_MODEL_UNAVAILABLE'],
  ] as const)('rechecks model eligibility before each image submission and persists %s', async (eligibilityState, failureCode) => {
    const eligibility = new SequenceModelEligibility([
      'READY', 'READY', 'READY', 'READY', eligibilityState,
    ])
    const { directory, images, service } = await fixture(undefined, false, false, undefined, eligibility)
    try {
      const created = await service.create('evaluation-tenant', request(2))
      await service.tick({ limit: 10 })

      expect(images.submissions).toHaveLength(1)
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'GENERATING',
        failure: null,
        pages: [
          expect.objectContaining({ submissionState: 'SUBMITTED' }),
          expect.objectContaining({
            status: 'FAILED',
            submissionState: 'NOT_SUBMITTED',
            billingState: 'NOT_CHARGED',
            errorCode: failureCode,
          }),
        ],
      })

      await service.tick({ limit: 10 })
      expect(images.submissions).toHaveLength(1)
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        failure: { code: failureCode },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('runs one Responses manuscript call, submits asynchronous images, validates pixels, and packages a PPTX', async () => {
    const { directory, artifacts, model, images, service } = await fixture()
    try {
      const first = await service.create('evaluation-tenant', request())
      const second = await service.create('evaluation-tenant', request())
      expect(first.jobId).not.toBe(second.jobId)
      expect(first.status).toBe('QUEUED')

      await service.tick({ limit: 10 })
      expect(model.calls).toHaveLength(2)
      expect(model.calls.every((call) => call.operation === 'create_visual_deck_v4_creative_manuscript'
        && call.structuredGenerationProtocol === 'RESPONSES_JSON_SCHEMA')).toBe(true)
      expect(model.calls.every((call) => !(call.payload as Record<string, unknown>).document)).toBe(true)
      expect(images.submissions).toHaveLength(4)
      expect(images.submissions.every((input) => input.idempotencyKey.startsWith('quick-deck-evaluation:'))).toBe(true)
      expect(images.submissions.every((input) => input.exactAspectRatio === true)).toBe(true)
      expect(images.submissions.every((input) => input.operationMode === 'TEXT_TO_IMAGE')).toBe(true)

      await service.tick({ limit: 10 })
      const completed = await service.getOwned('evaluation-tenant', first.jobId)
      expect(completed).toMatchObject({
        status: 'COMPLETED',
        phase: 'COMPLETE',
        models: { text: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        progress: { planned: true, submittedPages: 2, completedPages: 2, totalPages: 2 },
        quality: { state: 'NOT_ASSESSED', score: null, rubric: null },
      })
      expect(completed.pages).toEqual(expect.arrayContaining([
        expect.objectContaining({ width: 1600, height: 900, aspectRatioValidated: true }),
      ]))
      expect(completed.artifacts.pptx?.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(completed.artifacts.preview?.sha256).toMatch(/^[a-f0-9]{64}$/)
      const pptx = await service.getContentOwned('evaluation-tenant', first.jobId, 'pptx')
      expect((await artifacts.get({ tenantId: 'evaluation-tenant', artifactId: pptx.artifactId }))?.bytes.length).toBeGreaterThan(1_000)
      const events = await service.readEventsOwned('evaluation-tenant', first.jobId, 0, 20)
      expect(events.events.map((event) => event.type)).toEqual([
        'evaluation.accepted', 'planning.started', 'planning.completed', 'images.submitted',
        'packaging.started', 'packaging.completed',
      ])
      expect(events.terminalSequence).toBe(6)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists one recoverable checkpoint before each image provider submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-submission-checkpoint-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new InMemoryQuickDeckEvaluationRepository()
      const images = new CheckpointImages(artifacts, repository)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(3))
      images.setJobId(created.jobId)

      await service.tick({ limit: 10 })

      expect(images.checkpoints).toEqual([
        {
          pageNumber: 1, status: 'PENDING', submissionState: 'UNKNOWN', billingState: 'UNKNOWN',
          laterPages: [
            { pageNumber: 2, status: 'PENDING', submissionState: 'NOT_SUBMITTED', billingState: 'NOT_CHARGED' },
            { pageNumber: 3, status: 'PENDING', submissionState: 'NOT_SUBMITTED', billingState: 'NOT_CHARGED' },
          ],
        },
        {
          pageNumber: 2, status: 'PENDING', submissionState: 'UNKNOWN', billingState: 'UNKNOWN',
          laterPages: [{ pageNumber: 3, status: 'PENDING', submissionState: 'NOT_SUBMITTED', billingState: 'NOT_CHARGED' }],
        },
        {
          pageNumber: 3, status: 'PENDING', submissionState: 'UNKNOWN', billingState: 'UNKNOWN',
          laterPages: [],
        },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails a quick evaluation before image submission when its CreativeManuscript exceeds the aggregate limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-oversized-manuscript-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const model = new OversizedManuscriptModel()
      const images = new AsyncImages(artifacts)
      const service = new QuickDeckEvaluationService({
        repository: new InMemoryQuickDeckEvaluationRepository(), artifacts, model, images,
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))

      await service.tick({ limit: 10 })

      expect(model.calls).toHaveLength(1)
      expect(images.submissions).toHaveLength(0)
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        phase: 'FAILED',
        failure: { code: 'EVALUATION_MANUSCRIPT_CONTEXT_TOO_LARGE' },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('publishes a Chain-4 Responses protocol rejection as a stable evaluator failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-protocol-rejection-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const model = new ResponsesProtocolRejectedModel()
      const images = new AsyncImages(artifacts)
      const service = new QuickDeckEvaluationService({
        repository: new InMemoryQuickDeckEvaluationRepository(), artifacts, model, images,
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))

      await service.tick({ limit: 10 })

      expect(model.calls).toHaveLength(1)
      expect(images.submissions).toHaveLength(0)
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        failure: { code: 'EVALUATION_MODEL_PROTOCOL_INVALID' },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('atomically claims a queued evaluation before concurrent workers can plan or submit it twice', async () => {
    const { directory, model, images, service } = await fixture()
    try {
      await service.create('evaluation-tenant', request(1))

      await Promise.all([
        service.tick({ limit: 10 }),
        service.tick({ limit: 10 }),
      ])

      expect(model.calls).toHaveLength(1)
      expect(images.submissions).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails a reclaimed stale planning lease without rerunning the model or submitting images', async () => {
    const { directory, artifacts, repository, clock, images } = await fixture()
    try {
      const model = new LeaseExpiredCreativeModel(clock)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model, images, renderer: new SharpPptxPresentationRenderer(), clock,
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60 * 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))

      await service.tick({ limit: 1 })
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'PLANNING', phase: 'CREATIVE_PLANNING', nextAttemptAt: '2026-08-07T00:00:00.000Z',
      })

      await service.tick({ limit: 1 })
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED', phase: 'FAILED', failure: { code: 'EVALUATION_INTERRUPTED' },
      })
      expect(model.calls).toHaveLength(1)
      expect(images.submissions).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reclaims a stale packaging lease from deterministic artifacts without another image submission', async () => {
    const { directory, artifacts, repository, clock, model, images } = await fixture()
    try {
      const renderer = new LeaseExpiredPackagingRenderer(clock)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model, images, renderer, clock,
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60 * 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))

      await service.tick({ limit: 1 })
      await service.tick({ limit: 1 })
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'PACKAGING', phase: 'PPTX_PACKAGING', nextAttemptAt: '2026-08-07T00:00:00.000Z',
      })

      await service.tick({ limit: 1 })
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'COMPLETED', phase: 'COMPLETE',
      })
      expect(images.submissions).toHaveLength(1)
      expect(renderer.calls).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('bounds a valid 200,000-character CJK input before the Responses call', async () => {
    const { directory, model, service } = await fixture()
    try {
      const tailEvidence = '重点目标位于材料末尾并且必须保留'
      const created = await service.create('evaluation-tenant', {
        ...request(1),
        source: {
          kind: 'TEXT', name: '重点目标.txt',
          text: `${'甲'.repeat(200_000 - tailEvidence.length)}${tailEvidence}`,
        },
      })
      await service.tick({ limit: 10 })

      expect(created.status).toBe('QUEUED')
      const payload = JSON.stringify(model.calls[0]!.payload)
      expect(payload.length).toBeLessThanOrEqual(220_000)
      expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(220_000)
      expect((model.calls[0]!.payload as Record<string, unknown>).document).toBeUndefined()
      expect(payload).toContain(tailEvidence)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps tail evidence selectable for a valid unnamed 200,000-character input', async () => {
    const { directory, model, service } = await fixture()
    try {
      const tailEvidence = '无名材料的关键结论位于末尾且必须保留'
      await service.create('evaluation-tenant', {
        ...request(1),
        source: {
          kind: 'TEXT',
          text: `${'x'.repeat(200_000 - tailEvidence.length)}${tailEvidence}`,
        },
      })
      await service.tick({ limit: 10 })

      const payload = JSON.stringify(model.calls[0]!.payload)
      expect(payload.length).toBeLessThanOrEqual(220_000)
      expect(payload).toContain(tailEvidence)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('compiles Quick-deck manuscripts against only the evidence window sent to the model', async () => {
    const { directory, model, images, repository, service } = await fixture()
    try {
      const duplicatePrefix = `EVIDENCE_DUPLICATE_${'k'.repeat(100)}`
      const outsideMarker = 'OUTSIDE_MARKER_MUST_NOT_REACH_THE_COMPILER'
      const chunk = (prefix: string, fill: string) => `${prefix}${fill.repeat(12_000 - prefix.length)}`
      const source = [
        chunk(duplicatePrefix, '甲'),
        ...Array.from({ length: 7 }, () => '乙'.repeat(12_000)),
        chunk(`${duplicatePrefix}${outsideMarker}`, '丙'),
      ].join('')
      const created = await service.create('evaluation-tenant', {
        ...request(1),
        source: { kind: 'TEXT', name: 'source.txt', text: source },
      })

      await service.tick({ limit: 10 })

      const payload = model.calls[0]!.payload as {
        trustedEvidence: { sourceChunks: readonly { id: string; text: string }[] }
      }
      expect(payload.trustedEvidence.sourceChunks).toHaveLength(8)
      expect(JSON.stringify(payload)).not.toContain(outsideMarker)
      expect(images.submissions).toHaveLength(1)
      const stored = await repository.get(created.jobId)
      expect(stored).toMatchObject({
        status: 'GENERATING',
        phase: 'IMAGE_GENERATION',
      })
      expect(stored?.blueprint?.curriculum.sourceSummary).not.toContain(outsideMarker)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails a quick evaluation when actual image pixels are not 16:9', async () => {
    const { directory, service } = await fixture({ width: 1000, height: 1000 })
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      await expect(service.getContentOwned('evaluation-tenant', created.jobId, 'pptx'))
        .rejects.toMatchObject({ code: 'EVALUATION_CONTENT_NOT_READY' })
      const job = await service.getOwned('evaluation-tenant', created.jobId)
      expect(job).toMatchObject({
        status: 'FAILED', phase: 'FAILED', failure: { code: 'EVALUATION_IMAGE_RATIO_INVALID' },
      })
      expect(job.pages[0]).toMatchObject({
        submissionState: 'SUBMITTED',
        billingState: 'UNKNOWN',
        errorCode: 'EVALUATION_IMAGE_RATIO_INVALID',
        aspect: {
          observedWidth: 1000,
          observedHeight: 1000,
          relativeError: 0.4375,
          normalization: 'REJECTED',
        },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails closed before public persistence when an image adapter returns oversized pixels', async () => {
    const { directory, service } = await fixture({ width: 20_001, height: 1 })
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })

      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        phase: 'FAILED',
        failure: { code: 'EVALUATION_IMAGE_ARTIFACT_INVALID' },
        pages: [{
          status: 'FAILED',
          errorCode: 'EVALUATION_IMAGE_ARTIFACT_INVALID',
          width: null,
          height: null,
          aspect: null,
        }],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('uses verified artifact pixels when a completed image result carries an unbounded diagnostic', async () => {
    const { directory, service } = await fixture(undefined, false, false, (artifacts) => new UnboundedDiagnosticsImages(artifacts))
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })

      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'COMPLETED',
        pages: [{
          width: 1600,
          height: 900,
          aspectRatioValidated: true,
          aspect: {
            observedWidth: 1600,
            observedHeight: 900,
            normalization: 'PASSTHROUGH',
          },
        }],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists an inspected gateway ratio failure with its safe diagnostic evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-inspection-failure-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new InMemoryQuickDeckEvaluationRepository()
      const images = new FailedRatioImages(artifacts)
      const service = new QuickDeckEvaluationService({
        repository,
        artifacts,
        model: new CreativeModel(),
        images,
        renderer: new SharpPptxPresentationRenderer(),
        clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra',
        allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2,
        maxDailyJobs: 3,
        ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })

      const job = await service.getOwned('evaluation-tenant', created.jobId)
      expect(job).toMatchObject({ failure: { code: 'EVALUATION_IMAGE_RATIO_INVALID' } })
      expect(job.pages[0]).toMatchObject({
        status: 'FAILED',
        submissionState: 'SUBMITTED',
        billingState: 'UNKNOWN',
        errorCode: 'EVALUATION_IMAGE_RATIO_INVALID',
        width: 2048,
        height: 2048,
        aspect: {
          observedWidth: 2048,
          observedHeight: 2048,
          relativeError: 0.4375,
          normalization: 'REJECTED',
        },
      })
      const evidence = await service.getEvidenceOwned('evaluation-tenant', created.jobId)
      expect(evidence.pages[0]).toMatchObject({
        submissionState: 'SUBMITTED',
        billingState: 'UNKNOWN',
        errorCode: 'EVALUATION_IMAGE_RATIO_INVALID',
        evidenceCompleteness: 'COMPLETE',
      })
      expect(evidence.pages[0]?.providerRequestId).toMatch(/^[a-f0-9]{64}$/)
      expect(images.lookups).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('drains an inspected unknown submission through its original idempotency key without resubmitting', async () => {
    const { directory, images: imagePort, repository, service } = await fixture(undefined, false, false,
      (artifacts) => new UnknownInspectionImages(artifacts))
    const images = imagePort as UnknownInspectionImages
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      const submitted = await repository.get(created.jobId)
      const originalKeys = images.submissions.map((submission) => submission.idempotencyKey)
      const originalOperationId = submitted!.pages[0]!.operationId

      await service.tick({ limit: 10 })
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'GENERATING',
        phase: 'IMAGE_GENERATION',
        pendingFailure: 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN',
        drainDeadline: expect.any(String),
        pages: [expect.objectContaining({
          status: 'PENDING',
          submissionState: 'UNKNOWN',
          operationId: originalOperationId,
          billingState: 'UNKNOWN',
          errorCode: 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN',
        })],
      })
      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual(originalKeys)
      expect(images.inspections).toHaveLength(1)

      await service.tick({ limit: 10 })
      expect(images.lookups.map((lookup) => lookup.idempotencyKey)).toEqual([submitted!.pages[0]!.idempotencyKey])
      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual(originalKeys)
      expect(images.inspections).toHaveLength(1)

      await service.tick({ limit: 10 })
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        phase: 'FAILED',
        failure: { code: 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN' },
        artifacts: { pptx: null, preview: null },
        pages: [expect.objectContaining({ status: 'COMPLETED', submissionState: 'SUBMITTED' })],
      })
      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual(originalKeys)
      expect(images.lookups.map((lookup) => lookup.idempotencyKey)).toEqual([submitted!.pages[0]!.idempotencyKey, submitted!.pages[0]!.idempotencyKey])
      expect(images.inspections).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails a persistently unknown inspection after its bounded drain without resubmitting', async () => {
    const { directory, images: imagePort, repository, clock, service } = await fixture(undefined, false, false,
      (artifacts) => new PersistentUnknownInspectionImages(artifacts), undefined, 30 * 60_000)
    const images = imagePort as PersistentUnknownInspectionImages
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      const submitted = await repository.get(created.jobId)
      const originalKeys = images.submissions.map((submission) => submission.idempotencyKey)

      await service.tick({ limit: 10 })
      expect((await repository.get(created.jobId))?.pendingFailure).toBe('EVALUATION_IMAGE_SUBMISSION_UNKNOWN')

      clock.advance(15 * 60_000 + 1)
      await service.tick({ limit: 10 })

      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        phase: 'FAILED',
        failure: { code: 'EVALUATION_IMAGE_DRAIN_TIMEOUT' },
      })
      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual(originalKeys)
      expect(images.lookups.map((lookup) => lookup.idempotencyKey)).toEqual([submitted!.pages[0]!.idempotencyKey])

      clock.advance(15 * 60_000)
      await service.tick({ limit: 10 })

      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'EXPIRED',
        cleanupPending: true,
        pages: [expect.objectContaining({
          status: 'FAILED',
          submissionState: 'UNKNOWN',
          errorCode: 'EVALUATION_IMAGE_DRAIN_TIMEOUT',
        })],
      })
      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual(originalKeys)
      expect(images.lookups.map((lookup) => lookup.idempotencyKey)).toEqual([
        submitted!.pages[0]!.idempotencyKey,
        submitted!.pages[0]!.idempotencyKey,
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects unbounded failure diagnostics from an external image adapter before persistence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-unbounded-diagnostic-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new InMemoryQuickDeckEvaluationRepository()
      const service = new QuickDeckEvaluationService({
        repository,
        artifacts,
        model: new CreativeModel(),
        images: new FailedRatioImages(artifacts, {
          observedWidth: 20_001,
          observedHeight: 1,
          relativeError: 11_250,
          normalization: 'REJECTED',
          normalizedWidth: null,
          normalizedHeight: null,
        }),
        renderer: new SharpPptxPresentationRenderer(),
        clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra',
        allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2,
        maxDailyJobs: 3,
        ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })

      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        failure: { code: 'EVALUATION_IMAGE_ARTIFACT_INVALID' },
        pages: [{
          errorCode: 'EVALUATION_IMAGE_ARTIFACT_INVALID',
          width: null,
          height: null,
          aspect: null,
        }],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('stops later image submissions after a definite rejection and drains only accepted pages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-partial-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new InMemoryQuickDeckEvaluationRepository()
      const images = new RejectedPageImages(artifacts, 2)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(3))
      await service.tick({ limit: 10 })
      const stored = await repository.get(created.jobId)

      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual([
        expect.stringContaining(':slide:1:'),
        expect.stringContaining(':slide:2:'),
      ])
      expect(stored).toMatchObject({
        status: 'GENERATING',
        pendingFailure: 'EVALUATION_IMAGE_SUBMISSION_PARTIAL',
        drainStartedAt: expect.any(String),
        drainDeadline: expect.any(String),
      })
      expect(stored?.pages).toEqual([
        expect.objectContaining({ submissionState: 'SUBMITTED', operationId: expect.any(String) }),
        expect.objectContaining({ status: 'FAILED', submissionState: 'NOT_SUBMITTED', errorCode: 'EVALUATION_PROVIDER_ERROR' }),
        expect.objectContaining({
          status: 'FAILED', submissionState: 'NOT_SUBMITTED', billingState: 'NOT_CHARGED',
          operationId: null, errorCode: 'EVALUATION_IMAGE_SUBMISSION_SKIPPED',
        }),
      ])

      await service.tick({ limit: 10 })
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'FAILED', errorCode: 'EVALUATION_IMAGE_SUBMISSION_PARTIAL',
        pages: [
          expect.objectContaining({ status: 'COMPLETED' }),
          expect.objectContaining({ status: 'FAILED', submissionState: 'NOT_SUBMITTED', aspectDiagnostics: null }),
          expect.objectContaining({ status: 'FAILED', submissionState: 'NOT_SUBMITTED', errorCode: 'EVALUATION_IMAGE_SUBMISSION_SKIPPED' }),
        ],
      })
      expect(images.submissions).toHaveLength(2)
      expect(images.lookups).toHaveLength(0)
      expect(images.inspections.map((inspection) => inspection.operationId)).toEqual([stored!.pages[0]!.operationId!])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps unstarted pages skipped when a definite rejection outcome save is interrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-rejection-save-interruption-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new FailOnceDefiniteRejectionSaveRepository()
      const images = new RejectedPageImages(artifacts, 2)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(3))

      await service.tick({ limit: 10 })

      const interrupted = await repository.get(created.jobId)
      const rejectedPageKey = interrupted!.pages[1]!.idempotencyKey
      const submittedPageOperationId = interrupted!.pages[0]!.operationId!
      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual([
        expect.stringContaining(':slide:1:'),
        expect.stringContaining(':slide:2:'),
      ])
      expect(interrupted).toMatchObject({
        status: 'GENERATING', pendingFailure: 'EVALUATION_IMAGE_SUBMISSION_PARTIAL',
        pages: [
          expect.objectContaining({ submissionState: 'SUBMITTED', operationId: expect.any(String) }),
          expect.objectContaining({ status: 'PENDING', submissionState: 'UNKNOWN' }),
          expect.objectContaining({
            status: 'FAILED', submissionState: 'NOT_SUBMITTED', billingState: 'NOT_CHARGED',
            errorCode: 'EVALUATION_IMAGE_SUBMISSION_SKIPPED',
          }),
        ],
      })

      await service.tick({ limit: 10 })

      expect(images.submissions).toHaveLength(2)
      expect(images.lookups.map((lookup) => lookup.idempotencyKey)).toEqual([rejectedPageKey])
      expect(images.inspections.map((inspection) => inspection.operationId)).toEqual([submittedPageOperationId])
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'GENERATING', pendingFailure: 'EVALUATION_IMAGE_SUBMISSION_PARTIAL',
        pages: [
          expect.objectContaining({ status: 'COMPLETED', submissionState: 'SUBMITTED' }),
          expect.objectContaining({ status: 'PENDING', submissionState: 'UNKNOWN' }),
          expect.objectContaining({ status: 'FAILED', submissionState: 'NOT_SUBMITTED', errorCode: 'EVALUATION_IMAGE_SUBMISSION_SKIPPED' }),
        ],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails immediately without draining when the first image submission is definitely rejected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-first-rejection-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new InMemoryQuickDeckEvaluationRepository()
      const images = new RejectedPageImages(artifacts, 1)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(3))
      await service.tick({ limit: 10 })

      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual([
        expect.stringContaining(':slide:1:'),
      ])
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'FAILED',
        phase: 'FAILED',
        errorCode: 'EVALUATION_IMAGE_SUBMISSION_FAILED',
        pages: [
          expect.objectContaining({ status: 'FAILED', submissionState: 'NOT_SUBMITTED', errorCode: 'EVALUATION_PROVIDER_ERROR' }),
          expect.objectContaining({ status: 'FAILED', submissionState: 'NOT_SUBMITTED', errorCode: 'EVALUATION_IMAGE_SUBMISSION_SKIPPED' }),
          expect.objectContaining({ status: 'FAILED', submissionState: 'NOT_SUBMITTED', errorCode: 'EVALUATION_IMAGE_SUBMISSION_SKIPPED' }),
        ],
      })
      expect(images.lookups).toHaveLength(0)
      expect(images.inspections).toHaveLength(0)
      expect((await repository.readEvents({ jobId: created.jobId, afterSequence: 0, limit: 20 })).events
        .some((entry) => entry.type === 'images.draining')).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('drains submitted images after an outcome persistence interruption without submitting again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-save-interruption-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new FailOnceOutcomeSaveRepository()
      const images = new AsyncImages(artifacts)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(2))

      await service.tick({ limit: 10 })

      const interrupted = await repository.get(created.jobId)
      const originalKeys = images.submissions.map((submission) => submission.idempotencyKey)
      expect(interrupted).toMatchObject({
        status: 'GENERATING',
        phase: 'IMAGE_GENERATION',
        pendingFailure: 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN',
      })
      expect(interrupted!.pages).toEqual([
        expect.objectContaining({ status: 'PENDING', submissionState: 'UNKNOWN', operationId: null }),
        expect.objectContaining({ status: 'FAILED', submissionState: 'NOT_SUBMITTED', errorCode: 'EVALUATION_IMAGE_SUBMISSION_SKIPPED' }),
      ])
      expect(images.submissions).toHaveLength(1)

      await service.tick({ limit: 10 })

      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual(originalKeys)
      expect(images.lookups.map((lookup) => lookup.idempotencyKey)).toEqual(originalKeys)
      expect(images.inspections).toHaveLength(1)
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        phase: 'FAILED',
        failure: { code: 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN' },
        pages: [
          expect.objectContaining({ status: 'COMPLETED', submissionState: 'SUBMITTED' }),
          expect.objectContaining({ status: 'FAILED', submissionState: 'NOT_SUBMITTED', errorCode: 'EVALUATION_IMAGE_SUBMISSION_SKIPPED' }),
        ],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reclaims a stale unknown image submission into a bounded lookup-only drain', async () => {
    const { directory, images, repository, clock, service } = await fixture(
      undefined,
      false,
      false,
      (artifacts) => new UnknownLookupImages(artifacts),
      undefined,
      30 * 60_000,
    )
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      const submitted = await repository.get(created.jobId)
      expect(submitted).not.toBeNull()
      const submissionCount = images.submissions.length
      const originalKey = submitted!.pages[0]!.idempotencyKey
      await repository.save({
        record: {
          ...submitted!,
          status: 'SUBMITTING_IMAGES',
          phase: 'IMAGE_GENERATION',
          pages: submitted!.pages.map((page) => ({
            ...page,
            status: 'PENDING' as const,
            submissionState: 'UNKNOWN' as const,
            billingState: 'UNKNOWN' as const,
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
          pendingFailure: null,
          drainStartedAt: null,
          drainDeadline: null,
          nextAttemptAt: clock.now().toISOString(),
          updatedAt: clock.now().toISOString(),
        },
      })

      await service.tick({ limit: 10 })
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'GENERATING',
        pendingFailure: 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN',
        drainDeadline: expect.any(String),
      })
      expect(images.submissions).toHaveLength(submissionCount)
      expect(images.lookups).toHaveLength(0)

      clock.advance(15 * 60_000 + 1)
      await service.tick({ limit: 10 })

      expect(images.submissions).toHaveLength(submissionCount)
      expect(images.lookups.map((lookup) => lookup.idempotencyKey)).toEqual([originalKey])
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        failure: { code: 'EVALUATION_IMAGE_DRAIN_TIMEOUT' },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reclaims a fully persisted image submission without resubmitting or draining', async () => {
    const { directory, images, repository, clock, service } = await fixture()
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      const submitted = await repository.get(created.jobId)
      expect(submitted).not.toBeNull()
      const submissionCount = images.submissions.length
      await repository.save({
        record: {
          ...submitted!,
          status: 'SUBMITTING_IMAGES',
          phase: 'IMAGE_GENERATION',
          pendingFailure: null,
          drainStartedAt: null,
          drainDeadline: null,
          nextAttemptAt: clock.now().toISOString(),
          updatedAt: clock.now().toISOString(),
        },
      })

      await service.tick({ limit: 10 })

      expect(images.submissions).toHaveLength(submissionCount)
      expect(images.lookups).toHaveLength(0)
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'GENERATING',
        pendingFailure: null,
        drainDeadline: null,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('resumes normal generation when only the final generating-state save is interrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-generating-save-interruption-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new FailOnceGeneratingSaveRepository()
      const images = new AsyncImages(artifacts)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(2))

      await service.tick({ limit: 10 })

      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'GENERATING',
        phase: 'IMAGE_GENERATION',
        pendingFailure: null,
        pages: [
          expect.objectContaining({ submissionState: 'SUBMITTED', operationId: expect.any(String), errorCode: null }),
          expect.objectContaining({ submissionState: 'SUBMITTED', operationId: expect.any(String), errorCode: null }),
        ],
      })
      expect(images.submissions).toHaveLength(2)

      await service.tick({ limit: 10 })

      expect(images.submissions).toHaveLength(2)
      expect(images.lookups).toHaveLength(0)
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'COMPLETED',
        phase: 'COMPLETE',
        failure: null,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('records a definitive idempotency lookup as not charged after an interrupted image submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-not-submitted-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new FailOnceOutcomeSaveRepository()
      const images = new NotSubmittedLookupImages(artifacts)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))

      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })

      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'FAILED',
        pages: [expect.objectContaining({
          submissionState: 'NOT_SUBMITTED',
          billingState: 'NOT_CHARGED',
        })],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('continues after an unknown submission and resumes its partial drain without resubmitting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-restart-drain-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new InMemoryQuickDeckEvaluationRepository()
      const clock = new ControlledClock()
      const images = new PartialImages(artifacts)
      const firstService = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock,
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 30 * 60_000,
      })
      const created = await firstService.create('evaluation-tenant', request(3))
      await firstService.tick({ limit: 10 })
      const submitted = await repository.get(created.jobId)
      expect(submitted).toMatchObject({
        status: 'GENERATING', pendingFailure: 'EVALUATION_IMAGE_SUBMISSION_PARTIAL',
      })
      expect(images.submissions.map((submission) => submission.idempotencyKey)).toEqual([
        expect.stringContaining(':slide:1:'),
        expect.stringContaining(':slide:2:'),
        expect.stringContaining(':slide:3:'),
      ])
      expect(submitted!.pages[1]).toMatchObject({ status: 'PENDING', submissionState: 'UNKNOWN' })

      const resumedService = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock,
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 30 * 60_000,
      })
      await resumedService.initialize()
      clock.advance(20 * 60_000)
      await resumedService.tick({ limit: 10 })

      expect(images.submissions).toHaveLength(3)
      expect(images.lookups.map((lookup) => lookup.idempotencyKey)).toEqual([submitted!.pages[1]!.idempotencyKey])
      expect(images.inspections.map((inspection) => inspection.operationId)).toEqual([
        submitted!.pages[0]!.operationId!,
        submitted!.pages[2]!.operationId!,
      ])
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'FAILED', errorCode: 'EVALUATION_IMAGE_DRAIN_TIMEOUT',
        pages: [
          expect.objectContaining({ status: 'COMPLETED', submissionState: 'SUBMITTED' }),
          expect.objectContaining({ status: 'FAILED', submissionState: 'UNKNOWN' }),
          expect.objectContaining({ status: 'COMPLETED', submissionState: 'SUBMITTED' }),
        ],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('expires completed content and rejects image models outside the server whitelist', async () => {
    const { directory, clock, images, service } = await fixture()
    try {
      await expect(service.create('evaluation-tenant', { ...request(), imageModel: 'gpt-image-2' }))
        .rejects.toEqual(new QuickDeckEvaluationError(422, 'EVALUATION_MODEL_NOT_ALLOWED'))
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      clock.advance(60_001)
      const inspectionsBeforeRead = images.inspections.length
      const lookupsBeforeRead = images.lookups.length
      await expect(service.getContentOwned('evaluation-tenant', created.jobId, 'pptx'))
        .rejects.toMatchObject({ status: 410, code: 'EVALUATION_CONTENT_EXPIRED' })
      await expect(service.getEvidenceOwned('evaluation-tenant', created.jobId))
        .rejects.toMatchObject({ status: 410, code: 'EVALUATION_CONTENT_EXPIRED' })
      expect(images.inspections).toHaveLength(inspectionsBeforeRead)
      expect(images.lookups).toHaveLength(lookupsBeforeRead)
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({ status: 'COMPLETED', phase: 'COMPLETE' })
      await service.tick({ limit: 10 })
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({ status: 'EXPIRED', phase: 'EXPIRED' })
      await expect(service.getContentOwned('evaluation-tenant', created.jobId, 'pptx'))
        .rejects.toMatchObject({ code: 'EVALUATION_CONTENT_EXPIRED' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('physically removes dedicated page, preview and PPTX artifacts before publishing expiry', async () => {
    const { directory, artifacts, repository, clock, service } = await fixture(undefined, true)
    try {
      const created = await service.create('evaluation-tenant', request(2))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      const stored = await repository.get(created.jobId)
      const artifactIds = [
        ...stored!.pages.flatMap((page) => page.artifactId ? [page.artifactId] : []),
        stored!.pptx!.artifactId,
        stored!.preview!.artifactId,
      ]
      clock.advance(60_001)
      await service.tick({ limit: 10 })

      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({ status: 'EXPIRED' })
      for (const artifactId of artifactIds) {
        expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId })).toBeNull()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('expires known artifacts even when gateway cleanup lookup is unavailable', async () => {
    const { directory, artifacts, repository, clock, images, service } = await fixture(undefined, true)
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      const stored = await repository.get(created.jobId)
      const artifactIds = [stored!.pages[0]!.artifactId!, stored!.pptx!.artifactId, stored!.preview!.artifactId]
      images.failCleanupLookup = true
      clock.advance(60_001)

      await expect(service.tick({ limit: 10 })).resolves.toMatchObject({ expiredJobs: 1 })
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({ status: 'EXPIRED' })
      for (const artifactId of artifactIds) {
        expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId })).toBeNull()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('publishes expiry immediately and retries a failed artifact cleanup on the next tick', async () => {
    const { directory, artifacts, repository, clock, service } = await fixture(undefined, true, true)
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      const beforeExpiry = await repository.get(created.jobId)
      const artifactIds = [
        beforeExpiry!.pages[0]!.artifactId!, beforeExpiry!.pptx!.artifactId, beforeExpiry!.preview!.artifactId,
      ]
      clock.advance(60_001)

      await expect(service.tick({ limit: 10 })).resolves.toMatchObject({ expiredJobs: 1 })
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({ status: 'EXPIRED' })
      expect((await repository.get(created.jobId))!.pages.some((page) => page.artifactId !== null)
        || (await repository.get(created.jobId))!.pptx !== null
        || (await repository.get(created.jobId))!.preview !== null).toBe(true)

      await expect(service.tick({ limit: 10 })).resolves.toMatchObject({ expiredJobs: 1 })
      const cleaned = await repository.get(created.jobId)
      expect(cleaned).toMatchObject({ status: 'EXPIRED', pptx: null, preview: null })
      expect(cleaned!.pages.every((page) => page.artifactId === null)).toBe(true)
      for (const artifactId of artifactIds) {
        expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId })).toBeNull()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('recovers an interruption after durable expiry before physical artifact cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-expiry-crash-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new CrashAfterFirstExpirySaveRepository()
      const clock = new ControlledClock()
      const images = new AsyncImages(artifacts)
      const cleanup = new LocalQuickDeckEvaluationArtifactCleanupPort(join(directory, 'artifacts'))
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock, artifactCleanup: cleanup,
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      const beforeExpiry = await repository.get(created.jobId)
      const artifactIds = [
        beforeExpiry!.pages[0]!.artifactId!,
        beforeExpiry!.pptx!.artifactId,
        beforeExpiry!.preview!.artifactId,
      ]
      clock.advance(60_001)

      await service.tick({ limit: 10 })

      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'EXPIRED',
        cleanupPending: true,
        cleanupDeadline: expect.any(String),
      })
      for (const artifactId of artifactIds) {
        expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId })).not.toBeNull()
      }

      const resumedService = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock, artifactCleanup: cleanup,
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      expect(await resumedService.initialize()).toBe(0)
      await resumedService.tick({ limit: 10 })

      const cleaned = await repository.get(created.jobId)
      expect(cleaned).toMatchObject({ status: 'EXPIRED', cleanupPending: false, pptx: null, preview: null })
      expect(cleaned!.pages.every((page) => page.artifactId === null)).toBe(true)
      for (const artifactId of artifactIds) {
        expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId })).toBeNull()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps an expired processing image in the cleanup queue until its original operation can be removed', async () => {
    const { directory, artifacts, repository, clock, images, service } = await fixture(undefined, true, false,
      (localArtifacts) => new ProcessingAtExpiryImages(localArtifacts))
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      const submitted = await repository.get(created.jobId)
      const operationId = submitted!.pages[0]!.operationId!
      const artifactId = images.operations.get(operationId)!
      clock.advance(60_001)

      await service.tick({ limit: 10 })
      expect(await repository.get(created.jobId)).toMatchObject({ status: 'EXPIRED', cleanupPending: true })
      expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId })).not.toBeNull()

      await service.tick({ limit: 10 })
      expect((await repository.get(created.jobId))?.cleanupPending).toBe(false)
      expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId })).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps a terminal unknown image inspection in the expiry cleanup queue', async () => {
    const { directory, repository, clock, images: imagePort, service } = await fixture(undefined, false, false,
      (artifacts) => new PersistentUnknownInspectionImages(artifacts))
    const images = imagePort as PersistentUnknownInspectionImages
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      const submitted = await repository.get(created.jobId)
      const operationId = submitted!.pages[0]!.operationId
      clock.advance(60_001)

      await service.tick({ limit: 10 })

      expect(images.lookups.map((lookup) => lookup.idempotencyKey)).toEqual([submitted!.pages[0]!.idempotencyKey])
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'EXPIRED',
        cleanupPending: true,
        pages: [expect.objectContaining({
          status: 'SUBMITTED',
          submissionState: 'SUBMITTED',
          operationId,
          errorCode: null,
        })],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists an expired terminal image failure once instead of repeatedly inspecting it', async () => {
    const { directory, repository, clock, images: imagePort, service } = await fixture(undefined, false, false,
      (artifacts) => new FailedAtExpiryImages(artifacts))
    const images = imagePort as FailedAtExpiryImages
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      const submitted = await repository.get(created.jobId)
      const operationId = submitted!.pages[0]!.operationId
      images.failInspection = true
      clock.advance(60_001)

      await service.tick({ limit: 10 })

      expect(images.inspections).toHaveLength(1)
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'EXPIRED',
        cleanupPending: false,
        pages: [expect.objectContaining({
          status: 'FAILED',
          submissionState: 'SUBMITTED',
          billingState: 'CHARGED',
          operationId,
          errorCode: 'EVALUATION_PROVIDER_ERROR',
        })],
      })

      await service.tick({ limit: 10 })
      expect(images.inspections).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('does not re-inspect a terminal failed image while another expired artifact remains pending cleanup', async () => {
    const { directory, repository, clock, images: imagePort, service } = await fixture(undefined, true, true,
      (artifacts) => new FirstPageFailedAtExpiryImages(artifacts))
    const images = imagePort as FirstPageFailedAtExpiryImages
    try {
      const created = await service.create('evaluation-tenant', request(2))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      const completed = await repository.get(created.jobId)
      if (!completed) throw new Error('QUICK_DECK_TEST_RECORD_MISSING')
      await repository.save({
        record: {
          ...completed,
          pages: completed.pages.map((page) => page.pageNumber === 1 ? {
            ...page,
            status: 'FAILED',
            billingState: 'CHARGED',
            artifactId: null,
            errorCode: 'EVALUATION_PROVIDER_ERROR',
          } : page),
        },
      })
      images.failInspection = true
      clock.advance(60_001)
      const inspectionsBeforeExpiry = images.inspections.length

      await service.tick({ limit: 10 })
      expect((await repository.get(created.jobId))?.cleanupPending).toBe(true)
      expect(images.inspections).toHaveLength(inspectionsBeforeExpiry)

      await service.tick({ limit: 10 })
      expect(images.inspections).toHaveLength(inspectionsBeforeExpiry)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists a definitive not-submitted lookup during expiry cleanup', async () => {
    const { directory, repository, clock, images, service } = await fixture(undefined, false, false,
      (artifacts) => new NotSubmittedLookupImages(artifacts))
    try {
      const created = await service.create('evaluation-tenant', request(1))
      const record = await repository.get(created.jobId)
      if (!record) throw new Error('QUICK_DECK_TEST_RECORD_MISSING')
      await repository.save({
        record: {
          ...record,
          status: 'GENERATING',
          phase: 'IMAGE_GENERATION',
          pages: record.pages.map((page) => ({
            ...page,
            submissionState: 'UNKNOWN',
            billingState: 'UNKNOWN',
          })),
        },
      })
      clock.advance(60_001)

      await service.tick({ limit: 10 })

      expect(images.lookups).toHaveLength(1)
      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'EXPIRED',
        cleanupPending: false,
        pages: [expect.objectContaining({
          status: 'FAILED',
          submissionState: 'NOT_SUBMITTED',
          billingState: 'NOT_CHARGED',
        })],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('recovers deterministic packaging artifacts after the completed-state save is interrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-package-orphan-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new FailOnceCompletedSaveRepository()
      const clock = new ControlledClock()
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images: new AsyncImages(artifacts),
        renderer: new SharpPptxPresentationRenderer(), clock,
        artifactCleanup: new LocalQuickDeckEvaluationArtifactCleanupPort(join(directory, 'artifacts')),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      const previewKey = `quick-deck-evaluation:${created.jobId}:preview`
      const pptxKey = `quick-deck-evaluation:${created.jobId}:pptx`
      expect(await artifacts.getByIdempotencyKey({ tenantId: 'evaluation-tenant', idempotencyKey: previewKey })).not.toBeNull()
      expect(await artifacts.getByIdempotencyKey({ tenantId: 'evaluation-tenant', idempotencyKey: pptxKey })).not.toBeNull()
      expect(await repository.get(created.jobId)).toMatchObject({ status: 'FAILED' })

      clock.advance(60_001)
      await service.tick({ limit: 10 })

      expect(await artifacts.getByIdempotencyKey({ tenantId: 'evaluation-tenant', idempotencyKey: previewKey })).toBeNull()
      expect(await artifacts.getByIdempotencyKey({ tenantId: 'evaluation-tenant', idempotencyKey: pptxKey })).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('retains internal artifact references when no cleanup adapter can physically delete them', async () => {
    const { directory, artifacts, repository, clock, service } = await fixture()
    try {
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })
      const beforeExpiry = await repository.get(created.jobId)
      const artifactId = beforeExpiry!.pages[0]!.artifactId!

      clock.advance(60_001)
      await service.tick({ limit: 10 })

      expect(await repository.get(created.jobId)).toMatchObject({
        status: 'EXPIRED',
        cleanupPending: false,
        cleanupAuditRequired: true,
        pages: [expect.objectContaining({ artifactId })],
        pptx: expect.objectContaining({ artifactId: beforeExpiry!.pptx!.artifactId }),
        preview: expect.objectContaining({ artifactId: beforeExpiry!.preview!.artifactId }),
      })
      expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId })).not.toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('resumes a packaging lease loss from its stable artifacts without marking the evaluation failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-packaging-recovery-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new LoseCompletedClaimRepository()
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images: new AsyncImages(artifacts),
        renderer: new SharpPptxPresentationRenderer(), clock: new ControlledClock(),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(1))
      await service.tick({ limit: 10 })
      await service.tick({ limit: 10 })

      expect(await repository.get(created.jobId)).toMatchObject({ status: 'PACKAGING', phase: 'PPTX_PACKAGING' })
      expect(await service.initialize()).toBe(1)
      await service.tick({ limit: 10 })

      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({
        status: 'COMPLETED',
        phase: 'COMPLETE',
        failure: null,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists a newly discovered Provider artifact when its first expiry cleanup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-discovered-cleanup-'))
    try {
      const artifacts = new LocalArtifactPort(join(directory, 'artifacts'))
      const repository = new InMemoryQuickDeckEvaluationRepository()
      const clock = new ControlledClock()
      const images = new PartialImages(artifacts)
      const service = new QuickDeckEvaluationService({
        repository, artifacts, model: new CreativeModel(), images,
        renderer: new SharpPptxPresentationRenderer(), clock,
        artifactCleanup: new FailOnceArtifactCleanup(
          new LocalQuickDeckEvaluationArtifactCleanupPort(join(directory, 'artifacts')),
        ),
        textModel: 'gpt-5.6-terra', allowedImageModels: ['gemini-3-pro-image-preview'],
        modelEligibility: readyModelEligibility,
        maxActiveJobs: 2, maxDailyJobs: 3, ttlMs: 60_000,
      })
      const created = await service.create('evaluation-tenant', request(2))
      await service.tick({ limit: 10 })
      expect(await service.getOwned('evaluation-tenant', created.jobId)).toMatchObject({ status: 'GENERATING' })
      const providerArtifactId = images.operations.get(images.operations.get(
        `quick-deck-evaluation:${created.jobId}:slide:1:image`,
      )!)!
      clock.advance(60_001)

      await service.tick({ limit: 10 })
      const pendingCleanup = await repository.get(created.jobId)
      expect(pendingCleanup).toMatchObject({ status: 'EXPIRED' })
      expect(pendingCleanup!.pages[0]).toMatchObject({ pageNumber: 1, artifactId: providerArtifactId })
      expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId: providerArtifactId })).not.toBeNull()

      await service.tick({ limit: 10 })
      expect((await repository.get(created.jobId))!.pages.every((page) => page.artifactId === null)).toBe(true)
      expect(await artifacts.get({ tenantId: 'evaluation-tenant', artifactId: providerArtifactId })).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

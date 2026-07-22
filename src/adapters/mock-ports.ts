import type {
  ArtifactPort,
  AssetCandidateReviewPort,
  BudgetPort,
  ClockPort,
  DeckReviewPort,
  ImageGenerationPort,
  RevisionPlanningPort,
  RevisionApplicationPort,
  PresentationRendererPort,
  StructuredModelPort,
  VisualReviewPort,
} from '../core/ports'
import { BudgetReservationError, MediaSubmissionError } from '../core/ports'
import { createHash } from 'node:crypto'

export class FixedClock implements ClockPort {
  constructor(private current = new Date('2026-07-21T00:00:00.000Z')) {}
  now() { return new Date(this.current) }
  advance(milliseconds: number) { this.current = new Date(this.current.getTime() + milliseconds) }
}

export class MockBudgetPort implements BudgetPort {
  readonly reservations = new Map<string, string>()
  readonly released = new Set<string>()
  nextFailure: BudgetReservationError | null = null

  async reserve(input: Parameters<BudgetPort['reserve']>[0]) {
    const existing = this.reservations.get(input.idempotencyKey)
    if (existing) return { reservationId: existing }
    if (this.nextFailure) {
      const failure = this.nextFailure
      this.nextFailure = null
      throw failure
    }
    const reservationId = `budget:${input.host.tenantId}:${input.idempotencyKey}`
    this.reservations.set(input.idempotencyKey, reservationId)
    return { reservationId }
  }

  async release(input: Parameters<BudgetPort['release']>[0]) {
    this.released.add(input.reservationId)
  }

  failNext(code: string, reservationState: 'NOT_RESERVED' | 'UNKNOWN') {
    this.nextFailure = new BudgetReservationError(code, reservationState, code)
  }
}

export class MockImageGenerationPort implements ImageGenerationPort {
  readonly operations = new Map<string, string>()
  readonly statuses = new Map<string, Awaited<ReturnType<ImageGenerationPort['inspect']>>>()
  readonly requests = new Map<string, Parameters<ImageGenerationPort['submit']>[0]>()
  nextFailure: MediaSubmissionError | null = null

  async submit(input: Parameters<ImageGenerationPort['submit']>[0]) {
    const existing = this.operations.get(input.idempotencyKey)
    if (existing) return { operationId: existing, state: 'QUEUED' as const }
    if (this.nextFailure) {
      const failure = this.nextFailure
      this.nextFailure = null
      throw failure
    }
    const operationId = `image:${input.tenantId}:${input.idempotencyKey}`
    this.operations.set(input.idempotencyKey, operationId)
    this.requests.set(input.idempotencyKey, structuredClone(input))
    this.statuses.set(operationId, { state: 'QUEUED' })
    return { operationId, state: 'QUEUED' as const }
  }

  async inspect(input: Parameters<ImageGenerationPort['inspect']>[0]) {
    return structuredClone(this.statuses.get(input.operationId) ?? {
      state: 'FAILED' as const,
      errorCode: 'OPERATION_NOT_FOUND',
      billingState: 'UNKNOWN' as const,
    })
  }

  complete(idempotencyKey: string, artifactId: string) {
    const operationId = this.operations.get(idempotencyKey)
    if (!operationId) throw new Error('mock operation not found')
    this.statuses.set(operationId, { state: 'COMPLETED', artifactId })
  }

  fail(idempotencyKey: string, errorCode: string, billingState: 'NOT_CHARGED' | 'CHARGED' | 'UNKNOWN') {
    const operationId = this.operations.get(idempotencyKey)
    if (!operationId) throw new Error('mock operation not found')
    this.statuses.set(operationId, { state: 'FAILED', errorCode, billingState })
  }

  failNext(code: string, submissionState: 'NOT_SUBMITTED' | 'UNKNOWN') {
    this.nextFailure = new MediaSubmissionError(code, submissionState, code)
  }
}

export class MockStructuredModelPort implements StructuredModelPort {
  readonly executions = new Map<string, unknown>()
  nextFailure: Error | null = null

  constructor(public response: unknown) {}

  async execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    if (this.executions.has(input.idempotencyKey)) return this.executions.get(input.idempotencyKey)
    if (this.nextFailure) {
      const failure = this.nextFailure
      this.nextFailure = null
      throw failure
    }
    this.executions.set(input.idempotencyKey, structuredClone(this.response))
    return structuredClone(this.response)
  }
}

export class MockVisualReviewPort implements VisualReviewPort {
  readonly reviews = new Map<string, unknown>()
  readonly responsesByArtifact = new Map<string, unknown>()
  constructor(public response: unknown) {}

  async review(input: Parameters<VisualReviewPort['review']>[0]) {
    if (this.reviews.has(input.idempotencyKey)) return structuredClone(this.reviews.get(input.idempotencyKey))
    const response = this.responsesByArtifact.get(input.artifactId) ?? this.response
    this.reviews.set(input.idempotencyKey, structuredClone(response))
    return structuredClone(response)
  }

  respondToArtifact(artifactId: string, response: unknown) {
    this.responsesByArtifact.set(artifactId, structuredClone(response))
  }
}

export class MockAssetCandidateReviewPort implements AssetCandidateReviewPort {
  readonly reviews: Parameters<AssetCandidateReviewPort['reviewCandidate']>[0][] = []
  readonly responsesByCandidate = new Map<string, unknown>()

  constructor(public response: unknown) {}

  async reviewCandidate(input: Parameters<AssetCandidateReviewPort['reviewCandidate']>[0]) {
    this.reviews.push(structuredClone(input))
    return structuredClone(this.responsesByCandidate.get(input.candidate.providerAssetId) ?? this.response)
  }

  respondToCandidate(providerAssetId: string, response: unknown) {
    this.responsesByCandidate.set(providerAssetId, structuredClone(response))
  }
}

export class MockDeckReviewPort implements DeckReviewPort {
  readonly evaluations = new Map<string, unknown>()
  readonly requests = new Map<string, Parameters<DeckReviewPort['evaluate']>[0]>()

  constructor(public response: unknown) {}

  async evaluate(input: Parameters<DeckReviewPort['evaluate']>[0]) {
    if (this.evaluations.has(input.idempotencyKey)) {
      return structuredClone(this.evaluations.get(input.idempotencyKey))
    }
    this.requests.set(input.idempotencyKey, structuredClone(input))
    this.evaluations.set(input.idempotencyKey, structuredClone(this.response))
    return structuredClone(this.response)
  }
}

export class MockRevisionPlanningPort implements RevisionPlanningPort {
  readonly plans = new Map<string, unknown>()
  readonly requests = new Map<string, Parameters<RevisionPlanningPort['plan']>[0]>()

  constructor(public response: unknown) {}

  async plan(input: Parameters<RevisionPlanningPort['plan']>[0]) {
    if (this.plans.has(input.idempotencyKey)) return structuredClone(this.plans.get(input.idempotencyKey))
    this.requests.set(input.idempotencyKey, structuredClone(input))
    this.plans.set(input.idempotencyKey, structuredClone(this.response))
    return structuredClone(this.response)
  }
}

export class MockRevisionApplicationPort implements RevisionApplicationPort {
  readonly applications = new Map<string, unknown>()
  readonly requests = new Map<string, Parameters<RevisionApplicationPort['apply']>[0]>()

  constructor(public response: unknown) {}

  async apply(input: Parameters<RevisionApplicationPort['apply']>[0]) {
    if (this.applications.has(input.idempotencyKey)) return structuredClone(this.applications.get(input.idempotencyKey))
    this.requests.set(input.idempotencyKey, structuredClone(input))
    this.applications.set(input.idempotencyKey, structuredClone(this.response))
    return structuredClone(this.response)
  }
}

export class MockArtifactPort implements ArtifactPort {
  readonly artifacts = new Map<string, { mimeType: string; bytes: Uint8Array; sha256: string }>()
  readonly keys = new Map<string, string>()

  async put(input: Parameters<ArtifactPort['put']>[0]) {
    const existingId = this.keys.get(input.idempotencyKey)
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    if (existingId) {
      const existing = this.artifacts.get(existingId)!
      if (existing.sha256 !== sha256 || existing.mimeType !== input.mimeType) throw new Error('ARTIFACT_IDEMPOTENCY_CONFLICT')
      return { artifactId: existingId, sha256: existing.sha256 }
    }
    const artifactId = `artifact:${input.tenantId}:${input.idempotencyKey}`
    this.keys.set(input.idempotencyKey, artifactId)
    this.artifacts.set(artifactId, { mimeType: input.mimeType, bytes: new Uint8Array(input.bytes), sha256 })
    return { artifactId, sha256 }
  }

  async get(input: Parameters<ArtifactPort['get']>[0]) {
    const value = this.artifacts.get(input.artifactId)
    return value ? structuredClone(value) : null
  }

  async getByIdempotencyKey(input: Parameters<ArtifactPort['getByIdempotencyKey']>[0]) {
    const artifactId = this.keys.get(input.idempotencyKey)
    if (!artifactId?.startsWith(`artifact:${input.tenantId}:`)) return null
    const value = this.artifacts.get(artifactId)
    return value ? { artifactId, ...structuredClone(value) } : null
  }
}

export class MockPresentationRendererPort implements PresentationRendererPort {
  slidePreviewCalls = 0
  previewCalls = 0
  pptxCalls = 0
  nextFailure: Error | null = null

  async renderSlidePreviews(input: Parameters<PresentationRendererPort['renderSlidePreviews']>[0]) {
    this.slidePreviewCalls += 1
    this.throwIfNeeded()
    return input.slides.map((slide) => ({
      pageNumber: slide.pageNumber,
      image: new TextEncoder().encode(`SLIDE:${input.blueprint.id}:${slide.pageNumber}`),
    }))
  }

  async renderPreview(input: Parameters<PresentationRendererPort['renderPreview']>[0]) {
    return this.renderPreviewFromSlidePreviews({
      slides: input.slides.map((slide) => ({ pageNumber: slide.pageNumber, image: slide.image })),
    })
  }

  async renderPreviewFromSlidePreviews(input: Parameters<PresentationRendererPort['renderPreviewFromSlidePreviews']>[0]) {
    this.previewCalls += 1
    this.throwIfNeeded()
    return new TextEncoder().encode(`PNG:${input.slides.length}`)
  }

  async renderPptx(input: Parameters<PresentationRendererPort['renderPptx']>[0]) {
    this.pptxCalls += 1
    this.throwIfNeeded()
    return new TextEncoder().encode(`PPTX:${input.blueprint.id}:${input.slides.length}`)
  }

  private throwIfNeeded() {
    if (!this.nextFailure) return
    const failure = this.nextFailure
    this.nextFailure = null
    throw failure
  }
}

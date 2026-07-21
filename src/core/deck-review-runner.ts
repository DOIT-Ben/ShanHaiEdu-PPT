import { CONTRACT_VERSION } from '../contracts'
import {
  deckReviewDraftSchema,
  deckReviewSchema,
  type DeckReview,
  type DeckReviewDraft,
  type PresentationBlueprint,
} from '../presentation-contracts'
import { hashInput } from './hash'
import { getActiveBlueprint } from './active-blueprint'
import {
  renderAndStoreSlidePreviews,
  requirePresentationArtifactReferences,
  type PresentationArtifactReference,
} from './presentation-render-input'
import type {
  AgentRepository,
  ArtifactPort,
  ClockPort,
  DeckReviewPort,
  DocumentPort,
  PresentationRendererPort,
  RunRecord,
  SourceChunk,
  StepRecord,
} from './ports'
import { transitionRun } from './policy'

export const DECK_QUALITY_THRESHOLD = 80

export type DeckReviewResult = Readonly<{
  step: StepRecord
  review: DeckReview | null
  passed: boolean
  replayed: boolean
}>

type DeckSlideInput = Parameters<DeckReviewPort['evaluate']>[0]['slides'][number]

export class DeckReviewRunner {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    documents: DocumentPort
    reviewer: DeckReviewPort
    artifacts: ArtifactPort
    renderer: PresentationRendererPort
    clock: ClockPort
  }>) {}

  async review(runId: string): Promise<DeckReviewResult> {
    const run = await this.requireRun(runId)
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    let sourceChunks: readonly SourceChunk[]
    let slides: readonly DeckSlideInput[]
    let artifactReferences: readonly PresentationArtifactReference[]
    try {
      const document = await this.dependencies.documents.resolve({ host: run.host, source: run.source })
      if (!document.isComplete) throw new Error('SOURCE_INCOMPLETE')
      sourceChunks = this.requireSourceCoverage(blueprint, document.chunks)
      artifactReferences = await requirePresentationArtifactReferences(this.dependencies.repository, run, blueprint)
      slides = this.deckSlides(run, blueprint, artifactReferences)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DECK_REVIEW_INPUT_FAILED'
      return this.failBeforeStart(run, code)
    }
    const idempotencyKey = deckReviewStepKey(run)
    const inputHash = hashInput({
      tool: 'review_deck',
      revisionRound: run.revisionRound,
      blueprint,
      sourceChunks: sourceChunks.map(({ id, sha256 }) => ({ id, sha256 })),
      slides,
    })
    const prepared = await this.prepare(run, idempotencyKey, inputHash)
    if (prepared) return prepared

    try {
      const previews = await renderAndStoreSlidePreviews({
        artifacts: this.dependencies.artifacts,
        renderer: this.dependencies.renderer,
        run,
        blueprint,
        references: artifactReferences,
        idempotencyPrefix: idempotencyKey,
      })
      const previewByPage = new Map(previews.map((preview) => [preview.pageNumber, preview.artifactId]))
      const reviewSlides = slides.map((slide) => {
        const artifactId = previewByPage.get(slide.pageNumber)
        if (!artifactId) throw new Error('SLIDE_PREVIEW_ARTIFACT_MISSING')
        return { ...slide, artifactId }
      })
      const raw = await this.dependencies.reviewer.evaluate({
        tenantId: run.host.tenantId,
        blueprint,
        sourceChunks,
        slides: reviewSlides,
        idempotencyKey,
      })
      const draft = deckReviewDraftSchema.parse(raw)
      this.validateReferences(draft, run.id, blueprint, sourceChunks)
      const review = deckReviewSchema.parse({
        ...draft,
        id: `${runId}:deck-review:r${run.revisionRound}`,
        revisionRound: run.revisionRound,
        createdAt: this.dependencies.clock.now().toISOString(),
      })
      return this.complete(run, idempotencyKey, review)
    } catch {
      return this.fail(run, idempotencyKey, 'DECK_REVIEW_FAILED')
    }
  }

  private async prepare(run: RunRecord, idempotencyKey: string, inputHash: string) {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const existing = transaction.getStep(idempotencyKey)
      if (existing) {
        if (existing.inputHash !== inputHash || existing.tool !== 'review_deck') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        if (existing.status === 'COMPLETED') {
          const review = deckReviewSchema.parse(existing.output)
          return { step: existing, review, passed: passesDeckQuality(review), replayed: true }
        }
        if (existing.status === 'FAILED') {
          return { step: existing, review: null, passed: false, replayed: true }
        }
        throw new Error('DECK_REVIEW_ALREADY_RUNNING')
      }
      if (transaction.run.status !== 'DECK_REVIEW') throw new Error('RUN_NOT_IN_DECK_REVIEW')
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: `step-${run.id}-deck-review-r${run.revisionRound}`,
        runId: run.id,
        idempotencyKey,
        inputHash,
        tool: 'review_deck',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: now,
        updatedAt: now,
      }
      transaction.putStep(step)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.started',
        payload: { stepId: step.id, tool: step.tool, label: '执行整套课件质量评估' },
      })
      return null
    })
  }

  private async complete(run: RunRecord, idempotencyKey: string, review: DeckReview): Promise<DeckReviewResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const updatedStep: StepRecord = { ...step, status: 'COMPLETED', output: review, updatedAt: now }
      const passed = passesDeckQuality(review)
      const policy = passed ? transitionRun(transaction.run, 'DELIVERING') : transaction.run
      transaction.putStep(updatedStep)
      transaction.putRun({ ...transaction.run, ...policy, qualityScore: review.qualityScore, updatedAt: now })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: step.id, summary: `整套课件质量评估完成（${review.qualityScore} 分）` },
      })
      for (const issue of review.issues) {
        transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'issue.detected', payload: issue })
      }
      if (passed) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'DECK_REVIEW', to: 'DELIVERING' },
        })
      }
      return { step: updatedStep, review, passed, replayed: false }
    })
  }

  private async failBeforeStart(run: RunRecord, errorCode: string): Promise<DeckReviewResult> {
    const idempotencyKey = deckReviewStepKey(run)
    const inputHash = hashInput({ tool: 'review_deck', errorCode, revisionRound: run.revisionRound })
    const prepared = await this.prepare(run, idempotencyKey, inputHash)
    if (prepared) return prepared
    return this.fail(run, idempotencyKey, errorCode)
  }

  private async fail(run: RunRecord, idempotencyKey: string, errorCode: string): Promise<DeckReviewResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const policy = transaction.run.status === 'NEEDS_HUMAN'
        ? transaction.run
        : transitionRun(transaction.run, 'NEEDS_HUMAN')
      const updatedStep: StepRecord = { ...step, status: 'FAILED', errorCode, updatedAt: now }
      transaction.putStep(updatedStep)
      transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode, retryable: false },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: transaction.run.status, to: 'NEEDS_HUMAN', reason: errorCode },
      })
      return { step: updatedStep, review: null, passed: false, replayed: false }
    })
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }

  private requireSourceCoverage(blueprint: PresentationBlueprint, chunks: readonly SourceChunk[]) {
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
    const referenced = new Set([
      ...blueprint.curriculum.sourceChunkIds,
      ...blueprint.slides.flatMap((slide) => slide.sourceChunkIds),
    ])
    if ([...referenced].some((chunkId) => !chunksById.has(chunkId))) {
      throw new Error('DECK_REVIEW_SOURCE_REFERENCE_INVALID')
    }
    return chunks
  }

  private deckSlides(
    run: RunRecord,
    blueprint: PresentationBlueprint,
    references: readonly PresentationArtifactReference[],
  ): readonly DeckSlideInput[] {
    const referenceByPage = new Map(references.map((reference) => [reference.pageNumber, reference]))
    if (blueprint.renderMode === 'LAYERED_COURSEWARE_V3') {
      return blueprint.slides.map((slide) => {
        if (!slide.layeredDesign) throw new Error('LAYERED_DESIGN_MISSING')
        const reference = referenceByPage.get(slide.pageNumber)
        if (!reference?.assets) throw new Error('LAYER_ARTIFACT_NOT_FOUND')
        const artifactByElement = new Map(reference.assets.map((asset) => [asset.elementId, asset.artifactId]))
        const assets = slide.layeredDesign.elements
          .filter((element): element is Extract<(typeof slide.layeredDesign.elements)[number], { kind: 'IMAGE' }> => element.kind === 'IMAGE')
          .map((element) => {
            const artifactId = artifactByElement.get(element.elementId)
            if (!artifactId) throw new Error('LAYER_ARTIFACT_NOT_FOUND')
            return {
              elementId: element.elementId,
              role: element.role,
              artifactId,
              knowledgePoint: element.knowledgePoint,
              sourceChunkIds: element.sourceChunkIds,
            }
          })
        const base = assets.find((asset) => asset.role === 'BASE_LAYER')
        if (!base) throw new Error('BASE_LAYER_ARTIFACT_NOT_FOUND')
        return {
          slideId: `${run.id}:slide:${slide.pageNumber}`,
          pageNumber: slide.pageNumber,
          artifactId: reference.artifactId,
          title: slide.title,
          body: slide.body,
          layout: slide.layout,
          visualIntent: slide.visualIntent,
          sourceChunkIds: slide.sourceChunkIds,
          assets,
        }
      })
    }
    return blueprint.slides.map((slide) => {
      const reference = referenceByPage.get(slide.pageNumber)
      if (!reference) throw new Error('PAGE_ARTIFACT_NOT_FOUND')
      return {
        slideId: `${run.id}:slide:${slide.pageNumber}`,
        pageNumber: slide.pageNumber,
        artifactId: reference.artifactId,
        title: slide.title,
        body: slide.body,
        layout: slide.layout,
        visualIntent: slide.visualIntent,
        sourceChunkIds: slide.sourceChunkIds,
      }
    })
  }

  private validateReferences(draft: DeckReviewDraft, runId: string, blueprint: PresentationBlueprint, chunks: readonly SourceChunk[]) {
    const slideIds = new Set(blueprint.slides.map((slide) => `${runId}:slide:${slide.pageNumber}`))
    const sourceIds = new Set(chunks.map((chunk) => chunk.id))
    const requiredSourceIds = new Set(blueprint.curriculum.sourceChunkIds)
    if ([...requiredSourceIds].some((id) => !draft.reviewedSourceChunkIds.includes(id))) {
      throw new Error('DECK_REVIEW_SOURCE_COVERAGE_INCOMPLETE')
    }
    if (draft.reviewedSourceChunkIds.some((id) => !sourceIds.has(id))) {
      throw new Error('DECK_REVIEW_SOURCE_REFERENCE_INVALID')
    }
    for (const issue of draft.issues) {
      if (issue.slideIds.some((id) => !slideIds.has(id))) throw new Error('DECK_REVIEW_SLIDE_REFERENCE_INVALID')
      if (issue.sourceChunkIds.some((id) => !sourceIds.has(id))) {
        throw new Error('DECK_REVIEW_SOURCE_REFERENCE_INVALID')
      }
    }
  }
}

export function deckReviewStepKey(run: Pick<RunRecord, 'id' | 'revisionRound'>) {
  return `${run.id}:deck-review:r${run.revisionRound}`
}

export function passesDeckQuality(review: DeckReview) {
  return review.qualityScore >= DECK_QUALITY_THRESHOLD
    && !review.issues.some((issue) => issue.severity === 'CRITICAL')
}

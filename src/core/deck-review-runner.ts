import { agentEventSchema, CONTRACT_VERSION, issueSummarySchema, type AgentEvent } from '../contracts'
import { ZodError } from 'zod'
import {
  deckReviewDraftSchema,
  deckReviewSchema,
  revisionPlanSchema,
  type DeckReview,
  type DeckReviewDraft,
  type PresentationBlueprint,
} from '../presentation-contracts'
import { hashInput } from './hash'
import { getActiveBlueprint, revisionBlueprintStepKey } from './active-blueprint'
import {
  renderAndStoreSlidePreviews,
  requirePresentationArtifactReferences,
  type PresentationArtifactReference,
} from './presentation-render-input'
import type {
  AgentRepository,
  ArtifactPort,
  ClockPort,
  ContractRepairIssue,
  DeckReviewPort,
  DocumentPort,
  PresentationRendererPort,
  RunRecord,
  SourceChunk,
  StepRecord,
} from './ports'
import { StructuredModelError } from './ports'
import { revisionContractRepairIssues } from './revision-contract-repair'
import { compileVisualDeckV4RevisionIssueGroups } from './revision-plan-representability'
import { transitionRun } from './policy'
import { beginTechnicalRecovery, isTechnicalFailureCode } from './technical-recovery'
import {
  allPageNumbers,
  appendAcceptedQualityIssueResolutions,
  appendFixedIssueResolutions,
  appendV4LifecycleEvent,
  classifyAutomatedQualityAcceptanceIssues,
  ensureAutomatedQualityAcceptanceIssue,
  failVisualDeckV4Transaction,
  isHardQualityIssue,
  isVisualDeckV4,
  markAutomatedQualityAcceptance,
  qualityPolicyAuditForRun,
} from './v4-lifecycle'

export const DECK_QUALITY_THRESHOLD = 80
const MAX_DECK_REVIEW_ATTEMPTS = 5
const MAX_DECK_REVIEW_CONTRACT_ATTEMPTS = 3
const DECK_REVIEW_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000] as const

type DeckReviewFailure = Readonly<{
  errorCode: string
  providerAttempt: number
  maxProviderAttempts: number
  contractAttempt: number
  maxContractAttempts: number
  model: string | null
  requestId: string | null
}>

class DeckReviewExecutionError extends Error {
  constructor(readonly diagnostic: DeckReviewFailure) {
    super(diagnostic.errorCode)
    this.name = 'DeckReviewExecutionError'
  }
}

export type DeckReviewResult = Readonly<{
  step: StepRecord
  review: DeckReview | null
  passed: boolean
  replayed: boolean
}>

type DeckSlideInput = Parameters<DeckReviewPort['evaluate']>[0]['slides'][number]

export class DeckReviewRunner {
  private readonly inFlight = new Map<string, Promise<DeckReviewResult>>()

  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    documents: DocumentPort
    reviewer: DeckReviewPort
    artifacts: ArtifactPort
    renderer: PresentationRendererPort
    clock: ClockPort
    sleep?: (milliseconds: number) => Promise<void>
  }>) {}

  review(runId: string): Promise<DeckReviewResult> {
    const existing = this.inFlight.get(runId)
    if (existing) return existing
    const pending = this.reviewOnce(runId).finally(() => {
      if (this.inFlight.get(runId) === pending) this.inFlight.delete(runId)
    })
    this.inFlight.set(runId, pending)
    return pending
  }

  private async reviewOnce(runId: string): Promise<DeckReviewResult> {
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
      })
      const previewByPage = new Map(previews.map((preview) => [preview.pageNumber, preview.artifactId]))
      const reviewSlides = slides.map((slide) => {
        const artifactId = previewByPage.get(slide.pageNumber)
        if (!artifactId) throw new Error('SLIDE_PREVIEW_ARTIFACT_MISSING')
        return { ...slide, artifactId }
      })
      const review = await this.evaluateWithRetry(run, blueprint, sourceChunks, reviewSlides, idempotencyKey)
      return this.complete(run, idempotencyKey, review)
    } catch (error) {
      const diagnostic = error instanceof DeckReviewExecutionError
        ? error.diagnostic
        : deckReviewFailure(error, 1, 1)
      return this.fail(run, idempotencyKey, diagnostic)
    }
  }

  private async evaluateWithRetry(
    run: RunRecord,
    blueprint: PresentationBlueprint,
    sourceChunks: readonly SourceChunk[],
    slides: readonly DeckSlideInput[],
    baseIdempotencyKey: string,
  ) {
    let contractRepairIssues: readonly ContractRepairIssue[] | undefined
    let lastError: unknown = new Error('DECK_REVIEW_FAILED')
    for (let contractAttempt = 0;
      contractAttempt < MAX_DECK_REVIEW_CONTRACT_ATTEMPTS;
      contractAttempt += 1) {
      const idempotencyKey = deckReviewContractAttemptKey(baseIdempotencyKey, contractAttempt)
      for (let providerAttempt = 1; providerAttempt <= MAX_DECK_REVIEW_ATTEMPTS; providerAttempt += 1) {
        try {
          const raw = await this.dependencies.reviewer.evaluate({
            tenantId: run.host.tenantId,
            blueprint,
            sourceChunks,
            slides,
            idempotencyKey,
            ...(contractRepairIssues ? { contractRepairIssues } : {}),
            ...(run.v4StructuredGenerationProtocol ? { structuredGenerationProtocol: run.v4StructuredGenerationProtocol } : {}),
          })
          const draft = deckReviewDraftSchema.parse(raw)
          this.validateReferences(draft, run.id, blueprint, sourceChunks)
          if (blueprint.renderMode === 'VISUAL_DECK_V4') {
            const repairableIssues = draft.issues.filter((issue) => issue.severity !== 'INFO'
              && (draft.qualityScore < DECK_QUALITY_THRESHOLD
                || isHardQualityIssue(issue)))
            compileVisualDeckV4RevisionIssueGroups(repairableIssues)
          }
          return deckReviewSchema.parse({
            ...draft,
            id: `${run.id}:deck-review:r${run.revisionRound}`,
            revisionRound: run.revisionRound,
            createdAt: this.dependencies.clock.now().toISOString(),
          })
        } catch (error) {
          lastError = error
          const providerRetryable = error instanceof StructuredModelError
            && error.retryable
            && error.code !== 'MODEL_JSON_INVALID'
          if (providerRetryable) {
            if (providerAttempt === MAX_DECK_REVIEW_ATTEMPTS) {
              throw new DeckReviewExecutionError(
                deckReviewFailure(error, providerAttempt, contractAttempt + 1),
              )
            }
            await (this.dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
              DECK_REVIEW_RETRY_DELAYS_MS[providerAttempt - 1] ?? DECK_REVIEW_RETRY_DELAYS_MS.at(-1)!,
            )
            continue
          }
          const issues = deckReviewContractInvalid(error) ? revisionContractRepairIssues(error) : null
          if (!issues || contractAttempt + 1 >= MAX_DECK_REVIEW_CONTRACT_ATTEMPTS) {
            throw new DeckReviewExecutionError(
              deckReviewFailure(error, providerAttempt, contractAttempt + 1),
            )
          }
          contractRepairIssues = issues
          break
        }
      }
    }
    throw new DeckReviewExecutionError(
      deckReviewFailure(lastError, 1, MAX_DECK_REVIEW_CONTRACT_ATTEMPTS),
    )
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
          const remediationExhausted = isVisualDeckV4(transaction.run)
            && transaction.run.automationLevel === 'BOUNDED_AUTO'
            && transaction.run.revisionRound >= transaction.run.maxRevisionRounds
          const disposition = remediationExhausted
            ? appendAcceptedQualityIssueResolutions(transaction)
            : { acceptedIssueIds: [] as string[], blockingIssueIds: [] as string[] }
          const acceptedQuality = classifyAutomatedQualityAcceptanceIssues(
            transaction,
            disposition.acceptedIssueIds,
          )
          const initiallyPassed = passesDeckQuality(review)
            && !hasOpenQualityIssues(transaction.listEvents())
            && acceptedQuality.invalidIssueIds.length === 0
          const hasAcceptedQualityIssue = acceptedQuality.acceptedIssueIds.length > 0
            || qualityPolicyAuditForRun(transaction.run) !== null
          const policyAcceptedForDelivery = remediationExhausted
            && disposition.blockingIssueIds.length === 0
            && acceptedQuality.invalidIssueIds.length === 0
            && (hasAcceptedQualityIssue || !initiallyPassed)
          if (policyAcceptedForDelivery && transaction.run.status === 'DECK_REVIEW') {
            const now = this.dependencies.clock.now().toISOString()
            const policy = transitionRun(transaction.run, 'DELIVERING')
            const acceptedIssueIds = ensureAutomatedQualityAcceptanceIssue(transaction, disposition.acceptedIssueIds)
            transaction.putRun({
              ...markAutomatedQualityAcceptance({ ...transaction.run, ...policy }, acceptedIssueIds, now),
              qualityScore: review.qualityScore,
              updatedAt: now,
            })
            appendV4LifecycleEvent(transaction, 'deck_review.completed', {
              completed: 1, total: 1, pageNumbers: allPageNumbers(transaction.run),
              reason: passesDeckQuality(review) ? null : 'DECK_REVIEW_REJECTED',
              retryable: passesDeckQuality(review) ? null : false,
            })
            transaction.appendEvent({
              schemaVersion: CONTRACT_VERSION,
              type: 'phase.changed',
              payload: { from: 'DECK_REVIEW', to: 'DELIVERING', reason: 'QUALITY_POLICY_ACCEPTED' },
            })
            appendV4LifecycleEvent(transaction, 'delivery.started', {
              completed: 0, total: 1, pageNumbers: allPageNumbers(transaction.run),
            })
          }
          const replayHasHardBlocker = disposition.blockingIssueIds.length > 0
            || acceptedQuality.invalidIssueIds.length > 0
          const replayHasInconsistentPassingReview = passesDeckQuality(review) && !initiallyPassed
          if (!initiallyPassed && isVisualDeckV4(transaction.run)
            && transaction.run.status === 'DECK_REVIEW' && !policyAcceptedForDelivery
            && (replayHasHardBlocker || replayHasInconsistentPassingReview)) {
            failVisualDeckV4Transaction({
              transaction,
              clock: this.dependencies.clock,
              errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT',
              reason: 'DECK_REVIEW_REJECTED',
            })
          }
          return {
            step: existing,
            review,
            passed: initiallyPassed && !policyAcceptedForDelivery,
            replayed: true,
          }
        }
        if (existing.status === 'FAILED') {
          return { step: existing, review: null, passed: false, replayed: true }
        }
        if (existing.status === 'RUNNING') return null
        throw new Error('DECK_REVIEW_STEP_STATE_INVALID')
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
      appendV4LifecycleEvent(transaction, 'deck_review.started', {
        completed: 0,
        total: 1,
        pageNumbers: allPageNumbers(transaction.run),
      })
      return null
    })
  }

  private async complete(run: RunRecord, idempotencyKey: string, review: DeckReview): Promise<DeckReviewResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') {
        const persisted = deckReviewSchema.parse(step.output)
        return {
          step,
          review: persisted,
          passed: passesDeckQuality(persisted) && !hasOpenQualityIssues(transaction.listEvents()),
          replayed: true,
        }
      }
      if (step.status === 'FAILED') return { step, review: null, passed: false, replayed: true }
      if (step.status !== 'RUNNING') throw new Error('DECK_REVIEW_STEP_STATE_INVALID')
      const now = this.dependencies.clock.now().toISOString()
      const updatedStep: StepRecord = { ...step, status: 'COMPLETED', output: review, updatedAt: now }
      transaction.putStep(updatedStep)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: step.id, summary: `整套课件质量评估完成（${review.qualityScore} 分）` },
      })
      const successfulRevisionRounds = isVisualDeckV4(transaction.run)
        ? successfulV4RevisionRounds(transaction.listEvents())
        : null
      const repairedIssueIds = transaction.listSteps().flatMap((candidate) => {
        if (candidate.status !== 'COMPLETED'
          || (candidate.tool !== 'plan_revision' && candidate.tool !== 'plan_page_revision')) return []
        const plan = revisionPlanSchema.safeParse(candidate.output)
        const application = plan.success
          ? transaction.getStep(revisionBlueprintStepKey(run.id, plan.data.revisionRound))
          : null
        return plan.success && plan.data.revisionRound <= run.revisionRound
          && application?.status === 'COMPLETED'
          && (successfulRevisionRounds === null || successfulRevisionRounds.has(plan.data.revisionRound))
          ? plan.data.operations.flatMap((operation) => operation.issueIds)
          : []
      })
      appendFixedIssueResolutions(
        transaction,
        repairedIssueIds,
        review.issues.map((issue) => issue.id),
      )
      for (const issue of review.issues) {
        transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'issue.detected', payload: issue })
      }
      const currentReviewPassed = passesDeckQuality(review)
      const hasHistoricalIssue = hasOpenQualityIssues(transaction.listEvents())
      const hasHistoricalBlocker = hasOpenBlockingIssues(transaction.listEvents())
      const remediationExhausted = isVisualDeckV4(transaction.run)
        && transaction.run.automationLevel === 'BOUNDED_AUTO'
        && transaction.run.revisionRound >= transaction.run.maxRevisionRounds
      const disposition = remediationExhausted
        ? appendAcceptedQualityIssueResolutions(transaction)
        : { acceptedIssueIds: [] as string[], blockingIssueIds: [] as string[] }
      const acceptedQuality = classifyAutomatedQualityAcceptanceIssues(
        transaction,
        disposition.acceptedIssueIds,
      )
      const reviewPassed = currentReviewPassed
        && !hasHistoricalIssue
        && disposition.blockingIssueIds.length === 0
        && acceptedQuality.invalidIssueIds.length === 0
      const hasAcceptedQualityIssue = acceptedQuality.acceptedIssueIds.length > 0
        || qualityPolicyAuditForRun(transaction.run) !== null
      const policyAcceptedForDelivery = remediationExhausted
        && disposition.blockingIssueIds.length === 0
        && acceptedQuality.invalidIssueIds.length === 0
        && (hasAcceptedQualityIssue || !reviewPassed)
      const shouldDeliver = reviewPassed || policyAcceptedForDelivery
      const requiresHuman = currentReviewPassed && hasHistoricalBlocker && !remediationExhausted
      const requiresInternalFailure = isVisualDeckV4(transaction.run)
        && (disposition.blockingIssueIds.length > 0
          || acceptedQuality.invalidIssueIds.length > 0
          || (requiresHuman && !policyAcceptedForDelivery))
      const policy = shouldDeliver
        ? transitionRun(transaction.run, 'DELIVERING')
        : requiresHuman && !requiresInternalFailure ? transitionRun(transaction.run, 'NEEDS_HUMAN') : transaction.run
      const acceptedIssueIds = policyAcceptedForDelivery
        ? ensureAutomatedQualityAcceptanceIssue(transaction, disposition.acceptedIssueIds)
        : []
      const qualityRun = policyAcceptedForDelivery
        ? markAutomatedQualityAcceptance({ ...transaction.run, ...policy }, acceptedIssueIds, now)
        : { ...transaction.run, ...policy }
      const dispositionRun = reviewPassed && !policyAcceptedForDelivery && !qualityRun.qualityOverride
        ? { ...qualityRun, qualityDisposition: 'REVIEW_PASSED' as const, qualityPolicyAudit: null }
        : !qualityRun.qualityOverride
          ? { ...qualityRun, qualityDisposition: 'PENDING' as const }
          : qualityRun
      const persistedRun = isVisualDeckV4(transaction.run) && !shouldDeliver
        ? { ...dispositionRun, qualityDisposition: 'PENDING' as const }
        : dispositionRun
      transaction.putRun({ ...persistedRun, qualityScore: review.qualityScore, updatedAt: now })
      appendV4LifecycleEvent(transaction, 'deck_review.completed', {
        completed: 1,
        total: 1,
        pageNumbers: allPageNumbers(transaction.run),
        reason: currentReviewPassed ? null : 'DECK_REVIEW_REJECTED',
        retryable: currentReviewPassed ? null : policyAcceptedForDelivery ? false : !requiresHuman,
        requiresUserAction: requiresHuman && !requiresInternalFailure,
        nextAction: requiresHuman && !requiresInternalFailure ? 'REVIEW_RESULT' : null,
      })
      if (shouldDeliver) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'DECK_REVIEW', to: 'DELIVERING' },
        })
        appendV4LifecycleEvent(transaction, 'delivery.started', {
          completed: 0,
          total: 1,
          pageNumbers: allPageNumbers(transaction.run),
        })
      } else if (requiresInternalFailure) {
        failVisualDeckV4Transaction({
          transaction,
          clock: this.dependencies.clock,
          errorCode: 'QUALITY_ISSUE_STATE_INCONSISTENT',
          reason: 'DECK_REVIEW_REJECTED',
        })
      } else if (requiresHuman) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'DECK_REVIEW', to: 'NEEDS_HUMAN', reason: 'HISTORICAL_BLOCKING_ISSUE_OPEN' },
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'HUMAN_REVIEW', summary: '仍有未进入修订计划的历史阻断问题，需要人工复核。' },
        })
      }
      return {
        step: updatedStep,
        review,
        passed: reviewPassed && !policyAcceptedForDelivery,
        replayed: false,
      }
    })
  }

  private async failBeforeStart(run: RunRecord, errorCode: string): Promise<DeckReviewResult> {
    const idempotencyKey = deckReviewStepKey(run)
    const inputHash = hashInput({ tool: 'review_deck', errorCode, revisionRound: run.revisionRound })
    const prepared = await this.prepare(run, idempotencyKey, inputHash)
    if (prepared) return prepared
    return this.fail(run, idempotencyKey, {
      errorCode,
      providerAttempt: 0,
      maxProviderAttempts: MAX_DECK_REVIEW_ATTEMPTS,
      contractAttempt: 0,
      maxContractAttempts: MAX_DECK_REVIEW_CONTRACT_ATTEMPTS,
      model: null,
      requestId: null,
    })
  }

  private async fail(run: RunRecord, idempotencyKey: string, diagnostic: DeckReviewFailure): Promise<DeckReviewResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') {
        const persisted = deckReviewSchema.parse(step.output)
        return {
          step,
          review: persisted,
          passed: passesDeckQuality(persisted) && !hasOpenQualityIssues(transaction.listEvents()),
          replayed: true,
        }
      }
      if (step.status === 'FAILED') return { step, review: null, passed: false, replayed: true }
      if (step.status !== 'RUNNING') throw new Error('DECK_REVIEW_STEP_STATE_INVALID')
      const now = this.dependencies.clock.now().toISOString()
      const fromStatus = transaction.run.status
      const transitionRequired = fromStatus !== 'NEEDS_HUMAN'
      const v4TechnicalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4' && isTechnicalFailureCode(diagnostic.errorCode)
      const policy = transitionRequired && !v4TechnicalFailure ? transitionRun(transaction.run, 'NEEDS_HUMAN') : transaction.run
      const updatedStep: StepRecord = {
        ...step,
        status: v4TechnicalFailure ? 'RUNNING' : 'FAILED',
        errorCode: diagnostic.errorCode,
        output: { diagnostic },
        updatedAt: now,
      }
      transaction.putStep(updatedStep)
      if (transitionRequired && !v4TechnicalFailure) transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
      const technicalRecovery = v4TechnicalFailure
        ? beginTechnicalRecovery(transaction, this.dependencies.clock, diagnostic.errorCode)
        : null
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode: diagnostic.errorCode, retryable: technicalRecovery?.technicalRecovery?.retryable ?? false },
      })
      if (technicalRecovery) {
        appendV4LifecycleEvent(transaction, 'deck_review.completed', {
          completed: 0,
          total: 1,
          pageNumbers: allPageNumbers(transaction.run),
          reason: 'DECK_REVIEW_FAILED',
          retryable: technicalRecovery.technicalRecovery?.retryable ?? false,
        })
      } else if (transitionRequired) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: fromStatus, to: 'NEEDS_HUMAN', reason: diagnostic.errorCode },
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.required',
          payload: { kind: 'HUMAN_REVIEW', summary: '整套课件审查失败，需要人工处理后重试。' },
        })
        appendV4LifecycleEvent(transaction, 'deck_review.completed', {
          completed: 0,
          total: 1,
          pageNumbers: allPageNumbers(transaction.run),
          reason: 'DECK_REVIEW_FAILED',
          retryable: false,
          requiresUserAction: true,
          nextAction: 'REVIEW_RESULT',
        })
      }
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

function deckReviewContractInvalid(error: unknown) {
  if (error instanceof ZodError) return true
  if (error instanceof StructuredModelError) return error.code === 'MODEL_JSON_INVALID'
  return error instanceof Error && [
    'DECK_REVIEW_SOURCE_COVERAGE_INCOMPLETE',
    'DECK_REVIEW_SOURCE_REFERENCE_INVALID',
    'DECK_REVIEW_SLIDE_REFERENCE_INVALID',
    'REVISION_PLAN_OPERATION_BUDGET_EXCEEDED',
    'V4_REVISION_INSTRUCTION_BUDGET_EXCEEDED',
  ].includes(error.message)
}

function deckReviewContractAttemptKey(idempotencyKey: string, contractAttempt: number) {
  return contractAttempt === 0
    ? idempotencyKey
    : `deck-review-contract-repair-${hashInput({ idempotencyKey, contractAttempt })}`
}

function deckReviewFailure(
  error: unknown,
  providerAttempt: number,
  contractAttempt: number,
): DeckReviewFailure {
  if (error instanceof StructuredModelError) {
    return {
      errorCode: error.code,
      providerAttempt,
      maxProviderAttempts: MAX_DECK_REVIEW_ATTEMPTS,
      contractAttempt,
      maxContractAttempts: MAX_DECK_REVIEW_CONTRACT_ATTEMPTS,
      model: error.model,
      requestId: error.requestId,
    }
  }
  return {
    errorCode: error instanceof ZodError
      ? 'MODEL_JSON_INVALID'
      : error instanceof Error && /^[A-Z][A-Z0-9_]{2,99}$/.test(error.message)
        ? error.message
        : 'DECK_REVIEW_FAILED',
    providerAttempt,
    maxProviderAttempts: MAX_DECK_REVIEW_ATTEMPTS,
    contractAttempt,
    maxContractAttempts: MAX_DECK_REVIEW_CONTRACT_ATTEMPTS,
    model: null,
    requestId: null,
  }
}

export function deckReviewStepKey(run: Pick<RunRecord, 'id' | 'revisionRound'>) {
  return `${run.id}:deck-review:r${run.revisionRound}`
}

export function passesDeckQuality(review: DeckReview) {
  return review.qualityScore >= DECK_QUALITY_THRESHOLD
    && review.issues.length === 0
}

function hasOpenBlockingIssues(events: readonly AgentEvent[]) {
  return openQualityIssues(events).some(isHardQualityIssue)
}

function hasOpenQualityIssues(events: readonly AgentEvent[]) {
  return openQualityIssues(events).length > 0
}

function openQualityIssues(events: readonly AgentEvent[]) {
  const open = new Map<string, ReturnType<typeof issueSummarySchema.parse>>()
  for (const event of events) {
    if (event.type === 'issue.detected') {
      const issue = issueSummarySchema.safeParse(event.payload)
      if (issue.success) open.set(issue.data.id, issue.data)
    }
    if (event.type === 'issue.resolved') {
      const issueId = event.payload && typeof event.payload === 'object'
        ? (event.payload as { issueId?: unknown }).issueId
        : null
      if (typeof issueId === 'string') open.delete(issueId)
    }
  }
  return [...open.values()]
}

function successfulV4RevisionRounds(events: readonly AgentEvent[]) {
  const rounds = new Set<number>()
  for (const rawEvent of events) {
    const event = agentEventSchema.safeParse(rawEvent)
    if (!event.success || event.data.type !== 'revision.completed'
      || !event.data.payload || typeof event.data.payload !== 'object') continue
    const payload = event.data.payload as Record<string, unknown>
    if (Number.isSafeInteger(payload.revisionRound) && (payload.revisionRound as number) > 0
      && Number.isSafeInteger(payload.total) && (payload.total as number) > 0
      && payload.completed === payload.total && payload.reason === null) {
      rounds.add(payload.revisionRound as number)
    }
  }
  return rounds
}

import { CONTRACT_VERSION } from '../contracts'
import { ZodError } from 'zod'
import {
  blueprintDraftSchema,
  presentationBlueprintSchema,
  revisionPlanSchema,
  type BlueprintDraft,
  type PresentationBlueprint,
  type RevisionPlan,
} from '../presentation-contracts'
import {
  visualDeckV4ProposalDraftSchema,
  visualDeckV4RevisionApplicationResultSchema,
  visualDeckV4ReviewManuscriptSchema,
  isV4ManuscriptContextTooLargeError,
  V4_MANUSCRIPT_CONTEXT_TOO_LARGE,
  type VisualDeckV4ProposalDraft,
  type VisualDeckV4RevisionApplicationResult,
} from '../visual-deck-v4-contracts'
import { getActiveBlueprint, revisionBlueprintStepKey } from './active-blueprint'
import { hashInput } from './hash'
import type {
  AgentRepository,
  ClockPort,
  DocumentPort,
  RevisionApplicationPort,
  RunRecord,
  SourceChunk,
  StepRecord,
  ContractRepairIssue,
} from './ports'
import { StructuredModelError } from './ports'
import { transitionRun } from './policy'
import { beginTechnicalRecovery, isTechnicalFailureCode, technicalFailureDisposition } from './technical-recovery'
import {
  MAX_REVISION_CONTRACT_ATTEMPTS,
  revisionContractAttemptKey,
  revisionContractRepairIssues,
} from './revision-contract-repair'
import { revisionPlanStepKey } from './revision-planning-runner'
import {
  createVisualDeckV4BlueprintFromProposal,
} from './visual-deck-v4-planner'
import { ManuscriptCompiler, V4ManuscriptCompilationError } from './v4-manuscript-compiler'
import {
  isSupportedVisualDeckV4CompilerVersion,
  VISUAL_DECK_V4_COMPILER_VERSION,
  usesPatchRevisionContract,
} from '../release-identity'
import {
  allPageNumbers,
  appendV4LifecycleEvent,
  failVisualDeckV4Transaction,
  revisionDetails,
} from './v4-lifecycle'
import { requireV4StructuredGenerationProtocol, v4ModelOverride } from './v4-model-policy'
import { requirePersistedV4EvidenceWindow } from './v4-evidence-window-compiler'

export type RevisionApplicationResult = Readonly<{
  status: RunRecord['status']
  step: StepRecord
  blueprint: PresentationBlueprint | null
  requiresMedia: boolean
  replayed: boolean
}>

const MAX_REVISION_APPLICATION_PROVIDER_ATTEMPTS = 5
const REVISION_APPLICATION_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000] as const
const V4_MANUSCRIPT_SEMANTIC_INVALID = 'V4_MANUSCRIPT_SEMANTIC_INVALID'

type RevisionApplicationFailure = Readonly<{
  errorCode: string
  terminalCode?: 'CONTRACT_REPAIR_EXHAUSTED'
  diagnosticCode: string
  providerAttempt: number
  maxProviderAttempts: number
  contractAttempt: number
  maxContractAttempts: number
  model: string | null
  requestId: string | null
}>

class RevisionApplicationExecutionError extends Error {
  constructor(readonly diagnostic: RevisionApplicationFailure) {
    super(diagnostic.errorCode)
    this.name = 'RevisionApplicationExecutionError'
  }
}

export class RevisionApplicationRunner {
  private readonly inFlight = new Map<string, Promise<RevisionApplicationResult>>()

  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    documents: DocumentPort
    application: RevisionApplicationPort
    clock: ClockPort
    sleep?: (milliseconds: number) => Promise<void>
  }>) {}

  apply(runId: string): Promise<RevisionApplicationResult> {
    const existing = this.inFlight.get(runId)
    if (existing) return existing
    const pending = this.applyOnce(runId).finally(() => {
      if (this.inFlight.get(runId) === pending) this.inFlight.delete(runId)
    })
    this.inFlight.set(runId, pending)
    return pending
  }

  private async applyOnce(runId: string): Promise<RevisionApplicationResult> {
    const run = await this.requireRun(runId)
    if (run.revisionRound < 1) throw new Error('REVISION_ROUND_NOT_STARTED')
    const base = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound - 1)
    const plan = await this.requirePlan(run)
    let document: Awaited<ReturnType<DocumentPort['resolve']>>
    try {
      document = await this.dependencies.documents.resolve({ host: run.host, source: run.source })
      if (!document.isComplete) throw new Error('SOURCE_INCOMPLETE')
    } catch (error) {
      return this.failBeforeApply(run, error instanceof Error ? error.message : 'REVISION_INPUT_FAILED')
    }
    const compilerVersion = base.visualDeckV4Proposal?.compilerVersion
    const chain4Manuscript = base.renderMode === 'VISUAL_DECK_V4'
      && compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION
    const requiresSemanticModel = !(
      base.renderMode === 'VISUAL_DECK_V4'
      && plan.operations.every((operation) => operation.kind === 'REGENERATE_IMAGE')
    )
    let modelDocument = document
    if (chain4Manuscript && requiresSemanticModel) {
      try {
        requireV4StructuredGenerationProtocol(run, compilerVersion)
        modelDocument = {
          ...document,
          chunks: requirePersistedV4EvidenceWindow({
            run,
            document,
            steps: await this.dependencies.repository.listSteps(run.id),
          }).chunks,
        }
      } catch (error) {
        return this.failBeforeApply(run, error instanceof Error ? error.message : 'REVISION_INPUT_FAILED')
      }
    }
    const sourceChunks = modelDocument.chunks
    const idempotencyKey = revisionBlueprintStepKey(run.id, run.revisionRound)
    const inputHash = hashInput({
      tool: 'apply_revision',
      base,
      plan,
      sourceChunks: sourceChunks.map(({ id, sha256 }) => ({ id, sha256 })),
    })
    const prepared = await this.prepare(run, idempotencyKey, inputHash, plan)
    if (prepared) return prepared

    try {
      if (base.renderMode === 'VISUAL_DECK_V4') {
        requireV4StructuredGenerationProtocol(run, compilerVersion)
      }
      if (base.renderMode === 'VISUAL_DECK_V4'
        && !isSupportedVisualDeckV4CompilerVersion(compilerVersion ?? '')) {
        throw new Error('VISUAL_DECK_V4_COMPILER_UNSUPPORTED')
      }
      if (base.renderMode === 'VISUAL_DECK_V4'
        && plan.operations.every((operation) => operation.kind === 'REGENERATE_IMAGE')) {
        const slideIds = new Set(base.slides.map((slide) => `${run.id}:slide:${slide.pageNumber}`))
        if (plan.operations.some((operation) => !slideIds.has(operation.slideId))) {
          throw new Error('REVISION_PLAN_SLIDE_REFERENCE_INVALID')
        }
        const blueprint = presentationBlueprintSchema.parse({
          ...base,
          id: `${run.id}:blueprint:r${run.revisionRound}`,
          createdAt: this.dependencies.clock.now().toISOString(),
        })
        return this.complete(run, idempotencyKey, blueprint, plan)
      }
      const blueprint = await this.applyWithContractRepair({
        run,
        base,
        plan,
        document,
        modelDocument,
        idempotencyKey,
      })
      return this.complete(run, idempotencyKey, blueprint, plan)
    } catch (error) {
      const diagnostic = error instanceof RevisionApplicationExecutionError
        ? error.diagnostic
        : revisionApplicationFailure(error, 1, 1)
      return this.fail(run, idempotencyKey, diagnostic, plan)
    }
  }

  private async applyWithContractRepair(input: Readonly<{
    run: RunRecord
    base: PresentationBlueprint
    plan: RevisionPlan
    document: Awaited<ReturnType<DocumentPort['resolve']>>
    modelDocument: Awaited<ReturnType<DocumentPort['resolve']>>
    idempotencyKey: string
  }>) {
    let contractRepairIssues: readonly ContractRepairIssue[] | undefined
    let contentSlotCompletion = false
    let sourceEvidenceDisambiguation = false
    let lastError: unknown = new Error('REVISION_APPLICATION_FAILED')
    const compilerVersion = input.base.visualDeckV4Proposal?.compilerVersion
    const chain4 = compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION
    const modelOverride = v4ModelOverride(input.run, 'TEXT', compilerVersion)
    const structuredGenerationProtocol = requireV4StructuredGenerationProtocol(input.run, compilerVersion)
    for (let contractAttempt = 0; contractAttempt < MAX_REVISION_CONTRACT_ATTEMPTS; contractAttempt += 1) {
      for (let providerAttempt = 1;
        providerAttempt <= MAX_REVISION_APPLICATION_PROVIDER_ATTEMPTS;
        providerAttempt += 1) {
        try {
          const raw = await this.dependencies.application.apply({
            tenantId: input.run.host.tenantId,
            blueprint: input.base,
            plan: input.plan,
            sourceChunks: input.modelDocument.chunks,
            idempotencyKey: revisionContractAttemptKey(input.idempotencyKey, contractAttempt),
            ...(modelOverride ? { modelOverride } : {}),
            ...(chain4
              ? {
                  ...(contentSlotCompletion ? { contentSlotCompletion: true } : {}),
                  ...(sourceEvidenceDisambiguation ? { sourceEvidenceDisambiguation: true } : {}),
                }
              : (contractRepairIssues ? { contractRepairIssues } : {})),
            ...(structuredGenerationProtocol ? { structuredGenerationProtocol } : {}),
          })
          if (input.base.renderMode === 'VISUAL_DECK_V4') {
            const compilerVersion = input.base.visualDeckV4Proposal?.compilerVersion
            const draft = compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION
              ? new ManuscriptCompiler().compileRevision({
                  compilerInput: {
                    runId: input.run.id,
                    inputHash: hashInput({ baseId: input.base.id, plan: input.plan }),
                    source: input.run.source,
                    document: input.modelDocument,
                    config: input.run.visualDeckV4!,
                    slideCount: input.run.slideCount,
                    visualDirection: input.run.visualDirection,
                    ...(input.run.targetAudience ? { targetAudience: input.run.targetAudience } : {}),
                    ...(input.run.presentationGoal ? { presentationGoal: input.run.presentationGoal } : {}),
                    compilerVersion,
                    createdAt: this.dependencies.clock.now().toISOString(),
                  },
                  base: (() => {
                    const { compilerVersion: _version, ...draft } = input.base.visualDeckV4Proposal!
                    return draft
                  })(),
                  plan: input.plan,
                  manuscript: visualDeckV4ReviewManuscriptSchema.parse(raw),
                })
              : usesPatchRevisionContract(compilerVersion ?? '')
                ? this.mergeV4RevisionPatches(
                  input.run.id,
                  input.base,
                  input.plan,
                  visualDeckV4RevisionApplicationResultSchema.parse(raw),
                )
                : visualDeckV4ProposalDraftSchema.parse(raw)
            const blueprintDocument = compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION
              ? input.modelDocument
              : input.document
            const blueprint = this.compileV4Revision(input.run, input.base, input.plan, blueprintDocument, draft)
            this.validateV4Revision(input.run.id, input.base, blueprint, input.plan)
            return blueprint
          }
          const draft = inheritSourceLineage(input.base, blueprintDraftSchema.parse(raw))
          this.validateRevision(input.run.id, input.base, draft, input.plan, input.document.chunks)
          return presentationBlueprintSchema.parse({
            ...draft,
            id: `${input.run.id}:blueprint:r${input.run.revisionRound}`,
            visualDirection: input.base.visualDirection,
            ...(input.base.renderMode ? { renderMode: input.base.renderMode } : {}),
            ...(input.base.coverDesignMode ? { coverDesignMode: input.base.coverDesignMode } : {}),
            sourceManifest: input.base.sourceManifest,
            sourceAssets: input.base.sourceAssets,
            createdAt: this.dependencies.clock.now().toISOString(),
          })
        } catch (error) {
          lastError = error
          const providerRetryable = error instanceof StructuredModelError
            && error.retryable
            && error.code !== 'MODEL_JSON_INVALID'
          if (providerRetryable) {
            if (providerAttempt === MAX_REVISION_APPLICATION_PROVIDER_ATTEMPTS) {
              throw new RevisionApplicationExecutionError(
                revisionApplicationFailure(error, providerAttempt, contractAttempt + 1),
              )
            }
            await (this.dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
              REVISION_APPLICATION_RETRY_DELAYS_MS[providerAttempt - 1]
                ?? REVISION_APPLICATION_RETRY_DELAYS_MS.at(-1)!,
            )
            continue
          }
          const sourceEvidenceAmbiguous = chain4
            && error instanceof Error
            && error.message === 'V4_MANUSCRIPT_SOURCE_EVIDENCE_AMBIGUOUS'
          const semanticManuscriptFailure = chain4 && isV4SemanticManuscriptFailure(error)
          const issues = chain4 && !semanticManuscriptFailure
            ? null
            : revisionContractRepairIssues(error)
          if (!issues || contractAttempt + 1 >= MAX_REVISION_CONTRACT_ATTEMPTS) {
            throw new RevisionApplicationExecutionError(
              revisionApplicationFailure(
                error,
                providerAttempt,
                contractAttempt + 1,
                semanticManuscriptFailure && contractAttempt + 1 >= MAX_REVISION_CONTRACT_ATTEMPTS,
              ),
            )
          }
          if (chain4) {
            contentSlotCompletion = true
            if (sourceEvidenceAmbiguous) sourceEvidenceDisambiguation = true
          } else contractRepairIssues = issues
          break
        }
      }
    }
    throw new RevisionApplicationExecutionError(
      revisionApplicationFailure(lastError, 1, MAX_REVISION_CONTRACT_ATTEMPTS),
    )
  }

  private compileV4Revision(
    run: RunRecord,
    base: PresentationBlueprint,
    plan: RevisionPlan,
    document: Awaited<ReturnType<DocumentPort['resolve']>>,
    draft: VisualDeckV4ProposalDraft,
  ) {
    if (!run.visualDeckV4) throw new Error('VISUAL_DECK_V4_CONFIG_MISSING')
    return createVisualDeckV4BlueprintFromProposal({
      runId: run.id,
      inputHash: hashInput({ baseId: base.id, plan, draft }),
      source: run.source,
      document,
      config: run.visualDeckV4,
      slideCount: run.slideCount,
      visualDirection: run.visualDirection,
      ...(run.targetAudience ? { targetAudience: run.targetAudience } : {}),
      ...(run.presentationGoal ? { presentationGoal: run.presentationGoal } : {}),
      compilerVersion: base.visualDeckV4Proposal!.compilerVersion,
      createdAt: this.dependencies.clock.now().toISOString(),
    }, draft)
  }

  private async prepare(run: RunRecord, key: string, inputHash: string, plan: RevisionPlan) {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const existing = transaction.getStep(key)
      if (existing) {
        if (existing.inputHash !== inputHash || existing.tool !== 'apply_revision') throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        if (existing.status === 'COMPLETED') {
          const blueprint = presentationBlueprintSchema.parse(existing.output)
          return {
            status: transaction.run.status,
            step: existing,
            blueprint,
            requiresMedia: requiresRevisionMedia(plan, blueprint),
            replayed: true,
          }
        }
        if (existing.status === 'FAILED') {
          return { status: transaction.run.status, step: existing, blueprint: null, requiresMedia: false, replayed: true }
        }
        if (existing.status === 'RUNNING') return null
        throw new Error('REVISION_APPLICATION_STEP_STATE_INVALID')
      }
      if (transaction.run.status !== 'REVISING') throw new Error('RUN_NOT_REVISING')
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: `step-${run.id}-apply-revision-r${run.revisionRound}`,
        runId: run.id,
        idempotencyKey: key,
        inputHash,
        tool: 'apply_revision',
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
        payload: { stepId: step.id, tool: step.tool, label: `执行第 ${run.revisionRound} 轮局部修订` },
      })
      const details = revisionDetails(plan)
      appendV4LifecycleEvent(transaction, 'revision.started', {
        completed: 0,
        total: details.pageNumbers.length,
        ...details,
      })
      return null
    })
  }

  private async complete(
    run: RunRecord,
    key: string,
    blueprint: PresentationBlueprint,
    plan: RevisionPlan,
  ): Promise<RevisionApplicationResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(key)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') {
        const persisted = presentationBlueprintSchema.parse(step.output)
        return {
          status: transaction.run.status,
          step,
          blueprint: persisted,
          requiresMedia: requiresRevisionMedia(plan, persisted),
          replayed: true,
        }
      }
      if (step.status === 'FAILED') {
        return { status: transaction.run.status, step, blueprint: null, requiresMedia: false, replayed: true }
      }
      if (step.status !== 'RUNNING') throw new Error('REVISION_APPLICATION_STEP_STATE_INVALID')
      const now = this.dependencies.clock.now().toISOString()
      const requiresMedia = requiresRevisionMedia(plan, blueprint)
      const policy = requiresMedia ? transaction.run : transitionRun(transaction.run, 'DECK_REVIEW')
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updatedStep: StepRecord = { ...step, status: 'COMPLETED', output: blueprint, errorCode: null, updatedAt: now }
      transaction.putStep(updatedStep)
      transaction.putRun(updatedRun)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: step.id, summary: `已按计划更新 ${new Set(plan.operations.map((item) => item.slideId)).size} 页` },
      })
      if (!requiresMedia) {
        const details = revisionDetails(plan)
        appendV4LifecycleEvent(transaction, 'revision.completed', {
          completed: details.pageNumbers.length,
          total: details.pageNumbers.length,
          ...details,
        })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'REVISING', to: 'DECK_REVIEW' },
        })
        appendV4LifecycleEvent(transaction, 'deck_review.started', {
          completed: 0,
          total: 1,
          pageNumbers: allPageNumbers(transaction.run),
        })
      }
      return { status: updatedRun.status, step: updatedStep, blueprint, requiresMedia, replayed: false }
    })
  }

  private async failBeforeApply(run: RunRecord, errorCode: string): Promise<RevisionApplicationResult> {
    const key = revisionBlueprintStepKey(run.id, run.revisionRound)
    const inputHash = hashInput({ tool: 'apply_revision', revisionRound: run.revisionRound, errorCode })
    const plan = await this.requirePlan(run)
    const prepared = await this.prepare(run, key, inputHash, plan)
    return prepared ?? this.fail(run, key, revisionApplicationFailure(new Error(errorCode), 0, 0), plan)
  }

  private async fail(
    run: RunRecord,
    key: string,
    diagnostic: RevisionApplicationFailure,
    plan: RevisionPlan,
  ): Promise<RevisionApplicationResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(key)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') {
        const persisted = presentationBlueprintSchema.parse(step.output)
        return {
          status: transaction.run.status,
          step,
          blueprint: persisted,
          requiresMedia: requiresRevisionMedia(plan, persisted),
          replayed: true,
        }
      }
      if (step.status === 'FAILED') {
        return { status: transaction.run.status, step, blueprint: null, requiresMedia: false, replayed: true }
      }
      if (step.status !== 'RUNNING') throw new Error('REVISION_APPLICATION_STEP_STATE_INVALID')
      const now = this.dependencies.clock.now().toISOString()
      const terminalSemanticManuscriptFailure = diagnostic.terminalCode === 'CONTRACT_REPAIR_EXHAUSTED'
        && diagnostic.diagnosticCode === V4_MANUSCRIPT_SEMANTIC_INVALID
      const v4TechnicalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4'
        && !terminalSemanticManuscriptFailure
        && isTechnicalFailureCode(diagnostic.errorCode)
      const v4InternalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4'
        && !terminalSemanticManuscriptFailure
        && !v4TechnicalFailure
      const policy = v4TechnicalFailure || v4InternalFailure
        ? transaction.run
        : transitionRun(transaction.run, 'NEEDS_HUMAN')
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updatedStep: StepRecord = {
        ...step,
        status: v4TechnicalFailure ? 'RUNNING' : 'FAILED',
        errorCode: diagnostic.errorCode,
        output: { diagnostic },
        updatedAt: now,
      }
      transaction.putStep(updatedStep)
      if (!v4TechnicalFailure && !v4InternalFailure) transaction.putRun(updatedRun)
      const technicalRecovery = v4TechnicalFailure
        ? beginTechnicalRecovery(transaction, this.dependencies.clock, diagnostic.errorCode)
        : null
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode: diagnostic.errorCode, retryable: technicalRecovery?.technicalRecovery?.retryable ?? false },
      })
      if (technicalRecovery) {
        const details = revisionDetails(plan)
        appendV4LifecycleEvent(transaction, 'revision.completed', {
          completed: 0,
          total: details.pageNumbers.length,
          ...details,
          reason: 'REVISION_FAILED',
          retryable: technicalRecovery.technicalRecovery?.retryable ?? false,
        })
        return { status: transaction.run.status, step: updatedStep, blueprint: null, requiresMedia: requiresRevisionMedia(plan), replayed: false }
      }
      if (v4InternalFailure) {
        failVisualDeckV4Transaction({
          transaction,
          clock: this.dependencies.clock,
          errorCode: 'QUALITY_REMEDIATION_EXHAUSTED',
          reason: 'REVISION_FAILED',
        })
        return {
          status: transaction.run.status,
          step: updatedStep,
          blueprint: null,
          requiresMedia: false,
          replayed: false,
        }
      }
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'REVISING', to: 'NEEDS_HUMAN', reason: diagnostic.errorCode },
      })
      const details = revisionDetails(plan)
      appendV4LifecycleEvent(transaction, 'revision.completed', {
        completed: 0,
        total: details.pageNumbers.length,
        ...details,
        reason: 'REVISION_FAILED',
        retryable: false,
        requiresUserAction: true,
        nextAction: 'REVIEW_RESULT',
      })
      return { status: updatedRun.status, step: updatedStep, blueprint: null, requiresMedia: requiresRevisionMedia(plan), replayed: false }
    })
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }

  private async requirePlan(run: RunRecord) {
    const step = (await this.dependencies.repository.listSteps(run.id))
      .find((candidate) => candidate.idempotencyKey === revisionPlanStepKey(run.id, run.revisionRound)
        && candidate.status === 'COMPLETED')
    if (!step) throw new Error('REVISION_PLAN_NOT_READY')
    const plan = revisionPlanSchema.parse(step.output)
    if (plan.revisionRound !== run.revisionRound) throw new Error('REVISION_PLAN_ROUND_MISMATCH')
    return plan
  }

  private validateRevision(
    runId: string,
    base: PresentationBlueprint,
    draft: BlueprintDraft,
    plan: RevisionPlan,
    chunks: readonly SourceChunk[],
  ) {
    if (draft.title !== base.title || JSON.stringify(draft.curriculum) !== JSON.stringify(base.curriculum)) {
      throw new Error('REVISION_SCOPE_VIOLATION')
    }
    const operationsBySlide = new Map<string, RevisionPlan['operations'][number][]>()
    for (const operation of plan.operations) {
      const list = operationsBySlide.get(operation.slideId) ?? []
      list.push(operation)
      operationsBySlide.set(operation.slideId, list)
    }
    const sourceIds = new Set(chunks.map((chunk) => chunk.id))
    for (const [index, revised] of draft.slides.entries()) {
      const previous = base.slides[index]!
      const operations = operationsBySlide.get(`${runId}:slide:${revised.pageNumber}`) ?? []
      if (operations.length === 0) {
        if (JSON.stringify(revised) !== JSON.stringify(previous)) throw new Error('REVISION_SCOPE_VIOLATION')
        continue
      }
      const kinds = new Set(operations.map((operation) => operation.kind))
      if (!kinds.has('UPDATE_CONTENT') && (revised.title !== previous.title
        || JSON.stringify(revised.body) !== JSON.stringify(previous.body)
        || JSON.stringify(revised.sourceChunkIds) !== JSON.stringify(previous.sourceChunkIds))) {
        throw new Error('REVISION_SCOPE_VIOLATION')
      }
      if (!kinds.has('RELAYOUT') && revised.layout !== previous.layout) throw new Error('REVISION_SCOPE_VIOLATION')
      if (!kinds.has('RELAYOUT') && !kinds.has('REGENERATE_IMAGE')
        && (revised.visualIntent !== previous.visualIntent || revised.visualPrompt !== previous.visualPrompt)) {
        throw new Error('REVISION_SCOPE_VIOLATION')
      }
      if (revised.sourceChunkIds.some((id) => !sourceIds.has(id))) throw new Error('REVISION_SOURCE_REFERENCE_INVALID')
      const contentSourceChunkIds = new Set(operations
        .filter((operation) => operation.kind === 'UPDATE_CONTENT')
        .flatMap((operation) => operation.sourceChunkIds))
      if (kinds.has('UPDATE_CONTENT')) {
        validatePreservedSourceLineage(previous.sourceChunkIds, revised.sourceChunkIds, contentSourceChunkIds)
      }
      validateLayeredRevisionScope(previous, revised, operations)
    }
  }

  private mergeV4RevisionPatches(
    runId: string,
    base: PresentationBlueprint,
    plan: RevisionPlan,
    result: VisualDeckV4RevisionApplicationResult,
  ): VisualDeckV4ProposalDraft {
    const proposal = base.visualDeckV4Proposal
    if (!proposal) throw new Error('VISUAL_DECK_V4_PROPOSAL_MISSING')
    const briefBySlideId = new Map(proposal.slideBriefs.map((brief) => [
      `${runId}:slide:${brief.pageNumber}`,
      brief,
    ]))
    const operationsByPage = new Map<number, RevisionPlan['operations'][number][]>()
    for (const operation of plan.operations) {
      const brief = briefBySlideId.get(operation.slideId)
      if (!brief) throw new Error('REVISION_PATCH_SCOPE_INVALID')
      const operations = operationsByPage.get(brief.pageNumber) ?? []
      operations.push(operation)
      operationsByPage.set(brief.pageNumber, operations)
    }

    const expectedOwner = new Map<number, 'CONTENT' | 'LAYOUT'>()
    for (const [pageNumber, operations] of operationsByPage) {
      const kinds = new Set(operations.map((operation) => operation.kind))
      if (kinds.has('UPDATE_CONTENT')) expectedOwner.set(pageNumber, 'CONTENT')
      else if (kinds.has('RELAYOUT')) expectedOwner.set(pageNumber, 'LAYOUT')
    }
    const contentByPage = new Map(result.contentPatches.map((patch) => [patch.pageNumber, patch]))
    const layoutByPage = new Map(result.layoutPatches.map((patch) => [patch.pageNumber, patch]))
    const redrawOnly = new Set(result.redrawOnlyPageNumbers)
    const returnedPages = new Set([...contentByPage.keys(), ...layoutByPage.keys(), ...redrawOnly])
    if (returnedPages.size !== expectedOwner.size) throw new Error('REVISION_PATCH_SCOPE_INVALID')
    for (const [pageNumber, owner] of expectedOwner) {
      const matches = Number(contentByPage.has(pageNumber))
        + Number(layoutByPage.has(pageNumber))
        + Number(redrawOnly.has(pageNumber))
      if (matches !== 1
        || (owner === 'CONTENT' && layoutByPage.has(pageNumber))
        || (owner === 'LAYOUT' && contentByPage.has(pageNumber))) {
        throw new Error('REVISION_PATCH_SCOPE_INVALID')
      }
    }
    if ([...returnedPages].some((pageNumber) => !expectedOwner.has(pageNumber))) {
      throw new Error('REVISION_PATCH_SCOPE_INVALID')
    }

    const slideBriefs = proposal.slideBriefs.map((brief) => {
      const patch = contentByPage.get(brief.pageNumber) ?? layoutByPage.get(brief.pageNumber)
      if (!patch) return structuredClone(brief)
      const revised = { ...structuredClone(brief), ...structuredClone(patch) }
      if (sameV4RevisionBrief(revised, brief)) throw new Error('REVISION_PATCH_NOOP')
      return revised
    })
    const { compilerVersion: _compilerVersion, ...draft } = structuredClone(proposal)
    return visualDeckV4ProposalDraftSchema.parse({ ...draft, slideBriefs })
  }

  private validateV4Revision(
    runId: string,
    base: PresentationBlueprint,
    revised: PresentationBlueprint,
    plan: RevisionPlan,
  ) {
    const before = base.visualDeckV4Proposal
    const after = revised.visualDeckV4Proposal
    if (!before || !after) throw new Error('VISUAL_DECK_V4_PROPOSAL_MISSING')
    for (const field of ['sourceUnderstanding', 'presentationSpec', 'deckPlan', 'visualContract'] as const) {
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) throw new Error('REVISION_SCOPE_VIOLATION')
    }
    if (base.title !== revised.title || JSON.stringify(base.curriculum) !== JSON.stringify(revised.curriculum)) {
      throw new Error('REVISION_SCOPE_VIOLATION')
    }
    const operationsBySlide = new Map<string, RevisionPlan['operations'][number][]>()
    for (const operation of plan.operations) {
      const operations = operationsBySlide.get(operation.slideId) ?? []
      operations.push(operation)
      operationsBySlide.set(operation.slideId, operations)
    }
    for (const [index, nextBrief] of after.slideBriefs.entries()) {
      const previousBrief = before.slideBriefs[index]
      if (!previousBrief) throw new Error('REVISION_SCOPE_VIOLATION')
      const operations = operationsBySlide.get(`${runId}:slide:${nextBrief.pageNumber}`) ?? []
      if (operations.length === 0) {
        if (JSON.stringify(previousBrief) !== JSON.stringify(nextBrief)) throw new Error('REVISION_SCOPE_VIOLATION')
        continue
      }
      const kinds = new Set(operations.map((operation) => operation.kind))
      const contentOperations = operations.filter((operation) => operation.kind === 'UPDATE_CONTENT')
      const requiredSourceChunkIds = new Set(contentOperations.flatMap((operation) => operation.sourceChunkIds))
      if (contentOperations.length > 0) {
        if (before.presentationSpec.sourceMode === 'OPEN_KNOWLEDGE') {
          if (requiredSourceChunkIds.size > 0
            || JSON.stringify(previousBrief.sourceChunkIds) !== JSON.stringify(nextBrief.sourceChunkIds)) {
            throw new Error('REVISION_OPEN_KNOWLEDGE_SOURCE_FORBIDDEN')
          }
        } else {
          validatePreservedSourceLineage(
            previousBrief.sourceChunkIds,
            nextBrief.sourceChunkIds,
            requiredSourceChunkIds,
          )
        }
      }
      const previousComparable = structuredClone(previousBrief) as Record<string, unknown>
      const nextComparable = structuredClone(nextBrief) as Record<string, unknown>
      if (kinds.has('UPDATE_CONTENT')) {
        for (const field of ['title', 'keyClaim', 'audienceTakeaway', 'lockedCopy', 'facts', 'numbers', 'formulas', 'sourceChunkIds']) {
          delete previousComparable[field]
          delete nextComparable[field]
        }
      }
      if (kinds.has('UPDATE_CONTENT') || kinds.has('RELAYOUT')) {
        for (const field of ['visualMetaphor', 'composition', 'informationHierarchy', 'previousSlideRelation', 'nextSlideRelation']) {
          delete previousComparable[field]
          delete nextComparable[field]
        }
      }
      if (JSON.stringify(previousComparable) !== JSON.stringify(nextComparable)) {
        throw new Error('REVISION_SCOPE_VIOLATION')
      }
    }
  }
}

function sameV4RevisionBrief(
  left: VisualDeckV4ProposalDraft['slideBriefs'][number],
  right: VisualDeckV4ProposalDraft['slideBriefs'][number],
) {
  const normalized = (brief: VisualDeckV4ProposalDraft['slideBriefs'][number]) => ({
    ...brief,
    sourceChunkIds: [...brief.sourceChunkIds].sort(),
  })
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right))
}

function revisionApplicationFailure(
  error: unknown,
  providerAttempt: number,
  contractAttempt: number,
  terminalSemanticManuscriptFailure = false,
): RevisionApplicationFailure {
  const structured = error instanceof StructuredModelError ? error : null
  const manuscriptContextTooLarge = isV4ManuscriptContextTooLargeError(error)
  const semanticFailure = terminalSemanticManuscriptFailure && isV4SemanticManuscriptFailure(error)
  const message = error instanceof Error ? error.message : ''
  const technicalMessage = /^[A-Z][A-Z0-9_]{2,99}$/.test(message)
    && technicalFailureDisposition(message) === 'RETRYABLE'
  const diagnosticCode = semanticFailure
    ? V4_MANUSCRIPT_SEMANTIC_INVALID
    : structured?.code
      ?? (manuscriptContextTooLarge
        ? V4_MANUSCRIPT_CONTEXT_TOO_LARGE
        : technicalMessage
          ? message
          : /^[A-Z][A-Z0-9_]{2,99}$/.test(message)
            ? message
            : 'REVISION_APPLICATION_FAILED')
  return {
    errorCode: semanticFailure
      ? 'MODEL_JSON_INVALID'
      : structured?.code
        ?? (manuscriptContextTooLarge
          ? V4_MANUSCRIPT_CONTEXT_TOO_LARGE
          : error instanceof Error && ['V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE', 'V4_CHAIN4_PROTOCOL_UNSUPPORTED'].includes(error.message)
            ? error.message
            : technicalMessage
              ? 'PROVIDER_UNAVAILABLE'
              : 'REVISION_APPLICATION_FAILED'),
    ...(semanticFailure ? { terminalCode: 'CONTRACT_REPAIR_EXHAUSTED' as const } : {}),
    diagnosticCode,
    providerAttempt,
    maxProviderAttempts: MAX_REVISION_APPLICATION_PROVIDER_ATTEMPTS,
    contractAttempt,
    maxContractAttempts: MAX_REVISION_CONTRACT_ATTEMPTS,
    model: structured?.model ?? null,
    requestId: structured?.requestId ?? null,
  }
}

function isV4SemanticManuscriptFailure(error: unknown) {
  return error instanceof ZodError
    || (error instanceof StructuredModelError && error.code === 'MODEL_JSON_INVALID')
    || error instanceof V4ManuscriptCompilationError
}

function inheritSourceLineage(base: PresentationBlueprint, draft: BlueprintDraft): BlueprintDraft {
  return {
    ...draft,
    curriculum: {
      ...draft.curriculum,
      sourceAssetIds: draft.curriculum.sourceAssetIds ?? base.curriculum.sourceAssetIds,
    },
    slides: draft.slides.map((slide, index) => {
      const previous = base.slides[index]
      if (!previous) return slide
      return {
        ...slide,
        sourceAssetIds: slide.sourceAssetIds ?? previous.sourceAssetIds,
        ...(slide.layeredDesign && previous.layeredDesign ? {
          layeredDesign: {
            ...slide.layeredDesign,
            elements: slide.layeredDesign.elements.map((element) => {
              if (element.kind !== 'IMAGE' && element.kind !== 'TEXT') return element
              const before = previous.layeredDesign?.elements.find((candidate) => candidate.elementId === element.elementId)
              if (!before || before.kind !== element.kind) return element
              if (element.kind === 'IMAGE' && before.kind === 'IMAGE') {
                return {
                  ...element,
                  sourceAssetIds: element.sourceAssetIds ?? before.sourceAssetIds,
                  sourceAssetStrategy: element.sourceAssetStrategy ?? before.sourceAssetStrategy,
                }
              }
              return { ...element, sourceAssetIds: element.sourceAssetIds ?? before.sourceAssetIds }
            }),
          },
        } : {}),
      }
    }),
  }
}

function validateLayeredRevisionScope(
  previous: PresentationBlueprint['slides'][number],
  revised: BlueprintDraft['slides'][number],
  operations: RevisionPlan['operations'],
) {
  if (!previous.layeredDesign && !revised.layeredDesign) return
  if (!previous.layeredDesign || !revised.layeredDesign) throw new Error('REVISION_SCOPE_VIOLATION')
  if (previous.layeredDesign.designKind !== revised.layeredDesign.designKind
    || previous.layeredDesign.backgroundColor !== revised.layeredDesign.backgroundColor
    || previous.layeredDesign.elements.length !== revised.layeredDesign.elements.length) {
    throw new Error('REVISION_SCOPE_VIOLATION')
  }
  const kinds = new Set(operations.map((operation) => operation.kind))
  const regenerated = new Set(operations
    .filter((operation) => operation.kind === 'REGENERATE_IMAGE')
    .map((operation) => operation.targetElementId))
  const contentSourceChunkIds = new Set(operations
    .filter((operation) => operation.kind === 'UPDATE_CONTENT')
    .flatMap((operation) => operation.sourceChunkIds))
  for (const [index, next] of revised.layeredDesign.elements.entries()) {
    const before = previous.layeredDesign.elements[index]
    if (!before || before.elementId !== next.elementId || before.kind !== next.kind) {
      throw new Error('REVISION_SCOPE_VIOLATION')
    }
    const beforeComparable = structuredClone(before) as Record<string, unknown>
    const nextComparable = structuredClone(next) as Record<string, unknown>
    if (kinds.has('RELAYOUT')) {
      delete beforeComparable.placement
      delete beforeComparable.zIndex
      delete nextComparable.placement
      delete nextComparable.zIndex
    }
    if (kinds.has('UPDATE_CONTENT') && before.kind === 'TEXT' && next.kind === 'TEXT'
      && before.text !== next.text) {
      validatePreservedSourceLineage(before.sourceChunkIds, next.sourceChunkIds, contentSourceChunkIds)
      delete beforeComparable.text
      delete beforeComparable.sourceChunkIds
      delete nextComparable.text
      delete nextComparable.sourceChunkIds
    }
    if (regenerated.has(before.elementId) && before.kind === 'IMAGE' && next.kind === 'IMAGE') {
      delete beforeComparable.prompt
      delete beforeComparable.negativePrompt
      delete nextComparable.prompt
      delete nextComparable.negativePrompt
    }
    if (JSON.stringify(beforeComparable) !== JSON.stringify(nextComparable)) {
      throw new Error('REVISION_SCOPE_VIOLATION')
    }
  }
  if ([...regenerated].some((elementId) => !previous.layeredDesign!.elements
    .some((element) => element.kind === 'IMAGE' && element.elementId === elementId))) {
    throw new Error('REVISION_SCOPE_VIOLATION')
  }
}

function validatePreservedSourceLineage(
  previousSourceChunkIds: readonly string[],
  revisedSourceChunkIds: readonly string[],
  revisionSourceChunkIds: ReadonlySet<string>,
) {
  const required = new Set([...previousSourceChunkIds, ...revisionSourceChunkIds])
  if (revisedSourceChunkIds.length === 0
    || revisedSourceChunkIds.some((id) => !required.has(id))
    || [...required].some((id) => !revisedSourceChunkIds.includes(id))) {
    throw new Error('REVISION_SOURCE_REFERENCE_INVALID')
  }
}

export function requiresRevisionMedia(plan: RevisionPlan, blueprint?: PresentationBlueprint) {
  if (blueprint?.renderMode === 'VISUAL_DECK_V4') return plan.operations.length > 0
  if (blueprint?.renderMode === 'LAYERED_COURSEWARE_V3') {
    return plan.operations.some((operation) => operation.kind === 'REGENERATE_IMAGE')
  }
  return plan.operations.some((operation) => operation.kind === 'REGENERATE_IMAGE' || operation.kind === 'RELAYOUT')
}

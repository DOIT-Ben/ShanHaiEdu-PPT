import { createHash } from 'node:crypto'
import {
  CONTRACT_VERSION,
  MAX_PLANNING_RETRIES,
  createRunRequestSchema,
  runActionSchema,
  type HostContext,
  type RunAction,
} from '../contracts'
import { presentationBlueprintSchema, revisionPlanSchema } from '../presentation-contracts'
import { revisionBlueprintStepKey } from './active-blueprint'
import { deliveryStepKey } from './delivery-runner'
import {
  blueprintImageRequirements,
  controlledVisualDeckPageArtifact,
  latestCompletedAssetStep,
} from './blueprint-assets'
import { hashInput } from './hash'
import { planningStepKey } from './planning-runner'
import { getPresentationModeStrategy } from './presentation-mode-strategy'
import { V4_PLANNING_STAGE_COUNT } from './visual-deck-v4-planner'
import type {
  AgentRepository,
  AgentTransaction,
  ArtifactPort,
  ClockPort,
  ProviderBillingCatalogPort,
  RunListCursor,
  RunRecord,
  StepRecord,
} from './ports'
import { applyRunAction, PolicyError, recoverV4QualityFailure } from './policy'
import { revisionPlanStepKey } from './revision-planning-runner'
import { visualDeckV4RevisionInstructions } from './revision-instruction-memory'
import { buildIdentity, releaseIdentityForMode, type BuildIdentity } from '../release-identity'
import {
  usageAccountingProtocolSchema,
  type UsageAccountingProtocol,
} from '../usage-accounting-contracts'
import {
  accountingProtocolFor,
  enqueueUsageV2RunFinalization,
  isUsageV2RunFinalizationAcknowledged,
  usageV2FinalizeStepKey,
} from './usage-v2-coordinator'
import { deriveV4TerminalAccounting } from './v4-terminal-accounting'
import {
  allPageNumbers,
  activeRevisionLifecycle,
  appendV4LifecycleEvent,
  closeActiveV4LifecycleStages,
  isVisualDeckV4,
  revisionDetails,
  v4LifecyclePayload,
} from './v4-lifecycle'

const ADMIN_ONLY_CRITICAL_CATEGORIES = new Set([
  'CURRICULUM_GAP',
  'FACTUAL_RISK',
  'SOURCE_INCOMPLETE',
  'PLANNING_FAILED',
])

type QualityRecoveryArtifactProof = Readonly<{
  runId: string
  runVersion: number
  entries: readonly Readonly<{
    pageNumber: number
    stepKey: string
    artifactId: string
    sha256: string
    byteLength: number
    mimeType: string
  }>[]
}>

export class RunServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'RunServiceError'
  }
}

function owns(run: RunRecord, host: HostContext) {
  return run.host.tenantId === host.tenantId && run.host.externalUserId === host.externalUserId
}

export class RunService {
  private readonly defaultAccountingProtocol: UsageAccountingProtocol

  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    clock: ClockPort
    artifacts?: ArtifactPort
    buildIdentity?: BuildIdentity
    defaultAccountingProtocol?: UsageAccountingProtocol
    providerBillingCatalog?: ProviderBillingCatalogPort
  }>) {
    this.defaultAccountingProtocol = usageAccountingProtocolSchema.parse(
      dependencies.defaultAccountingProtocol ?? 'LEGACY_RESERVATION_V1',
    )
  }

  async create(request: unknown, idempotencyKey: string) {
    const parsed = createRunRequestSchema.safeParse(request)
    if (!parsed.success) throw new RunServiceError(422, 'VALIDATION_ERROR', 'run request is invalid')
    const key = idempotencyKey.trim()
    if (key.length < 8 || key.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      throw new RunServiceError(422, 'INVALID_IDEMPOTENCY_KEY', 'idempotency key is invalid')
    }

    const creationKey = hashInput({
      tenantId: parsed.data.host.tenantId,
      externalUserId: parsed.data.host.externalUserId,
      idempotencyKey: key,
    })
    const runId = `run-${creationKey.slice(0, 28)}`
    const requestHash = hashInput(parsed.data)
    const existing = await this.dependencies.repository.getRun(runId)
    if (existing) return this.replayOrConflict(existing, requestHash)

    const tenantSettings = await this.dependencies.repository.getTenantRevisionRoundsSettings(parsed.data.host.tenantId)
    const maxRevisionRounds = tenantSettings.isConfigured
      ? tenantSettings.maxRevisionRounds
      : parsed.data.maxRevisionRounds
    const now = this.dependencies.clock.now().toISOString()
    const accountingProtocol = parsed.data.host.tenantId === 'frameflow'
      && parsed.data.presentationMode === 'VISUAL_DECK_V4'
      ? this.defaultAccountingProtocol
      : 'LEGACY_RESERVATION_V1' as const
    if (accountingProtocol === 'FRAMEFLOW_USAGE_V2') {
      if (!this.dependencies.providerBillingCatalog) {
        throw new RunServiceError(
          503,
          'USAGE_V2_PROVIDER_BILLING_CATALOG_REQUIRED',
          'Usage V2 billing catalog is unavailable',
        )
      }
      try {
        this.dependencies.providerBillingCatalog.snapshot({
          model: parsed.data.imageModel,
          operationMode: 'TEXT_TO_IMAGE',
          resolution: '1K',
          aspectRatio: parsed.data.visualDeckV4!.deckOptions.aspectRatio,
        })
      } catch {
        throw new RunServiceError(
          503,
          'USAGE_V2_PROVIDER_BILLING_PROFILE_NOT_FOUND',
          'Usage V2 initial image billing profile is unavailable',
        )
      }
    }
    const run: RunRecord = {
      id: runId,
      creationKey,
      requestHash,
      host: parsed.data.host,
      source: parsed.data.source,
      slideCount: parsed.data.slideCount,
      visualDirection: parsed.data.visualDirection,
      ...(parsed.data.targetAudience ? { targetAudience: parsed.data.targetAudience } : {}),
      ...(parsed.data.presentationGoal ? { presentationGoal: parsed.data.presentationGoal } : {}),
      imageModel: parsed.data.imageModel,
      accountingProtocol,
      automationLevel: parsed.data.automationLevel,
      presentationMode: parsed.data.presentationMode,
      coverDesignMode: parsed.data.coverDesignMode,
      assetAcquisitionPolicy: parsed.data.assetAcquisitionPolicy,
      maxVisualAssetsPerSlide: parsed.data.maxVisualAssetsPerSlide,
      ...(parsed.data.visualDeckV4 ? { visualDeckV4: parsed.data.visualDeckV4 } : {}),
      release: releaseIdentityForMode(buildIdentity(this.dependencies.buildIdentity), parsed.data.presentationMode),
      maxRevisionRounds,
      revisionRound: 0,
      planningAttempt: 0,
      qualityScore: null,
      status: 'PLANNING',
      resumeState: null,
      version: 0,
      budgetUnits: parsed.data.budgetUnits,
      committedBudgetUnits: 0,
      qualityOverride: false,
      qualityOverrideReason: null,
      qualityOverrideBy: null,
      leaseToken: null,
      leaseUntil: null,
      leaseVersion: 0,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await this.dependencies.repository.createRun(run)
    } catch {
      const concurrent = await this.dependencies.repository.getRun(runId)
      if (!concurrent) throw new RunServiceError(500, 'RUN_CREATE_FAILED', 'run could not be created')
      return this.replayOrConflict(concurrent, requestHash)
    }
    await this.dependencies.repository.transact(run.id, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.started',
        payload: { status: 'PLANNING' },
      })
      appendV4LifecycleEvent(transaction, 'planning.started', {
        completed: 0,
        total: run.presentationMode === 'VISUAL_DECK_V4' ? V4_PLANNING_STAGE_COUNT : 1,
        pageNumbers: allPageNumbers(transaction.run),
      })
    })
    return { run, replayed: false }
  }

  async getOwned(runId: string, host: HostContext) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run || !owns(run, host)) throw new RunServiceError(404, 'RUN_NOT_FOUND', 'run was not found')
    return run
  }

  async listOwnedPage(host: HostContext, input: Readonly<{ after: RunListCursor | null; limit: number }>) {
    return this.dependencies.repository.listOwnedRuns({ host, ...input })
  }

  async act(runId: string, host: HostContext, request: unknown, idempotencyKey: string) {
    const parsed = runActionSchema.safeParse(request)
    if (!parsed.success) throw new RunServiceError(422, 'VALIDATION_ERROR', 'run action is invalid')
    const key = idempotencyKey.trim()
    if (key.length < 8 || key.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      throw new RunServiceError(422, 'INVALID_IDEMPOTENCY_KEY', 'idempotency key is invalid')
    }

    try {
      const qualityRecoveryArtifactProof = parsed.data.type === 'RETRY_DELIVERY'
        ? await this.assertV4QualityFailureArtifactsAvailable(runId, host, parsed.data.expectedVersion)
        : null
      return await this.dependencies.repository.transact(runId, (transaction) => {
        if (!owns(transaction.run, host)) throw new RunServiceError(404, 'RUN_NOT_FOUND', 'run was not found')
        const actionStepKey = `${runId}:action:${key}`
        const actionInputHash = hashInput({ host, action: parsed.data })
        const existingAction = transaction.getStep(actionStepKey)
        if (existingAction) {
          if (existingAction.inputHash !== actionInputHash || existingAction.tool !== 'user_action') {
            throw new RunServiceError(409, 'IDEMPOTENCY_CONFLICT', 'action key is already bound to another request')
          }
          if (existingAction.status !== 'COMPLETED' || !existingAction.output) {
            throw new RunServiceError(409, 'ACTION_IN_PROGRESS', 'action is still being processed')
          }
          return existingAction.output as RunRecord
        }
        if (parsed.data.expectedVersion !== transaction.run.version) {
          throw new RunServiceError(409, 'RUN_VERSION_CONFLICT', 'run version does not match expectedVersion')
        }
        const qualityFailureRecovery = parsed.data.type === 'RETRY_DELIVERY'
          && transaction.run.status === 'FAILED'
        const approvedRevisionRound = this.assertActionPrerequisites(
          transaction,
          parsed.data,
          host,
          qualityRecoveryArtifactProof,
        )
        const nextPlanningAttempt = this.planningRetryAttempt(transaction, parsed.data)
        const previous = transaction.run
        const policy = qualityFailureRecovery
          ? recoverV4QualityFailure(previous)
          : applyRunAction(previous, parsed.data, { actorRole: host.role ?? 'USER' })
        const now = this.dependencies.clock.now().toISOString()
        const updated: RunRecord = {
          ...previous,
          ...policy,
          ...(parsed.data.type === 'ACCEPT_WITH_OVERRIDE' ? {
            qualityOverrideReason: parsed.data.reason,
            qualityOverrideBy: host.externalUserId,
            qualityOverrideRole: host.role ?? 'USER',
            qualityOverrideIssueIds: parsed.data.issueIds,
            qualityOverrideAt: now,
          } : {}),
          ...(approvedRevisionRound === null ? {} : { revisionRound: approvedRevisionRound }),
          ...(nextPlanningAttempt === null ? {} : {
            planningAttempt: nextPlanningAttempt,
            ...(parsed.data.type === 'REPLAN' ? {
              slideCount: parsed.data.slideCount,
              visualDirection: parsed.data.visualDirection,
            } : {}),
          }),
          updatedAt: now,
        }
        transaction.putRun(updated)
        this.appendActionEvents(transaction, previous, updated, parsed.data, qualityFailureRecovery)
        transaction.putStep({
          id: `action-${hashInput({ runId, key }).slice(0, 28)}`,
          runId,
          idempotencyKey: actionStepKey,
          inputHash: actionInputHash,
          tool: 'user_action',
          status: 'COMPLETED',
          budgetUnits: 0,
          budgetReservationId: null,
          externalOperationId: null,
          errorCode: null,
          output: updated,
          createdAt: now,
          updatedAt: now,
        })
        return updated
      })
    } catch (error) {
      if (error instanceof RunServiceError) throw error
      if (error instanceof PolicyError) {
        throw new RunServiceError(error.code === 'RUN_VERSION_CONFLICT' ? 409 : 422, error.code, error.message)
      }
      if (error instanceof Error && error.message.startsWith('run not found:')) {
        throw new RunServiceError(404, 'RUN_NOT_FOUND', 'run was not found')
      }
      throw error
    }
  }

  private replayOrConflict(run: RunRecord, requestHash: string) {
    if (run.requestHash !== requestHash) {
      throw new RunServiceError(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to another request')
    }
    return { run, replayed: true }
  }

  private assertActionPrerequisites(
    transaction: AgentTransaction,
    action: RunAction,
    host: HostContext,
    qualityRecoveryArtifactProof: QualityRecoveryArtifactProof | null,
  ) {
    if (action.type === 'ACCEPT_WITH_OVERRIDE') {
      if (transaction.run.presentationMode === 'VISUAL_DECK_V4' && (host.role ?? 'USER') !== 'ADMIN') {
        throw new RunServiceError(403, 'QUALITY_OVERRIDE_ADMIN_REQUIRED', 'v4 quality override requires administrator approval')
      }
      const blueprintStep = transaction.getStep(transaction.run.revisionRound === 0
        ? planningStepKey(transaction.run.id, transaction.run.planningAttempt ?? 0)
        : revisionBlueprintStepKey(transaction.run.id, transaction.run.revisionRound))
      if (!blueprintStep || blueprintStep.status !== 'COMPLETED') {
        throw new RunServiceError(409, 'DELIVERY_BLUEPRINT_REQUIRED', 'quality override requires a valid blueprint')
      }
      presentationBlueprintSchema.parse(blueprintStep.output)
      const openIssues = new Map<string, Extract<ReturnType<AgentTransaction['listEvents']>[number], { type: 'issue.detected' }>['payload']>()
      for (const event of transaction.listEvents()) {
        if (event.type === 'issue.detected') openIssues.set(event.payload.id, event.payload)
        if (event.type === 'issue.resolved') openIssues.delete(event.payload.issueId)
      }
      if (action.issueIds.length !== openIssues.size || action.issueIds.some((id) => !openIssues.has(id))) {
        throw new RunServiceError(409, 'QUALITY_OVERRIDE_ISSUES_MISMATCH', 'quality override must acknowledge every open issue')
      }
      const adminOnly = action.issueIds.map((id) => openIssues.get(id)!).some((issue) =>
        issue.severity === 'CRITICAL'
        && (ADMIN_ONLY_CRITICAL_CATEGORIES.has(issue.category) || issue.repairDomain === 'KNOWLEDGE'))
      if (adminOnly && (host.role ?? 'USER') !== 'ADMIN') {
        throw new RunServiceError(403, 'QUALITY_OVERRIDE_ADMIN_REQUIRED', 'critical teaching issues require administrator approval')
      }
      return null
    }
    if (action.type === 'RETRY_DELIVERY') {
      if (transaction.run.status === 'FAILED') {
        this.assertV4QualityFailureRecovery(transaction, qualityRecoveryArtifactProof)
        return null
      }
      const failed = transaction.getStep(deliveryStepKey(transaction.run))
      if (!failed || failed.tool !== 'deliver_presentation' || failed.status !== 'FAILED') {
        throw new RunServiceError(409, 'DELIVERY_FAILURE_NOT_READY', 'failed delivery attempt is not available')
      }
      return null
    }
    if (action.type === 'APPROVE_BLUEPRINT') {
      const strategy = getPresentationModeStrategy(transaction.run.presentationMode ?? 'SLIDE_IMAGE_V2')
      if (strategy.executionAvailability !== 'AVAILABLE') {
        throw new RunServiceError(422, 'MODE_EXECUTION_NOT_IMPLEMENTED', `${strategy.mode} execution is not implemented`)
      }
      const step = transaction.getStep(planningStepKey(transaction.run.id, transaction.run.planningAttempt ?? 0))
      if (!step || step.status !== 'COMPLETED') {
        throw new RunServiceError(409, 'BLUEPRINT_NOT_READY', 'blueprint is not ready for approval')
      }
      presentationBlueprintSchema.parse(step.output)
      return null
    }
    if (action.type === 'APPROVE_REVISION') {
      const targetRound = transaction.run.revisionRound + 1
      const step = transaction.getStep(revisionPlanStepKey(transaction.run.id, targetRound))
      if (!step || step.status !== 'COMPLETED') {
        throw new RunServiceError(409, 'REVISION_PLAN_NOT_READY', 'revision plan is not ready for approval')
      }
      const plan = revisionPlanSchema.parse(step.output)
      if (plan.revisionRound !== targetRound) {
        throw new RunServiceError(409, 'REVISION_PLAN_ROUND_MISMATCH', 'revision plan targets another round')
      }
      return plan.revisionRound
    }
    if (action.type === 'SUBMIT_LIMITED_REVISION') {
      if (transaction.run.status !== 'NEEDS_HUMAN') {
        throw new RunServiceError(422, 'LIMITED_REVISION_NOT_ALLOWED', 'limited revision requires human review')
      }
      const targetRound = transaction.run.revisionRound + 1
      if (targetRound > transaction.run.maxRevisionRounds) {
        throw new RunServiceError(422, 'REVISION_LIMIT_REACHED', 'revision limit has been reached')
      }
      const blueprintStep = transaction.getStep(transaction.run.revisionRound === 0
        ? planningStepKey(transaction.run.id)
        : revisionBlueprintStepKey(transaction.run.id, transaction.run.revisionRound))
      if (!blueprintStep || blueprintStep.status !== 'COMPLETED') {
        throw new RunServiceError(409, 'BLUEPRINT_NOT_READY', 'active blueprint is not ready')
      }
      const blueprint = presentationBlueprintSchema.parse(blueprintStep.output)
      const slide = blueprint.slides.find((candidate) => `${transaction.run.id}:slide:${candidate.pageNumber}` === action.slideId)
      if (!slide) throw new RunServiceError(422, 'REVISION_SLIDE_INVALID', 'revision slide does not exist')
      if (action.repairDomain === 'ASSET') {
        const element = slide.layeredDesign?.elements.find((candidate) => candidate.elementId === action.targetElementId)
        if (!element || element.kind !== 'IMAGE' || element.role === 'BASE_LAYER') {
          throw new RunServiceError(422, 'REVISION_ELEMENT_INVALID', 'revision element is not a knowledge image asset')
        }
      }
      const operationKind = action.repairDomain === 'KNOWLEDGE'
        ? 'UPDATE_CONTENT' as const
        : action.repairDomain === 'ASSET' ? 'REGENERATE_IMAGE' as const : 'RELAYOUT' as const
      const createdAt = this.dependencies.clock.now().toISOString()
      const issueId = `manual-${hashInput({ runId: transaction.run.id, action }).slice(0, 24)}`
      const openIssueIds = new Set<string>()
      for (const event of transaction.listEvents()) {
        if (event.type === 'issue.detected') openIssueIds.add(event.payload.id)
        if (event.type === 'issue.resolved') openIssueIds.delete(event.payload.issueId)
      }
      const replacedMediaIssueIds = transaction.listSteps()
        .filter((step) => step.tool === 'generate_slide_image'
          && step.idempotencyKey.startsWith(`${action.slideId}:image:`)
          && ['FAILED', 'FAILED_CHARGED', 'FAILED_NOT_CHARGED'].includes(step.status))
        .flatMap((step) => [`${step.id}:provider-result`, `${step.id}:submission-unknown`])
        .filter((candidate) => openIssueIds.has(candidate))
      const plan = revisionPlanSchema.parse({
        id: `${transaction.run.id}:manual-revision:r${targetRound}`,
        reviewId: `${transaction.run.id}:manual-review:r${transaction.run.revisionRound}`,
        revisionRound: targetRound,
        createdAt,
        summary: `教师提交第 ${slide.pageNumber} 页${action.repairDomain}局部修订。`,
        operations: [{
          id: `${transaction.run.id}:manual-operation:r${targetRound}`,
          slideId: action.slideId,
          kind: operationKind,
          issueIds: replacedMediaIssueIds.length > 0 ? replacedMediaIssueIds : [issueId],
          instruction: action.instruction,
          sourceChunkIds: action.repairDomain === 'KNOWLEDGE' ? slide.sourceChunkIds : [],
          ...(action.targetElementId ? { targetElementId: action.targetElementId } : {}),
        }],
      })
      if (isVisualDeckV4(transaction.run)) {
        try {
          visualDeckV4RevisionInstructions({
            runId: transaction.run.id,
            pageNumber: slide.pageNumber,
            revisionRound: targetRound,
            steps: transaction.listSteps(),
            currentInstructions: [action.instruction],
          })
        } catch (error) {
          if (error instanceof Error && error.message === 'V4_REVISION_INSTRUCTION_BUDGET_EXCEEDED') {
            throw new RunServiceError(
              422,
              'REVISION_INSTRUCTION_BUDGET_EXCEEDED',
              'revision history is too large for another lossless page correction',
            )
          }
          throw error
        }
      }
      const key = revisionPlanStepKey(transaction.run.id, targetRound)
      const existingPlan = transaction.getStep(key)
      transaction.putStep({
        id: existingPlan?.id ?? `step-${transaction.run.id}-manual-revision-r${targetRound}`,
        runId: transaction.run.id,
        idempotencyKey: key,
        inputHash: hashInput({ tool: 'manual_revision', action }),
        tool: 'plan_revision',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: plan,
        createdAt: existingPlan?.createdAt ?? createdAt,
        updatedAt: createdAt,
      })
      return targetRound
    }
    return null
  }

  private planningRetryAttempt(transaction: AgentTransaction, action: RunAction) {
    if (action.type !== 'RETRY_PLANNING' && action.type !== 'REPLAN') return null
    const currentAttempt = transaction.run.planningAttempt ?? 0
    if (action.type === 'RETRY_PLANNING' && isVisualDeckV4(transaction.run)) {
      const failed = transaction.getStep(planningStepKey(transaction.run.id, currentAttempt))
      if (!failed || failed.status !== 'FAILED') {
        throw new RunServiceError(409, 'PLANNING_FAILURE_NOT_READY', 'failed planning attempt is not available')
      }
      return currentAttempt
    }
    if (currentAttempt >= MAX_PLANNING_RETRIES) {
      throw new RunServiceError(422, 'PLANNING_RETRY_LIMIT_REACHED', 'planning retry limit has been reached')
    }
    const failed = transaction.getStep(planningStepKey(transaction.run.id, currentAttempt))
    if (!failed || failed.status !== 'FAILED') {
      throw new RunServiceError(409, 'PLANNING_FAILURE_NOT_READY', 'failed planning attempt is not available')
    }
    return currentAttempt + 1
  }

  private appendActionEvents(
    transaction: AgentTransaction,
    previous: RunRecord,
    updated: RunRecord,
    action: RunAction,
    qualityFailureRecovery = false,
  ) {
    if (action.type === 'CANCEL' && isVisualDeckV4(updated)) {
      closeActiveV4LifecycleStages(transaction, 'CANCELLED_BY_USER')
    }
    if (action.type === 'CANCEL') enqueueUsageV2RunFinalization(transaction, this.dependencies.clock)
    if (previous.status !== updated.status) {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: previous.status, to: updated.status, reason: `USER_${action.type}` },
      })
    }
    if (qualityFailureRecovery) {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.resumed',
        payload: { status: 'DECK_REVIEW' },
      })
      appendV4LifecycleEvent(transaction, 'deck_review.started', {
        completed: 0,
        total: 1,
        pageNumbers: allPageNumbers(updated),
      })
      return
    }
    if (action.type === 'PAUSE') {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.paused',
        payload: isVisualDeckV4(updated)
          ? {
              ...v4LifecyclePayload(updated, 'RUN', {
                completed: 0,
                total: 1,
                reason: 'PAUSED_BY_USER',
              }),
              resumeState: updated.resumeState!,
            }
          : { reason: 'USER_PAUSED', resumeState: updated.resumeState! },
      })
    } else if (action.type === 'RESUME') {
      transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'run.resumed', payload: { status: updated.status } })
    } else if (action.type === 'CANCEL') {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.cancelled',
        payload: isVisualDeckV4(updated)
          ? {
              ...v4LifecyclePayload(updated, 'RUN', {
                completed: 0,
                total: 1,
                reason: 'CANCELLED_BY_USER',
              }),
              mode: action.mode ?? 'STOP_NEW_SUBMISSIONS',
            }
          : { reason: action.reason ?? null, mode: action.mode ?? 'STOP_NEW_SUBMISSIONS' },
      })
    } else if (action.type === 'ADD_BUDGET') {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'budget.updated',
        payload: { budgetUnits: updated.budgetUnits, committedBudgetUnits: updated.committedBudgetUnits },
      })
    } else if (['APPROVE_BLUEPRINT', 'RETRY_PLANNING', 'REPLAN', 'RETRY_DELIVERY', 'APPROVE_REVISION', 'SUBMIT_LIMITED_REVISION', 'REJECT_REVISION', 'ACCEPT_WITH_OVERRIDE'].includes(action.type)) {
      if (action.type === 'ACCEPT_WITH_OVERRIDE') {
        for (const issueId of action.issueIds) {
          transaction.appendEvent({
            schemaVersion: CONTRACT_VERSION,
            type: 'issue.resolved',
            payload: { issueId, resolution: 'ACCEPTED' },
          })
        }
      }
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.resolved',
        payload: {
          kind: action.type === 'APPROVE_BLUEPRINT' ? 'BLUEPRINT'
            : ['RETRY_PLANNING', 'REPLAN', 'RETRY_DELIVERY', 'ACCEPT_WITH_OVERRIDE', 'SUBMIT_LIMITED_REVISION'].includes(action.type) ? 'HUMAN_REVIEW' : 'REVISION',
          actionType: action.type,
          ...(action.type === 'ACCEPT_WITH_OVERRIDE' ? {
            actorId: updated.qualityOverrideBy!,
            actorRole: updated.qualityOverrideRole!,
            issueIds: action.issueIds,
            reason: action.reason,
          } : {}),
        },
      })
    }
    if (!isVisualDeckV4(updated)) return
    if (action.type === 'REJECT_REVISION') {
      const started = activeRevisionLifecycle(transaction)
      if (started) {
        appendV4LifecycleEvent(transaction, 'revision.completed', {
          completed: 0,
          total: started.payload.total,
          pageNumbers: started.payload.pageNumbers,
          revisionKind: started.payload.revisionKind,
          revisionRound: started.payload.revisionRound,
          reason: 'REVISION_REJECTED_BY_USER',
          retryable: false,
          requiresUserAction: true,
          nextAction: 'REVIEW_RESULT',
        })
      }
    } else if (action.type === 'APPROVE_BLUEPRINT') {
      appendV4LifecycleEvent(transaction, 'generation.started', {
        completed: 0,
        total: updated.slideCount,
        pageNumbers: allPageNumbers(updated),
      })
    } else if (action.type === 'RETRY_PLANNING' || action.type === 'REPLAN'
      || action.type === 'REQUEST_BLUEPRINT_REVISION') {
      appendV4LifecycleEvent(transaction, 'planning.started', {
        completed: 0,
        total: V4_PLANNING_STAGE_COUNT,
        pageNumbers: allPageNumbers(updated),
      })
    } else if (action.type === 'RETRY_DELIVERY' || action.type === 'ACCEPT_WITH_OVERRIDE') {
      appendV4LifecycleEvent(transaction, 'delivery.started', { completed: 0, total: 1 })
    } else if (action.type === 'APPROVE_REVISION' || action.type === 'SUBMIT_LIMITED_REVISION') {
      const step = transaction.getStep(revisionPlanStepKey(updated.id, updated.revisionRound))
      const parsed = revisionPlanSchema.safeParse(step?.output)
      if (parsed.success) {
        appendV4LifecycleEvent(transaction, 'revision.started', {
          completed: 0,
          total: new Set(parsed.data.operations.map((operation) => operation.slideId)).size,
          ...revisionDetails(parsed.data),
        })
      }
    }
  }

  private assertV4QualityFailureRecovery(
    transaction: AgentTransaction,
    artifactProof: QualityRecoveryArtifactProof | null,
  ) {
    const run = transaction.run
    if (!isVisualDeckV4(run)) {
      throw new RunServiceError(409, 'QUALITY_FAILURE_RECOVERY_NOT_ALLOWED', 'quality recovery requires a V4 run')
    }
    const lastResumeSequence = [...transaction.listEvents()].reverse()
      .find((event) => event.type === 'run.resumed')?.sequence ?? 0
    const failure = [...transaction.listEvents()].reverse().find((event) =>
      event.sequence > lastResumeSequence && event.type === 'run.failed')
    if (!failure || failure.type !== 'run.failed'
      || failure.payload.errorCode !== 'QUALITY_REMEDIATION_EXHAUSTED') {
      throw new RunServiceError(409, 'QUALITY_FAILURE_RECOVERY_NOT_ALLOWED', 'run is not a recoverable quality failure')
    }
    if (run.pendingTerminalFailure) {
      throw new RunServiceError(409, 'QUALITY_FAILURE_ACCOUNTING_NOT_FINAL', 'terminal accounting is still pending')
    }
    const authoritativeAccounting = deriveV4TerminalAccounting(run, transaction.listSteps())
    if (authoritativeAccounting.accountingStatus !== 'FINAL'
      || run.terminalAccounting?.accountingStatus !== 'FINAL'
      || JSON.stringify(authoritativeAccounting) !== JSON.stringify(run.terminalAccounting)) {
      throw new RunServiceError(409, 'QUALITY_FAILURE_ACCOUNTING_NOT_FINAL', 'terminal accounting is not final')
    }
    if (accountingProtocolFor(run) === 'FRAMEFLOW_USAGE_V2'
      && !isUsageV2RunFinalizationAcknowledged(transaction.getStep(usageV2FinalizeStepKey(run.id)))) {
      throw new RunServiceError(
        409,
        'QUALITY_FAILURE_USAGE_FINALIZATION_NOT_ACKNOWLEDGED',
        'Usage V2 finalization requires reconciliation before quality recovery',
      )
    }
    const blueprintStep = transaction.getStep(run.revisionRound === 0
      ? planningStepKey(run.id, run.planningAttempt ?? 0)
      : revisionBlueprintStepKey(run.id, run.revisionRound))
    const blueprint = presentationBlueprintSchema.safeParse(blueprintStep?.output)
    if (!blueprintStep || blueprintStep.status !== 'COMPLETED'
      || !blueprint.success || blueprint.data.renderMode !== 'VISUAL_DECK_V4') {
      throw new RunServiceError(409, 'QUALITY_FAILURE_BLUEPRINT_INVALID', 'active V4 blueprint is not valid')
    }
    const steps = transaction.listSteps()
    const requirements = blueprintImageRequirements(run, blueprint.data)
    const artifactReferences = requirements.map((requirement) => {
      const minimumRevisionRound = minimumRequiredV4ImageRound(
        steps, run.id, requirement.slideId, run.revisionRound,
      )
      const step = latestCompletedAssetStep(
        steps, requirement, run.revisionRound, minimumRevisionRound,
      )
      const reference = controlledVisualDeckPageArtifact(step, requirement)
      return step && reference ? {
        pageNumber: requirement.pageNumber,
        stepKey: step.idempotencyKey,
        artifactId: reference.artifactId,
      } : null
    })
    const artifactsComplete = artifactReferences.every((reference) => reference !== null)
      && new Set(artifactReferences.map((reference) => reference?.artifactId)).size === artifactReferences.length
    const proofIdentityMatches = artifactProof !== null
      && artifactProof.runId === run.id
      && artifactProof.runVersion === run.version
      && JSON.stringify(artifactReferences) === JSON.stringify(artifactProof.entries.map((entry) => ({
        pageNumber: entry.pageNumber,
        stepKey: entry.stepKey,
        artifactId: entry.artifactId,
      })))
    const artifactIntegrityMatches = artifactProof !== null
      && this.dependencies.artifacts !== undefined
      && artifactProof.entries.every((entry) => this.dependencies.artifacts!.verifyIntegrity({
        tenantId: run.host.tenantId,
        artifactId: entry.artifactId,
        mimeType: entry.mimeType,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
      }))
    if (!artifactsComplete || !proofIdentityMatches || !artifactIntegrityMatches) {
      throw new RunServiceError(409, 'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE', 'current V4 page artifacts are incomplete')
    }
    if (transaction.getDelivery(deliveryStepKey(run))
      || transaction.listSteps().some((step) => step.tool === 'deliver_presentation')) {
      throw new RunServiceError(409, 'QUALITY_FAILURE_DELIVERY_EXISTS', 'a delivery already exists for this run')
    }
  }

  private async assertV4QualityFailureArtifactsAvailable(
    runId: string,
    host: HostContext,
    expectedVersion: number,
  ) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run || !owns(run, host) || run.status !== 'FAILED'
      || !isVisualDeckV4(run) || run.version !== expectedVersion) return null
    const events = await this.dependencies.repository.listEvents(runId)
    const lastResumeSequence = [...events].reverse()
      .find((event) => event.type === 'run.resumed')?.sequence ?? 0
    const failure = [...events].reverse().find((event) =>
      event.sequence > lastResumeSequence && event.type === 'run.failed')
    if (!failure || failure.type !== 'run.failed'
      || failure.payload.errorCode !== 'QUALITY_REMEDIATION_EXHAUSTED') return null

    const steps = await this.dependencies.repository.listSteps(runId)
    const blueprintStep = steps.find((step) => step.idempotencyKey === (run.revisionRound === 0
      ? planningStepKey(run.id, run.planningAttempt ?? 0)
      : revisionBlueprintStepKey(run.id, run.revisionRound)))
    const blueprint = presentationBlueprintSchema.safeParse(blueprintStep?.output)
    if (!blueprintStep || blueprintStep.status !== 'COMPLETED'
      || !blueprint.success || blueprint.data.renderMode !== 'VISUAL_DECK_V4') return null

    const artifacts = this.dependencies.artifacts
    if (!artifacts) {
      throw new RunServiceError(409, 'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE', 'controlled artifact access is unavailable')
    }
    const requirements = blueprintImageRequirements(run, blueprint.data)
    const references = requirements.map((requirement) => {
      const minimumRevisionRound = minimumRequiredV4ImageRound(
        steps, run.id, requirement.slideId, run.revisionRound,
      )
      const step = latestCompletedAssetStep(
        steps, requirement, run.revisionRound, minimumRevisionRound,
      )
      const reference = controlledVisualDeckPageArtifact(step, requirement)
      return step && reference ? {
        pageNumber: requirement.pageNumber,
        stepKey: step.idempotencyKey,
        artifactId: reference.artifactId,
      } : null
    })
    if (references.some((reference) => reference === null)) {
      throw new RunServiceError(409, 'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE', 'current V4 page artifact identity is invalid')
    }
    if (new Set(references.map((reference) => reference?.artifactId)).size !== references.length) {
      throw new RunServiceError(409, 'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE', 'current V4 page artifacts are not unique')
    }
    const proofEntries: QualityRecoveryArtifactProof['entries'][number][] = []
    for (const reference of references) {
      if (!reference) throw new Error('QUALITY_RECOVERY_ARTIFACT_PROOF_INVALID')
      const artifact = await artifacts.get({ tenantId: run.host.tenantId, artifactId: reference.artifactId })
      const digest = artifact ? createHash('sha256').update(artifact.bytes).digest('hex') : null
      if (!artifact || !artifact.mimeType.startsWith('image/') || artifact.bytes.length === 0
        || artifact.sha256 !== digest) {
        throw new RunServiceError(409, 'QUALITY_FAILURE_ARTIFACTS_INCOMPLETE', 'current V4 page artifact is unavailable')
      }
      proofEntries.push({
        ...reference,
        sha256: artifact.sha256,
        byteLength: artifact.bytes.length,
        mimeType: artifact.mimeType,
      })
    }
    return {
      runId: run.id,
      runVersion: run.version,
      entries: proofEntries,
    } satisfies QualityRecoveryArtifactProof
  }
}

function minimumRequiredV4ImageRound(
  steps: readonly StepRecord[],
  runId: string,
  slideId: string,
  maxRevisionRound: number,
) {
  let minimumRevisionRound = 0
  for (const step of steps) {
    if (step.status !== 'COMPLETED'
      || (step.tool !== 'plan_revision' && step.tool !== 'plan_page_revision')) continue
    const plan = revisionPlanSchema.safeParse(step.output)
    if (!plan.success || plan.data.revisionRound > maxRevisionRound
      || step.idempotencyKey !== revisionPlanStepKey(runId, plan.data.revisionRound)) continue
    if (plan.data.operations.some((operation) => operation.slideId === slideId)) {
      minimumRevisionRound = Math.max(minimumRevisionRound, plan.data.revisionRound)
    }
  }
  return minimumRevisionRound
}

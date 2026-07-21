import {
  CONTRACT_VERSION,
  createRunRequestSchema,
  runActionSchema,
  type HostContext,
  type RunAction,
} from '../contracts'
import { presentationBlueprintSchema, revisionPlanSchema } from '../presentation-contracts'
import { hashInput } from './hash'
import { planningStepKey } from './planning-runner'
import type { AgentRepository, AgentTransaction, ClockPort, RunRecord } from './ports'
import { applyRunAction, PolicyError } from './policy'
import { revisionPlanStepKey } from './revision-planning-runner'

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
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    clock: ClockPort
  }>) {}

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

    const now = this.dependencies.clock.now().toISOString()
    const run: RunRecord = {
      id: runId,
      creationKey,
      requestHash,
      host: parsed.data.host,
      source: parsed.data.source,
      slideCount: parsed.data.slideCount,
      visualDirection: parsed.data.visualDirection,
      imageModel: parsed.data.imageModel,
      automationLevel: parsed.data.automationLevel,
      presentationMode: parsed.data.presentationMode,
      coverDesignMode: parsed.data.coverDesignMode,
      maxVisualAssetsPerSlide: parsed.data.maxVisualAssetsPerSlide,
      maxRevisionRounds: parsed.data.maxRevisionRounds,
      revisionRound: 0,
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
    })
    return { run, replayed: false }
  }

  async getOwned(runId: string, host: HostContext) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run || !owns(run, host)) throw new RunServiceError(404, 'RUN_NOT_FOUND', 'run was not found')
    return run
  }

  async listOwned(host: HostContext) {
    return (await this.dependencies.repository.listRuns())
      .filter((run) => owns(run, host))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
  }

  async act(runId: string, host: HostContext, request: unknown, idempotencyKey: string) {
    const parsed = runActionSchema.safeParse(request)
    if (!parsed.success) throw new RunServiceError(422, 'VALIDATION_ERROR', 'run action is invalid')
    const key = idempotencyKey.trim()
    if (key.length < 8 || key.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      throw new RunServiceError(422, 'INVALID_IDEMPOTENCY_KEY', 'idempotency key is invalid')
    }

    try {
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
        const approvedRevisionRound = this.assertActionPrerequisites(transaction, parsed.data)
        const previous = transaction.run
        const policy = applyRunAction(previous, parsed.data)
        const now = this.dependencies.clock.now().toISOString()
        const updated: RunRecord = {
          ...previous,
          ...policy,
          ...(parsed.data.type === 'ACCEPT_WITH_OVERRIDE' ? {
            qualityOverrideReason: parsed.data.reason,
            qualityOverrideBy: host.externalUserId,
          } : {}),
          ...(approvedRevisionRound === null ? {} : { revisionRound: approvedRevisionRound }),
          updatedAt: now,
        }
        transaction.putRun(updated)
        this.appendActionEvents(transaction, previous, updated, parsed.data)
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
  ) {
    if (action.type === 'APPROVE_BLUEPRINT') {
      const step = transaction.getStep(planningStepKey(transaction.run.id))
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
    return null
  }

  private appendActionEvents(
    transaction: AgentTransaction,
    previous: RunRecord,
    updated: RunRecord,
    action: RunAction,
  ) {
    if (previous.status !== updated.status) {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: previous.status, to: updated.status, reason: `USER_${action.type}` },
      })
    }
    if (action.type === 'PAUSE') {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.paused',
        payload: { reason: 'USER_PAUSED', resumeState: updated.resumeState! },
      })
    } else if (action.type === 'RESUME') {
      transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'run.resumed', payload: { status: updated.status } })
    } else if (action.type === 'CANCEL') {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.cancelled',
        payload: { reason: action.reason ?? null },
      })
    } else if (action.type === 'ADD_BUDGET') {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'budget.updated',
        payload: { budgetUnits: updated.budgetUnits, committedBudgetUnits: updated.committedBudgetUnits },
      })
    } else if (['APPROVE_BLUEPRINT', 'APPROVE_REVISION', 'REJECT_REVISION', 'ACCEPT_WITH_OVERRIDE'].includes(action.type)) {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.resolved',
        payload: {
          kind: action.type === 'APPROVE_BLUEPRINT' ? 'BLUEPRINT' : action.type === 'ACCEPT_WITH_OVERRIDE' ? 'HUMAN_REVIEW' : 'REVISION',
          actionType: action.type,
        },
      })
    }
  }
}

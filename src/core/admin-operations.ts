import { CONTRACT_VERSION, type HostContext } from '../contracts'
import { BudgetReservationError, type AgentRepository, type BudgetPort, type ClockPort, type RunRecord, type StepRecord } from './ports'
import type { MediaStepRunner } from './media-step-runner'
import { hashInput } from './hash'
import { releaseBudget } from './policy'

export type AdminOperationsAction = 'REINSPECT' | 'MARK_NOT_CHARGED' | 'MARK_CHARGED'

export class AdminOperationsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'AdminOperationsError'
  }
}

export interface AdminOperationsPort {
  act(input: Readonly<{
    host: HostContext
    runId: string
    stepId: string
    action: AdminOperationsAction
    expectedVersion: number
    idempotencyKey: string
    reason: string
  }>): Promise<Readonly<{ run: RunRecord; step: StepRecord; replayed: boolean }>>
}

const ACCOUNTING_STATUSES = new Set<StepRecord['status']>([
  'RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN', 'BILLING_UNKNOWN', 'FAILED_CHARGED',
])

function canResolveAccounting(status: StepRecord['status'], charged: boolean) {
  if (!ACCOUNTING_STATUSES.has(status)) return false
  if (status === 'RESERVATION_UNKNOWN') return !charged
  if (status === 'FAILED_CHARGED') return charged
  return true
}

export class AdminOperationsService implements AdminOperationsPort {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    budget: BudgetPort
    media: MediaStepRunner
    clock: ClockPort
  }>) {}

  async act(input: Readonly<{
    host: HostContext
    runId: string
    stepId: string
    action: AdminOperationsAction
    expectedVersion: number
    idempotencyKey: string
    reason: string
  }>) {
    if ((input.host.role ?? 'USER') !== 'ADMIN') throw new AdminOperationsError(403, 'ADMIN_REQUIRED', 'administrator role is required')
    const actionKey = `admin:${input.idempotencyKey}`
    const inputHash = hashInput({ runId: input.runId, stepId: input.stepId, action: input.action, reason: input.reason })
    const target = (await this.dependencies.repository.listSteps(input.runId)).find((step) => step.id === input.stepId)
    if (!target) throw new AdminOperationsError(404, 'STEP_NOT_FOUND', 'step was not found')
    const prepared = await this.dependencies.repository.transact(input.runId, (transaction) => {
      if (transaction.run.host.tenantId !== input.host.tenantId) {
        throw new AdminOperationsError(404, 'RUN_NOT_FOUND', 'run was not found')
      }
      const existing = transaction.getStep(actionKey)
      if (existing) {
        if (existing.inputHash !== inputHash || existing.tool !== 'admin_reconciliation') {
          throw new AdminOperationsError(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to another action')
        }
        const target = transaction.getStep((existing.output as { stepKey?: string } | null)?.stepKey ?? '')
        if (!target) throw new AdminOperationsError(409, 'ADMIN_ACTION_TARGET_MISSING', 'admin action target is unavailable')
        return { run: transaction.run, target, actionStep: existing, replayed: existing.status === 'COMPLETED' }
      }
      if (transaction.run.version !== input.expectedVersion) {
        throw new AdminOperationsError(409, 'RUN_VERSION_CONFLICT', 'run version does not match expectedVersion')
      }
      if (transaction.listSteps().some((step) => step.tool === 'admin_reconciliation' && step.status === 'RUNNING')) {
        throw new AdminOperationsError(409, 'ADMIN_ACTION_IN_PROGRESS', 'another administrator action is still in progress')
      }
      const currentTarget = transaction.getStep(target.idempotencyKey)
      if (!currentTarget || currentTarget.id !== input.stepId) {
        throw new AdminOperationsError(404, 'STEP_NOT_FOUND', 'step was not found')
      }
      if (input.action === 'REINSPECT'
        && (!['WAITING', 'BILLING_UNKNOWN'].includes(currentTarget.status) || !currentTarget.externalOperationId)) {
        throw new AdminOperationsError(409, 'STEP_NOT_REINSPECTABLE', 'step cannot be reinspected')
      }
      if (input.action !== 'REINSPECT'
        && !canResolveAccounting(currentTarget.status, input.action === 'MARK_CHARGED')) {
        throw new AdminOperationsError(409, 'STEP_NOT_RECONCILABLE', 'step cannot be manually reconciled')
      }
      const actionStep: StepRecord = {
        id: `${input.runId}:admin:${hashInput(actionKey).slice(0, 24)}`,
        runId: input.runId,
        idempotencyKey: actionKey,
        inputHash,
        tool: 'admin_reconciliation',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: { stepKey: target.idempotencyKey, action: input.action },
        createdAt: this.dependencies.clock.now().toISOString(),
        updatedAt: this.dependencies.clock.now().toISOString(),
      }
      transaction.putStep(actionStep)
      return { run: transaction.run, target: currentTarget, actionStep, replayed: false }
    })
    if (prepared.replayed) return { run: prepared.run, step: prepared.target, replayed: true }

    let updated: StepRecord
    if (input.action === 'REINSPECT') {
      if (!['WAITING', 'BILLING_UNKNOWN'].includes(prepared.target.status) || !prepared.target.externalOperationId) {
        throw new AdminOperationsError(409, 'STEP_NOT_REINSPECTABLE', 'step cannot be reinspected')
      }
      updated = (await this.dependencies.media.refreshSlideImage(input.runId, prepared.target.idempotencyKey)).step
    } else {
      updated = await this.resolveAccounting(input.runId, prepared.target.idempotencyKey, input.action === 'MARK_CHARGED')
    }

    const completed = await this.dependencies.repository.transact(input.runId, (transaction) => {
      const actionStep = transaction.getStep(actionKey)
      const current = transaction.getStep(prepared.target.idempotencyKey)
      if (!actionStep || !current) throw new AdminOperationsError(409, 'ADMIN_ACTION_STATE_MISSING', 'admin action state is unavailable')
      if (input.action === 'REINSPECT' && ['WAITING', 'BILLING_UNKNOWN'].includes(current.status)) {
        const now = this.dependencies.clock.now().toISOString()
        transaction.putStep({
          ...actionStep,
          status: 'COMPLETED',
          output: { ...actionStep.output as object, resultStatus: current.status },
          updatedAt: now,
        })
        return { run: transaction.run, step: current }
      }
      if (actionStep.status !== 'COMPLETED') {
        const now = this.dependencies.clock.now().toISOString()
        transaction.putStep({ ...actionStep, status: 'COMPLETED', output: { ...actionStep.output as object, resultStatus: current.status }, updatedAt: now })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'approval.resolved',
          payload: {
            kind: 'HUMAN_REVIEW', actionType: input.action,
            actorId: input.host.externalUserId, actorRole: 'ADMIN', reason: input.reason,
          },
        })
      }
      return { run: transaction.run, step: current }
    })
    return { ...completed, step: updated.status === completed.step.status ? completed.step : updated, replayed: false }
  }

  private async resolveAccounting(runId: string, stepKey: string, charged: boolean) {
    const run = await this.dependencies.repository.getRun(runId)
    const step = (await this.dependencies.repository.listSteps(runId)).find((candidate) => candidate.idempotencyKey === stepKey)
    if (!run || !step) throw new AdminOperationsError(404, 'STEP_NOT_FOUND', 'step was not found')
    const desiredStatus = charged ? 'FAILED_CHARGED' : 'FAILED_NOT_CHARGED'
    if (step.status === desiredStatus) return step
    if (!canResolveAccounting(step.status, charged)) {
      throw new AdminOperationsError(409, 'STEP_NOT_RECONCILABLE', 'step cannot be manually reconciled')
    }
    if (!charged && run.committedBudgetUnits < step.budgetUnits) {
      throw new AdminOperationsError(409, 'BUDGET_RECONCILIATION_CONFLICT', 'committed budget is lower than the step amount')
    }
    let reservationId = step.budgetReservationId
    if (!reservationId) {
      try {
        reservationId = (await this.dependencies.budget.reserve({
          host: run.host,
          model: run.imageModel,
          units: step.budgetUnits,
          idempotencyKey: step.idempotencyKey,
        })).reservationId
      } catch (error) {
        if (!(step.status === 'RESERVATION_UNKNOWN'
          && error instanceof BudgetReservationError
          && error.reservationState === 'NOT_RESERVED')) throw error
      }
    }
    if (charged) {
      if (!reservationId) throw new AdminOperationsError(409, 'BUDGET_RESERVATION_MISSING', 'host reservation is unavailable')
      await this.dependencies.budget.settle({
        host: run.host,
        reservationId,
        idempotencyKey: `admin-settle:${step.idempotencyKey}`,
      })
    } else if (reservationId) {
      await this.dependencies.budget.release({
        host: run.host,
        reservationId,
        idempotencyKey: `admin-release:${step.idempotencyKey}`,
      })
    }
    return this.dependencies.repository.transact(runId, (transaction) => {
      const current = transaction.getStep(stepKey)
      if (!current) throw new AdminOperationsError(404, 'STEP_NOT_FOUND', 'step was not found')
      if (current.status === desiredStatus) return current
      const now = this.dependencies.clock.now().toISOString()
      const policy = charged
        ? { ...transaction.run, version: transaction.run.version + 1 }
        : releaseBudget(transaction.run, current.budgetUnits)
      transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
      const updated = { ...current, status: desiredStatus, budgetReservationId: reservationId ?? null, updatedAt: now } as StepRecord
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION, type: 'issue.resolved',
        payload: { issueId: `${current.id}:submission-unknown`, resolution: 'FIXED' },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION, type: 'issue.resolved',
        payload: { issueId: `${current.id}:provider-result`, resolution: 'FIXED' },
      })
      if (!charged) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION, type: 'budget.updated',
          payload: { budgetUnits: policy.budgetUnits, committedBudgetUnits: policy.committedBudgetUnits },
        })
      }
      return updated
    })
  }
}

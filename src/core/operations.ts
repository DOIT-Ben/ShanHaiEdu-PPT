import type { KnownAgentEvent as AgentEvent, RunStatus } from '../contracts'
import type {
  OperationsFilters,
  OperationsPercentiles,
  OperationsReport,
  RunRecord,
  StepRecord,
  StepStatus,
} from './ports'

export type OperationalRun = Pick<RunRecord, 'id' | 'host' | 'status' | 'version' | 'createdAt' | 'updatedAt'>
export type OperationalStep = Pick<StepRecord,
  'id' | 'runId' | 'idempotencyKey' | 'tool' | 'status' | 'budgetUnits' | 'externalOperationId' | 'errorCode' | 'createdAt' | 'updatedAt'>

const FAILURE_STATUSES = new Set<StepStatus>(['FAILED', 'FAILED_CHARGED', 'FAILED_NOT_CHARGED', 'BILLING_UNKNOWN'])
const UNKNOWN_BILLING_STATUSES = new Set<StepStatus>(['RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN', 'BILLING_UNKNOWN'])

function ageMs(now: number, value: string) {
  return Math.max(0, now - Date.parse(value))
}

function percentile(values: readonly number[], quantile: number) {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  return Math.round(ordered[Math.ceil(quantile * ordered.length) - 1]!)
}

function percentiles(values: readonly number[]): OperationsPercentiles {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) }
}

function reconciliationItem(step: OperationalStep, now: number, filters: OperationsFilters) {
  const age = ageMs(now, step.updatedAt)
  let errorCode: string | null = null
  let allowedActions: OperationsReport['reconciliation'][number]['allowedActions'] = []
  if (['report_usage_v2', 'finalize_usage_v2'].includes(step.tool) && step.status === 'FAILED') {
    errorCode = step.errorCode ?? (step.tool === 'finalize_usage_v2'
      ? 'HOST_USAGE_V2_FINALIZATION_REJECTED'
      : 'HOST_USAGE_V2_EVENT_REJECTED')
    allowedActions = ['REINSPECT']
  } else if (step.status === 'WAITING' && age >= filters.waitingSlaMs) {
    errorCode = 'WAITING_TOO_LONG'
    allowedActions = ['REINSPECT']
  } else if (['RUNNING', 'RESERVED', 'SUBMITTING', 'RELEASING'].includes(step.status) && age >= filters.stepSlaMs) {
    errorCode = 'STEP_SLA_EXCEEDED'
  } else if (UNKNOWN_BILLING_STATUSES.has(step.status)) {
    errorCode = step.errorCode ?? step.status
    allowedActions = step.status === 'RESERVATION_UNKNOWN'
      ? ['MARK_NOT_CHARGED']
      : step.externalOperationId
        ? ['REINSPECT', 'MARK_NOT_CHARGED', 'MARK_CHARGED']
        : ['MARK_NOT_CHARGED', 'MARK_CHARGED']
  } else if (step.status === 'FAILED_CHARGED') {
    errorCode = step.errorCode ?? 'FAILED_CHARGED'
    allowedActions = ['MARK_CHARGED']
  }
  if (!errorCode) return null
  return {
    id: `${step.runId}:${step.id}:${errorCode}`,
    runId: step.runId,
    stepId: step.id,
    stepKey: step.idempotencyKey,
    status: step.status,
    errorCode,
    ageMs: age,
    allowedActions,
    updatedAt: step.updatedAt,
  } as const
}

export function buildOperationsReport(input: Readonly<{
  runs: readonly OperationalRun[]
  steps: readonly OperationalStep[]
  events: readonly AgentEvent[]
  filters: OperationsFilters
}>): OperationsReport {
  const now = Date.parse(input.filters.now)
  const tenantRuns = input.runs.filter((run) => run.host.tenantId === input.filters.tenantId)
  const tenantRunIds = new Set(tenantRuns.map((run) => run.id))
  const steps = input.steps.filter((step) => tenantRunIds.has(step.runId))
  const events = input.events.filter((event) => tenantRunIds.has(event.runId))
  const stepsByRun = new Map<string, OperationalStep[]>()
  for (const step of steps) stepsByRun.set(step.runId, [...(stepsByRun.get(step.runId) ?? []), step])
  const runVersions = new Map(tenantRuns.map((run) => [run.id, run.version]))
  const reconciliation = steps.map((step) => reconciliationItem(step, now, input.filters)).filter((item) => item !== null)
    .map((item) => ({ ...item, runVersion: runVersions.get(item.runId)! }))
  const reconciliationByRun = new Map<string, number>()
  for (const item of reconciliation) reconciliationByRun.set(item.runId, (reconciliationByRun.get(item.runId) ?? 0) + 1)

  const filteredRuns = tenantRuns.filter((run) => {
    const runSteps = stepsByRun.get(run.id) ?? []
    return (!input.filters.status || run.status === input.filters.status)
      && (!input.filters.externalUserId || run.host.externalUserId === input.filters.externalUserId)
      && (!input.filters.errorCode || runSteps.some((step) => step.errorCode === input.filters.errorCode))
      && (!input.filters.createdFrom || run.createdAt >= input.filters.createdFrom)
      && (!input.filters.createdTo || run.createdAt <= input.filters.createdTo)
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
  const runs = filteredRuns.slice(input.filters.offset, input.filters.offset + input.filters.limit).map((run) => {
    const runSteps = stepsByRun.get(run.id) ?? []
    const lastError = [...runSteps].filter((step) => step.errorCode).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    return {
      id: run.id,
      externalUserId: run.host.externalUserId,
      status: run.status,
      version: run.version,
      lastErrorCode: lastError?.errorCode ?? null,
      reconciliationCount: reconciliationByRun.get(run.id) ?? 0,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }
  })

  const terminalRuns = tenantRuns.filter((run) => ['COMPLETED', 'FAILED'].includes(run.status))
  const providerSteps = steps.filter((step) => step.tool === 'generate_slide_image'
    && (step.status === 'COMPLETED' || step.status === 'COMPLETED_AFTER_CANCEL' || FAILURE_STATUSES.has(step.status)))
  const eventsByRun = new Map<string, AgentEvent[]>()
  for (const event of events) eventsByRun.set(event.runId, [...(eventsByRun.get(event.runId) ?? []), event])
  const phaseDurations = new Map<RunStatus, number[]>()
  const toolStartedAt = new Map<string, number>()
  const queueWait: number[] = []
  for (const run of tenantRuns) {
    let enteredAt: number | null = null
    for (const event of (eventsByRun.get(run.id) ?? []).sort((left, right) => left.sequence - right.sequence)) {
      if (event.type === 'run.started') {
        enteredAt = Date.parse(event.createdAt)
      } else if (event.type === 'tool.started') {
        toolStartedAt.set(`${event.runId}:${event.payload.stepId}`, Date.parse(event.createdAt))
      } else if (event.type === 'tool.progress' && event.payload.completed === 0) {
        const key = `${event.runId}:${event.payload.stepId}`
        const startedAt = toolStartedAt.get(key)
        if (startedAt !== undefined) {
          queueWait.push(Math.max(0, Date.parse(event.createdAt) - startedAt))
          toolStartedAt.delete(key)
        }
      } else if (event.type === 'phase.changed') {
        const changedAt = Date.parse(event.createdAt)
        if (enteredAt !== null) {
          phaseDurations.set(event.payload.from, [...(phaseDurations.get(event.payload.from) ?? []), Math.max(0, changedAt - enteredAt)])
        }
        enteredAt = changedAt
      }
    }
  }

  return {
    runs,
    totalRuns: filteredRuns.length,
    totalReconciliation: reconciliation.length,
    reconciliation: reconciliation.sort((left, right) => right.ageMs - left.ageMs).slice(0, 500),
    metrics: {
      successRate: terminalRuns.length > 0
        ? terminalRuns.filter((run) => run.status === 'COMPLETED').length / terminalRuns.length
        : null,
      phaseLatencyMs: Object.fromEntries([...phaseDurations].map(([phase, values]) => [phase, percentiles(values)])),
      queueWaitMs: percentiles(queueWait),
      providerFailureRate: providerSteps.length > 0
        ? providerSteps.filter((step) => FAILURE_STATUSES.has(step.status)).length / providerSteps.length
        : null,
      unknownBillingCount: steps.filter((step) => UNKNOWN_BILLING_STATUSES.has(step.status)).length,
    },
  }
}

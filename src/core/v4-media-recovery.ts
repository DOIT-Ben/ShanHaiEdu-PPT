import { CONTRACT_VERSION } from '../contracts'
import { revisionPlanSchema } from '../presentation-contracts'
import { recoverMediaExecution, recoverMediaRevision } from './policy'
import type { AgentTransaction, ClockPort, RunRecord } from './ports'
import { revisionPlanStepKey } from './revision-planning-runner'
import { allPageNumbers, appendV4LifecycleEvent, isVisualDeckV4, revisionDetails } from './v4-lifecycle'
import { visualDeckPageImageIdentity } from './blueprint-assets'

/** Restores the correct V4 stage only after the affected raster batch is fully recovered. */
export function recoverV4AfterMediaRecovery(transaction: AgentTransaction, clock: ClockPort): RunRecord {
  const run = transaction.run
  if (!isVisualDeckV4(run) || run.status !== 'NEEDS_HUMAN') return run

  const revision = recoverV4RevisionAfterMediaRecovery(transaction, clock)
  if (revision) return revision

  const imageSteps = transaction.listSteps().filter((step) =>
    step.tool === 'generate_slide_image'
      && isPageImageFor(step.idempotencyKey, run.id, run.revisionRound))
  if (imageSteps.length !== run.slideCount || imageSteps.some((step) => step.status !== 'COMPLETED')) return run

  const pageNumbers = new Set<number>()
  for (const step of imageSteps) {
    const output = step.output as { slideId?: unknown; artifactId?: unknown } | null
    const match = typeof output?.slideId === 'string' ? /:slide:(\d+)$/.exec(output.slideId) : null
    if (!match || typeof output?.artifactId !== 'string') return run
    const pageNumber = Number(match[1])
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > run.slideCount) return run
    pageNumbers.add(pageNumber)
  }
  if (pageNumbers.size !== run.slideCount) return run

  if (openIssueIds(transaction).size > 0) return run

  const recovered = { ...run, ...recoverMediaExecution(run), updatedAt: clock.now().toISOString() }
  transaction.putRun(recovered)
  transaction.appendEvent({
    schemaVersion: CONTRACT_VERSION,
    type: 'phase.changed',
    payload: { from: 'NEEDS_HUMAN', to: 'EXECUTING', reason: 'PROVIDER_REINSPECTION_RECOVERED' },
  })
  transaction.appendEvent({
    schemaVersion: CONTRACT_VERSION,
    type: 'run.resumed',
    payload: { status: 'EXECUTING' },
  })
  appendV4LifecycleEvent(transaction, 'generation.progress', {
    completed: run.slideCount,
    total: run.slideCount,
    pageNumbers: allPageNumbers(run),
    retryable: true,
  })
  return recovered
}

function recoverV4RevisionAfterMediaRecovery(transaction: AgentTransaction, clock: ClockPort): RunRecord | null {
  const run = transaction.run
  if (run.revisionRound < 1) return null
  const planStep = transaction.getStep(revisionPlanStepKey(run.id, run.revisionRound))
  if (!planStep || planStep.status !== 'COMPLETED') return null
  const parsedPlan = revisionPlanSchema.safeParse(planStep.output)
  if (!parsedPlan.success) return null
  const plan = parsedPlan.data
  const pageNumbers = [...new Set(plan.operations.map((operation) => Number(operation.slideId.split(':').at(-1))))]
    .filter((pageNumber) => Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= run.slideCount)
    .sort((left, right) => left - right)
  if (pageNumbers.length === 0) return null

  const allSteps = transaction.listSteps()
  const steps = pageNumbers.map((pageNumber) => allSteps.find((step) => {
    const identity = visualDeckPageImageIdentity(step.idempotencyKey)
    return step.tool === 'generate_slide_image'
      && identity?.runId === run.id
      && identity.pageNumber === pageNumber
      && identity.revisionRound === run.revisionRound
  }))
  if (steps.some((step) => step?.status !== 'COMPLETED' || !hasControlledArtifact(step))) return null
  if (hasOpenMediaIssue(transaction, steps.filter((step): step is NonNullable<typeof step> => step !== null))) return null

  const details = revisionDetails(plan, planStep.tool === 'plan_page_revision')
  const recovered = { ...run, ...recoverMediaRevision(run), updatedAt: clock.now().toISOString() }
  transaction.putRun(recovered)
  transaction.appendEvent({
    schemaVersion: CONTRACT_VERSION,
    type: 'phase.changed',
    payload: { from: 'NEEDS_HUMAN', to: 'REVISING', reason: 'PROVIDER_REINSPECTION_RECOVERED' },
  })
  transaction.appendEvent({
    schemaVersion: CONTRACT_VERSION,
    type: 'run.resumed',
    payload: { status: 'REVISING' },
  })
  appendV4LifecycleEvent(transaction, 'revision.started', {
    completed: 0,
    total: pageNumbers.length,
    ...details,
  })
  appendV4LifecycleEvent(transaction, 'revision.progress', {
    completed: pageNumbers.length,
    total: pageNumbers.length,
    ...details,
  })
  return recovered
}

function isPageImageFor(idempotencyKey: string, runId: string, revisionRound: number) {
  const identity = visualDeckPageImageIdentity(idempotencyKey)
  return identity?.runId === runId && identity.revisionRound === revisionRound
}

function hasControlledArtifact(step: ReturnType<AgentTransaction['getStep']>) {
  const output = step?.output as { artifactId?: unknown } | null
  return typeof output?.artifactId === 'string'
}

function openIssueIds(transaction: AgentTransaction) {
  const openIssueIds = new Set<string>()
  for (const event of transaction.listEvents()) {
    if (event.type === 'issue.detected') openIssueIds.add(event.payload.id)
    if (event.type === 'issue.resolved') openIssueIds.delete(event.payload.issueId)
  }
  return openIssueIds
}

function hasOpenMediaIssue(transaction: AgentTransaction, steps: readonly Readonly<{ id: string }>[]) {
  const open = openIssueIds(transaction)
  return steps.some((step) => open.has(`${step.id}:provider-result`) || open.has(`${step.id}:submission-unknown`))
}

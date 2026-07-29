import { presentationBlueprintSchema, type PresentationBlueprint } from '../presentation-contracts'
import { planningStepKey } from './planning-runner'
import type { AgentRepository, StepRecord } from './ports'

export async function getActiveBlueprint(
  repository: AgentRepository,
  runId: string,
  revisionRound: number,
): Promise<PresentationBlueprint> {
  const steps = await repository.listSteps(runId)
  const revised = steps
    .map((step) => ({ step, round: revisionBlueprintRound(step, runId) }))
    .filter((candidate): candidate is { step: StepRecord; round: number } =>
      candidate.round !== null && candidate.round <= revisionRound && candidate.step.status === 'COMPLETED')
    .sort((left, right) => right.round - left.round)[0]
  if (revised) return presentationBlueprintSchema.parse(revised.step.output)

  const planned = steps
    .map((step) => ({ step, attempt: planningBlueprintAttempt(step, runId) }))
    .filter((candidate): candidate is { step: StepRecord; attempt: number } =>
      candidate.attempt !== null && candidate.step.status === 'COMPLETED')
    .sort((left, right) => right.attempt - left.attempt)[0]
  if (!planned) throw new Error('BLUEPRINT_NOT_READY')
  return presentationBlueprintSchema.parse(planned.step.output)
}

export function revisionBlueprintStepKey(runId: string, revisionRound: number) {
  return `${runId}:revision-blueprint:r${revisionRound}`
}

function revisionBlueprintRound(step: StepRecord, runId: string) {
  if (step.tool !== 'apply_revision') return null
  const prefix = `${runId}:revision-blueprint:r`
  if (!step.idempotencyKey.startsWith(prefix)) return null
  const round = Number(step.idempotencyKey.slice(prefix.length))
  return Number.isSafeInteger(round) && round >= 1 ? round : null
}

function planningBlueprintAttempt(step: StepRecord, runId: string) {
  if (step.tool !== 'create_blueprint') return null
  if (step.idempotencyKey === planningStepKey(runId)) return 0
  const prefix = `${runId}:blueprint:retry:`
  if (!step.idempotencyKey.startsWith(prefix)) return null
  const attempt = Number(step.idempotencyKey.slice(prefix.length))
  return Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : null
}

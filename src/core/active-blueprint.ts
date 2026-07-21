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

  const initial = steps.find((step) =>
    step.idempotencyKey === planningStepKey(runId) && step.status === 'COMPLETED')
  if (!initial) throw new Error('BLUEPRINT_NOT_READY')
  return presentationBlueprintSchema.parse(initial.output)
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

import { CONTRACT_VERSION } from '../contracts'
import type { PresentationBlueprint } from '../presentation-contracts'
import { getActiveBlueprint } from './active-blueprint'
import { blueprintImageRequirements } from './blueprint-assets'
import { hashInput } from './hash'
import { MediaStepRunner } from './media-step-runner'
import type { AgentRepository, ClockPort, RunRecord, StepRecord } from './ports'
import { evaluateBudget, transitionRun } from './policy'

export type SubmitBlueprintImagesResult = Readonly<{
  status: RunRecord['status']
  submitted: number
  total: number
  steps: readonly StepRecord[]
}>

export type RefreshBlueprintImagesResult = Readonly<{
  status: RunRecord['status']
  completed: number
  total: number
  artifactIds: readonly string[]
}>

export class SlideGenerationCoordinator {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    media: MediaStepRunner
    clock: ClockPort
  }>) {}

  async submitBlueprintImages(runId: string, unitBudgetUnits: number): Promise<SubmitBlueprintImagesResult> {
    if (!Number.isSafeInteger(unitBudgetUnits) || unitBudgetUnits <= 0) throw new Error('INVALID_UNIT_BUDGET')
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    if (run.status === 'PAUSED' || run.status === 'NEEDS_HUMAN') {
      return { status: run.status, submitted: 0, total: run.slideCount, steps: [] }
    }
    if (run.status !== 'EXECUTING') throw new Error('RUN_NOT_EXECUTING')
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    const requirements = blueprintImageRequirements(run, blueprint)
    const existingSteps = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image')
    const blockingStep = existingSteps.find((step) => ['FAILED', 'RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(step.status))
    if (blockingStep) {
      await this.requireHuman(runId, blockingStep)
      return { status: 'NEEDS_HUMAN', submitted: 0, total: blueprint.slides.length, steps: existingSteps }
    }
    const existingKeys = new Set(existingSteps.map((step) => step.idempotencyKey))
    const pendingRequirements = requirements.filter((requirement) => !existingKeys.has(requirement.idempotencyKey))

    if (pendingRequirements.length === 0) {
      return {
        status: run.status,
        submitted: existingSteps.filter((step) => ['WAITING', 'COMPLETED'].includes(step.status)).length,
        total: requirements.length,
        steps: existingSteps,
      }
    }

    const decision = evaluateBudget(run, pendingRequirements.length * unitBudgetUnits)
    if (!decision.allowed && decision.reason === 'BUDGET_EXCEEDED') {
      const paused = await this.pauseForBudget(run, pendingRequirements.length * unitBudgetUnits)
      return { status: paused.status, submitted: 0, total: requirements.length, steps: existingSteps }
    }
    if (!decision.allowed) throw new Error(decision.reason)

    const steps = [...existingSteps]
    for (const requirement of pendingRequirements) {
      const key = requirement.idempotencyKey
      const versionId = requirement.elementId === null
        ? `${runId}:slide:${requirement.pageNumber}:r${run.revisionRound}:v1`
        : `${runId}:slide:${requirement.pageNumber}:element:${requirement.elementId}:r${run.revisionRound}:v1`
      const result = await this.dependencies.media.submitSlideImage({
        runId,
        stepId: `step-${runId}-asset-${hashInput(requirement.assetKey).slice(0, 20)}-r${run.revisionRound}`,
        idempotencyKey: key,
        slideId: requirement.slideId,
        versionId,
        prompt: requirement.prompt,
        ...(requirement.negativePrompt ? { negativePrompt: requirement.negativePrompt } : {}),
        model: run.imageModel,
        budgetUnits: unitBudgetUnits,
        aspectRatio: requirement.aspectRatio,
        backgroundMode: requirement.backgroundMode,
        ...(requirement.elementId ? { elementId: requirement.elementId } : {}),
        ...(requirement.reuseKey ? { assetReuseKey: requirement.reuseKey } : {}),
      })
      if (!steps.some((step) => step.idempotencyKey === result.step.idempotencyKey)) steps.push(result.step)
      const latestRun = await this.dependencies.repository.getRun(runId)
      if (!latestRun || latestRun.status === 'NEEDS_HUMAN' || latestRun.status === 'PAUSED') break
      if (result.step.status === 'FAILED') {
        await this.requireHuman(runId, result.step)
        break
      }
      await this.appendProgress(runId, result.step.id, steps.length, requirements.length)
    }
    const latest = await this.dependencies.repository.getRun(runId)
    return {
      status: latest?.status ?? 'FAILED',
      submitted: steps.filter((step) => ['WAITING', 'COMPLETED'].includes(step.status)).length,
      total: requirements.length,
      steps,
    }
  }

  async refreshBlueprintImages(runId: string): Promise<RefreshBlueprintImagesResult> {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    const requirements = blueprintImageRequirements(run, blueprint)
    if (run.status === 'PAGE_REVIEW') return this.completedSummary(runId, requirements.length, run.status)
    if (run.status !== 'EXECUTING') return this.completedSummary(runId, requirements.length, run.status)

    const steps = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image')
    for (const step of steps.filter((candidate) => candidate.status === 'WAITING')) {
      await this.dependencies.media.refreshSlideImage(runId, step.idempotencyKey)
      const latest = await this.dependencies.repository.getRun(runId)
      if (!latest || latest.status === 'NEEDS_HUMAN') break
    }

    const refreshed = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image')
    const failed = refreshed.find((step) => ['FAILED', 'RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(step.status))
    if (failed) await this.requireHuman(runId, failed)
    const completed = refreshed.filter((step) => step.status === 'COMPLETED' && this.artifactId(step) !== null)
    const latest = await this.dependencies.repository.getRun(runId)
    if (!failed && completed.length === requirements.length && latest?.status === 'EXECUTING') {
      await this.dependencies.repository.transact(runId, (transaction) => {
        if (transaction.run.status !== 'EXECUTING') return
        const now = this.dependencies.clock.now().toISOString()
        const policy = transitionRun(transaction.run, 'PAGE_REVIEW')
        transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'EXECUTING', to: 'PAGE_REVIEW' },
        })
      })
    }
    const finalRun = await this.dependencies.repository.getRun(runId)
    return {
      status: finalRun?.status ?? 'FAILED',
      completed: completed.length,
      total: requirements.length,
      artifactIds: completed.map((step) => this.artifactId(step)!),
    }
  }

  private artifactId(step: StepRecord) {
    const output = step.output as { artifactId?: unknown } | null
    return output && typeof output.artifactId === 'string' ? output.artifactId : null
  }

  private async completedSummary(runId: string, total: number, status: RunRecord['status']) {
    const completed = (await this.dependencies.repository.listSteps(runId))
      .filter((step) => step.tool === 'generate_slide_image' && step.status === 'COMPLETED' && this.artifactId(step))
    return {
      status,
      completed: completed.length,
      total,
      artifactIds: completed.map((step) => this.artifactId(step)!),
    }
  }

  private async pauseForBudget(run: RunRecord, requiredBudgetUnits: number) {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      if (transaction.run.status === 'PAUSED') return transaction.run
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'PAUSED')
      const updated: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      transaction.putRun(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.paused',
        payload: {
          reason: `BUDGET_REQUIRED:${requiredBudgetUnits}`,
          resumeState: 'EXECUTING',
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'BUDGET', summary: `剩余页面预计需要 ${requiredBudgetUnits} 预算单位，请追加预算或取消。` },
      })
      return updated
    })
  }

  private async requireHuman(runId: string, step: StepRecord) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      if (transaction.run.status === 'NEEDS_HUMAN') return
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: transaction.run.status, to: 'NEEDS_HUMAN', reason: step.errorCode ?? 'IMAGE_SUBMISSION_FAILED' },
      })
    })
  }

  private async appendProgress(runId: string, stepId: string, completed: number, total: number) {
    await this.dependencies.repository.transact(runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.progress',
        payload: { stepId, completed, total, summary: `已安全提交 ${completed}/${total} 页图片任务` },
      })
    })
  }
}

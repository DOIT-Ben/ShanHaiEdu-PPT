import { CONTRACT_VERSION } from '../contracts'
import { revisionPlanSchema } from '../presentation-contracts'
import { getActiveBlueprint } from './active-blueprint'
import { blueprintImageRequirements } from './blueprint-assets'
import { hashInput } from './hash'
import { MediaStepRunner } from './media-step-runner'
import type { AgentRepository, ClockPort, RunRecord, StepRecord } from './ports'
import { evaluateBudget, transitionRun } from './policy'
import { revisionPlanStepKey } from './revision-planning-runner'

export type RevisionMediaResult = Readonly<{
  status: RunRecord['status']
  completed: number
  submitted: number
  total: number
}>

export class RevisionMediaCoordinator {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    media: MediaStepRunner
    clock: ClockPort
  }>) {}

  async submit(runId: string, unitBudgetUnits: number): Promise<RevisionMediaResult> {
    if (!Number.isSafeInteger(unitBudgetUnits) || unitBudgetUnits <= 0) throw new Error('INVALID_UNIT_BUDGET')
    const run = await this.requireRun(runId)
    if (run.status === 'PAUSED' || run.status === 'NEEDS_HUMAN') return this.summary(run)
    if (run.status !== 'REVISING') throw new Error('RUN_NOT_REVISING')
    const targets = await this.targets(run)
    if (targets.length === 0) throw new Error('REVISION_MEDIA_NOT_REQUIRED')
    const steps = await this.currentSteps(run, targets)
    const keys = new Set(steps.map((step) => step.idempotencyKey))
    const pending = targets.filter((target) => !keys.has(target.idempotencyKey))
    const decision = evaluateBudget(run, pending.length * unitBudgetUnits)
    if (pending.length > 0 && !decision.allowed && decision.reason === 'BUDGET_EXCEEDED') {
      await this.pauseForBudget(run, pending.length * unitBudgetUnits)
      return { status: 'PAUSED', completed: 0, submitted: steps.length, total: targets.length }
    }
    if (pending.length > 0 && !decision.allowed) throw new Error(decision.reason)

    let submitted = steps.length
    for (const target of pending) {
      const key = target.idempotencyKey
      const result = await this.dependencies.media.submitSlideImage({
        runId,
        stepId: target.stepId,
        idempotencyKey: key,
        slideId: target.slideId,
        versionId: target.versionId,
        prompt: target.prompt,
        ...(target.negativePrompt ? { negativePrompt: target.negativePrompt } : {}),
        model: run.imageModel,
        budgetUnits: unitBudgetUnits,
        aspectRatio: target.aspectRatio,
        backgroundMode: target.backgroundMode,
        ...(target.elementId ? { elementId: target.elementId } : {}),
        ...(target.assetReuseKey ? { assetReuseKey: target.assetReuseKey } : {}),
      })
      if (['WAITING', 'COMPLETED'].includes(result.step.status)) submitted += 1
      const latest = await this.dependencies.repository.getRun(runId)
      if (!latest || latest.status === 'NEEDS_HUMAN' || latest.status === 'PAUSED') break
    }
    const latest = await this.requireRun(runId)
    return { status: latest.status, completed: 0, submitted, total: targets.length }
  }

  async refresh(runId: string): Promise<RevisionMediaResult> {
    const run = await this.requireRun(runId)
    const targets = await this.targets(run)
    if (run.status === 'PAGE_REVIEW') return this.summary(run)
    if (run.status !== 'REVISING') return this.summary(run)
    const steps = await this.currentSteps(run, targets)
    for (const step of steps.filter((candidate) => candidate.status === 'WAITING')) {
      await this.dependencies.media.refreshSlideImage(runId, step.idempotencyKey)
      const latest = await this.requireRun(runId)
      if (latest.status === 'NEEDS_HUMAN') break
    }
    const refreshed = await this.currentSteps(run, targets)
    const failed = refreshed.find((step) => ['FAILED', 'RESERVATION_UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(step.status))
    const completed = refreshed.filter((step) => step.status === 'COMPLETED' && this.artifactId(step)).length
    const latest = await this.requireRun(runId)
    if (!failed && completed === targets.length && latest.status === 'REVISING') {
      await this.dependencies.repository.transact(runId, (transaction) => {
        const now = this.dependencies.clock.now().toISOString()
        const policy = transitionRun(transaction.run, 'PAGE_REVIEW')
        transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'REVISING', to: 'PAGE_REVIEW' },
        })
      })
    }
    const finalRun = await this.requireRun(runId)
    return { status: finalRun.status, completed, submitted: refreshed.length, total: targets.length }
  }

  private async targets(run: RunRecord) {
    const blueprint = await getActiveBlueprint(this.dependencies.repository, run.id, run.revisionRound)
    const step = (await this.dependencies.repository.listSteps(run.id))
      .find((candidate) => candidate.idempotencyKey === revisionPlanStepKey(run.id, run.revisionRound)
        && candidate.status === 'COMPLETED')
    if (!step) throw new Error('REVISION_PLAN_NOT_READY')
    const plan = revisionPlanSchema.parse(step.output)
    if (blueprint.renderMode === 'LAYERED_COURSEWARE_V3') {
      const requirements = blueprintImageRequirements(run, blueprint)
      const targets = plan.operations.filter((operation) => operation.kind === 'REGENERATE_IMAGE').map((operation) => {
        const pageNumber = Number(operation.slideId.split(':').at(-1))
        const slide = blueprint.slides[pageNumber - 1]
        if (!slide?.layeredDesign || !operation.targetElementId) throw new Error('REVISION_TARGET_ELEMENT_REQUIRED')
        const element = slide.layeredDesign.elements.find((candidate) => candidate.kind === 'IMAGE'
          && candidate.elementId === operation.targetElementId)
        if (!element || element.kind !== 'IMAGE') throw new Error('REVISION_TARGET_ELEMENT_INVALID')
        const assetKey = element.reuseKey ? `reuse:${element.reuseKey}` : `slide:${pageNumber}:element:${element.elementId}`
        const requirement = requirements.find((candidate) => candidate.assetKey === assetKey)
        if (!requirement) throw new Error('REVISION_ASSET_REQUIREMENT_NOT_FOUND')
        return {
          pageNumber,
          elementId: element.elementId,
          assetReuseKey: element.reuseKey ?? null,
          idempotencyKey: requirement.idempotencyKey,
          stepId: `step-${run.id}-asset-${hashInput(assetKey).slice(0, 20)}-r${run.revisionRound}`,
          slideId: `${run.id}:slide:${pageNumber}`,
          versionId: `${run.id}:slide:${pageNumber}:element:${element.elementId}:r${run.revisionRound}:v1`,
          prompt: `${element.prompt} Quality correction: ${operation.instruction}`.slice(0, 3_000),
          negativePrompt: element.negativePrompt,
          aspectRatio: element.aspectRatio,
          backgroundMode: element.backgroundMode,
        }
      })
      return [...new Map(targets.map((target) => [target.idempotencyKey, target])).values()]
    }
    const byPage = new Map<number, string[]>()
    for (const operation of plan.operations.filter((item) => item.kind === 'REGENERATE_IMAGE' || item.kind === 'RELAYOUT')) {
      const pageNumber = Number(operation.slideId.split(':').at(-1))
      byPage.set(pageNumber, [...(byPage.get(pageNumber) ?? []), operation.instruction])
    }
    return [...byPage].map(([pageNumber, instructions]) => {
      const slide = blueprint.slides[pageNumber - 1]
      if (!slide) throw new Error('REVISION_PLAN_SLIDE_REFERENCE_INVALID')
      return {
        pageNumber,
        elementId: null,
        assetReuseKey: null,
        idempotencyKey: this.imageKey(run, pageNumber),
        stepId: `step-${run.id}-slide-${pageNumber}-image-r${run.revisionRound}`,
        slideId: `${run.id}:slide:${pageNumber}`,
        versionId: `${run.id}:slide:${pageNumber}:r${run.revisionRound}:v1`,
        prompt: `${slide.visualPrompt} Quality correction: ${instructions.join(' ')}`.slice(0, 3_000),
        negativePrompt: null,
        aspectRatio: '16:9' as const,
        backgroundMode: 'OPAQUE' as const,
      }
    })
  }

  private async currentSteps(run: RunRecord, targets: readonly Readonly<{ idempotencyKey: string }>[]) {
    const keys = new Set(targets.map((target) => target.idempotencyKey))
    return (await this.dependencies.repository.listSteps(run.id))
      .filter((step) => step.tool === 'generate_slide_image' && keys.has(step.idempotencyKey))
  }

  private imageKey(run: RunRecord, pageNumber: number) {
    return `${run.id}:slide:${pageNumber}:image:r${run.revisionRound}:v1`
  }

  private artifactId(step: StepRecord) {
    const output = step.output as { artifactId?: unknown } | null
    return output && typeof output.artifactId === 'string' ? output.artifactId : null
  }

  private async summary(run: RunRecord): Promise<RevisionMediaResult> {
    const targets = await this.targets(run)
    const steps = await this.currentSteps(run, targets)
    return {
      status: run.status,
      completed: steps.filter((step) => step.status === 'COMPLETED' && this.artifactId(step)).length,
      submitted: steps.length,
      total: targets.length,
    }
  }

  private async pauseForBudget(run: RunRecord, required: number) {
    await this.dependencies.repository.transact(run.id, (transaction) => {
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'PAUSED')
      transaction.putRun({ ...transaction.run, ...policy, updatedAt: now })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.paused',
        payload: { reason: `BUDGET_REQUIRED:${required}`, resumeState: 'REVISING' },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'BUDGET', summary: `局部重绘预计需要 ${required} 预算单位，请追加预算或取消。` },
      })
    })
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }
}

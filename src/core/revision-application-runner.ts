import { CONTRACT_VERSION } from '../contracts'
import {
  blueprintDraftSchema,
  presentationBlueprintSchema,
  revisionPlanSchema,
  type BlueprintDraft,
  type PresentationBlueprint,
  type RevisionPlan,
} from '../presentation-contracts'
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
} from './ports'
import { transitionRun } from './policy'
import { revisionPlanStepKey } from './revision-planning-runner'

export type RevisionApplicationResult = Readonly<{
  status: RunRecord['status']
  step: StepRecord
  blueprint: PresentationBlueprint | null
  requiresMedia: boolean
  replayed: boolean
}>

export class RevisionApplicationRunner {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    documents: DocumentPort
    application: RevisionApplicationPort
    clock: ClockPort
  }>) {}

  async apply(runId: string): Promise<RevisionApplicationResult> {
    const run = await this.requireRun(runId)
    if (run.revisionRound < 1) throw new Error('REVISION_ROUND_NOT_STARTED')
    const base = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound - 1)
    const plan = await this.requirePlan(run)
    let sourceChunks: readonly SourceChunk[]
    try {
      const document = await this.dependencies.documents.resolve({ host: run.host, source: run.source })
      if (!document.isComplete) throw new Error('SOURCE_INCOMPLETE')
      sourceChunks = document.chunks
    } catch (error) {
      return this.failBeforeApply(run, error instanceof Error ? error.message : 'REVISION_INPUT_FAILED')
    }
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
      const raw = await this.dependencies.application.apply({
        tenantId: run.host.tenantId,
        blueprint: base,
        plan,
        sourceChunks,
        idempotencyKey,
      })
      const draft = inheritSourceLineage(base, blueprintDraftSchema.parse(raw))
      this.validateRevision(run.id, base, draft, plan, sourceChunks)
      const blueprint = presentationBlueprintSchema.parse({
        ...draft,
        id: `${run.id}:blueprint:r${run.revisionRound}`,
        visualDirection: base.visualDirection,
        ...(base.renderMode ? { renderMode: base.renderMode } : {}),
        ...(base.coverDesignMode ? { coverDesignMode: base.coverDesignMode } : {}),
        sourceManifest: base.sourceManifest,
        sourceAssets: base.sourceAssets,
        createdAt: this.dependencies.clock.now().toISOString(),
      })
      return this.complete(run, idempotencyKey, blueprint, plan)
    } catch {
      return this.fail(run, idempotencyKey, 'REVISION_APPLICATION_FAILED', plan)
    }
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
        return null
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
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'phase.changed',
          payload: { from: 'REVISING', to: 'DECK_REVIEW' },
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
    return prepared ?? this.fail(run, key, errorCode, plan)
  }

  private async fail(run: RunRecord, key: string, errorCode: string, plan: RevisionPlan): Promise<RevisionApplicationResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(key)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updatedStep: StepRecord = { ...step, status: 'FAILED', errorCode, updatedAt: now }
      transaction.putStep(updatedStep)
      transaction.putRun(updatedRun)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode, retryable: false },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'REVISING', to: 'NEEDS_HUMAN', reason: errorCode },
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
      validateLayeredRevisionScope(previous, revised, operations)
    }
  }
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
    if (kinds.has('UPDATE_CONTENT') && before.kind === 'TEXT' && next.kind === 'TEXT') {
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

export function requiresRevisionMedia(plan: RevisionPlan, blueprint?: PresentationBlueprint) {
  if (blueprint?.renderMode === 'LAYERED_COURSEWARE_V3') {
    return plan.operations.some((operation) => operation.kind === 'REGENERATE_IMAGE')
  }
  return plan.operations.some((operation) => operation.kind === 'REGENERATE_IMAGE' || operation.kind === 'RELAYOUT')
}

import type { CreateRunRequest } from '../contracts'
import { CONTRACT_VERSION } from '../contracts'
import {
  blueprintDraftSchema,
  presentationBlueprintSchema,
  type PresentationBlueprint,
} from '../presentation-contracts'
import { hashInput } from './hash'
import type {
  AgentRepository,
  ClockPort,
  DocumentPort,
  DocumentResult,
  RunRecord,
  StepRecord,
  StructuredModelPort,
} from './ports'
import { transitionRun } from './policy'

export type PlanPresentationInput = Readonly<{
  runId: string
  stepId: string
  idempotencyKey: string
  source: CreateRunRequest['source']
  slideCount: number
  visualDirection: string
  presentationMode?: CreateRunRequest['presentationMode']
  coverDesignMode?: CreateRunRequest['coverDesignMode']
  maxVisualAssetsPerSlide?: CreateRunRequest['maxVisualAssetsPerSlide']
}>

export type PlanPresentationResult = Readonly<{
  step: StepRecord
  blueprint: PresentationBlueprint | null
  replayed: boolean
}>

export function planningStepKey(runId: string) {
  return `${runId}:blueprint:v1`
}

export class PlanningRunner {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    documents: DocumentPort
    model: StructuredModelPort
    clock: ClockPort
  }>) {}

  async plan(input: PlanPresentationInput): Promise<PlanPresentationResult> {
    const run = await this.requireRun(input.runId)
    const document = await this.dependencies.documents.resolve({ host: run.host, source: input.source })
    const prepared = await this.prepare(input, document)
    if (prepared.replayed) return prepared

    if (!document.isComplete || document.chunks.length === 0) {
      const step = await this.fail(input, 'SOURCE_INCOMPLETE', 'SOURCE_INCOMPLETE', document)
      return { step, blueprint: null, replayed: false }
    }

    try {
      const raw = await this.dependencies.model.execute({
        operation: 'create_blueprint',
        schemaName: 'ppt_agent_blueprint_v1',
        idempotencyKey: input.idempotencyKey,
        payload: {
          slideCount: input.slideCount,
          visualDirection: input.visualDirection,
          presentationMode: input.presentationMode ?? 'SLIDE_IMAGE_V2',
          coverDesignMode: input.coverDesignMode ?? 'INDEPENDENT',
          maxVisualAssetsPerSlide: input.maxVisualAssetsPerSlide ?? 4,
          document: {
            name: document.name,
            chunks: document.chunks.map((chunk) => ({ id: chunk.id, sha256: chunk.sha256, text: chunk.text })),
          },
        },
      })
      const draft = blueprintDraftSchema.parse(raw)
      this.assertBlueprintCoverage(
        draft,
        document,
        input.slideCount,
        input.presentationMode ?? 'SLIDE_IMAGE_V2',
        input.maxVisualAssetsPerSlide ?? 4,
      )
      const now = this.dependencies.clock.now().toISOString()
      const blueprint = presentationBlueprintSchema.parse({
        ...draft,
        id: `blueprint-${hashInput({ runId: input.runId, inputHash: prepared.step.inputHash }).slice(0, 28)}`,
        visualDirection: input.visualDirection,
        renderMode: input.presentationMode ?? 'SLIDE_IMAGE_V2',
        coverDesignMode: input.coverDesignMode ?? 'INDEPENDENT',
        createdAt: now,
      })
      const step = await this.complete(input, blueprint)
      return { step, blueprint, replayed: false }
    } catch (error) {
      const errorCode = error instanceof Error && error.message === 'BLUEPRINT_SOURCE_REFERENCE_INVALID'
        ? 'BLUEPRINT_SOURCE_REFERENCE_INVALID'
        : error instanceof Error && error.message === 'BLUEPRINT_SLIDE_COUNT_MISMATCH'
          ? 'BLUEPRINT_SLIDE_COUNT_MISMATCH'
          : 'BLUEPRINT_MODEL_OUTPUT_INVALID'
      const step = await this.fail(input, errorCode, 'PLANNING_FAILED', document)
      return { step, blueprint: null, replayed: false }
    }
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }

  private async prepare(input: PlanPresentationInput, document: DocumentResult): Promise<PlanPresentationResult & { run: RunRecord }> {
    const inputHash = hashInput({
      tool: 'create_blueprint',
      slideCount: input.slideCount,
      visualDirection: input.visualDirection,
      presentationMode: input.presentationMode ?? 'SLIDE_IMAGE_V2',
      coverDesignMode: input.coverDesignMode ?? 'INDEPENDENT',
      maxVisualAssetsPerSlide: input.maxVisualAssetsPerSlide ?? 4,
      document: {
        name: document.name,
        isComplete: document.isComplete,
        missingRanges: document.missingRanges,
        chunks: document.chunks.map((chunk) => ({ id: chunk.id, sha256: chunk.sha256 })),
      },
    })

    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const existing = transaction.getStep(input.idempotencyKey)
      if (existing) {
        if (existing.id !== input.stepId || existing.inputHash !== inputHash || existing.tool !== 'create_blueprint') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        if (existing.status === 'COMPLETED') {
          const blueprint = presentationBlueprintSchema.parse(existing.output)
          return { run: transaction.run, step: existing, blueprint, replayed: true }
        }
        if (existing.status === 'FAILED') {
          return { run: transaction.run, step: existing, blueprint: null, replayed: true }
        }
        return { run: transaction.run, step: existing, blueprint: null, replayed: false }
      }
      if (transaction.run.status !== 'PLANNING') throw new Error('RUN_NOT_PLANNING')

      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: input.stepId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        inputHash,
        tool: 'create_blueprint',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: now,
        updatedAt: now,
      }
      const updatedRun = { ...transaction.run, updatedAt: now }
      transaction.putRun(updatedRun)
      transaction.putStep(step)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.started',
        payload: { stepId: step.id, tool: step.tool, label: '分析教材并规划逐页蓝图' },
      })
      return { run: updatedRun, step, blueprint: null, replayed: false }
    })
  }

  private assertBlueprintCoverage(
    draft: ReturnType<typeof blueprintDraftSchema.parse>,
    document: DocumentResult,
    slideCount: number,
    presentationMode: CreateRunRequest['presentationMode'],
    maxVisualAssetsPerSlide: number,
  ) {
    if (draft.slides.length !== slideCount) throw new Error('BLUEPRINT_SLIDE_COUNT_MISMATCH')
    const available = new Set(document.chunks.map((chunk) => chunk.id))
    const cited = new Set([...draft.curriculum.sourceChunkIds, ...draft.slides.flatMap((slide) => slide.sourceChunkIds)])
    if ([...cited].some((id) => !available.has(id))) throw new Error('BLUEPRINT_SOURCE_REFERENCE_INVALID')
    if (document.chunks.some((chunk) => !draft.curriculum.sourceChunkIds.includes(chunk.id))) {
      throw new Error('BLUEPRINT_SOURCE_REFERENCE_INVALID')
    }
    if (presentationMode === 'LAYERED_COURSEWARE_V3' && draft.slides.some((slide) =>
      !slide.layeredDesign || slide.layeredDesign.elements.filter((element) =>
        element.kind === 'IMAGE' && element.role !== 'BASE_LAYER').length > maxVisualAssetsPerSlide)) {
      throw new Error('BLUEPRINT_VISUAL_ASSET_LIMIT_EXCEEDED')
    }
  }

  private async complete(input: PlanPresentationInput, blueprint: PresentationBlueprint) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'COMPLETED') return step
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'AWAITING_BLUEPRINT_APPROVAL')
      const run: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updated: StepRecord = { ...step, status: 'COMPLETED', output: blueprint, errorCode: null, updatedAt: now }
      transaction.putRun(run)
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: step.id, summary: `已生成 ${blueprint.slides.length} 页教学蓝图` },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PLANNING', to: 'AWAITING_BLUEPRINT_APPROVAL' },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'approval.required',
        payload: { kind: 'BLUEPRINT', summary: `请确认《${blueprint.title}》的 ${blueprint.slides.length} 页蓝图` },
      })
      return updated
    })
  }

  private async fail(
    input: PlanPresentationInput,
    errorCode: string,
    issueCategory: 'SOURCE_INCOMPLETE' | 'PLANNING_FAILED',
    document: DocumentResult,
  ) {
    return this.dependencies.repository.transact(input.runId, (transaction) => {
      const step = transaction.getStep(input.idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      if (step.status === 'FAILED') return step
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'NEEDS_HUMAN')
      const run: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updated: StepRecord = { ...step, status: 'FAILED', errorCode, updatedAt: now }
      transaction.putRun(run)
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode, retryable: false },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: `${step.id}:planning-failed`,
          category: issueCategory,
          severity: 'CRITICAL',
          summary: issueCategory === 'SOURCE_INCOMPLETE'
            ? `教材内容不完整：${document.missingRanges.join('；') || '没有可用内容'}`
            : '教材蓝图未通过结构或来源校验，需要人工处理。',
          slideIds: [],
          sourceChunkIds: document.chunks.map((chunk) => chunk.id),
          status: 'OPEN',
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PLANNING', to: 'NEEDS_HUMAN', reason: errorCode },
      })
      return updated
    })
  }
}

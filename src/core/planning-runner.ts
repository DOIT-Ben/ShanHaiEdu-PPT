import type { CreateRunRequest, PlanningFailure } from '../contracts'
import { CONTRACT_VERSION } from '../contracts'
import { ZodError } from 'zod'
import {
  blueprintDraftSchema,
  presentationBlueprintSchema,
  type PresentationBlueprint,
} from '../presentation-contracts'
import { hashInput } from './hash'
import { StructuredModelError } from './ports'
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

const MAX_BLUEPRINT_CONTRACT_ATTEMPTS = 5
const MAX_PROVIDER_ATTEMPTS = 3
const PROVIDER_RETRY_DELAYS_MS = [250, 1_000] as const

class PlanningFailureError extends Error {
  constructor(readonly failure: PlanningFailure) {
    super(failure.errorCode)
    this.name = 'PlanningFailureError'
  }
}

export type PlanPresentationInput = Readonly<{
  runId: string
  stepId: string
  idempotencyKey: string
  source: CreateRunRequest['source']
  slideCount: number
  visualDirection: string
  presentationMode?: CreateRunRequest['presentationMode']
  coverDesignMode?: CreateRunRequest['coverDesignMode']
  assetAcquisitionPolicy?: CreateRunRequest['assetAcquisitionPolicy']
  maxVisualAssetsPerSlide?: CreateRunRequest['maxVisualAssetsPerSlide']
  attempt?: number
}>

export type PlanPresentationResult = Readonly<{
  step: StepRecord
  blueprint: PresentationBlueprint | null
  replayed: boolean
}>

export function planningStepKey(runId: string, attempt = 0) {
  return attempt === 0 ? `${runId}:blueprint:v1` : `${runId}:blueprint:retry:${attempt}`
}

export class PlanningRunner {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    documents: DocumentPort
    model: StructuredModelPort
    clock: ClockPort
    sleep?: (milliseconds: number) => Promise<void>
  }>) {}

  async plan(input: PlanPresentationInput): Promise<PlanPresentationResult> {
    const run = await this.requireRun(input.runId)
    const document = await this.dependencies.documents.resolve({ host: run.host, source: input.source })
    const prepared = await this.prepare(input, document)
    if (prepared.replayed) return prepared

    if (!document.isComplete || document.chunks.length === 0) {
      const step = await this.fail(input, this.sourceFailure(input), 'SOURCE_INCOMPLETE', document)
      return { step, blueprint: null, replayed: false }
    }

    try {
      const blueprint = await this.createBlueprint(input, document, prepared.step.inputHash, run.host.tenantId)
      const step = await this.complete(input, blueprint)
      return { step, blueprint, replayed: false }
    } catch (error) {
      const failure = error instanceof PlanningFailureError
        ? error.failure
        : this.contractFailure(input, error, 1, 1, false)
      const step = await this.fail(input, failure, 'PLANNING_FAILED', document)
      return { step, blueprint: null, replayed: false }
    }
  }

  private async createBlueprint(input: PlanPresentationInput, document: DocumentResult, inputHash: string, tenantId: string) {
    const basePayload = {
      slideCount: input.slideCount,
      visualDirection: input.visualDirection,
      presentationMode: input.presentationMode ?? 'SLIDE_IMAGE_V2',
      coverDesignMode: input.coverDesignMode ?? 'INDEPENDENT',
      assetAcquisitionPolicy: input.assetAcquisitionPolicy ?? 'AI_FIRST',
      maxVisualAssetsPerSlide: input.maxVisualAssetsPerSlide ?? 4,
      document: {
        name: document.name,
        sources: document.sources ?? [],
        chunks: document.chunks.map((chunk) => ({
          id: chunk.id,
          sourceId: chunk.sourceId,
          sha256: chunk.sha256,
          text: chunk.text,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          region: chunk.region,
        })),
        assets: (document.assets ?? []).map(({ bytes: _bytes, ...asset }) => asset),
      },
    }
    let repairIssues: { path: string; message: string }[] = []
    for (let attempt = 0; attempt < MAX_BLUEPRINT_CONTRACT_ATTEMPTS; attempt++) {
      try {
        const modelKey = attempt === 0
          ? input.idempotencyKey
          : `blueprint-repair-${hashInput({ idempotencyKey: input.idempotencyKey, attempt })}`
        const raw = await this.executeWithProviderRetry(input, {
          tenantId,
          operation: 'create_blueprint',
          schemaName: 'ppt_agent_blueprint_v1',
          idempotencyKey: modelKey,
          payload: { ...basePayload, ...(repairIssues.length > 0 ? { contractRepairIssues: repairIssues } : {}) },
          sourceAssets: document.assets ?? [],
        })
        const draft = blueprintDraftSchema.parse(raw)
        this.assertBlueprintCoverage(
          draft,
          document,
          input.slideCount,
          input.presentationMode ?? 'SLIDE_IMAGE_V2',
          input.maxVisualAssetsPerSlide ?? 4,
        )
        return presentationBlueprintSchema.parse({
          ...draft,
          id: `blueprint-${hashInput({ runId: input.runId, inputHash }).slice(0, 28)}`,
          visualDirection: input.visualDirection,
          renderMode: input.presentationMode ?? 'SLIDE_IMAGE_V2',
          coverDesignMode: input.coverDesignMode ?? 'INDEPENDENT',
          sourceManifest: document.sources ?? [],
          sourceAssets: (document.assets ?? []).map(({ bytes: _bytes, ...asset }) => asset),
          createdAt: this.dependencies.clock.now().toISOString(),
        })
      } catch (error) {
        if (error instanceof PlanningFailureError) throw error
        const issues = this.contractIssues(error)
        if (!issues) throw new PlanningFailureError(this.contractFailure(input, error, attempt + 1, MAX_BLUEPRINT_CONTRACT_ATTEMPTS, false))
        if (attempt === MAX_BLUEPRINT_CONTRACT_ATTEMPTS - 1) {
          throw new PlanningFailureError(this.contractFailure(
            input,
            error,
            attempt + 1,
            MAX_BLUEPRINT_CONTRACT_ATTEMPTS,
            true,
          ))
        }
        repairIssues = issues
      }
    }
    throw new Error('BLUEPRINT_CONTRACT_REPAIR_EXHAUSTED')
  }

  private async executeWithProviderRetry(
    input: PlanPresentationInput,
    request: Parameters<StructuredModelPort['execute']>[0],
  ) {
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
      try {
        return await this.dependencies.model.execute(request)
      } catch (error) {
        const failure = this.providerFailure(input, error, attempt)
        if (!failure) throw error
        if (!failure.retryable || attempt === MAX_PROVIDER_ATTEMPTS) throw new PlanningFailureError(failure)
        await this.recordProviderRetry(input, failure, attempt + 1)
        await (this.dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
          PROVIDER_RETRY_DELAYS_MS[attempt - 1] ?? PROVIDER_RETRY_DELAYS_MS.at(-1)!,
        )
      }
    }
    throw new Error('PROVIDER_RETRY_LOOP_INVALID')
  }

  private providerFailure(input: PlanPresentationInput, error: unknown, attempt: number): PlanningFailure | null {
    if (!(error instanceof StructuredModelError) || error.code === 'MODEL_JSON_INVALID') return null
    return {
      errorCode: error.code,
      retryable: error.retryable,
      attempt,
      maxAttempts: MAX_PROVIDER_ATTEMPTS,
      suggestedAction: error.retryable ? 'RETRY' : 'CONTACT_ADMIN',
      diagnosticCode: error.code,
      fieldPaths: [],
      correlationId: this.correlationId(input),
      requestId: error.requestId ?? this.traceRequestId(input),
      model: error.model,
      contractVersion: CONTRACT_VERSION,
    }
  }

  private sourceFailure(input: PlanPresentationInput): PlanningFailure {
    return {
      errorCode: 'SOURCE_INCOMPLETE',
      retryable: false,
      attempt: 0,
      maxAttempts: 0,
      suggestedAction: 'MODIFY_SOURCE',
      diagnosticCode: 'SOURCE_INCOMPLETE',
      fieldPaths: ['source'],
      correlationId: this.correlationId(input),
      requestId: this.traceRequestId(input),
      model: this.dependencies.model.modelName ?? null,
      contractVersion: CONTRACT_VERSION,
    }
  }

  private contractFailure(
    input: PlanPresentationInput,
    error: unknown,
    attempt: number,
    maxAttempts: number,
    exhausted: boolean,
  ): PlanningFailure {
    const fieldPaths = error instanceof ZodError
      ? [...new Set(error.issues.map((issue) => issue.path.join('.') || 'blueprint'))].slice(0, 20)
      : error instanceof StructuredModelError && error.code === 'MODEL_JSON_INVALID'
        ? ['blueprint']
        : []
    const message = error instanceof Error ? error.message : ''
    const errorCode: PlanningFailure['errorCode'] = error instanceof ZodError
      ? input.presentationMode === 'LAYERED_COURSEWARE_V3' && error.issues.some((issue) =>
        issue.path.includes('layeredDesign') || issue.path.includes('elements'))
        ? 'V3_LAYER_CONTRACT_INVALID'
        : 'BLUEPRINT_SCHEMA_INVALID'
      : message === 'BLUEPRINT_SLIDE_COUNT_MISMATCH'
        ? 'BLUEPRINT_SLIDE_COUNT_MISMATCH'
        : message === 'BLUEPRINT_SOURCE_REFERENCE_INVALID'
          ? 'BLUEPRINT_SOURCE_REFERENCE_INVALID'
          : message === 'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID'
            ? 'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID'
            : message === 'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE'
              ? 'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE'
          : message === 'BLUEPRINT_VISUAL_ASSET_LIMIT_EXCEEDED'
            ? 'VISUAL_ASSET_LIMIT_EXCEEDED'
            : message === 'LAYERED_BLUEPRINT_SCHEMA_INVALID'
              ? 'V3_LAYER_CONTRACT_INVALID'
              : message === 'MODEL_JSON_INVALID' || error instanceof SyntaxError
                ? 'MODEL_JSON_INVALID'
                : 'BLUEPRINT_SCHEMA_INVALID'
    const retryable = [
      'MODEL_JSON_INVALID',
      'BLUEPRINT_SLIDE_COUNT_MISMATCH',
      'BLUEPRINT_SOURCE_REFERENCE_INVALID',
      'BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID',
      'BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE',
    ]
      .includes(errorCode)
    return {
      errorCode,
      ...(exhausted ? { terminalCode: 'CONTRACT_REPAIR_EXHAUSTED' as const } : {}),
      retryable,
      attempt,
      maxAttempts,
      suggestedAction: retryable ? 'RETRY' : 'CONTACT_ADMIN',
      diagnosticCode: errorCode,
      fieldPaths,
      correlationId: this.correlationId(input),
      requestId: error instanceof StructuredModelError
        ? error.requestId ?? this.traceRequestId(input)
        : this.traceRequestId(input),
      model: error instanceof StructuredModelError
        ? error.model
        : this.dependencies.model.modelName ?? null,
      contractVersion: CONTRACT_VERSION,
    }
  }

  private correlationId(input: PlanPresentationInput) {
    return `plan-${hashInput({ runId: input.runId, stepId: input.stepId, idempotencyKey: input.idempotencyKey }).slice(0, 28)}`
  }

  private traceRequestId(input: PlanPresentationInput) {
    return `plan-request-${hashInput({ runId: input.runId, idempotencyKey: input.idempotencyKey }).slice(0, 24)}`
  }

  private async recordProviderRetry(input: PlanPresentationInput, failure: PlanningFailure, nextAttempt: number) {
    await this.dependencies.repository.transact(input.runId, (transaction) => {
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.progress',
        payload: {
          stepId: input.stepId,
          completed: failure.attempt,
          total: failure.maxAttempts,
          summary: `规划模型暂时不可用，准备自动重试 ${nextAttempt}/${failure.maxAttempts}`,
        },
      })
    })
  }

  private contractIssues(error: unknown) {
    if (error instanceof ZodError) {
      return error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }))
    }
    if (error instanceof Error && (error.message.startsWith('BLUEPRINT_') || error.message === 'LAYERED_BLUEPRINT_SCHEMA_INVALID')) {
      return [{ path: 'blueprint', message: error.message }]
    }
    if (error instanceof StructuredModelError && error.code === 'MODEL_JSON_INVALID') {
      return [{ path: 'blueprint', message: error.code }]
    }
    return null
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
      assetAcquisitionPolicy: input.assetAcquisitionPolicy ?? 'AI_FIRST',
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
    const availableAssets = new Set((document.assets ?? []).map((asset) => asset.id))
    const curriculumAssets = draft.curriculum.sourceAssetIds ?? []
    const mappedAssets = new Set([
      ...draft.slides.flatMap((slide) => slide.sourceAssetIds ?? []),
      ...draft.slides.flatMap((slide) => slide.layeredDesign?.elements.flatMap((element) =>
        element.kind === 'IMAGE' || element.kind === 'TEXT' ? element.sourceAssetIds ?? [] : []) ?? []),
    ])
    const citedAssets = new Set([...curriculumAssets, ...mappedAssets])
    if ([...citedAssets].some((id) => !availableAssets.has(id))) throw new Error('BLUEPRINT_SOURCE_ASSET_REFERENCE_INVALID')
    if ([...availableAssets].some((id) => !curriculumAssets.includes(id) || !mappedAssets.has(id))) {
      throw new Error('BLUEPRINT_SOURCE_ASSET_MAPPING_INCOMPLETE')
    }
    if (presentationMode === 'LAYERED_COURSEWARE_V3' && draft.slides.some((slide) => !slide.layeredDesign)) {
      throw new Error('LAYERED_BLUEPRINT_SCHEMA_INVALID')
    }
    if (presentationMode === 'LAYERED_COURSEWARE_V3' && draft.slides.some((slide) =>
      slide.layeredDesign!.elements.filter((element) =>
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
      const attempt = input.attempt ?? 0
      if (attempt > 0) {
        const previous = transaction.getStep(planningStepKey(input.runId, attempt - 1))
        if (previous?.status === 'FAILED') {
          transaction.appendEvent({
            schemaVersion: CONTRACT_VERSION,
            type: 'issue.resolved',
            payload: { issueId: `${previous.id}:planning-failed`, resolution: 'FIXED' },
          })
        }
      }
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
    failure: PlanningFailure,
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
      const updated: StepRecord = { ...step, status: 'FAILED', errorCode: failure.errorCode, updatedAt: now }
      transaction.putRun(run)
      transaction.putStep(updated)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode: failure.errorCode, retryable: failure.retryable },
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
            : this.failureSummary(failure),
          slideIds: [],
          sourceChunkIds: document.chunks.map((chunk) => chunk.id),
          status: 'OPEN',
          planningFailure: failure,
        },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'PLANNING', to: 'NEEDS_HUMAN', reason: failure.errorCode },
      })
      return updated
    })
  }

  private failureSummary(failure: PlanningFailure) {
    if (failure.suggestedAction === 'RETRY') {
      return `规划暂时失败（${failure.errorCode}），系统已尝试 ${failure.attempt}/${failure.maxAttempts} 次，可以按原参数重试。`
    }
    if (failure.suggestedAction === 'MODIFY_SOURCE') {
      return '教材内容不完整，请补充或替换教材后重新规划。'
    }
    return `蓝图合同校验失败（${failure.errorCode}），系统已尝试修复 ${failure.attempt}/${failure.maxAttempts} 次，请联系管理员检查模型或合同版本。`
  }
}

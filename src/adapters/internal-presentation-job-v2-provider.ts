import { createHash } from 'node:crypto'
import type { RunService } from '../core/run-service'
import type {
  AgentRepository,
  ArtifactPort,
  RunRecord,
  StepRecord,
} from '../core/ports'
import {
  PRESENTATION_JOB_V2_PPTX_MIME_TYPE,
  type PresentationJobV2Owner,
  type PresentationJobV2ProviderPort,
} from '../core/presentation-job-v2-ports'
import {
  PRESENTATION_JOB_V2_MAX_BILLABLE_IMAGE_OPERATIONS_PER_PAGE,
  type PresentationJobV2UsageSummary,
} from '../presentation-job-v2-contracts'
import { storedGenerationBatchSchema } from '../generation-batch-contracts'

const INTERNAL_MODEL = 'nanobanana'

function digest(...values: readonly string[]) {
  return createHash('sha256').update(values.join('\0')).digest('hex')
}

function bounded(value: string, maximum: number) {
  return value.trim().slice(0, maximum)
}

function internalIdentity(owner: PresentationJobV2Owner) {
  return {
    externalUserId: `v2-user-${digest(owner.tenantId, owner.externalUserId).slice(0, 32)}`,
    ...(owner.externalProjectId ? {
      externalProjectId: `v2-project-${digest(owner.tenantId, owner.externalProjectId).slice(0, 32)}`,
    } : {}),
  }
}

function batchReleasedOperationKeys(steps: readonly StepRecord[]) {
  const released = new Set<string>()
  for (const batchStep of steps) {
    if (batchStep.tool !== 'generate_image_batch') continue
    const parsed = storedGenerationBatchSchema.safeParse(batchStep.output)
    if (!parsed.success || !['SETTLED', 'RELEASED'].includes(parsed.data.accounting.settlement)
      || parsed.data.accounting.reconciliationUnits !== 0) continue
    const pageKeys = new Set(parsed.data.pages.map((page) => page.idempotencyKey))
    const mediaSteps = steps.filter((step) => step.tool === 'generate_slide_image' && pageKeys.has(step.idempotencyKey))
    const settledUnits = mediaSteps
      .filter((step) => ['COMPLETED', 'COMPLETED_AFTER_CANCEL', 'FAILED_CHARGED'].includes(step.status))
      .reduce((total, step) => total + step.budgetUnits, 0)
    const releasedUnits = mediaSteps
      .filter((step) => ['FAILED', 'FAILED_NOT_CHARGED'].includes(step.status))
      .reduce((total, step) => total + step.budgetUnits, 0)
    if (parsed.data.accounting.settledUnits !== settledUnits
      || parsed.data.accounting.releasedUnits !== releasedUnits) continue
    for (const step of mediaSteps) {
      if (step.status === 'FAILED' && step.externalOperationId) released.add(step.idempotencyKey)
    }
  }
  return released
}

function operationKind(step: StepRecord, releasedOperationKeys: ReadonlySet<string>) {
  if (['COMPLETED', 'COMPLETED_AFTER_CANCEL', 'FAILED_CHARGED'].includes(step.status)) return 'billable' as const
  if (step.status === 'FAILED_NOT_CHARGED') return 'notCharged' as const
  if (['BILLING_UNKNOWN', 'SUBMISSION_UNKNOWN', 'RESERVATION_UNKNOWN'].includes(step.status)) return 'unknown' as const
  if (['WAITING', 'SUBMITTING'].includes(step.status)) {
    return 'unknown' as const
  }
  if (step.status === 'FAILED' && step.externalOperationId) {
    return releasedOperationKeys.has(step.idempotencyKey) ? 'notCharged' as const : 'unknown' as const
  }
  return null
}

function operationModel(step: StepRecord, fallback: string) {
  const output = step.output && typeof step.output === 'object'
    ? step.output as { model?: unknown }
    : null
  return typeof output?.model === 'string' && output.model.trim() ? output.model.trim() : fallback
}

function usageSummary(run: RunRecord, steps: readonly StepRecord[]): PresentationJobV2UsageSummary {
  const releasedOperationKeys = batchReleasedOperationKeys(steps)
  const models = new Map<string, {
    model: string
    billableImageOperations: number
    notChargedImageOperations: number
    unknownImageOperations: number
  }>()
  for (const step of steps) {
    if (step.tool !== 'generate_slide_image') continue
    const kind = operationKind(step, releasedOperationKeys)
    if (!kind) continue
    const model = operationModel(step, run.imageModel)
    const entry = models.get(model) ?? {
      model,
      billableImageOperations: 0,
      notChargedImageOperations: 0,
      unknownImageOperations: 0,
    }
    if (kind === 'billable') entry.billableImageOperations += 1
    if (kind === 'notCharged') entry.notChargedImageOperations += 1
    if (kind === 'unknown') entry.unknownImageOperations += 1
    models.set(model, entry)
  }
  const byModel = [...models.values()].sort((left, right) => left.model.localeCompare(right.model))
  return byModel.reduce((summary, entry) => ({
    billableImageOperations: summary.billableImageOperations + entry.billableImageOperations,
    notChargedImageOperations: summary.notChargedImageOperations + entry.notChargedImageOperations,
    unknownImageOperations: summary.unknownImageOperations + entry.unknownImageOperations,
    byModel,
  }), {
    billableImageOperations: 0,
    notChargedImageOperations: 0,
    unknownImageOperations: 0,
    byModel,
  })
}

function operationCount(usage: PresentationJobV2UsageSummary) {
  return usage.billableImageOperations + usage.notChargedImageOperations + usage.unknownImageOperations
}

export function presentationJobV2InternalTenantId(publicTenantId: string) {
  if (!publicTenantId.trim() || publicTenantId !== publicTenantId.trim()) {
    throw new Error('PRESENTATION_JOB_V2_PUBLIC_TENANT_INVALID')
  }
  return `presentation-job-v2-${digest(publicTenantId).slice(0, 32)}`
}

export class InternalPresentationJobV2Provider implements PresentationJobV2ProviderPort {
  constructor(private readonly dependencies: Readonly<{
    runs: Pick<RunService, 'create'>
    repository: AgentRepository
    artifacts: ArtifactPort
    internalTenantId: string
  }>) {}

  async submit(input: Parameters<PresentationJobV2ProviderPort['submit']>[0]) {
    const snapshot = input.source.snapshot
    const expectedMaximum = snapshot.pages.length
      * PRESENTATION_JOB_V2_MAX_BILLABLE_IMAGE_OPERATIONS_PER_PAGE
    if (input.maximumBillableImageOperations !== expectedMaximum) {
      throw new Error('PRESENTATION_PROVIDER_OPERATION_CAP_MISMATCH')
    }
    const focus = bounded(snapshot.objectives.join('；'), 1_000)
    const style = bounded(snapshot.pages.flatMap((page) => [
      page.layoutIntent,
      ...page.visualRequirements,
    ]).join('；'), 1_000)
    const identity = internalIdentity(input.owner)
    const created = await this.dependencies.runs.create({
      schemaVersion: '1',
      host: {
        tenantId: this.dependencies.internalTenantId,
        ...identity,
      },
      source: {
        kind: 'APPROVED_PAGE_DESIGN',
        artifactVersionId: input.source.artifactVersionId,
        artifactContentHash: input.source.sha256,
        ...snapshot,
      },
      slideCount: snapshot.pages.length,
      visualDirection: style || '严格遵循已审核逐页设计稿的视觉方向',
      targetAudience: snapshot.audience,
      presentationGoal: focus,
      imageModel: INTERNAL_MODEL,
      automationLevel: 'BOUNDED_AUTO',
      budgetUnits: input.maximumBillableImageOperations,
      maxRevisionRounds: 4,
      presentationMode: 'VISUAL_DECK_V4',
      coverDesignMode: 'INDEPENDENT',
      assetAcquisitionPolicy: 'AI_FIRST',
      maxVisualAssetsPerSlide: 4,
      visualDeckV4: {
        instruction: bounded(`根据已审核逐页设计稿制作《${snapshot.title}》完整课堂演示文稿。`, 4_000),
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: {
          deckType: 'DETAILED_DECK',
          language: 'zh-CN',
          length: { slideCount: snapshot.pages.length },
          aspectRatio: '16:9',
          audience: snapshot.audience,
          focus,
          styleHint: style || '严格遵循已审核逐页设计稿',
        },
      },
    }, input.idempotencyKey)
    return { operationId: created.run.id }
  }

  async inspect(input: Parameters<PresentationJobV2ProviderPort['inspect']>[0]) {
    const run = await this.dependencies.repository.getRun(input.operationId)
    if (!run || run.host.tenantId !== this.dependencies.internalTenantId) {
      return { state: 'FAILED' as const, errorCode: 'PRESENTATION_OPERATION_NOT_FOUND', usage: this.unknownUsage() }
    }
    const steps = await this.dependencies.repository.listSteps(run.id)
    const usage = usageSummary(run, steps)
    if (operationCount(usage) > run.budgetUnits) {
      return { state: 'FAILED' as const, errorCode: 'PROVIDER_USAGE_CAP_EXCEEDED', usage }
    }
    if (run.status === 'COMPLETED') return await this.completed(run, usage)
    if (['FAILED', 'CANCELLED', 'NEEDS_HUMAN', 'PAUSED'].includes(run.status)) {
      const terminal = await this.dependencies.repository.getTerminalEvent(run.id)
      const errorCode = terminal?.type === 'run.failed'
        ? terminal.payload.errorCode
        : run.status === 'CANCELLED'
          ? 'PRESENTATION_OPERATION_CANCELLED'
          : 'PRESENTATION_OPERATION_REQUIRES_INTERNAL_REVIEW'
      return { state: 'FAILED' as const, errorCode, usage }
    }
    return { state: 'RUNNING' as const }
  }

  private async completed(run: RunRecord, usage: PresentationJobV2UsageSummary) {
    const delivery = (await this.dependencies.repository.listDeliveries(run.id)).at(-1)
    if (!delivery) return { state: 'FAILED' as const, errorCode: 'PRESENTATION_DELIVERY_MISSING', usage }
    const stored = await this.dependencies.artifacts.get({
      tenantId: this.dependencies.internalTenantId,
      artifactId: delivery.pptx.artifactId,
    })
    if (!stored || stored.mimeType !== PRESENTATION_JOB_V2_PPTX_MIME_TYPE
      || stored.sha256 !== delivery.pptx.sha256 || stored.bytes.length !== delivery.pptx.byteLength) {
      return { state: 'FAILED' as const, errorCode: 'PRESENTATION_DELIVERY_INVALID', usage }
    }
    const quality = delivery.qualityStatus === 'APPROVED'
      ? 'PASSED' as const
      : delivery.qualityStatus === 'SYSTEM_POLICY_ACCEPTED'
        ? 'BEST_EFFORT' as const
        : 'BLOCKING_FAILURE' as const
    return {
      state: 'COMPLETED' as const,
      quality,
      usage,
      artifact: {
        bytes: stored.bytes,
        name: delivery.pptx.name,
        mimeType: PRESENTATION_JOB_V2_PPTX_MIME_TYPE,
      },
    }
  }

  private unknownUsage(): PresentationJobV2UsageSummary {
    return {
      billableImageOperations: 0,
      notChargedImageOperations: 0,
      unknownImageOperations: 1,
      byModel: [{
        model: INTERNAL_MODEL,
        billableImageOperations: 0,
        notChargedImageOperations: 0,
        unknownImageOperations: 1,
      }],
    }
  }
}

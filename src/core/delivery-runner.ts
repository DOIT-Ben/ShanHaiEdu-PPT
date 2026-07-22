import { CONTRACT_VERSION } from '../contracts'
import {
  deliveryRecordSchema,
  webAssetProvenanceSchema,
  type DeliveryRecord,
} from '../presentation-contracts'
import { hashInput } from './hash'
import { getActiveBlueprint } from './active-blueprint'
import { loadPresentationSlides, requirePresentationArtifactReferences } from './presentation-render-input'
import type {
  AgentRepository,
  ArtifactPort,
  ClockPort,
  PresentationRendererPort,
  RunRecord,
  StepRecord,
} from './ports'
import { transitionRun } from './policy'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const

export type DeliveryResult = Readonly<{
  status: RunRecord['status']
  step: StepRecord
  delivery: DeliveryRecord | null
  replayed: boolean
}>

export class DeliveryRunner {
  constructor(private readonly dependencies: Readonly<{
    repository: AgentRepository
    artifacts: ArtifactPort
    renderer: PresentationRendererPort
    clock: ClockPort
  }>) {}

  async deliver(runId: string): Promise<DeliveryResult> {
    const run = await this.requireRun(runId)
    const blueprint = await getActiveBlueprint(this.dependencies.repository, runId, run.revisionRound)
    let slideArtifacts: Awaited<ReturnType<typeof requirePresentationArtifactReferences>>
    try {
      slideArtifacts = await requirePresentationArtifactReferences(this.dependencies.repository, run, blueprint)
    } catch (error) {
      return this.failBeforeRender(run, error instanceof Error ? error.message : 'DELIVERY_INPUT_FAILED')
    }
    const idempotencyKey = deliveryStepKey(run)
    const inputHash = hashInput({ tool: 'deliver_presentation', blueprint, slideArtifacts })
    const prepared = await this.prepare(run, idempotencyKey, inputHash)
    if (prepared) return prepared

    try {
      const slides = await loadPresentationSlides(this.dependencies.artifacts, run, slideArtifacts)
      const previewBytes = await this.dependencies.renderer.renderPreview({ blueprint, slides })
      const pptxBytes = await this.dependencies.renderer.renderPptx({ blueprint, slides })
      if (previewBytes.length === 0 || pptxBytes.length === 0) throw new Error('DELIVERY_RENDER_EMPTY')

      const previewName = 'presentation-preview.png'
      const pptxName = 'presentation.pptx'
      const sourcesName = 'asset-sources.json'
      const provenances = await this.webAssetProvenances(runId)
      const sourcesBytes = new TextEncoder().encode(JSON.stringify({
        schemaVersion: CONTRACT_VERSION,
        runId,
        generatedAt: this.dependencies.clock.now().toISOString(),
        assets: provenances,
      }, null, 2))
      const preview = await this.dependencies.artifacts.put({
        tenantId: run.host.tenantId,
        runId,
        name: previewName,
        mimeType: 'image/png',
        bytes: previewBytes,
        idempotencyKey: `${idempotencyKey}:preview`,
      })
      const pptx = await this.dependencies.artifacts.put({
        tenantId: run.host.tenantId,
        runId,
        name: pptxName,
        mimeType: PPTX_MIME,
        bytes: pptxBytes,
        idempotencyKey: `${idempotencyKey}:pptx`,
      })
      const sources = await this.dependencies.artifacts.put({
        tenantId: run.host.tenantId,
        runId,
        name: sourcesName,
        mimeType: 'application/json',
        bytes: sourcesBytes,
        idempotencyKey: `${idempotencyKey}:sources`,
      })
      const delivery = deliveryRecordSchema.parse({
        id: `${run.id}:delivery:r${run.revisionRound}`,
        runId,
        revisionRound: run.revisionRound,
        qualityScore: run.qualityScore,
        qualityOverride: run.qualityOverride,
        qualityOverrideAudit: run.qualityOverride
          && run.qualityOverrideBy
          && run.qualityOverrideRole
          && run.qualityOverrideReason
          && run.qualityOverrideIssueIds?.length
          && run.qualityOverrideAt
          ? {
              actorId: run.qualityOverrideBy,
              actorRole: run.qualityOverrideRole,
              reason: run.qualityOverrideReason,
              issueIds: run.qualityOverrideIssueIds,
              acceptedAt: run.qualityOverrideAt,
            }
          : null,
        preview: {
          artifactId: preview.artifactId,
          name: previewName,
          mimeType: 'image/png',
          sha256: preview.sha256,
          byteLength: previewBytes.length,
        },
        pptx: {
          artifactId: pptx.artifactId,
          name: pptxName,
          mimeType: PPTX_MIME,
          sha256: pptx.sha256,
          byteLength: pptxBytes.length,
        },
        sources: {
          artifactId: sources.artifactId,
          name: sourcesName,
          mimeType: 'application/json',
          sha256: sources.sha256,
          byteLength: sourcesBytes.length,
        },
        createdAt: this.dependencies.clock.now().toISOString(),
      })
      return this.complete(run, idempotencyKey, delivery)
    } catch {
      return this.fail(run, idempotencyKey, 'DELIVERY_FAILED')
    }
  }

  private async prepare(run: RunRecord, idempotencyKey: string, inputHash: string) {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const existing = transaction.getStep(idempotencyKey)
      if (existing) {
        if (existing.inputHash !== inputHash || existing.tool !== 'deliver_presentation') {
          throw new Error('STEP_IDEMPOTENCY_CONFLICT')
        }
        if (existing.status === 'COMPLETED') {
          return {
            status: transaction.run.status,
            step: existing,
            delivery: deliveryRecordSchema.parse(existing.output),
            replayed: true,
          }
        }
        if (existing.status === 'FAILED') {
          return { status: transaction.run.status, step: existing, delivery: null, replayed: true }
        }
        return null
      }
      if (transaction.run.status !== 'DELIVERING') throw new Error('RUN_NOT_DELIVERING')
      const now = this.dependencies.clock.now().toISOString()
      const step: StepRecord = {
        id: `step-${run.id}-delivery-r${run.revisionRound}`,
        runId: run.id,
        idempotencyKey,
        inputHash,
        tool: 'deliver_presentation',
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
        payload: { stepId: step.id, tool: step.tool, label: '生成 PNG 预览和可编辑 PPTX' },
      })
      return null
    })
  }

  private async complete(run: RunRecord, idempotencyKey: string, delivery: DeliveryRecord): Promise<DeliveryResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'COMPLETED')
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updatedStep: StepRecord = { ...step, status: 'COMPLETED', output: delivery, errorCode: null, updatedAt: now }
      transaction.putDelivery(delivery)
      transaction.putStep(updatedStep)
      transaction.putRun(updatedRun)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: step.id, summary: 'PNG 预览和可编辑 PPTX 已生成' },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.completed',
        payload: { deliveryId: delivery.id, qualityOverride: delivery.qualityOverride },
      })
      return { status: updatedRun.status, step: updatedStep, delivery, replayed: false }
    })
  }

  private async failBeforeRender(run: RunRecord, errorCode: string): Promise<DeliveryResult> {
    const idempotencyKey = deliveryStepKey(run)
    const inputHash = hashInput({ tool: 'deliver_presentation', revisionRound: run.revisionRound, errorCode })
    const prepared = await this.prepare(run, idempotencyKey, inputHash)
    if (prepared) return prepared
    return this.fail(run, idempotencyKey, errorCode)
  }

  private async fail(run: RunRecord, idempotencyKey: string, errorCode: string): Promise<DeliveryResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
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
        payload: { stepId: step.id, errorCode, retryable: true },
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'DELIVERING', to: 'NEEDS_HUMAN', reason: errorCode },
      })
      return { status: updatedRun.status, step: updatedStep, delivery: null, replayed: false }
    })
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.repository.getRun(runId)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }

  private async webAssetProvenances(runId: string) {
    const values = (await this.dependencies.repository.listSteps(runId)).flatMap((step) => {
      const output = step.output as { provenance?: unknown } | null
      const parsed = webAssetProvenanceSchema.safeParse(output?.provenance)
      return parsed.success ? [parsed.data] : []
    })
    return [...new Map(values.map((value) => [value.sha256, value])).values()]
  }

}

export function deliveryStepKey(run: Pick<RunRecord, 'id' | 'revisionRound'>) {
  return `${run.id}:delivery:r${run.revisionRound}`
}

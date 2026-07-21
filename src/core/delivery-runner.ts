import { CONTRACT_VERSION } from '../contracts'
import {
  deliveryRecordSchema,
  type DeliveryRecord,
  type PresentationBlueprint,
} from '../presentation-contracts'
import { hashInput } from './hash'
import { getActiveBlueprint } from './active-blueprint'
import { blueprintImageRequirements, latestCompletedAssetStep } from './blueprint-assets'
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

type SlideArtifact = Readonly<{
  pageNumber: number
  artifactId: string
  assets?: readonly Readonly<{ elementId: string; artifactId: string }>[]
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
    let slideArtifacts: readonly SlideArtifact[]
    try {
      slideArtifacts = await this.requireSlideArtifacts(run, blueprint)
    } catch (error) {
      return this.failBeforeRender(run, error instanceof Error ? error.message : 'DELIVERY_INPUT_FAILED')
    }
    const idempotencyKey = deliveryStepKey(run)
    const inputHash = hashInput({ tool: 'deliver_presentation', blueprint, slideArtifacts })
    const prepared = await this.prepare(run, idempotencyKey, inputHash)
    if (prepared) return prepared

    try {
      const slides = []
      for (const item of slideArtifacts) {
        const artifact = await this.dependencies.artifacts.get({
          tenantId: run.host.tenantId,
          artifactId: item.artifactId,
        })
        if (!artifact || !artifact.mimeType.startsWith('image/') || artifact.bytes.length === 0) {
          throw new Error('DELIVERY_SOURCE_ARTIFACT_NOT_FOUND')
        }
        const assets = []
        for (const assetReference of item.assets ?? []) {
          const asset = await this.dependencies.artifacts.get({
            tenantId: run.host.tenantId,
            artifactId: assetReference.artifactId,
          })
          if (!asset || !asset.mimeType.startsWith('image/') || asset.bytes.length === 0) {
            throw new Error('DELIVERY_LAYER_ARTIFACT_NOT_FOUND')
          }
          assets.push({ elementId: assetReference.elementId, image: asset.bytes, imageMimeType: asset.mimeType })
        }
        slides.push({
          pageNumber: item.pageNumber,
          image: artifact.bytes,
          imageMimeType: artifact.mimeType,
          ...(assets.length > 0 ? { assets } : {}),
        })
      }
      const previewBytes = await this.dependencies.renderer.renderPreview({ blueprint, slides })
      const pptxBytes = await this.dependencies.renderer.renderPptx({ blueprint, slides })
      if (previewBytes.length === 0 || pptxBytes.length === 0) throw new Error('DELIVERY_RENDER_EMPTY')

      const previewName = 'presentation-preview.png'
      const pptxName = 'presentation.pptx'
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
      const delivery = deliveryRecordSchema.parse({
        id: `${run.id}:delivery:r${run.revisionRound}`,
        runId,
        revisionRound: run.revisionRound,
        qualityScore: run.qualityScore,
        qualityOverride: run.qualityOverride,
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

  private async requireSlideArtifacts(run: RunRecord, blueprint: PresentationBlueprint): Promise<readonly SlideArtifact[]> {
    const steps = (await this.dependencies.repository.listSteps(run.id))
      .filter((step) => step.tool === 'generate_slide_image' && step.status === 'COMPLETED')
    if (blueprint.renderMode === 'LAYERED_COURSEWARE_V3') {
      const requirements = blueprintImageRequirements(run, blueprint)
      const artifactByAssetKey = new Map(requirements.map((requirement) => {
        const step = latestCompletedAssetStep(steps, requirement, run.revisionRound)
        const output = step ? this.imageOutput(step) : null
        if (!output) throw new Error('LAYER_ARTIFACT_NOT_FOUND')
        return [requirement.assetKey, output.artifactId]
      }))
      return blueprint.slides.map((slide) => {
        if (!slide.layeredDesign) throw new Error('LAYERED_DESIGN_MISSING')
        const assets = slide.layeredDesign.elements
          .filter((element): element is Extract<(typeof slide.layeredDesign.elements)[number], { kind: 'IMAGE' }> => element.kind === 'IMAGE')
          .map((element) => {
            const assetKey = element.reuseKey ? `reuse:${element.reuseKey}` : `slide:${slide.pageNumber}:element:${element.elementId}`
            const artifactId = artifactByAssetKey.get(assetKey)
            if (!artifactId) throw new Error('LAYER_ARTIFACT_NOT_FOUND')
            return { elementId: element.elementId, artifactId }
          })
        const baseElementId = slide.layeredDesign.elements.find((element) => element.kind === 'IMAGE' && element.role === 'BASE_LAYER')?.elementId
        const base = assets.find((asset) => asset.elementId === baseElementId)
        if (!base) throw new Error('BASE_LAYER_ARTIFACT_NOT_FOUND')
        return { pageNumber: slide.pageNumber, artifactId: base.artifactId, assets }
      })
    }
    return blueprint.slides.map((slide) => {
      const slideId = `${run.id}:slide:${slide.pageNumber}`
      const candidates = steps.map((step) => this.imageOutput(step))
        .filter((output): output is NonNullable<typeof output> => output?.slideId === slideId)
        .filter((output) => output.round <= run.revisionRound)
        .sort((left, right) => right.round - left.round)
      if (!candidates[0]) throw new Error('PAGE_ARTIFACT_NOT_FOUND')
      return { pageNumber: slide.pageNumber, artifactId: candidates[0].artifactId }
    })
  }

  private imageOutput(step: StepRecord) {
    const output = step.output as { slideId?: unknown; versionId?: unknown; artifactId?: unknown } | null
    if (!output || typeof output.slideId !== 'string' || typeof output.versionId !== 'string' || typeof output.artifactId !== 'string') return null
    const round = /:r(\d+):/.exec(output.versionId)?.[1]
    return round === undefined ? null : { slideId: output.slideId, artifactId: output.artifactId, round: Number(round) }
  }
}

export function deliveryStepKey(run: Pick<RunRecord, 'id' | 'revisionRound'>) {
  return `${run.id}:delivery:r${run.revisionRound}`
}

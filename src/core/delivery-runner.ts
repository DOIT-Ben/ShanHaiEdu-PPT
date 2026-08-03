import { createHash } from 'node:crypto'
import { posix as posixPath } from 'node:path'
import JSZip from 'jszip'
import { SaxesParser, type SaxesTagNS } from 'saxes'
import sharp from 'sharp'
import { CONTRACT_VERSION } from '../contracts'
import {
  deliveryRecordSchema,
  webAssetProvenanceSchema,
  type DeliveryRecord,
} from '../presentation-contracts'
import { hashInput } from './hash'
import { getActiveBlueprint } from './active-blueprint'
import {
  loadPresentationSlides,
  renderAndStoreSlidePreviews,
  requirePresentationArtifactReferences,
} from './presentation-render-input'
import type {
  AgentRepository,
  ArtifactPort,
  ClockPort,
  PresentationRendererPort,
  RunRecord,
  StepRecord,
  TechnicalFailure,
} from './ports'
import { transitionRun } from './policy'
import {
  beginTechnicalRecovery,
  contractTechnicalFailure,
  providerTechnicalFailure,
} from './technical-recovery'
import { enqueueUsageV2RunFinalization } from './usage-v2-coordinator'
import {
  allPageNumbers,
  appendV4LifecycleEvent,
  isVisualDeckV4,
  qualityPolicyAuditForRun,
  V4_NON_BLOCKING_QUALITY_POLICY_ID,
  v4LifecyclePayload,
} from './v4-lifecycle'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const
const PREVIEW_NAME = 'presentation-preview.png'
const PPTX_NAME = 'presentation.pptx'
const SOURCES_NAME = 'asset-sources.json'
const ROOT_RELATIONSHIPS_PART = '_rels/.rels'
const PRESENTATION_PART = 'ppt/presentation.xml'
const PRESENTATION_RELATIONSHIPS_PART = 'ppt/_rels/presentation.xml.rels'
const PRESENTATION_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
])
const OFFICE_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
])
const PACKAGE_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
])
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
])
const SLIDE_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/slide',
])

type StoredFinalArtifact = Readonly<{
  artifactId: string
  mimeType: string
  bytes: Uint8Array
  sha256: string
}>

type StoredFinalArtifacts = Readonly<{
  preview: StoredFinalArtifact | null
  pptx: StoredFinalArtifact | null
  sources: StoredFinalArtifact | null
}>

function rendererTechnicalFailure(error: unknown): TechnicalFailure {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const hasExternalCode = typeof value?.code === 'string'
  const errorCode = hasExternalCode ? value.code as string : 'DELIVERY_FAILED'
  const httpStatus = typeof value?.status === 'number' && Number.isSafeInteger(value.status)
    ? value.status
    : undefined
  const disposition = typeof value?.retryable === 'boolean'
    ? value.retryable ? 'RETRYABLE' as const : 'NON_RETRYABLE' as const
    : hasExternalCode ? undefined : 'RETRYABLE' as const
  return providerTechnicalFailure(errorCode, {
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(disposition === undefined ? {} : { disposition }),
  })
}

function outputWithTechnicalFailure(output: unknown, technicalFailure: TechnicalFailure) {
  const persisted = output && typeof output === 'object' ? output as Record<string, unknown> : {}
  return { ...persisted, technicalFailure }
}

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
      const storedArtifacts = await this.loadStoredFinalArtifacts(run, idempotencyKey)
      if (storedArtifacts.preview && storedArtifacts.pptx && storedArtifacts.sources) {
        const delivery = await this.buildVerifiedDelivery(run, blueprint, {
          preview: storedArtifacts.preview,
          pptx: storedArtifacts.pptx,
          sources: storedArtifacts.sources,
        })
        return this.complete(run, idempotencyKey, delivery, blueprint)
      }
      const slides = await loadPresentationSlides(this.dependencies.artifacts, run, slideArtifacts)
      const previewArtifacts = await renderAndStoreSlidePreviews({
        artifacts: this.dependencies.artifacts,
        renderer: this.dependencies.renderer,
        run,
        blueprint,
        references: slideArtifacts,
      })
      const previewSlides = await Promise.all(previewArtifacts.map(async (preview) => {
        const artifact = await this.dependencies.artifacts.get({
          tenantId: run.host.tenantId,
          artifactId: preview.artifactId,
        })
        if (!artifact || artifact.mimeType !== 'image/png' || artifact.bytes.length === 0) {
          throw new Error('SLIDE_PREVIEW_ARTIFACT_MISSING')
        }
        return { pageNumber: preview.pageNumber, image: artifact.bytes }
      }))
      const previewBytes = await this.dependencies.renderer.renderPreviewFromSlidePreviews({ slides: previewSlides })
      const pptxBytes = await this.dependencies.renderer.renderPptx({ blueprint, slides })
      if (previewBytes.length === 0 || pptxBytes.length === 0) throw new Error('DELIVERY_RENDER_EMPTY')
      if (isVisualDeckV4(run)) {
        await assertReadableV4DeliveryArtifacts(previewBytes, pptxBytes, blueprint.slides.length)
      }

      const provenances = await this.webAssetProvenances(runId)
      const sourcesBytes = new TextEncoder().encode(JSON.stringify({
        schemaVersion: CONTRACT_VERSION,
        runId,
        generatedAt: this.dependencies.clock.now().toISOString(),
        assets: provenances,
      }, null, 2))
      const finalArtifacts = {
        preview: await this.storeOrReuseFinalArtifact({
          run,
          existing: storedArtifacts.preview,
          name: PREVIEW_NAME,
          mimeType: 'image/png',
          bytes: previewBytes,
          idempotencyKey: `${idempotencyKey}:preview`,
        }),
        pptx: await this.storeOrReuseFinalArtifact({
          run,
          existing: storedArtifacts.pptx,
          name: PPTX_NAME,
          mimeType: PPTX_MIME,
          bytes: pptxBytes,
          idempotencyKey: `${idempotencyKey}:pptx`,
        }),
        sources: await this.storeOrReuseFinalArtifact({
          run,
          existing: storedArtifacts.sources,
          name: SOURCES_NAME,
          mimeType: 'application/json',
          bytes: sourcesBytes,
          idempotencyKey: `${idempotencyKey}:sources`,
        }),
      }
      const delivery = await this.buildVerifiedDelivery(run, blueprint, finalArtifacts)
      return this.complete(run, idempotencyKey, delivery, blueprint)
    } catch (error) {
      return this.fail(run, idempotencyKey, rendererTechnicalFailure(error))
    }
  }

  private async loadStoredFinalArtifacts(run: RunRecord, idempotencyKey: string): Promise<StoredFinalArtifacts> {
    const [preview, pptx, sources] = await Promise.all([
      this.dependencies.artifacts.getByIdempotencyKey({
        tenantId: run.host.tenantId,
        idempotencyKey: `${idempotencyKey}:preview`,
      }),
      this.dependencies.artifacts.getByIdempotencyKey({
        tenantId: run.host.tenantId,
        idempotencyKey: `${idempotencyKey}:pptx`,
      }),
      this.dependencies.artifacts.getByIdempotencyKey({
        tenantId: run.host.tenantId,
        idempotencyKey: `${idempotencyKey}:sources`,
      }),
    ])
    return { preview, pptx, sources }
  }

  private async storeOrReuseFinalArtifact(input: Readonly<{
    run: RunRecord
    existing: StoredFinalArtifact | null
    name: string
    mimeType: string
    bytes: Uint8Array
    idempotencyKey: string
  }>): Promise<StoredFinalArtifact> {
    if (input.existing) {
      if (input.existing.mimeType !== input.mimeType || input.existing.bytes.length === 0) {
        throw new Error('FINAL_DELIVERY_ARTIFACT_INVALID')
      }
      return input.existing
    }
    const stored = await this.dependencies.artifacts.put({
      tenantId: input.run.host.tenantId,
      runId: input.run.id,
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.bytes,
      idempotencyKey: input.idempotencyKey,
    })
    return {
      artifactId: stored.artifactId,
      mimeType: input.mimeType,
      bytes: input.bytes,
      sha256: stored.sha256,
    }
  }

  private async buildVerifiedDelivery(
    run: RunRecord,
    blueprint: Awaited<ReturnType<typeof getActiveBlueprint>>,
    artifacts: Readonly<{
      preview: StoredFinalArtifact
      pptx: StoredFinalArtifact
      sources: StoredFinalArtifact
    }>,
  ) {
    if (artifacts.preview.mimeType !== 'image/png'
      || artifacts.pptx.mimeType !== PPTX_MIME
      || artifacts.sources.mimeType !== 'application/json'
      || artifacts.preview.bytes.length === 0
      || artifacts.pptx.bytes.length === 0
      || artifacts.sources.bytes.length === 0) {
      throw new Error('FINAL_DELIVERY_ARTIFACT_INVALID')
    }
    if (isVisualDeckV4(run)) {
      await assertReadableV4DeliveryArtifacts(
        artifacts.preview.bytes,
        artifacts.pptx.bytes,
        blueprint.slides.length,
      )
    }
    const qualityPolicyAudit = qualityPolicyAuditForRun(run)
    const delivery = deliveryRecordSchema.parse({
      id: `${run.id}:delivery:r${run.revisionRound}`,
      runId: run.id,
      revisionRound: run.revisionRound,
      qualityScore: run.qualityScore,
      qualityOverride: run.qualityOverride,
      disposition: 'FINAL',
      qualityStatus: qualityPolicyAudit
        ? 'SYSTEM_POLICY_ACCEPTED'
        : run.qualityOverride ? 'OVERRIDDEN_INTERNAL' : 'APPROVED',
      openIssueIds: run.qualityOverrideIssueIds ?? [],
      identity: {
        status: 'VERIFIED',
        slideCount: blueprint.slides.length,
        pageNumbers: blueprint.slides.map((slide) => slide.pageNumber),
        blueprintHash: hashInput(blueprint),
        ...(blueprint.visualDeckV4Proposal
          ? { proposalHash: hashInput(blueprint.visualDeckV4Proposal) }
          : {}),
      },
      qualityPolicyAudit,
      qualityOverrideAudit: !qualityPolicyAudit
        && run.qualityOverride
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
        artifactId: artifacts.preview.artifactId,
        name: PREVIEW_NAME,
        mimeType: 'image/png',
        sha256: artifacts.preview.sha256,
        byteLength: artifacts.preview.bytes.length,
      },
      pptx: {
        artifactId: artifacts.pptx.artifactId,
        name: PPTX_NAME,
        mimeType: PPTX_MIME,
        sha256: artifacts.pptx.sha256,
        byteLength: artifacts.pptx.bytes.length,
      },
      sources: {
        artifactId: artifacts.sources.artifactId,
        name: SOURCES_NAME,
        mimeType: 'application/json',
        sha256: artifacts.sources.sha256,
        byteLength: artifacts.sources.bytes.length,
      },
      ...(run.release ? { release: run.release } : {}),
      createdAt: this.dependencies.clock.now().toISOString(),
    })
    if (isVisualDeckV4(run)) {
      await assertStoredFinalDeliveryArtifacts(this.dependencies.artifacts, run, delivery)
    }
    return delivery
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
          if (transaction.run.status !== 'DELIVERING') {
            return { status: transaction.run.status, step: existing, delivery: null, replayed: true }
          }
          const now = this.dependencies.clock.now().toISOString()
          transaction.putStep({ ...existing, status: 'RUNNING', errorCode: null, updatedAt: now })
          transaction.appendEvent({
            schemaVersion: CONTRACT_VERSION,
            type: 'tool.started',
            payload: { stepId: existing.id, tool: existing.tool, label: '重试生成 PNG 预览和可编辑 PPTX' },
          })
          return null
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
      appendV4LifecycleEvent(transaction, 'delivery.started', {
        completed: 0,
        total: 1,
        pageNumbers: allPageNumbers(transaction.run),
      })
      return null
    })
  }

  private async complete(
    run: RunRecord,
    idempotencyKey: string,
    delivery: DeliveryRecord,
    blueprint: Awaited<ReturnType<typeof getActiveBlueprint>>,
  ): Promise<DeliveryResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      assertFinalDeliveryForCompletion(transaction.run, blueprint, delivery)
      const now = this.dependencies.clock.now().toISOString()
      const policy = transitionRun(transaction.run, 'COMPLETED')
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updatedStep: StepRecord = { ...step, status: 'COMPLETED', output: delivery, errorCode: null, updatedAt: now }
      transaction.putDelivery(delivery)
      transaction.putStep(updatedStep)
      transaction.putRun(updatedRun)
      enqueueUsageV2RunFinalization(transaction, this.dependencies.clock)
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.completed',
        payload: { stepId: step.id, summary: 'PNG 预览和可编辑 PPTX 已生成' },
      })
      appendV4LifecycleEvent(transaction, 'delivery.completed', {
        completed: 1,
        total: 1,
        pageNumbers: allPageNumbers(transaction.run),
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'run.completed',
        payload: isVisualDeckV4(updatedRun)
          ? {
              ...v4LifecyclePayload(updatedRun, 'RUN', {
                completed: 1,
                total: 1,
                pageNumbers: allPageNumbers(updatedRun),
              }),
              deliveryId: delivery.id,
              qualityOverride: delivery.qualityOverride,
            }
          : { deliveryId: delivery.id, qualityOverride: delivery.qualityOverride },
      })
      return { status: updatedRun.status, step: updatedStep, delivery, replayed: false }
    })
  }

  private async failBeforeRender(run: RunRecord, errorCode: string): Promise<DeliveryResult> {
    const idempotencyKey = deliveryStepKey(run)
    const inputHash = hashInput({ tool: 'deliver_presentation', revisionRound: run.revisionRound, errorCode })
    const prepared = await this.prepare(run, idempotencyKey, inputHash)
    if (prepared) return prepared
    return this.fail(run, idempotencyKey, contractTechnicalFailure(errorCode))
  }

  private async fail(
    run: RunRecord,
    idempotencyKey: string,
    technicalFailure: TechnicalFailure,
  ): Promise<DeliveryResult> {
    return this.dependencies.repository.transact(run.id, (transaction) => {
      const step = transaction.getStep(idempotencyKey)
      if (!step) throw new Error('STEP_NOT_FOUND')
      const now = this.dependencies.clock.now().toISOString()
      const errorCode = technicalFailure.diagnosticCode
      const v4TechnicalFailure = transaction.run.presentationMode === 'VISUAL_DECK_V4'
      const policy = v4TechnicalFailure ? transaction.run : transitionRun(transaction.run, 'NEEDS_HUMAN')
      const updatedRun: RunRecord = { ...transaction.run, ...policy, updatedAt: now }
      const updatedStep: StepRecord = {
        ...step,
        status: 'FAILED',
        errorCode,
        output: outputWithTechnicalFailure(step.output, technicalFailure),
        updatedAt: now,
      }
      transaction.putStep(updatedStep)
      if (!v4TechnicalFailure) transaction.putRun(updatedRun)
      const technicalRecovery = v4TechnicalFailure
        ? beginTechnicalRecovery(transaction, this.dependencies.clock, technicalFailure)
        : null
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'tool.failed',
        payload: { stepId: step.id, errorCode, retryable: technicalRecovery?.technicalRecovery?.retryable ?? true },
      })
      if (technicalRecovery) {
        const events = transaction.listEvents()
        const started = [...events].reverse().find((event) => event.type === 'delivery.started')
        const completed = [...events].reverse().find((event) => event.type === 'delivery.completed')
        const stageAlreadyClosed = completed && (!started || completed.sequence > started.sequence)
        if (!stageAlreadyClosed && transaction.run.status !== 'FAILED') {
          appendV4LifecycleEvent(transaction, 'delivery.completed', {
            completed: 0,
            total: 1,
            pageNumbers: allPageNumbers(transaction.run),
            reason: 'DELIVERY_FAILED',
            retryable: technicalRecovery.technicalRecovery?.retryable ?? false,
          })
        }
        return { status: transaction.run.status, step: updatedStep, delivery: null, replayed: false }
      }
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'phase.changed',
        payload: { from: 'DELIVERING', to: 'NEEDS_HUMAN', reason: errorCode },
      })
      appendV4LifecycleEvent(transaction, 'delivery.completed', {
        completed: 0,
        total: 1,
        pageNumbers: allPageNumbers(transaction.run),
        reason: 'DELIVERY_FAILED',
        retryable: true,
        requiresUserAction: true,
        nextAction: 'RETRY',
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

async function assertReadableV4DeliveryArtifacts(
  previewBytes: Uint8Array,
  pptxBytes: Uint8Array,
  expectedSlideCount: number,
) {
  const preview = sharp(previewBytes, { failOn: 'error' })
  const metadata = await preview.metadata()
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw new Error('FINAL_PREVIEW_INVALID')
  }
  await preview.raw().toBuffer()

  const archive = await JSZip.loadAsync(pptxBytes, { checkCRC32: true, createFolders: false })
  const requiredEntries = [
    '[Content_Types].xml',
    ROOT_RELATIONSHIPS_PART,
    PRESENTATION_PART,
    PRESENTATION_RELATIONSHIPS_PART,
  ]
  if (requiredEntries.some((entry) => !archive.file(entry))) throw new Error('FINAL_PPTX_STRUCTURE_INVALID')
  const xmlParts = await parsePptxXmlParts(archive)
  const rootRelationships = parsePptxRelationships(xmlParts.get(ROOT_RELATIONSHIPS_PART)!, ROOT_RELATIONSHIPS_PART)
  const officeDocumentRelationships = rootRelationships.filter((relationship) =>
    OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(relationship.type))
  if (officeDocumentRelationships.length !== 1) throw new Error('FINAL_PPTX_ROOT_RELATIONSHIP_INVALID')
  const officeDocumentRelationship = officeDocumentRelationships[0]!
  if (officeDocumentRelationship.targetMode?.toUpperCase() === 'EXTERNAL'
    || resolvePptxRelationshipTarget(null, officeDocumentRelationship.target) !== PRESENTATION_PART) {
    throw new Error('FINAL_PPTX_ROOT_RELATIONSHIP_INVALID')
  }
  const slideEntries = Object.keys(archive.files)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  const expectedEntries = Array.from(
    { length: expectedSlideCount },
    (_, index) => `ppt/slides/slide${index + 1}.xml`,
  )
  if (JSON.stringify(slideEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error('FINAL_PPTX_SLIDE_COUNT_INVALID')
  }
  const slideRelationshipIds = parsePresentationSlideRelationshipIds(xmlParts.get(PRESENTATION_PART)!)
  if (slideRelationshipIds.length !== expectedSlideCount) throw new Error('FINAL_PPTX_SLIDE_COUNT_INVALID')
  const relationships = parsePptxRelationships(
    xmlParts.get(PRESENTATION_RELATIONSHIPS_PART)!,
    PRESENTATION_RELATIONSHIPS_PART,
  )
  const relationshipsById = new Map(relationships.map((relationship) => [relationship.id, relationship]))
  if (relationshipsById.size !== relationships.length) throw new Error('FINAL_PPTX_RELATIONSHIP_INVALID')

  const referencedIds = new Set(slideRelationshipIds)
  const slideRelationships = relationships.filter((relationship) => SLIDE_RELATIONSHIP_TYPES.has(relationship.type))
  if (slideRelationships.length !== slideRelationshipIds.length
    || slideRelationships.some((relationship) => !referencedIds.has(relationship.id))) {
    throw new Error('FINAL_PPTX_RELATIONSHIP_INVALID')
  }
  const referencedSlideEntries = slideRelationshipIds.map((relationshipId) => {
    const relationship = relationshipsById.get(relationshipId)
    if (!relationship
      || !SLIDE_RELATIONSHIP_TYPES.has(relationship.type)
      || relationship.targetMode?.toUpperCase() === 'EXTERNAL') {
      throw new Error('FINAL_PPTX_RELATIONSHIP_INVALID')
    }
    const target = resolvePptxRelationshipTarget(PRESENTATION_PART, relationship.target)
    if (!archive.file(target)) throw new Error('FINAL_PPTX_RELATIONSHIP_TARGET_MISSING')
    return target
  })
  if (JSON.stringify(referencedSlideEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error('FINAL_PPTX_SLIDE_SET_INVALID')
  }
}

type PptxRelationship = Readonly<{
  id: string
  type: string
  target: string
  targetMode: string | null
}>

async function parsePptxXmlParts(archive: JSZip) {
  const entries = Object.values(archive.files)
    .filter((entry) => !entry.dir && (entry.name.endsWith('.xml') || entry.name.endsWith('.rels')))
  const contents = await Promise.all(entries.map(async (entry) => [entry.name, await entry.async('string')] as const))
  for (const [name, xml] of contents) parseXmlPart(xml, name)
  return new Map(contents)
}

function parseXmlPart(
  xml: string,
  fileName: string,
  handlers: Readonly<{
    openTag?: (tag: SaxesTagNS) => void
    closeTag?: (tag: SaxesTagNS) => void
  }> = {},
) {
  if (xml.length === 0) throw new Error('FINAL_PPTX_XML_INVALID')
  const parser = new SaxesParser<{ xmlns: true; fileName: string }>({ xmlns: true, fileName })
  parser.on('doctype', () => {
    throw new Error('FINAL_PPTX_XML_DOCTYPE_INVALID')
  })
  if (handlers.openTag) parser.on('opentag', handlers.openTag)
  if (handlers.closeTag) parser.on('closetag', handlers.closeTag)
  parser.write(xml).close()
}

function parsePresentationSlideRelationshipIds(xml: string) {
  const relationshipIds: string[] = []
  let depth = 0
  let slideListDepth: number | null = null
  let sawPresentation = false
  let sawSlideList = false
  parseXmlPart(xml, PRESENTATION_PART, {
    openTag(tag) {
      depth += 1
      if (depth === 1) {
        if (tag.local !== 'presentation' || !PRESENTATION_NAMESPACES.has(tag.uri)) {
          throw new Error('FINAL_PPTX_PRESENTATION_INVALID')
        }
        sawPresentation = true
      } else if (depth === 2 && tag.local === 'sldIdLst' && PRESENTATION_NAMESPACES.has(tag.uri)) {
        if (sawSlideList) throw new Error('FINAL_PPTX_PRESENTATION_INVALID')
        sawSlideList = true
        slideListDepth = depth
      } else if (slideListDepth !== null
        && depth === slideListDepth + 1
        && tag.local === 'sldId'
        && PRESENTATION_NAMESPACES.has(tag.uri)) {
        const relationshipId = Object.values(tag.attributes)
          .find((attribute) => attribute.local === 'id'
            && OFFICE_RELATIONSHIP_NAMESPACES.has(attribute.uri))?.value
        if (!relationshipId) throw new Error('FINAL_PPTX_SLIDE_RELATIONSHIP_MISSING')
        relationshipIds.push(relationshipId)
      }
    },
    closeTag() {
      if (depth === slideListDepth) slideListDepth = null
      depth -= 1
    },
  })
  if (!sawPresentation || !sawSlideList || new Set(relationshipIds).size !== relationshipIds.length) {
    throw new Error('FINAL_PPTX_PRESENTATION_INVALID')
  }
  return relationshipIds
}

function parsePptxRelationships(xml: string, fileName: string) {
  const relationships: PptxRelationship[] = []
  let depth = 0
  let sawRelationships = false
  parseXmlPart(xml, fileName, {
    openTag(tag) {
      depth += 1
      if (depth === 1) {
        if (tag.local !== 'Relationships' || !PACKAGE_RELATIONSHIP_NAMESPACES.has(tag.uri)) {
          throw new Error('FINAL_PPTX_RELATIONSHIPS_INVALID')
        }
        sawRelationships = true
        return
      }
      if (depth !== 2 || tag.local !== 'Relationship' || !PACKAGE_RELATIONSHIP_NAMESPACES.has(tag.uri)) return
      const attributes = Object.values(tag.attributes)
      const value = (name: string) => attributes.find((attribute) => attribute.local === name && attribute.uri === '')?.value
      const id = value('Id')
      const type = value('Type')
      const target = value('Target')
      if (!id || !type || !target) throw new Error('FINAL_PPTX_RELATIONSHIP_INVALID')
      relationships.push({ id, type, target, targetMode: value('TargetMode') ?? null })
    },
    closeTag() {
      depth -= 1
    },
  })
  if (!sawRelationships) throw new Error('FINAL_PPTX_RELATIONSHIPS_INVALID')
  return relationships
}

function resolvePptxRelationshipTarget(sourcePart: string | null, rawTarget: string) {
  let target: string
  try {
    target = decodeURI(rawTarget)
  } catch {
    throw new Error('FINAL_PPTX_RELATIONSHIP_TARGET_INVALID')
  }
  if (!target || target.includes('\\') || target.includes('?') || target.includes('#')) {
    throw new Error('FINAL_PPTX_RELATIONSHIP_TARGET_INVALID')
  }
  const resolved = target.startsWith('/')
    ? posixPath.normalize(target.slice(1))
    : posixPath.normalize(sourcePart === null ? target : posixPath.join(posixPath.dirname(sourcePart), target))
  if (!resolved || resolved === '..' || resolved.startsWith('../') || posixPath.isAbsolute(resolved)) {
    throw new Error('FINAL_PPTX_RELATIONSHIP_TARGET_INVALID')
  }
  return resolved
}

async function assertStoredFinalDeliveryArtifacts(
  artifacts: ArtifactPort,
  run: RunRecord,
  delivery: DeliveryRecord,
) {
  for (const artifact of [delivery.preview, delivery.pptx, delivery.sources].filter((value) => value !== undefined)) {
    if (!artifacts.verifyIntegrity({
      tenantId: run.host.tenantId,
      artifactId: artifact.artifactId,
      mimeType: artifact.mimeType,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    })) throw new Error('FINAL_DELIVERY_ARTIFACT_INTEGRITY_INVALID')
    const stored = await artifacts.get({ tenantId: run.host.tenantId, artifactId: artifact.artifactId })
    const digest = stored ? createHash('sha256').update(stored.bytes).digest('hex') : null
    if (!stored
      || stored.mimeType !== artifact.mimeType
      || stored.bytes.length !== artifact.byteLength
      || stored.sha256 !== artifact.sha256
      || digest !== artifact.sha256) {
      throw new Error('FINAL_DELIVERY_ARTIFACT_READBACK_INVALID')
    }
  }
}

export function deliveryStepKey(run: Pick<RunRecord, 'id' | 'revisionRound'>) {
  return `${run.id}:delivery:r${run.revisionRound}`
}

export function assertFinalDeliveryForCompletion(
  run: RunRecord,
  blueprint: Awaited<ReturnType<typeof getActiveBlueprint>>,
  delivery: DeliveryRecord,
) {
  if (delivery.disposition !== 'FINAL' || delivery.identity.status !== 'VERIFIED') {
    throw new Error('FINAL_DELIVERY_IDENTITY_REQUIRED')
  }
  if (delivery.runId !== run.id || delivery.revisionRound !== run.revisionRound) {
    throw new Error('FINAL_DELIVERY_REVISION_MISMATCH')
  }
  const expectedPages = blueprint.slides.map((slide) => slide.pageNumber)
  if (delivery.identity.slideCount !== expectedPages.length
    || delivery.identity.pageNumbers.some((pageNumber, index) => pageNumber !== expectedPages[index])
    || delivery.identity.blueprintHash !== hashInput(blueprint)) {
    throw new Error('FINAL_DELIVERY_BLUEPRINT_MISMATCH')
  }
  const proposalHash = blueprint.visualDeckV4Proposal ? hashInput(blueprint.visualDeckV4Proposal) : undefined
  if (proposalHash !== delivery.identity.proposalHash) throw new Error('FINAL_DELIVERY_PROPOSAL_MISMATCH')
  if (delivery.qualityOverride) {
    if (delivery.qualityStatus === 'SYSTEM_POLICY_ACCEPTED') {
      if (!delivery.qualityPolicyAudit || delivery.qualityOverrideAudit) {
        throw new Error('FINAL_DELIVERY_POLICY_AUDIT_REQUIRED')
      }
      if (!isVisualDeckV4(run) || run.automationLevel !== 'BOUNDED_AUTO') {
        throw new Error('FINAL_DELIVERY_POLICY_MODE_INVALID')
      }
      const runPolicyAudit = qualityPolicyAuditForRun(run)
      if (!runPolicyAudit
        || (run.qualityDisposition && run.qualityDisposition !== 'SYSTEM_POLICY_ACCEPTED')
        || runPolicyAudit.policyId !== V4_NON_BLOCKING_QUALITY_POLICY_ID
        || JSON.stringify(delivery.qualityPolicyAudit) !== JSON.stringify(runPolicyAudit)
        || JSON.stringify(delivery.openIssueIds) !== JSON.stringify(runPolicyAudit.issueIds)) {
        throw new Error('FINAL_DELIVERY_POLICY_AUDIT_INVALID')
      }
    } else {
      if (delivery.qualityStatus !== 'OVERRIDDEN_INTERNAL' || !delivery.qualityOverrideAudit
        || delivery.qualityPolicyAudit) {
        throw new Error('FINAL_DELIVERY_OVERRIDE_AUDIT_REQUIRED')
      }
      if (run.presentationMode === 'VISUAL_DECK_V4' && delivery.qualityOverrideAudit.actorRole !== 'ADMIN') {
        throw new Error('FINAL_DELIVERY_V4_ADMIN_OVERRIDE_REQUIRED')
      }
      if (delivery.qualityOverrideAudit.actorId !== run.qualityOverrideBy
        || delivery.qualityOverrideAudit.actorRole !== run.qualityOverrideRole
        || delivery.qualityOverrideAudit.reason !== run.qualityOverrideReason
        || delivery.qualityOverrideAudit.acceptedAt !== run.qualityOverrideAt
        || JSON.stringify(delivery.qualityOverrideAudit.issueIds) !== JSON.stringify(run.qualityOverrideIssueIds)
        || JSON.stringify(delivery.openIssueIds) !== JSON.stringify(delivery.qualityOverrideAudit.issueIds)
        || (run.qualityDisposition && run.qualityDisposition !== 'ADMIN_OVERRIDE')) {
        throw new Error('FINAL_DELIVERY_OVERRIDE_AUDIT_INVALID')
      }
    }
  } else if (delivery.qualityStatus !== 'APPROVED'
    || delivery.qualityPolicyAudit
    || delivery.qualityOverrideAudit
    || delivery.openIssueIds.length > 0) {
    throw new Error('FINAL_DELIVERY_QUALITY_STATUS_INVALID')
  }
}

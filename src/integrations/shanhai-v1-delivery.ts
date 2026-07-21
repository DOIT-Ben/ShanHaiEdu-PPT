import type { HostContext } from '../contracts'
import { hashInput } from '../core/hash'
import type { ArtifactPort } from '../core/ports'
import {
  ShanHaiPptImageTextRendererV1,
  type ShanHaiPptImageAssetV1,
  type ShanHaiPptRenderInputV1,
} from '../adapters/shanhai-v1-renderer'
import {
  shanHaiPptDeliveryRequestV1Schema,
  shanHaiPptDeliveryResultV1Schema,
  type ShanHaiPptDeliveryRequestV1,
  type ShanHaiPptDeliveryResultV1,
} from '../shanhai-v1-contracts'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const

type Renderer = Readonly<{
  renderPreview(input: ShanHaiPptRenderInputV1): Promise<Uint8Array>
  renderPptx(input: ShanHaiPptRenderInputV1): Promise<Uint8Array>
}>

export type ShanHaiPptDeliveryReceiptV1 = Readonly<{
  inputHash: string
  result: ShanHaiPptDeliveryResultV1
}>

/**
 * The host owns durable delivery receipts. save must insert once per node run,
 * return the stored receipt on an exact replay, and reject a changed input hash.
 */
export interface ShanHaiPptDeliveryReceiptPortV1 {
  load(input: Readonly<{
    organizationId: string
    projectId: string
    nodeRunId: string
  }>): Promise<ShanHaiPptDeliveryReceiptV1 | null>

  save(input: Readonly<{
    organizationId: string
    projectId: string
    nodeRunId: string
    receipt: ShanHaiPptDeliveryReceiptV1
  }>): Promise<ShanHaiPptDeliveryReceiptV1>
}

export class ShanHaiPptDeliveryServiceV1 {
  private readonly renderer: Renderer

  constructor(private readonly dependencies: Readonly<{
    artifacts: ArtifactPort
    receipts: ShanHaiPptDeliveryReceiptPortV1
    renderer?: Renderer
  }>) {
    this.renderer = dependencies.renderer ?? new ShanHaiPptImageTextRendererV1()
  }

  async deliver(host: HostContext, requestInput: ShanHaiPptDeliveryRequestV1): Promise<ShanHaiPptDeliveryResultV1> {
    const request = shanHaiPptDeliveryRequestV1Schema.parse(requestInput)
    this.requireHost(host, request)
    const sourceArtifacts: Array<ShanHaiPptImageAssetV1 & { sha256: string }> = []
    for (const reference of request.image_artifacts) {
      const artifact = await this.dependencies.artifacts.get({
        tenantId: host.tenantId,
        artifactId: reference.artifact_id,
      })
      if (!artifact || !['image/png', 'image/jpeg'].includes(artifact.mimeType) || artifact.bytes.length === 0) {
        throw new Error(`SHANHAI_V1_SOURCE_ARTIFACT_INVALID:${reference.target_slot_key}`)
      }
      sourceArtifacts.push({
        target_slot_key: reference.target_slot_key,
        bytes: artifact.bytes,
        mime_type: artifact.mimeType as 'image/png' | 'image/jpeg',
        sha256: artifact.sha256,
      })
    }
    const inputHash = hashInput({
      schema_version: request.schema_version,
      execution: request.execution,
      deck: request.deck,
      image_artifacts: sourceArtifacts
        .map((artifact) => ({
          target_slot_key: artifact.target_slot_key,
          sha256: artifact.sha256,
        }))
        .sort((left, right) => left.target_slot_key.localeCompare(right.target_slot_key)),
    })
    const receiptKey = {
      organizationId: request.execution.organization_id,
      projectId: request.execution.project_id,
      nodeRunId: request.execution.node_run_id,
    }
    const existingReceipt = await this.dependencies.receipts.load(receiptKey)
    if (existingReceipt) return this.replayReceipt(existingReceipt, inputHash, request)

    const renderInput: ShanHaiPptRenderInputV1 = {
      deck: request.deck,
      assets: sourceArtifacts,
    }
    const previewBytes = await this.renderer.renderPreview(renderInput)
    const pptxBytes = await this.renderer.renderPptx(renderInput)
    if (previewBytes.length === 0 || pptxBytes.length === 0) throw new Error('SHANHAI_V1_DELIVERY_EMPTY')

    const idempotencyPrefix = `shanhai-v1:${request.execution.node_run_id}`
    const preview = await this.dependencies.artifacts.put({
      tenantId: host.tenantId,
      runId: request.execution.node_run_id,
      name: 'presentation-preview.png',
      mimeType: 'image/png',
      bytes: previewBytes,
      idempotencyKey: `${idempotencyPrefix}:preview`,
    })
    const pptx = await this.dependencies.artifacts.put({
      tenantId: host.tenantId,
      runId: request.execution.node_run_id,
      name: 'presentation.pptx',
      mimeType: PPTX_MIME,
      bytes: pptxBytes,
      idempotencyKey: `${idempotencyPrefix}:pptx`,
    })
    const result = shanHaiPptDeliveryResultV1Schema.parse({
      schema_version: 'shanhai.ppt.delivery-result.v1',
      organization_id: request.execution.organization_id,
      project_id: request.execution.project_id,
      node_run_id: request.execution.node_run_id,
      input_hash: inputHash,
      preview: {
        artifact_id: preview.artifactId,
        name: 'presentation-preview.png',
        mime_type: 'image/png',
        sha256: preview.sha256,
        byte_length: previewBytes.length,
      },
      pptx: {
        artifact_id: pptx.artifactId,
        name: 'presentation.pptx',
        mime_type: PPTX_MIME,
        sha256: pptx.sha256,
        byte_length: pptxBytes.length,
      },
    })
    const savedReceipt = await this.dependencies.receipts.save({
      ...receiptKey,
      receipt: { inputHash, result },
    })
    return this.replayReceipt(savedReceipt, inputHash, request)
  }

  private requireHost(host: HostContext, request: ShanHaiPptDeliveryRequestV1) {
    if (
      host.tenantId !== request.execution.organization_id
      || host.externalProjectId !== request.execution.project_id
      || !host.externalUserId
    ) {
      throw new Error('SHANHAI_V1_HOST_CONTEXT_MISMATCH')
    }
  }

  private replayReceipt(
    receipt: ShanHaiPptDeliveryReceiptV1,
    inputHash: string,
    request: ShanHaiPptDeliveryRequestV1,
  ) {
    if (receipt.inputHash !== inputHash) throw new Error('SHANHAI_V1_NODE_RUN_INPUT_CONFLICT')
    const result = shanHaiPptDeliveryResultV1Schema.parse(receipt.result)
    if (
      result.input_hash !== inputHash
      || result.organization_id !== request.execution.organization_id
      || result.project_id !== request.execution.project_id
      || result.node_run_id !== request.execution.node_run_id
    ) {
      throw new Error('SHANHAI_V1_RECEIPT_CONTEXT_MISMATCH')
    }
    return result
  }
}

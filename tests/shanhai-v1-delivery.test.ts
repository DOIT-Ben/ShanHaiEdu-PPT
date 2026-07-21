import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { MockArtifactPort } from '../src/adapters/mock-ports'
import {
  ShanHaiPptDeliveryServiceV1,
  type ShanHaiPptDeliveryReceiptPortV1,
  type ShanHaiPptDeliveryReceiptV1,
} from '../src/integrations/shanhai-v1-delivery'
import type { ShanHaiPptDeckV1, ShanHaiPptDeliveryRequestV1 } from '../src/shanhai-v1-contracts'

const ids = {
  organization: '10000000-0000-4000-8000-000000000001',
  project: '10000000-0000-4000-8000-000000000002',
  workflowRun: '10000000-0000-4000-8000-000000000003',
  nodeRun: '10000000-0000-4000-8000-000000000004',
  release: '10000000-0000-4000-8000-000000000005',
  workflow: '10000000-0000-4000-8000-000000000006',
  lessonUnit: '10000000-0000-4000-8000-000000000007',
}

class MemoryDeliveryReceipts implements ShanHaiPptDeliveryReceiptPortV1 {
  readonly receipts = new Map<string, ShanHaiPptDeliveryReceiptV1>()

  async load(input: Parameters<ShanHaiPptDeliveryReceiptPortV1['load']>[0]) {
    return structuredClone(this.receipts.get(this.key(input)) ?? null)
  }

  async save(input: Parameters<ShanHaiPptDeliveryReceiptPortV1['save']>[0]) {
    const key = this.key(input)
    const existing = this.receipts.get(key)
    if (existing) {
      if (existing.inputHash !== input.receipt.inputHash) throw new Error('SHANHAI_V1_NODE_RUN_INPUT_CONFLICT')
      return structuredClone(existing)
    }
    this.receipts.set(key, structuredClone(input.receipt))
    return structuredClone(input.receipt)
  }

  private key(input: Readonly<{ organizationId: string; projectId: string; nodeRunId: string }>) {
    return `${input.organizationId}:${input.projectId}:${input.nodeRunId}`
  }
}

function page(position: number): ShanHaiPptDeckV1['pages'][number] {
  const cover = position === 1
  return {
    page_key: `PAGE-${String(position).padStart(2, '0')}`,
    position,
    page_type: cover ? 'cover' : 'concept',
    teaching_task: cover ? '识别课题' : `理解数量 ${position}`,
    source_refs: ['lesson-plan:v1'],
    student_focus: '观察并表达数量关系',
    canvas: cover
      ? { aspect_ratio: '16:9', background_mode: 'cover_art' }
      : { aspect_ratio: '16:9', background_mode: 'solid_white', background_color: '#FFFFFF' },
    visual: {
      visual_decision: 'quantity_relation', image_strategy: 'original_asset',
      main_visual_description: `第 ${position} 页无文字主视觉`,
      asset_requirements: [{
        requirement_key: `visual-${position}`, role: 'main_visual',
        prompt: `A text-free primary math visual for page ${position}`,
        negative_prompt: 'text, numbers, formulas, logos',
        target_slot_key: `ppt.page-${position}.main-visual`,
      }],
    },
    editable_text_blocks: [
      { block_key: `title-${position}`, role: 'title', text: cover ? '1～5的认识' : `认识数量 ${position}` },
      { block_key: `body-${position}`, role: 'body', text: '观察图片，说一说你发现了什么。' },
    ],
    editable_math_shapes: [],
    layout_spec: { template: cover ? 'COVER' : 'IMAGE_LEFT', image_fit: 'cover' },
    interaction_spec: { mode: cover ? 'static' : 'question' },
    speaker_notes: '先观察，再表达。',
  }
}

async function fixture() {
  const artifacts = new MockArtifactPort()
  const receipts = new MemoryDeliveryReceipts()
  const imageArtifacts = []
  for (let position = 1; position <= 5; position += 1) {
    const stored = await artifacts.put({
      tenantId: ids.organization,
      runId: ids.nodeRun,
      name: `source-${position}.png`,
      mimeType: 'image/png',
      bytes: new Uint8Array(await sharp({
        create: { width: 1280, height: 720, channels: 3, background: '#79BDA7' },
      }).png().toBuffer()),
      idempotencyKey: `source-${position}`,
    })
    imageArtifacts.push({
      target_slot_key: `ppt.page-${position}.main-visual`,
      artifact_id: stored.artifactId,
    })
  }
  const request: ShanHaiPptDeliveryRequestV1 = {
    schema_version: 'shanhai.ppt.delivery.v1',
    execution: {
      organization_id: ids.organization,
      project_id: ids.project,
      workflow_run_id: ids.workflowRun,
      node_run_id: ids.nodeRun,
      content_release_id: ids.release,
      workflow_definition_version_id: ids.workflow,
      node_key: 'ppt.pages.assemble',
      branch_key: 'ppt',
      lesson_key: 'LESSON-001',
      lesson_unit_id: ids.lessonUnit,
    },
    deck: {
      schema_version: 'shanhai.ppt.image-text.v1',
      title: '1～5的认识',
      pages: Array.from({ length: 5 }, (_, index) => page(index + 1)),
    },
    image_artifacts: imageArtifacts,
  }
  const host = {
    tenantId: ids.organization,
    externalUserId: 'teacher-1',
    externalProjectId: ids.project,
  }
  return { artifacts, receipts, request, host, service: new ShanHaiPptDeliveryServiceV1({ artifacts, receipts }) }
}

describe('ShanHai PPT v1 delivery service', () => {
  test('renders controlled image artifacts into stored preview and PPTX outputs', async () => {
    const { artifacts, request, host, service } = await fixture()
    const result = await service.deliver(host, request)

    expect(result).toMatchObject({
      schema_version: 'shanhai.ppt.delivery-result.v1',
      organization_id: ids.organization,
      project_id: ids.project,
      node_run_id: ids.nodeRun,
      preview: { mime_type: 'image/png' },
      pptx: { mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    })
    expect(result.input_hash).toHaveLength(64)
    expect(artifacts.artifacts.get(result.preview.artifact_id)?.bytes.length).toBeGreaterThan(10_000)
    expect(artifacts.artifacts.get(result.pptx.artifact_id)?.bytes.length).toBeGreaterThan(50_000)
  })

  test('replays output artifact writes under the same node run', async () => {
    const { artifacts, receipts, request, host, service } = await fixture()
    const first = await service.deliver(host, request)
    const artifactCount = artifacts.artifacts.size
    const replay = await service.deliver(host, request)

    expect(replay).toEqual(first)
    expect(artifacts.artifacts.size).toBe(artifactCount)
    expect(receipts.receipts.size).toBe(1)

    const reorderedRequest = structuredClone(request)
    reorderedRequest.image_artifacts.reverse()
    expect(await service.deliver(host, reorderedRequest)).toEqual(first)

    const changedRequest = structuredClone(request)
    changedRequest.deck.title = '同一节点运行不允许更换输入'
    await expect(service.deliver(host, changedRequest)).rejects.toThrow('SHANHAI_V1_NODE_RUN_INPUT_CONFLICT')
  })

  test('rejects spoofed host ownership and unavailable source artifacts', async () => {
    const { artifacts, request, host, service } = await fixture()
    await expect(service.deliver({ ...host, externalProjectId: ids.workflowRun }, request))
      .rejects.toThrow('SHANHAI_V1_HOST_CONTEXT_MISMATCH')

    artifacts.artifacts.delete(request.image_artifacts[0]!.artifact_id)
    await expect(service.deliver(host, request)).rejects.toThrow('SHANHAI_V1_SOURCE_ARTIFACT_INVALID')
  })
})

import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import {
  ShanHaiPptImageTextRendererV1,
  renderShanHaiPptPagePreviewV1,
  type ShanHaiPptImageAssetV1,
} from '../src/adapters/shanhai-v1-renderer'
import type { ShanHaiPptDeckV1 } from '../src/shanhai-v1-contracts'

function page(position: number): ShanHaiPptDeckV1['pages'][number] {
  const cover = position === 1
  return {
    page_key: `PAGE-${String(position).padStart(2, '0')}`,
    position,
    page_type: cover ? 'cover' : position === 5 ? 'summary' : 'concept',
    teaching_task: cover ? '识别课题' : `理解第 ${position} 个知识要点`,
    source_refs: ['lesson-plan:v1'],
    student_focus: '观察图片并表达数量关系',
    canvas: cover
      ? { aspect_ratio: '16:9', background_mode: 'cover_art' }
      : { aspect_ratio: '16:9', background_mode: 'solid_white', background_color: '#FFFFFF' },
    visual: {
      visual_decision: 'quantity_relation',
      image_strategy: 'original_asset',
      main_visual_description: `第 ${position} 页无文字主视觉`,
      asset_requirements: [{
        requirement_key: `visual-${position}`,
        role: 'main_visual',
        prompt: `A text-free paper-clay primary math visual for page ${position}`,
        negative_prompt: 'text, numbers, formulas, logos',
        target_slot_key: `ppt.page-${position}.main-visual`,
      }],
    },
    editable_text_blocks: [
      { block_key: `title-${position}`, role: 'title', text: cover ? '1～5的认识' : `认识数量 ${position}` },
      { block_key: `body-${position}`, role: 'body', text: '图片负责情境，准确数字与说明保持原生可编辑。' },
      { block_key: `question-${position}`, role: 'question', text: '你看到了什么？' },
    ],
    editable_math_shapes: [],
    layout_spec: {
      template: cover ? 'COVER' : position % 2 === 0 ? 'IMAGE_LEFT' : 'IMAGE_RIGHT',
      image_fit: 'cover',
    },
    interaction_spec: { mode: cover ? 'static' : 'question' },
    speaker_notes: '先观察图片，再引导学生表达。',
  }
}

function deck(): ShanHaiPptDeckV1 {
  return {
    schema_version: 'shanhai.ppt.image-text.v1',
    title: '1～5的认识',
    pages: Array.from({ length: 5 }, (_, index) => page(index + 1)),
  }
}

async function assets(): Promise<ShanHaiPptImageAssetV1[]> {
  return Promise.all(Array.from({ length: 5 }, async (_, index) => ({
    target_slot_key: `ppt.page-${index + 1}.main-visual`,
    bytes: new Uint8Array(await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: index === 0 ? '#467B6B' : '#79BDA7',
      },
    }).png().toBuffer()),
    mime_type: 'image/png' as const,
  })))
}

describe('ShanHai PPT image-text v1 renderer', () => {
  test('keeps body imagery inside its region on a white canvas', async () => {
    const allAssets = await assets()
    const preview = await renderShanHaiPptPagePreviewV1(page(2), allAssets[1]!)
    const metadata = await sharp(preview).metadata()
    const corner = await sharp(preview)
      .extract({ left: 10, top: 10, width: 8, height: 8 })
      .removeAlpha()
      .raw()
      .toBuffer()

    expect(metadata).toMatchObject({ format: 'png', width: 1600, height: 900 })
    expect([...corner].every((value) => value > 250)).toBe(true)
  })

  test('renders a five-page contact sheet and editable PPTX package', async () => {
    const renderer = new ShanHaiPptImageTextRendererV1()
    const input = { deck: deck(), assets: await assets() }
    const preview = await renderer.renderPreview(input)
    const pptx = await renderer.renderPptx(input)

    expect(await sharp(preview).metadata()).toMatchObject({ format: 'png', width: 1536, height: 612 })
    expect(new TextDecoder().decode(pptx.slice(0, 2))).toBe('PK')
    expect(pptx.length).toBeGreaterThan(50_000)
  })

  test('rejects missing and undeclared image assets', async () => {
    const renderer = new ShanHaiPptImageTextRendererV1()
    const allAssets = await assets()
    await expect(renderer.renderPreview({ deck: deck(), assets: allAssets.slice(1) }))
      .rejects.toThrow('SHANHAI_V1_ASSET_MISSING')
    await expect(renderer.renderPptx({
      deck: deck(),
      assets: [...allAssets, { ...allAssets[0]!, target_slot_key: 'ppt.undeclared' }],
    })).rejects.toThrow('SHANHAI_V1_ASSET_UNDECLARED')
  })
})

import { describe, expect, test } from 'bun:test'
import { shanHaiPptDeckV1Schema } from '../src/shanhai-v1-contracts'

function page(position: number) {
  const cover = position === 1
  return {
    page_key: `PAGE-${String(position).padStart(2, '0')}`,
    position,
    page_type: cover ? 'cover' : 'concept',
    teaching_task: cover ? '识别课题' : `理解第 ${position} 个知识要点`,
    source_refs: ['lesson-plan:v1'],
    student_focus: cover ? '建立课题期待' : '观察图片并理解数量关系',
    canvas: cover
      ? { aspect_ratio: '16:9', background_mode: 'cover_art' }
      : { aspect_ratio: '16:9', background_mode: 'solid_white', background_color: '#FFFFFF' },
    visual: {
      visual_decision: 'quantity_relation',
      image_strategy: 'original_asset',
      main_visual_description: `第 ${position} 页的无文字课堂主视觉`,
      asset_requirements: [{
        requirement_key: `visual-${position}`,
        role: 'main_visual',
        prompt: `A text-free primary math classroom visual for page ${position}`,
        negative_prompt: 'text, numbers, formulas, logos',
        target_slot_key: `ppt.page-${position}.main-visual`,
      }],
    },
    editable_text_blocks: [
      { block_key: `title-${position}`, role: 'title', text: cover ? '1～5的认识' : `知识要点 ${position}` },
      { block_key: `body-${position}`, role: 'body', text: '观察图片，说一说你发现的数量关系。' },
    ],
    editable_math_shapes: [],
    layout_spec: { template: cover ? 'COVER' : 'IMAGE_LEFT', image_fit: 'cover' },
    interaction_spec: { mode: cover ? 'static' : 'question' },
    speaker_notes: '引导学生先观察，再表达。',
  }
}

function deck() {
  return {
    schema_version: 'shanhai.ppt.image-text.v1',
    title: '1～5的认识',
    pages: Array.from({ length: 5 }, (_, index) => page(index + 1)),
  }
}

describe('ShanHai PPT image-text v1 contracts', () => {
  test('accepts a five-page cover and white-body deck', () => {
    const parsed = shanHaiPptDeckV1Schema.parse(deck())
    expect(parsed.pages).toHaveLength(5)
    expect(parsed.pages[1]!.canvas).toEqual({
      aspect_ratio: '16:9', background_mode: 'solid_white', background_color: '#FFFFFF',
    })
  })

  test('rejects full-bleed body pages and non-editable math in v1', () => {
    const bodyBackground = deck()
    bodyBackground.pages[1]!.canvas = { aspect_ratio: '16:9', background_mode: 'cover_art' }
    expect(shanHaiPptDeckV1Schema.safeParse(bodyBackground).success).toBe(false)

    const mathShape = structuredClone(deck()) as {
      pages: Array<{ editable_math_shapes: unknown[] }>
    }
    mathShape.pages[1]!.editable_math_shapes = [{ shape_key: 'formula-1' }]
    expect(shanHaiPptDeckV1Schema.safeParse(mathShape).success).toBe(false)
  })

  test('requires continuous pages with unique asset slots', () => {
    const invalid = deck()
    invalid.pages[2]!.position = 4
    invalid.pages[2]!.visual.asset_requirements[0]!.target_slot_key = 'ppt.page-2.main-visual'
    expect(shanHaiPptDeckV1Schema.safeParse(invalid).success).toBe(false)
  })
})

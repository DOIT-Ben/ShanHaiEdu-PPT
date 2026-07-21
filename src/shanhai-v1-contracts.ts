import { z } from 'zod'

const identifierSchema = z.string().trim().min(1).max(160)
const sourceRefsSchema = z.array(identifierSchema).min(1).max(200)

export const shanHaiPptPageTypeV1Schema = z.enum([
  'cover',
  'introduction',
  'concept',
  'exploration',
  'example',
  'practice',
  'discussion',
  'summary',
  'other',
])

export const shanHaiPptTextBlockV1Schema = z.object({
  block_key: identifierSchema,
  role: z.enum(['title', 'body', 'question', 'label', 'answer', 'note']),
  text: z.string().trim().min(1).max(2_000),
}).strict()

export const shanHaiPptAssetRequirementV1Schema = z.object({
  requirement_key: identifierSchema,
  role: z.literal('main_visual'),
  prompt: z.string().trim().min(20).max(4_000),
  negative_prompt: z.string().max(2_000),
  target_slot_key: z.string().trim().regex(/^ppt\.[A-Za-z0-9._:-]+$/).max(240),
}).strict()

export const shanHaiPptPageV1Schema = z.object({
  page_key: z.string().trim().regex(/^PAGE-[0-9]{2,}$/),
  position: z.number().int().min(1).max(60),
  page_type: shanHaiPptPageTypeV1Schema,
  teaching_task: z.string().trim().min(1).max(500),
  source_refs: sourceRefsSchema,
  student_focus: z.string().trim().min(1).max(500),
  canvas: z.object({
    aspect_ratio: z.literal('16:9'),
    background_mode: z.enum(['cover_art', 'solid_white']),
    background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  }).strict(),
  visual: z.object({
    visual_decision: z.enum([
      'quantity_relation',
      'whole_part',
      'comparison',
      'transformation',
      'unit_one',
      'change',
      'operation',
      'life_application',
      'other',
    ]),
    image_strategy: z.enum(['textbook_reconstruction', 'original_asset', 'mixed']),
    main_visual_description: z.string().trim().min(1).max(1_000),
    asset_requirements: z.array(shanHaiPptAssetRequirementV1Schema).length(1),
  }).strict(),
  editable_text_blocks: z.array(shanHaiPptTextBlockV1Schema).min(1).max(20),
  editable_math_shapes: z.array(z.never()).max(0).default([]),
  layout_spec: z.object({
    template: z.enum(['COVER', 'IMAGE_LEFT', 'IMAGE_RIGHT', 'IMAGE_TOP']),
    image_fit: z.enum(['cover', 'contain']).default('cover'),
  }).strict(),
  interaction_spec: z.object({
    mode: z.enum(['static', 'question', 'reveal']).default('static'),
  }).strict(),
  speaker_notes: z.string().max(4_000).default(''),
}).strict().superRefine((page, context) => {
  if (page.page_type === 'cover') {
    if (page.canvas.background_mode !== 'cover_art' || page.layout_spec.template !== 'COVER') {
      context.addIssue({ code: 'custom', path: ['canvas'], message: 'cover must use cover_art and COVER' })
    }
    return
  }
  if (
    page.canvas.background_mode !== 'solid_white'
    || page.canvas.background_color?.toUpperCase() !== '#FFFFFF'
    || page.layout_spec.template === 'COVER'
  ) {
    context.addIssue({ code: 'custom', path: ['canvas'], message: 'body pages must use a solid white canvas' })
  }
})

export const shanHaiPptDeckV1Schema = z.object({
  schema_version: z.literal('shanhai.ppt.image-text.v1'),
  title: z.string().trim().min(1).max(200),
  pages: z.array(shanHaiPptPageV1Schema).min(5).max(60),
}).strict().superRefine((deck, context) => {
  const pageKeys = new Set<string>()
  const targetSlots = new Set<string>()
  deck.pages.forEach((page, index) => {
    if (page.position !== index + 1) {
      context.addIssue({ code: 'custom', path: ['pages', index, 'position'], message: 'page positions must be continuous' })
    }
    if (pageKeys.has(page.page_key)) {
      context.addIssue({ code: 'custom', path: ['pages', index, 'page_key'], message: 'page keys must be unique' })
    }
    pageKeys.add(page.page_key)
    const targetSlot = page.visual.asset_requirements[0]!.target_slot_key
    if (targetSlots.has(targetSlot)) {
      context.addIssue({ code: 'custom', path: ['pages', index, 'visual'], message: 'asset target slots must be unique' })
    }
    targetSlots.add(targetSlot)
    if ((index === 0) !== (page.page_type === 'cover')) {
      context.addIssue({ code: 'custom', path: ['pages', index, 'page_type'], message: 'only the first page may be the cover' })
    }
  })
})

export type ShanHaiPptPageV1 = z.infer<typeof shanHaiPptPageV1Schema>
export type ShanHaiPptDeckV1 = z.infer<typeof shanHaiPptDeckV1Schema>

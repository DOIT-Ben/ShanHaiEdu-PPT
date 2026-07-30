import { z } from 'zod'

export const visualDeckV4SourceRoleSchema = z.enum([
  'AUTO',
  'CONTENT_SOURCE',
  'TEACHING_GUIDE',
  'STRUCTURE_REFERENCE',
  'DESIGN_REFERENCE',
  'BRAND_GUIDE',
  'ASSET',
])

export const visualDeckV4LengthSchema = z.union([
  z.enum(['SHORT', 'DEFAULT', 'LONG']),
  z.object({ slideCount: z.number().int().min(2).max(50) }).strict(),
])

export const visualDeckV4ConfigSchema = z.object({
  instruction: z.string().trim().min(3).max(4_000),
  sourceMode: z.enum(['AUTO', 'SOURCE_GROUNDED', 'OPEN_KNOWLEDGE']).default('AUTO'),
  deckOptions: z.object({
    deckType: z.enum(['DETAILED_DECK', 'PRESENTER_SLIDES']).default('DETAILED_DECK'),
    language: z.string().trim().min(2).max(40).default('zh-CN'),
    length: visualDeckV4LengthSchema.default('DEFAULT'),
    aspectRatio: z.literal('16:9').default('16:9'),
    audience: z.string().trim().min(3).max(500).optional(),
    focus: z.string().trim().min(3).max(1_000).optional(),
    styleHint: z.string().trim().min(3).max(1_000).optional(),
  }).strict(),
}).strict()

export type VisualDeckV4Config = z.infer<typeof visualDeckV4ConfigSchema>
export type VisualDeckV4SourceRole = z.infer<typeof visualDeckV4SourceRoleSchema>

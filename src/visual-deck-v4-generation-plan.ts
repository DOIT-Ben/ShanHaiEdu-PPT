import { z } from 'zod'
import type { VisualDeckV4Proposal } from './visual-deck-v4-contracts'

export const visualDeckV4GenerationPlanSchema = z.object({
  schemaVersion: z.literal('1'),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(20).max(2_000),
  audience: z.string().trim().min(1).max(500),
  slideCount: z.number().int().min(2).max(50),
  aspectRatio: z.literal('16:9'),
  presentationType: z.string().trim().min(1).max(80),
  flow: z.array(z.string().trim().min(1).max(500)).min(2).max(20),
  pages: z.array(z.object({
    pageNumber: z.number().int().min(1).max(50),
    title: z.string().trim().min(1).max(160),
    content: z.string().trim().min(1).max(1_000),
    visual: z.string().trim().min(1).max(2_000),
  }).strict()).min(2).max(50),
  style: z.object({
    summary: z.string().trim().min(1).max(1_000),
    palette: z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).min(2).max(10),
    pageCharacteristics: z.array(z.string().trim().min(1).max(300)).min(2).max(24),
  }).strict(),
  output: z.object({
    format: z.literal('IMAGE_BASED_PPTX'),
    description: z.string().trim().min(1).max(500),
    editable: z.literal(false),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.pages.length !== value.slideCount) {
    context.addIssue({ code: 'custom', path: ['pages'], message: 'generation plan page count must match' })
  }
  value.pages.forEach((page, index) => {
    if (page.pageNumber !== index + 1) {
      context.addIssue({ code: 'custom', path: ['pages', index, 'pageNumber'], message: 'generation plan pages must be continuous' })
    }
  })
})

export type VisualDeckV4GenerationPlan = z.infer<typeof visualDeckV4GenerationPlanSchema>

export function visualDeckV4GenerationPlan(proposal: VisualDeckV4Proposal): VisualDeckV4GenerationPlan {
  const spec = proposal.presentationSpec
  const flow = proposal.deckPlan.narrativeArc
  return visualDeckV4GenerationPlanSchema.parse({
    schemaVersion: '1',
    title: proposal.deckPlan.title,
    summary: `这套PPT将面向${spec.audience}，围绕“${spec.goal}”展开，通过${flow.join('、')}完成整套讲述。`.slice(0, 2_000),
    audience: spec.audience,
    slideCount: spec.slideCount,
    aspectRatio: '16:9',
    presentationType: spec.deckType === 'DETAILED_DECK' ? '完整视觉演示' : '演讲型视觉演示',
    flow,
    pages: proposal.slideBriefs.map((brief) => ({
      pageNumber: brief.pageNumber,
      title: brief.title,
      content: brief.keyClaim,
      visual: `${brief.visualMetaphor}。${brief.composition}`.slice(0, 2_000),
    })),
    style: {
      summary: proposal.visualContract.artDirection,
      palette: proposal.visualContract.palette,
      pageCharacteristics: [
        ...proposal.visualContract.compositionRules,
        ...proposal.visualContract.continuityRules,
      ],
    },
    output: {
      format: 'IMAGE_BASED_PPTX',
      description: '每一页都是一张完整的16:9视觉页面，并封装为图片型PPTX；页面中的文字和图形不能单独编辑。',
      editable: false,
    },
  })
}

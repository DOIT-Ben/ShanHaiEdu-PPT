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

const identifierSchema = z.string().trim().min(1).max(160)
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum)

export const VISUAL_DECK_V4_CRITICAL_CONTENT_MAX_LENGTH = 6_000

export const visualDeckV4SourceModeSchema = z.enum(['SOURCE_GROUNDED', 'OPEN_KNOWLEDGE'])

export const visualDeckV4SourceUnderstandingSchema = z.object({
  sourceMode: visualDeckV4SourceModeSchema,
  instruction: boundedText(4_000),
  sources: z.array(z.object({
    sourceId: identifierSchema,
    name: boundedText(300),
    role: visualDeckV4SourceRoleSchema.exclude(['AUTO']),
    confidence: z.number().min(0).max(1),
    status: z.enum(['READY', 'FAILED']),
    sourceChunkIds: z.array(identifierSchema).max(200),
    failureCode: identifierSchema.optional(),
  }).strict()).max(7),
  missingRanges: z.array(boundedText(300)).max(50),
}).strict().superRefine((value, context) => {
  const sourceIds = value.sources.map((source) => source.sourceId)
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'v4 source ids must be unique' })
  }
  if (value.sourceMode === 'SOURCE_GROUNDED' && !value.sources.some((source) => source.status === 'READY')) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'grounded v4 planning requires a ready source' })
  }
})

export const visualDeckV4PresentationSpecSchema = z.object({
  sourceMode: visualDeckV4SourceModeSchema,
  deckType: z.enum(['DETAILED_DECK', 'PRESENTER_SLIDES']),
  language: boundedText(40),
  audience: boundedText(500),
  goal: boundedText(1_000),
  slideCount: z.number().int().min(2).max(50),
  focus: z.array(boundedText(500)).min(1).max(12),
  style: boundedText(1_000),
  requiredCoverage: z.array(boundedText(500)).min(1).max(30),
  forbidden: z.array(boundedText(300)).max(20),
}).strict()

export const visualDeckV4DeckPlanSchema = z.object({
  title: boundedText(160),
  slideCount: z.number().int().min(2).max(50),
  narrativeArc: z.array(boundedText(500)).min(2).max(20),
  chapters: z.array(z.object({
    chapterId: identifierSchema,
    title: boundedText(160),
    purpose: boundedText(500),
    slideNumbers: z.array(z.number().int().min(1).max(50)).min(1).max(50),
  }).strict()).min(1).max(20),
}).strict().superRefine((value, context) => {
  const chapterIds = value.chapters.map((chapter) => chapter.chapterId)
  if (new Set(chapterIds).size !== chapterIds.length) {
    context.addIssue({ code: 'custom', path: ['chapters'], message: 'v4 chapter ids must be unique' })
  }
  const pages = value.chapters.flatMap((chapter) => chapter.slideNumbers).sort((left, right) => left - right)
  const expected = Array.from({ length: value.slideCount }, (_, index) => index + 1)
  if (pages.length !== expected.length || pages.some((page, index) => page !== expected[index])) {
    context.addIssue({ code: 'custom', path: ['chapters'], message: 'v4 chapters must cover every slide exactly once' })
  }
})

export const visualDeckV4SlideRoleSchema = z.enum([
  'COVER',
  'SECTION',
  'CONTEXT',
  'QUESTION',
  'EXPLANATION',
  'COMPARISON',
  'PROCESS',
  'PRACTICE',
  'SUMMARY',
])

export const visualDeckV4SlideBriefSchema = z.object({
  pageNumber: z.number().int().min(1).max(50),
  role: visualDeckV4SlideRoleSchema,
  title: boundedText(120),
  keyClaim: boundedText(1_000),
  audienceTakeaway: boundedText(1_000),
  lockedCopy: z.array(boundedText(500)).min(1).max(8),
  facts: z.array(boundedText(500)).max(20),
  numbers: z.array(boundedText(200)).max(20),
  formulas: z.array(boundedText(300)).max(20),
  sourceChunkIds: z.array(identifierSchema).max(200),
  visualMetaphor: boundedText(1_000),
  composition: boundedText(1_000),
  informationHierarchy: z.array(boundedText(300)).min(1).max(12),
  previousSlideRelation: boundedText(500).nullable(),
  nextSlideRelation: boundedText(500).nullable(),
}).strict().superRefine((value, context) => {
  const criticalContentLength = [
    value.title,
    ...value.lockedCopy,
    ...value.facts,
    ...value.numbers,
    ...value.formulas,
  ].join('').length
  if (criticalContentLength > VISUAL_DECK_V4_CRITICAL_CONTENT_MAX_LENGTH) {
    context.addIssue({
      code: 'custom',
      path: ['facts'],
      message: 'v4 critical slide content exceeds the lossless image prompt budget',
    })
  }
})

export const visualDeckV4VisualContractSchema = z.object({
  artDirection: boundedText(1_000),
  palette: z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).min(2).max(10),
  typography: boundedText(500),
  medium: boundedText(300),
  visualDensity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  compositionRules: z.array(boundedText(300)).min(2).max(12),
  continuityRules: z.array(boundedText(300)).min(2).max(12),
  forbidden: z.array(boundedText(300)).max(20),
}).strict()

/**
 * V4 planning is deliberately split into persisted model outputs.  These
 * schemas are the hand-off contracts between planning stages, not UI models.
 */
export const visualDeckV4SourceSpecStageSchema = z.object({
  sourceUnderstanding: visualDeckV4SourceUnderstandingSchema,
  presentationSpec: visualDeckV4PresentationSpecSchema,
}).strict()

export const visualDeckV4DeckVisualStageSchema = z.object({
  deckPlan: visualDeckV4DeckPlanSchema,
  visualContract: visualDeckV4VisualContractSchema,
}).strict()

export const visualDeckV4SlideBriefsStageSchema = z.object({
  slideBriefs: z.array(visualDeckV4SlideBriefSchema).min(2).max(50),
}).strict()

export function normalizeVisualDeckV4VisibleReferences(
  stage: z.infer<typeof visualDeckV4SlideBriefsStageSchema>,
) {
  return {
    slideBriefs: stage.slideBriefs.map((slide) => {
      const visibleCopy = [slide.title, ...slide.lockedCopy].join('\n')
      return {
        ...slide,
        numbers: slide.numbers.filter((number) => visibleCopy.includes(number)),
        formulas: slide.formulas.filter((formula) => visibleCopy.includes(formula)),
      }
    }),
  }
}

export const visualDeckV4FinalCoherenceReviewSchema = z.object({
  decision: z.literal('APPROVED'),
  summary: boundedText(1_000),
  checks: z.array(z.object({
    dimension: z.enum([
      'REQUEST_BINDING',
      'SOURCE_GROUNDING',
      'NARRATIVE_COHERENCE',
      'SLIDE_COVERAGE',
      'VISUAL_COHERENCE',
    ]),
    passed: z.literal(true),
    evidence: boundedText(500),
  }).strict()).length(5),
}).strict().superRefine((value, context) => {
  const dimensions = value.checks.map((check) => check.dimension)
  if (new Set(dimensions).size !== dimensions.length) {
    context.addIssue({ code: 'custom', path: ['checks'], message: 'v4 coherence checks must be unique' })
  }
})

export const visualDeckV4ProposalDraftSchema = z.object({
  sourceUnderstanding: visualDeckV4SourceUnderstandingSchema,
  presentationSpec: visualDeckV4PresentationSpecSchema,
  deckPlan: visualDeckV4DeckPlanSchema,
  slideBriefs: z.array(visualDeckV4SlideBriefSchema).min(2).max(50),
  visualContract: visualDeckV4VisualContractSchema,
}).strict().superRefine((value, context) => {
  const count = value.presentationSpec.slideCount
  if (value.deckPlan.slideCount !== count || value.slideBriefs.length !== count) {
    context.addIssue({ code: 'custom', path: ['slideBriefs'], message: 'v4 proposal slide counts must match' })
  }
  value.slideBriefs.forEach((slide, index) => {
    if (slide.pageNumber !== index + 1) {
      context.addIssue({ code: 'custom', path: ['slideBriefs', index, 'pageNumber'], message: 'v4 slide pages must be continuous' })
    }
    const visibleCopy = [slide.title, ...slide.lockedCopy].join('\n')
    slide.numbers.forEach((number, numberIndex) => {
      if (!visibleCopy.includes(number)) {
        context.addIssue({
          code: 'custom', path: ['slideBriefs', index, 'numbers', numberIndex],
          message: 'v4 visible numbers must occur in title or lockedCopy',
        })
      }
    })
    slide.formulas.forEach((formula, formulaIndex) => {
      if (!visibleCopy.includes(formula)) {
        context.addIssue({
          code: 'custom', path: ['slideBriefs', index, 'formulas', formulaIndex],
          message: 'v4 visible formulas must occur in title or lockedCopy',
        })
      }
    })
  })
  if (value.presentationSpec.sourceMode !== value.sourceUnderstanding.sourceMode) {
    context.addIssue({ code: 'custom', path: ['presentationSpec', 'sourceMode'], message: 'v4 source mode must be consistent' })
  }
  if (value.presentationSpec.sourceMode === 'SOURCE_GROUNDED') {
    const available = new Set(value.sourceUnderstanding.sources.flatMap((source) => source.sourceChunkIds))
    value.slideBriefs.forEach((slide, index) => {
      if (slide.sourceChunkIds.length === 0 || slide.sourceChunkIds.some((id) => !available.has(id))) {
        context.addIssue({ code: 'custom', path: ['slideBriefs', index, 'sourceChunkIds'], message: 'grounded v4 slides require valid source chunks' })
      }
    })
  }
})

export const visualDeckV4ProposalSchema = visualDeckV4ProposalDraftSchema.safeExtend({
  compilerVersion: identifierSchema,
}).strict()

export const visualDeckV4RenderedSlideSchema = z.object({
  pageNumber: z.number().int().min(1).max(50),
  strategy: z.enum(['FULL_GENERATIVE', 'CONTROLLED_RASTER']),
  artifactId: identifierSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  qualityStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
}).strict()

export const visualDeckV4DeckManifestSchema = z.object({
  schemaVersion: z.literal('1'),
  runId: identifierSchema,
  presentationMode: z.literal('VISUAL_DECK_V4'),
  compilerVersion: identifierSchema,
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  slides: z.array(visualDeckV4RenderedSlideSchema).min(2).max(50),
  createdAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  value.slides.forEach((slide, index) => {
    if (slide.pageNumber !== index + 1) {
      context.addIssue({ code: 'custom', path: ['slides', index, 'pageNumber'], message: 'v4 manifest pages must be continuous' })
    }
  })
})

export type VisualDeckV4Config = z.infer<typeof visualDeckV4ConfigSchema>
export type VisualDeckV4SourceRole = z.infer<typeof visualDeckV4SourceRoleSchema>
export type VisualDeckV4SourceSpecStage = z.infer<typeof visualDeckV4SourceSpecStageSchema>
export type VisualDeckV4DeckVisualStage = z.infer<typeof visualDeckV4DeckVisualStageSchema>
export type VisualDeckV4SlideBriefsStage = z.infer<typeof visualDeckV4SlideBriefsStageSchema>
export type VisualDeckV4FinalCoherenceReview = z.infer<typeof visualDeckV4FinalCoherenceReviewSchema>
export type VisualDeckV4ProposalDraft = z.infer<typeof visualDeckV4ProposalDraftSchema>
export type VisualDeckV4Proposal = z.infer<typeof visualDeckV4ProposalSchema>
export type VisualDeckV4RenderedSlide = z.infer<typeof visualDeckV4RenderedSlideSchema>
export type VisualDeckV4DeckManifest = z.infer<typeof visualDeckV4DeckManifestSchema>

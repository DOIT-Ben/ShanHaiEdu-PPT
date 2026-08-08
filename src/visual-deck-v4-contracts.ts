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
  z.object({ slideCount: z.number().int().min(1).max(50) }).strict(),
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

// These fields are losslessly repeated for image creation and image editing.
// Reserve the remaining 12k prompt budget for corrections and fixed safeguards.
export const VISUAL_DECK_V4_CRITICAL_CONTENT_MAX_LENGTH = 4_000
export const VISUAL_DECK_V4_REPAIR_CONSTRAINT_MAX_LENGTH = 2_300
export const VISUAL_DECK_V4_MANUSCRIPT_MAX_CHARACTERS = 80_000
export const V4_MANUSCRIPT_CONTEXT_TOO_LARGE = 'V4_MANUSCRIPT_CONTEXT_TOO_LARGE'
const V4_MANUSCRIPT_CONTEXT_TOO_LARGE_CODES = new Set([
  V4_MANUSCRIPT_CONTEXT_TOO_LARGE,
  'MODEL_CONTEXT_TOO_LARGE',
  'V4_MODEL_PAYLOAD_TOO_LARGE',
])

export function visualDeckV4ManuscriptCharacterCount(value: unknown) {
  return JSON.stringify(value)?.length ?? 0
}

export function assertVisualDeckV4ManuscriptCharacterLimit(value: unknown) {
  if (visualDeckV4ManuscriptCharacterCount(value) > VISUAL_DECK_V4_MANUSCRIPT_MAX_CHARACTERS) {
    throw new Error(V4_MANUSCRIPT_CONTEXT_TOO_LARGE)
  }
}

export function isV4ManuscriptContextTooLargeError(error: unknown) {
  return (error instanceof Error && V4_MANUSCRIPT_CONTEXT_TOO_LARGE_CODES.has(error.message))
    || (error instanceof z.ZodError && error.issues.some((issue) => issue.message === V4_MANUSCRIPT_CONTEXT_TOO_LARGE))
}

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
  slideCount: z.number().int().min(1).max(50),
  focus: z.array(boundedText(500)).min(1).max(12),
  style: boundedText(1_000),
  requiredCoverage: z.array(boundedText(500)).min(1).max(30),
  forbidden: z.array(boundedText(300)).max(20),
}).strict()

export const visualDeckV4DeckPlanSchema = z.object({
  title: boundedText(160),
  slideCount: z.number().int().min(1).max(50),
  narrativeArc: z.array(boundedText(500)).min(1).max(20),
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
  'SINGLE',
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

const visualDeckV4SlideBriefShape = {
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
} as const

export const visualDeckV4SlideBriefSchema = z.object(visualDeckV4SlideBriefShape).strict().superRefine((value, context) => {
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

/**
 * Chain-4 is a semantic model boundary.  The model can describe content and
 * evidence excerpts, but it cannot choose runtime-owned identifiers, pages,
 * roles, hashes, budgets, or patch paths.
 */
const visualDeckV4ManuscriptSlideShape = {
  title: boundedText(160),
  narrative: boundedText(1_200),
  userVisibleCopy: z.array(boundedText(500)).min(1).max(8),
  factualStatements: z.array(boundedText(500)).max(20),
  visualDescription: boundedText(1_500),
  sourceEvidence: z.array(z.object({ excerpt: boundedText(1_200) }).strict()).max(8),
} as const

export function isSemanticManuscriptPlaceholder(value: string) {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase()
  const content = normalized.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
  if (content.length === 0) return true
  return /^(?:tbd|todo|n\/?a|placeholder|待补充|待完善|待定|待补全|暂无|未定|待填)(?:[\p{P}\p{S}].*)?$/u.test(content)
}

const visualDeckV4ManuscriptSlideSchema = z.object(visualDeckV4ManuscriptSlideShape).strict()
  .superRefine((value, context) => {
    if (isSemanticManuscriptPlaceholder(value.visualDescription)) {
      context.addIssue({
        code: 'custom',
        path: ['visualDescription'],
        message: 'semantic manuscript content cannot be a placeholder',
      })
    }
  })

export const visualDeckV4CreativeManuscriptSchema = z.object({
  title: boundedText(160),
  narrative: z.array(boundedText(500)).min(1).max(20),
  slides: z.array(visualDeckV4ManuscriptSlideSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  if (visualDeckV4ManuscriptCharacterCount(value) > VISUAL_DECK_V4_MANUSCRIPT_MAX_CHARACTERS) {
    context.addIssue({ code: 'custom', message: V4_MANUSCRIPT_CONTEXT_TOO_LARGE })
  }
})

export const visualDeckV4ReviewManuscriptSchema = z.object({
  title: boundedText(160),
  narrative: z.array(boundedText(500)).min(1).max(20),
  slides: z.array(visualDeckV4ManuscriptSlideSchema).min(1).max(50),
  revisionSuggestions: z.array(boundedText(1_000)).max(50),
}).strict().superRefine((value, context) => {
  if (visualDeckV4ManuscriptCharacterCount(value) > VISUAL_DECK_V4_MANUSCRIPT_MAX_CHARACTERS) {
    context.addIssue({ code: 'custom', message: V4_MANUSCRIPT_CONTEXT_TOO_LARGE })
  }
})

export const visualDeckV4SlideBriefRevisionPatchSchema = z.object({
  pageNumber: visualDeckV4SlideBriefShape.pageNumber,
  role: visualDeckV4SlideBriefShape.role,
  visualMetaphor: visualDeckV4SlideBriefShape.visualMetaphor,
  composition: visualDeckV4SlideBriefShape.composition,
  informationHierarchy: visualDeckV4SlideBriefShape.informationHierarchy,
  previousSlideRelation: visualDeckV4SlideBriefShape.previousSlideRelation,
  nextSlideRelation: visualDeckV4SlideBriefShape.nextSlideRelation,
}).strict()

export const visualDeckV4ContentRevisionPatchSchema = z.object({
  pageNumber: visualDeckV4SlideBriefShape.pageNumber,
  title: visualDeckV4SlideBriefShape.title,
  keyClaim: visualDeckV4SlideBriefShape.keyClaim,
  audienceTakeaway: visualDeckV4SlideBriefShape.audienceTakeaway,
  lockedCopy: visualDeckV4SlideBriefShape.lockedCopy,
  facts: visualDeckV4SlideBriefShape.facts,
  numbers: visualDeckV4SlideBriefShape.numbers,
  formulas: visualDeckV4SlideBriefShape.formulas,
  sourceChunkIds: visualDeckV4SlideBriefShape.sourceChunkIds,
  visualMetaphor: visualDeckV4SlideBriefShape.visualMetaphor,
  composition: visualDeckV4SlideBriefShape.composition,
  informationHierarchy: visualDeckV4SlideBriefShape.informationHierarchy,
  previousSlideRelation: visualDeckV4SlideBriefShape.previousSlideRelation,
  nextSlideRelation: visualDeckV4SlideBriefShape.nextSlideRelation,
}).strict()

export const visualDeckV4LayoutRevisionPatchSchema = z.object({
  pageNumber: visualDeckV4SlideBriefShape.pageNumber,
  visualMetaphor: visualDeckV4SlideBriefShape.visualMetaphor,
  composition: visualDeckV4SlideBriefShape.composition,
  informationHierarchy: visualDeckV4SlideBriefShape.informationHierarchy,
  previousSlideRelation: visualDeckV4SlideBriefShape.previousSlideRelation,
  nextSlideRelation: visualDeckV4SlideBriefShape.nextSlideRelation,
}).strict()

export const visualDeckV4RevisionApplicationResultSchema = z.object({
  contentPatches: z.array(visualDeckV4ContentRevisionPatchSchema).max(50),
  layoutPatches: z.array(visualDeckV4LayoutRevisionPatchSchema).max(50),
  redrawOnlyPageNumbers: z.array(visualDeckV4SlideBriefShape.pageNumber).max(50),
}).strict().superRefine((value, context) => {
  const owners = [
    ...value.contentPatches.map((patch, index) => ({ pageNumber: patch.pageNumber, path: ['contentPatches', index, 'pageNumber'] })),
    ...value.layoutPatches.map((patch, index) => ({ pageNumber: patch.pageNumber, path: ['layoutPatches', index, 'pageNumber'] })),
    ...value.redrawOnlyPageNumbers.map((pageNumber, index) => ({ pageNumber, path: ['redrawOnlyPageNumbers', index] })),
  ]
  const seen = new Set<number>()
  for (const owner of owners) {
    if (seen.has(owner.pageNumber)) {
      context.addIssue({
        code: 'custom',
        path: owner.path,
        message: 'v4 revision pages must have exactly one patch or redraw-only disposition',
      })
    }
    seen.add(owner.pageNumber)
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

export function normalizeVisualDeckV4RequestFocus(
  stage: z.infer<typeof visualDeckV4SourceSpecStageSchema>,
  requestFocus: string | undefined,
) {
  if (!requestFocus || stage.presentationSpec.focus.includes(requestFocus)) return stage
  return {
    ...stage,
    presentationSpec: {
      ...stage.presentationSpec,
      focus: [requestFocus, ...stage.presentationSpec.focus].slice(0, 12),
    },
  }
}

export const visualDeckV4DeckVisualStageSchema = z.object({
  deckPlan: visualDeckV4DeckPlanSchema,
  visualContract: visualDeckV4VisualContractSchema,
}).strict()

export const visualDeckV4SlideBriefsStageSchema = z.object({
  slideBriefs: z.array(visualDeckV4SlideBriefSchema).min(1).max(50),
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

export const VISUAL_DECK_V4_REFLECTION_RUBRIC_VERSION = 'v4-reflection-1' as const

export const VISUAL_DECK_V4_REFLECTION_DIMENSIONS = [
  'REQUEST_BINDING',
  'SOURCE_GROUNDING',
  'NARRATIVE_COHERENCE',
  'SLIDE_COVERAGE',
  'VISUAL_COHERENCE',
  'IMAGE_MODEL_EXECUTABILITY',
  'COUNTABILITY_RISK',
  'UNAUTHORIZED_TEXT_RISK',
  'VISUAL_DENSITY_RISK',
  'CROSS_SLIDE_REPETITION',
  'SOURCE_ROLE_INTEGRITY',
  'PEDAGOGICAL_SEQUENCE',
] as const

export const visualDeckV4ReflectionDimensionSchema = z.enum(VISUAL_DECK_V4_REFLECTION_DIMENSIONS)

const reflectionCheckSchema = z.object({
  dimension: visualDeckV4ReflectionDimensionSchema,
  passed: z.boolean(),
  evidence: boundedText(1_000),
}).strict()

const reflectionFindingBase = {
  id: identifierSchema,
  dimension: visualDeckV4ReflectionDimensionSchema,
  severity: z.enum(['WARNING', 'BLOCKER']),
  impact: z.literal('PAGES'),
  evidence: boundedText(1_000),
  risk: boundedText(1_000),
  revisionInstruction: boundedText(1_000),
}

export const visualDeckV4DeckVisualFindingSchema = z.object({
  ...reflectionFindingBase,
  scope: z.literal('DECK_VISUAL'),
  pageNumbers: z.array(z.number().int().min(1).max(50)).min(1).max(50)
    .refine((value) => new Set(value).size === value.length, 'reflection page numbers must be unique'),
  fieldPaths: z.array(z.enum([
    'deckPlan.title',
    'deckPlan.narrativeArc',
    'deckPlan.chapters',
    'visualContract.artDirection',
    'visualContract.palette',
    'visualContract.typography',
    'visualContract.medium',
    'visualContract.visualDensity',
    'visualContract.compositionRules',
    'visualContract.continuityRules',
    'visualContract.forbidden',
  ])).min(1).max(12)
    .refine((value) => new Set(value).size === value.length, 'reflection field paths must be unique'),
}).strict()

export const visualDeckV4SlideBriefFindingSchema = z.object({
  ...reflectionFindingBase,
  scope: z.literal('SLIDE_BRIEF'),
  pageNumbers: z.array(z.number().int().min(1).max(50)).min(1).max(50)
    .refine((value) => new Set(value).size === value.length, 'reflection page numbers must be unique'),
  fieldPaths: z.array(z.enum([
    'role',
    'visualMetaphor',
    'composition',
    'informationHierarchy',
    'previousSlideRelation',
    'nextSlideRelation',
  ])).min(1).max(6)
    .refine((value) => new Set(value).size === value.length, 'reflection field paths must be unique'),
}).strict()

type ReflectionDecision = Readonly<{
  decision: 'UNCHANGED' | 'REVISED'
  checks: readonly z.infer<typeof reflectionCheckSchema>[]
  findings: readonly { id: string; dimension: z.infer<typeof visualDeckV4ReflectionDimensionSchema> }[]
  appliedFindingIds: readonly string[]
}>

function validateReflectionDecision(value: ReflectionDecision, context: z.RefinementCtx) {
  const dimensions = value.checks.map((check) => check.dimension)
  if (new Set(dimensions).size !== VISUAL_DECK_V4_REFLECTION_DIMENSIONS.length
    || VISUAL_DECK_V4_REFLECTION_DIMENSIONS.some((dimension) => !dimensions.includes(dimension))) {
    context.addIssue({ code: 'custom', path: ['checks'], message: 'every reflection rubric dimension is required exactly once' })
  }
  const findingIds = value.findings.map((finding) => finding.id)
  if (new Set(findingIds).size !== findingIds.length) {
    context.addIssue({ code: 'custom', path: ['findings'], message: 'reflection finding ids must be unique' })
  }
  if (new Set(value.appliedFindingIds).size !== value.appliedFindingIds.length) {
    context.addIssue({ code: 'custom', path: ['appliedFindingIds'], message: 'applied reflection finding ids must be unique' })
  }
  if (value.decision === 'UNCHANGED') {
    if (value.checks.some((check) => !check.passed)) {
      context.addIssue({ code: 'custom', path: ['checks'], message: 'unchanged reflection requires every rubric check to pass' })
    }
    if (value.findings.length > 0) {
      context.addIssue({ code: 'custom', path: ['findings'], message: 'unchanged reflection cannot report findings' })
    }
    if (value.appliedFindingIds.length > 0) {
      context.addIssue({ code: 'custom', path: ['appliedFindingIds'], message: 'unchanged reflection cannot apply findings' })
    }
    return
  }
  if (value.findings.length === 0) {
    context.addIssue({ code: 'custom', path: ['findings'], message: 'revised reflection requires at least one finding' })
  }
  const applied = new Set(value.appliedFindingIds)
  if (applied.size !== findingIds.length || findingIds.some((id) => !applied.has(id))) {
    context.addIssue({ code: 'custom', path: ['appliedFindingIds'], message: 'revised reflection must apply every reported finding exactly once' })
  }
  const failedDimensions = new Set(value.checks.filter((check) => !check.passed).map((check) => check.dimension))
  if (failedDimensions.size === 0
    || value.findings.some((finding) => !failedDimensions.has(finding.dimension))
    || [...failedDimensions].some((dimension) => !value.findings.some((finding) => finding.dimension === dimension))) {
    context.addIssue({ code: 'custom', path: ['findings'], message: 'revised reflection findings must exactly explain failed rubric dimensions' })
  }
}

const reflectionResultBase = {
  checks: z.array(reflectionCheckSchema).length(VISUAL_DECK_V4_REFLECTION_DIMENSIONS.length),
  baseArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewContextHash: z.string().regex(/^[a-f0-9]{64}$/),
}

export const visualDeckV4DeckVisualReflectionResultSchema = z.object({
  decision: z.enum(['UNCHANGED', 'REVISED']),
  ...reflectionResultBase,
  findings: z.array(visualDeckV4DeckVisualFindingSchema).max(50),
  appliedFindingIds: z.array(identifierSchema).max(50),
  revisedArtifact: visualDeckV4DeckVisualStageSchema,
}).strict().superRefine(validateReflectionDecision)

export const visualDeckV4SlideBriefsReflectionResultSchema = z.object({
  decision: z.enum(['UNCHANGED', 'REVISED']),
  ...reflectionResultBase,
  findings: z.array(visualDeckV4SlideBriefFindingSchema).max(50),
  appliedFindingIds: z.array(identifierSchema).max(50),
  revisedSlides: z.array(visualDeckV4SlideBriefRevisionPatchSchema).max(50)
    .refine((value) => new Set(value.map((slide) => slide.pageNumber)).size === value.length, 'revised slide pages must be unique'),
}).strict().superRefine((value, context) => {
  validateReflectionDecision(value, context)
  if (value.decision === 'UNCHANGED' && value.revisedSlides.length > 0) {
    context.addIssue({ code: 'custom', path: ['revisedSlides'], message: 'unchanged reflection cannot return revised slides' })
  }
  if (value.decision === 'REVISED' && value.revisedSlides.length === 0) {
    context.addIssue({ code: 'custom', path: ['revisedSlides'], message: 'revised reflection requires revised slides' })
  }
})

export const visualDeckV4DeckVisualReflectionStageOutputSchema = z.object({
  reflection: visualDeckV4DeckVisualReflectionResultSchema,
  artifact: visualDeckV4DeckVisualStageSchema,
  audit: z.object({
    rubricVersion: z.literal(VISUAL_DECK_V4_REFLECTION_RUBRIC_VERSION),
    decision: z.enum(['UNCHANGED', 'REVISED']),
    findingCount: z.number().int().nonnegative().max(50),
    modelCallCount: z.number().int().min(1).max(5),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    requestId: identifierSchema.nullable(),
    promptBeforeHash: z.string().regex(/^[a-f0-9]{64}$/),
    promptAfterHash: z.string().regex(/^[a-f0-9]{64}$/),
    highRiskEscalation: z.literal(false),
  }).strict().optional(),
}).strict()

export const visualDeckV4SlideBriefsReflectionStageOutputSchema = z.object({
  reflection: visualDeckV4SlideBriefsReflectionResultSchema,
  artifact: visualDeckV4SlideBriefsStageSchema,
  audit: visualDeckV4DeckVisualReflectionStageOutputSchema.shape.audit,
}).strict()

const reflectionOriginalRequestSchema = z.object({
  instruction: boundedText(4_000),
  targetAudience: boundedText(500).nullable(),
  presentationGoal: boundedText(1_000).nullable(),
  visualDirection: boundedText(1_000),
}).strict()

const reflectionTrustedEvidenceSchema = z.object({
  sourceManifest: z.array(z.object({
    sourceId: identifierSchema,
    name: boundedText(300),
    role: visualDeckV4SourceRoleSchema.exclude(['AUTO']),
    status: z.enum(['READY', 'FAILED']),
    sourceChunkIds: z.array(identifierSchema).max(200),
  }).strict()).max(7),
  sourceChunks: z.array(z.object({
    id: identifierSchema,
    sourceId: identifierSchema.nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    text: boundedText(20_000),
    pageStart: z.number().int().positive().nullable(),
    pageEnd: z.number().int().positive().nullable(),
    region: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    }).strict().nullable(),
  }).strict()).min(1).max(200),
}).strict()

const reflectionFrozenConstraintsSchema = z.object({
  slideCount: z.number().int().min(1).max(50),
  language: boundedText(40),
  sourceMode: visualDeckV4SourceModeSchema,
  presentationMode: z.literal('VISUAL_DECK_V4'),
  deckType: z.enum(['DETAILED_DECK', 'PRESENTER_SLIDES']),
  audience: boundedText(500),
  goal: boundedText(1_000),
  aspectRatio: z.literal('16:9'),
  forbidden: z.array(boundedText(300)).max(40),
}).strict()

const reflectionProviderCapabilitiesSchema = z.object({
  deliveryModel: z.literal('RASTER_SLIDES_IN_PPTX'),
}).strict()

const deckVisualGovernanceContextSchema = z.object({
  presentationSpec: visualDeckV4PresentationSpecSchema,
}).strict()

const slideBriefsGovernanceContextSchema = z.object({
  presentationSpec: visualDeckV4PresentationSpecSchema,
  deckPlan: visualDeckV4DeckPlanSchema,
  visualContract: visualDeckV4VisualContractSchema,
}).strict()

const reflectionInputBase = {
  originalRequest: reflectionOriginalRequestSchema,
  trustedEvidence: reflectionTrustedEvidenceSchema,
  frozenConstraints: reflectionFrozenConstraintsSchema,
  candidateArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewContextHash: z.string().regex(/^[a-f0-9]{64}$/),
  rubricVersion: z.literal(VISUAL_DECK_V4_REFLECTION_RUBRIC_VERSION),
  providerCapabilities: reflectionProviderCapabilitiesSchema,
}

export const visualDeckV4DeckVisualReflectionInputSchema = z.object({
  ...reflectionInputBase,
  governanceContext: deckVisualGovernanceContextSchema,
  candidateArtifact: visualDeckV4DeckVisualStageSchema,
}).strict()

export const visualDeckV4SlideBriefsReflectionInputSchema = z.object({
  ...reflectionInputBase,
  governanceContext: slideBriefsGovernanceContextSchema,
  candidateArtifact: visualDeckV4SlideBriefsStageSchema,
}).strict()

export const visualDeckV4ProposalDraftSchema = z.object({
  sourceUnderstanding: visualDeckV4SourceUnderstandingSchema,
  presentationSpec: visualDeckV4PresentationSpecSchema,
  deckPlan: visualDeckV4DeckPlanSchema,
  slideBriefs: z.array(visualDeckV4SlideBriefSchema).min(1).max(50),
  visualContract: visualDeckV4VisualContractSchema,
}).strict().superRefine((value, context) => {
  const count = value.presentationSpec.slideCount
  if (value.deckPlan.slideCount !== count || value.slideBriefs.length !== count) {
    context.addIssue({ code: 'custom', path: ['slideBriefs'], message: 'v4 proposal slide counts must match' })
  }
  if (count === 1) {
    const [slide] = value.slideBriefs
    if (slide?.role !== 'SINGLE') {
      context.addIssue({ code: 'custom', path: ['slideBriefs', 0, 'role'], message: 'a one-page v4 proposal requires the SINGLE role' })
    }
    if (slide?.previousSlideRelation !== null) {
      context.addIssue({ code: 'custom', path: ['slideBriefs', 0, 'previousSlideRelation'], message: 'a one-page v4 proposal has no previous slide relation' })
    }
    if (slide?.nextSlideRelation !== null) {
      context.addIssue({ code: 'custom', path: ['slideBriefs', 0, 'nextSlideRelation'], message: 'a one-page v4 proposal has no next slide relation' })
    }
  } else {
    value.slideBriefs.forEach((slide, index) => {
      if (slide.role === 'SINGLE') {
        context.addIssue({ code: 'custom', path: ['slideBriefs', index, 'role'], message: 'the SINGLE role is valid only for a one-page v4 proposal' })
      }
    })
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
  const repairConstraintLength = [
    ...value.visualContract.continuityRules,
    ...value.visualContract.forbidden,
    ...value.presentationSpec.forbidden,
  ].join('').length
  if (repairConstraintLength > VISUAL_DECK_V4_REPAIR_CONSTRAINT_MAX_LENGTH) {
    context.addIssue({
      code: 'custom',
      path: ['visualContract', 'continuityRules'],
      message: 'v4 repair image constraints exceed the lossless image prompt budget',
    })
  }
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
  slides: z.array(visualDeckV4RenderedSlideSchema).min(1).max(50),
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
export type VisualDeckV4SlideBrief = z.infer<typeof visualDeckV4SlideBriefSchema>
export type VisualDeckV4FinalCoherenceReview = z.infer<typeof visualDeckV4FinalCoherenceReviewSchema>
export type VisualDeckV4DeckVisualReflectionInput = z.infer<typeof visualDeckV4DeckVisualReflectionInputSchema>
export type VisualDeckV4SlideBriefsReflectionInput = z.infer<typeof visualDeckV4SlideBriefsReflectionInputSchema>
export type VisualDeckV4DeckVisualReflectionResult = z.infer<typeof visualDeckV4DeckVisualReflectionResultSchema>
export type VisualDeckV4SlideBriefsReflectionResult = z.infer<typeof visualDeckV4SlideBriefsReflectionResultSchema>
export type VisualDeckV4DeckVisualReflectionStageOutput = z.infer<typeof visualDeckV4DeckVisualReflectionStageOutputSchema>
export type VisualDeckV4SlideBriefsReflectionStageOutput = z.infer<typeof visualDeckV4SlideBriefsReflectionStageOutputSchema>
export type VisualDeckV4ContentRevisionPatch = z.infer<typeof visualDeckV4ContentRevisionPatchSchema>
export type VisualDeckV4LayoutRevisionPatch = z.infer<typeof visualDeckV4LayoutRevisionPatchSchema>
export type VisualDeckV4RevisionApplicationResult = z.infer<typeof visualDeckV4RevisionApplicationResultSchema>
export type VisualDeckV4CreativeManuscript = z.infer<typeof visualDeckV4CreativeManuscriptSchema>
export type VisualDeckV4ReviewManuscript = z.infer<typeof visualDeckV4ReviewManuscriptSchema>
export type VisualDeckV4ProposalDraft = z.infer<typeof visualDeckV4ProposalDraftSchema>
export type VisualDeckV4Proposal = z.infer<typeof visualDeckV4ProposalSchema>
export type VisualDeckV4RenderedSlide = z.infer<typeof visualDeckV4RenderedSlideSchema>
export type VisualDeckV4DeckManifest = z.infer<typeof visualDeckV4DeckManifestSchema>

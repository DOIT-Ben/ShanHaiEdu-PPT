import { z } from 'zod'
import { CONTRACT_VERSION, qualityOverrideAuditSchema, qualityPolicyAuditSchema } from './contracts'
import { layoutPresentationText } from './presentation-text-layout'
import { releaseIdentitySchema } from './release-identity'
import { visualDeckV4ProposalSchema } from './visual-deck-v4-contracts'

const identifierSchema = z.string().trim().min(1).max(160)
const sourceChunkIdsSchema = z.array(identifierSchema).min(1).max(200)
const sourceAssetIdsSchema = z.array(identifierSchema).max(200).optional()
const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/)

export const assetIntentSchema = z.object({
  searchQueries: z.array(z.string().trim().min(2).max(160)).min(1).max(6),
  mediaType: z.enum(['PHOTO', 'ILLUSTRATION', 'ICON', 'DIAGRAM', 'TEXTURE']),
  styleKeywords: z.array(z.string().trim().min(2).max(80)).min(1).max(8),
  transparencyPreference: z.enum(['PREFER_TRANSPARENT', 'PREFER_OPAQUE', 'EITHER']),
}).strict()

export const slideElementPlacementSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().superRefine((value, context) => {
  if (value.x + value.width > 1.000_001 || value.y + value.height > 1.000_001) {
    context.addIssue({ code: 'custom', message: 'element placement must stay inside the slide' })
  }
})

export const layeredImageElementSchema = z.object({
  kind: z.literal('IMAGE'),
  elementId: identifierSchema,
  role: z.enum(['BASE_LAYER', 'KNOWLEDGE_VISUAL', 'DIAGRAM', 'CHARACTER']),
  knowledgePoint: z.string().trim().min(3).max(500),
  prompt: z.string().trim().min(20).max(3_000),
  negativePrompt: z.string().trim().min(3).max(1_000),
  sourceChunkIds: sourceChunkIdsSchema,
  sourceAssetIds: sourceAssetIdsSchema,
  sourceAssetStrategy: z.enum(['REUSE_ORIGINAL', 'REFERENCE_GENERATION', 'SEARCH_WEB', 'REGENERATE']).optional(),
  assetIntent: assetIntentSchema.optional(),
  placement: slideElementPlacementSchema,
  zIndex: z.number().int().min(0).max(100),
  fit: z.enum(['COVER', 'CONTAIN']),
  aspectRatio: z.enum(['16:9', '4:3', '1:1', '3:4']),
  backgroundMode: z.enum(['OPAQUE', 'TRANSPARENT']),
  reuseKey: identifierSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.sourceAssetStrategy && !['REGENERATE', 'SEARCH_WEB'].includes(value.sourceAssetStrategy) && (value.sourceAssetIds?.length ?? 0) === 0) {
    context.addIssue({ code: 'custom', path: ['sourceAssetIds'], message: 'source asset reuse requires a source asset id' })
  }
  if (value.sourceAssetStrategy && !['REGENERATE', 'SEARCH_WEB'].includes(value.sourceAssetStrategy) && (value.sourceAssetIds?.length ?? 0) > 1) {
    context.addIssue({ code: 'custom', path: ['sourceAssetIds'], message: 'one image element must reference exactly one source asset' })
  }
  if (value.sourceAssetStrategy === 'SEARCH_WEB' && !value.assetIntent) {
    context.addIssue({ code: 'custom', path: ['assetIntent'], message: 'web asset search requires an explicit asset intent' })
  }
  if (value.sourceAssetStrategy === 'SEARCH_WEB' && (value.sourceAssetIds?.length ?? 0) > 0) {
    context.addIssue({ code: 'custom', path: ['sourceAssetIds'], message: 'web asset search cannot reference source assets' })
  }
})

export const layeredTextElementSchema = z.object({
  kind: z.literal('TEXT'),
  elementId: identifierSchema,
  role: z.enum(['TITLE', 'SUBTITLE', 'BODY', 'CAPTION', 'QUESTION']),
  text: z.string().trim().min(1).max(1_500),
  sourceChunkIds: sourceChunkIdsSchema,
  sourceAssetIds: sourceAssetIdsSchema,
  placement: slideElementPlacementSchema,
  zIndex: z.number().int().min(0).max(100),
  style: z.object({
    fontSize: z.number().int().min(10).max(60),
    bold: z.boolean(),
    color: hexColorSchema,
    align: z.enum(['LEFT', 'CENTER', 'RIGHT']),
  }).strict(),
}).strict().superRefine((value, context) => {
  const layout = layoutPresentationText({
    text: value.text,
    fontSize: value.style.fontSize,
    width: value.placement.width,
    height: value.placement.height,
  })
  if (!layout.fits) {
    context.addIssue({
      code: 'custom',
      path: ['text'],
      message: 'text must fit its placement at the declared font size',
    })
  }
})

export const layeredShapeElementSchema = z.object({
  kind: z.literal('SHAPE'),
  elementId: identifierSchema,
  role: z.enum(['CONTENT_PANEL', 'HIGHLIGHT', 'ARROW', 'DIVIDER']),
  shape: z.enum(['RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE', 'LINE', 'ARROW']),
  placement: slideElementPlacementSchema,
  zIndex: z.number().int().min(0).max(100),
  fillColor: hexColorSchema,
  transparency: z.number().int().min(0).max(100),
}).strict()

export const layeredSlideElementSchema = z.discriminatedUnion('kind', [
  layeredImageElementSchema,
  layeredTextElementSchema,
  layeredShapeElementSchema,
])

export const layeredSlideDesignSchema = z.object({
  designKind: z.enum(['COVER', 'CONTENT']),
  backgroundColor: hexColorSchema,
  elements: z.array(layeredSlideElementSchema).min(3).max(140),
}).strict().superRefine((value, context) => {
  const ids = value.elements.map((element) => element.elementId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['elements'], message: 'layer element ids must be unique' })
  }
  const images = value.elements.filter((element) => element.kind === 'IMAGE')
  if (images.filter((element) => element.role === 'BASE_LAYER').length !== 1) {
    context.addIssue({ code: 'custom', path: ['elements'], message: 'layered slide requires exactly one base layer image' })
  }
  if (images.filter((element) => element.role !== 'BASE_LAYER').length > 4) {
    context.addIssue({ code: 'custom', path: ['elements'], message: 'layered slide allows at most four knowledge visual assets' })
  }
  if (!value.elements.some((element) => element.kind === 'TEXT')) {
    context.addIssue({ code: 'custom', path: ['elements'], message: 'layered slide requires editable text' })
  }
})

export const presentationLayoutSchema = z.enum([
  'HERO',
  'SPLIT',
  'EDITORIAL',
  'STATEMENT',
  'IMAGE_FULL',
])

export const curriculumBriefSchema = z.object({
  subject: z.string().trim().min(1).max(100).nullable(),
  grade: z.string().trim().min(1).max(100).nullable(),
  lessonTitle: z.string().trim().min(1).max(200),
  sourceSummary: z.string().trim().min(20).max(4_000),
  learningObjectives: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
  scopeBoundaries: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  prohibitedExtensions: z.array(z.string().trim().min(1).max(300)).max(20),
  sourceChunkIds: sourceChunkIdsSchema,
  sourceAssetIds: sourceAssetIdsSchema,
}).strict()

export const blueprintSlideSchema = z.object({
  pageNumber: z.number().int().positive().max(50),
  title: z.string().trim().min(1).max(120),
  body: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  layout: presentationLayoutSchema,
  visualIntent: z.string().trim().min(10).max(1_000),
  visualPrompt: z.string().trim().min(20).max(3_000),
  sourceChunkIds: sourceChunkIdsSchema,
  sourceAssetIds: sourceAssetIdsSchema,
  layeredDesign: layeredSlideDesignSchema.optional(),
}).strict()

export const blueprintDraftSchema = z.object({
  title: z.string().trim().min(1).max(160),
  curriculum: curriculumBriefSchema,
  slides: z.array(blueprintSlideSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  value.slides.forEach((slide, index) => {
    if (slide.pageNumber !== index + 1) {
      context.addIssue({
        code: 'custom',
        path: ['slides', index, 'pageNumber'],
        message: 'slide page numbers must be continuous and start at 1',
      })
    }
  })
})

const slideImageBlueprintSlideSchema = blueprintSlideSchema.omit({ layeredDesign: true }).strict()

export const slideImageBlueprintDraftSchema = blueprintDraftSchema.safeExtend({
  slides: z.array(slideImageBlueprintSlideSchema).min(2).max(50),
}).strict()

export const blueprintReflectionDimensionSchema = z.enum([
  'AUDIENCE_FIT',
  'GOAL_ALIGNMENT',
  'NARRATIVE',
  'INFORMATION_HIERARCHY',
  'COMPOSITION',
  'VISUAL_COHERENCE',
  'PROMPT_EXECUTABILITY',
])

const blueprintReflectionFindingSchema = z.object({
  dimension: blueprintReflectionDimensionSchema,
  score: z.number().int().min(1).max(5),
  diagnosis: z.string().trim().min(10).max(600),
  revisionInstruction: z.string().trim().min(10).max(600),
}).strict()

export const blueprintReflectionSchema = z.object({
  deckBrief: z.object({
    targetAudience: z.string().trim().min(3).max(500),
    presentationGoal: z.string().trim().min(3).max(1_000),
    useContext: z.string().trim().min(3).max(500),
    audienceNeeds: z.array(z.string().trim().min(3).max(300)).min(1).max(8),
    narrativeArc: z.array(z.string().trim().min(3).max(500)).min(2).max(12),
    visualSystem: z.object({
      artDirection: z.string().trim().min(10).max(1_000),
      palette: z.string().trim().min(3).max(500),
      compositionRules: z.array(z.string().trim().min(3).max(300)).min(2).max(8),
      continuityRules: z.array(z.string().trim().min(3).max(300)).min(2).max(8),
    }).strict(),
  }).strict(),
  findings: z.array(blueprintReflectionFindingSchema).length(7),
  revisedBlueprint: blueprintDraftSchema,
}).strict().superRefine((value, context) => {
  const dimensions = value.findings.map((finding) => finding.dimension)
  if (new Set(dimensions).size !== blueprintReflectionDimensionSchema.options.length) {
    context.addIssue({ code: 'custom', path: ['findings'], message: 'reflection must cover every rubric dimension exactly once' })
  }
})

export const slideImageBlueprintReflectionSchema = blueprintReflectionSchema.safeExtend({
  revisedBlueprint: slideImageBlueprintDraftSchema,
}).strict()

const layeredBlueprintSlideSchema = blueprintSlideSchema.extend({
  layeredDesign: layeredSlideDesignSchema,
}).strict()

export const layeredBlueprintDraftSchema = blueprintDraftSchema.safeExtend({
  slides: z.array(layeredBlueprintSlideSchema).min(2).max(50),
}).strict().superRefine((value, context) => {
  value.slides.forEach((slide, index) => {
    const expected = index === 0 ? 'COVER' : 'CONTENT'
    if (slide.layeredDesign.designKind !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['slides', index, 'layeredDesign', 'designKind'],
        message: index === 0 ? 'first layered slide must be COVER' : 'only the first layered slide may be COVER',
      })
    }
  })
})

const sourceManifestSchema = z.array(z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(300),
  kind: z.enum(['TEXT', 'IMAGE', 'PDF', 'MARKDOWN']),
  mimeType: z.string().trim().min(1).max(160).optional(),
  pageCount: z.number().int().positive().max(50).optional(),
  status: z.enum(['READY', 'FAILED']),
  failureCode: z.string().trim().min(1).max(160).optional(),
}).strict()).max(7).default([])

const sourceAssetSummarySchema = z.array(z.object({
  id: identifierSchema,
  sourceId: identifierSchema,
  name: z.string().trim().min(1).max(300),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  byteLength: z.number().int().positive().max(24 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
  pageNumber: z.number().int().positive().max(50).optional(),
  region: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  }).strict().optional(),
  caption: z.string().trim().min(1).max(500).optional(),
  ocrText: z.string().trim().min(1).max(2_000).optional(),
}).strict()).max(200).default([])

export const presentationBlueprintSchema = blueprintDraftSchema.extend({
  id: identifierSchema,
  visualDirection: z.string().trim().min(3).max(1_000),
  renderMode: z.enum(['SLIDE_IMAGE_V2', 'SLIDE_IMAGE_V2_1', 'LAYERED_COURSEWARE_V3', 'VISUAL_DECK_V4']).optional(),
  coverDesignMode: z.enum(['INDEPENDENT', 'FOLLOW_TEMPLATE']).optional(),
  visualDeckV4Proposal: visualDeckV4ProposalSchema.optional(),
  sourceManifest: sourceManifestSchema,
  sourceAssets: sourceAssetSummarySchema,
  createdAt: z.string().datetime(),
}).strict().transform((value) => ({
  ...value,
  ...(value.renderMode === 'LAYERED_COURSEWARE_V3' && value.coverDesignMode === undefined
    ? { coverDesignMode: 'INDEPENDENT' as const }
    : {}),
  curriculum: { ...value.curriculum, sourceAssetIds: value.curriculum.sourceAssetIds ?? [] },
  slides: value.slides.map((slide) => ({
    ...slide,
    sourceAssetIds: slide.sourceAssetIds ?? [],
    ...(slide.layeredDesign ? {
      layeredDesign: {
        ...slide.layeredDesign,
        elements: slide.layeredDesign.elements.map((element) => element.kind === 'IMAGE'
          ? {
              ...element,
              sourceAssetIds: element.sourceAssetIds ?? [],
              sourceAssetStrategy: element.sourceAssetStrategy ?? 'REGENERATE' as const,
            }
          : element.kind === 'TEXT'
            ? { ...element, sourceAssetIds: element.sourceAssetIds ?? [] }
            : element),
      },
    } : {}),
  })),
})).superRefine((value, context) => {
  if (value.renderMode === 'VISUAL_DECK_V4' && !value.visualDeckV4Proposal) {
    context.addIssue({ code: 'custom', path: ['visualDeckV4Proposal'], message: 'v4 blueprint requires a visual deck proposal' })
  }
  if (value.renderMode !== 'VISUAL_DECK_V4' && value.visualDeckV4Proposal) {
    context.addIssue({ code: 'custom', path: ['visualDeckV4Proposal'], message: 'v4 proposal is only valid for v4 blueprints' })
  }
  if (value.visualDeckV4Proposal) {
    value.slides.forEach((slide, index) => {
      const brief = value.visualDeckV4Proposal!.slideBriefs[index]
      if (!brief || brief.pageNumber !== slide.pageNumber || brief.title !== slide.title) {
        context.addIssue({ code: 'custom', path: ['slides', index], message: 'v4 blueprint slides must match proposal briefs' })
      } else if (brief.sourceChunkIds.some((id) => !slide.sourceChunkIds.includes(id))) {
        context.addIssue({ code: 'custom', path: ['slides', index, 'sourceChunkIds'], message: 'v4 blueprint must retain brief source references' })
      }
    })
  }
  if (value.renderMode !== 'LAYERED_COURSEWARE_V3') return
  value.slides.forEach((slide, index) => {
    if (!slide.layeredDesign) {
      context.addIssue({ code: 'custom', path: ['slides', index, 'layeredDesign'], message: 'layered mode requires a design for every slide' })
      return
    }
    const expected = index === 0 ? 'COVER' : 'CONTENT'
    if (slide.layeredDesign.designKind !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['slides', index, 'layeredDesign', 'designKind'],
        message: index === 0 ? 'first layered slide must be COVER' : 'only the first layered slide may be COVER',
      })
    }
    if (index === 0 && value.coverDesignMode === 'INDEPENDENT') {
      const hasBody = slide.layeredDesign.elements.some((element) => element.kind === 'TEXT' && element.role === 'BODY')
      const hasContentPanel = slide.layeredDesign.elements.some((element) => element.kind === 'SHAPE' && element.role === 'CONTENT_PANEL')
      const hasTitle = slide.layeredDesign.elements.some((element) => element.kind === 'TEXT' && element.role === 'TITLE')
      const hasHeroVisual = slide.layeredDesign.elements.some((element) => element.kind === 'IMAGE' && element.role !== 'BASE_LAYER')
      if (hasBody || hasContentPanel || !hasTitle || !hasHeroVisual) {
        context.addIssue({
          code: 'custom',
          path: ['slides', index, 'layeredDesign', 'elements'],
          message: 'independent cover requires title and hero visual without body copy or content panel',
        })
      }
    }
  })
})

export const slideVisualReviewSchema = z.object({
  approved: z.boolean(),
  textDetected: z.boolean(),
  visualScore: z.number().int().min(0).max(100),
  reasons: z.array(z.string().trim().min(1).max(300)).max(6),
  retryInstruction: z.string().trim().min(10).max(1_000).nullable(),
  qualityImpact: z.enum(['PASS', 'NON_BLOCKING_RECOMMENDATION', 'HARD_BLOCKER']).optional(),
}).strict().superRefine((value, context) => {
  const qualityImpact = value.qualityImpact ?? (value.approved ? 'PASS' : 'HARD_BLOCKER')
  if (value.approved && value.textDetected) {
    context.addIssue({ code: 'custom', path: ['approved'], message: 'an image with detected text cannot be approved' })
  }
  if (!value.approved && value.retryInstruction === null) {
    context.addIssue({ code: 'custom', path: ['retryInstruction'], message: 'rejected image requires a retry instruction' })
  }
  if (value.approved !== (qualityImpact === 'PASS')) {
    context.addIssue({ code: 'custom', path: ['qualityImpact'], message: 'quality impact must agree with approval' })
  }
  if (!value.approved && value.textDetected && qualityImpact !== 'HARD_BLOCKER') {
    context.addIssue({ code: 'custom', path: ['qualityImpact'], message: 'detected invalid text is a hard blocker' })
  }
})

export const deckReviewIssueCategorySchema = z.enum([
  'CURRICULUM_GAP',
  'FACTUAL_RISK',
  'SEQUENCE_BREAK',
  'DUPLICATION',
  'COVER_IMPACT',
  'VISUAL_CONSISTENCY',
  'COMPOSITION_CONFLICT',
  'IMAGE_QUALITY',
  'ASSET_RELEVANCE',
  'LAYERING_CONFLICT',
  'CHILD_READABILITY',
])

export const deckReviewIssueSchema = z.object({
  id: identifierSchema,
  category: deckReviewIssueCategorySchema,
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  summary: z.string().trim().min(1).max(500),
  slideIds: z.array(identifierSchema).min(1).max(50),
  sourceChunkIds: z.array(identifierSchema).max(200),
  status: z.literal('OPEN'),
  repairDomain: z.enum(['KNOWLEDGE', 'ASSET', 'LAYOUT']).optional(),
}).strict().superRefine((value, context) => {
  if ((['CURRICULUM_GAP', 'FACTUAL_RISK'].includes(value.category) || value.repairDomain === 'KNOWLEDGE')
    && value.sourceChunkIds.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['sourceChunkIds'],
      message: 'curriculum and factual issues require source references',
    })
  }
})

const deckReviewDraftObjectSchema = z.object({
  qualityScore: z.number().int().min(0).max(100),
  curriculumCoverageScore: z.number().int().min(0).max(100),
  narrativeCoherenceScore: z.number().int().min(0).max(100),
  visualConsistencyScore: z.number().int().min(0).max(100),
  compositionScore: z.number().int().min(0).max(100),
  summary: z.string().trim().min(10).max(1_000),
  reviewedSourceChunkIds: z.array(identifierSchema).min(1).max(200),
  issues: z.array(deckReviewIssueSchema).max(100),
}).strict()

function requireUniqueDeckReviewIssueIds(
  value: z.infer<typeof deckReviewDraftObjectSchema>,
  context: z.RefinementCtx,
) {
  const seen = new Set<string>()
  value.issues.forEach((issue, index) => {
    if (seen.has(issue.id)) {
      context.addIssue({
        code: 'custom',
        path: ['issues', index, 'id'],
        message: 'deck review issue ids must be unique',
      })
    }
    seen.add(issue.id)
  })
}

export const deckReviewDraftSchema = deckReviewDraftObjectSchema.superRefine(requireUniqueDeckReviewIssueIds)

export const deckReviewSchema = deckReviewDraftObjectSchema.extend({
  id: identifierSchema,
  revisionRound: z.number().int().min(0).max(4),
  createdAt: z.string().datetime(),
}).strict().superRefine(requireUniqueDeckReviewIssueIds)

export const revisionOperationSchema = z.object({
  id: identifierSchema,
  slideId: identifierSchema,
  kind: z.enum(['UPDATE_CONTENT', 'REGENERATE_IMAGE', 'RELAYOUT']),
  issueIds: z.array(identifierSchema).min(1).max(20),
  instruction: z.string().trim().min(10).max(2_000),
  sourceChunkIds: z.array(identifierSchema).max(200),
  targetElementId: identifierSchema.optional(),
}).strict()

export const revisionPlanDraftSchema = z.object({
  summary: z.string().trim().min(10).max(1_000),
  operations: z.array(revisionOperationSchema).min(1).max(50),
}).strict()

export const revisionPlanSchema = revisionPlanDraftSchema.extend({
  id: identifierSchema,
  reviewId: identifierSchema,
  revisionRound: z.number().int().min(1).max(4),
  createdAt: z.string().datetime(),
}).strict()

export const deliveryArtifactSchema = z.object({
  artifactId: identifierSchema,
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(160),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive(),
}).strict()

export const webAssetProvenanceSchema = z.object({
  provider: z.enum(['WIKIMEDIA_COMMONS', 'OPENVERSE']),
  providerAssetId: identifierSchema,
  title: z.string().trim().min(1).max(1_000),
  sourceUrl: z.string().url().max(2_000),
  creator: z.string().trim().min(1).max(500).nullable(),
  license: z.enum(['PUBLIC_DOMAIN', 'CC0', 'CC_BY']),
  licenseUrl: z.string().url().max(2_000),
  attribution: z.string().trim().min(1).max(2_000).nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  selectionReview: z.object({
    visualScore: z.number().int().min(0).max(100),
    reasons: z.array(z.string().trim().min(1).max(300)).max(6),
  }).strict().optional(),
}).strict()

export const verifiedDeliveryIdentitySchema = z.object({
  status: z.literal('VERIFIED'),
  slideCount: z.number().int().min(1).max(50),
  pageNumbers: z.array(z.number().int().min(1).max(50)).min(1).max(50),
  blueprintHash: z.string().regex(/^[a-f0-9]{64}$/),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.pageNumbers.length !== value.slideCount
    || value.pageNumbers.some((pageNumber, index) => pageNumber !== index + 1)) {
    context.addIssue({ code: 'custom', path: ['pageNumbers'], message: 'verified delivery pages must be complete and continuous' })
  }
})

export const deliveryIdentitySchema = z.discriminatedUnion('status', [
  verifiedDeliveryIdentitySchema,
  z.object({ status: z.literal('LEGACY_UNVERIFIED') }).strict(),
])

const deliveryRecordObjectSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION).default(CONTRACT_VERSION),
  id: identifierSchema,
  runId: identifierSchema,
  revisionRound: z.number().int().min(0).max(4),
  qualityScore: z.number().int().min(0).max(100).nullable(),
  qualityOverride: z.boolean(),
  disposition: z.literal('FINAL').default('FINAL'),
  qualityStatus: z.enum(['APPROVED', 'SYSTEM_POLICY_ACCEPTED', 'OVERRIDDEN_INTERNAL']).optional(),
  openIssueIds: z.array(identifierSchema).max(50)
    .refine((value) => new Set(value).size === value.length).default([]),
  identity: deliveryIdentitySchema.default({ status: 'LEGACY_UNVERIFIED' }),
  qualityPolicyAudit: qualityPolicyAuditSchema.nullable().optional(),
  qualityOverrideAudit: qualityOverrideAuditSchema.nullable().optional(),
  preview: deliveryArtifactSchema.extend({ mimeType: z.literal('image/png') }).strict(),
  pptx: deliveryArtifactSchema.extend({
    mimeType: z.literal('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  }).strict(),
  sources: deliveryArtifactSchema.extend({ mimeType: z.literal('application/json') }).strict().optional(),
  release: releaseIdentitySchema.optional(),
  createdAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  const hasSystemPolicyAudit = Boolean(value.qualityPolicyAudit)
  const qualityStatus = value.qualityStatus
    ?? (hasSystemPolicyAudit
      ? 'SYSTEM_POLICY_ACCEPTED'
      : value.qualityOverride ? 'OVERRIDDEN_INTERNAL' : 'APPROVED')
  if (qualityStatus === 'OVERRIDDEN_INTERNAL' && !value.qualityOverride) {
    context.addIssue({ code: 'custom', path: ['qualityStatus'], message: 'internal override status requires qualityOverride' })
  }
  if (qualityStatus === 'SYSTEM_POLICY_ACCEPTED' && (!value.qualityOverride || !hasSystemPolicyAudit)) {
    context.addIssue({ code: 'custom', path: ['qualityPolicyAudit'], message: 'system policy status requires policy audit' })
  }
  if (qualityStatus === 'APPROVED' && value.qualityOverride) {
    context.addIssue({ code: 'custom', path: ['qualityStatus'], message: 'quality override cannot be marked approved' })
  }
  if (value.qualityPolicyAudit && qualityStatus !== 'SYSTEM_POLICY_ACCEPTED') {
    context.addIssue({ code: 'custom', path: ['qualityPolicyAudit'], message: 'policy audit requires system policy status' })
  }
  if (value.qualityOverrideAudit && qualityStatus !== 'OVERRIDDEN_INTERNAL') {
    context.addIssue({ code: 'custom', path: ['qualityOverrideAudit'], message: 'actor audit requires internal override status' })
  }
  const legacyUnauditedOverride = qualityStatus === 'OVERRIDDEN_INTERNAL'
    && value.identity.status === 'LEGACY_UNVERIFIED'
    && !value.qualityOverrideAudit
    && !value.qualityPolicyAudit
  if (qualityStatus === 'OVERRIDDEN_INTERNAL' && !value.qualityOverrideAudit && !legacyUnauditedOverride) {
    context.addIssue({ code: 'custom', path: ['qualityOverrideAudit'], message: 'internal override status requires actor audit' })
  }
  const auditIssueIds = qualityStatus === 'SYSTEM_POLICY_ACCEPTED'
    ? value.qualityPolicyAudit?.issueIds
    : qualityStatus === 'OVERRIDDEN_INTERNAL' ? value.qualityOverrideAudit?.issueIds : []
  if (auditIssueIds && JSON.stringify(value.openIssueIds) !== JSON.stringify(auditIssueIds)) {
    context.addIssue({ code: 'custom', path: ['openIssueIds'], message: 'delivery issue ids must match quality audit' })
  }
  if (qualityStatus === 'APPROVED' && value.openIssueIds.length > 0) {
    context.addIssue({ code: 'custom', path: ['openIssueIds'], message: 'approved delivery cannot retain open issues' })
  }
})

export const deliveryRecordSchema = deliveryRecordObjectSchema.transform((value) => {
  const qualityPolicyAudit = value.qualityPolicyAudit ?? null
  return {
    ...value,
    qualityStatus: value.qualityStatus
      ?? (qualityPolicyAudit
        ? 'SYSTEM_POLICY_ACCEPTED' as const
        : value.qualityOverride ? 'OVERRIDDEN_INTERNAL' as const : 'APPROVED' as const),
    qualityPolicyAudit,
    qualityOverrideAudit: value.qualityOverrideAudit ?? null,
  }
})

export const publicDeliveryRecordSchema = deliveryRecordSchema.refine(
  (value) => value.identity.status === 'VERIFIED',
  { path: ['identity', 'status'], message: 'public delivery must have a verified identity' },
)

export type BlueprintDraft = z.infer<typeof blueprintDraftSchema>
export type PresentationBlueprint = z.infer<typeof presentationBlueprintSchema>
export type AssetIntent = z.infer<typeof assetIntentSchema>
export type SlideVisualReview = z.infer<typeof slideVisualReviewSchema>
export type DeckReviewIssue = z.infer<typeof deckReviewIssueSchema>
export type DeckReviewDraft = z.infer<typeof deckReviewDraftSchema>
export type DeckReview = z.infer<typeof deckReviewSchema>
export type RevisionPlanDraft = z.infer<typeof revisionPlanDraftSchema>
export type RevisionPlan = z.infer<typeof revisionPlanSchema>
export type DeliveryRecordInput = z.input<typeof deliveryRecordSchema>
export type DeliveryRecord = z.output<typeof deliveryRecordSchema>
export type PublicDeliveryRecord = z.output<typeof publicDeliveryRecordSchema>

export function revisionRepairDomain(operation: z.infer<typeof revisionOperationSchema>) {
  if (operation.kind === 'UPDATE_CONTENT') return 'KNOWLEDGE' as const
  if (operation.kind === 'REGENERATE_IMAGE') return 'ASSET' as const
  return 'LAYOUT' as const
}

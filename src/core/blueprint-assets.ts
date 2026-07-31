import type { PresentationBlueprint } from '../presentation-contracts'
import { hashInput } from './hash'
import type { RunRecord, StepRecord } from './ports'

export type BlueprintImageRequirement = Readonly<{
  assetKey: string
  idempotencyKey: string
  slideId: string
  pageNumber: number
  elementId: string | null
  reuseKey: string | null
  role: string
  knowledgePoint: string
  prompt: string
  negativePrompt: string | null
  aspectRatio: '16:9' | '4:3' | '1:1' | '3:4'
  backgroundMode: 'OPAQUE' | 'TRANSPARENT'
  assetIntent: Extract<NonNullable<PresentationBlueprint['slides'][number]['layeredDesign']>['elements'][number], { kind: 'IMAGE' }>['assetIntent'] | null
  sourceAssetIds: readonly string[]
  sourceAssetStrategy: 'REUSE_ORIGINAL' | 'REFERENCE_GENERATION' | 'SEARCH_WEB' | 'REGENERATE'
}>

export function blueprintElementAssetKey(
  slide: PresentationBlueprint['slides'][number],
  element: Extract<NonNullable<PresentationBlueprint['slides'][number]['layeredDesign']>['elements'][number], { kind: 'IMAGE' }>,
) {
  const strategy = element.sourceAssetStrategy ?? 'REGENERATE'
  const sourceIdentity = strategy === 'REGENERATE' ? '' : `:${(element.sourceAssetIds ?? []).join(',')}`
  return element.reuseKey
    ? `reuse:${element.reuseKey}:${strategy}${sourceIdentity}`
    : `slide:${slide.pageNumber}:element:${element.elementId}:${strategy}${sourceIdentity}`
}

function slideImageCompositionInstruction(layout: PresentationBlueprint['slides'][number]['layout']) {
  if (layout === 'SPLIT') {
    return 'Place the primary visual subject in the right 46% of the frame and keep the left 48% naturally quiet for editable text.'
  }
  if (layout === 'EDITORIAL') {
    return 'Place the primary visual subject in the left 46% of the frame and keep the right 48% naturally quiet for editable text.'
  }
  if (layout === 'STATEMENT') {
    return 'Use one strong focal subject in the lower-right half and keep the upper-left area naturally quiet for a concise statement.'
  }
  if (layout === 'IMAGE_FULL') {
    return 'Use an immersive full-frame scene with one unmistakable focal subject and low detail behind the later text area.'
  }
  return 'Place one strong focal subject in the right half and keep the left half naturally quiet for the title and key message.'
}

export function completeSlideImageV21Prompt(
  blueprint: Pick<PresentationBlueprint, 'visualDirection'>,
  slide: PresentationBlueprint['slides'][number],
) {
  return [
    'STRICT PRESENTATION IMAGE: create visual imagery only, never typography or symbols.',
    slide.visualPrompt.trim().slice(0, 1_600),
    `Global art direction: ${blueprint.visualDirection.trim().slice(0, 500)}.`,
    'Create one continuous, polished, unframed 16:9 image with a clear visual hierarchy and one primary focal idea.',
    slideImageCompositionInstruction(slide.layout),
    'The quiet area must be part of the natural scene; do not draw a text box, caption panel, card, collage, frame, border, gradient overlay, vignette, interface, poster layout or decorative chrome.',
    'No text, no letters, no numbers, no formulas, no captions, no watermark, no logo.',
  ].join(' ')
}

export function completeVisualDeckV4Prompt(
  blueprint: Pick<PresentationBlueprint, 'visualDeckV4Proposal'>,
  slide: PresentationBlueprint['slides'][number],
) {
  const proposal = blueprint.visualDeckV4Proposal
  const brief = proposal?.slideBriefs.find((candidate) => candidate.pageNumber === slide.pageNumber)
  if (!proposal || !brief) throw new Error('VISUAL_DECK_V4_BRIEF_MISSING')
  const allowedCopy = visualDeckV4AllowedCopy(brief)
  return [
    'Create one finished, full-bleed 16:9 presentation slide as a single raster image.',
    `Slide role: ${brief.role}.`,
    `Title: ${brief.title}.`,
    `Core message: ${brief.keyClaim}.`,
    `Audience takeaway: ${brief.audienceTakeaway}.`,
    `Allowed on-slide copy (exact wording): ${allowedCopy.join(' | ')}.`,
    brief.facts.length > 0 ? `Facts that must remain accurate: ${brief.facts.join(' | ')}.` : '',
    brief.numbers.length > 0 ? `Numbers that must appear exactly: ${brief.numbers.join(' | ')}.` : '',
    brief.formulas.length > 0 ? `Formulas that must appear exactly: ${brief.formulas.join(' | ')}.` : '',
    `Visual idea: ${brief.visualMetaphor}.`,
    `Composition: ${brief.composition}.`,
    `Information order: ${brief.informationHierarchy.join(' -> ')}.`,
    `Global art direction: ${proposal.visualContract.artDirection}.`,
    `Palette: ${proposal.visualContract.palette.join(', ')}.`,
    `Typography: ${proposal.visualContract.typography}.`,
    `Medium: ${proposal.visualContract.medium}.`,
    `Composition rules: ${proposal.visualContract.compositionRules.join(' | ')}.`,
    `Continuity rules: ${proposal.visualContract.continuityRules.join(' | ')}.`,
    `Never include: ${[...proposal.visualContract.forbidden, ...proposal.presentationSpec.forbidden].join(' | ')}.`,
    'Do not invent any additional labels, captions, page numbers, interface text, or decorative words. Every visible teaching label beyond the title must already be listed in the allowed on-slide copy.',
    'Do not create a contact sheet, thumbnail grid, multi-slide collage, editor interface, frame, watermark, logo, or content from any other slide.',
  ].filter(Boolean).join(' ')
}

export function visualDeckV4AllowedCopy(
  brief: NonNullable<PresentationBlueprint['visualDeckV4Proposal']>['slideBriefs'][number],
) {
  return [...new Set([brief.title, ...brief.lockedCopy].map((copy) => copy.trim()).filter(Boolean))]
}

export function blueprintImageRequirements(
  run: Pick<RunRecord, 'id' | 'revisionRound'>,
  blueprint: PresentationBlueprint,
): readonly BlueprintImageRequirement[] {
  if (blueprint.renderMode !== 'LAYERED_COURSEWARE_V3') {
    return blueprint.slides.map((slide) => ({
      assetKey: `slide:${slide.pageNumber}`,
      idempotencyKey: `${run.id}:slide:${slide.pageNumber}:image:r${run.revisionRound}:v1`,
      slideId: `${run.id}:slide:${slide.pageNumber}`,
      pageNumber: slide.pageNumber,
      elementId: null,
      reuseKey: null,
      role: 'BASE_LAYER',
      knowledgePoint: slide.visualIntent,
      prompt: blueprint.renderMode === 'VISUAL_DECK_V4'
        ? completeVisualDeckV4Prompt(blueprint, slide)
        : blueprint.renderMode === 'SLIDE_IMAGE_V2_1'
          ? completeSlideImageV21Prompt(blueprint, slide)
          : slide.visualPrompt,
      negativePrompt: null,
      aspectRatio: '16:9',
      backgroundMode: 'OPAQUE',
      assetIntent: null,
      sourceAssetIds: [],
      sourceAssetStrategy: 'REGENERATE',
    }))
  }

  const unique = new Map<string, BlueprintImageRequirement>()
  for (const slide of blueprint.slides) {
    if (!slide.layeredDesign) throw new Error('LAYERED_DESIGN_MISSING')
    for (const element of slide.layeredDesign.elements) {
      if (element.kind !== 'IMAGE') continue
      const sourceAssetStrategy = element.sourceAssetStrategy ?? 'REGENERATE'
      const assetKey = blueprintElementAssetKey(slide, element)
      if (unique.has(assetKey)) continue
      const keyHash = hashInput({ assetKey }).slice(0, 28)
      unique.set(assetKey, {
        assetKey,
        idempotencyKey: `${run.id}:asset:${keyHash}:r${run.revisionRound}:v1`,
        slideId: `${run.id}:slide:${slide.pageNumber}`,
        pageNumber: slide.pageNumber,
        elementId: element.elementId,
        reuseKey: element.reuseKey ?? null,
        role: element.role,
        knowledgePoint: element.knowledgePoint,
        prompt: element.prompt,
        negativePrompt: element.negativePrompt,
        aspectRatio: element.aspectRatio,
        backgroundMode: element.backgroundMode,
        assetIntent: element.assetIntent ?? null,
        sourceAssetIds: element.sourceAssetIds ?? [],
        sourceAssetStrategy,
      })
    }
  }
  return [...unique.values()]
}

export function latestCompletedAssetStep(
  steps: readonly StepRecord[],
  requirement: BlueprintImageRequirement,
  maxRevisionRound: number,
) {
  const match = /^(.*):r\d+:v1$/.exec(requirement.idempotencyKey)
  if (!match) return null
  const prefix = `${match[1]}:r`
  return steps
    .filter((step) => step.tool === 'generate_slide_image' && step.status === 'COMPLETED')
    .map((step) => ({ step, round: Number(new RegExp(`^${escapeRegExp(prefix)}(\\d+):v1$`).exec(step.idempotencyKey)?.[1] ?? -1) }))
    .filter((candidate) => candidate.round >= 0 && candidate.round <= maxRevisionRound)
    .sort((left, right) => right.round - left.round)[0]?.step ?? null
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

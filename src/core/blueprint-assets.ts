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
  prompt: string
  negativePrompt: string | null
  aspectRatio: '16:9' | '4:3' | '1:1' | '3:4'
  backgroundMode: 'OPAQUE' | 'TRANSPARENT'
  sourceAssetIds: readonly string[]
  sourceAssetStrategy: 'REUSE_ORIGINAL' | 'REFERENCE_GENERATION' | 'REGENERATE'
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
      prompt: slide.visualPrompt,
      negativePrompt: null,
      aspectRatio: '16:9',
      backgroundMode: 'OPAQUE',
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
        prompt: element.prompt,
        negativePrompt: element.negativePrompt,
        aspectRatio: element.aspectRatio,
        backgroundMode: element.backgroundMode,
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

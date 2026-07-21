import type { PresentationBlueprint } from '../presentation-contracts'
import { blueprintImageRequirements, latestCompletedAssetStep } from './blueprint-assets'
import type { AgentRepository, ArtifactPort, RunRecord, StepRecord } from './ports'

export type PresentationArtifactReference = Readonly<{
  pageNumber: number
  artifactId: string
  assets?: readonly Readonly<{ elementId: string; artifactId: string }>[]
}>

export async function requirePresentationArtifactReferences(
  repository: AgentRepository,
  run: RunRecord,
  blueprint: PresentationBlueprint,
): Promise<readonly PresentationArtifactReference[]> {
  const steps = (await repository.listSteps(run.id))
    .filter((step) => step.tool === 'generate_slide_image' && step.status === 'COMPLETED')
  if (blueprint.renderMode === 'LAYERED_COURSEWARE_V3') {
    const requirements = blueprintImageRequirements(run, blueprint)
    const artifactByAssetKey = new Map(requirements.map((requirement) => {
      const step = latestCompletedAssetStep(steps, requirement, run.revisionRound)
      const output = step ? imageOutput(step) : null
      if (!output) throw new Error('LAYER_ARTIFACT_NOT_FOUND')
      return [requirement.assetKey, output.artifactId]
    }))
    return blueprint.slides.map((slide) => {
      if (!slide.layeredDesign) throw new Error('LAYERED_DESIGN_MISSING')
      const assets = slide.layeredDesign.elements
        .filter((element): element is Extract<(typeof slide.layeredDesign.elements)[number], { kind: 'IMAGE' }> => element.kind === 'IMAGE')
        .map((element) => {
          const assetKey = element.reuseKey ? `reuse:${element.reuseKey}` : `slide:${slide.pageNumber}:element:${element.elementId}`
          const artifactId = artifactByAssetKey.get(assetKey)
          if (!artifactId) throw new Error('LAYER_ARTIFACT_NOT_FOUND')
          return { elementId: element.elementId, artifactId }
        })
      const baseElementId = slide.layeredDesign.elements
        .find((element) => element.kind === 'IMAGE' && element.role === 'BASE_LAYER')?.elementId
      const base = assets.find((asset) => asset.elementId === baseElementId)
      if (!base) throw new Error('BASE_LAYER_ARTIFACT_NOT_FOUND')
      return { pageNumber: slide.pageNumber, artifactId: base.artifactId, assets }
    })
  }
  return blueprint.slides.map((slide) => {
    const slideId = `${run.id}:slide:${slide.pageNumber}`
    const candidates = steps.map(imageOutput)
      .filter((output): output is NonNullable<typeof output> => output?.slideId === slideId)
      .filter((output) => output.round <= run.revisionRound)
      .sort((left, right) => right.round - left.round)
    if (!candidates[0]) throw new Error('PAGE_ARTIFACT_NOT_FOUND')
    return { pageNumber: slide.pageNumber, artifactId: candidates[0].artifactId }
  })
}

export async function loadPresentationSlides(
  artifacts: ArtifactPort,
  run: RunRecord,
  references: readonly PresentationArtifactReference[],
) {
  const slides = []
  for (const reference of references) {
    const source = await artifacts.get({ tenantId: run.host.tenantId, artifactId: reference.artifactId })
    if (!source || !source.mimeType.startsWith('image/') || source.bytes.length === 0) {
      throw new Error('PRESENTATION_SOURCE_ARTIFACT_NOT_FOUND')
    }
    const assets = []
    for (const assetReference of reference.assets ?? []) {
      const asset = await artifacts.get({ tenantId: run.host.tenantId, artifactId: assetReference.artifactId })
      if (!asset || !asset.mimeType.startsWith('image/') || asset.bytes.length === 0) {
        throw new Error('PRESENTATION_LAYER_ARTIFACT_NOT_FOUND')
      }
      assets.push({ elementId: assetReference.elementId, image: asset.bytes, imageMimeType: asset.mimeType })
    }
    slides.push({
      pageNumber: reference.pageNumber,
      image: source.bytes,
      imageMimeType: source.mimeType,
      ...(assets.length > 0 ? { assets } : {}),
    })
  }
  return slides
}

function imageOutput(step: StepRecord) {
  const output = step.output as { slideId?: unknown; versionId?: unknown; artifactId?: unknown } | null
  if (!output || typeof output.slideId !== 'string' || typeof output.versionId !== 'string' || typeof output.artifactId !== 'string') return null
  const round = /:r(\d+):/.exec(output.versionId)?.[1]
  return round === undefined ? null : { slideId: output.slideId, artifactId: output.artifactId, round: Number(round) }
}

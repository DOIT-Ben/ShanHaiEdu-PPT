import type { PresentationMode } from '../contracts'

export type PresentationModeStrategy = Readonly<{
  mode: PresentationMode
  planningKind: 'BLUEPRINT' | 'BLUEPRINT_WITH_REFLECTION' | 'VISUAL_DECK_COMPILER'
  assetModel: 'SLIDE_BACKGROUND' | 'LAYERED_ELEMENTS' | 'COMPLETE_SLIDE_RASTER'
  deliveryModel: 'EDITABLE_TEXT_OVER_RASTER' | 'EDITABLE_LAYERED_PPTX' | 'RASTER_SLIDES_IN_PPTX'
  executionAvailability: 'AVAILABLE' | 'NOT_IMPLEMENTED'
}>

const PRESENTATION_MODE_STRATEGIES = {
  SLIDE_IMAGE_V2: {
    mode: 'SLIDE_IMAGE_V2',
    planningKind: 'BLUEPRINT',
    assetModel: 'SLIDE_BACKGROUND',
    deliveryModel: 'EDITABLE_TEXT_OVER_RASTER',
    executionAvailability: 'AVAILABLE',
  },
  SLIDE_IMAGE_V2_1: {
    mode: 'SLIDE_IMAGE_V2_1',
    planningKind: 'BLUEPRINT_WITH_REFLECTION',
    assetModel: 'SLIDE_BACKGROUND',
    deliveryModel: 'EDITABLE_TEXT_OVER_RASTER',
    executionAvailability: 'AVAILABLE',
  },
  LAYERED_COURSEWARE_V3: {
    mode: 'LAYERED_COURSEWARE_V3',
    planningKind: 'BLUEPRINT',
    assetModel: 'LAYERED_ELEMENTS',
    deliveryModel: 'EDITABLE_LAYERED_PPTX',
    executionAvailability: 'AVAILABLE',
  },
  VISUAL_DECK_V4: {
    mode: 'VISUAL_DECK_V4',
    planningKind: 'VISUAL_DECK_COMPILER',
    assetModel: 'COMPLETE_SLIDE_RASTER',
    deliveryModel: 'RASTER_SLIDES_IN_PPTX',
    executionAvailability: 'NOT_IMPLEMENTED',
  },
} as const satisfies Readonly<Record<PresentationMode, PresentationModeStrategy>>

export function getPresentationModeStrategy(mode: PresentationMode): PresentationModeStrategy {
  return PRESENTATION_MODE_STRATEGIES[mode]
}

export function listPresentationModeStrategies(): readonly PresentationModeStrategy[] {
  return Object.values(PRESENTATION_MODE_STRATEGIES)
}

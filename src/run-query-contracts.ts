import { z } from 'zod'
import { CONTRACT_VERSION, type PresentationMode } from './contracts'
import type { PresentationBlueprint } from './presentation-contracts'
import { visualDeckV4GenerationPlanSchema } from './visual-deck-v4-generation-plan'

const identifierSchema = z.string().trim().min(1).max(160)
const modelNameSchema = z.string().trim().min(1).max(120)
const sourceChunkIdsSchema = z.array(identifierSchema).max(200)
const sourceAssetIdsSchema = z.array(identifierSchema).max(200)

const publicCurriculumProjectionSchema = z.object({
  subject: z.string().trim().min(1).max(100).nullable(),
  grade: z.string().trim().min(1).max(100).nullable(),
  lessonTitle: z.string().trim().min(1).max(200),
  learningObjectives: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
  scopeBoundaries: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  prohibitedExtensions: z.array(z.string().trim().min(1).max(300)).max(20),
  sourceChunkIds: sourceChunkIdsSchema,
  sourceAssetIds: sourceAssetIdsSchema,
}).strict()

const publicBlueprintSlideProjectionSchema = z.object({
  pageNumber: z.number().int().min(1).max(50),
  title: z.string().trim().min(1).max(120),
  body: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  layout: z.enum(['HERO', 'SPLIT', 'EDITORIAL', 'STATEMENT', 'IMAGE_FULL']),
  visualIntent: z.string().trim().min(10).max(1_000),
  sourceChunkIds: sourceChunkIdsSchema,
  sourceAssetIds: sourceAssetIdsSchema,
}).strict()

/**
 * This is the only Blueprint shape exposed from the V1 API. Provider prompts,
 * negative prompts, OCR text, and renderer-specific element instructions stay
 * inside the worker boundary.
 */
export const publicBlueprintProjectionSchema = z.object({
  id: identifierSchema,
  title: z.string().trim().min(1).max(160),
  renderMode: z.enum(['SLIDE_IMAGE_V2', 'SLIDE_IMAGE_V2_1', 'LAYERED_COURSEWARE_V3', 'VISUAL_DECK_V4']),
  visualDirection: z.string().trim().min(3).max(1_000),
  coverDesignMode: z.enum(['INDEPENDENT', 'FOLLOW_TEMPLATE']).optional(),
  curriculum: publicCurriculumProjectionSchema,
  slides: z.array(publicBlueprintSlideProjectionSchema).min(1).max(50),
  createdAt: z.string().datetime(),
}).strict()

export type PublicBlueprintProjection = z.output<typeof publicBlueprintProjectionSchema>

export function publicBlueprintProjection(
  blueprint: PresentationBlueprint,
  renderMode: PresentationMode,
): PublicBlueprintProjection {
  return publicBlueprintProjectionSchema.parse({
    id: blueprint.id,
    title: blueprint.title,
    renderMode,
    visualDirection: blueprint.visualDirection,
    ...(blueprint.coverDesignMode ? { coverDesignMode: blueprint.coverDesignMode } : {}),
    curriculum: {
      subject: blueprint.curriculum.subject,
      grade: blueprint.curriculum.grade,
      lessonTitle: blueprint.curriculum.lessonTitle,
      learningObjectives: blueprint.curriculum.learningObjectives,
      scopeBoundaries: blueprint.curriculum.scopeBoundaries,
      prohibitedExtensions: blueprint.curriculum.prohibitedExtensions,
      sourceChunkIds: blueprint.curriculum.sourceChunkIds,
      sourceAssetIds: blueprint.curriculum.sourceAssetIds,
    },
    slides: blueprint.slides.map((slide) => ({
      pageNumber: slide.pageNumber,
      title: slide.title,
      body: slide.body,
      layout: slide.layout,
      visualIntent: slide.visualIntent,
      sourceChunkIds: slide.sourceChunkIds,
      sourceAssetIds: slide.sourceAssetIds,
    })),
    createdAt: blueprint.createdAt,
  })
}

const publicSourceRecordSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(300),
  kind: z.enum(['TEXT', 'IMAGE', 'PDF', 'MARKDOWN']),
  mimeType: z.string().trim().min(1).max(160).optional(),
  pageCount: z.number().int().positive().max(50).optional(),
  status: z.enum(['READY', 'FAILED']),
  failureCode: z.string().trim().min(1).max(160).optional(),
}).strict()

const publicSourceAssetSchema = z.object({
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
}).strict()

const publicSourcePageReferenceSchema = z.object({
  pageNumber: z.number().int().min(1).max(50),
  sourceChunkIds: sourceChunkIdsSchema,
  sourceAssetIds: sourceAssetIdsSchema,
}).strict()

export const runSourcesProjectionSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('NOT_READY'),
    reason: z.literal('BLUEPRINT_NOT_READY'),
  }).strict(),
  z.object({
    state: z.literal('AVAILABLE'),
    sources: z.array(publicSourceRecordSchema).max(7),
    assets: z.array(publicSourceAssetSchema).max(200),
    pageReferences: z.array(publicSourcePageReferenceSchema).min(1).max(50),
  }).strict(),
])

export type RunSourcesProjection = z.output<typeof runSourcesProjectionSchema>

export function publicRunSources(blueprint: PresentationBlueprint | null): RunSourcesProjection {
  if (!blueprint) return runSourcesProjectionSchema.parse({ state: 'NOT_READY', reason: 'BLUEPRINT_NOT_READY' })
  return runSourcesProjectionSchema.parse({
    state: 'AVAILABLE',
    sources: blueprint.sourceManifest,
    assets: blueprint.sourceAssets.map((asset) => ({
      id: asset.id,
      sourceId: asset.sourceId,
      name: asset.name,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      ...(asset.pageNumber === undefined ? {} : { pageNumber: asset.pageNumber }),
      ...(asset.region ? { region: asset.region } : {}),
    })),
    pageReferences: blueprint.slides.map((slide) => ({
      pageNumber: slide.pageNumber,
      sourceChunkIds: slide.sourceChunkIds,
      sourceAssetIds: slide.sourceAssetIds,
    })),
  })
}

export const runPlanProjectionSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('NOT_READY'),
    reason: z.enum(['V4_REQUIRED', 'V4_PLAN_NOT_READY']),
  }).strict(),
  z.object({
    state: z.literal('AVAILABLE'),
    plan: visualDeckV4GenerationPlanSchema,
  }).strict(),
])

export type RunPlanProjection = z.output<typeof runPlanProjectionSchema>

export const runPlanEnvelopeSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  requestId: identifierSchema,
  data: runPlanProjectionSchema,
}).strict()

export const runSourcesEnvelopeSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  requestId: identifierSchema,
  data: runSourcesProjectionSchema,
}).strict()

const uniqueModelListSchema = z.array(modelNameSchema).max(20)
  .refine((models) => new Set(models).size === models.length, 'models must be unique')
const optionalUniqueModelListSchema = z.array(modelNameSchema).max(20)
  .refine((models) => new Set(models).size === models.length, 'models must be unique')
const publicModelAvailabilityEntrySchema = z.object({
  model: modelNameSchema,
  state: z.enum(['UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE']),
  checkedAt: z.string().datetime().nullable(),
}).strict()
const publicModelAvailabilityListSchema = z.array(publicModelAvailabilityEntrySchema).max(20)
  .refine((entries) => new Set(entries.map((entry) => entry.model)).size === entries.length, 'models must be unique')
const publicModelAvailabilitySchema = z.object({
  text: publicModelAvailabilityListSchema,
  vision: publicModelAvailabilityListSchema,
  image: publicModelAvailabilityListSchema,
  imageEdit: publicModelAvailabilityListSchema,
}).strict()

export type PublicModelAvailability = z.output<typeof publicModelAvailabilitySchema>

export const publicCapabilitiesSchema = z.object({
  runtimeMode: z.enum(['GATEWAY', 'MOCK']),
  visualDeckV4: z.object({
    sourceModes: z.array(z.enum(['SOURCE_GROUNDED', 'OPEN_KNOWLEDGE'])).min(1).max(2),
    sourceKinds: z.array(z.enum(['TEXT', 'HOST_ATTACHMENT', 'SOURCE_PACKAGE', 'APPROVED_PAGE_DESIGN'])).min(1).max(4),
    slideCount: z.object({ minimum: z.literal(1), maximum: z.literal(50) }).strict(),
    aspectRatios: z.array(z.literal('16:9')).length(1),
    models: z.object({
      text: uniqueModelListSchema,
      vision: uniqueModelListSchema,
      image: uniqueModelListSchema,
      imageEdit: optionalUniqueModelListSchema,
    }).strict(),
    modelAvailability: publicModelAvailabilitySchema.optional(),
    imageGeneration: z.object({
      asynchronous: z.boolean(),
      protocol: z.enum(['IMAGE_TASK', 'LOCAL_MOCK']),
      validatesActualPixels: z.literal(true),
    }).strict(),
    delivery: z.object({
      formats: z.array(z.enum(['PPTX', 'PREVIEW_PNG', 'SOURCES_JSON'])).length(3),
      rasterSlides: z.literal(true),
    }).strict(),
  }).strict(),
  quickDeckEvaluation: z.object({
    available: z.boolean(),
    slideCount: z.object({ minimum: z.literal(1), maximum: z.literal(10) }).strict(),
    isolatedFromRuns: z.literal(true),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!value.visualDeckV4.modelAvailability) return
  const availability = value.visualDeckV4.modelAvailability
  const models = value.visualDeckV4.models
  for (const role of ['text', 'vision', 'image', 'imageEdit'] as const) {
    const listed = models[role]
    const observed = availability[role].map((entry) => entry.model)
    if (listed.length !== observed.length || listed.some((model, index) => model !== observed[index])) {
      context.addIssue({ code: 'custom', path: ['visualDeckV4', 'modelAvailability', role], message: 'availability must match public model order' })
    }
  }
})

export type PublicCapabilities = z.output<typeof publicCapabilitiesSchema>

export function createPublicCapabilities(input: Readonly<{
  runtimeMode?: 'GATEWAY' | 'MOCK'
  textModels?: readonly string[]
  visionModels?: readonly string[]
  imageModels?: readonly string[]
  imageEditModels?: readonly string[]
  modelAvailability?: PublicModelAvailability
  quickDeckAvailable?: boolean
}> = {}): PublicCapabilities {
  const runtimeMode = input.runtimeMode ?? 'MOCK'
  const textModels = input.textModels ?? ['local-mock-text']
  const visionModels = input.visionModels ?? ['local-mock-vision']
  const imageModels = input.imageModels ?? ['local-mock-image']
  const imageEditModels = input.imageEditModels ?? []
  const defaultAvailabilityState = runtimeMode === 'MOCK' ? 'HEALTHY' as const : 'UNKNOWN' as const
  const modelAvailability = input.modelAvailability ?? {
    text: textModels.map((model) => ({ model, state: defaultAvailabilityState, checkedAt: null })),
    vision: visionModels.map((model) => ({ model, state: defaultAvailabilityState, checkedAt: null })),
    image: imageModels.map((model) => ({ model, state: defaultAvailabilityState, checkedAt: null })),
    imageEdit: imageEditModels.map((model) => ({ model, state: defaultAvailabilityState, checkedAt: null })),
  }
  return publicCapabilitiesSchema.parse({
    runtimeMode,
    visualDeckV4: {
      sourceModes: ['SOURCE_GROUNDED', 'OPEN_KNOWLEDGE'],
      sourceKinds: ['TEXT', 'HOST_ATTACHMENT', 'SOURCE_PACKAGE', 'APPROVED_PAGE_DESIGN'],
      slideCount: { minimum: 1, maximum: 50 },
      aspectRatios: ['16:9'],
      models: {
        text: textModels,
        vision: visionModels,
        image: imageModels,
        imageEdit: imageEditModels,
      },
      modelAvailability,
      imageGeneration: runtimeMode === 'GATEWAY'
        ? { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true }
        : { asynchronous: false, protocol: 'LOCAL_MOCK', validatesActualPixels: true },
      delivery: { formats: ['PPTX', 'PREVIEW_PNG', 'SOURCES_JSON'], rasterSlides: true },
    },
    quickDeckEvaluation: {
      available: input.quickDeckAvailable ?? false,
      slideCount: { minimum: 1, maximum: 10 },
      isolatedFromRuns: true,
    },
  })
}

export const DEFAULT_PUBLIC_CAPABILITIES: PublicCapabilities = createPublicCapabilities()

export const capabilitiesEnvelopeSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  requestId: identifierSchema,
  data: publicCapabilitiesSchema,
}).strict()

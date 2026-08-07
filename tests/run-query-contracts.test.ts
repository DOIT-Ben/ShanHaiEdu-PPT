import { describe, expect, test } from 'bun:test'
import { presentationBlueprintSchema } from '../src/presentation-contracts'
import {
  DEFAULT_PUBLIC_CAPABILITIES,
  createPublicCapabilities,
  publicBlueprintProjection,
  publicRunSources,
} from '../src/run-query-contracts'

function blueprint() {
  return presentationBlueprintSchema.parse({
    id: 'blueprint-query-1',
    title: '光合作用',
    renderMode: 'SLIDE_IMAGE_V2',
    visualDirection: '清晰的课堂科学信息图风格',
    createdAt: '2026-08-07T00:00:00.000Z',
    sourceManifest: [{
      id: 'source-1', name: '教材.md', kind: 'MARKDOWN', mimeType: 'text/markdown', pageCount: 2, status: 'READY',
    }],
    sourceAssets: [{
      id: 'asset-1', sourceId: 'source-1', name: '叶片.png', mimeType: 'image/png', byteLength: 1024,
      sha256: 'a'.repeat(64), width: 1280, height: 720, ocrText: 'internal OCR source text',
    }],
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: 'private source material must not be copied to public run queries.',
      learningObjectives: ['理解光合作用的条件与产物'],
      scopeBoundaries: ['只覆盖教材的基础过程'], prohibitedExtensions: [],
      sourceChunkIds: ['chunk-1'], sourceAssetIds: ['asset-1'],
    },
    slides: [{
      pageNumber: 1, title: '认识光合作用', body: ['绿色植物利用光能制造有机物。'], layout: 'HERO',
      visualIntent: '以叶片和阳光建立课堂主题视觉',
      visualPrompt: 'INTERNAL PROMPT: A classroom science illustration with no text or symbols.',
      sourceChunkIds: ['chunk-1'], sourceAssetIds: ['asset-1'],
    }],
  })
}

describe('public run query contracts', () => {
  test('projects only user-facing blueprint fields and never internal prompts or source text', () => {
    const projected = publicBlueprintProjection(blueprint(), 'SLIDE_IMAGE_V2')
    const serialized = JSON.stringify(projected)

    expect(projected).toMatchObject({
      id: 'blueprint-query-1',
      renderMode: 'SLIDE_IMAGE_V2',
      slides: [{ pageNumber: 1, title: '认识光合作用', visualIntent: '以叶片和阳光建立课堂主题视觉' }],
    })
    expect(serialized).not.toContain('visualPrompt')
    expect(serialized).not.toContain('INTERNAL PROMPT')
    expect(serialized).not.toContain('sourceSummary')
    expect(serialized).not.toContain('private source material')
  })

  test('returns source metadata and page references without OCR or raw source content', () => {
    const sources = publicRunSources(blueprint())
    const serialized = JSON.stringify(sources)

    expect(sources).toMatchObject({
      state: 'AVAILABLE',
      sources: [{ id: 'source-1', name: '教材.md', kind: 'MARKDOWN' }],
      assets: [{ id: 'asset-1', width: 1280, height: 720 }],
      pageReferences: [{ pageNumber: 1, sourceChunkIds: ['chunk-1'], sourceAssetIds: ['asset-1'] }],
    })
    expect(serialized).not.toContain('ocrText')
    expect(serialized).not.toContain('internal OCR source text')
  })

  test('advertises truthful local mock capabilities without provider configuration', () => {
    const serialized = JSON.stringify(DEFAULT_PUBLIC_CAPABILITIES)

    expect(DEFAULT_PUBLIC_CAPABILITIES).toMatchObject({
      runtimeMode: 'MOCK',
      visualDeckV4: {
        slideCount: { minimum: 1, maximum: 50 },
        aspectRatios: ['16:9'],
        models: { text: ['local-mock-text'], vision: ['local-mock-vision'], image: ['local-mock-image'], imageEdit: [] },
        modelAvailability: {
          text: [{ model: 'local-mock-text', state: 'HEALTHY', checkedAt: null }],
          vision: [{ model: 'local-mock-vision', state: 'HEALTHY', checkedAt: null }],
          image: [{ model: 'local-mock-image', state: 'HEALTHY', checkedAt: null }],
          imageEdit: [],
        },
        imageGeneration: { asynchronous: false, protocol: 'LOCAL_MOCK', validatesActualPixels: true },
        delivery: { formats: ['PPTX', 'PREVIEW_PNG', 'SOURCES_JSON'], rasterSlides: true },
      },
      quickDeckEvaluation: { available: false, slideCount: { minimum: 1, maximum: 10 }, isolatedFromRuns: true },
    })
    expect(serialized).not.toContain('baseUrl')
    expect(serialized).not.toContain('apiKey')
    expect(createPublicCapabilities({ imageEditModels: [] }).visualDeckV4.models.imageEdit).toEqual([])
  })

  test('rejects a model availability list that is unique but not aligned with its published-model order', () => {
    expect(() => createPublicCapabilities({
      textModels: ['text-a', 'text-b'],
      visionModels: [],
      imageModels: [],
      imageEditModels: [],
      modelAvailability: {
        text: [
          { model: 'text-b', state: 'HEALTHY', checkedAt: null },
          { model: 'text-a', state: 'HEALTHY', checkedAt: null },
        ],
        vision: [],
        image: [],
        imageEdit: [],
      },
    })).toThrow('availability must match public model order')
  })
})

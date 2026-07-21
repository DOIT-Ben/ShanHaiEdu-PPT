import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { SharpPptxPresentationRenderer } from '../src/adapters/presentation-renderer'
import { presentationBlueprintSchema } from '../src/presentation-contracts'

function blueprint() {
  return {
    id: 'blueprint-render-1',
    title: '光合作用',
    visualDirection: '清晰的课堂科学信息图风格',
    createdAt: '2026-07-21T00:00:00.000Z',
    sourceManifest: [],
    sourceAssets: [],
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: pageNumber === 1 ? '认识光合作用' : '条件与产物',
      body: pageNumber === 1 ? ['绿色植物利用光能制造有机物'] : ['需要光和叶绿体', '释放氧气'],
      layout: pageNumber === 1 ? 'HERO' as const : 'SPLIT' as const,
      visualIntent: `第 ${pageNumber} 页对应的教材视觉目标`,
      visualPrompt: `A clean science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
    })),
  }
}

async function input() {
  const colors = ['#75b798', '#8ecae6']
  const slides = await Promise.all(colors.map(async (background, index) => ({
    pageNumber: index + 1,
    image: new Uint8Array(await sharp({
      create: { width: 1280, height: 720, channels: 3, background },
    }).png().toBuffer()),
    imageMimeType: 'image/png',
  })))
  return { blueprint: blueprint(), slides }
}

describe('Sharp and PptxGenJS presentation renderer', () => {
  test('renders a non-empty deck contact sheet with stable dimensions', async () => {
    const renderer = new SharpPptxPresentationRenderer()
    const preview = await renderer.renderPreview(await input())
    const metadata = await sharp(preview).metadata()
    const stats = await sharp(preview).stats()

    expect(metadata).toMatchObject({ format: 'png', width: 1032, height: 318 })
    expect(preview.length).toBeGreaterThan(5_000)
    expect(stats.channels.some((channel) => channel.stdev > 5)).toBe(true)
  })

  test('renders ordered full-size slide previews for visual review', async () => {
    const renderer = new SharpPptxPresentationRenderer()
    const previews = await renderer.renderSlidePreviews(await input())

    expect(previews.map((preview) => preview.pageNumber)).toEqual([1, 2])
    for (const preview of previews) {
      expect(await sharp(preview.image).metadata()).toMatchObject({ format: 'png', width: 1600, height: 900 })
    }
  })

  test('renders a valid Open XML package with editable slide text', async () => {
    const renderer = new SharpPptxPresentationRenderer()
    const pptx = await renderer.renderPptx(await input())

    expect(new TextDecoder().decode(pptx.slice(0, 2))).toBe('PK')
    expect(pptx.length).toBeGreaterThan(20_000)
  })

  test('exports v3 base art, knowledge art, text and shapes as independent pptx objects', async () => {
    const baseBlueprint = blueprint()
    const layeredBlueprint = presentationBlueprintSchema.parse({
      ...baseBlueprint,
      renderMode: 'LAYERED_COURSEWARE_V3',
      coverDesignMode: 'INDEPENDENT',
      slides: baseBlueprint.slides.map((slide, index) => ({
        ...slide,
        layeredDesign: {
          designKind: index === 0 ? 'COVER' : 'CONTENT',
          backgroundColor: '#F7FBFA',
          elements: [
            {
              kind: 'IMAGE', elementId: `base-${index + 1}`, role: 'BASE_LAYER',
              knowledgePoint: '建立本页教材知识情境',
              prompt: 'A wide text-free educational classroom background directly supporting this lesson page',
              negativePrompt: 'text, logo, watermark', sourceChunkIds: ['chunk-1'],
              placement: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 0,
              fit: 'COVER', aspectRatio: '16:9', backgroundMode: 'OPAQUE',
            },
            {
              kind: 'IMAGE', elementId: `knowledge-${index + 1}`, role: 'KNOWLEDGE_VISUAL',
              knowledgePoint: '用叶片说明光合作用发生位置',
              prompt: 'A transparent text-free green leaf cutout directly illustrating photosynthesis for children',
              negativePrompt: 'text, logo, watermark', sourceChunkIds: ['chunk-1'],
              placement: { x: 0.62, y: 0.22, width: 0.30, height: 0.48 }, zIndex: 10,
              fit: 'CONTAIN', aspectRatio: '1:1', backgroundMode: 'TRANSPARENT', reuseKey: 'leaf-cutout',
            },
            {
              kind: 'SHAPE', elementId: `panel-${index + 1}`, role: 'CONTENT_PANEL', shape: 'ROUNDED_RECTANGLE',
              placement: { x: 0.05, y: 0.10, width: 0.48, height: 0.78 }, zIndex: 15,
              fillColor: '#FFFFFF', transparency: 8,
            },
            {
              kind: 'TEXT', elementId: `title-${index + 1}`, role: 'TITLE', text: slide.title,
              sourceChunkIds: ['chunk-1'], placement: { x: 0.09, y: 0.20, width: 0.39, height: 0.18 }, zIndex: 20,
              style: { fontSize: 30, bold: true, color: '#17202A', align: 'LEFT' },
            },
            {
              kind: 'TEXT', elementId: `body-${index + 1}`, role: 'BODY', text: slide.body.join('\n'),
              sourceChunkIds: ['chunk-1'], placement: { x: 0.09, y: 0.44, width: 0.39, height: 0.28 }, zIndex: 20,
              style: { fontSize: 18, bold: false, color: '#29343D', align: 'LEFT' },
            },
          ].filter((element) => index > 0 || element.kind === 'IMAGE' || element.role === 'TITLE'),
        },
      })),
    })
    const slides = await Promise.all(layeredBlueprint.slides.map(async (slide) => {
      const base = new Uint8Array(await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#CDEBE1' } }).png().toBuffer())
      const knowledge = new Uint8Array(await sharp({ create: { width: 420, height: 420, channels: 4, background: { r: 63, g: 155, b: 92, alpha: 0.85 } } }).png().toBuffer())
      return {
        pageNumber: slide.pageNumber,
        image: base,
        imageMimeType: 'image/png',
        assets: [
          { elementId: `base-${slide.pageNumber}`, image: base, imageMimeType: 'image/png' },
          { elementId: `knowledge-${slide.pageNumber}`, image: knowledge, imageMimeType: 'image/png' },
        ],
      }
    }))
    const renderer = new SharpPptxPresentationRenderer()
    const preview = await renderer.renderPreview({ blueprint: layeredBlueprint, slides })
    const pptx = await renderer.renderPptx({ blueprint: layeredBlueprint, slides })
    expect(await sharp(preview).metadata()).toMatchObject({ format: 'png', width: 1032, height: 318 })

    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-v3-'))
    try {
      const path = join(directory, 'layered.pptx')
      await writeFile(path, pptx)
      const process = Bun.spawn(['unzip', '-p', path, 'ppt/slides/slide2.xml'], { stdout: 'pipe', stderr: 'pipe' })
      const xml = await new Response(process.stdout).text()
      expect(await process.exited).toBe(0)
      expect(xml.match(/<p:pic>/g)).toHaveLength(2)
      expect(xml).toContain('base-2')
      expect(xml).toContain('knowledge-2')
      expect(xml).toContain('title-2')
      expect(xml).toContain('body-2')
      expect(xml).not.toContain('<p:bgPr><a:blipFill>')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

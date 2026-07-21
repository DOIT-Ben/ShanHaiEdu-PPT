import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { SharpPptxPresentationRenderer } from '../src/adapters/presentation-renderer'

function blueprint() {
  return {
    id: 'blueprint-render-1',
    title: '光合作用',
    visualDirection: '清晰的课堂科学信息图风格',
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: pageNumber === 1 ? '认识光合作用' : '条件与产物',
      body: pageNumber === 1 ? ['绿色植物利用光能制造有机物'] : ['需要光和叶绿体', '释放氧气'],
      layout: pageNumber === 1 ? 'HERO' as const : 'SPLIT' as const,
      visualIntent: `第 ${pageNumber} 页对应的教材视觉目标`,
      visualPrompt: `A clean science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: ['chunk-1'],
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

  test('renders a valid Open XML package with editable slide text', async () => {
    const renderer = new SharpPptxPresentationRenderer()
    const pptx = await renderer.renderPptx(await input())

    expect(new TextDecoder().decode(pptx.slice(0, 2))).toBe('PK')
    expect(pptx.length).toBeGreaterThan(20_000)
  })
})

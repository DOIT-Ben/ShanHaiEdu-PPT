import PptxGenJS from 'pptxgenjs'
import sharp from 'sharp'
import type { PresentationRendererPort } from '../core/ports'

const SLIDE_WIDTH = 1600
const SLIDE_HEIGHT = 900
const PPTX_WIDTH = 13.333
const PPTX_HEIGHT = 7.5
const FONT_FACE = 'Microsoft YaHei'

type RenderInput = Parameters<PresentationRendererPort['renderPreview']>[0]

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[character]!)
}

function wrapText(value: string, maxCharacters: number) {
  const characters = [...value]
  const lines: string[] = []
  while (characters.length > 0) lines.push(characters.splice(0, maxCharacters).join(''))
  return lines.length > 0 ? lines : ['']
}

function layout(slideLayout: string) {
  if (slideLayout === 'SPLIT') return { x: 78, width: 680, panelWidth: 790 }
  if (slideLayout === 'EDITORIAL') return { x: 820, width: 700, panelWidth: 800 }
  return { x: 88, width: 920, panelWidth: 1040 }
}

function typographySvg(input: Readonly<{
  deckTitle: string
  title: string
  body: readonly string[]
  pageNumber: number
  slideLayout: string
}>) {
  const placement = layout(input.slideLayout)
  const titleLines = wrapText(input.title, placement.width > 800 ? 18 : 14).slice(0, 2)
  const bodyLines = input.body.flatMap((item) => wrapText(item, placement.width > 800 ? 30 : 22)).slice(0, 7)
  const titleSvg = titleLines.map((line, index) =>
    `<text x="${placement.x}" y="${216 + index * 74}" font-size="58" font-weight="700" fill="#17202a">${escapeXml(line)}</text>`
  ).join('')
  const bodySvg = bodyLines.map((line, index) =>
    `<text x="${placement.x + 18}" y="${390 + index * 58}" font-size="30" font-weight="400" fill="#29343d">${escapeXml(`• ${line}`)}</text>`
  ).join('')
  return Buffer.from(`<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${placement.panelWidth}" height="${SLIDE_HEIGHT}" fill="#ffffff" fill-opacity="0.90"/>
    <text x="${placement.x}" y="92" font-size="24" font-weight="600" fill="#49616f">${escapeXml(input.deckTitle)}</text>
    ${titleSvg}
    ${bodySvg}
    <text x="1508" y="842" text-anchor="end" font-size="24" font-weight="600" fill="#344955">${String(input.pageNumber).padStart(2, '0')}</text>
  </svg>`)
}

async function normalizedPng(image: Uint8Array) {
  return sharp(image)
    .rotate()
    .resize(SLIDE_WIDTH, SLIDE_HEIGHT, { fit: 'cover', position: 'centre' })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 8 })
    .toBuffer()
}

async function renderSlide(input: Readonly<{
  image: Uint8Array
  deckTitle: string
  title: string
  body: readonly string[]
  pageNumber: number
  slideLayout: string
}>) {
  const background = await normalizedPng(input.image)
  return sharp(background)
    .composite([{ input: typographySvg(input), top: 0, left: 0 }])
    .png({ compressionLevel: 8 })
    .toBuffer()
}

function slideByPage(input: RenderInput) {
  const slideMap = new Map(input.slides.map((slide) => [slide.pageNumber, slide]))
  return input.blueprint.slides.map((slide) => {
    const source = slideMap.get(slide.pageNumber)
    if (!source) throw new Error(`RENDER_SOURCE_MISSING:${slide.pageNumber}`)
    return { blueprint: slide, source }
  })
}

export class SharpPptxPresentationRenderer implements PresentationRendererPort {
  async renderPreview(input: RenderInput) {
    const rendered = await Promise.all(slideByPage(input).map(({ blueprint, source }) => renderSlide({
      image: source.image,
      deckTitle: input.blueprint.title,
      title: blueprint.title,
      body: blueprint.body,
      pageNumber: blueprint.pageNumber,
      slideLayout: blueprint.layout,
    })))
    const columns = Math.min(3, rendered.length)
    const rows = Math.ceil(rendered.length / columns)
    const thumbnailWidth = 480
    const thumbnailHeight = 270
    const gap = 24
    const width = columns * thumbnailWidth + (columns + 1) * gap
    const height = rows * thumbnailHeight + (rows + 1) * gap
    const composites = await Promise.all(rendered.map(async (image, index) => ({
      input: await sharp(image).resize(thumbnailWidth, thumbnailHeight).png().toBuffer(),
      left: gap + (index % columns) * (thumbnailWidth + gap),
      top: gap + Math.floor(index / columns) * (thumbnailHeight + gap),
    })))
    return sharp({ create: { width, height, channels: 3, background: '#e8edf0' } })
      .composite(composites)
      .png({ compressionLevel: 8 })
      .toBuffer()
  }

  async renderPptx(input: Parameters<PresentationRendererPort['renderPptx']>[0]) {
    const pptx = new PptxGenJS()
    pptx.layout = 'LAYOUT_WIDE'
    pptx.author = 'PPT Agent'
    pptx.company = 'PPT Agent'
    pptx.subject = '可编辑教学课件'
    pptx.title = input.blueprint.title
    pptx.theme = { headFontFace: FONT_FACE, bodyFontFace: FONT_FACE }

    for (const { blueprint, source } of slideByPage(input)) {
      const image = await normalizedPng(source.image)
      const placement = layout(blueprint.layout)
      const x = placement.x / 120
      const panelWidth = placement.panelWidth / 120
      const slide = pptx.addSlide()
      slide.addImage({
        data: `data:image/png;base64,${image.toString('base64')}`,
        x: 0,
        y: 0,
        w: PPTX_WIDTH,
        h: PPTX_HEIGHT,
        altText: `${blueprint.title}的原始无文字主视觉`,
      })
      slide.addShape(pptx.ShapeType.rect, {
        x: 0, y: 0, w: panelWidth, h: PPTX_HEIGHT,
        fill: { color: 'FFFFFF', transparency: 10 },
        line: { color: 'FFFFFF', transparency: 100 },
      })
      slide.addText(input.blueprint.title, {
        x, y: 0.42, w: Math.max(2, panelWidth - x - 0.3), h: 0.36,
        fontFace: FONT_FACE, fontSize: 14, bold: true, color: '49616F', margin: 0,
      })
      slide.addText(blueprint.title, {
        x, y: 1.32, w: Math.max(2, panelWidth - x - 0.3), h: 1.05,
        fontFace: FONT_FACE, fontSize: 28, bold: true, color: '17202A', margin: 0,
        breakLine: false, fit: 'shrink', valign: 'middle',
      })
      slide.addText(blueprint.body.map((item) => `• ${item}`).join('\n'), {
        x: x + 0.12, y: 3.05, w: Math.max(2, panelWidth - x - 0.5), h: 2.95,
        fontFace: FONT_FACE, fontSize: 17, color: '29343D', margin: 0,
        breakLine: false, fit: 'shrink', valign: 'top', paraSpaceAfter: 8,
      })
      slide.addText(String(blueprint.pageNumber).padStart(2, '0'), {
        x: 11.8, y: 6.82, w: 0.78, h: 0.3,
        fontFace: FONT_FACE, fontSize: 13, bold: true, color: '344955',
        margin: 0, align: 'right',
      })
    }
    const output = await pptx.write({ outputType: 'uint8array', compression: true })
    return new Uint8Array(output as Uint8Array)
  }
}

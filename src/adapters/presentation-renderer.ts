import PptxGenJS from 'pptxgenjs'
import sharp from 'sharp'
import type { z } from 'zod'
import type { PresentationRendererPort } from '../core/ports'
import { layeredSlideElementSchema } from '../presentation-contracts'

const SLIDE_WIDTH = 1600
const SLIDE_HEIGHT = 900
const PPTX_WIDTH = 13.333
const PPTX_HEIGHT = 7.5
const FONT_FACE = 'Microsoft YaHei'

type RenderInput = Parameters<PresentationRendererPort['renderPreview']>[0]
type LayeredElement = z.infer<typeof layeredSlideElementSchema>
type SlideSource = RenderInput['slides'][number]

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

function pixelPlacement(element: LayeredElement) {
  return {
    left: Math.round(element.placement.x * SLIDE_WIDTH),
    top: Math.round(element.placement.y * SLIDE_HEIGHT),
    width: Math.max(1, Math.round(element.placement.width * SLIDE_WIDTH)),
    height: Math.max(1, Math.round(element.placement.height * SLIDE_HEIGHT)),
  }
}

function layeredSvg(element: Exclude<LayeredElement, { kind: 'IMAGE' }>) {
  const box = pixelPlacement(element)
  if (element.kind === 'SHAPE') {
    const fill = element.fillColor
    const opacity = (100 - element.transparency) / 100
    const shape = element.shape === 'ELLIPSE'
      ? `<ellipse cx="${box.left + box.width / 2}" cy="${box.top + box.height / 2}" rx="${box.width / 2}" ry="${box.height / 2}" fill="${fill}" fill-opacity="${opacity}"/>`
      : element.shape === 'LINE' || element.shape === 'ARROW'
        ? `<line x1="${box.left}" y1="${box.top + box.height / 2}" x2="${box.left + box.width}" y2="${box.top + box.height / 2}" stroke="${fill}" stroke-width="6"${element.shape === 'ARROW' ? ' marker-end="url(#arrow)"' : ''}/>`
        : `<rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" rx="${element.shape === 'ROUNDED_RECTANGLE' ? 24 : 0}" fill="${fill}" fill-opacity="${opacity}"/>`
    return Buffer.from(`<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${fill}"/></marker></defs>${shape}</svg>`)
  }

  const fontSize = Math.max(15, Math.round(element.style.fontSize * 1.55))
  const maxCharacters = Math.max(4, Math.floor(box.width / (fontSize * 0.95)))
  const lines = wrapText(element.text, maxCharacters).slice(0, Math.max(1, Math.floor(box.height / (fontSize * 1.25))))
  const anchor = element.style.align === 'CENTER' ? 'middle' : element.style.align === 'RIGHT' ? 'end' : 'start'
  const x = element.style.align === 'CENTER' ? box.left + box.width / 2 : element.style.align === 'RIGHT' ? box.left + box.width : box.left
  const text = lines.map((line, index) => `<text x="${x}" y="${box.top + fontSize + index * fontSize * 1.25}" text-anchor="${anchor}" font-family="${FONT_FACE}" font-size="${fontSize}" font-weight="${element.style.bold ? 700 : 400}" fill="${element.style.color}">${escapeXml(line)}</text>`).join('')
  return Buffer.from(`<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">${text}</svg>`)
}

function requireLayeredAssets(source: SlideSource, elements: readonly LayeredElement[]) {
  const byId = new Map((source.assets ?? []).map((asset) => [asset.elementId, asset]))
  const imageElements = elements.filter((element): element is Extract<LayeredElement, { kind: 'IMAGE' }> => element.kind === 'IMAGE')
  for (const element of imageElements) {
    if (!byId.has(element.elementId)) throw new Error(`RENDER_LAYER_ASSET_MISSING:${element.elementId}`)
  }
  return byId
}

async function renderLayeredSlide(source: SlideSource, elements: readonly LayeredElement[], backgroundColor: string) {
  const assets = requireLayeredAssets(source, elements)
  const composites = await Promise.all([...elements].sort((left, right) => left.zIndex - right.zIndex).map(async (element) => {
    if (element.kind !== 'IMAGE') return { input: layeredSvg(element), left: 0, top: 0 }
    const asset = assets.get(element.elementId)!
    const box = pixelPlacement(element)
    const image = await sharp(asset.image).rotate().resize(box.width, box.height, {
      fit: element.fit === 'COVER' ? 'cover' : 'contain',
      position: 'centre',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png({ compressionLevel: 8 }).toBuffer()
    return { input: image, left: box.left, top: box.top }
  }))
  return sharp({ create: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, channels: 4, background: backgroundColor } })
    .composite(composites)
    .flatten({ background: backgroundColor })
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
    const rendered = await Promise.all(slideByPage(input).map(({ blueprint, source }) => {
      if (input.blueprint.renderMode === 'LAYERED_COURSEWARE_V3') {
        if (!blueprint.layeredDesign) throw new Error(`RENDER_LAYERED_DESIGN_MISSING:${blueprint.pageNumber}`)
        return renderLayeredSlide(source, blueprint.layeredDesign.elements, blueprint.layeredDesign.backgroundColor)
      }
      return renderSlide({
        image: source.image,
        deckTitle: input.blueprint.title,
        title: blueprint.title,
        body: blueprint.body,
        pageNumber: blueprint.pageNumber,
        slideLayout: blueprint.layout,
      })
    }))
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
      if (input.blueprint.renderMode === 'LAYERED_COURSEWARE_V3') {
        if (!blueprint.layeredDesign) throw new Error(`RENDER_LAYERED_DESIGN_MISSING:${blueprint.pageNumber}`)
        const assets = requireLayeredAssets(source, blueprint.layeredDesign.elements)
        const slide = pptx.addSlide()
        slide.background = { color: blueprint.layeredDesign.backgroundColor.slice(1) }
        for (const element of [...blueprint.layeredDesign.elements].sort((left, right) => left.zIndex - right.zIndex)) {
          const x = element.placement.x * PPTX_WIDTH
          const y = element.placement.y * PPTX_HEIGHT
          const w = element.placement.width * PPTX_WIDTH
          const h = element.placement.height * PPTX_HEIGHT
          if (element.kind === 'IMAGE') {
            const image = await sharp(assets.get(element.elementId)!.image).rotate().png().toBuffer()
            slide.addImage({
              data: `data:image/png;base64,${image.toString('base64')}`,
              x, y, w, h,
              sizing: { type: element.fit === 'CONTAIN' ? 'contain' : 'cover', w, h },
              altText: `${element.elementId} | ${element.role} | ${element.knowledgePoint}`,
              objectName: element.elementId,
            })
          } else if (element.kind === 'TEXT') {
            slide.addText(element.text, {
              x, y, w, h,
              fontFace: FONT_FACE,
              fontSize: element.style.fontSize,
              bold: element.style.bold,
              color: element.style.color.slice(1),
              align: element.style.align.toLowerCase() as 'left' | 'center' | 'right',
              margin: 0.04,
              fit: 'shrink',
              valign: element.role === 'TITLE' ? 'middle' : 'top',
              objectName: element.elementId,
            })
          } else {
            const shapeType = element.shape === 'ROUNDED_RECTANGLE' ? pptx.ShapeType.roundRect
              : element.shape === 'ELLIPSE' ? pptx.ShapeType.ellipse
                : element.shape === 'LINE' ? pptx.ShapeType.line
                  : element.shape === 'ARROW' ? pptx.ShapeType.rightArrow
                    : pptx.ShapeType.rect
            slide.addShape(shapeType, {
              x, y, w, h,
              fill: { color: element.fillColor.slice(1), transparency: element.transparency },
              line: { color: element.fillColor.slice(1), transparency: element.shape === 'LINE' ? element.transparency : 100 },
              objectName: element.elementId,
            })
          }
        }
        continue
      }
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

import PptxGenJS from 'pptxgenjs'
import sharp from 'sharp'
import {
  shanHaiPptDeckV1Schema,
  shanHaiPptPageV1Schema,
  type ShanHaiPptDeckV1,
  type ShanHaiPptPageV1,
} from '../shanhai-v1-contracts'

const SLIDE_WIDTH = 1600
const SLIDE_HEIGHT = 900
const PX_PER_INCH = 120
const FONT_FACE = 'Microsoft YaHei'

type Box = Readonly<{ x: number; y: number; width: number; height: number }>
type PageLayout = Readonly<{ image: Box; text: Box }>

export type ShanHaiPptImageAssetV1 = Readonly<{
  target_slot_key: string
  bytes: Uint8Array
  mime_type: 'image/png' | 'image/jpeg'
}>

export type ShanHaiPptRenderInputV1 = Readonly<{
  deck: ShanHaiPptDeckV1
  assets: readonly ShanHaiPptImageAssetV1[]
}>

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

function pageLayout(page: ShanHaiPptPageV1): PageLayout {
  switch (page.layout_spec.template) {
    case 'COVER':
      return {
        image: { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
        text: { x: 90, y: 530, width: 1_180, height: 270 },
      }
    case 'IMAGE_RIGHT':
      return {
        image: { x: 820, y: 90, width: 700, height: 720 },
        text: { x: 80, y: 105, width: 660, height: 680 },
      }
    case 'IMAGE_TOP':
      return {
        image: { x: 100, y: 65, width: 1_400, height: 475 },
        text: { x: 110, y: 585, width: 1_380, height: 235 },
      }
    default:
      return {
        image: { x: 80, y: 90, width: 700, height: 720 },
        text: { x: 860, y: 105, width: 660, height: 680 },
      }
  }
}

function textContent(page: ShanHaiPptPageV1) {
  const title = page.editable_text_blocks.find((block) => block.role === 'title')
    ?? page.editable_text_blocks[0]!
  const body = page.editable_text_blocks.filter((block) => block.block_key !== title.block_key)
  return { title, body }
}

async function normalizedImage(asset: ShanHaiPptImageAssetV1, box: Box, fit: 'cover' | 'contain') {
  return sharp(asset.bytes)
    .rotate()
    .resize(box.width, box.height, {
      fit,
      position: 'centre',
      background: '#FFFFFF',
    })
    .flatten({ background: '#FFFFFF' })
    .png({ compressionLevel: 8 })
    .toBuffer()
}

function previewTextSvg(page: ShanHaiPptPageV1, layout: PageLayout) {
  const { title, body } = textContent(page)
  const cover = page.page_type === 'cover'
  const titleLimit = layout.text.width > 1_000 ? 24 : 15
  const bodyLimit = layout.text.width > 1_000 ? 46 : 24
  const titleLines = wrapText(title.text, titleLimit).slice(0, 2)
  const bodyLines = body.flatMap((block) => wrapText(block.text, bodyLimit)).slice(0, 7)
  const titleFill = cover ? '#FFFFFF' : '#17202A'
  const bodyFill = cover ? '#F4F7F8' : '#34424A'
  const backdrop = cover
    ? `<rect x="55" y="490" width="1320" height="340" rx="18" fill="#111820" fill-opacity="0.58"/>`
    : ''
  const titleSvg = titleLines.map((line, index) => (
    `<text x="${layout.text.x}" y="${layout.text.y + 58 + index * 70}" font-size="58" font-weight="700" fill="${titleFill}">${escapeXml(line)}</text>`
  )).join('')
  const bodyStart = layout.text.y + 205
  const bodySvg = bodyLines.map((line, index) => (
    `<text x="${layout.text.x}" y="${bodyStart + index * 49}" font-size="29" font-weight="400" fill="${bodyFill}">${escapeXml(line)}</text>`
  )).join('')
  return Buffer.from(`<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    ${backdrop}
    ${titleSvg}
    ${bodySvg}
    <text x="1515" y="850" text-anchor="end" font-size="22" font-weight="600" fill="${cover ? '#FFFFFF' : '#55736A'}">${String(page.position).padStart(2, '0')}</text>
  </svg>`)
}

function requireAssets(deck: ShanHaiPptDeckV1, assets: readonly ShanHaiPptImageAssetV1[]) {
  const bySlot = new Map<string, ShanHaiPptImageAssetV1>()
  for (const asset of assets) {
    if (bySlot.has(asset.target_slot_key)) throw new Error(`SHANHAI_V1_ASSET_DUPLICATE:${asset.target_slot_key}`)
    bySlot.set(asset.target_slot_key, asset)
  }
  const required = new Set(deck.pages.map((page) => (
    page.visual.asset_requirements[0]!.target_slot_key
  )))
  for (const slot of required) {
    if (!bySlot.has(slot)) throw new Error(`SHANHAI_V1_ASSET_MISSING:${slot}`)
  }
  for (const slot of bySlot.keys()) {
    if (!required.has(slot)) throw new Error(`SHANHAI_V1_ASSET_UNDECLARED:${slot}`)
  }
  return bySlot
}

export async function renderShanHaiPptPagePreviewV1(
  pageInput: ShanHaiPptPageV1,
  asset: ShanHaiPptImageAssetV1,
) {
  const page = shanHaiPptPageV1Schema.parse(pageInput)
  const expectedSlot = page.visual.asset_requirements[0]!.target_slot_key
  if (asset.target_slot_key !== expectedSlot) throw new Error(`SHANHAI_V1_ASSET_SLOT_MISMATCH:${expectedSlot}`)
  const layout = pageLayout(page)
  const image = await normalizedImage(asset, layout.image, page.layout_spec.image_fit)
  const base = page.page_type === 'cover'
    ? image
    : await sharp({ create: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, channels: 3, background: '#FFFFFF' } })
      .composite([{ input: image, left: layout.image.x, top: layout.image.y }])
      .png()
      .toBuffer()
  return sharp(base)
    .composite([{ input: previewTextSvg(page, layout), left: 0, top: 0 }])
    .png({ compressionLevel: 8 })
    .toBuffer()
}

function inches(value: number) {
  return value / PX_PER_INCH
}

function addEditableText(slide: ReturnType<PptxGenJS['addSlide']>, page: ShanHaiPptPageV1, layout: PageLayout) {
  const { title, body } = textContent(page)
  const cover = page.page_type === 'cover'
  const titleColor = cover ? 'FFFFFF' : '17202A'
  const bodyColor = cover ? 'F4F7F8' : '34424A'
  if (cover) {
    slide.addShape('rect', {
      x: inches(55), y: inches(490), w: inches(1_320), h: inches(340),
      rectRadius: 0.08,
      fill: { color: '111820', transparency: 42 },
      line: { color: '111820', transparency: 100 },
    })
  }
  slide.addText(title.text, {
    x: inches(layout.text.x), y: inches(layout.text.y),
    w: inches(layout.text.width), h: cover ? 1.35 : 1.05,
    fontFace: FONT_FACE, fontSize: cover ? 31 : 28, bold: true,
    color: titleColor, margin: 0, fit: 'shrink', valign: 'middle',
  })
  const bodyY = inches(layout.text.y) + (cover ? 1.62 : 1.28)
  const bodyText = body.map((block) => block.text).join('\n\n')
  if (bodyText) {
    slide.addText(bodyText, {
      x: inches(layout.text.x), y: bodyY,
      w: inches(layout.text.width),
      h: Math.max(0.7, inches(layout.text.y + layout.text.height) - bodyY),
      fontFace: FONT_FACE, fontSize: cover ? 18 : 17,
      color: bodyColor, margin: 0, fit: 'shrink', valign: 'top', breakLine: false,
      paraSpaceAfter: 8,
    })
  }
  slide.addText(String(page.position).padStart(2, '0'), {
    x: 12.1, y: 6.95, w: 0.55, h: 0.24,
    fontFace: FONT_FACE, fontSize: 11, bold: true,
    color: cover ? 'FFFFFF' : '55736A', margin: 0, align: 'right',
  })
  if (page.speaker_notes) slide.addNotes(page.speaker_notes)
}

export class ShanHaiPptImageTextRendererV1 {
  async renderPreview(input: ShanHaiPptRenderInputV1) {
    const deck = shanHaiPptDeckV1Schema.parse(input.deck)
    const assets = requireAssets(deck, input.assets)
    const pages = await Promise.all(deck.pages.map((page) => renderShanHaiPptPagePreviewV1(
      page,
      assets.get(page.visual.asset_requirements[0]!.target_slot_key)!,
    )))
    const columns = Math.min(3, pages.length)
    const rows = Math.ceil(pages.length / columns)
    const thumbnailWidth = 480
    const thumbnailHeight = 270
    const gap = 24
    const composites = await Promise.all(pages.map(async (page, index) => ({
      input: await sharp(page).resize(thumbnailWidth, thumbnailHeight).png().toBuffer(),
      left: gap + (index % columns) * (thumbnailWidth + gap),
      top: gap + Math.floor(index / columns) * (thumbnailHeight + gap),
    })))
    return sharp({
      create: {
        width: columns * thumbnailWidth + (columns + 1) * gap,
        height: rows * thumbnailHeight + (rows + 1) * gap,
        channels: 3,
        background: '#E8EDF0',
      },
    }).composite(composites).png({ compressionLevel: 8 }).toBuffer()
  }

  async renderPptx(input: ShanHaiPptRenderInputV1) {
    const deck = shanHaiPptDeckV1Schema.parse(input.deck)
    const assets = requireAssets(deck, input.assets)
    const pptx = new PptxGenJS()
    pptx.layout = 'LAYOUT_WIDE'
    pptx.author = 'ShanHaiEdu PPT Agent'
    pptx.company = 'ShanHaiEdu'
    pptx.subject = '可编辑图片文字混合课件'
    pptx.title = deck.title
    pptx.theme = { headFontFace: FONT_FACE, bodyFontFace: FONT_FACE }

    for (const page of deck.pages) {
      const asset = assets.get(page.visual.asset_requirements[0]!.target_slot_key)!
      const layout = pageLayout(page)
      const image = await normalizedImage(asset, layout.image, page.layout_spec.image_fit)
      const slide = pptx.addSlide()
      slide.background = { color: 'FFFFFF' }
      slide.addImage({
        data: `data:image/png;base64,${image.toString('base64')}`,
        x: inches(layout.image.x), y: inches(layout.image.y),
        w: inches(layout.image.width), h: inches(layout.image.height),
        altText: page.visual.main_visual_description,
      })
      addEditableText(slide, page, layout)
    }
    const output = await pptx.write({ outputType: 'uint8array', compression: true })
    return new Uint8Array(output as Uint8Array)
  }
}

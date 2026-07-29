import PptxGenJS from 'pptxgenjs'
import sharp from 'sharp'
import type { PresentationRendererPort } from '../core/ports'

const WIDTH = 1600
const HEIGHT = 900
const PPTX_WIDTH = 13.333
const PPTX_HEIGHT = 7.5
const FONT_FACE = 'Microsoft YaHei'

const COLORS = {
  ink: '#17324D',
  muted: '#5F7180',
  green: '#13766B',
  paleGreen: '#E3F3EC',
  coral: '#EF6F6C',
  yellow: '#F4D35E',
  blue: '#6AAED6',
  paleBlue: '#E8F3F8',
  purple: '#8067B7',
  white: '#FFFFFF',
  canvas: '#F7FAF8',
  line: '#D9E4E1',
} as const

type Blueprint = Parameters<PresentationRendererPort['renderPptx']>[0]['blueprint']
type BlueprintSlide = Blueprint['slides'][number]

type Element = Readonly<{
  kind: 'RECT' | 'ELLIPSE' | 'LINE' | 'TRIANGLE' | 'TEXT'
  x: number
  y: number
  width: number
  height: number
  fill?: string
  stroke?: string
  lineWidth?: number
  radius?: number
  rotation?: number
  text?: string
  fontSize?: number
  bold?: boolean
  color?: string
  align?: 'LEFT' | 'CENTER' | 'RIGHT'
}>

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[character]!)
}

function rect(x: number, y: number, width: number, height: number, fill: string, radius = 24, stroke?: string): Element {
  return { kind: 'RECT', x, y, width, height, fill, radius, ...(stroke ? { stroke } : {}) }
}

function ellipse(x: number, y: number, width: number, height: number, fill: string, stroke?: string): Element {
  return { kind: 'ELLIPSE', x, y, width, height, fill, ...(stroke ? { stroke } : {}) }
}

function line(x: number, y: number, width: number, height: number, stroke: string, lineWidth = 6): Element {
  return { kind: 'LINE', x, y, width, height, stroke, lineWidth }
}

function triangle(x: number, y: number, width: number, height: number, fill: string, rotation = 0): Element {
  return { kind: 'TRIANGLE', x, y, width, height, fill, rotation }
}

function text(
  value: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number,
  color: string = COLORS.ink,
  bold: boolean = false,
  align: Element['align'] = 'LEFT',
): Element {
  return { kind: 'TEXT', text: value, x, y, width, height, fontSize, color, bold, align }
}

function basePage(slide: BlueprintSlide): Element[] {
  return [
    rect(0, 0, WIDTH, HEIGHT, COLORS.canvas, 0),
    rect(64, 45, 260, 38, COLORS.paleGreen, 18),
    text('人教版一年级上册 · 数学', 84, 48, 220, 30, 20, COLORS.green, true),
    text(String(slide.pageNumber).padStart(2, '0'), 1455, 46, 80, 34, 22, COLORS.muted, true, 'RIGHT'),
    rect(64, 106, 8, 64, COLORS.coral, 4),
    text(slide.title, 94, 102, 1370, 78, 48, COLORS.ink, true),
  ]
}

function counterGroup(count: number, x: number, y: number, color: string, size = 58, columns = 5): Element[] {
  return Array.from({ length: count }, (_, index) => ellipse(
    x + (index % columns) * (size + 14),
    y + Math.floor(index / columns) * (size + 14),
    size,
    size,
    color,
    COLORS.white,
  ))
}

function bird(x: number, y: number, color: string, scale = 1): Element[] {
  return [
    ellipse(x, y + 14 * scale, 72 * scale, 42 * scale, color),
    ellipse(x + 46 * scale, y, 34 * scale, 34 * scale, color),
    ellipse(x + 20 * scale, y + 18 * scale, 34 * scale, 22 * scale, COLORS.white),
    triangle(x + 76 * scale, y + 10 * scale, 18 * scale, 16 * scale, COLORS.yellow, 90),
    ellipse(x + 66 * scale, y + 9 * scale, 5 * scale, 5 * scale, COLORS.ink),
  ]
}

function nest(x: number, y: number, scale = 1): Element[] {
  return [
    ellipse(x, y, 190 * scale, 76 * scale, '#C58B58'),
    ellipse(x + 16 * scale, y + 10 * scale, 158 * scale, 44 * scale, '#6F4936'),
    rect(x + 13 * scale, y + 33 * scale, 164 * scale, 58 * scale, '#B97945', 30 * scale),
    line(x + 28 * scale, y + 50 * scale, 130 * scale, 0, '#E3B27B', 5),
    line(x + 40 * scale, y + 68 * scale, 106 * scale, 0, '#E3B27B', 5),
  ]
}

function flower(x: number, y: number, color: string, scale = 1): Element[] {
  const petal = 32 * scale
  return [
    ellipse(x + petal, y, petal, petal, color),
    ellipse(x + petal * 2, y + petal, petal, petal, color),
    ellipse(x + petal, y + petal * 2, petal, petal, color),
    ellipse(x, y + petal, petal, petal, color),
    ellipse(x + petal, y + petal, petal, petal, COLORS.yellow),
  ]
}

function arrow(x: number, y: number, width: number, color: string = COLORS.green): Element[] {
  return [line(x, y, width - 22, 0, color, 6), triangle(x + width - 28, y - 13, 28, 26, color, 90)]
}

function splitCard(x: number, y: number, left: number, right: number, accent: string): Element[] {
  return [
    rect(x, y, 600, 195, COLORS.white, 24, COLORS.line),
    text(`5 可以分成 ${left} 和 ${right}`, x + 28, y + 20, 544, 45, 28, COLORS.ink, true, 'CENTER'),
    ...counterGroup(left, x + 86, y + 94, accent, 48, 4),
    text('和', x + 272, y + 100, 56, 42, 24, COLORS.muted, true, 'CENTER'),
    ...counterGroup(right, x + 354, y + 94, COLORS.blue, 48, 4),
  ]
}

function lessonElements(slide: BlueprintSlide): Element[] {
  const page = slide.pageNumber
  if (page === 1) {
    const elements: Element[] = [
      rect(0, 0, WIDTH, HEIGHT, '#EEF7F1', 0),
      rect(74, 66, 292, 42, COLORS.white, 21),
      text('人教版一年级上册 · 第20—21页', 94, 70, 252, 32, 20, COLORS.green, true),
      text('5以内数的\n分与合', 90, 175, 650, 230, 78, COLORS.ink, true),
      text('把一个数分成两个部分', 96, 440, 520, 60, 34, COLORS.coral, true),
      rect(94, 535, 390, 78, COLORS.white, 24),
      text('帮助 5 只小鸟找到两个家', 120, 552, 340, 44, 26, COLORS.green, true),
      line(710, 690, 790, -80, '#8B6A4A', 18),
      ...nest(930, 615, 0.9),
      ...nest(1240, 565, 0.9),
    ]
    const positions = [[785, 250], [970, 200], [1140, 300], [1305, 218], [1380, 380]]
    positions.forEach(([x, y], index) => elements.push(...bird(x!, y!, [COLORS.coral, COLORS.blue, COLORS.yellow, COLORS.green, COLORS.purple][index]!, 0.9)))
    return elements
  }

  const elements = basePage(slide)
  if (page === 2) {
    elements.push(rect(70, 215, 700, 590, COLORS.paleBlue, 28))
    ;[[145, 285], [300, 255], [455, 300], [230, 420], [410, 445]].forEach(([x, y], index) =>
      elements.push(...bird(x!, y!, [COLORS.coral, COLORS.blue, COLORS.yellow, COLORS.green, COLORS.purple][index]!, 0.8)))
    elements.push(...nest(145, 625, 0.8), ...nest(445, 625, 0.8))
    const tasks = ['一共有几只小鸟？', '它们要飞进几个鸟巢？', '两个鸟巢里的数量会怎样变化？']
    tasks.forEach((task, index) => {
      const y = 220 + index * 178
      elements.push(rect(835, y, 680, 142, COLORS.white, 24, COLORS.line))
      elements.push(ellipse(872, y + 39, 62, 62, index === 0 ? COLORS.coral : index === 1 ? COLORS.green : COLORS.blue))
      elements.push(text(String(index + 1), 872, y + 51, 62, 36, 24, COLORS.white, true, 'CENTER'))
      elements.push(text(task, 970, y + 43, 500, 58, 29, COLORS.ink, true))
    })
  } else if (page === 3) {
    elements.push(rect(70, 215, 930, 540, '#DCEEF3', 24))
    elements.push(rect(92, 237, 886, 496, COLORS.white, 18))
    ;[[155, 315], [300, 280], [445, 340], [600, 292], [735, 360]].forEach(([x, y], index) =>
      elements.push(...bird(x!, y!, [COLORS.coral, COLORS.blue, COLORS.yellow, COLORS.green, COLORS.purple][index]!, 0.72)))
    elements.push(...nest(270, 565, 0.65), ...nest(620, 565, 0.65))
    elements.push(...arrow(245, 485, 145, COLORS.coral), ...arrow(600, 485, 145, COLORS.blue))
    elements.push(ellipse(457, 408, 110, 110, COLORS.green), triangle(501, 438, 38, 42, COLORS.white, 90))
    elements.push(rect(1050, 235, 470, 198, COLORS.white, 24, COLORS.line))
    elements.push(text('认真观察', 1090, 273, 380, 48, 31, COLORS.green, true))
    elements.push(text('5只小鸟陆续飞向\n两个鸟巢', 1090, 330, 380, 82, 27, COLORS.ink, true))
    elements.push(rect(1050, 465, 470, 220, '#FFF7E1', 24))
    elements.push(text('先想一想', 1090, 503, 380, 48, 31, '#A86420', true))
    elements.push(text('两个鸟巢里\n可能各有几只？', 1090, 565, 380, 92, 27, COLORS.ink, true))
  } else if (page === 4) {
    elements.push(rect(72, 215, 780, 575, COLORS.paleGreen, 28))
    ;[[130, 275], [250, 265], [370, 290], [490, 265], [610, 285]].forEach(([x, y], index) =>
      elements.push(...bird(x!, y!, [COLORS.coral, COLORS.blue, COLORS.yellow, COLORS.green, COLORS.purple][index]!, 0.68)))
    elements.push(...arrow(340, 425, 220), ...nest(150, 600, 0.72), ...nest(500, 600, 0.72))
    elements.push(rect(910, 230, 610, 210, COLORS.white, 24, COLORS.line))
    elements.push(text('一共有 5 只小鸟，\n飞进两个鸟巢。', 960, 270, 510, 110, 32, COLORS.ink, true))
    elements.push(rect(910, 475, 610, 215, '#FFF4F2', 24))
    elements.push(text('怎样找清楚，又不漏掉？', 960, 515, 510, 48, 30, COLORS.coral, true))
    elements.push(text('用 5 个圆片代替小鸟，分成两堆试一试。', 960, 590, 510, 70, 25, COLORS.ink))
  } else if (page === 5) {
    elements.push(rect(74, 225, 800, 510, '#F3E6D5', 28))
    elements.push(rect(120, 285, 270, 360, COLORS.white, 22, '#D5B38C'))
    elements.push(rect(558, 285, 270, 360, COLORS.white, 22, '#D5B38C'))
    elements.push(...counterGroup(1, 222, 420, COLORS.coral, 72))
    elements.push(...counterGroup(4, 605, 375, COLORS.blue, 72, 2))
    elements.push(text('1 个', 175, 565, 160, 45, 28, COLORS.coral, true, 'CENTER'))
    elements.push(text('4 个', 615, 565, 160, 45, 28, COLORS.blue, true, 'CENTER'))
    elements.push(rect(930, 240, 580, 435, COLORS.white, 24, COLORS.line))
    elements.push(text('动手摆一摆', 980, 282, 480, 52, 34, COLORS.green, true))
    elements.push(text('• 每一堆都要有圆片\n\n• 数一数两堆各有几个\n\n• 和同桌说一说你的分法', 980, 365, 480, 250, 26, COLORS.ink))
  } else if (page === 6) {
    elements.push(...splitCard(120, 245, 1, 4, COLORS.coral))
    elements.push(...splitCard(880, 245, 2, 3, COLORS.green))
    elements.push(rect(250, 520, 1100, 160, COLORS.paleGreen, 28))
    elements.push(text('两堆圆片合在一起，还是 5 个。', 300, 565, 1000, 58, 36, COLORS.green, true, 'CENTER'))
  } else if (page === 7) {
    elements.push(text('一个整体', 100, 235, 340, 44, 25, COLORS.muted, true, 'CENTER'))
    elements.push(rect(100, 300, 340, 250, COLORS.white, 28, COLORS.line))
    elements.push(...counterGroup(5, 120, 380, COLORS.green, 52, 5))
    elements.push(...arrow(465, 410, 170, COLORS.coral))
    elements.push(text('分', 505, 352, 85, 42, 28, COLORS.coral, true, 'CENTER'))
    elements.push(rect(665, 250, 770, 145, '#FFF4F2', 24))
    elements.push(...counterGroup(1, 710, 300, COLORS.coral, 48), text('和', 835, 310, 50, 34, 24, COLORS.muted, true, 'CENTER'), ...counterGroup(4, 930, 300, COLORS.blue, 48, 4))
    elements.push(rect(665, 450, 770, 145, COLORS.paleBlue, 24))
    elements.push(...counterGroup(2, 710, 500, COLORS.coral, 48, 2), text('和', 880, 510, 50, 34, 24, COLORS.muted, true, 'CENTER'), ...counterGroup(3, 980, 500, COLORS.blue, 48, 3))
    elements.push(text('5 可以分成 1 和 4，1 和 4 组成 5。\n5 可以分成 2 和 3，2 和 3 组成 5。', 240, 670, 1120, 110, 28, COLORS.ink, true, 'CENTER'))
  } else if (page === 8) {
    const pairs = [[1, 4], [2, 3], [3, 2], [4, 1]]
    pairs.forEach(([left, right], index) => {
      const x = 80 + index * 380
      elements.push(rect(x, 245, 330, 350, index % 2 === 0 ? COLORS.paleGreen : COLORS.paleBlue, 24))
      elements.push(text(`${left} 和 ${right}`, x + 35, 275, 260, 44, 29, COLORS.ink, true, 'CENTER'))
      elements.push(...counterGroup(left!, x + 50, 365, COLORS.coral, 44, 4))
      elements.push(line(x + 45, 455, 240, 0, COLORS.line, 4))
      elements.push(...counterGroup(right!, x + 50, 495, COLORS.blue, 44, 4))
      if (index < pairs.length - 1) elements.push(...arrow(x + 320, 420, 62, COLORS.green))
    })
    elements.push(rect(230, 650, 1140, 105, COLORS.white, 24, COLORS.line))
    elements.push(text('按顺序分：一边逐渐增加，另一边逐渐减少。', 280, 680, 1040, 48, 31, COLORS.green, true, 'CENTER'))
  } else if (page === 9) {
    const cards = [[120, 1, 3], [850, 2, 2]] as const
    cards.forEach(([x, left, right], cardIndex) => {
      elements.push(rect(x, 245, 610, 390, COLORS.white, 28, COLORS.line))
      elements.push(text(`4 可以分成 ${left} 和 ${right}`, x + 40, 280, 530, 48, 30, COLORS.ink, true, 'CENTER'))
      for (let i = 0; i < left; i += 1) elements.push(...flower(x + 85 + i * 100, 390, COLORS.coral, 0.8))
      elements.push(text('和', x + 270, 455, 70, 42, 26, COLORS.muted, true, 'CENTER'))
      for (let i = 0; i < right; i += 1) elements.push(...flower(x + 355 + i * 100, 390, cardIndex === 0 ? COLORS.blue : COLORS.purple, 0.8))
    })
    elements.push(text('先自己摆，再和同桌说一说。', 400, 690, 800, 50, 30, COLORS.green, true, 'CENTER'))
  } else if (page === 10) {
    const questions = [
      { y: 220, prompt: '3 可以分成 1 和（  ）', solid: 1, empty: 2, color: COLORS.coral },
      { y: 410, prompt: '3 和（  ）组成 5', solid: 3, empty: 2, color: COLORS.blue },
      { y: 600, prompt: '1 和（  ）组成 2', solid: 1, empty: 1, color: COLORS.green },
    ]
    questions.forEach((question, index) => {
      elements.push(rect(120, question.y, 1360, 150, index === 1 ? COLORS.paleBlue : COLORS.paleGreen, 28))
      elements.push(text(question.prompt, 180, question.y + 39, 560, 62, 34, COLORS.ink, true))
      elements.push(...counterGroup(question.solid, 815, question.y + 46, question.color, 54, 5))
      for (let i = 0; i < question.empty; i += 1) {
        elements.push(ellipse(1115 + i * 78, question.y + 46, 54, 54, COLORS.white, COLORS.coral))
      }
    })
    elements.push(text('先摆一摆或看清图意，再填一填。', 420, 790, 760, 40, 25, COLORS.green, true, 'CENTER'))
  } else if (page === 11) {
    elements.push(rect(70, 220, 820, 565, COLORS.paleBlue, 28))
    elements.push(...nest(145, 540, 0.85), ...nest(535, 540, 0.85))
    ;[[180, 420], [265, 390]].forEach(([x, y], index) => elements.push(...bird(x!, y!, [COLORS.coral, COLORS.yellow][index]!, 0.7)))
    ;[[520, 365], [620, 410], [710, 350]].forEach(([x, y], index) => elements.push(...bird(x!, y!, [COLORS.blue, COLORS.green, COLORS.purple][index]!, 0.7)))
    elements.push(text('2 只', 185, 690, 150, 40, 28, COLORS.coral, true, 'CENTER'))
    elements.push(text('3 只', 575, 690, 150, 40, 28, COLORS.blue, true, 'CENTER'))
    elements.push(rect(940, 250, 570, 405, COLORS.white, 26, COLORS.line))
    elements.push(text('5 可以分成', 990, 285, 470, 48, 30, COLORS.ink, true))
    elements.push(text('2 和 3', 990, 355, 470, 54, 36, COLORS.coral, true, 'CENTER'))
    elements.push(text('2 和 3 组成 5', 990, 475, 470, 60, 32, COLORS.green, true, 'CENTER'))
    elements.push(text('你还能想到其他分法吗？', 990, 585, 470, 42, 24, COLORS.muted, false, 'CENTER'))
  } else if (page === 12) {
    const cards = [
      ['分', '把一个数分成两个部分', COLORS.coral],
      ['合', '两个部分组成一个数', COLORS.green],
      ['有序', '按顺序分，不重复、不遗漏', COLORS.blue],
    ] as const
    cards.forEach(([label, body, color], index) => {
      const x = 80 + index * 500
      elements.push(rect(x, 245, 450, 250, COLORS.white, 26, COLORS.line))
      elements.push(ellipse(x + 40, 285, 78, 78, color))
      elements.push(text(label, x + 40, 307, 78, 36, 24, COLORS.white, true, 'CENTER'))
      elements.push(text(body, x + 42, 390, 366, 76, 28, COLORS.ink, true, 'CENTER'))
    })
    elements.push(rect(185, 570, 1230, 155, COLORS.paleGreen, 28))
    elements.push(...counterGroup(5, 260, 620, COLORS.green, 50, 5))
    elements.push(...arrow(650, 645, 160, COLORS.coral))
    elements.push(...counterGroup(2, 850, 620, COLORS.coral, 50, 2))
    elements.push(text('和', 1010, 628, 50, 36, 24, COLORS.muted, true, 'CENTER'))
    elements.push(...counterGroup(3, 1090, 620, COLORS.blue, 50, 3))
    elements.push(text('课后：完成教材第21页“摆一摆，填一填”和小鸟活动。', 280, 775, 1040, 44, 25, COLORS.muted, false, 'CENTER'))
  }
  return elements
}

function svgElement(element: Element) {
  const stroke = element.stroke ? ` stroke="${element.stroke}" stroke-width="${element.lineWidth ?? 3}"` : ''
  if (element.kind === 'RECT') {
    return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="${element.radius ?? 0}" fill="${element.fill}"${stroke}/>`
  }
  if (element.kind === 'ELLIPSE') {
    return `<ellipse cx="${element.x + element.width / 2}" cy="${element.y + element.height / 2}" rx="${element.width / 2}" ry="${element.height / 2}" fill="${element.fill}"${stroke}/>`
  }
  if (element.kind === 'LINE') {
    return `<line x1="${element.x}" y1="${element.y}" x2="${element.x + element.width}" y2="${element.y + element.height}" stroke="${element.stroke}" stroke-width="${element.lineWidth ?? 4}" stroke-linecap="round"/>`
  }
  if (element.kind === 'TRIANGLE') {
    const cx = element.x + element.width / 2
    const cy = element.y + element.height / 2
    return `<polygon points="${cx},${element.y} ${element.x + element.width},${element.y + element.height} ${element.x},${element.y + element.height}" fill="${element.fill}" transform="rotate(${element.rotation ?? 0} ${cx} ${cy})"/>`
  }
  const anchor = element.align === 'CENTER' ? 'middle' : element.align === 'RIGHT' ? 'end' : 'start'
  const x = element.align === 'CENTER' ? element.x + element.width / 2 : element.align === 'RIGHT' ? element.x + element.width : element.x
  const lines = (element.text ?? '').split('\n')
  const lineHeight = (element.fontSize ?? 24) * 1.35
  return lines.map((value, index) => `<text x="${x}" y="${element.y + (element.fontSize ?? 24) + index * lineHeight}" text-anchor="${anchor}" font-family="${FONT_FACE}" font-size="${element.fontSize}" font-weight="${element.bold ? 700 : 400}" fill="${element.color}">${escapeXml(value)}</text>`).join('')
}

export function isFiveCompositionCourseware(blueprint: Blueprint) {
  return blueprint.slides.length === 12
    && blueprint.slides.every((slide, index) => slide.pageNumber === index + 1)
    && blueprint.title.includes('5以内数的分与合')
}

export async function renderFiveCompositionSlide(slide: BlueprintSlide) {
  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">${lessonElements(slide).map(svgElement).join('')}</svg>`
  return sharp(Buffer.from(svg)).png({ compressionLevel: 8 }).toBuffer()
}

export function addFiveCompositionSlide(pptx: PptxGenJS, slideBlueprint: BlueprintSlide) {
  const slide = pptx.addSlide()
  slide.background = { color: COLORS.canvas.slice(1) }
  for (const element of lessonElements(slideBlueprint)) {
    const x = element.x / WIDTH * PPTX_WIDTH
    const y = element.y / HEIGHT * PPTX_HEIGHT
    const width = element.width / WIDTH * PPTX_WIDTH
    const height = element.height / HEIGHT * PPTX_HEIGHT
    if (element.kind === 'TEXT') {
      slide.addText(element.text ?? '', {
        x, y, w: width, h: height,
        fontFace: FONT_FACE,
        fontSize: (element.fontSize ?? 24) * 0.75,
        bold: element.bold ?? false,
        color: (element.color ?? COLORS.ink).slice(1),
        align: (element.align ?? 'LEFT').toLowerCase() as 'left' | 'center' | 'right',
        margin: 0,
        fit: 'shrink',
        valign: 'top',
      })
      continue
    }
    if (element.kind === 'LINE') {
      slide.addShape(pptx.ShapeType.line, {
        x, y, w: width, h: height,
        line: { color: (element.stroke ?? COLORS.ink).slice(1), width: Math.max(1, (element.lineWidth ?? 4) * 0.55) },
      })
      continue
    }
    const shapeType = element.kind === 'ELLIPSE'
      ? pptx.ShapeType.ellipse
      : element.kind === 'TRIANGLE'
        ? pptx.ShapeType.triangle
        : (element.radius ?? 0) > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect
    slide.addShape(shapeType, {
      x, y, w: width, h: height,
      rotate: element.rotation ?? 0,
      fill: { color: (element.fill ?? COLORS.white).slice(1) },
      line: element.stroke
        ? { color: element.stroke.slice(1), width: Math.max(1, (element.lineWidth ?? 3) * 0.45) }
        : { color: (element.fill ?? COLORS.white).slice(1), transparency: 100 },
    })
  }
}

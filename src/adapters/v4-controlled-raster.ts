import sharp from 'sharp'
import type { ArtifactPort, ControlledRasterPort } from '../core/ports'
import type { ExactDiagramSpec } from '../core/v4-constraint-compiler'

export const CONTROLLED_RASTER_WIDTH = 1600
export const CONTROLLED_RASTER_HEIGHT = 900

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!)
}

function visibleLine(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function fontSize(value: string, maximum: number, minimum: number) {
  return Math.max(minimum, Math.min(maximum, Math.floor(1_120 / Math.max(1, value.length))))
}

function circleGrid(input: Readonly<{
  count: number
  startX: number
  startY: number
  availableWidth: number
  color: string
  maximumPerRow?: number
  radius?: number
}>) {
  const maximumPerRow = input.maximumPerRow ?? Math.min(5, input.count)
  const radius = input.radius ?? 40
  const gap = radius * 2.55
  const columns = Math.max(1, Math.min(maximumPerRow, input.count))
  const width = (columns - 1) * gap
  const xOffset = Math.max(0, (input.availableWidth - width) / 2)
  return Array.from({ length: input.count }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = input.startX + xOffset + column * gap
    const y = input.startY + row * gap
    return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${input.color}" fill-opacity="0.94"/><circle cx="${x - radius * 0.26}" cy="${y - radius * 0.28}" r="${radius * 0.22}" fill="#ffffff" fill-opacity="0.48"/>`
  }).join('')
}

function exactCountDiagram(diagram: Extract<ExactDiagramSpec, { kind: 'EXACT_COUNT' }>) {
  return circleGrid({ count: diagram.count, startX: 310, startY: 360, availableWidth: 980, color: '#F97316' })
}

function circleGridInBox(input: Readonly<{
  count: number
  left: number
  top: number
  width: number
  height: number
  color: string
  maximumPerRow: number
  maximumRadius: number
}>) {
  const columns = Math.max(1, Math.min(input.maximumPerRow, input.count))
  const rows = Math.ceil(input.count / columns)
  const spacing = 2.55
  const radius = Math.min(
    input.maximumRadius,
    input.width / (2 + (columns - 1) * spacing),
    input.height / (2 + (rows - 1) * spacing),
  )
  const gap = radius * spacing
  const firstX = input.left + input.width / 2 - (columns - 1) * gap / 2
  const firstY = input.top + input.height / 2 - (rows - 1) * gap / 2
  return Array.from({ length: input.count }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = firstX + column * gap
    const y = firstY + row * gap
    return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${input.color}" fill-opacity="0.94"/><circle cx="${x - radius * 0.26}" cy="${y - radius * 0.28}" r="${radius * 0.22}" fill="#ffffff" fill-opacity="0.48"/>`
  }).join('')
}

function partitionDiagram(diagram: Extract<ExactDiagramSpec, { kind: 'PARTITION' }>) {
  const groupColumns = Math.ceil(Math.sqrt(diagram.groupCount))
  const groupRows = Math.ceil(diagram.groupCount / groupColumns)
  const groupGap = 18
  const area = { left: 200, top: 315, width: 1200, height: 450 }
  const groupWidth = (area.width - groupGap * (groupColumns - 1)) / groupColumns
  const groupHeight = (area.height - groupGap * (groupRows - 1)) / groupRows
  const boxes = Array.from({ length: diagram.groupCount }, (_, index) => {
    const column = index % groupColumns
    const row = Math.floor(index / groupColumns)
    const left = area.left + column * (groupWidth + groupGap)
    const top = area.top + row * (groupHeight + groupGap)
    const color = index % 2 === 0 ? '#0EA5E9' : '#8B5CF6'
    const inset = Math.min(26, Math.max(12, Math.min(groupWidth, groupHeight) * 0.14))
    const cornerRadius = Math.min(30, Math.max(12, Math.min(groupWidth, groupHeight) / 4))
    return [
      `<rect x="${left}" y="${top}" width="${groupWidth}" height="${groupHeight}" rx="${cornerRadius}" fill="#ffffff" stroke="${color}" stroke-width="5"/>`,
      circleGridInBox({
        count: diagram.itemsPerGroup,
        left: left + inset,
        top: top + inset,
        width: groupWidth - inset * 2,
        height: groupHeight - inset * 2,
        color,
        maximumPerRow: Math.min(4, diagram.itemsPerGroup),
        maximumRadius: 28,
      }),
    ].join('')
  }).join('')
  return boxes
}

function comparisonDiagram(diagram: Extract<ExactDiagramSpec, { kind: 'COMPARE' }>) {
  const leftColor = diagram.direction === 'LEFT_GREATER' ? '#F97316' : '#38BDF8'
  const rightColor = diagram.direction === 'RIGHT_GREATER' ? '#F97316' : '#38BDF8'
  const panel = (input: Readonly<{ left: number; count: number; color: string }>) => [
    `<rect x="${input.left}" y="315" width="525" height="450" rx="34" fill="#ffffff" stroke="${input.color}" stroke-width="5"/>`,
    circleGrid({ count: input.count, startX: input.left + 75, startY: 420, availableWidth: 375, color: input.color, radius: 27 }),
  ].join('')
  return [
    panel({ left: 135, count: diagram.left.count, color: leftColor }),
    panel({ left: 940, count: diagram.right.count, color: rightColor }),
    `<path d="M710 540 L890 540" stroke="#475569" stroke-width="9" stroke-linecap="round"/>`,
    `<path d="M890 540 L850 510 M890 540 L850 570" stroke="#475569" stroke-width="9" stroke-linecap="round" fill="none"/>`,
  ].join('')
}

function diagramSvg(diagram: ExactDiagramSpec) {
  if (diagram.kind === 'EXACT_COUNT') return exactCountDiagram(diagram)
  if (diagram.kind === 'PARTITION') return partitionDiagram(diagram)
  return comparisonDiagram(diagram)
}

function unescapeXml(value: string) {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  })[entity]!)
}

export function assertControlledRasterSvgTextWhitelist(svg: string, allowedText: ReadonlySet<string>) {
  const textNodes = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
  for (const node of textNodes) {
    const text = visibleLine(unescapeXml(node[1]!))
    if (!allowedText.has(text)) throw new Error('CONTROLLED_RASTER_VISIBLE_TEXT_NOT_ALLOWED')
  }
}

export function controlledRasterSvg(input: Parameters<ControlledRasterPort['render']>[0]) {
  const allowedText = new Set([input.title, ...input.visibleCopy].map(visibleLine).filter(Boolean))
  const visibleText = [visibleLine(input.title), ...input.visibleCopy.slice(0, 3).map(visibleLine)].filter(Boolean)
  if (visibleText.some((text) => !allowedText.has(text))) throw new Error('CONTROLLED_RASTER_VISIBLE_TEXT_NOT_ALLOWED')
  const copy = visibleText.slice(1).map((line, index) =>
    `<text x="800" y="${172 + index * 42}" text-anchor="middle" font-size="${fontSize(line, 29, 18)}" font-family="sans-serif" fill="#475569">${escapeXml(line)}</text>`).join('')
  const svg = `<svg width="${CONTROLLED_RASTER_WIDTH}" height="${CONTROLLED_RASTER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#F8FAFC"/>
    <rect x="68" y="58" width="1464" height="784" rx="42" fill="#EAF3FF"/>
    <rect x="84" y="74" width="1432" height="752" rx="34" fill="#FDFEFF"/>
    <rect x="84" y="74" width="16" height="752" rx="8" fill="#2563EB"/>
    <text x="800" y="122" text-anchor="middle" font-size="${fontSize(visibleText[0] ?? '', 54, 24)}" font-weight="700" font-family="sans-serif" fill="#172554">${escapeXml(visibleText[0] ?? '')}</text>
    ${copy}
    ${diagramSvg(input.diagram)}
  </svg>`
  assertControlledRasterSvgTextWhitelist(svg, allowedText)
  return svg
}

export class SharpControlledRasterPort implements ControlledRasterPort {
  constructor(private readonly dependencies: Readonly<{ artifacts: ArtifactPort }>) {}

  async render(input: Parameters<ControlledRasterPort['render']>[0]) {
    const bytes = new Uint8Array(await sharp(Buffer.from(controlledRasterSvg(input))).png({ compressionLevel: 8 }).toBuffer())
    const metadata = await sharp(bytes).metadata()
    if (metadata.width !== CONTROLLED_RASTER_WIDTH || metadata.height !== CONTROLLED_RASTER_HEIGHT) {
      throw new Error('CONTROLLED_RASTER_OUTPUT_DIMENSIONS_INVALID')
    }
    const artifact = await this.dependencies.artifacts.put({
      tenantId: input.tenantId,
      runId: input.runId,
      name: `v4-controlled-page-${input.pageNumber}.png`,
      mimeType: 'image/png',
      bytes,
      idempotencyKey: `${input.idempotencyKey}:controlled-raster:v1`,
    })
    return { ...artifact, width: CONTROLLED_RASTER_WIDTH, height: CONTROLLED_RASTER_HEIGHT }
  }
}

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

function visibleLine(value: string, limit = 34) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}...`
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
  return [
    `<text x="800" y="310" text-anchor="middle" font-size="42" font-family="sans-serif" fill="#334155">${diagram.count}个${escapeXml(diagram.itemLabel)}</text>`,
    circleGrid({ count: diagram.count, startX: 310, startY: 420, availableWidth: 980, color: '#F97316' }),
  ].join('')
}

function partitionDiagram(diagram: Extract<ExactDiagramSpec, { kind: 'PARTITION' }>) {
  const groupWidth = Math.min(390, Math.floor(1100 / diagram.groupCount))
  const totalWidth = groupWidth * diagram.groupCount
  const firstLeft = 800 - totalWidth / 2
  const boxes = Array.from({ length: diagram.groupCount }, (_, index) => {
    const left = firstLeft + index * groupWidth
    const color = index % 2 === 0 ? '#0EA5E9' : '#8B5CF6'
    return [
      `<rect x="${left + 12}" y="335" width="${groupWidth - 24}" height="430" rx="30" fill="#ffffff" stroke="${color}" stroke-width="5"/>`,
      `<text x="${left + groupWidth / 2}" y="395" text-anchor="middle" font-size="30" font-family="sans-serif" fill="#334155">第${index + 1}组</text>`,
      circleGrid({
        count: diagram.itemsPerGroup,
        startX: left + 54,
        startY: 490,
        availableWidth: groupWidth - 108,
        color,
        maximumPerRow: Math.min(4, diagram.itemsPerGroup),
        radius: 28,
      }),
    ].join('')
  }).join('')
  return [
    `<text x="800" y="290" text-anchor="middle" font-size="38" font-family="sans-serif" fill="#334155">${diagram.total}个${escapeXml(diagram.itemLabel)}平均分成${diagram.groupCount}组，每组${diagram.itemsPerGroup}个</text>`,
    boxes,
  ].join('')
}

function comparisonDiagram(diagram: Extract<ExactDiagramSpec, { kind: 'COMPARE' }>) {
  const leftColor = diagram.direction === 'LEFT_GREATER' ? '#F97316' : '#38BDF8'
  const rightColor = diagram.direction === 'RIGHT_GREATER' ? '#F97316' : '#38BDF8'
  const panel = (input: Readonly<{ left: number; label: string; count: number; color: string }>) => [
    `<rect x="${input.left}" y="315" width="525" height="450" rx="34" fill="#ffffff" stroke="${input.color}" stroke-width="5"/>`,
    `<text x="${input.left + 262}" y="385" text-anchor="middle" font-size="38" font-family="sans-serif" fill="#334155">${escapeXml(input.label)} ${input.count}个</text>`,
    circleGrid({ count: input.count, startX: input.left + 75, startY: 485, availableWidth: 375, color: input.color, radius: 27 }),
  ].join('')
  return [
    panel({ left: 135, label: diagram.left.label, count: diagram.left.count, color: leftColor }),
    panel({ left: 940, label: diagram.right.label, count: diagram.right.count, color: rightColor }),
    `<path d="M710 540 L890 540" stroke="#475569" stroke-width="9" stroke-linecap="round"/>`,
    `<path d="M890 540 L850 510 M890 540 L850 570" stroke="#475569" stroke-width="9" stroke-linecap="round" fill="none"/>`,
    `<text x="800" y="605" text-anchor="middle" font-size="34" font-family="sans-serif" fill="#334155">相差${diagram.difference}个${escapeXml(diagram.itemLabel)}</text>`,
  ].join('')
}

function diagramSvg(diagram: ExactDiagramSpec) {
  if (diagram.kind === 'EXACT_COUNT') return exactCountDiagram(diagram)
  if (diagram.kind === 'PARTITION') return partitionDiagram(diagram)
  return comparisonDiagram(diagram)
}

function rasterSvg(input: Parameters<ControlledRasterPort['render']>[0]) {
  const copy = input.visibleCopy.slice(0, 3).map((line, index) =>
    `<text x="800" y="${172 + index * 42}" text-anchor="middle" font-size="29" font-family="sans-serif" fill="#475569">${escapeXml(visibleLine(line))}</text>`).join('')
  return `<svg width="${CONTROLLED_RASTER_WIDTH}" height="${CONTROLLED_RASTER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#F8FAFC"/>
    <rect x="68" y="58" width="1464" height="784" rx="42" fill="#EAF3FF"/>
    <rect x="84" y="74" width="1432" height="752" rx="34" fill="#FDFEFF"/>
    <rect x="84" y="74" width="16" height="752" rx="8" fill="#2563EB"/>
    <text x="800" y="122" text-anchor="middle" font-size="54" font-weight="700" font-family="sans-serif" fill="#172554">${escapeXml(visibleLine(input.title, 28))}</text>
    ${copy}
    ${diagramSvg(input.diagram)}
    <text x="800" y="805" text-anchor="middle" font-size="24" font-family="sans-serif" fill="#64748B">精确关系图示</text>
  </svg>`
}

export class SharpControlledRasterPort implements ControlledRasterPort {
  constructor(private readonly dependencies: Readonly<{ artifacts: ArtifactPort }>) {}

  async render(input: Parameters<ControlledRasterPort['render']>[0]) {
    const bytes = new Uint8Array(await sharp(Buffer.from(rasterSvg(input))).png({ compressionLevel: 8 }).toBuffer())
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

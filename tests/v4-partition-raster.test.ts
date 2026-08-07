import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import {
  CONTROLLED_RASTER_HEIGHT,
  CONTROLLED_RASTER_WIDTH,
  controlledRasterSvg,
} from '../src/adapters/v4-controlled-raster'

type PartitionSpec = Readonly<{
  total: number
  groupCount: number
  itemsPerGroup: number
}>

function partitionSvg(spec: PartitionSpec) {
  return controlledRasterSvg({
    tenantId: 'frameflow', runId: 'partition-raster', pageNumber: 1,
    title: '平均分', visibleCopy: ['每组数量相同。'],
    diagram: { kind: 'PARTITION', itemLabel: '圆片', ...spec },
    idempotencyKey: `partition-raster:${spec.groupCount}x${spec.itemsPerGroup}`,
  })
}

function partitionBoxes(svg: string) {
  return [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="[\d.]+" fill="#ffffff" stroke="(#[A-F0-9]+)"/g)]
    .map((match) => ({ left: Number(match[1]), top: Number(match[2]), width: Number(match[3]), height: Number(match[4]), color: match[5]! }))
}

function objects(svg: string) {
  return [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="(#[A-F0-9]+)"/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), radius: Number(match[3]), color: match[4]! }))
}

describe('V4 partition controlled raster', () => {
  test('keeps 20 by 1 and 1 by 20 partition objects inside their groups after rasterization', async () => {
    const cases: readonly PartitionSpec[] = [
      { total: 20, groupCount: 20, itemsPerGroup: 1 },
      { total: 20, groupCount: 1, itemsPerGroup: 20 },
    ]

    for (const spec of cases) {
      const svg = partitionSvg(spec)
      const boxes = partitionBoxes(svg)
      const circles = objects(svg)
      expect(boxes).toHaveLength(spec.groupCount)
      expect(circles).toHaveLength(spec.total)
      for (const circle of circles) {
        expect(boxes.some((box) => box.color === circle.color
          && circle.x - circle.radius >= box.left - 0.001
          && circle.x + circle.radius <= box.left + box.width + 0.001
          && circle.y - circle.radius >= box.top - 0.001
          && circle.y + circle.radius <= box.top + box.height + 0.001)).toBe(true)
      }

      const png = await sharp(Buffer.from(svg)).png().toBuffer()
      expect(await sharp(png).metadata()).toMatchObject({
        format: 'png', width: CONTROLLED_RASTER_WIDTH, height: CONTROLLED_RASTER_HEIGHT,
      })
    }
  })
})

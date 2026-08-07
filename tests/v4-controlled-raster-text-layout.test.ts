import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import {
  assertControlledRasterSvgTextWhitelist,
  controlledRasterSvg,
} from '../src/adapters/v4-controlled-raster'

const input = {
  tenantId: 'frameflow',
  runId: 'run-controlled-raster-layout',
  pageNumber: 1,
  diagram: { kind: 'EXACT_COUNT' as const, itemLabel: '苹果', count: 5 },
  idempotencyKey: 'controlled-raster-layout',
}

function svgText(svg: string) {
  return [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((match) => match[1]!.replace(/<[^>]*>/g, ''))
}

function colorDistance(data: Buffer, offset: number, color: readonly [number, number, number]) {
  return Math.abs(data[offset]! - color[0])
    + Math.abs(data[offset + 1]! - color[1])
    + Math.abs(data[offset + 2]! - color[2])
}

describe('V4 controlled raster text layout', () => {
  test('renders every compact title and locked-copy entry without truncation', () => {
    const title = '五个苹果的数量关系'
    const visibleCopy = ['第一条文案', '第二条文案', '第三条文案', '第四条文案', 'fifth copy']
    const text = svgText(controlledRasterSvg({ ...input, title, visibleCopy }))

    expect(text).toEqual([title, ...visibleCopy])
  })

  test('renders all eight compact locked-copy entries without dropping later lines', () => {
    const visibleCopy = Array.from({ length: 8 }, (_, index) => `第${index + 1}条已批准文案`)
    const text = svgText(controlledRasterSvg({ ...input, title: '五个苹果的数量关系', visibleCopy }))

    expect(text).toEqual(['五个苹果的数量关系', ...visibleCopy])
  })

  test('wraps only for layout while keeping each approved visible string atomic', () => {
    const copy = '一二三四五六七八九十'.repeat(6)
    const title = '数量关系'
    const svg = controlledRasterSvg({ ...input, title, visibleCopy: [copy] })
    const text = svgText(svg)

    expect(text).toEqual([title, copy])
    expect(svg.match(/<tspan\b/g)).toHaveLength(3)
    expect(() => assertControlledRasterSvgTextWhitelist(svg, new Set([title, copy]))).not.toThrow()
  })

  test('preserves approved internal whitespace instead of silently rewriting it', () => {
    const title = '两个  空格'
    const copy = '保留  原始间距'
    const svg = controlledRasterSvg({ ...input, title, visibleCopy: [copy] })

    expect(svgText(svg)).toEqual([title, copy])
    expect(() => assertControlledRasterSvgTextWhitelist(svg, new Set([title, copy]))).not.toThrow()
    expect(() => assertControlledRasterSvgTextWhitelist(svg, new Set(['两个 空格', '保留 原始间距']))).toThrow(
      'CONTROLLED_RASTER_VISIBLE_TEXT_NOT_ALLOWED',
    )
  })

  test('keeps the largest supported multiline text above the diagram in rendered pixels', async () => {
    const svg = controlledRasterSvg({
      ...input,
      title: 'W'.repeat(100),
      visibleCopy: ['W'.repeat(400)],
    })
    const rendered = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let left = rendered.info.width
    let right = -1
    let top = rendered.info.height
    let bottom = -1
    const textColors: readonly (readonly [number, number, number])[] = [[23, 37, 84], [71, 85, 105]]

    for (let y = 0; y < rendered.info.height; y += 1) {
      for (let x = 0; x < rendered.info.width; x += 1) {
        const offset = (y * rendered.info.width + x) * rendered.info.channels
        if (textColors.some((color) => colorDistance(rendered.data, offset, color) <= 12)) {
          left = Math.min(left, x)
          right = Math.max(right, x)
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
        }
      }
    }

    expect([left, right, top, bottom]).not.toContain(-1)
    expect(left).toBeGreaterThanOrEqual(120)
    expect(right).toBeLessThanOrEqual(1_480)
    expect(top).toBeGreaterThanOrEqual(90)
    expect(bottom).toBeLessThan(480)
  })

  test('fails closed instead of truncating visible copy that cannot fit the controlled raster', () => {
    expect(() => controlledRasterSvg({
      ...input,
      title: '数量关系',
      visibleCopy: ['一二三四五六七八九十'.repeat(50)],
    })).toThrow('CONTROLLED_RASTER_VISIBLE_TEXT_TOO_LARGE')
  })

  test('fails closed instead of truncating a title that cannot fit the controlled raster', () => {
    expect(() => controlledRasterSvg({
      ...input,
      title: '一二三四五六七八九十'.repeat(17),
      visibleCopy: ['数量关系'],
    })).toThrow('CONTROLLED_RASTER_VISIBLE_TEXT_TOO_LARGE')
  })
})

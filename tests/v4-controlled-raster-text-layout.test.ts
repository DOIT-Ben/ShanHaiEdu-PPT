import { describe, expect, test } from 'bun:test'
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

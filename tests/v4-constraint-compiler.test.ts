import { describe, expect, test } from 'bun:test'
import { ConstraintCompiler } from '../src/core/v4-constraint-compiler'

function compile(input: Readonly<{
  title?: string
  lockedCopy?: readonly string[]
  facts?: readonly string[]
}>) {
  return new ConstraintCompiler().compile({
    title: input.title ?? '数量关系',
    lockedCopy: input.lockedCopy ?? [],
  })
}

describe('V4 constraint compiler', () => {
  test('compiles one unambiguous exact count from visible copy', () => {
    expect(compile({ lockedCopy: ['桌上有5个苹果。'] })).toEqual({
      kind: 'EXACT_COUNT',
      itemLabel: '苹果',
      count: 5,
    })
  })

  test('compiles a complete Chinese-numeral equal partition only when the arithmetic closes', () => {
    expect(compile({ lockedCopy: ['把八个圆片平均分成两组，每组四个。'] })).toEqual({
      kind: 'PARTITION',
      itemLabel: '圆片',
      total: 8,
      groupCount: 2,
      itemsPerGroup: 4,
    })
    expect(compile({ lockedCopy: ['把8个圆片平均分成2组，每组3个。'] })).toBeNull()
  })

  test('compiles an explicit comparison with validated counts and direction', () => {
    expect(compile({ lockedCopy: ['甲组有5个苹果，乙组有3个苹果，甲组比乙组多2个苹果。'] })).toEqual({
      kind: 'COMPARE',
      itemLabel: '苹果',
      left: { label: '甲组', count: 5 },
      right: { label: '乙组', count: 3 },
      direction: 'LEFT_GREATER',
      difference: 2,
    })
  })

  test('falls back when the content has multiple unsupported count claims or exceeds the readable item limit', () => {
    expect(compile({ lockedCopy: ['这里有5个苹果和3个梨。'] })).toBeNull()
    expect(compile({ facts: ['桌上有5个苹果。'] })).toBeNull()
    expect(compile({ lockedCopy: ['这里有许多苹果。'] })).toBeNull()
  })
})

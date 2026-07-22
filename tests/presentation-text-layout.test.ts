import { describe, expect, test } from 'bun:test'
import { layoutPresentationText } from '../src/presentation-text-layout'

describe('presentation text layout', () => {
  test('wraps mixed Chinese and Latin text deterministically', () => {
    const result = layoutPresentationText({
      text: '地球围绕 Sun 公转，形成一年中的季节变化。',
      fontSize: 20,
      width: 0.24,
      height: 0.22,
    })

    expect(result.fits).toBe(true)
    expect(result.lines.length).toBeGreaterThan(1)
    expect(result.lines.join('')).toBe('地球围绕 Sun 公转，形成一年中的季节变化。')
  })

  test('reports overflow instead of silently dropping lines', () => {
    const result = layoutPresentationText({
      text: '这是一段不允许通过缩小字体或截断来掩盖的超长课堂正文。'.repeat(20),
      fontSize: 22,
      width: 0.18,
      height: 0.08,
    })

    expect(result.fits).toBe(false)
    expect(result.lines.join('')).not.toBe(result.textWithoutNewlines)
  })
})

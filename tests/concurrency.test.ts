import { describe, expect, test } from 'bun:test'
import { mapWithConcurrency } from '../src/core/concurrency'

describe('bounded concurrency', () => {
  test('preserves result order while limiting active operations', async () => {
    let active = 0
    let maximumActive = 0
    const result = await mapWithConcurrency([30, 5, 20, 10], 2, async (delay, index) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, delay))
      active -= 1
      return `result-${index}`
    })

    expect(result).toEqual(['result-0', 'result-1', 'result-2', 'result-3'])
    expect(maximumActive).toBe(2)
  })

  test('stops starting queued work after the first failure', async () => {
    const started: number[] = []
    await expect(mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      started.push(value)
      if (value === 1) throw new Error('injected failure')
      await new Promise((resolve) => setTimeout(resolve, 5))
      return value
    })).rejects.toThrow('injected failure')

    expect(started).toEqual([0, 1])
  })
})

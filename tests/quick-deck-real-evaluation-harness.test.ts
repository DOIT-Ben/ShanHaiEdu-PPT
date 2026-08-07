import { describe, expect, test } from 'bun:test'
import {
  QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS,
  readQuickDeckEvaluationReadyRelease,
  resolveQuickDeckEvaluationCanaryPageCounts,
  runQuickDeckEvaluationCanary,
  type QuickDeckEvaluationRelease,
} from '../scripts/run-quick-deck-real-evaluation'

const release: QuickDeckEvaluationRelease = {
  softwareVersion: '4.4.0',
  gitSha: 'a'.repeat(40),
  releaseId: 'v4.4.0-aaaaaaaaaaaa',
}

describe('Quick-deck real evaluation harness', () => {
  test('only accepts the fixed 1 -> 3 -> 10 canary sequence', () => {
    expect(resolveQuickDeckEvaluationCanaryPageCounts(undefined)).toEqual([1, 3, 10])
    expect(resolveQuickDeckEvaluationCanaryPageCounts('1,3,10')).toEqual([1, 3, 10])
    expect(() => resolveQuickDeckEvaluationCanaryPageCounts('3,10')).toThrow('QUICK_DECK_EVAL_PAGE_COUNTS_INVALID')
    expect(() => resolveQuickDeckEvaluationCanaryPageCounts('1,10,3')).toThrow('QUICK_DECK_EVAL_PAGE_COUNTS_INVALID')
  })

  test('records only the service readiness release before any evaluator submission', async () => {
    const calls: Array<Readonly<{ url: string; authorization: string | null }>> = []
    const observed = await readQuickDeckEvaluationReadyRelease({
      serviceUrl: 'http://127.0.0.1:4311',
      timeoutMs: 1_000,
      fetch: async (url, init) => {
        calls.push({ url, authorization: new Headers(init?.headers).get('Authorization') })
        return new Response(JSON.stringify({ status: 'READY', release }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    expect(observed).toEqual(release)
    expect(calls).toEqual([{ url: 'http://127.0.0.1:4311/health/ready', authorization: null }])
  })

  test('does not submit a canary when readiness does not prove a released service identity', async () => {
    let submissions = 0
    await expect(runQuickDeckEvaluationCanary({
      preflight: () => readQuickDeckEvaluationReadyRelease({
        serviceUrl: 'http://127.0.0.1:4311',
        timeoutMs: 1_000,
        fetch: async () => new Response(JSON.stringify({ status: 'NOT_READY', release }), { status: 503 }),
      }),
      runCase: async (slideCount) => {
        submissions += 1
        return { passed: true, slideCount }
      },
    })).rejects.toThrow('QUICK_DECK_EVAL_READY_HTTP_503')
    expect(submissions).toBe(0)
  })

  test('runs the canary in order and stops after the first failed case', async () => {
    const attempted: number[] = []
    const result = await runQuickDeckEvaluationCanary({
      preflight: async () => release,
      runCase: async (slideCount) => {
        attempted.push(slideCount)
        if (slideCount === 1) throw new Error('QUICK_DECK_CANARY_FAILED')
        return { passed: true, slideCount }
      },
    })

    expect(attempted).toEqual([1])
    expect(result).toEqual({
      release,
      passed: false,
      results: [{ passed: false, slideCount: 1, errorCode: 'QUICK_DECK_CANARY_FAILED' }],
    })
  })

  test('does not submit a later canary after a case returns a failed result', async () => {
    const attempted: number[] = []
    const result = await runQuickDeckEvaluationCanary({
      preflight: async () => release,
      runCase: async (slideCount) => {
        attempted.push(slideCount)
        return { passed: false, slideCount, errorCode: 'EVALUATION_IMAGE_ASPECT_RATIO_INVALID' }
      },
    })

    expect(attempted).toEqual([1])
    expect(result.passed).toBe(false)
    expect(result.results).toEqual([
      { passed: false, slideCount: 1, errorCode: 'EVALUATION_IMAGE_ASPECT_RATIO_INVALID' },
    ])
  })

  test('runs all three cases only after the release preflight succeeds', async () => {
    const order: Array<string | number> = []
    const result = await runQuickDeckEvaluationCanary({
      preflight: async () => {
        order.push('ready')
        return release
      },
      runCase: async (slideCount) => {
        order.push(slideCount)
        return { passed: true, slideCount }
      },
    })

    expect(order).toEqual(['ready', ...QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS])
    expect(result.passed).toBe(true)
    expect(result.results.map((item) => item.slideCount)).toEqual([1, 3, 10])
  })
})

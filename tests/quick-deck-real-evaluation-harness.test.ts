import { describe, expect, test } from 'bun:test'
import {
  QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS,
  readQuickDeckEvaluationReadyRelease,
  resolveQuickDeckEvaluationCanaryPageCounts,
  runQuickDeckEvaluationCanary,
  validateCompletedQuickDeckJob,
  type QuickDeckEvaluationRelease,
} from '../scripts/run-quick-deck-real-evaluation'
import { quickDeckEvaluationPublicJobSchema } from '../src/quick-deck-evaluation-contracts'

const release: QuickDeckEvaluationRelease = {
  softwareVersion: '4.4.0',
  gitSha: 'a'.repeat(40),
  releaseId: 'v4.4.0-aaaaaaaaaaaa',
}

function failedEvaluationJob() {
  return quickDeckEvaluationPublicJobSchema.parse({
    schemaVersion: '1',
    jobId: 'quick-deck-evaluation-failed-case',
    status: 'FAILED',
    phase: 'FAILED',
    slideCount: 1,
    aspectRatio: '16:9',
    models: { text: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
    progress: { planned: true, submittedPages: 1, completedPages: 0, totalPages: 1 },
    pages: [{
      pageNumber: 1,
      status: 'FAILED',
      submissionState: 'SUBMITTED',
      billingState: 'UNKNOWN',
      errorCode: 'EVALUATION_IMAGE_RATIO_INVALID',
      width: 1376,
      height: 768,
      aspectRatioValidated: false,
      aspect: {
        observedWidth: 1376,
        observedHeight: 768,
        relativeError: 0.0078125,
        normalization: 'REJECTED',
        normalizedWidth: null,
        normalizedHeight: null,
      },
      sha256: null,
    }],
    artifacts: { pptx: null, preview: null },
    quality: { state: 'NOT_ASSESSED', score: null, rubric: null },
    failure: { code: 'EVALUATION_IMAGE_RATIO_INVALID' },
    createdAt: '2026-08-08T00:00:00.000Z',
    startedAt: '2026-08-08T00:00:01.000Z',
    completedAt: '2026-08-08T00:00:02.000Z',
    expiresAt: '2026-08-09T00:00:00.000Z',
    durationMs: 1_000,
  })
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

  test('preserves the service failure code when a real quick-deck job reaches a failed terminal state', () => {
    expect(() => validateCompletedQuickDeckJob(failedEvaluationJob(), {
      textModel: 'gpt-5.6-terra',
      imageModel: 'gemini-3-pro-image-preview',
    }, 1)).toThrow('EVALUATION_IMAGE_RATIO_INVALID')
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

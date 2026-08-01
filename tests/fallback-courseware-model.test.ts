import { describe, expect, test } from 'bun:test'
import { FallbackCoursewareModel, type CoursewareModelPorts } from '../src/adapters/fallback-courseware-model'
import { StructuredModelError } from '../src/core/ports'

type Method = 'execute' | 'reviewCandidate' | 'review' | 'evaluate' | 'plan' | 'apply'

function model(
  modelName: string,
  invoke: (method: Method, input: unknown) => Promise<unknown>,
): CoursewareModelPorts {
  return {
    modelName,
    execute: (input) => invoke('execute', input),
    reviewCandidate: (input) => invoke('reviewCandidate', input),
    review: (input) => invoke('review', input),
    evaluate: (input) => invoke('evaluate', input),
    plan: (input) => invoke('plan', input),
    apply: (input) => invoke('apply', input),
  }
}

describe('fallback courseware model', () => {
  test('returns a successful primary response without invoking the fallback', async () => {
    let fallbackCalls = 0
    const port = new FallbackCoursewareModel({
      primary: model('primary', async () => ({ source: 'primary' })),
      fallback: model('MiniMax-M3', async () => { fallbackCalls += 1; return { source: 'fallback' } }),
    })

    await expect(port.execute({
      operation: 'create_blueprint', schemaName: 'schema', payload: {}, idempotencyKey: 'stable-key',
    })).resolves.toEqual({ source: 'primary' })
    expect(port.modelName).toBe('primary')
    expect(fallbackCalls).toBe(0)
  })

  test('passes the same input and idempotency key to the fallback for all six ports', async () => {
    const primaryInputs: Array<{ method: Method; input: unknown }> = []
    const fallbackInputs: Array<{ method: Method; input: unknown }> = []
    const port = new FallbackCoursewareModel({
      primary: model('primary', async (method, input) => {
        primaryInputs.push({ method, input })
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'primary', 'primary-request')
      }),
      fallback: model('MiniMax-M3', async (method, input) => {
        fallbackInputs.push({ method, input })
        return { method }
      }),
    })
    const calls = [
      ['execute', { idempotencyKey: 'key-execute' }],
      ['reviewCandidate', { idempotencyKey: 'key-candidate' }],
      ['review', { idempotencyKey: 'key-review' }],
      ['evaluate', { idempotencyKey: 'key-evaluate' }],
      ['plan', { idempotencyKey: 'key-plan' }],
      ['apply', { idempotencyKey: 'key-apply' }],
    ] as const

    for (const [method, input] of calls) {
      await expect((port[method] as (value: never) => Promise<unknown>)(input as never)).resolves.toEqual({ method })
    }
    expect(fallbackInputs).toHaveLength(calls.length)
    for (let index = 0; index < calls.length; index += 1) {
      expect(primaryInputs[index]?.method).toBe(calls[index]![0])
      expect(fallbackInputs[index]?.method).toBe(calls[index]![0])
      expect(fallbackInputs[index]?.input).toBe(primaryInputs[index]?.input)
      expect((fallbackInputs[index]?.input as { idempotencyKey: string }).idempotencyKey).toBe(calls[index]![1].idempotencyKey)
    }
  })

  test('does not fallback for model contract failures', async () => {
    let fallbackCalls = 0
    const original = new StructuredModelError('MODEL_JSON_INVALID', true, 'primary', 'primary-json')
    const port = new FallbackCoursewareModel({
      primary: model('primary', async () => { throw original }),
      fallback: model('MiniMax-M3', async () => { fallbackCalls += 1; return {} }),
    })

    await expect(port.execute({
      operation: 'create_blueprint', schemaName: 'schema', payload: {}, idempotencyKey: 'stable-key',
    })).rejects.toBe(original)
    expect(fallbackCalls).toBe(0)
  })

  test('preserves the fallback model and request id when MiniMax fails', async () => {
    const fallbackError = new StructuredModelError('PROVIDER_TIMEOUT', true, 'MiniMax-M3', 'minimax-request-1')
    const port = new FallbackCoursewareModel({
      primary: model('primary', async () => {
        throw new StructuredModelError('PROVIDER_RATE_LIMIT', true, 'primary', 'primary-request')
      }),
      fallback: model('MiniMax-M3', async () => { throw fallbackError }),
    })

    await expect(port.execute({
      operation: 'create_blueprint', schemaName: 'schema', payload: {}, idempotencyKey: 'stable-key',
    })).rejects.toBe(fallbackError)
  })
})

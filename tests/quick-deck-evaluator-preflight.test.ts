import { describe, expect, test } from 'bun:test'
import {
  assertQuickDeckEvaluatorModelsAvailable,
  QuickDeckEvaluatorModelEligibility,
  type QuickDeckEvaluatorDirectoryProbe,
} from '../src/runtime/quick-deck-evaluator-preflight'
import type { V4ModelPolicy } from '../src/core/v4-model-policy'

function probe(models: readonly string[] | Error): QuickDeckEvaluatorDirectoryProbe {
  return {
    async listModels() {
      if (models instanceof Error) throw models
      return models
    },
  }
}

describe('quick-deck evaluator gateway preflight', () => {
  test('accepts only models visible to the independent evaluator text and image directories', async () => {
    await expect(assertQuickDeckEvaluatorModelsAvailable({
      textModel: 'gpt-5.6-terra',
      allowedImageModels: ['gemini-3-pro-image-preview', 'gpt-image-2'],
      textProbe: probe(['gpt-5.6-terra']),
      imageProbe: probe(['gemini-3-pro-image-preview', 'gpt-image-2']),
    })).resolves.toBeUndefined()
  })

  test('fails closed when an evaluator directory is unavailable or lacks a selected model', async () => {
    await expect(assertQuickDeckEvaluatorModelsAvailable({
      textModel: 'gpt-5.6-terra',
      allowedImageModels: ['gemini-3-pro-image-preview'],
      textProbe: probe(['gpt-5.6-terra']),
      imageProbe: probe([]),
    })).rejects.toThrow('PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODEL_UNAVAILABLE')

    await expect(assertQuickDeckEvaluatorModelsAvailable({
      textModel: 'gpt-5.6-terra',
      allowedImageModels: ['gemini-3-pro-image-preview'],
      textProbe: probe(new Error('upstream private diagnostic')),
      imageProbe: probe(['gemini-3-pro-image-preview']),
    })).rejects.toThrow('PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_MODEL_DIRECTORY_UNAVAILABLE')
  })

  test('rechecks V4 readiness before querying evaluator directories', async () => {
    let directoryCalls = 0
    const eligibility = new QuickDeckEvaluatorModelEligibility({
      v4ModelPolicy: {
        allowsQuickDeckModels() { return false },
      } satisfies Pick<V4ModelPolicy, 'allowsQuickDeckModels'>,
      textProbe: { async listModels() { directoryCalls += 1; return ['gpt-5.6-terra'] } },
      imageProbe: { async listModels() { directoryCalls += 1; return ['gemini-3-pro-image-preview'] } },
    })

    await expect(eligibility.check({
      textModel: 'gpt-5.6-terra', imageModels: ['gemini-3-pro-image-preview'],
    })).resolves.toBe('NOT_READY')
    expect(directoryCalls).toBe(0)
  })

  test('reuses evaluator directory results only until its TTL elapses', async () => {
    let now = new Date('2026-08-07T00:00:00.000Z')
    let imageModels = ['gemini-3-pro-image-preview']
    let textCalls = 0
    let imageCalls = 0
    const eligibility = new QuickDeckEvaluatorModelEligibility({
      v4ModelPolicy: {
        allowsQuickDeckModels() { return true },
      } satisfies Pick<V4ModelPolicy, 'allowsQuickDeckModels'>,
      textProbe: { async listModels() { textCalls += 1; return ['gpt-5.6-terra'] } },
      imageProbe: { async listModels() { imageCalls += 1; return imageModels } },
      directoryTtlMs: 1_000,
      now: () => now,
    })
    const selection = { textModel: 'gpt-5.6-terra', imageModels: ['gemini-3-pro-image-preview'] }

    await expect(eligibility.check(selection)).resolves.toBe('READY')
    imageModels = []
    now = new Date('2026-08-07T00:00:00.999Z')
    await expect(eligibility.check(selection)).resolves.toBe('READY')
    expect({ textCalls, imageCalls }).toEqual({ textCalls: 1, imageCalls: 1 })

    now = new Date('2026-08-07T00:00:01.000Z')
    await expect(eligibility.check(selection)).resolves.toBe('UNAVAILABLE')
    expect({ textCalls, imageCalls }).toEqual({ textCalls: 2, imageCalls: 2 })
  })
})

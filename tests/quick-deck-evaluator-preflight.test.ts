import { describe, expect, test } from 'bun:test'
import {
  assertQuickDeckEvaluatorModelsAvailable,
  type QuickDeckEvaluatorDirectoryProbe,
} from '../src/runtime/quick-deck-evaluator-preflight'

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
})

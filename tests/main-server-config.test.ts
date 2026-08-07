import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  resolveGatewayCoursewareModelsConfig,
  resolveMainServerConfig,
  resolvePublicV4CapabilitiesConfig,
  resolveQuickDeckEvaluationConfig,
  resolveV4RevisionImageModel,
} from '../src/runtime/main-server-config'

describe('main PPT Agent server configuration', () => {
  test('allows a V1-only process without a V2 credential', () => {
    const v1Only = resolveMainServerConfig({
      PPT_AGENT_API_TOKEN: 'v1-server-token-0001',
      PPT_AGENT_RUNTIME_MODE: 'mock',
    })
    expect(v1Only).toMatchObject({
      hostname: '127.0.0.1',
      port: 4310,
      apiToken: 'v1-server-token-0001',
    })
    expect(v1Only.presentationJobV2ApiToken).toBeUndefined()
    expect(resolveMainServerConfig({
      PPT_AGENT_API_TOKEN: 'v1-server-token-0001',
      PPT_AGENT_V2_API_TOKEN: 'v2-server-token-0001',
    }).presentationJobV2ApiToken).toBe('v2-server-token-0001')
    expect(resolveMainServerConfig({
      PPT_AGENT_API_TOKEN: 'v1-server-token-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN: 'quick-deck-evaluation-token-0001',
    }).quickDeckEvaluationApiToken).toBe('quick-deck-evaluation-token-0001')
  })

  test('requires an isolated evaluator root and limits quick decks to published V4 models', () => {
    const config = resolveQuickDeckEvaluationConfig({
      PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN: 'quick-deck-evaluation-token-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT: '/opt/ppt-agent/shared/data/quick-deck-evaluations',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_TEXT_KEY: 'evaluation-text-key-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_IMAGE_KEY: 'evaluation-image-key-0001',
      MODEL_GATEWAY_TEXT_KEY: 'formal-text-key-0001',
      MODEL_GATEWAY_IMAGE_KEY: 'formal-image-key-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_MODEL: 'gpt-5.6-terra',
      PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODELS: 'gemini-3-pro-image-preview,gpt-image-2',
      PPT_AGENT_QUICK_DECK_EVALUATION_MAX_ACTIVE_JOBS: '3',
      PPT_AGENT_QUICK_DECK_EVALUATION_MAX_DAILY_JOBS: '12',
      PPT_AGENT_QUICK_DECK_EVALUATION_TTL_HOURS: '48',
      PPT_AGENT_QUICK_DECK_EVALUATION_TICK_BATCH_SIZE: '7',
    }, {
      textModels: ['gpt-5.6-terra', 'MiniMax-M3'],
      imageModels: ['gemini-3-pro-image-preview', 'gpt-image-2'],
    })
    expect(config).toEqual({
      apiToken: 'quick-deck-evaluation-token-0001',
      dataRoot: '/opt/ppt-agent/shared/data/quick-deck-evaluations',
      gatewayTextKey: 'evaluation-text-key-0001',
      gatewayImageKey: 'evaluation-image-key-0001',
      textModel: 'gpt-5.6-terra',
      allowedImageModels: ['gemini-3-pro-image-preview', 'gpt-image-2'],
      maxActiveJobs: 3,
      maxDailyJobs: 12,
      ttlMs: 48 * 60 * 60_000,
      tickBatchSize: 7,
    })
    expect(() => resolveQuickDeckEvaluationConfig({
      PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN: 'quick-deck-evaluation-token-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT: '/opt/ppt-agent/shared/data/quick-deck-evaluations',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_TEXT_KEY: 'evaluation-text-key-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_IMAGE_KEY: 'evaluation-image-key-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODELS: 'unpublished-image-model',
    }, {
      textModels: ['gpt-5.6-terra'], imageModels: ['gemini-3-pro-image-preview'],
    })).toThrow('PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODEL_NOT_ALLOWED')
    expect(() => resolveQuickDeckEvaluationConfig({
      PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN: 'quick-deck-evaluation-token-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT: '/opt/ppt-agent/shared/data/quick-deck-evaluations',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_TEXT_KEY: 'evaluation-text-key-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_IMAGE_KEY: 'evaluation-image-key-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_TTL_HOURS: '0',
    }, {
      textModels: ['gpt-5.6-terra'], imageModels: ['gemini-3-pro-image-preview'],
    })).toThrow('PPT_AGENT_QUICK_DECK_EVALUATION_TTL_HOURS_INVALID')
    expect(() => resolveQuickDeckEvaluationConfig({
      PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN: 'quick-deck-evaluation-token-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT: '/opt/ppt-agent/shared/data/quick-deck-evaluations',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_TEXT_KEY: 'shared-text-key-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_IMAGE_KEY: 'evaluation-image-key-0001',
      MODEL_GATEWAY_TEXT_KEY: 'shared-text-key-0001',
      MODEL_GATEWAY_IMAGE_KEY: 'formal-image-key-0001',
    }, {
      textModels: ['gpt-5.6-terra'], imageModels: ['gemini-3-pro-image-preview'],
    })).toThrow('PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_KEY_NOT_ISOLATED')
    expect(() => resolveQuickDeckEvaluationConfig({
      PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN: 'quick-deck-evaluation-token-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT: '/opt/ppt-agent/shared/data/quick-deck-evaluations',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_TEXT_KEY: 'formal-image-key-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_IMAGE_KEY: 'evaluation-image-key-0001',
      MODEL_GATEWAY_TEXT_KEY: 'formal-text-key-0001',
      MODEL_GATEWAY_IMAGE_KEY: 'formal-image-key-0001',
    }, {
      textModels: ['gpt-5.6-terra'], imageModels: ['gemini-3-pro-image-preview'],
    })).toThrow('PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_KEY_NOT_ISOLATED')
    expect(() => resolveQuickDeckEvaluationConfig({
      PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN: 'quick-deck-evaluation-token-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT: '/opt/ppt-agent/shared/data/quick-deck-evaluations',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_TEXT_KEY: 'evaluation-text-key-0001',
      PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_IMAGE_KEY: 'formal-text-key-0001',
      MODEL_GATEWAY_TEXT_KEY: 'formal-text-key-0001',
      MODEL_GATEWAY_IMAGE_KEY: 'formal-image-key-0001',
    }, {
      textModels: ['gpt-5.6-terra'], imageModels: ['gemini-3-pro-image-preview'],
    })).toThrow('PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_KEY_NOT_ISOLATED')
  })

  test('routes the optional MiniMax fallback through the unified model gateway', () => {
    const config = resolveGatewayCoursewareModelsConfig({
      MODEL_GATEWAY_BASE_URL: 'https://newapi.doitbenai.cloud/v1',
      MODEL_GATEWAY_TEXT_KEY: 'gateway-text-key-0001',
      PPT_AGENT_TEXT_MODEL: 'gpt-5.6-terra',
      PPT_AGENT_VISION_MODEL: 'gpt-5.6-terra',
      PPT_AGENT_FALLBACK_MODEL_ENABLED: 'true',
      PPT_AGENT_FALLBACK_TEXT_MODEL: 'MiniMax-M3',
      PPT_AGENT_FALLBACK_VISION_MODEL: 'MiniMax-M3',
      MINIMAX_BASE_URL: 'https://api.minimaxi.com/v1',
      MINIMAX_API_KEY: 'legacy-direct-key-must-be-ignored',
    })

    expect(config.primary).toEqual({
      baseUrl: 'https://newapi.doitbenai.cloud/v1',
      apiKey: 'gateway-text-key-0001',
      textModel: 'gpt-5.6-terra',
      visionModel: 'gpt-5.6-terra',
    })
    expect(config.fallback).toEqual({
      baseUrl: 'https://newapi.doitbenai.cloud/v1',
      apiKey: 'gateway-text-key-0001',
      textModel: 'MiniMax-M3',
      visionModel: 'MiniMax-M3',
      transport: 'CHAT_COMPLETIONS',
    })
    expect(JSON.stringify(config)).not.toContain('api.minimaxi.com')
    expect(JSON.stringify(config)).not.toContain('legacy-direct-key-must-be-ignored')
  })

  test('keeps the shared-gateway fallback disabled by default and validates the flag', () => {
    expect(resolveGatewayCoursewareModelsConfig({
      MODEL_GATEWAY_BASE_URL: 'https://newapi.doitbenai.cloud/v1',
      MODEL_GATEWAY_TEXT_KEY: 'gateway-text-key-0001',
    }).fallback).toBeUndefined()
    expect(() => resolveGatewayCoursewareModelsConfig({
      PPT_AGENT_FALLBACK_MODEL_ENABLED: 'sometimes',
    })).toThrow('PPT_AGENT_FALLBACK_MODEL_ENABLED_INVALID')
  })

  test('fails closed for V4 image edits until an operator explicitly enables a verified model', () => {
    expect(resolveV4RevisionImageModel({
      PPT_AGENT_V4_REVISION_IMAGE_MODEL: 'gpt-image-2',
    })).toBeNull()
    expect(resolveV4RevisionImageModel({
      PPT_AGENT_V4_IMAGE_EDIT_ENABLED: 'true',
      PPT_AGENT_V4_REVISION_IMAGE_MODEL: 'verified-image-edit-model',
    })).toBeNull()
    expect(resolveV4RevisionImageModel({
      PPT_AGENT_V4_IMAGE_EDIT_ENABLED: 'true',
      PPT_AGENT_V4_IMAGE_EDIT_ASYNC_TASK_ENABLED: 'true',
      PPT_AGENT_V4_REVISION_IMAGE_MODEL: 'verified-image-edit-model',
    })).toBe('verified-image-edit-model')
    expect(() => resolveV4RevisionImageModel({
      PPT_AGENT_V4_IMAGE_EDIT_ENABLED: 'invalid',
    })).toThrow('PPT_AGENT_V4_IMAGE_EDIT_ENABLED_INVALID')
    expect(() => resolveV4RevisionImageModel({
      PPT_AGENT_V4_IMAGE_EDIT_ENABLED: 'true',
      PPT_AGENT_V4_IMAGE_EDIT_ASYNC_TASK_ENABLED: 'true',
    })).toThrow('PPT_AGENT_V4_REVISION_IMAGE_MODEL_REQUIRED')
    expect(() => resolveV4RevisionImageModel({
      PPT_AGENT_V4_IMAGE_EDIT_ENABLED: 'true',
      PPT_AGENT_V4_IMAGE_EDIT_ASYNC_TASK_ENABLED: 'invalid',
    })).toThrow('PPT_AGENT_V4_IMAGE_EDIT_ASYNC_TASK_ENABLED_INVALID')
  })

  test('derives public model names from unified-gateway configuration without route or credential fields', () => {
    const env = {
      MODEL_GATEWAY_BASE_URL: 'https://newapi.doitbenai.cloud/v1',
      MODEL_GATEWAY_TEXT_KEY: 'gateway-text-key-0001',
      PPT_AGENT_TEXT_MODEL: 'gpt-5.6-terra',
      PPT_AGENT_VISION_MODEL: 'deepseek-v3.2',
      PPT_AGENT_FALLBACK_MODEL_ENABLED: 'true',
      PPT_AGENT_FALLBACK_TEXT_MODEL: 'MiniMax-M3',
      PPT_AGENT_FALLBACK_VISION_MODEL: 'MiniMax-M3',
      PPT_AGENT_V4_INITIAL_IMAGE_MODELS: 'gemini-3-pro-image-preview, gpt-image-2',
    }
    const capabilities = resolvePublicV4CapabilitiesConfig(
      env,
      resolveGatewayCoursewareModelsConfig(env),
      'gpt-image-2',
    )

    expect(capabilities).toEqual({
      textModels: ['gpt-5.6-terra'],
      visionModels: ['deepseek-v3.2'],
      imageModels: ['gemini-3-pro-image-preview', 'gpt-image-2'],
      imageEditModels: ['gpt-image-2'],
    })
    expect(JSON.stringify(capabilities)).not.toContain('newapi.doitbenai.cloud')
    expect(JSON.stringify(capabilities)).not.toContain('gateway-text-key-0001')
    expect(() => resolvePublicV4CapabilitiesConfig({
      ...env,
      PPT_AGENT_V4_INITIAL_IMAGE_MODELS: 'gemini-3-pro-image-preview,gemini-3-pro-image-preview',
    }, resolveGatewayCoursewareModelsConfig(env), 'gpt-image-2')).toThrow('PPT_AGENT_V4_INITIAL_IMAGE_MODELS_INVALID')
    expect(resolvePublicV4CapabilitiesConfig(
      env,
      resolveGatewayCoursewareModelsConfig(env),
      null,
    ).imageEditModels).toEqual([])
  })

  test('documents only unified-gateway credentials for the MiniMax fallback', () => {
    const environmentExample = readFileSync(
      new URL('../deploy/aliyun/ppt-agent.env.example', import.meta.url),
      'utf8',
    )
    expect(environmentExample).toContain('PPT_AGENT_FALLBACK_TEXT_MODEL=MiniMax-M3')
    expect(environmentExample).toContain('PPT_AGENT_FALLBACK_VISION_MODEL=MiniMax-M3')
    expect(environmentExample).toContain('PPT_AGENT_V4_IMAGE_EDIT_ENABLED=false')
    expect(environmentExample).toContain('PPT_AGENT_V4_IMAGE_EDIT_ASYNC_TASK_ENABLED=false')
    expect(environmentExample).not.toContain('MINIMAX_BASE_URL')
    expect(environmentExample).not.toContain('MINIMAX_API_KEY')
    expect(environmentExample).not.toContain('MINIMAX_TEXT_MODEL')
    expect(environmentExample).not.toContain('MINIMAX_VISION_MODEL')
    expect(environmentExample).not.toContain('api.minimaxi.com')
  })
})

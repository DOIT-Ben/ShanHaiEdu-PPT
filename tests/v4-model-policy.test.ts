import { describe, expect, test } from 'bun:test'
import type { CreateRunRequest } from '../src/contracts'
import {
  V4ModelPolicy,
  V4ModelPolicyError,
  V4LegacyModelSnapshotError,
  v4ImageEditModelOverride,
  v4ModelOverride,
  type V4ModelAvailabilityProbe,
  type V4ModelReadinessRecord,
} from '../src/core/v4-model-policy'
import {
  CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION,
  CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION,
  LEGACY_VISUAL_DECK_V4_COMPILER_VERSION,
  VISUAL_DECK_V4_COMPILER_VERSION,
} from '../src/release-identity'

const readiness: V4ModelReadinessRecord = {
  status: 'PASSED',
  evaluationRelease: '4.5.0',
  gatewayContractVersion: 'gateway-media-v1',
  structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
  evaluatedAt: '2026-08-07T00:00:00.000Z',
  evaluationSuite: 'v4-canary-1-3-10',
  expiresAt: '2026-08-08T00:00:00.000Z',
}

const request = {
  presentationMode: 'VISUAL_DECK_V4',
  imageModel: 'gemini-3-pro-image-preview',
} as CreateRunRequest

function probe(models: readonly string[]): V4ModelAvailabilityProbe {
  return { async listModels() { return models } }
}

function policy(input: Partial<ConstructorParameters<typeof V4ModelPolicy>[0]> = {}) {
  return new V4ModelPolicy({
    runtimeMode: 'GATEWAY',
    models: [
      { model: 'gpt-5.6-terra', roles: ['TEXT', 'VISION'], evaluationEnabled: true, published: true, readiness },
      { model: 'gemini-3-pro-image-preview', roles: ['IMAGE'], evaluationEnabled: true, published: true, readiness },
      { model: 'gpt-image-2', roles: ['IMAGE_EDIT'], evaluationEnabled: true, published: false, readiness },
    ],
    availabilityProbes: {
      text: probe(['gpt-5.6-terra']),
      image: probe(['gemini-3-pro-image-preview']),
    },
    availabilityTtlMs: 60_000,
    now: () => new Date('2026-08-07T01:00:00.000Z'),
    ...input,
  })
}

describe('V4 model policy', () => {
  test('allows a new V4 Run only after published readiness and directory health all pass', async () => {
    const configured = policy()

    await expect(configured.assertNewRunAllowed(request)).resolves.toBeUndefined()
    await expect(configured.publicCapabilities(true)).resolves.toMatchObject({
      runtimeMode: 'GATEWAY',
      visualDeckV4: {
        models: {
          text: ['gpt-5.6-terra'],
          vision: ['gpt-5.6-terra'],
          image: ['gemini-3-pro-image-preview'],
          imageEdit: [],
        },
        modelAvailability: {
          text: [{ model: 'gpt-5.6-terra', state: 'HEALTHY' }],
          vision: [{ model: 'gpt-5.6-terra', state: 'HEALTHY' }],
          image: [{ model: 'gemini-3-pro-image-preview', state: 'HEALTHY' }],
          imageEdit: [],
        },
      },
    })
  })

  test('freezes exactly one ready route for every V4 model role', async () => {
    const configured = policy({
      models: [
        { model: 'gpt-5.6-terra', roles: ['TEXT', 'VISION'], evaluationEnabled: true, published: true, readiness },
        { model: 'gemini-3-pro-image-preview', roles: ['IMAGE'], evaluationEnabled: true, published: true, readiness },
        { model: 'gpt-image-2', roles: ['IMAGE_EDIT'], evaluationEnabled: true, published: true, readiness },
      ],
      availabilityProbes: {
        text: probe(['gpt-5.6-terra']),
        image: probe(['gemini-3-pro-image-preview', 'gpt-image-2']),
      },
    })

    await expect(configured.createNewRunSnapshot(request)).resolves.toEqual({
      schemaVersion: '1',
      textModel: 'gpt-5.6-terra',
      visionModel: 'gpt-5.6-terra',
      imageModel: 'gemini-3-pro-image-preview',
      imageEditModel: 'gpt-image-2',
    })
  })

  test('rejects an ambiguous published text or vision route instead of selecting by configuration order', async () => {
    const configured = policy({
      models: [
        { model: 'text-a', roles: ['TEXT'], evaluationEnabled: true, published: true, readiness },
        { model: 'text-b', roles: ['TEXT'], evaluationEnabled: true, published: true, readiness },
        { model: 'vision', roles: ['VISION'], evaluationEnabled: true, published: true, readiness },
        { model: 'gemini-3-pro-image-preview', roles: ['IMAGE'], evaluationEnabled: true, published: true, readiness },
      ],
      availabilityProbes: {
        text: probe(['text-a', 'text-b', 'vision']),
        image: probe(['gemini-3-pro-image-preview']),
      },
    })

    await expect(configured.createNewRunSnapshot(request)).rejects.toEqual(expect.objectContaining({
      code: 'V4_MODEL_NOT_READY', status: 422,
    } satisfies Partial<V4ModelPolicyError>))
  })

  test('keeps evaluator eligibility separate from publication and rejects unpublished formal image selection', async () => {
    const configured = policy({
      models: [
        { model: 'gpt-5.6-terra', roles: ['TEXT', 'VISION'], evaluationEnabled: true, published: true, readiness },
        { model: 'gemini-3-pro-image-preview', roles: ['IMAGE'], evaluationEnabled: true, published: false, readiness },
      ],
    })

    expect(configured.evaluationModels('IMAGE')).toEqual(['gemini-3-pro-image-preview'])
    await expect(configured.assertNewRunAllowed(request)).rejects.toEqual(expect.objectContaining({
      code: 'V4_IMAGE_MODEL_NOT_ALLOWED',
      status: 422,
    } satisfies Partial<V4ModelPolicyError>))
    await expect(configured.publicCapabilities(false)).resolves.toMatchObject({
      visualDeckV4: { models: { image: [] } },
    })
  })

  test('allows quick-deck models only after the relevant evaluation attestation passes', () => {
    const configured = policy({
      models: [
        { model: 'responses-ready', roles: ['TEXT'], evaluationEnabled: true, published: false, readiness },
        {
          model: 'chat-only', roles: ['TEXT'], evaluationEnabled: true, published: false,
          readiness: { ...readiness, structuredGenerationProtocol: null },
        },
        {
          model: 'expired', roles: ['TEXT', 'IMAGE'], evaluationEnabled: true, published: false,
          readiness: { ...readiness, expiresAt: '2026-08-07T00:30:00.000Z' },
        },
        { model: 'image-ready', roles: ['IMAGE'], evaluationEnabled: true, published: false, readiness },
      ],
    })

    expect(configured.quickDeckResponsesTextModels()).toEqual(['responses-ready'])
    expect(configured.quickDeckImageModels()).toEqual(['image-ready'])
  })

  test('does not advertise or select a V4 text route without Responses attestation', async () => {
    const configured = policy({
      models: [
        {
          model: 'chat-only-text', roles: ['TEXT', 'VISION'], evaluationEnabled: true, published: true,
          readiness: { ...readiness, structuredGenerationProtocol: null },
        },
        { model: 'gemini-3-pro-image-preview', roles: ['IMAGE'], evaluationEnabled: true, published: true, readiness },
      ],
      availabilityProbes: {
        text: probe(['chat-only-text']),
        image: probe(['gemini-3-pro-image-preview']),
      },
    })

    expect(configured.quickDeckResponsesTextModels()).toEqual([])
    await expect(configured.publicCapabilities(false)).resolves.toMatchObject({
      visualDeckV4: { models: { text: [], vision: [] } },
    })
    await expect(configured.assertNewRunAllowed(request)).rejects.toEqual(expect.objectContaining({
      code: 'V4_MODEL_NOT_READY', status: 422,
    } satisfies Partial<V4ModelPolicyError>))
  })

  test('fails closed for expired readiness and transient directory degradation without treating either as an allowed model', async () => {
    const expired = policy({
      models: [
        { model: 'gpt-5.6-terra', roles: ['TEXT', 'VISION'], evaluationEnabled: true, published: true, readiness },
        {
          model: 'gemini-3-pro-image-preview', roles: ['IMAGE'], evaluationEnabled: true, published: true,
          readiness: { ...readiness, expiresAt: '2026-08-07T00:30:00.000Z' },
        },
      ],
    })
    await expect(expired.assertNewRunAllowed(request)).rejects.toEqual(expect.objectContaining({
      code: 'V4_MODEL_NOT_READY', status: 422,
    } satisfies Partial<V4ModelPolicyError>))

    const degraded = policy({
      availabilityProbes: {
        text: probe(['gpt-5.6-terra']),
        image: { async listModels() { throw new Error('network unavailable') } },
      },
    })
    await expect(degraded.assertNewRunAllowed(request)).rejects.toEqual(expect.objectContaining({
      code: 'V4_MODEL_UNAVAILABLE', status: 503,
    } satisfies Partial<V4ModelPolicyError>))
    await expect(degraded.publicCapabilities(false)).resolves.toMatchObject({
      visualDeckV4: {
        modelAvailability: { image: [{ model: 'gemini-3-pro-image-preview', state: 'DEGRADED' }] },
      },
    })
  })

  test('requires a complete attestation whose evaluation has already occurred', async () => {
    const invalidReadiness = [
      { evaluationRelease: null },
      { gatewayContractVersion: null },
      { evaluationSuite: null },
      { evaluatedAt: null },
      { expiresAt: null },
      { evaluatedAt: '2026-08-07T01:00:00.001Z' },
    ] as const

    for (const patch of invalidReadiness) {
      const configured = policy({
        models: [
          { model: 'gpt-5.6-terra', roles: ['TEXT', 'VISION'], evaluationEnabled: true, published: true, readiness },
          {
            model: 'gemini-3-pro-image-preview', roles: ['IMAGE'], evaluationEnabled: true, published: true,
            readiness: { ...readiness, ...patch },
          },
        ],
      })

      expect(configured.publishedModels('IMAGE')).toEqual([])
      await expect(configured.assertNewRunAllowed(request)).rejects.toEqual(expect.objectContaining({
        code: 'V4_MODEL_NOT_READY', status: 422,
      } satisfies Partial<V4ModelPolicyError>))
    }
  })

  test('does not start a new Run when a published asynchronous image-edit route is absent from the same live directory', async () => {
    const configured = policy({
      models: [
        { model: 'gpt-5.6-terra', roles: ['TEXT', 'VISION'], evaluationEnabled: true, published: true, readiness },
        { model: 'gemini-3-pro-image-preview', roles: ['IMAGE'], evaluationEnabled: true, published: true, readiness },
        { model: 'gpt-image-2', roles: ['IMAGE_EDIT'], evaluationEnabled: true, published: true, readiness },
      ],
      availabilityProbes: {
        text: probe(['gpt-5.6-terra']),
        image: probe(['gemini-3-pro-image-preview']),
      },
    })

    await expect(configured.assertNewRunAllowed(request)).rejects.toEqual(expect.objectContaining({
      code: 'V4_MODEL_UNAVAILABLE', status: 503,
    } satisfies Partial<V4ModelPolicyError>))
  })

  test('reuses one directory result within its TTL and refreshes new-Run eligibility after expiry', async () => {
    let now = new Date('2026-08-07T01:00:00.000Z')
    let calls = 0
    const configured = policy({
      availabilityTtlMs: 10_000,
      now: () => now,
      availabilityProbes: {
        text: { async listModels() { calls += 1; return ['gpt-5.6-terra'] } },
        image: { async listModels() { calls += 1; return calls <= 2 ? ['gemini-3-pro-image-preview'] : [] } },
      },
    })

    await configured.assertNewRunAllowed(request)
    await configured.assertNewRunAllowed(request)
    expect(calls).toBe(2)

    now = new Date('2026-08-07T01:00:10.001Z')
    await expect(configured.assertNewRunAllowed(request)).rejects.toEqual(expect.objectContaining({
      code: 'V4_MODEL_UNAVAILABLE', status: 503,
    } satisfies Partial<V4ModelPolicyError>))
    expect(calls).toBe(4)
  })

  test('keeps same-name text and image directory health isolated by gateway channel', async () => {
    let releaseTextProbe: (models: readonly string[]) => void = (_models) => {
      throw new Error('text directory probe did not start')
    }
    const textDirectory = new Promise<readonly string[]>((resolve) => { releaseTextProbe = resolve })
    const configured = policy({
      models: [
        {
          model: 'shared-model',
          roles: ['TEXT', 'VISION', 'IMAGE'],
          evaluationEnabled: true,
          published: true,
          readiness,
        },
      ],
      availabilityProbes: {
        text: { async listModels() { return await textDirectory } },
        image: probe([]),
      },
    })
    const sharedRequest = { ...request, imageModel: 'shared-model' }
    const assertion = configured.assertNewRunAllowed(sharedRequest)

    await Promise.resolve()
    await Promise.resolve()
    releaseTextProbe(['shared-model'])

    await expect(assertion).rejects.toEqual(expect.objectContaining({
      code: 'V4_MODEL_UNAVAILABLE', status: 503,
    } satisfies Partial<V4ModelPolicyError>))
    await expect(configured.publicCapabilities(false)).resolves.toMatchObject({
      visualDeckV4: {
        modelAvailability: {
          text: [{ model: 'shared-model', state: 'HEALTHY' }],
          vision: [{ model: 'shared-model', state: 'HEALTHY' }],
          image: [{ model: 'shared-model', state: 'UNAVAILABLE' }],
        },
      },
    })
  })

  test('treats malformed persisted V4 snapshots as unavailable rather than invoking a runtime model', () => {
    const malformed = {
      presentationMode: 'VISUAL_DECK_V4' as const,
      v4ModelSnapshot: {
        schemaVersion: '1' as const,
        textModel: 42,
        visionModel: 'vision',
        imageModel: 'image',
        imageEditModel: 7,
      },
    }

    expect(() => v4ModelOverride(malformed as never, 'TEXT')).toThrow(V4LegacyModelSnapshotError)
    expect(() => v4ImageEditModelOverride(malformed as never)).toThrow(V4LegacyModelSnapshotError)
  })

  test('keeps pre-chain-4 records on their historical route when they predate model snapshots', () => {
    for (const compilerVersion of [
      LEGACY_VISUAL_DECK_V4_COMPILER_VERSION,
      CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION,
      CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION,
    ]) {
      const legacy = {
        presentationMode: 'VISUAL_DECK_V4' as const,
        imageModel: 'legacy-image-model',
        release: { compilerVersion },
      }
      expect(v4ModelOverride(legacy, 'TEXT')).toBeUndefined()
      expect(v4ModelOverride(legacy, 'VISION')).toBeUndefined()
      expect(v4ModelOverride(legacy, 'IMAGE')).toBe('legacy-image-model')
      expect(v4ImageEditModelOverride(legacy)).toBeUndefined()
    }

    const chain4 = {
      presentationMode: 'VISUAL_DECK_V4' as const,
      imageModel: 'new-image-model',
      release: { compilerVersion: VISUAL_DECK_V4_COMPILER_VERSION },
    }
    expect(() => v4ModelOverride(chain4, 'TEXT')).toThrow(V4LegacyModelSnapshotError)
    expect(() => v4ImageEditModelOverride(chain4)).toThrow(V4LegacyModelSnapshotError)
  })
})

import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  V4_EVALUATION_CANARY_PAGE_COUNTS,
  V4_EVALUATION_DEFAULT_SERVICE_URL,
  assertV4EvaluationRoots,
  evaluationInputContentHash,
  deliveryAvailabilityWaitState,
  loadV4EvaluationInputs,
  normalizeEvaluationRequest,
  presentationSlideEntries,
  referencedSlideImageEntry,
  requireAvailableDelivery,
  readV4EvaluationGatewayTarget,
  REQUIRED_COMPLETED_LIFECYCLE,
  resolveV4EvaluationCanaryPageCounts,
  redactedEvaluationRequest,
  runV4EvaluationCanary,
  validateLifecycle,
  validateQualityGate,
  validateRasterPages,
  validateCreatedV4RunIdentity,
  v4EvaluationIdempotencyKey,
  type V4EvaluationRelease,
} from '../scripts/run-v4-real-evaluation'
import { createPublicCapabilities } from '../src/run-query-contracts'

type LifecycleEvent = Parameters<typeof validateLifecycle>[0][number]

const releasedService: V4EvaluationRelease = {
  softwareVersion: '4.4.0',
  gitSha: 'a'.repeat(40),
  releaseId: 'v4.4.0-aaaaaaaaaaaa',
}

function request() {
  return {
    schemaVersion: '1',
    host: { tenantId: 'phase5', externalUserId: 'evaluation-user' },
    source: { kind: 'TEXT', name: '教材.txt', text: '这是用于真实评测脚本合同测试的完整教材内容。'.repeat(4) },
    slideCount: 10,
    visualDirection: '适合课堂投影的清晰视觉风格',
    imageModel: 'gemini-3-pro-image-preview',
    automationLevel: 'BOUNDED_AUTO',
    budgetUnits: 30,
    maxRevisionRounds: 2,
    presentationMode: 'VISUAL_DECK_V4',
    visualDeckV4: {
      instruction: '请制作一套10页课堂PPT。',
      sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 10 }, aspectRatio: '16:9',
      },
    },
  }
}

function requestForSlideCount(slideCount: 1 | 3 | 10) {
  const value = request()
  value.slideCount = slideCount
  value.visualDeckV4.deckOptions.length = { slideCount }
  value.visualDeckV4.instruction = `请制作一套${slideCount}页课堂PPT。`
  return value
}

function gatewayCapabilities(imageModel = 'gemini-3-pro-image-preview') {
  const textModel = 'gpt-5.6-terra'
  return createPublicCapabilities({
    runtimeMode: 'GATEWAY',
    textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
    textModels: [textModel],
    visionModels: [textModel],
    imageModels: [imageModel],
    modelAvailability: {
      text: [{ model: textModel, state: 'HEALTHY', checkedAt: '2026-08-08T00:00:00.000Z' }],
      vision: [{ model: textModel, state: 'HEALTHY', checkedAt: '2026-08-08T00:00:00.000Z' }],
      image: [{ model: imageModel, state: 'HEALTHY', checkedAt: '2026-08-08T00:00:00.000Z' }],
      imageEdit: [],
    },
  })
}

function readinessResponse(release = releasedService) {
  return new Response(JSON.stringify({ service: 'ppt-agent', status: 'READY', release }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function capabilitiesResponse(capability: ReturnType<typeof gatewayCapabilities>) {
  return new Response(JSON.stringify({ schemaVersion: '1', requestId: 'v4-eval-capabilities', data: capability }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function completedLifecycleEvents(): LifecycleEvent[] {
  return REQUIRED_COMPLETED_LIFECYCLE.map((type, index) => {
    if (type === 'run.completed') {
      return { eventId: `event-${index + 1}`, sequence: index + 1, type, payload: undefined }
    }
    const stage = type.split('.')[0]!.toUpperCase()
    const started = type.endsWith('.started')
    const reason = null
    return {
      eventId: `event-${index + 1}`,
      sequence: index + 1,
      type,
      payload: {
        stage,
        completed: started ? 0 : 1,
        total: 1,
        pageNumbers: [1],
        revisionKind: null,
        revisionRound: 0,
        reason,
      },
    }
  })
}

describe('V4 real evaluation harness', () => {
  test('uses the main V4 service and only the fixed 1 -> 3 -> 10 canary sequence', () => {
    expect(V4_EVALUATION_DEFAULT_SERVICE_URL).toBe('http://127.0.0.1:4310')
    expect(resolveV4EvaluationCanaryPageCounts(undefined)).toEqual([1, 3, 10])
    expect(resolveV4EvaluationCanaryPageCounts('1,3,10')).toEqual([1, 3, 10])
    expect(() => resolveV4EvaluationCanaryPageCounts('3,10')).toThrow('V4_EVAL_PAGE_COUNTS_INVALID')
    expect(() => resolveV4EvaluationCanaryPageCounts('1,10,3')).toThrow('V4_EVAL_PAGE_COUNTS_INVALID')
  })

  test('rejects production runtime paths before it can read inputs or write an evaluation report', () => {
    expect(() => assertV4EvaluationRoots('/opt/ppt-agent/input', '/opt/ppt-agent-test/evaluation')).toThrow(
      'V4_EVAL_INPUT_PRODUCTION_PATH_FORBIDDEN',
    )
    expect(() => assertV4EvaluationRoots('/srv/ppt-evaluation-input', '/opt/ppt-agent/reports')).toThrow(
      'V4_EVAL_OUTPUT_PRODUCTION_PATH_FORBIDDEN',
    )
  })

  test('writes only hashes for request source and model-facing instructions', () => {
    const input = normalizeEvaluationRequest(request(), 10)
    const manifest = redactedEvaluationRequest(input)
    const serialized = JSON.stringify(manifest)

    expect(serialized).not.toContain(input.source.kind === 'TEXT' ? input.source.text : '')
    expect(serialized).not.toContain(input.visualDeckV4!.instruction)
    expect(manifest.source.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.contentHashes.visualDeckV4).toMatch(/^[a-f0-9]{64}$/)
  })

  test('rejects an invalid later input before any canary preflight or submission can begin', async () => {
    const inputRoot = await mkdtemp(path.join(tmpdir(), 'ppt-agent-v4-eval-input-'))
    try {
      await Promise.all(V4_EVALUATION_CANARY_PAGE_COUNTS.map(async (slideCount) => {
        const caseDirectory = path.join(inputRoot, String(slideCount), 'case-a')
        await mkdir(caseDirectory, { recursive: true })
        const value = requestForSlideCount(slideCount)
        if (slideCount === 10) value.visualDeckV4.deckOptions.length = { slideCount: 9 }
        await writeFile(path.join(caseDirectory, 'request.json'), JSON.stringify(value))
      }))

      await expect(loadV4EvaluationInputs({
        inputRoot,
        caseIds: ['case-a'],
        pageCounts: V4_EVALUATION_CANARY_PAGE_COUNTS,
      })).rejects.toThrow('v4 length must match slideCount')
    } finally {
      await rm(inputRoot, { recursive: true, force: true })
    }
  })

  test('proves the released gateway target before the first V4 submission', async () => {
    const order: Array<string | number> = []
    const observed = await runV4EvaluationCanary({
      preflight: () => readV4EvaluationGatewayTarget({
        serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
        apiToken: 'evaluation-api-token',
        request: normalizeEvaluationRequest(request(), 10),
        timeoutMs: 1_000,
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: releasedService.releaseId },
        fetch: async (url, init) => {
          order.push(new URL(url).pathname)
          if (new URL(url).pathname === '/health/ready') return readinessResponse()
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer evaluation-api-token')
          expect(new Headers(init?.headers).get('X-PPT-Agent-Tenant')).toBe('phase5')
          return capabilitiesResponse(gatewayCapabilities())
        },
      }),
      persistPreflight: async () => { order.push('preflight.json') },
      caseIds: ['case-a'],
      runCase: async (slideCount, caseId) => {
        order.push(slideCount)
        return { passed: true, slideCount, caseId }
      },
    })

    expect(order).toEqual(['/health/ready', '/v1/capabilities', 'preflight.json', ...V4_EVALUATION_CANARY_PAGE_COUNTS])
    expect(observed).toMatchObject({
      passed: true,
      target: {
        service: 'ppt-agent',
        release: releasedService,
        runtimeMode: 'GATEWAY',
        textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
        models: { text: 'gpt-5.6-terra', vision: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        imageGeneration: { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true },
      },
    })
  })

  test('keeps each real evaluation idempotency key bounded while isolating fresh batches', () => {
    const caseId = 'c'.repeat(80)
    const first = v4EvaluationIdempotencyKey(10, caseId, 'batch-a')
    const second = v4EvaluationIdempotencyKey(10, caseId, 'batch-b')

    expect(first).toMatch(/^[A-Za-z0-9._:-]+$/)
    expect(first.length).toBeLessThanOrEqual(160)
    expect(second).not.toBe(first)
  })

  test('stops after a create response identifies the wrong page mode or image model', () => {
    const input = normalizeEvaluationRequest(request(), 10)
    expect(() => validateCreatedV4RunIdentity({
      slideCount: 3,
      presentationMode: 'VISUAL_DECK_V4',
      imageModel: input.imageModel,
    }, input, 10)).toThrow('V4_EVAL_CREATED_SLIDE_COUNT_INVALID')
    expect(() => validateCreatedV4RunIdentity({
      slideCount: 10,
      presentationMode: 'SLIDE_IMAGE_V2',
      imageModel: input.imageModel,
    }, input, 10)).toThrow('V4_EVAL_CREATED_PRESENTATION_MODE_INVALID')
    expect(() => validateCreatedV4RunIdentity({
      slideCount: 10,
      presentationMode: 'VISUAL_DECK_V4',
      imageModel: 'other-image-model',
    }, input, 10)).toThrow('V4_EVAL_CREATED_IMAGE_MODEL_INVALID')
  })

  test('blocks every submission when the target is a mock, non-image-task, or wrong release', async () => {
    const requestValue = normalizeEvaluationRequest(request(), 10)
    const failures: Array<Readonly<{ capability: unknown; expectedRelease: { gitSha: string | null; releaseId: string | null }; code: string }>> = [
      {
        capability: createPublicCapabilities(),
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: null },
        code: 'V4_EVAL_RUNTIME_MODE_INVALID',
      },
      {
        capability: (() => {
          const capability = gatewayCapabilities()
          return {
            ...capability,
            visualDeckV4: {
              ...capability.visualDeckV4,
              textGeneration: { protocol: 'UNAVAILABLE', streaming: false },
            },
          }
        })(),
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: null },
        code: 'V4_EVAL_TEXT_PROTOCOL_INVALID',
      },
      {
        capability: {
          ...gatewayCapabilities(),
          visualDeckV4: {
            ...gatewayCapabilities().visualDeckV4,
            imageGeneration: { asynchronous: false, protocol: 'LOCAL_MOCK', validatesActualPixels: true },
          },
        },
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: null },
        code: 'V4_EVAL_IMAGE_PROTOCOL_INVALID',
      },
      {
        capability: gatewayCapabilities(),
        expectedRelease: { gitSha: 'b'.repeat(40), releaseId: null },
        code: 'V4_EVAL_READY_GIT_SHA_MISMATCH',
      },
      {
        capability: (() => {
          const capability = gatewayCapabilities()
          return {
            ...capability,
            visualDeckV4: {
              ...capability.visualDeckV4,
              modelAvailability: {
                ...capability.visualDeckV4.modelAvailability!,
                image: [{
                  ...capability.visualDeckV4.modelAvailability!.image[0]!,
                  state: 'DEGRADED',
                }],
              },
            },
          }
        })(),
        expectedRelease: { gitSha: releasedService.gitSha, releaseId: null },
        code: 'V4_EVAL_IMAGE_MODEL_UNAVAILABLE',
      },
    ]

    for (const failure of failures) {
      let submissions = 0
      await expect(runV4EvaluationCanary({
        preflight: () => readV4EvaluationGatewayTarget({
          serviceUrl: V4_EVALUATION_DEFAULT_SERVICE_URL,
          apiToken: 'evaluation-api-token',
          request: requestValue,
          timeoutMs: 1_000,
          expectedRelease: failure.expectedRelease,
          fetch: async (url) => new URL(url).pathname === '/health/ready'
            ? readinessResponse()
            : new Response(JSON.stringify({ schemaVersion: '1', requestId: 'v4-eval-capabilities', data: failure.capability }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        }),
        caseIds: ['case-a'],
        runCase: async (slideCount, caseId) => {
          submissions += 1
          return { passed: true, slideCount, caseId }
        },
      })).rejects.toThrow(failure.code)
      expect(submissions).toBe(0)
    }
  })

  test('stops the canary at the first failed case without submitting later pages', async () => {
    const attempted: Array<string> = []
    const result = await runV4EvaluationCanary({
      preflight: async () => ({
        service: 'ppt-agent',
        release: releasedService,
        runtimeMode: 'GATEWAY',
        textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
        models: { text: 'gpt-5.6-terra', vision: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        imageGeneration: { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true },
      }),
      caseIds: ['case-a', 'case-b'],
      runCase: async (slideCount, caseId) => {
        attempted.push(`${slideCount}/${caseId}`)
        return { passed: false, slideCount, caseId, errorCode: 'V4_EVAL_CASE_FAILED' }
      },
    })

    expect(attempted).toEqual(['1/case-a'])
    expect(result).toEqual({
      target: {
        service: 'ppt-agent',
        release: releasedService,
        runtimeMode: 'GATEWAY',
        textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
        models: { text: 'gpt-5.6-terra', vision: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        imageGeneration: { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true },
      },
      passed: false,
      results: [{ passed: false, slideCount: 1, caseId: 'case-a', errorCode: 'V4_EVAL_CASE_FAILED' }],
    })
  })

  test('does not submit a run when preflight evidence cannot be persisted', async () => {
    let submissions = 0
    await expect(runV4EvaluationCanary({
      preflight: async () => ({
        service: 'ppt-agent',
        release: releasedService,
        runtimeMode: 'GATEWAY',
        textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
        models: { text: 'gpt-5.6-terra', vision: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
        imageGeneration: { asynchronous: true, protocol: 'IMAGE_TASK', validatesActualPixels: true },
      }),
      persistPreflight: async () => { throw new Error('V4_EVAL_PREFLIGHT_PERSIST_FAILED') },
      caseIds: ['case-a'],
      runCase: async (slideCount, caseId) => {
        submissions += 1
        return { passed: true, slideCount, caseId }
      },
    })).rejects.toThrow('V4_EVAL_PREFLIGHT_PERSIST_FAILED')
    expect(submissions).toBe(0)
  })

  test('consumes only the exact delivery authorized by deliveryAvailability', () => {
    const delivery = {
      schemaVersion: '1' as const,
      id: 'run-1:delivery:r0',
      runId: 'run-1',
      revisionRound: 0,
      qualityScore: 90,
      qualityOverride: false,
      disposition: 'FINAL' as const,
      qualityStatus: 'APPROVED' as const,
      openIssueIds: [],
      identity: {
        status: 'VERIFIED' as const,
        slideCount: 2,
        pageNumbers: [1, 2],
        blueprintHash: 'a'.repeat(64),
      },
      qualityPolicyAudit: null,
      qualityOverrideAudit: null,
      preview: {
        artifactId: 'preview-1', name: 'preview.png', mimeType: 'image/png' as const,
        sha256: 'b'.repeat(64), byteLength: 100,
      },
      pptx: {
        artifactId: 'pptx-1', name: 'presentation.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const,
        sha256: 'c'.repeat(64), byteLength: 200,
      },
      createdAt: '2026-08-04T00:00:00.000Z',
    }
    const run = {
      schemaVersion: '1' as const,
      id: 'run-1',
      status: 'COMPLETED',
      version: 8,
      slideCount: 2,
      revisionRound: 0,
      committedBudgetUnits: 2,
      qualityScore: 90,
      qualityOverride: false,
      issues: [],
      deliveryAvailability: {
        state: 'AVAILABLE', deliveryId: delivery.id, disposition: 'FINAL', identityStatus: 'VERIFIED',
      },
      deliveries: [delivery],
    }

    expect(requireAvailableDelivery(run)).toEqual(delivery)
    expect(() => requireAvailableDelivery({
      ...run,
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'ACCOUNTING_PENDING' },
    })).toThrow('DELIVERY_UNAVAILABLE:ACCOUNTING_PENDING')
    expect(() => requireAvailableDelivery({
      ...run,
      deliveryAvailability: { ...run.deliveryAvailability, deliveryId: 'delivery-other' },
    })).toThrow('DELIVERY_PUBLIC_IDENTITY_MISMATCH')
  })

  test('waits for AVAILABLE instead of treating any non-accounting state as downloadable', () => {
    const run = {
      schemaVersion: '1' as const,
      id: 'run-1',
      status: 'COMPLETED',
      version: 8,
      slideCount: 2,
      revisionRound: 0,
      committedBudgetUnits: 2,
      qualityScore: 90,
      qualityOverride: false,
      issues: [],
      deliveries: [],
    }

    expect(deliveryAvailabilityWaitState({
      ...run,
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'ACCOUNTING_PENDING' },
    })).toEqual({ state: 'WAIT', reason: 'ACCOUNTING_PENDING' })
    expect(deliveryAvailabilityWaitState({
      ...run,
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'DELIVERY_CONTRACT_INVALID' },
    })).toEqual({ state: 'WAIT', reason: 'DELIVERY_CONTRACT_INVALID' })
    expect(deliveryAvailabilityWaitState({
      ...run,
      deliveryAvailability: {
        state: 'AVAILABLE', deliveryId: 'run-1:delivery:r0', disposition: 'FINAL', identityStatus: 'VERIFIED',
      },
    })).toEqual({ state: 'AVAILABLE', reason: null })
    expect(deliveryAvailabilityWaitState({
      ...run,
      status: 'FAILED',
      deliveryAvailability: { state: 'UNAVAILABLE', reason: 'RUN_NOT_COMPLETED' },
    })).toEqual({ state: 'TERMINAL', reason: 'RUN_FAILED' })
  })

  test('executes an already matching V4 request without editing it', () => {
    const input = request()
    const normalized = normalizeEvaluationRequest(input, 10)

    expect(normalized.visualDeckV4?.instruction).toBe(input.visualDeckV4.instruction)
    expect(normalized.slideCount).toBe(10)
    expect(normalized.visualDeckV4?.deckOptions.length).toEqual({ slideCount: 10 })
  })

  test('rejects a page-count mismatch instead of rewriting the original instruction', () => {
    const value = request()
    value.visualDeckV4.instruction = '第12页展示课堂练习，整套原计划为12页。'

    expect(() => normalizeEvaluationRequest(value, 2)).toThrow('V4_EVAL_SLIDE_COUNT_MISMATCH')
    expect(value.visualDeckV4.instruction).toBe('第12页展示课堂练习，整套原计划为12页。')
  })

  test('hashes evaluation request contents and case identities instead of the directory path', () => {
    const first = evaluationInputContentHash([
      { caseId: '01-raw-requirement', bytes: new TextEncoder().encode('{"slideCount":10}') },
    ])
    const changedContent = evaluationInputContentHash([
      { caseId: '01-raw-requirement', bytes: new TextEncoder().encode('{"slideCount":12}') },
    ])
    const changedCase = evaluationInputContentHash([
      { caseId: '02-planned-outline', bytes: new TextEncoder().encode('{"slideCount":10}') },
    ])

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(changedContent).not.toBe(first)
    expect(changedCase).not.toBe(first)
  })

  test('accepts one ordered and unique completed lifecycle', () => {
    const events = completedLifecycleEvents()

    expect(validateLifecycle(events, 'COMPLETED', 0)).toEqual({
      passed: true,
      monotonicSequence: true,
      uniqueEventIds: true,
      missing: [],
      terminalEventCount: 1,
      terminalEventType: 'run.completed',
      terminalLifecycleIsLast: true,
      stageLifecyclePairs: {
        PLANNING: 1, GENERATION: 1, PAGE_REVIEW: 1, REVISION: 0, DECK_REVIEW: 1, DELIVERY: 1,
      },
      stageLifecycleValid: true,
      revisionLifecyclePairs: 0,
      revisionLifecycleValid: true,
      revisionRounds: [],
    })
  })

  test('rejects an orphaned or inconsistent revision lifecycle', () => {
    const base = completedLifecycleEvents().map(({ type, payload }) => ({ type, payload }))
    const withOrphan = [
      ...base.slice(0, 7),
      {
        type: 'revision.started',
        payload: {
          completed: 0, total: 2, pageNumbers: [2, 3], revisionKind: 'DECK_VISUAL', revisionRound: 1,
        },
      },
      ...base.slice(7),
    ].map((event, index) => ({ ...event, eventId: `event-${index + 1}`, sequence: index + 1 }))

    const lifecycle = validateLifecycle(withOrphan, 'COMPLETED', 1)

    expect(lifecycle.passed).toBe(false)
    expect(lifecycle.revisionLifecyclePairs).toBe(0)
    expect(lifecycle.revisionLifecycleValid).toBe(false)
  })

  test('rejects missing lifecycle stages and non-raster PPTX pages', () => {
    const lifecycle = validateLifecycle([
      { eventId: 'event-1', sequence: 2, type: 'planning.started' },
      { eventId: 'event-2', sequence: 1, type: 'run.completed' },
    ], 'COMPLETED', 0)
    const raster = validateRasterPages([
      {
        pageNumber: 1,
        mediaEntry: 'ppt/media/image1.png',
        sha256: 'a'.repeat(64),
        byteLength: 100,
        pictureObjects: 1,
        nativeTextObjects: 1,
        imageXEmu: 0,
        imageYEmu: 0,
        imageWidthEmu: 12_192_000,
        imageHeightEmu: 6_858_000,
        imageWidthPx: 1600,
        imageHeightPx: 900,
        imageRelativeAspectError: 0,
        imageAspectRatioValidated: true,
        slideWidthEmu: 12_192_000,
        slideHeightEmu: 6_858_000,
        fullBleed: true,
      },
    ], 2)

    expect(lifecycle.passed).toBe(false)
    expect(lifecycle.monotonicSequence).toBe(false)
    expect(lifecycle.missing).toContain('planning.completed')
    expect(raster).toEqual({ passed: false, continuous: false, expectedPages: 2, validPages: 0 })
  })

  test('rejects duplicate stage starts and a failed revision inside a completed run', () => {
    const duplicate = completedLifecycleEvents()
    duplicate.splice(1, 0, {
      ...duplicate[0]!,
      eventId: 'event-duplicate-planning',
      sequence: 0,
    })
    const duplicateEvents = duplicate.map((event, index) => ({ ...event, sequence: index + 1 }))
    expect(validateLifecycle(duplicateEvents, 'COMPLETED', 0)).toMatchObject({
      passed: false,
      stageLifecycleValid: false,
    })

    const failedRevision = completedLifecycleEvents()
    const deckStartedIndex = failedRevision.findIndex((event) => event.type === 'deck_review.started')
    const revisionEvents: LifecycleEvent[] = [
      {
        eventId: 'revision-started', sequence: 0, type: 'revision.started',
        payload: {
          stage: 'REVISION', completed: 0, total: 1, pageNumbers: [1],
          revisionKind: 'DECK_VISUAL', revisionRound: 1, reason: 'DECK_REVIEW_REJECTED',
        },
      },
      {
        eventId: 'revision-completed', sequence: 0, type: 'revision.completed',
        payload: {
          stage: 'REVISION', completed: 0, total: 1, pageNumbers: [1],
          revisionKind: 'DECK_VISUAL', revisionRound: 1, reason: 'REVISION_FAILED',
        },
      },
    ]
    failedRevision.splice(deckStartedIndex, 0, ...revisionEvents)
    const failedRevisionEvents = failedRevision.map((event, index) => ({ ...event, sequence: index + 1 }))
    expect(validateLifecycle(failedRevisionEvents, 'COMPLETED', 1)).toMatchObject({
      passed: false,
      stageLifecycleValid: false,
      revisionLifecycleValid: false,
    })
  })

  test('accepts one production-shaped single-page V4 revision through page re-review', () => {
    const stage = (
      type: string,
      completed: number,
      total: number,
      pageNumbers: number[],
      reason: string | null = null,
      revisionRound = 0,
      revisionKind: string | null = null,
    ): LifecycleEvent => ({
      eventId: '', sequence: 0, type,
      payload: { stage: type.split('.')[0]!.toUpperCase(), completed, total, pageNumbers, reason,
        revisionRound, revisionKind },
    })
    const allPages = [1, 2, 3]
    const events: LifecycleEvent[] = [
      stage('planning.started', 0, 1, allPages),
      stage('planning.completed', 1, 1, allPages),
      stage('generation.started', 0, 3, allPages),
      stage('generation.progress', 3, 3, allPages),
      stage('generation.completed', 3, 3, allPages),
      stage('page_review.started', 0, 3, allPages),
      stage('page_review.completed', 3, 3, [2], 'PAGE_REVIEW_REJECTED'),
      stage('revision.started', 0, 1, [2], 'PAGE_REVIEW_REJECTED', 1, 'PAGE_VISUAL'),
      stage('revision.progress', 1, 1, [2], null, 1, 'PAGE_VISUAL'),
      stage('revision.completed', 1, 1, [2], null, 1, 'PAGE_VISUAL'),
      stage('page_review.started', 0, 3, allPages, null, 1),
      stage('page_review.completed', 3, 3, allPages, null, 1),
      stage('deck_review.started', 0, 1, allPages, null, 1),
      stage('deck_review.completed', 1, 1, allPages, null, 1),
      stage('delivery.started', 0, 1, allPages, null, 1),
      stage('delivery.completed', 1, 1, allPages, null, 1),
      { eventId: '', sequence: 0, type: 'run.completed' },
    ].map((event, index) => ({ ...event, eventId: `event-${index + 1}`, sequence: index + 1 }))

    expect(validateLifecycle(events, 'COMPLETED', 1)).toMatchObject({
      passed: true,
      stageLifecyclePairs: {
        PLANNING: 1, GENERATION: 1, PAGE_REVIEW: 2, REVISION: 1, DECK_REVIEW: 1, DELIVERY: 1,
      },
      stageLifecycleValid: true,
      revisionLifecyclePairs: 1,
      revisionLifecycleValid: true,
      revisionRounds: [1],
    })
  })

  test('rejects a V4 revision that skips progress and page re-review', () => {
    const base = completedLifecycleEvents()
    const deckStarted = base.find((event) => event.type === 'deck_review.started')!
    const deckCompletedIndex = base.findIndex((event) => event.type === 'deck_review.completed')
    const deckCompleted = base[deckCompletedIndex]!
    if (!deckCompleted.payload || typeof deckCompleted.payload !== 'object') throw new Error('TEST_DECK_PAYLOAD_MISSING')
    base[deckCompletedIndex] = {
      ...deckCompleted,
      payload: { ...deckCompleted.payload, reason: 'DECK_REVIEW_REJECTED' },
    }
    base.splice(deckCompletedIndex + 1, 0, {
      eventId: 'revision-started', sequence: 0, type: 'revision.started',
      payload: {
        stage: 'REVISION', completed: 0, total: 1, pageNumbers: [1],
        revisionKind: 'DECK_VISUAL', revisionRound: 1, reason: 'DECK_REVIEW_REJECTED',
      },
    }, {
      eventId: 'revision-completed', sequence: 0, type: 'revision.completed',
      payload: {
        stage: 'REVISION', completed: 1, total: 1, pageNumbers: [1],
        revisionKind: 'DECK_VISUAL', revisionRound: 1, reason: null,
      },
    }, {
      ...deckStarted,
      eventId: 'second-deck-started',
      sequence: 0,
      payload: { ...(deckStarted.payload as Record<string, unknown>), revisionRound: 1 },
    }, {
      ...deckCompleted,
      eventId: 'second-deck-completed',
      sequence: 0,
      payload: { ...deckCompleted.payload, revisionRound: 1 },
    })
    const events = base.map((event, index) => ({ ...event, sequence: index + 1 }))

    expect(validateLifecycle(events, 'COMPLETED', 1)).toMatchObject({
      passed: false,
      stageLifecycleValid: false,
      revisionLifecycleValid: false,
    })
  })

  test('uses the presentation slide list and the exact picture relationship', () => {
    const presentationXml = '<p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>'
    const presentationRelations = [
      '<Relationships>',
      '<Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/>',
      '<Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/>',
      '<Relationship Id="rId99" Type="x/slide" Target="slides/slide99.xml"/>',
      '</Relationships>',
    ].join('')
    expect(presentationSlideEntries(presentationXml, presentationRelations)).toEqual([
      { pageNumber: 1, slideEntry: 'ppt/slides/slide2.xml' },
      { pageNumber: 2, slideEntry: 'ppt/slides/slide1.xml' },
    ])

    const slideXml = '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>'
    const slideRelations = [
      '<Relationships>',
      '<Relationship Id="rId1" Type="x/image" Target="../media/unused.png"/>',
      '<Relationship Id="rId2" Type="x/image" Target="../media/actual.png"/>',
      '</Relationships>',
    ].join('')
    expect(referencedSlideImageEntry(slideXml, slideRelations, 1)).toBe('ppt/media/actual.png')

    const pages = Array.from({ length: 11 }, (_, index) => ({
      pageNumber: index + 1,
      mediaEntry: `ppt/media/image-${index + 1}.png`,
      sha256: String(index % 10).repeat(64),
      byteLength: 100,
      pictureObjects: 1,
      nativeTextObjects: 0,
      imageXEmu: 0,
      imageYEmu: 0,
      imageWidthEmu: 12_192_000,
      imageHeightEmu: 6_858_000,
      imageWidthPx: 1600,
      imageHeightPx: 900,
      imageRelativeAspectError: 0,
      imageAspectRatioValidated: true,
      slideWidthEmu: 12_192_000,
      slideHeightEmu: 6_858_000,
      fullBleed: index !== 5,
    }))

    expect(validateRasterPages(pages, 10)).toEqual({
      passed: false, continuous: false, expectedPages: 10, validPages: 10,
    })
  })

  test('records post-package image pixels and rejects a non-normalized final slide image', () => {
    const page = {
      pageNumber: 1,
      mediaEntry: 'ppt/media/image-1.png',
      sha256: 'a'.repeat(64),
      byteLength: 100,
      pictureObjects: 1,
      nativeTextObjects: 0,
      imageXEmu: 0,
      imageYEmu: 0,
      imageWidthEmu: 12_192_000,
      imageHeightEmu: 6_858_000,
      imageWidthPx: 1600,
      imageHeightPx: 900,
      imageRelativeAspectError: 0,
      imageAspectRatioValidated: true,
      slideWidthEmu: 12_192_000,
      slideHeightEmu: 6_858_000,
      fullBleed: true,
    }

    expect(validateRasterPages([page], 1)).toMatchObject({ passed: true, validPages: 1 })
    expect(validateRasterPages([{
      ...page,
      imageWidthPx: 1376,
      imageHeightPx: 768,
      imageRelativeAspectError: 0.0078125,
      imageAspectRatioValidated: false,
    }], 1)).toMatchObject({ passed: false, validPages: 0 })
  })

  test('rejects low scores and open critical or factual issues directly', () => {
    const raster = { passed: true, continuous: true, expectedPages: 10, validPages: 10 }
    const lifecycle = {
      passed: true, monotonicSequence: true, uniqueEventIds: true, missing: [], terminalEventCount: 1,
      terminalEventType: 'run.completed', terminalLifecycleIsLast: true,
      stageLifecyclePairs: {
        PLANNING: 1, GENERATION: 1, PAGE_REVIEW: 1, REVISION: 1, DECK_REVIEW: 1, DELIVERY: 1,
      },
      stageLifecycleValid: true,
      revisionLifecyclePairs: 1, revisionLifecycleValid: true, revisionRounds: [1],
    }
    const baseRun = {
      status: 'COMPLETED', slideCount: 10, qualityScore: 79, qualityOverride: false,
      issues: [] as unknown[],
    }

    expect(validateQualityGate(baseRun, raster, lifecycle, 10)).toMatchObject({
      passed: false, qualityScorePassed: false, blockingOpenIssues: 0,
    })
    expect(validateQualityGate({
      ...baseRun,
      qualityScore: 90,
      issues: [{
        id: 'issue-factual', category: 'FACTUAL_RISK', severity: 'WARNING', summary: '存在事实错误。',
        slideIds: ['run-1:slide:2'], sourceChunkIds: ['chunk-1'], status: 'OPEN', repairDomain: 'KNOWLEDGE',
      }],
    }, raster, lifecycle, 10)).toMatchObject({
      passed: false, qualityScorePassed: true, blockingOpenIssues: 1,
    })
  })

  test('rejects missing revision rounds, missing issues and lifecycle events after completion', () => {
    const events = completedLifecycleEvents()
    events.push({ eventId: 'event-after-completion', sequence: events.length + 1, type: 'delivery.completed' })
    const lifecycle = validateLifecycle(events, 'COMPLETED', 1)
    expect(lifecycle).toMatchObject({
      passed: false,
      terminalLifecycleIsLast: false,
      revisionLifecyclePairs: 0,
      revisionLifecycleValid: false,
      revisionRounds: [],
    })

    const raster = { passed: true, continuous: true, expectedPages: 10, validPages: 10 }
    const otherwiseValidLifecycle = { ...lifecycle, passed: true, terminalLifecycleIsLast: true }
    expect(validateQualityGate({
      status: 'COMPLETED', slideCount: 10, qualityScore: 90, qualityOverride: false,
    }, raster, otherwiseValidLifecycle, 10)).toMatchObject({
      passed: false, issuesPresent: false, issuesValid: false,
    })
  })
})

import { describe, expect, test } from 'bun:test'
import {
  evaluationInputContentHash,
  deliveryAvailabilityWaitState,
  normalizeEvaluationRequest,
  presentationSlideEntries,
  referencedSlideImageEntry,
  requireAvailableDelivery,
  REQUIRED_COMPLETED_LIFECYCLE,
  validateLifecycle,
  validateQualityGate,
  validateRasterPages,
} from '../scripts/run-v4-real-evaluation'

type LifecycleEvent = Parameters<typeof validateLifecycle>[0][number]

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
      slideWidthEmu: 12_192_000,
      slideHeightEmu: 6_858_000,
      fullBleed: index !== 5,
    }))

    expect(validateRasterPages(pages, 10)).toEqual({
      passed: false, continuous: false, expectedPages: 10, validPages: 10,
    })
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

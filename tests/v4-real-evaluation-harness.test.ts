import { describe, expect, test } from 'bun:test'
import {
  normalizeEvaluationRequest,
  REQUIRED_COMPLETED_LIFECYCLE,
  validateLifecycle,
  validateRasterPages,
} from '../scripts/run-v4-real-evaluation'

function request() {
  return {
    schemaVersion: '1',
    host: { tenantId: 'phase5', externalUserId: 'evaluation-user' },
    source: { kind: 'TEXT', name: '教材.txt', text: '这是用于真实评测脚本合同测试的完整教材内容。'.repeat(4) },
    slideCount: 10,
    visualDirection: '适合课堂投影的清晰视觉风格',
    imageModel: 'nanobanana',
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

describe('V4 real evaluation harness', () => {
  test('normalizes an existing V4 request to the bounded smoke-test page count', () => {
    const normalized = normalizeEvaluationRequest(request(), 2)

    expect(normalized.slideCount).toBe(2)
    expect(normalized.visualDeckV4?.deckOptions.length).toEqual({ slideCount: 2 })
    expect(normalized.visualDeckV4?.instruction).toContain('严格输出 2 页')
    expect(normalized.visualDeckV4?.instruction).not.toContain('10页')
  })

  test('accepts one ordered and unique completed lifecycle', () => {
    const events = REQUIRED_COMPLETED_LIFECYCLE.map((type, index) => ({
      eventId: `event-${index + 1}`,
      sequence: index + 1,
      type,
    }))

    expect(validateLifecycle(events, 'COMPLETED')).toEqual({
      passed: true,
      monotonicSequence: true,
      uniqueEventIds: true,
      missing: [],
      terminalEventCount: 1,
      terminalEventType: 'run.completed',
    })
  })

  test('rejects missing lifecycle stages and non-raster PPTX pages', () => {
    const lifecycle = validateLifecycle([
      { eventId: 'event-1', sequence: 2, type: 'planning.started' },
      { eventId: 'event-2', sequence: 1, type: 'run.completed' },
    ], 'COMPLETED')
    const raster = validateRasterPages([
      {
        pageNumber: 1,
        mediaEntry: 'ppt/media/image1.png',
        sha256: 'a'.repeat(64),
        byteLength: 100,
        pictureObjects: 1,
        nativeTextObjects: 1,
      },
    ], 2)

    expect(lifecycle.passed).toBe(false)
    expect(lifecycle.monotonicSequence).toBe(false)
    expect(lifecycle.missing).toContain('planning.completed')
    expect(raster).toEqual({ passed: false, continuous: false, expectedPages: 2, validPages: 0 })
  })
})

import { describe, expect, test } from 'bun:test'
import {
  quickDeckEvaluationEventSchema,
  quickDeckEvaluationPublicJobSchema,
  quickDeckEvaluationRequestSchema,
} from '../src/quick-deck-evaluation-contracts'

const now = '2026-08-07T00:00:00.000Z'

function job() {
  return {
    schemaVersion: '1' as const,
    jobId: 'quick-deck-eval-1',
    status: 'QUEUED' as const,
    phase: 'ACCEPTED' as const,
    slideCount: 1,
    aspectRatio: '16:9' as const,
    models: { text: 'gpt-5.6-terra', image: 'gemini-3-pro-image-preview' },
    progress: { planned: false, submittedPages: 0, completedPages: 0, totalPages: 1 },
    pages: [{ pageNumber: 1, status: 'PENDING' as const, width: null, height: null, aspectRatioValidated: false, sha256: null }],
    artifacts: { pptx: null, preview: null },
    quality: { state: 'NOT_ASSESSED' as const, score: null, rubric: null },
    failure: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    expiresAt: '2026-08-08T00:00:00.000Z',
    durationMs: null,
  }
}

describe('quick-deck evaluation contracts', () => {
  test('accepts only bounded text inputs for a one-to-ten-page V4 evaluation', () => {
    expect(quickDeckEvaluationRequestSchema.parse({
      schemaVersion: '1',
      source: { kind: 'TEXT', name: 'controlled.txt', text: '这是用于验证 PPT 智能体快速生成能力的受控测试材料。'.repeat(3) },
      slideCount: 10,
      visualDirection: '清晰的课堂信息图',
      imageModel: 'gemini-3-pro-image-preview',
    })).toMatchObject({ slideCount: 10, source: { kind: 'TEXT' } })
    expect(quickDeckEvaluationRequestSchema.safeParse({
      schemaVersion: '1',
      source: { kind: 'HOST_ATTACHMENT', attachmentId: 'attachment-1' },
      slideCount: 1,
      visualDirection: '清晰的课堂信息图',
      imageModel: 'gemini-3-pro-image-preview',
    }).success).toBe(false)
    expect(quickDeckEvaluationRequestSchema.safeParse({
      schemaVersion: '1',
      source: { kind: 'TEXT', text: '这是用于验证 PPT 智能体快速生成能力的受控测试材料。'.repeat(3) },
      slideCount: 11,
      visualDirection: '清晰的课堂信息图',
      imageModel: 'gemini-3-pro-image-preview',
    }).success).toBe(false)
  })

  test('does not publish artifacts until a completed evaluation has every page', () => {
    expect(quickDeckEvaluationPublicJobSchema.parse(job())).toMatchObject({
      artifacts: { pptx: null, preview: null },
      quality: { state: 'NOT_ASSESSED', score: null },
    })
    expect(quickDeckEvaluationPublicJobSchema.safeParse({
      ...job(),
      artifacts: { pptx: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sha256: 'a'.repeat(64), byteLength: 1 }, preview: null },
    }).success).toBe(false)
    expect(quickDeckEvaluationPublicJobSchema.safeParse({
      ...job(),
      status: 'COMPLETED',
      phase: 'COMPLETE',
      progress: { planned: true, submittedPages: 1, completedPages: 1, totalPages: 1 },
      pages: [{ pageNumber: 1, status: 'COMPLETED', width: 1600, height: 900, aspectRatioValidated: true, sha256: 'b'.repeat(64) }],
      artifacts: {
        pptx: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sha256: 'a'.repeat(64), byteLength: 2_048 },
        preview: { mimeType: 'image/png', sha256: 'c'.repeat(64), byteLength: 1_024 },
      },
      completedAt: now,
      durationMs: 100,
    }).success).toBe(true)
  })

  test('keeps SSE events bounded and strongly typed', () => {
    expect(quickDeckEvaluationEventSchema.parse({
      schemaVersion: '1', jobId: 'quick-deck-eval-1', sequence: 1, eventId: 'event-1', occurredAt: now,
      type: 'images.progress', payload: { completedPages: 1, totalPages: 3 },
    })).toMatchObject({ type: 'images.progress' })
    expect(quickDeckEvaluationEventSchema.safeParse({
      schemaVersion: '1', jobId: 'quick-deck-eval-1', sequence: 1, eventId: 'event-1', occurredAt: now,
      type: 'images.progress', payload: { completedPages: 1, totalPages: 3, rawPrompt: 'must not leak' },
    }).success).toBe(false)
  })
})

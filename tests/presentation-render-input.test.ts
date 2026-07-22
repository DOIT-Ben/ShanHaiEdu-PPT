import { describe, expect, test } from 'bun:test'
import { MockArtifactPort, MockPresentationRendererPort } from '../src/adapters/mock-ports'
import { renderAndStoreSlidePreviews } from '../src/core/presentation-render-input'
import type { RunRecord } from '../src/core/ports'

const run: RunRecord = {
  id: 'run-cache', creationKey: 'create-cache', requestHash: 'request-cache',
  host: { tenantId: 'frameflow', externalUserId: 'teacher-1' },
  source: { kind: 'TEXT', text: '用于页面预览缓存测试的完整教材文本。' },
  slideCount: 2, visualDirection: '清晰课堂风格', imageModel: 'mock-image', automationLevel: 'SUPERVISED',
  maxRevisionRounds: 2, revisionRound: 0, qualityScore: null, status: 'PAGE_REVIEW', resumeState: null,
  version: 1, budgetUnits: 10, committedBudgetUnits: 2, qualityOverride: false,
  qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null, leaseUntil: null, leaseVersion: 0,
  createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
}

const blueprint = {
  id: 'blueprint-cache', title: '预览缓存', visualDirection: '清晰课堂风格',
  sourceManifest: [], sourceAssets: [], createdAt: '2026-07-23T00:00:00.000Z',
  curriculum: {
    subject: '科学', grade: '小学', lessonTitle: '预览缓存',
    sourceSummary: '这是一段用于测试页面预览缓存的完整课程摘要。',
    learningObjectives: ['验证页面预览复用'], scopeBoundaries: ['仅用于测试'],
    prohibitedExtensions: [], sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
  },
  slides: [1, 2].map((pageNumber) => ({
    pageNumber, title: `第 ${pageNumber} 页`, body: ['测试内容'], layout: pageNumber === 1 ? 'HERO' as const : 'SPLIT' as const,
    visualIntent: '使用清晰课堂画面验证预览缓存', visualPrompt: 'A clean classroom illustration without text or logos',
    sourceChunkIds: ['chunk-1'], sourceAssetIds: [],
  })),
}

describe('presentation render input', () => {
  test('reuses persisted slide previews for the same blueprint and artifacts', async () => {
    const artifacts = new MockArtifactPort()
    const renderer = new MockPresentationRendererPort()
    const sources = await Promise.all([1, 2].map((pageNumber) => artifacts.put({
      tenantId: 'frameflow', runId: run.id, name: `source-${pageNumber}.png`, mimeType: 'image/png',
      bytes: new TextEncoder().encode(`source-${pageNumber}`), idempotencyKey: `source-${pageNumber}`,
    })))
    const references = sources.map((source, index) => ({ pageNumber: index + 1, artifactId: source.artifactId }))
    const input = { artifacts, renderer, run, blueprint, references }

    const first = await renderAndStoreSlidePreviews(input)
    const replay = await renderAndStoreSlidePreviews(input)

    expect(replay).toEqual(first)
    expect(renderer.slidePreviewCalls).toBe(1)
  })
})

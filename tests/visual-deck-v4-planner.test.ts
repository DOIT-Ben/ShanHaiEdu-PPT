import { describe, expect, test } from 'bun:test'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'

describe('visual deck v4 mock planner', () => {
  test('compiles twelve source-grounded slide briefs from raw instruction and resolved sources', () => {
    const chunks = Array.from({ length: 4 }, (_, index) => ({
      id: `chunk-${index + 1}`,
      sourceId: index < 3 ? 'textbook' : 'design',
      text: `第${index + 1}段教材说明了核心概念、示例和课堂应用。`.repeat(4),
      sha256: String(index + 1).repeat(64),
    }))
    const blueprint = createVisualDeckV4Blueprint({
      runId: 'run-v4',
      inputHash: 'input-v4',
      source: {
        kind: 'SOURCE_PACKAGE',
        name: '百分数资料包',
        sources: [
          { kind: 'TEXT', sourceId: 'textbook', name: '教材.md', text: '教材原文'.repeat(20), roleHint: 'CONTENT_SOURCE' },
          { kind: 'TEXT', sourceId: 'design', name: '设计稿.md', text: '设计要求'.repeat(20), roleHint: 'DESIGN_REFERENCE' },
        ],
      },
      document: {
        name: '百分数资料包',
        chunks,
        sources: [
          { id: 'textbook', name: '教材.md', kind: 'MARKDOWN', status: 'READY' },
          { id: 'design', name: '设计稿.md', kind: 'MARKDOWN', status: 'READY' },
        ],
        isComplete: true,
        missingRanges: [],
      },
      config: {
        instruction: '为六年级学生制作一套理解百分数的视觉演示',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: {
          deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 12 }, aspectRatio: '16:9',
          audience: '小学六年级学生', focus: '理解百分数是统一比较标准', styleHint: '成熟清晰的课堂视觉叙事',
        },
      },
      slideCount: 12,
      visualDirection: '资料驱动的课堂信息图',
      createdAt: '2026-07-30T00:00:00.000Z',
    })

    const proposal = blueprint.visualDeckV4Proposal!
    expect(blueprint.renderMode).toBe('VISUAL_DECK_V4')
    expect(proposal.slideBriefs).toHaveLength(12)
    expect(new Set(proposal.slideBriefs.map((brief) => brief.title)).size).toBe(12)
    const availableChunks = new Set(chunks.map((chunk) => chunk.id))
    expect(proposal.slideBriefs.every((brief) =>
      brief.sourceChunkIds.length === 1 && brief.sourceChunkIds.every((id) => availableChunks.has(id)))).toBe(true)
    expect(proposal.sourceUnderstanding.sources).toMatchObject([
      { sourceId: 'textbook', role: 'CONTENT_SOURCE' },
      { sourceId: 'design', role: 'DESIGN_REFERENCE' },
    ])
    expect(proposal.presentationSpec.goal).toBe('为六年级学生制作一套理解百分数的视觉演示')
  })
})

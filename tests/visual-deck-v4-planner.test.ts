import { describe, expect, test } from 'bun:test'
import {
  compileVisualDeckV4Proposal,
  createVisualDeckV4Blueprint,
  createVisualDeckV4BlueprintFromProposal,
  normalizeVisualDeckV4SourceSpecRequestBinding,
} from '../src/core/visual-deck-v4-planner'

describe('visual deck v4 chain planner', () => {
  test('compiles one page as a SINGLE narrative with a hero blueprint slide', () => {
    const source = {
      kind: 'TEXT' as const,
      name: '水循环教材.txt',
      text: '太阳加热水面形成水汽，水汽凝结成云，降水回到地表，构成持续循环。'.repeat(4),
    }
    const blueprint = createVisualDeckV4Blueprint({
      runId: 'run-v4-single', inputHash: 'input-v4-single', source,
      document: {
        name: source.name,
        chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
        isComplete: true,
        missingRanges: [],
      },
      config: {
        instruction: '制作一张解释水循环核心关系的视觉演示页',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: {
          deckType: 'PRESENTER_SLIDES', language: 'zh-CN', length: { slideCount: 1 }, aspectRatio: '16:9',
          audience: '小学高年级学生', focus: '水循环的核心关系', styleHint: '清晰的自然科学信息图',
        },
      },
      slideCount: 1,
      visualDirection: '清晰的自然科学信息图',
      createdAt: '2026-08-07T00:00:00.000Z',
    })

    expect(blueprint.slides).toHaveLength(1)
    expect(blueprint.slides[0]).toMatchObject({ pageNumber: 1, layout: 'HERO' })
    expect(blueprint.visualDeckV4Proposal).toMatchObject({
      presentationSpec: { slideCount: 1 },
      deckPlan: { narrativeArc: ['在单页中建立主题、核心结论与主视觉'] },
      slideBriefs: [expect.objectContaining({ role: 'SINGLE', previousSlideRelation: null, nextSlideRelation: null })],
    })
  })

  test('rejects a model proposal that changes frozen request fields', () => {
    const source = {
      kind: 'TEXT' as const,
      name: '分数教材.txt',
      text: '把一个蛋糕平均分成两份，其中一份就是这个蛋糕的二分之一。'.repeat(4),
    }
    const base = {
      runId: 'run-v4-request-binding', inputHash: 'input-v4-request-binding', source,
      document: {
        name: source.name,
        chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
        isComplete: true,
        missingRanges: [],
      },
      config: {
        instruction: '为三年级学生制作一套认识二分之一的视觉演示',
        sourceMode: 'SOURCE_GROUNDED' as const,
        deckOptions: {
          deckType: 'DETAILED_DECK' as const, language: 'zh-CN', length: { slideCount: 2 },
          aspectRatio: '16:9' as const, audience: '小学三年级学生', focus: '平均分和二分之一',
          styleHint: '温暖的儿童绘本课堂视觉',
        },
      },
      slideCount: 2,
      visualDirection: '温暖的儿童绘本课堂视觉',
      createdAt: '2026-07-30T00:00:00.000Z',
    }
    const { compilerVersion: _compilerVersion, ...draft } = compileVisualDeckV4Proposal(base)

    expect(() => createVisualDeckV4BlueprintFromProposal(base, {
      ...draft,
      sourceUnderstanding: { ...draft.sourceUnderstanding, instruction: '模型擅自改写后的要求' },
    })).toThrow('VISUAL_DECK_V4_REQUEST_MISMATCH')
    expect(() => createVisualDeckV4BlueprintFromProposal({
      ...base,
      slideCount: 3,
      config: { ...base.config, deckOptions: { ...base.config.deckOptions, length: { slideCount: 3 } } },
    }, draft)).toThrow('VISUAL_DECK_V4_REQUEST_MISMATCH')

    const longTitle = '课堂允许文字'.repeat(30).slice(0, 120)
    const compiled = createVisualDeckV4BlueprintFromProposal(base, {
      ...draft,
      slideBriefs: draft.slideBriefs.map((brief, index) => index === 0 ? {
        ...brief,
        title: longTitle,
        lockedCopy: Array.from({ length: 8 }, (_, copyIndex) => `允许文字${copyIndex + 1}`),
      } : brief),
    })
    expect(compiled.slides[0]?.title).toHaveLength(120)
    expect(compiled.slides[0]?.body).toHaveLength(8)
    expect(compiled.visualDeckV4Proposal?.slideBriefs[0]?.title).toBe(longTitle)
    expect(compiled.visualDeckV4Proposal?.slideBriefs[0]?.lockedCopy).toHaveLength(8)
  })

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

  test('binds omitted audience goal and focus to deterministic request defaults', () => {
    const source = {
      kind: 'TEXT' as const,
      name: '百分数教材.md',
      text: '百分数表示一个数是另一个数的百分之几。'.repeat(4),
    }
    const input = {
      runId: 'run-v4-default-binding', inputHash: 'input-v4-default-binding', source,
      document: {
        name: source.name,
        chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
        isComplete: true,
        missingRanges: [],
      },
      config: {
        instruction: '制作一套介绍百分数的课堂演示',
        sourceMode: 'SOURCE_GROUNDED' as const,
        deckOptions: {
          deckType: 'DETAILED_DECK' as const, language: 'zh-CN', length: { slideCount: 2 },
          aspectRatio: '16:9' as const,
        },
      },
      slideCount: 2,
      visualDirection: '清晰课堂信息图',
      createdAt: '2026-08-03T00:00:00.000Z',
    }
    const compiled = compileVisualDeckV4Proposal(input)
    const normalized = normalizeVisualDeckV4SourceSpecRequestBinding(input, {
      sourceUnderstanding: compiled.sourceUnderstanding,
      presentationSpec: {
        ...compiled.presentationSpec,
        audience: '模型擅自指定的受众',
        goal: '模型擅自改变的目标',
        focus: ['模型擅自改变的重点'],
      },
    })

    expect(normalized.presentationSpec).toMatchObject({
      audience: '需要理解本主题的学习者',
      goal: input.config.instruction,
      focus: ['围绕《百分数教材》建立清晰理解'],
    })
  })
})

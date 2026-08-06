import { describe, expect, test } from 'bun:test'
import {
  ManuscriptCompiler,
  SourceEvidenceResolver,
  V4ManuscriptCompilationError,
  V4PlanCompiler,
} from '../src/core/v4-manuscript-compiler'
import { visualDeckV4CreativeManuscriptSchema, visualDeckV4ReviewManuscriptSchema } from '../src/visual-deck-v4-contracts'

function input(slideCount = 1) {
  const text = '太阳加热水面形成水汽，水汽凝结成云，降水回到地面，构成持续循环。'
  return {
    runId: 'run-manuscript',
    inputHash: 'input-manuscript',
    source: { kind: 'TEXT' as const, name: '水循环.txt', text: text.repeat(4) },
    document: {
      name: '水循环.txt',
      chunks: [{ id: 'chunk-1', text: text.repeat(2), sha256: 'a'.repeat(64) }],
      isComplete: true,
      missingRanges: [],
    },
    config: {
      instruction: '制作水循环核心关系的视觉演示',
      sourceMode: 'SOURCE_GROUNDED' as const,
      deckOptions: {
        deckType: 'PRESENTER_SLIDES' as const,
        language: 'zh-CN',
        length: { slideCount },
        aspectRatio: '16:9' as const,
        audience: '小学高年级学生',
        focus: '水循环关系',
        styleHint: '清晰的自然科学信息图',
      },
    },
    slideCount,
    visualDirection: '清晰的自然科学信息图',
    compilerVersion: 'visual-deck-v4-chain-4',
    createdAt: '2026-08-07T00:00:00.000Z',
  }
}

function manuscript(slideCount = 1) {
  const excerpt = '太阳加热水面形成水汽，水汽凝结成云'
  const slides = Array.from({ length: slideCount }, (_, index) => ({
    title: index === 0 ? '水循环' : `水循环阶段${index + 1}`,
    narrative: '水在自然界中持续经历蒸发、凝结和降水，形成循环。',
    userVisibleCopy: [index === 0 ? '水循环' : `阶段${index + 1}`, '水不断循环'],
    factualStatements: ['太阳加热水面形成水汽', '水汽凝结成云'],
    visualDescription: '用一个连续、清晰的自然场景表现水汽、云和降水的关系',
    sourceEvidence: [{ excerpt }],
  }))
  return { title: '水循环', narrative: ['建立水循环主题', '解释循环关系'], slides }
}

describe('V4 chain-4 semantic manuscript compiler', () => {
  test('compiles semantic output into deterministic page and role controls', () => {
    const base = input()
    const creative = visualDeckV4CreativeManuscriptSchema.parse(manuscript())
    const review = visualDeckV4ReviewManuscriptSchema.parse({ ...creative, revisionSuggestions: [] })
    const proposal = new ManuscriptCompiler().compilePlan(base, creative, review)

    expect(proposal.deckPlan.title).toBe('水循环')
    expect(proposal.slideBriefs).toHaveLength(1)
    expect(proposal.slideBriefs[0]).toMatchObject({
      pageNumber: 1,
      role: 'SINGLE',
      sourceChunkIds: ['chunk-1'],
    })
    expect(JSON.stringify(proposal)).not.toContain('sourceEvidence')
    expect(JSON.stringify(proposal)).not.toContain('pageIndex')
  })

  test('rejects an evidence excerpt that is not present in trusted chunks', () => {
    const resolver = new SourceEvidenceResolver()
    expect(() => resolver.resolve({
      sourceMode: 'SOURCE_GROUNDED',
      evidence: [{ excerpt: '不存在于资料中的句子' }],
      chunks: input().document.chunks,
    })).toThrow(V4ManuscriptCompilationError)
  })

  test('schema rejects runtime control fields in model output', () => {
    expect(() => visualDeckV4CreativeManuscriptSchema.parse({
      ...manuscript(),
      slides: [{ ...manuscript().slides[0], pageNumber: 1, role: 'SINGLE', sourceChunkId: 'chunk-1' }],
    })).toThrow()
  })

  test('requires one semantic slot per requested page', () => {
    const base = input(2)
    const creative = visualDeckV4CreativeManuscriptSchema.parse(manuscript(2))
    const review = visualDeckV4ReviewManuscriptSchema.parse({ ...creative, slides: creative.slides.slice(0, 1), revisionSuggestions: [] })
    expect(() => new V4PlanCompiler().compile(base, review)).toThrow('V4_MANUSCRIPT_SLIDE_COUNT_MISMATCH')
  })
})

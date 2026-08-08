import { describe, expect, test } from 'bun:test'
import {
  ManuscriptCompiler,
  SourceEvidenceResolver,
  V4ManuscriptCompilationError,
  V4PlanCompiler,
} from '../src/core/v4-manuscript-compiler'
import { createVisualDeckV4BlueprintFromProposal } from '../src/core/visual-deck-v4-planner'
import {
  assertVisualDeckV4ManuscriptCharacterLimit,
  VISUAL_DECK_V4_MANUSCRIPT_MAX_CHARACTERS,
  visualDeckV4CreativeManuscriptSchema,
  visualDeckV4ReviewManuscriptSchema,
} from '../src/visual-deck-v4-contracts'

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

function oversizedManuscript() {
  return {
    title: '标题'.repeat(80),
    narrative: Array.from({ length: 20 }, () => '叙事'.repeat(250)),
    slides: Array.from({ length: 5 }, () => ({
      title: '页'.repeat(160),
      narrative: '叙'.repeat(1_200),
      userVisibleCopy: Array.from({ length: 8 }, () => '文'.repeat(500)),
      factualStatements: Array.from({ length: 20 }, () => '事'.repeat(500)),
      visualDescription: '视'.repeat(1_500),
      sourceEvidence: Array.from({ length: 8 }, () => ({ excerpt: '证'.repeat(1_200) })),
    })),
  }
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

  test('rejects every known placeholder form while keeping short meaningful descriptions valid', () => {
    for (const visualDescription of [
      '...', '…', '待补全', '待补全。', 'TBD: ...', '暂无', 'N/A。', 'N-A', 'N–A', 'N—A', '???',
    ]) {
      const invalid = {
        ...manuscript(),
        slides: [{ ...manuscript().slides[0]!, visualDescription }],
      }
      expect(() => visualDeckV4CreativeManuscriptSchema.parse(invalid)).toThrow(
        'semantic manuscript content cannot be a placeholder',
      )
    }
    expect(() => visualDeckV4CreativeManuscriptSchema.parse({
      ...manuscript(),
      slides: [{ ...manuscript().slides[0]!, visualDescription: '水面、云和降水' }],
    })).not.toThrow()
  })

  test('derives a valid blueprint visual intent from a short meaningful semantic description', () => {
    const base = input()
    const creative = visualDeckV4CreativeManuscriptSchema.parse(manuscript())
    const review = visualDeckV4ReviewManuscriptSchema.parse({
      ...creative,
      slides: [{ ...creative.slides[0]!, visualDescription: '水面、云和降水' }],
      revisionSuggestions: [],
    })
    const proposal = new ManuscriptCompiler().compilePlan(base, creative, review)
    const blueprint = createVisualDeckV4BlueprintFromProposal(base, proposal)

    expect(blueprint.slides[0]?.visualIntent.length).toBeGreaterThanOrEqual(10)
  })

  test('rejects an evidence excerpt that is not present in trusted chunks', () => {
    const resolver = new SourceEvidenceResolver()
    expect(() => resolver.resolve({
      sourceMode: 'SOURCE_GROUNDED',
      evidence: [{ excerpt: '不存在于资料中的句子' }],
      chunks: input().document.chunks,
    })).toThrow(V4ManuscriptCompilationError)
  })

  test('rejects an evidence excerpt that ambiguously matches multiple trusted chunks', () => {
    const resolver = new SourceEvidenceResolver()
    expect(() => resolver.resolve({
      sourceMode: 'SOURCE_GROUNDED',
      evidence: [{ excerpt: '太阳加热水面形成水汽' }],
      chunks: [
        { id: 'chunk-1', text: '太阳加热水面形成水汽，随后凝结。', sha256: 'a'.repeat(64) },
        { id: 'chunk-2', text: '教材再次说明太阳加热水面形成水汽。', sha256: 'b'.repeat(64) },
      ],
    })).toThrow('V4_MANUSCRIPT_SOURCE_EVIDENCE_AMBIGUOUS')
  })

  test('does not treat different formula operators as the same source evidence', () => {
    const resolver = new SourceEvidenceResolver()
    expect(() => resolver.resolve({
      sourceMode: 'SOURCE_GROUNDED',
      evidence: [{ excerpt: '公式 5-2=7' }],
      chunks: [{ id: 'chunk-1', text: '公式 5+2=7', sha256: 'a'.repeat(64) }],
    })).toThrow('V4_MANUSCRIPT_SOURCE_EVIDENCE_UNRESOLVED')
  })

  test('schema rejects runtime control fields in model output', () => {
    expect(() => visualDeckV4CreativeManuscriptSchema.parse({
      ...manuscript(),
      slides: [{ ...manuscript().slides[0], pageNumber: 1, role: 'SINGLE', sourceChunkId: 'chunk-1' }],
    })).toThrow()
  })

  test('rejects aggregate semantic manuscripts before deterministic compilation', () => {
    const creative = oversizedManuscript()
    const review = { ...creative, revisionSuggestions: Array.from({ length: 50 }, () => '建议'.repeat(500)) }

    expect(JSON.stringify(creative).length).toBeGreaterThan(VISUAL_DECK_V4_MANUSCRIPT_MAX_CHARACTERS)
    expect(() => visualDeckV4CreativeManuscriptSchema.parse(creative)).toThrow('V4_MANUSCRIPT_CONTEXT_TOO_LARGE')
    expect(() => visualDeckV4ReviewManuscriptSchema.parse(review)).toThrow('V4_MANUSCRIPT_CONTEXT_TOO_LARGE')
    expect(() => assertVisualDeckV4ManuscriptCharacterLimit(creative)).toThrow('V4_MANUSCRIPT_CONTEXT_TOO_LARGE')
    expect(() => new ManuscriptCompiler().compilePlan(input(5), creative as never, review as never))
      .toThrow('V4_MANUSCRIPT_CONTEXT_TOO_LARGE')
    expect(() => new V4PlanCompiler().compile(input(5), review as never)).toThrow('V4_MANUSCRIPT_CONTEXT_TOO_LARGE')
  })

  test('requires one semantic slot per requested page', () => {
    const base = input(2)
    const creative = visualDeckV4CreativeManuscriptSchema.parse(manuscript(2))
    const review = visualDeckV4ReviewManuscriptSchema.parse({ ...creative, slides: creative.slides.slice(0, 1), revisionSuggestions: [] })
    expect(() => new V4PlanCompiler().compile(base, review)).toThrow('V4_MANUSCRIPT_SLIDE_COUNT_MISMATCH')
  })
})

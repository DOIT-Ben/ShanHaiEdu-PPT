import { describe, expect, test } from 'bun:test'
import {
  normalizeVisualDeckV4RequestFocus,
  normalizeVisualDeckV4VisibleReferences,
  visualDeckV4DeckManifestSchema,
  visualDeckV4ProposalSchema,
  visualDeckV4SlideBriefsStageSchema,
} from '../src/visual-deck-v4-contracts'
import { presentationBlueprintSchema } from '../src/presentation-contracts'

function proposal() {
  return {
    compilerVersion: 'visual-deck-v4-chain-1',
    sourceUnderstanding: {
      sourceMode: 'SOURCE_GROUNDED' as const,
      instruction: '根据教材制作一套适合课堂讲解的百分数视觉演示',
      sources: [{
        sourceId: 'textbook', name: '百分数教材', role: 'CONTENT_SOURCE' as const,
        confidence: 1, status: 'READY' as const, sourceChunkIds: ['chunk-1', 'chunk-2'],
      }],
      missingRanges: [],
    },
    presentationSpec: {
      sourceMode: 'SOURCE_GROUNDED' as const,
      deckType: 'PRESENTER_SLIDES' as const,
      language: 'zh-CN', audience: '小学六年级学生', goal: '理解百分数提供的统一比较标准',
      slideCount: 2, focus: ['从生活比较过渡到每一百份的统一标准'],
      style: '成熟、清晰、适合课堂投影的视觉叙事',
      requiredCoverage: ['生活比较问题', '百分数的核心意义'], forbidden: ['脱离教材扩写'],
    },
    deckPlan: {
      title: '百分数：统一比较的语言', slideCount: 2,
      narrativeArc: ['用不公平比较制造认知冲突', '建立每一百份的统一标准'],
      chapters: [
        { chapterId: 'problem', title: '为什么不能直接比较', purpose: '建立问题', slideNumbers: [1] },
        { chapterId: 'concept', title: '统一成每一百份', purpose: '建立概念', slideNumbers: [2] },
      ],
    },
    slideBriefs: [1, 2].map((pageNumber) => ({
      pageNumber,
      role: pageNumber === 1 ? 'COVER' as const : 'EXPLANATION' as const,
      title: pageNumber === 1 ? '怎样公平比较？' : '统一成每100份',
      keyClaim: pageNumber === 1 ? '不同总数不能只比较命中次数' : '百分数提供统一比较标准',
      audienceTakeaway: '观察比较标准如何影响结论',
      lockedCopy: [pageNumber === 1 ? '怎样公平比较？' : '每100份中的数量'],
      facts: ['教材中的百分数概念'], numbers: pageNumber === 2 ? ['100'] : [], formulas: [],
      sourceChunkIds: [`chunk-${pageNumber}`],
      visualMetaphor: '不同大小的计分板逐步归一到百格板',
      composition: '单一主视觉焦点，标题与关系图形成清晰层级',
      informationHierarchy: ['核心问题', '视觉关系', '结论'],
      previousSlideRelation: pageNumber === 1 ? null : '承接比较问题',
      nextSlideRelation: pageNumber === 2 ? null : '进入统一标准',
    })),
    visualContract: {
      artDirection: '成熟的课堂信息图与生活场景融合', palette: ['#F7F8F3', '#235789', '#F4B942'],
      typography: '清晰中文标题和低密度正文', medium: '编辑插画与数据场景', visualDensity: 'LOW' as const,
      compositionRules: ['每页一个主要焦点', '关键关系优先于装饰'],
      continuityRules: ['保持百格板视觉母题', '保持统一色彩和材质'], forbidden: ['科幻界面', '无关装饰'],
    },
  }
}

describe('visual deck v4 contracts', () => {
  test('accepts a complete source-grounded proposal', () => {
    expect(visualDeckV4ProposalSchema.parse(proposal()).slideBriefs).toHaveLength(2)
  })

  test('rejects incomplete chapter coverage and invented source chunks', () => {
    const invalidCoverage = proposal()
    invalidCoverage.deckPlan.chapters[1]!.slideNumbers = [1]
    expect(() => visualDeckV4ProposalSchema.parse(invalidCoverage)).toThrow()

    const inventedSource = proposal()
    inventedSource.slideBriefs[1]!.sourceChunkIds = ['invented']
    expect(() => visualDeckV4ProposalSchema.parse(inventedSource)).toThrow()

    const tooMuchCopy = proposal()
    tooMuchCopy.slideBriefs[0]!.lockedCopy = Array.from({ length: 9 }, (_, index) => `第${index + 1}条文字`)
    expect(() => visualDeckV4ProposalSchema.parse(tooMuchCopy)).toThrow()

    const inventedVisibleNumber = proposal()
    inventedVisibleNumber.slideBriefs[0]!.numbers = ['2']
    expect(() => visualDeckV4ProposalSchema.parse(inventedVisibleNumber)).toThrow()

    const unboundedCriticalContent = proposal()
    unboundedCriticalContent.slideBriefs[0]!.facts = Array.from(
      { length: 20 },
      (_, index) => `来源事实${index + 1}：${'必须完整进入图片生成提示词。'.repeat(40)}`.slice(0, 500),
    )
    expect(() => visualDeckV4ProposalSchema.parse(unboundedCriticalContent))
      .toThrow('v4 critical slide content exceeds the lossless image prompt budget')

    const repairPromptOverflow = proposal()
    repairPromptOverflow.visualContract.continuityRules = Array.from(
      { length: 12 },
      (_, index) => `连续性规则${index + 1}：${'必须保留的视觉约束。'.repeat(30)}`.slice(0, 300),
    )
    repairPromptOverflow.visualContract.forbidden = Array.from(
      { length: 20 },
      (_, index) => `视觉禁项${index + 1}：${'不得出现在修订图片中。'.repeat(30)}`.slice(0, 300),
    )
    repairPromptOverflow.presentationSpec.forbidden = Array.from(
      { length: 20 },
      (_, index) => `课件禁项${index + 1}：${'不得改变教材范围。'.repeat(30)}`.slice(0, 300),
    )
    expect(() => visualDeckV4ProposalSchema.parse(repairPromptOverflow))
      .toThrow('v4 repair image constraints exceed the lossless image prompt budget')
  })

  test('removes only number and formula references that are absent from visible copy', () => {
    const stage = visualDeckV4SlideBriefsStageSchema.parse({
      slideBriefs: proposal().slideBriefs.map((slide) => ({ ...slide })),
    })
    stage.slideBriefs[0] = {
      ...stage.slideBriefs[0]!,
      title: '互动练习：百分数小达人',
      lockedCopy: [
        '第1关：读写——把“百分之四十点五”写成百分数；把72%读出来。',
        '第2关：说意义——一件商品降价20%，这里的20%表示什么？',
        '第3关：互化——0.35=（ ）%；4/5=（ ）%。',
        '第4关：判断——“六（1）班今天来了48人，出勤率是48%。”这句话对吗？为什么？',
      ],
      numbers: ['40.5', '72%', '20%', '0.35', '4/5', '48', '48%', '4'],
      formulas: ['0.35=（ ）%', '40.5%'],
    }

    const normalized = normalizeVisualDeckV4VisibleReferences(stage)

    expect(normalized.slideBriefs[0]?.numbers).toEqual(['72%', '20%', '0.35', '4/5', '48', '48%', '4'])
    expect(normalized.slideBriefs[0]?.formulas).toEqual(['0.35=（ ）%'])
    expect(normalized.slideBriefs[0]?.lockedCopy).toEqual(stage.slideBriefs[0]?.lockedCopy)
    expect(stage.slideBriefs[0]?.numbers).toContain('40.5')
    expect(() => visualDeckV4ProposalSchema.parse({
      ...proposal(),
      slideBriefs: normalized.slideBriefs,
    })).not.toThrow()
  })

  test('preserves the exact requested focus when the model splits it into separate items', () => {
    const value = proposal()
    const requestFocus = '准确计数；分成两个非空组；按顺序操作；不引入加减法'
    const normalized = normalizeVisualDeckV4RequestFocus({
      sourceUnderstanding: value.sourceUnderstanding,
      presentationSpec: {
        ...value.presentationSpec,
        focus: ['准确计数', '分成两个非空组', '按顺序操作', '不引入加减法'],
      },
    }, requestFocus)

    expect(normalized.presentationSpec.focus).toEqual([
      requestFocus, '准确计数', '分成两个非空组', '按顺序操作', '不引入加减法',
    ])
  })

  test('accepts only ordered rendered slides in a v4 manifest', () => {
    const manifest = {
      schemaVersion: '1', runId: 'run-v4', presentationMode: 'VISUAL_DECK_V4',
      compilerVersion: 'visual-deck-v4-chain-1', proposalHash: 'a'.repeat(64),
      slides: [1, 2].map((pageNumber) => ({
        pageNumber, strategy: 'FULL_GENERATIVE', artifactId: `slide-${pageNumber}`,
        sha256: String(pageNumber).repeat(64), revision: 0, qualityStatus: 'APPROVED',
      })),
      createdAt: '2026-07-30T00:00:00.000Z',
    }
    expect(visualDeckV4DeckManifestSchema.parse(manifest).slides).toHaveLength(2)
    manifest.slides.reverse()
    expect(() => visualDeckV4DeckManifestSchema.parse(manifest)).toThrow()
  })

  test('binds a v4 proposal to the compatible persisted blueprint', () => {
    const parsedProposal = visualDeckV4ProposalSchema.parse(proposal())
    const blueprint = {
      id: 'blueprint-v4',
      title: parsedProposal.deckPlan.title,
      visualDirection: parsedProposal.visualContract.artDirection,
      renderMode: 'VISUAL_DECK_V4' as const,
      visualDeckV4Proposal: parsedProposal,
      sourceManifest: [],
      sourceAssets: [],
      createdAt: '2026-07-30T00:00:00.000Z',
      curriculum: {
        subject: null,
        grade: null,
        lessonTitle: parsedProposal.deckPlan.title,
        sourceSummary: '这是一份用于验证V4规划工件持久化和来源绑定关系的完整资料摘要。',
        learningObjectives: [parsedProposal.presentationSpec.goal],
        scopeBoundaries: ['只使用已经绑定的来源资料'],
        prohibitedExtensions: [],
        sourceChunkIds: ['chunk-1', 'chunk-2'],
      },
      slides: parsedProposal.slideBriefs.map((brief) => ({
        pageNumber: brief.pageNumber,
        title: brief.title,
        body: brief.lockedCopy,
        layout: brief.pageNumber === 1 ? 'HERO' as const : 'STATEMENT' as const,
        visualIntent: brief.visualMetaphor,
        visualPrompt: `V4执行阶段只允许编译当前第${brief.pageNumber}页的独立视觉请求。`,
        sourceChunkIds: brief.sourceChunkIds,
      })),
    }

    expect(presentationBlueprintSchema.parse(blueprint).visualDeckV4Proposal?.slideBriefs).toHaveLength(2)
    expect(() => presentationBlueprintSchema.parse({ ...blueprint, visualDeckV4Proposal: undefined })).toThrow()
    expect(() => presentationBlueprintSchema.parse({ ...blueprint, renderMode: 'SLIDE_IMAGE_V2' })).toThrow()
  })
})

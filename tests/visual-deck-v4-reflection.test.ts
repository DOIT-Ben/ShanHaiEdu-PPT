import { describe, expect, test } from 'bun:test'
import { compileVisualDeckV4Proposal } from '../src/core/visual-deck-v4-planner'
import {
  deckCriticResultSchema,
  deckOptimizerResultSchema,
  slideCriticResultSchema,
  slideOptimizerResultSchema,
  type SlideOptimizerResult,
} from '../src/core/v4-reflection/contracts'
import { applyDeckOptimizerResult, bindDeckCriticIssues } from '../src/core/v4-reflection/deck'
import { ReflectionContractError } from '../src/core/v4-reflection/diagnostics'
import { applySlideOptimizerResult, bindSlideCriticIssues } from '../src/core/v4-reflection/slides'

function proposal() {
  return compileVisualDeckV4Proposal({
    runId: 'run-reflection-chain-3',
    inputHash: 'reflection-chain-3-input',
    source: {
      kind: 'TEXT', name: '分与合教材.txt',
      text: '把五个圆片分成两个非空组，可以分成一和四，也可以分成二和三。',
    },
    document: {
      name: '分与合教材.txt',
      chunks: [{
        id: 'chunk-1',
        text: '把五个圆片分成两个非空组，可以分成一和四，也可以分成二和三。',
        sha256: 'a'.repeat(64),
      }],
      isComplete: true,
      missingRanges: [],
    },
    config: {
      instruction: '为一年级学生制作五以内数的分与合课堂演示',
      sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 3 }, aspectRatio: '16:9',
        audience: '小学一年级学生', focus: '五个圆片分成两个非空组', styleHint: '清晰活泼的课堂信息图',
      },
    },
    slideCount: 3,
    visualDirection: '清晰活泼的课堂信息图',
    createdAt: '2026-08-03T00:00:00.000Z',
  })
}

function emptyDeckOptimizer() {
  return {
    titleChanges: [],
    narrativeArcChanges: [],
    artDirectionChanges: [],
    paletteChanges: [],
    typographyChanges: [],
    mediumChanges: [],
    visualDensityChanges: [],
    compositionRuleChanges: [],
    continuityRuleChanges: [],
    forbiddenChanges: [],
  }
}

function emptySlideOptimizer(): SlideOptimizerResult {
  return {
    roleChanges: [],
    visualMetaphorChanges: [],
    compositionChanges: [],
    informationHierarchyChanges: [],
    previousSlideRelationChanges: [],
    nextSlideRelationChanges: [],
  }
}

describe('visual deck v4 chain-3 reflection contracts', () => {
  test('keeps both Critics findings-only and rejects model-owned identities or artifacts', () => {
    expect(deckCriticResultSchema.parse({ issues: [] })).toEqual({ issues: [] })
    expect(slideCriticResultSchema.parse({ issues: [] })).toEqual({ issues: [] })

    for (const forbidden of [
      'decision', 'checks', 'candidateHash', 'reviewContextHash', 'rubricVersion', 'appliedIssueIds',
      'revisedArtifact', 'revisedSlides', 'audit',
    ]) {
      expect(deckCriticResultSchema.safeParse({ issues: [], [forbidden]: 'model-owned' }).success).toBe(false)
      expect(slideCriticResultSchema.safeParse({ issues: [], [forbidden]: 'model-owned' }).success).toBe(false)
    }
  })

  test('uses separate Deck and Slide issue contracts instead of one universal risk schema', () => {
    expect(deckCriticResultSchema.parse({
      issues: [{
        pageNumbers: [2, 3],
        category: 'CROSS_SLIDE_REPETITION',
        field: 'deckPlan.narrativeArc',
        problem: '第2和第3页承担相同解释任务，叙事没有推进',
        desiredChange: '第2页解释概念，第3页改为对比应用',
      }],
    }).issues).toHaveLength(1)
    expect(slideCriticResultSchema.parse({
      issues: [{
        pageNumber: 2,
        category: 'COUNTABILITY_RISK',
        field: 'composition',
        problem: '底部聚拢提示可能形成第三组圆片',
        desiredChange: '只保留两个非空组，不重复绘制圆片',
      }],
    }).issues).toHaveLength(1)

    expect(deckCriticResultSchema.safeParse({
      issues: [{
        pageNumbers: [1], category: 'NARRATIVE_BREAK', field: 'deckPlan.chapters',
        problem: '试图改写完整章节结构', desiredChange: '重写全部章节',
      }],
    }).success).toBe(false)
    expect(slideCriticResultSchema.safeParse({
      issues: [{
        pageNumber: 2, category: 'COMPOSITION_AMBIGUITY', field: 'title',
        problem: '试图改写冻结标题', desiredChange: '改标题',
      }],
    }).success).toBe(false)
  })

  test('accepts only fixed per-field Optimizer arrays and never complete candidates', () => {
    expect(deckOptimizerResultSchema.parse(emptyDeckOptimizer())).toEqual(emptyDeckOptimizer())
    expect(slideOptimizerResultSchema.parse(emptySlideOptimizer())).toEqual(emptySlideOptimizer())
    expect(deckOptimizerResultSchema.safeParse({
      ...emptyDeckOptimizer(), chapterChanges: [],
    }).success).toBe(false)
    expect(deckOptimizerResultSchema.safeParse({
      ...emptyDeckOptimizer(), revisedArtifact: {},
    }).success).toBe(false)
    expect(slideOptimizerResultSchema.safeParse({
      ...emptySlideOptimizer(), revisedSlides: [],
    }).success).toBe(false)
  })

  test('binds Deck issue ids in the backend and applies only an authorized field value', () => {
    const value = proposal()
    const candidate = { deckPlan: value.deckPlan, visualContract: value.visualContract }
    const issues = bindDeckCriticIssues({
      candidate,
      result: deckCriticResultSchema.parse({
        issues: [{
          pageNumbers: [2, 3],
          category: 'CROSS_SLIDE_REPETITION',
          field: 'deckPlan.narrativeArc',
          problem: '中间两页缺少叙事推进',
          desiredChange: '按概念、对比、应用推进',
        }],
      }),
    })
    expect(issues[0]?.issueId).toMatch(/^reflection-issue-[a-f0-9]{24}$/)

    const revisedArc = ['情境导入', '解释分与合', '比较并应用']
    const revised = applyDeckOptimizerResult({
      candidate,
      expectedSlideCount: value.presentationSpec.slideCount,
      issues,
      result: deckOptimizerResultSchema.parse({
        ...emptyDeckOptimizer(),
        narrativeArcChanges: [{ issueIds: [issues[0]!.issueId], value: revisedArc }],
      }),
    })
    expect(revised.deckPlan.narrativeArc).toEqual(revisedArc)
    expect(revised.deckPlan.chapters).toEqual(candidate.deckPlan.chapters)
    expect(revised.visualContract).toEqual(candidate.visualContract)
  })

  test('rejects Deck no-op, unknown issue, duplicate ownership and frozen slide-count mismatch', () => {
    const value = proposal()
    const candidate = { deckPlan: value.deckPlan, visualContract: value.visualContract }
    const issues = bindDeckCriticIssues({
      candidate,
      result: deckCriticResultSchema.parse({
        issues: [{
          pageNumbers: [1, 2, 3], category: 'VISUAL_INCONSISTENCY',
          field: 'visualContract.compositionRules', problem: '页面构图规则不统一',
          desiredChange: '统一每页单一主焦点',
        }],
      }),
    })
    const issueId = issues[0]!.issueId

    expect(() => applyDeckOptimizerResult({
      candidate, expectedSlideCount: 3, issues,
      result: deckOptimizerResultSchema.parse({
        ...emptyDeckOptimizer(),
        compositionRuleChanges: [{ issueIds: [issueId], value: candidate.visualContract.compositionRules }],
      }),
    })).toThrow(ReflectionContractError)
    expect(() => applyDeckOptimizerResult({
      candidate, expectedSlideCount: 3, issues,
      result: deckOptimizerResultSchema.parse({
        ...emptyDeckOptimizer(),
        compositionRuleChanges: [{ issueIds: ['reflection-issue-unknown'], value: ['一页一焦点', '避免重复'] }],
      }),
    })).toThrow(ReflectionContractError)
    expect(deckOptimizerResultSchema.safeParse({
      ...emptyDeckOptimizer(),
      compositionRuleChanges: [
        { issueIds: [issueId], value: ['一页一焦点', '避免重复'] },
        { issueIds: [issueId], value: ['另一套规则', '仍然重复'] },
      ],
    }).success).toBe(false)
    expect(() => bindDeckCriticIssues({
      candidate,
      expectedSlideCount: 4,
      result: deckCriticResultSchema.parse({ issues: [] }),
    })).toThrow(ReflectionContractError)
  })

  test('applies one Slide field per backend-bound issue and preserves all frozen teaching content', () => {
    const value = proposal()
    const candidate = { slideBriefs: value.slideBriefs }
    const issues = bindSlideCriticIssues({
      candidate,
      result: slideCriticResultSchema.parse({
        issues: [{
          pageNumber: 2, category: 'COUNTABILITY_RISK', field: 'composition',
          problem: '存在重复圆片集合风险', desiredChange: '只保留一个权威集合',
        }],
      }),
    })
    const revisedComposition = '只绘制一个五圆片权威集合，用空间分隔表达两个非空组'
    const revised = applySlideOptimizerResult({
      candidate,
      proposalContext: {
        sourceUnderstanding: value.sourceUnderstanding,
        presentationSpec: value.presentationSpec,
        deckPlan: value.deckPlan,
        visualContract: value.visualContract,
      },
      issues,
      result: slideOptimizerResultSchema.parse({
        ...emptySlideOptimizer(),
        compositionChanges: [{
          issueIds: [issues[0]!.issueId], pageNumber: 2, value: revisedComposition,
        }],
      }),
    })

    expect(revised.slideBriefs[1]?.composition).toBe(revisedComposition)
    expect(revised.slideBriefs[0]).toEqual(candidate.slideBriefs[0])
    for (const field of [
      'title', 'keyClaim', 'audienceTakeaway', 'lockedCopy', 'facts', 'numbers', 'formulas', 'sourceChunkIds',
    ] as const) {
      expect(revised.slideBriefs[1]?.[field]).toEqual(candidate.slideBriefs[1]?.[field])
    }
  })

  test('rejects Slide page/field scope violations, no-op and missing issue coverage', () => {
    const value = proposal()
    const candidate = { slideBriefs: value.slideBriefs }
    const issues = bindSlideCriticIssues({
      candidate,
      result: slideCriticResultSchema.parse({
        issues: [{
          pageNumber: 2, category: 'COMPOSITION_AMBIGUITY', field: 'composition',
          problem: '构图关系不清楚', desiredChange: '明确主体和空间关系',
        }],
      }),
    })
    const proposalContext = {
      sourceUnderstanding: value.sourceUnderstanding,
      presentationSpec: value.presentationSpec,
      deckPlan: value.deckPlan,
      visualContract: value.visualContract,
    }
    const apply = (result: ReturnType<typeof emptySlideOptimizer>) => applySlideOptimizerResult({
      candidate, proposalContext, issues, result: slideOptimizerResultSchema.parse(result),
    })

    expect(() => apply(emptySlideOptimizer())).toThrow(ReflectionContractError)
    expect(() => apply({
      ...emptySlideOptimizer(),
      compositionChanges: [{
        issueIds: [issues[0]!.issueId], pageNumber: 3, value: '错误页面的构图修改',
      }],
    })).toThrow(ReflectionContractError)
    expect(() => apply({
      ...emptySlideOptimizer(),
      compositionChanges: [{
        issueIds: [issues[0]!.issueId], pageNumber: 2, value: candidate.slideBriefs[1]!.composition,
      }],
    })).toThrow(ReflectionContractError)
  })
})

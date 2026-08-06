import { describe, expect, test } from 'bun:test'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { visualDeckV4GenerationPlan } from '../src/visual-deck-v4-generation-plan'

describe('visual deck v4 user generation plan', () => {
  test('presents the approved proposal in plain user-facing language without internal prompt fields', () => {
    const source = {
      kind: 'TEXT' as const,
      name: '分数教材.txt',
      text: '把一个蛋糕平均分成两份，其中的一份就是这个蛋糕的二分之一。'.repeat(4),
    }
    const blueprint = createVisualDeckV4Blueprint({
      runId: 'run-user-plan', inputHash: 'input-user-plan', source,
      document: {
        name: source.name,
        chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
        isComplete: true,
        missingRanges: [],
      },
      config: {
        instruction: '制作一套让三年级学生理解二分之一的课堂PPT',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: {
          deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 3 }, aspectRatio: '16:9',
          audience: '小学三年级学生', focus: '平均分和二分之一', styleHint: '温暖的儿童绘本课堂视觉',
        },
      },
      slideCount: 3,
      visualDirection: '温暖的儿童绘本课堂视觉',
      createdAt: '2026-07-30T00:00:00.000Z',
    })

    const plan = visualDeckV4GenerationPlan(blueprint.visualDeckV4Proposal!)
    expect(plan).toMatchObject({
      title: '分数教材', audience: '小学三年级学生', slideCount: 3, presentationType: '完整视觉演示',
      output: { format: 'IMAGE_BASED_PPTX', editable: false },
    })
    expect(plan.summary).toContain('这套PPT将面向小学三年级学生')
    expect(plan.pages).toHaveLength(3)
    expect(plan.pages[0]).toEqual({
      pageNumber: 1,
      title: blueprint.visualDeckV4Proposal!.slideBriefs[0]!.title,
      content: blueprint.visualDeckV4Proposal!.slideBriefs[0]!.keyClaim,
      visual: `${blueprint.visualDeckV4Proposal!.slideBriefs[0]!.visualMetaphor}。${blueprint.visualDeckV4Proposal!.slideBriefs[0]!.composition}`,
    })
    expect(JSON.stringify(plan)).not.toContain('sourceChunkIds')
    expect(JSON.stringify(plan)).not.toContain('compilerVersion')
    expect(JSON.stringify(plan)).not.toContain('visualPrompt')
  })

  test('projects a single-page v4 plan without fabricating a two-step flow', () => {
    const source = {
      kind: 'TEXT' as const,
      name: '水循环教材.txt',
      text: '太阳加热水面形成水汽，水汽凝结成云，降水回到地表，构成持续循环。'.repeat(4),
    }
    const blueprint = createVisualDeckV4Blueprint({
      runId: 'run-user-plan-single', inputHash: 'input-user-plan-single', source,
      document: {
        name: source.name,
        chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
        isComplete: true,
        missingRanges: [],
      },
      config: {
        instruction: '制作一张解释水循环核心关系的视觉演示页',
        sourceMode: 'SOURCE_GROUNDED',
        deckOptions: { deckType: 'PRESENTER_SLIDES', language: 'zh-CN', length: { slideCount: 1 }, aspectRatio: '16:9' },
      },
      slideCount: 1,
      visualDirection: '清晰的自然科学信息图',
      createdAt: '2026-08-07T00:00:00.000Z',
    })

    const plan = visualDeckV4GenerationPlan(blueprint.visualDeckV4Proposal!)
    expect(plan).toMatchObject({ slideCount: 1, flow: ['在单页中建立主题、核心结论与主视觉'] })
    expect(plan.pages).toHaveLength(1)
  })
})

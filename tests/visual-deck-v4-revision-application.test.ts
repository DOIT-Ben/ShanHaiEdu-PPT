import { describe, expect, test } from 'bun:test'
import {
  visualDeckV4RevisionApplicationResultSchema,
} from '../src/visual-deck-v4-contracts'

function layoutPatch(pageNumber = 2) {
  return {
    pageNumber,
    visualMetaphor: '用单一叶片表达光合作用关系',
    composition: '叶片居中，关系沿单一路径展开',
    informationHierarchy: ['核心叶片', '光能来源', '产物关系'],
    previousSlideRelation: '承接第一页的问题',
    nextSlideRelation: '为下一页练习建立前提',
  }
}

function contentPatch(pageNumber = 1) {
  return {
    pageNumber,
    title: '光合作用会产生什么？',
    keyClaim: '绿色植物制造有机物并释放氧气。',
    audienceTakeaway: '说出光合作用的两种产物。',
    lockedCopy: ['制造有机物', '释放氧气'],
    facts: ['绿色植物制造有机物并释放氧气。'],
    numbers: [],
    formulas: [],
    sourceChunkIds: ['chunk-2'],
    visualMetaphor: '一片叶子连接有机物与氧气',
    composition: '叶片位于中央，两种产物从同一叶片引出',
    informationHierarchy: ['核心结论', '来源事实', '视觉关系'],
    previousSlideRelation: null,
    nextSlideRelation: '进入产物辨认练习',
  }
}

describe('V4 revision application patch contract', () => {
  test('accepts scoped content, layout and redraw-only dispositions', () => {
    expect(visualDeckV4RevisionApplicationResultSchema.parse({
      contentPatches: [contentPatch()],
      layoutPatches: [layoutPatch()],
      redrawOnlyPageNumbers: [3, 5],
    })).toMatchObject({ redrawOnlyPageNumbers: [3, 5] })
  })

  test('rejects frozen fields, global proposal echoes and duplicate page ownership', () => {
    expect(visualDeckV4RevisionApplicationResultSchema.safeParse({
      contentPatches: [{ ...contentPatch(), role: 'COVER' }],
      layoutPatches: [],
      redrawOnlyPageNumbers: [],
    }).success).toBe(false)
    expect(visualDeckV4RevisionApplicationResultSchema.safeParse({
      contentPatches: [],
      layoutPatches: [],
      redrawOnlyPageNumbers: [],
      sourceUnderstanding: {},
    }).success).toBe(false)
    expect(visualDeckV4RevisionApplicationResultSchema.safeParse({
      contentPatches: [contentPatch(2)],
      layoutPatches: [layoutPatch(2)],
      redrawOnlyPageNumbers: [2],
    }).success).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import { compileVisualDeckV4RevisionIssueGroups } from '../src/core/revision-plan-representability'
import type { DeckReview } from '../src/presentation-contracts'

type Issue = DeckReview['issues'][number]

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    category: 'COMPOSITION_CONFLICT',
    severity: 'WARNING',
    summary: `完整保留 ${id} 的修复要求。`,
    slideIds: ['run-1:slide:1'],
    sourceChunkIds: [],
    status: 'OPEN',
    repairDomain: 'LAYOUT',
    ...overrides,
  }
}

describe('V4 revision plan representability', () => {
  test('rejects a legal review that cannot fit into fifty lossless operations', () => {
    const issues = Array.from({ length: 21 }, (_, index) => issue(`issue-${index + 1}`, {
      slideIds: Array.from({ length: 50 }, (_value, slideIndex) => `run-1:slide:${slideIndex + 1}`),
    }))

    expect(() => compileVisualDeckV4RevisionIssueGroups(issues))
      .toThrow('REVISION_PLAN_OPERATION_BUDGET_EXCEEDED')
  })

  test('splits knowledge issues before their source union exceeds the operation contract', () => {
    const firstSources = Array.from({ length: 200 }, (_, index) => `source-a-${index + 1}`)
    const secondSources = Array.from({ length: 200 }, (_, index) => `source-b-${index + 1}`)
    const groups = compileVisualDeckV4RevisionIssueGroups([
      issue('knowledge-1', { category: 'FACTUAL_RISK', repairDomain: 'KNOWLEDGE', sourceChunkIds: firstSources }),
      issue('knowledge-2', { category: 'FACTUAL_RISK', repairDomain: 'KNOWLEDGE', sourceChunkIds: secondSources }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.sourceChunkIds.length === 200)).toBe(true)
  })

  test('retains every issue summary without truncation while respecting instruction bounds', () => {
    const issues = Array.from({ length: 6 }, (_, index) => issue(`issue-${index + 1}`, {
      summary: `${index + 1}-${'必须完整保留的修复要求。'.repeat(35)}`,
    }))
    const groups = compileVisualDeckV4RevisionIssueGroups(issues)
    const compiled = groups.map((group) => group.instruction).join('\n')

    expect(groups.every((group) => group.instruction.length <= 2_000)).toBe(true)
    for (const item of issues) expect(compiled).toContain(item.summary)
  })
})

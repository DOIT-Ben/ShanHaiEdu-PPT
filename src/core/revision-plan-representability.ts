import type { DeckReview, RevisionPlan } from '../presentation-contracts'
import { compileVisualDeckV4RevisionInstructions } from './blueprint-assets'

const MAX_ISSUES_PER_OPERATION = 20
const MAX_SOURCES_PER_OPERATION = 200
const MAX_INSTRUCTION_LENGTH = 2_000
const MAX_OPERATIONS = 50

type Issue = DeckReview['issues'][number]

export type RevisionIssueGroup = Readonly<{
  slideId: string
  kind: RevisionPlan['operations'][number]['kind']
  issues: readonly Issue[]
  instruction: string
  sourceChunkIds: readonly string[]
}>

export function compileVisualDeckV4RevisionIssueGroups(issues: readonly Issue[]): readonly RevisionIssueGroup[] {
  const byTarget = new Map<string, { slideId: string; kind: RevisionIssueGroup['kind']; issues: Issue[] }>()
  for (const issue of issues) {
    const kind = expectedRevisionKind(issue)
    for (const slideId of issue.slideIds) {
      const key = `${slideId}\u0000${kind}`
      const target = byTarget.get(key) ?? { slideId, kind, issues: [] }
      target.issues.push(issue)
      byTarget.set(key, target)
    }
  }

  const groups: RevisionIssueGroup[] = []
  for (const target of byTarget.values()) {
    let pending: Issue[] = []
    const flush = () => {
      if (pending.length === 0) return
      groups.push(group(target.slideId, target.kind, pending))
      pending = []
    }
    for (const issue of target.issues) {
      const candidate = [...pending, issue]
      const compiled = group(target.slideId, target.kind, candidate)
      if (pending.length > 0 && (
        candidate.length > MAX_ISSUES_PER_OPERATION
        || compiled.sourceChunkIds.length > MAX_SOURCES_PER_OPERATION
        || compiled.instruction.length > MAX_INSTRUCTION_LENGTH
      )) {
        flush()
      }
      pending.push(issue)
    }
    flush()
  }

  if (groups.length > MAX_OPERATIONS) throw new Error('REVISION_PLAN_OPERATION_BUDGET_EXCEEDED')
  const instructionsBySlide = new Map<string, string[]>()
  for (const item of groups) {
    const instructions = instructionsBySlide.get(item.slideId) ?? []
    instructions.push(item.instruction)
    instructionsBySlide.set(item.slideId, instructions)
  }
  for (const instructions of instructionsBySlide.values()) {
    compileVisualDeckV4RevisionInstructions(instructions)
  }
  return groups
}

function group(slideId: string, kind: RevisionIssueGroup['kind'], issues: readonly Issue[]): RevisionIssueGroup {
  return {
    slideId,
    kind,
    issues: [...issues],
    instruction: `逐项修复审查问题：${issues.map((issue) => issue.summary.trim()).join('；')}`,
    sourceChunkIds: [...new Set(issues.flatMap((issue) => issue.sourceChunkIds))],
  }
}

function expectedRevisionKind(issue: Issue): RevisionIssueGroup['kind'] {
  const repairDomain = revisionRepairDomain(issue)
  if (repairDomain === 'KNOWLEDGE') return 'UPDATE_CONTENT'
  if (repairDomain === 'ASSET') return 'REGENERATE_IMAGE'
  return 'RELAYOUT'
}

export function revisionRepairDomain(issue: Issue) {
  const inferredDomain = ['CURRICULUM_GAP', 'FACTUAL_RISK'].includes(issue.category)
    ? 'KNOWLEDGE'
    : ['IMAGE_QUALITY', 'ASSET_RELEVANCE'].includes(issue.category) ? 'ASSET' : 'LAYOUT'
  return issue.repairDomain ?? inferredDomain
}

import { isDeepStrictEqual } from 'node:util'
import {
  visualDeckV4ProposalDraftSchema,
  visualDeckV4SlideBriefsStageSchema,
  type VisualDeckV4DeckVisualStage,
  type VisualDeckV4SlideBriefsStage,
  type VisualDeckV4SourceSpecStage,
} from '../../visual-deck-v4-contracts'
import { hashInput } from '../hash'
import type {
  BoundSlideCriticIssue,
  SlideCriticResult,
  SlideOptimizerResult,
  SlideReflectionField,
} from './contracts'
import { semanticFailure, scopeFailure } from './diagnostics'

const SLIDE_ARRAYS = {
  roleChanges: 'role',
  visualMetaphorChanges: 'visualMetaphor',
  compositionChanges: 'composition',
  informationHierarchyChanges: 'informationHierarchy',
  previousSlideRelationChanges: 'previousSlideRelation',
  nextSlideRelationChanges: 'nextSlideRelation',
} as const satisfies Readonly<Record<keyof SlideOptimizerResult, SlideReflectionField>>

export function bindSlideCriticIssues(input: Readonly<{
  candidate: VisualDeckV4SlideBriefsStage
  result: SlideCriticResult
}>): readonly BoundSlideCriticIssue[] {
  const candidate = visualDeckV4SlideBriefsStageSchema.parse(input.candidate)
  const pages = new Set(candidate.slideBriefs.map((brief) => brief.pageNumber))
  return input.result.issues.map((issue, ordinal) => {
    if (!pages.has(issue.pageNumber)) {
      semanticFailure('SLIDE_CRITIC_PAGE_OUT_OF_RANGE', ['issues', ordinal, 'pageNumber'])
    }
    return {
      ...issue,
      issueId: `reflection-issue-${hashInput({ candidate, issue, ordinal }).slice(0, 24)}`,
    }
  })
}

export function applySlideOptimizerResult(input: Readonly<{
  candidate: VisualDeckV4SlideBriefsStage
  proposalContext: VisualDeckV4SourceSpecStage & VisualDeckV4DeckVisualStage
  issues: readonly BoundSlideCriticIssue[]
  result: SlideOptimizerResult
}>): VisualDeckV4SlideBriefsStage {
  const candidate = visualDeckV4SlideBriefsStageSchema.parse(input.candidate)
  const issueById = new Map(input.issues.map((issue) => [issue.issueId, issue]))
  const ownerByIssue = new Map<string, string>()
  const ownerByPageField = new Set<string>()
  const revised = structuredClone(candidate)
  const slideByPage = new Map(revised.slideBriefs.map((slide) => [slide.pageNumber, slide]))

  for (const [arrayName, field] of Object.entries(SLIDE_ARRAYS) as [keyof SlideOptimizerResult, SlideReflectionField][]) {
    const entries = input.result[arrayName] as readonly Readonly<{
      issueIds: readonly string[]
      pageNumber: number
      value: unknown
    }>[]
    for (const entry of entries) {
      const pageField = `${entry.pageNumber}:${field}`
      if (ownerByPageField.has(pageField)) scopeFailure('SLIDE_OPTIMIZER_DUPLICATE_PAGE_FIELD', [arrayName])
      const slide = slideByPage.get(entry.pageNumber)
      if (!slide) semanticFailure('SLIDE_OPTIMIZER_PAGE_OUT_OF_RANGE', [arrayName, 'pageNumber'])
      for (const issueId of entry.issueIds) {
        const issue = issueById.get(issueId)
        if (!issue) scopeFailure('SLIDE_OPTIMIZER_UNKNOWN_ISSUE', [arrayName, 'issueIds'])
        if (issue.pageNumber !== entry.pageNumber || issue.field !== field) {
          scopeFailure('SLIDE_OPTIMIZER_SCOPE_NOT_AUTHORIZED', [arrayName])
        }
        if (ownerByIssue.has(issueId)) scopeFailure('SLIDE_OPTIMIZER_DUPLICATE_ISSUE_OWNER', [arrayName])
        ownerByIssue.set(issueId, pageField)
      }
      ownerByPageField.add(pageField)
      setSlideField(slide, field, entry.value)
    }
  }
  if (ownerByIssue.size !== input.issues.length
    || input.issues.some((issue) => !ownerByIssue.has(issue.issueId))) {
    scopeFailure('SLIDE_OPTIMIZER_MISSING_ISSUE', ['issues'])
  }
  if (isDeepStrictEqual(candidate, revised)) semanticFailure('SLIDE_OPTIMIZER_NO_OP')

  const parsed = visualDeckV4SlideBriefsStageSchema.safeParse(revised)
  if (!parsed.success) semanticFailure('SLIDE_OPTIMIZER_RESULT_INVALID')
  const proposal = visualDeckV4ProposalDraftSchema.safeParse({ ...input.proposalContext, ...parsed.data })
  if (!proposal.success) semanticFailure('SLIDE_OPTIMIZER_PROPOSAL_INVALID')
  return parsed.data
}

function setSlideField(
  slide: VisualDeckV4SlideBriefsStage['slideBriefs'][number],
  field: SlideReflectionField,
  value: unknown,
) {
  switch (field) {
    case 'role': slide.role = value as typeof slide.role; return
    case 'visualMetaphor': slide.visualMetaphor = value as string; return
    case 'composition': slide.composition = value as string; return
    case 'informationHierarchy': slide.informationHierarchy = value as string[]; return
    case 'previousSlideRelation': slide.previousSlideRelation = value as string | null; return
    case 'nextSlideRelation': slide.nextSlideRelation = value as string | null; return
  }
}

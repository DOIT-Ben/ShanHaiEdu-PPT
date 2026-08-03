import { isDeepStrictEqual } from 'node:util'
import {
  visualDeckV4DeckVisualStageSchema,
  type VisualDeckV4DeckVisualStage,
} from '../../visual-deck-v4-contracts'
import { hashInput } from '../hash'
import type {
  BoundDeckCriticIssue,
  DeckCriticResult,
  DeckOptimizerResult,
  DeckReflectionField,
} from './contracts'
import { semanticFailure, scopeFailure } from './diagnostics'

const DECK_ARRAYS = {
  titleChanges: 'deckPlan.title',
  narrativeArcChanges: 'deckPlan.narrativeArc',
  artDirectionChanges: 'visualContract.artDirection',
  paletteChanges: 'visualContract.palette',
  typographyChanges: 'visualContract.typography',
  mediumChanges: 'visualContract.medium',
  visualDensityChanges: 'visualContract.visualDensity',
  compositionRuleChanges: 'visualContract.compositionRules',
  continuityRuleChanges: 'visualContract.continuityRules',
  forbiddenChanges: 'visualContract.forbidden',
} as const satisfies Readonly<Record<keyof DeckOptimizerResult, DeckReflectionField>>

export function bindDeckCriticIssues(input: Readonly<{
  candidate: VisualDeckV4DeckVisualStage
  result: DeckCriticResult
  expectedSlideCount?: number
}>): readonly BoundDeckCriticIssue[] {
  const candidate = visualDeckV4DeckVisualStageSchema.parse(input.candidate)
  const expectedSlideCount = input.expectedSlideCount ?? candidate.deckPlan.slideCount
  if (candidate.deckPlan.slideCount !== expectedSlideCount) {
    semanticFailure('DECK_SLIDE_COUNT_MISMATCH', ['deckPlan', 'slideCount'])
  }
  return input.result.issues.map((issue, ordinal) => {
    const pages = [...issue.pageNumbers]
    if (new Set(pages).size !== pages.length
      || pages.some((page, index) => page !== [...pages].sort((left, right) => left - right)[index])
      || pages.some((page) => page > expectedSlideCount)) {
      semanticFailure('DECK_CRITIC_PAGE_SCOPE_INVALID', ['issues', ordinal, 'pageNumbers'])
    }
    return {
      ...issue,
      issueId: `reflection-issue-${hashInput({ candidate, issue, ordinal }).slice(0, 24)}`,
    }
  })
}

export function applyDeckOptimizerResult(input: Readonly<{
  candidate: VisualDeckV4DeckVisualStage
  expectedSlideCount: number
  issues: readonly BoundDeckCriticIssue[]
  result: DeckOptimizerResult
}>): VisualDeckV4DeckVisualStage {
  const candidate = visualDeckV4DeckVisualStageSchema.parse(input.candidate)
  if (candidate.deckPlan.slideCount !== input.expectedSlideCount) {
    semanticFailure('DECK_SLIDE_COUNT_MISMATCH', ['deckPlan', 'slideCount'])
  }
  const issueById = new Map(input.issues.map((issue) => [issue.issueId, issue]))
  const owners = new Map<string, DeckReflectionField>()
  const fieldChanges = new Map<DeckReflectionField, unknown>()

  for (const [arrayName, field] of Object.entries(DECK_ARRAYS) as [keyof DeckOptimizerResult, DeckReflectionField][]) {
    const entries = input.result[arrayName] as readonly Readonly<{ issueIds: readonly string[]; value: unknown }>[]
    if (entries.length > 1) scopeFailure('DECK_OPTIMIZER_DUPLICATE_FIELD_OWNER', [arrayName])
    for (const entry of entries) {
      if (fieldChanges.has(field)) scopeFailure('DECK_OPTIMIZER_DUPLICATE_FIELD_OWNER', [arrayName])
      for (const issueId of entry.issueIds) {
        const issue = issueById.get(issueId)
        if (!issue) scopeFailure('DECK_OPTIMIZER_UNKNOWN_ISSUE', [arrayName, 'issueIds'])
        if (issue.field !== field) scopeFailure('DECK_OPTIMIZER_FIELD_NOT_AUTHORIZED', [arrayName])
        if (owners.has(issueId)) scopeFailure('DECK_OPTIMIZER_DUPLICATE_ISSUE_OWNER', [arrayName])
        owners.set(issueId, field)
      }
      fieldChanges.set(field, entry.value)
    }
  }
  if (owners.size !== input.issues.length
    || input.issues.some((issue) => !owners.has(issue.issueId))) {
    scopeFailure('DECK_OPTIMIZER_MISSING_ISSUE', ['issues'])
  }

  const revised = structuredClone(candidate)
  for (const [field, value] of fieldChanges) setDeckField(revised, field, value)
  if (isDeepStrictEqual(candidate, revised)) semanticFailure('DECK_OPTIMIZER_NO_OP')
  const parsed = visualDeckV4DeckVisualStageSchema.safeParse(revised)
  if (!parsed.success || parsed.data.deckPlan.slideCount !== input.expectedSlideCount) {
    semanticFailure('DECK_OPTIMIZER_RESULT_INVALID')
  }
  if (!isDeepStrictEqual(parsed.data.deckPlan.chapters, candidate.deckPlan.chapters)) {
    scopeFailure('DECK_OPTIMIZER_FROZEN_CHAPTERS_CHANGED', ['deckPlan', 'chapters'])
  }
  return parsed.data
}

function setDeckField(candidate: VisualDeckV4DeckVisualStage, field: DeckReflectionField, value: unknown) {
  switch (field) {
    case 'deckPlan.title': candidate.deckPlan.title = value as string; return
    case 'deckPlan.narrativeArc': candidate.deckPlan.narrativeArc = value as string[]; return
    case 'visualContract.artDirection': candidate.visualContract.artDirection = value as string; return
    case 'visualContract.palette': candidate.visualContract.palette = value as string[]; return
    case 'visualContract.typography': candidate.visualContract.typography = value as string; return
    case 'visualContract.medium': candidate.visualContract.medium = value as string; return
    case 'visualContract.visualDensity': candidate.visualContract.visualDensity = value as 'LOW' | 'MEDIUM' | 'HIGH'; return
    case 'visualContract.compositionRules': candidate.visualContract.compositionRules = value as string[]; return
    case 'visualContract.continuityRules': candidate.visualContract.continuityRules = value as string[]; return
    case 'visualContract.forbidden': candidate.visualContract.forbidden = value as string[]; return
  }
}

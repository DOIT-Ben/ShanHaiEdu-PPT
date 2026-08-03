import { z } from 'zod'
import { visualDeckV4SlideRoleSchema } from '../../visual-deck-v4-contracts'

const identifier = z.string().trim().min(1).max(160)
const issueText = z.string().trim().min(1).max(1_000)
const replacementText = (maximum: number) => z.string().trim().min(1).max(maximum)

export const deckReflectionFieldSchema = z.enum([
  'deckPlan.title',
  'deckPlan.narrativeArc',
  'visualContract.artDirection',
  'visualContract.palette',
  'visualContract.typography',
  'visualContract.medium',
  'visualContract.visualDensity',
  'visualContract.compositionRules',
  'visualContract.continuityRules',
  'visualContract.forbidden',
])

export const deckCriticIssueSchema = z.object({
  pageNumbers: z.array(z.number().int().min(1).max(50)).min(1).max(50),
  category: z.enum([
    'NARRATIVE_BREAK',
    'CROSS_SLIDE_REPETITION',
    'VISUAL_INCONSISTENCY',
    'DENSITY_IMBALANCE',
    'DECK_COMPOSITION_CONFLICT',
    'CONTINUITY_BREAK',
  ]),
  field: deckReflectionFieldSchema,
  problem: issueText,
  desiredChange: issueText,
}).strict()

export const deckCriticResultSchema = z.object({
  issues: z.array(deckCriticIssueSchema).max(40),
}).strict()

const deckChange = <T extends z.ZodType>(value: T) => z.object({
  issueIds: z.array(identifier).min(1).max(40),
  value,
}).strict()

const boundedList = (maximum: number, itemMaximum: number) =>
  z.array(replacementText(itemMaximum)).min(1).max(maximum)

export const deckOptimizerResultSchema = z.object({
  titleChanges: z.array(deckChange(replacementText(160))).max(1),
  narrativeArcChanges: z.array(deckChange(boundedList(20, 500))).max(1),
  artDirectionChanges: z.array(deckChange(replacementText(1_000))).max(1),
  paletteChanges: z.array(deckChange(z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).min(2).max(10))).max(1),
  typographyChanges: z.array(deckChange(replacementText(500))).max(1),
  mediumChanges: z.array(deckChange(replacementText(300))).max(1),
  visualDensityChanges: z.array(deckChange(z.enum(['LOW', 'MEDIUM', 'HIGH']))).max(1),
  compositionRuleChanges: z.array(deckChange(boundedList(12, 300))).max(1),
  continuityRuleChanges: z.array(deckChange(boundedList(12, 300))).max(1),
  forbiddenChanges: z.array(deckChange(z.array(replacementText(300)).max(20))).max(1),
}).strict()

export const slideReflectionFieldSchema = z.enum([
  'role',
  'visualMetaphor',
  'composition',
  'informationHierarchy',
  'previousSlideRelation',
  'nextSlideRelation',
])

export const slideCriticIssueSchema = z.object({
  pageNumber: z.number().int().min(1).max(50),
  category: z.enum([
    'COUNTABILITY_RISK',
    'UNAUTHORIZED_TEXT_RISK',
    'COMPOSITION_AMBIGUITY',
    'VISUAL_DENSITY_RISK',
    'CROSS_SLIDE_REPETITION',
    'CONTINUITY_BREAK',
  ]),
  field: slideReflectionFieldSchema,
  problem: issueText,
  desiredChange: issueText,
}).strict()

export const slideCriticResultSchema = z.object({
  issues: z.array(slideCriticIssueSchema).max(100),
}).strict()

const slideChange = <T extends z.ZodType>(value: T) => z.object({
  issueIds: z.array(identifier).min(1).max(100),
  pageNumber: z.number().int().min(1).max(50),
  value,
}).strict()

export const slideOptimizerResultSchema = z.object({
  roleChanges: z.array(slideChange(visualDeckV4SlideRoleSchema)).max(50),
  visualMetaphorChanges: z.array(slideChange(replacementText(1_000))).max(50),
  compositionChanges: z.array(slideChange(replacementText(1_000))).max(50),
  informationHierarchyChanges: z.array(slideChange(boundedList(12, 300))).max(50),
  previousSlideRelationChanges: z.array(slideChange(replacementText(500).nullable())).max(50),
  nextSlideRelationChanges: z.array(slideChange(replacementText(500).nullable())).max(50),
}).strict()

export type DeckCriticIssue = z.infer<typeof deckCriticIssueSchema>
export type DeckCriticResult = z.infer<typeof deckCriticResultSchema>
export type DeckOptimizerResult = z.infer<typeof deckOptimizerResultSchema>
export type DeckReflectionField = z.infer<typeof deckReflectionFieldSchema>
export type SlideCriticIssue = z.infer<typeof slideCriticIssueSchema>
export type SlideCriticResult = z.infer<typeof slideCriticResultSchema>
export type SlideOptimizerResult = z.infer<typeof slideOptimizerResultSchema>
export type SlideReflectionField = z.infer<typeof slideReflectionFieldSchema>

export type BoundDeckCriticIssue = DeckCriticIssue & Readonly<{ issueId: string }>
export type BoundSlideCriticIssue = SlideCriticIssue & Readonly<{ issueId: string }>

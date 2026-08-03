import { revisionPlanSchema, slideVisualReviewSchema } from '../presentation-contracts'
import type { StepRecord } from './ports'
import { compileVisualDeckV4RevisionInstructions } from './blueprint-assets'

export function visualDeckV4RevisionInstructions(input: Readonly<{
  runId: string
  pageNumber: number
  revisionRound: number
  steps: readonly StepRecord[]
  currentInstructions?: readonly string[]
}>) {
  const instructions: string[] = []
  const slideId = `${input.runId}:slide:${input.pageNumber}`
  const imagePrefix = `${slideId}:image:`
  const orderedSteps = [...input.steps].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.idempotencyKey.localeCompare(right.idempotencyKey))

  for (const step of orderedSteps) {
    if (step.status !== 'COMPLETED') continue
    if (step.tool === 'review_slide_image' && step.idempotencyKey.startsWith(imagePrefix)) {
      const reviewRound = reviewImageRound(step.idempotencyKey)
      if (reviewRound === null || reviewRound >= input.revisionRound) continue
      const review = slideVisualReviewSchema.safeParse(step.output)
      if (review.success && !review.data.approved && review.data.retryInstruction) {
        instructions.push(review.data.retryInstruction)
      }
      continue
    }
    if (step.tool !== 'plan_revision' && step.tool !== 'plan_page_revision') continue
    const plan = revisionPlanSchema.safeParse(step.output)
    if (!plan.success || plan.data.revisionRound >= input.revisionRound) continue
    instructions.push(...plan.data.operations
      .filter((operation) => operation.slideId === slideId && operation.kind !== 'UPDATE_CONTENT')
      .map((operation) => operation.instruction))
  }

  const unique = [...new Set([...instructions, ...(input.currentInstructions ?? [])]
    .map((instruction) => instruction.trim()).filter(Boolean))]
  compileVisualDeckV4RevisionInstructions(unique)
  return unique
}

function reviewImageRound(idempotencyKey: string) {
  const match = /:image:r(\d+):v\d+(?:\:edit\:[a-f0-9]{24})?:review(?:$|:)/.exec(idempotencyKey)
  if (!match) return null
  const round = Number(match[1])
  return Number.isSafeInteger(round) && round >= 0 ? round : null
}

import type { PresentationBlueprint } from '../presentation-contracts'
import { ConstraintCompiler, type ExactDiagramSpec } from './v4-constraint-compiler'

export type V4RenderStrategy = Readonly<
  | { kind: 'FULL_GENERATIVE' }
  | { kind: 'CONTROLLED_RASTER'; diagram: ExactDiagramSpec }
>

const compiler = new ConstraintCompiler()

/** Chooses a deterministic renderer only for compiler-verified V4 content. */
export function resolveV4RenderStrategy(
  blueprint: PresentationBlueprint,
  pageNumber: number,
): V4RenderStrategy {
  if (blueprint.renderMode !== 'VISUAL_DECK_V4') return { kind: 'FULL_GENERATIVE' }
  const brief = blueprint.visualDeckV4Proposal?.slideBriefs.find((candidate) => candidate.pageNumber === pageNumber)
  if (!brief) return { kind: 'FULL_GENERATIVE' }
  const diagram = compiler.compile({
    title: brief.title,
    lockedCopy: brief.lockedCopy,
    facts: brief.facts,
  })
  return diagram ? { kind: 'CONTROLLED_RASTER', diagram } : { kind: 'FULL_GENERATIVE' }
}

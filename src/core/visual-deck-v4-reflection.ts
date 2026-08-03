import { isDeepStrictEqual } from 'node:util'
import {
  VISUAL_DECK_V4_REFLECTION_RUBRIC_VERSION,
  visualDeckV4DeckVisualReflectionInputSchema,
  visualDeckV4DeckVisualReflectionResultSchema,
  visualDeckV4DeckVisualReflectionStageOutputSchema,
  visualDeckV4DeckVisualStageSchema,
  visualDeckV4SlideBriefsReflectionInputSchema,
  visualDeckV4SlideBriefsReflectionResultSchema,
  visualDeckV4SlideBriefsReflectionStageOutputSchema,
  visualDeckV4SlideBriefsStageSchema,
  type VisualDeckV4DeckVisualReflectionStageOutput,
  type VisualDeckV4DeckVisualReflectionResult,
  type VisualDeckV4DeckVisualStage,
  type VisualDeckV4Config,
  type VisualDeckV4SlideBriefsReflectionStageOutput,
  type VisualDeckV4SlideBriefsReflectionResult,
  type VisualDeckV4SlideBriefsStage,
  type VisualDeckV4SourceSpecStage,
} from '../visual-deck-v4-contracts'
import type { DocumentResult } from './ports'
import { hashInput } from './hash'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function changedLeafPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (isDeepStrictEqual(before, after)) return []
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [prefix]
    return before.flatMap((value, index) => changedLeafPaths(value, after[index], `${prefix}.${index}`))
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    return keys.flatMap((key) => changedLeafPaths(
      before[key],
      after[key],
      prefix ? `${prefix}.${key}` : key,
    ))
  }
  return [prefix]
}

function fieldCoversChange(fieldPath: string, changedPath: string) {
  return fieldPath === changedPath || changedPath.startsWith(`${fieldPath}.`)
}

function assertBaseHash(candidate: unknown, baseArtifactHash: string) {
  if (hashInput(candidate) !== baseArtifactHash) throw new Error('V4_REFLECTION_BASE_HASH_MISMATCH')
}

function assertReviewContextHash(actual: string, expected: string) {
  if (actual !== expected) throw new Error('V4_REFLECTION_CONTEXT_HASH_MISMATCH')
}

type ReflectionContextInput = Readonly<{
  config: VisualDeckV4Config
  sourceSpec: VisualDeckV4SourceSpecStage
  document: DocumentResult
  visualDirection: string
  deckVisual?: VisualDeckV4DeckVisualStage
  targetAudience?: string
  presentationGoal?: string
}>

function reflectionContext(input: ReflectionContextInput) {
  const referencedChunkIds = new Set(
    input.sourceSpec.sourceUnderstanding.sources.flatMap((source) => source.sourceChunkIds),
  )
  return {
    originalRequest: {
      instruction: input.config.instruction,
      targetAudience: input.config.deckOptions.audience ?? input.targetAudience ?? null,
      presentationGoal: input.presentationGoal ?? null,
      visualDirection: input.visualDirection,
    },
    trustedEvidence: {
      sourceManifest: input.sourceSpec.sourceUnderstanding.sources.map((source) => ({
        sourceId: source.sourceId,
        name: source.name,
        role: source.role,
        status: source.status,
        sourceChunkIds: source.sourceChunkIds,
      })),
      sourceChunks: input.document.chunks
        .filter((chunk) => referencedChunkIds.has(chunk.id))
        .map((chunk) => ({
          id: chunk.id,
          sourceId: chunk.sourceId ?? null,
          sha256: chunk.sha256,
          text: chunk.text,
          pageStart: chunk.pageStart ?? null,
          pageEnd: chunk.pageEnd ?? null,
          region: chunk.region ?? null,
        })),
    },
    frozenConstraints: {
      slideCount: input.sourceSpec.presentationSpec.slideCount,
      language: input.sourceSpec.presentationSpec.language,
      sourceMode: input.sourceSpec.presentationSpec.sourceMode,
      presentationMode: 'VISUAL_DECK_V4' as const,
      deckType: input.sourceSpec.presentationSpec.deckType,
      audience: input.sourceSpec.presentationSpec.audience,
      goal: input.sourceSpec.presentationSpec.goal,
      aspectRatio: input.config.deckOptions.aspectRatio,
      forbidden: input.sourceSpec.presentationSpec.forbidden,
    },
    rubricVersion: VISUAL_DECK_V4_REFLECTION_RUBRIC_VERSION,
    providerCapabilities: { deliveryModel: 'RASTER_SLIDES_IN_PPTX' as const },
  }
}

export function createVisualDeckV4DeckVisualReflectionInput(
  input: ReflectionContextInput,
  candidateArtifact: VisualDeckV4DeckVisualStage,
) {
  const context = reflectionContext(input)
  const governanceContext = { presentationSpec: input.sourceSpec.presentationSpec }
  const candidateArtifactHash = hashInput(candidateArtifact)
  return visualDeckV4DeckVisualReflectionInputSchema.parse({
    ...context,
    governanceContext,
    candidateArtifact,
    candidateArtifactHash,
    reviewContextHash: hashInput({ ...context, governanceContext, candidateArtifactHash }),
  })
}

export function createVisualDeckV4SlideBriefsReflectionInput(
  input: ReflectionContextInput,
  candidateArtifact: VisualDeckV4SlideBriefsStage,
) {
  if (!input.deckVisual) throw new Error('V4_REFLECTION_GOVERNANCE_CONTEXT_REQUIRED')
  const context = reflectionContext(input)
  const governanceContext = {
    presentationSpec: input.sourceSpec.presentationSpec,
    deckPlan: input.deckVisual.deckPlan,
    visualContract: input.deckVisual.visualContract,
  }
  const candidateArtifactHash = hashInput(candidateArtifact)
  return visualDeckV4SlideBriefsReflectionInputSchema.parse({
    ...context,
    governanceContext,
    candidateArtifact,
    candidateArtifactHash,
    reviewContextHash: hashInput({ ...context, governanceContext, candidateArtifactHash }),
  })
}

export function applyVisualDeckV4DeckVisualReflection(input: Readonly<{
  candidate: VisualDeckV4DeckVisualStage
  result: VisualDeckV4DeckVisualReflectionResult
  expectedReviewContextHash: string
}>): VisualDeckV4DeckVisualStage {
  visualDeckV4DeckVisualStageSchema.parse(input.candidate)
  const result = visualDeckV4DeckVisualReflectionResultSchema.parse(input.result)
  assertBaseHash(input.candidate, result.baseArtifactHash)
  assertReviewContextHash(result.reviewContextHash, input.expectedReviewContextHash)
  if (result.decision === 'UNCHANGED') {
    if (!isDeepStrictEqual(input.candidate, result.revisedArtifact)) {
      throw new Error('V4_REFLECTION_UNCHANGED_ARTIFACT_MUTATED')
    }
    return input.candidate
  }

  if (input.candidate.deckPlan.slideCount !== result.revisedArtifact.deckPlan.slideCount) {
    throw new Error('V4_REFLECTION_FROZEN_FIELD_MUTATION')
  }
  if (result.findings.some((finding) => finding.pageNumbers.some((pageNumber) =>
    pageNumber > input.candidate.deckPlan.slideCount))) {
    throw new Error('V4_REFLECTION_FINDING_PAGE_OUT_OF_RANGE')
  }
  const allDeckPages = Array.from(
    { length: input.candidate.deckPlan.slideCount },
    (_, index) => index + 1,
  )
  if (result.findings.some((finding) =>
    finding.pageNumbers.length !== allDeckPages.length
    || allDeckPages.some((pageNumber) => !finding.pageNumbers.includes(pageNumber)))) {
    throw new Error('V4_REFLECTION_FINDING_PAGE_SCOPE_MISMATCH')
  }
  const changedPaths = changedLeafPaths(input.candidate, result.revisedArtifact)
  if (changedPaths.length === 0) throw new Error('V4_REFLECTION_APPLIED_FINDING_NO_CHANGE')
  if (changedPaths.some((changedPath) => !result.findings.some((finding) =>
    finding.fieldPaths.some((fieldPath) => fieldCoversChange(fieldPath, changedPath))))) {
    throw new Error('V4_REFLECTION_CHANGE_OUT_OF_SCOPE')
  }
  if (result.findings.some((finding) => !finding.fieldPaths.every((fieldPath) =>
    changedPaths.some((changedPath) => fieldCoversChange(fieldPath, changedPath))))) {
    throw new Error('V4_REFLECTION_APPLIED_FINDING_NO_CHANGE')
  }
  return result.revisedArtifact
}

export function applyVisualDeckV4SlideBriefsReflection(input: Readonly<{
  candidate: VisualDeckV4SlideBriefsStage
  result: VisualDeckV4SlideBriefsReflectionResult
  expectedReviewContextHash: string
}>): VisualDeckV4SlideBriefsStage {
  visualDeckV4SlideBriefsStageSchema.parse(input.candidate)
  const result = visualDeckV4SlideBriefsReflectionResultSchema.parse(input.result)
  assertBaseHash(input.candidate, result.baseArtifactHash)
  assertReviewContextHash(result.reviewContextHash, input.expectedReviewContextHash)
  if (result.decision === 'UNCHANGED') return input.candidate

  const candidateByPage = new Map(input.candidate.slideBriefs.map((slide) => [slide.pageNumber, slide]))
  const patchesByPage = new Map(result.revisedSlides.map((slide) => [slide.pageNumber, slide]))
  const reportedPages = new Set(result.findings.flatMap((finding) => finding.pageNumbers))
  if ([...reportedPages].some((pageNumber) => !candidateByPage.has(pageNumber))) {
    throw new Error('V4_REFLECTION_FINDING_PAGE_OUT_OF_RANGE')
  }
  if (result.revisedSlides.some((slide) => !reportedPages.has(slide.pageNumber))) {
    throw new Error('V4_REFLECTION_UNREPORTED_PAGE_MUTATION')
  }
  if ([...reportedPages].some((pageNumber) => !patchesByPage.has(pageNumber))) {
    throw new Error('V4_REFLECTION_APPLIED_FINDING_NO_CHANGE')
  }

  const changesByPage = new Map<number, string[]>()
  const mergedByPage = new Map<number, (typeof input.candidate.slideBriefs)[number]>()
  for (const patch of result.revisedSlides) {
    const candidate = candidateByPage.get(patch.pageNumber)
    if (!candidate) throw new Error('V4_REFLECTION_UNREPORTED_PAGE_MUTATION')
    const revised = { ...candidate, ...patch }
    const changedPaths = changedLeafPaths(candidate, revised)
    if (changedPaths.some((changedPath) => !result.findings.some((finding) =>
      finding.pageNumbers.includes(patch.pageNumber)
      && finding.fieldPaths.some((fieldPath) => fieldCoversChange(fieldPath, changedPath))))) {
      throw new Error('V4_REFLECTION_CHANGE_OUT_OF_SCOPE')
    }
    changesByPage.set(patch.pageNumber, changedPaths)
    mergedByPage.set(patch.pageNumber, revised)
  }

  if (result.findings.some((finding) =>
    !finding.pageNumbers.every((pageNumber) => {
      const changedPaths = changesByPage.get(pageNumber) ?? []
      return finding.fieldPaths.some((fieldPath) =>
        changedPaths.some((changedPath) => fieldCoversChange(fieldPath, changedPath)))
    })
    || !finding.fieldPaths.every((fieldPath) => finding.pageNumbers.some((pageNumber) =>
      (changesByPage.get(pageNumber) ?? []).some((changedPath) =>
        fieldCoversChange(fieldPath, changedPath)))))) {
    throw new Error('V4_REFLECTION_APPLIED_FINDING_NO_CHANGE')
  }

  return visualDeckV4SlideBriefsStageSchema.parse({
    slideBriefs: input.candidate.slideBriefs.map((slide) => mergedByPage.get(slide.pageNumber) ?? slide),
  })
}

export function resolveVisualDeckV4DeckVisualReflection(
  candidate: VisualDeckV4DeckVisualStage,
  value: unknown,
  expectedReviewContextHash: string,
): VisualDeckV4DeckVisualReflectionStageOutput {
  const persisted = visualDeckV4DeckVisualReflectionStageOutputSchema.safeParse(value)
  if (persisted.success) {
    const expected = applyVisualDeckV4DeckVisualReflection({
      candidate,
      result: persisted.data.reflection,
      expectedReviewContextHash,
    })
    if (!isDeepStrictEqual(expected, persisted.data.artifact)) throw new Error('V4_REFLECTION_PERSISTED_ARTIFACT_MISMATCH')
    return persisted.data
  }
  const reflection = visualDeckV4DeckVisualReflectionResultSchema.parse(value)
  return visualDeckV4DeckVisualReflectionStageOutputSchema.parse({
    reflection,
    artifact: applyVisualDeckV4DeckVisualReflection({ candidate, result: reflection, expectedReviewContextHash }),
  })
}

export function resolveVisualDeckV4SlideBriefsReflection(
  candidate: VisualDeckV4SlideBriefsStage,
  value: unknown,
  expectedReviewContextHash: string,
): VisualDeckV4SlideBriefsReflectionStageOutput {
  const persisted = visualDeckV4SlideBriefsReflectionStageOutputSchema.safeParse(value)
  if (persisted.success) {
    const expected = applyVisualDeckV4SlideBriefsReflection({
      candidate,
      result: persisted.data.reflection,
      expectedReviewContextHash,
    })
    if (!isDeepStrictEqual(expected, persisted.data.artifact)) throw new Error('V4_REFLECTION_PERSISTED_ARTIFACT_MISMATCH')
    return persisted.data
  }
  const reflection = visualDeckV4SlideBriefsReflectionResultSchema.parse(value)
  return visualDeckV4SlideBriefsReflectionStageOutputSchema.parse({
    reflection,
    artifact: applyVisualDeckV4SlideBriefsReflection({ candidate, result: reflection, expectedReviewContextHash }),
  })
}

import { hashInput } from './hash'
import type { DocumentResult, RunRecord, SourceChunk, StepRecord } from './ports'

export const V4_EVIDENCE_WINDOW_VERSION = 'v4-evidence-window-v1'
export const V4_EVIDENCE_WINDOW_MAX_CHARACTERS = 96_000
export const V4_EVIDENCE_CHUNK_MAX_CHARACTERS = 12_000
export const V4_EVIDENCE_WINDOW_MAX_CHUNKS = 200
export const v4EvidenceWindowStepKey = (runId: string) => `${runId}:v4:evidence-window`

export type V4EvidenceWindow = Readonly<{
  chunks: readonly SourceChunk[]
  audit: V4EvidenceWindowAudit
}>

export type V4EvidenceWindowAudit = Readonly<{
  version: typeof V4_EVIDENCE_WINDOW_VERSION
  selectedChunkIds: readonly string[]
  selectedContentHash: string
  omittedChunkCount: number
  characterCount: number
  serializedByteCount: number
}>

function keywords(values: readonly (string | undefined)[]) {
  const matches = values.join('\n').normalize('NFKC').toLocaleLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu) ?? []
  return [...new Set(matches)].sort()
}

function eligibleChunks(document: DocumentResult) {
  if (!document.sources) return document.chunks
  const readySources = document.sources.filter((source) => source.status === 'READY')
  const readySourceIds = new Set(readySources.map((source) => source.id))
  const onlyReadySourceId = readySources.length === 1 ? readySources[0]!.id : undefined
  return document.chunks.flatMap((chunk) => {
    if (chunk.sourceId && readySourceIds.has(chunk.sourceId)) return [chunk]
    // FrameFlow's single attachment may carry source metadata without repeating its ID on every chunk.
    if (!chunk.sourceId && onlyReadySourceId) return [{ ...chunk, sourceId: onlyReadySourceId }]
    return []
  })
}

function sourceOrder(document: DocumentResult, chunks: readonly SourceChunk[]) {
  if (document.sources) {
    return [...new Set(document.sources.filter((source) => source.status === 'READY').map((source) => source.id))]
  }
  return [...new Set(chunks.map((chunk) => chunk.sourceId ?? '').filter(Boolean))]
}

function score(text: string, terms: readonly string[]) {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  return terms.reduce((total, term) => total + (normalized.includes(term) ? 1 : 0), 0)
}

function stableChunks(chunks: readonly SourceChunk[], terms: readonly string[]) {
  return [...chunks].sort((left, right) =>
    score(right.text, terms) - score(left.text, terms)
    || (left.pageStart ?? Number.MAX_SAFE_INTEGER) - (right.pageStart ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id))
}

export class V4EvidenceWindowCompiler {
  compile(input: Readonly<{
    document: DocumentResult
    instruction: string
    focus?: string
    goal?: string
  }>): V4EvidenceWindow {
    const chunks = eligibleChunks(input.document)
    const order = sourceOrder(input.document, chunks)
    const terms = keywords([input.instruction, input.focus, input.goal])
    const grouped = new Map(order.map((sourceId) => [
      sourceId,
      chunks.filter((chunk) => (chunk.sourceId ?? '') === sourceId),
    ]))
    const unbound = input.document.sources ? [] : chunks.filter((chunk) => !chunk.sourceId)
    if (unbound.length > 0) grouped.set('', unbound)
    const groupOrder = [...order, ...(unbound.length > 0 ? [''] : [])]
    const selected: SourceChunk[] = []
    const selectedIds = new Set<string>()
    let remainingCharacters = V4_EVIDENCE_WINDOW_MAX_CHARACTERS
    const serializedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2
    const boundedText = (value: string, characterLimit: number) => value.slice(0, Math.min(value.length, characterLimit))

    const nonEmptyGroups = groupOrder.filter((sourceId) => (grouped.get(sourceId)?.length ?? 0) > 0)
    const mandatoryLimit = Math.min(
      V4_EVIDENCE_CHUNK_MAX_CHARACTERS,
      Math.floor(V4_EVIDENCE_WINDOW_MAX_CHARACTERS / Math.max(1, nonEmptyGroups.length)),
    )
    const append = (chunk: SourceChunk, limit: number) => {
      if (selected.length >= V4_EVIDENCE_WINDOW_MAX_CHUNKS
        || selectedIds.has(chunk.id) || remainingCharacters <= 0 || limit <= 0) return
      const text = boundedText(chunk.text, Math.min(limit, remainingCharacters))
      if (!text) return
      selected.push({ ...chunk, text })
      selectedIds.add(chunk.id)
      remainingCharacters -= text.length
    }

    for (const sourceId of nonEmptyGroups) append(grouped.get(sourceId)![0]!, mandatoryLimit)

    const queues = new Map(nonEmptyGroups.map((sourceId) => [
      sourceId,
      stableChunks(grouped.get(sourceId)!.slice(1), terms),
    ]))
    while (selected.length < V4_EVIDENCE_WINDOW_MAX_CHUNKS
      && remainingCharacters > 0
      && [...queues.values()].some((queue) => queue.length > 0)) {
      for (const sourceId of nonEmptyGroups) {
        const chunk = queues.get(sourceId)?.shift()
        if (chunk) append(chunk, V4_EVIDENCE_CHUNK_MAX_CHARACTERS)
        if (selected.length >= V4_EVIDENCE_WINDOW_MAX_CHUNKS || remainingCharacters <= 0) break
      }
    }

    return {
      chunks: selected,
      audit: {
        version: V4_EVIDENCE_WINDOW_VERSION,
        selectedChunkIds: selected.map((chunk) => chunk.id),
        selectedContentHash: hashInput(selected.map((chunk) => ({ id: chunk.id, text: chunk.text }))),
        omittedChunkCount: input.document.chunks.length - selected.length,
        characterCount: selected.reduce((total, chunk) => total + chunk.text.length, 0),
        serializedByteCount: selected.reduce((total, chunk) => total + serializedBytes(chunk.text), 0),
      },
    }
  }
}

function isPersistedAudit(value: unknown): value is V4EvidenceWindowAudit {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<V4EvidenceWindowAudit>
  return candidate.version === V4_EVIDENCE_WINDOW_VERSION
    && Array.isArray(candidate.selectedChunkIds)
    && candidate.selectedChunkIds.length <= V4_EVIDENCE_WINDOW_MAX_CHUNKS
    && new Set(candidate.selectedChunkIds).size === candidate.selectedChunkIds.length
    && candidate.selectedChunkIds.every((id) => typeof id === 'string' && id.length > 0)
    && typeof candidate.selectedContentHash === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.selectedContentHash)
    && typeof candidate.omittedChunkCount === 'number' && Number.isSafeInteger(candidate.omittedChunkCount) && candidate.omittedChunkCount >= 0
    && typeof candidate.characterCount === 'number' && Number.isSafeInteger(candidate.characterCount) && candidate.characterCount >= 0
    && typeof candidate.serializedByteCount === 'number' && Number.isSafeInteger(candidate.serializedByteCount) && candidate.serializedByteCount >= 0
}

export function compileV4EvidenceWindowForRun(input: Readonly<{
  run: Pick<RunRecord, 'visualDeckV4' | 'presentationGoal'>
  document: DocumentResult
}>): V4EvidenceWindow {
  const config = input.run.visualDeckV4
  if (!config) throw new Error('V4_EVIDENCE_WINDOW_CONFIG_MISSING')
  return new V4EvidenceWindowCompiler().compile({
    document: input.document,
    instruction: config.instruction,
    ...(config.deckOptions.focus ? { focus: config.deckOptions.focus } : {}),
    ...(input.run.presentationGoal ? { goal: input.run.presentationGoal } : {}),
  })
}

/** Rebuilds the durable selection so later Chain-4 calls cannot widen its source window. */
export function requirePersistedV4EvidenceWindow(input: Readonly<{
  run: Pick<RunRecord, 'id' | 'visualDeckV4' | 'presentationGoal'>
  document: DocumentResult
  steps: readonly StepRecord[]
}>): V4EvidenceWindow {
  const persisted = input.steps.find((step) => step.idempotencyKey === v4EvidenceWindowStepKey(input.run.id)
    && step.tool === 'compile_v4_evidence_window'
    && step.status === 'COMPLETED')
  if (!persisted) throw new Error('V4_EVIDENCE_WINDOW_MISSING')
  if (!isPersistedAudit(persisted.output)) throw new Error('V4_EVIDENCE_WINDOW_REPLAY_MISMATCH')
  const rebuilt = compileV4EvidenceWindowForRun(input)
  if (hashInput(persisted.output) !== hashInput(rebuilt.audit)) {
    throw new Error('V4_EVIDENCE_WINDOW_REPLAY_MISMATCH')
  }
  return rebuilt
}

import { hashInput } from './hash'
import type { DocumentResult, SourceChunk } from './ports'

export const V4_EVIDENCE_WINDOW_VERSION = 'v4-evidence-window-v1'
export const V4_EVIDENCE_WINDOW_MAX_CHARACTERS = 96_000
export const V4_EVIDENCE_CHUNK_MAX_CHARACTERS = 12_000

export type V4EvidenceWindow = Readonly<{
  chunks: readonly SourceChunk[]
  audit: Readonly<{
    version: typeof V4_EVIDENCE_WINDOW_VERSION
    selectedChunkIds: readonly string[]
    selectedContentHash: string
    omittedChunkCount: number
    characterCount: number
  }>
}>

function keywords(values: readonly (string | undefined)[]) {
  const matches = values.join('\n').normalize('NFKC').toLocaleLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu) ?? []
  return [...new Set(matches)].sort()
}

function sourceOrder(document: DocumentResult) {
  const ready = (document.sources ?? []).filter((source) => source.status === 'READY').map((source) => source.id)
  const remaining = document.chunks.map((chunk) => chunk.sourceId ?? '').filter(Boolean)
  return [...new Set([...ready, ...remaining])]
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
    const order = sourceOrder(input.document)
    const terms = keywords([input.instruction, input.focus, input.goal])
    const grouped = new Map(order.map((sourceId) => [
      sourceId,
      input.document.chunks.filter((chunk) => (chunk.sourceId ?? '') === sourceId),
    ]))
    const unbound = input.document.chunks.filter((chunk) => !chunk.sourceId)
    if (unbound.length > 0) grouped.set('', unbound)
    const groupOrder = [...order, ...(unbound.length > 0 ? [''] : [])]
    const selected: SourceChunk[] = []
    const selectedIds = new Set<string>()
    let remaining = V4_EVIDENCE_WINDOW_MAX_CHARACTERS

    const nonEmptyGroups = groupOrder.filter((sourceId) => (grouped.get(sourceId)?.length ?? 0) > 0)
    const mandatoryLimit = Math.min(
      V4_EVIDENCE_CHUNK_MAX_CHARACTERS,
      Math.floor(V4_EVIDENCE_WINDOW_MAX_CHARACTERS / Math.max(1, nonEmptyGroups.length)),
    )
    const append = (chunk: SourceChunk, limit: number) => {
      if (selectedIds.has(chunk.id) || remaining <= 0 || limit <= 0) return
      const text = chunk.text.slice(0, Math.min(limit, remaining))
      if (!text) return
      selected.push({ ...chunk, text })
      selectedIds.add(chunk.id)
      remaining -= text.length
    }

    for (const sourceId of nonEmptyGroups) append(grouped.get(sourceId)![0]!, mandatoryLimit)

    const queues = new Map(nonEmptyGroups.map((sourceId) => [
      sourceId,
      stableChunks(grouped.get(sourceId)!.slice(1), terms),
    ]))
    while (remaining > 0 && [...queues.values()].some((queue) => queue.length > 0)) {
      for (const sourceId of nonEmptyGroups) {
        const chunk = queues.get(sourceId)?.shift()
        if (chunk) append(chunk, V4_EVIDENCE_CHUNK_MAX_CHARACTERS)
        if (remaining <= 0) break
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
      },
    }
  }
}

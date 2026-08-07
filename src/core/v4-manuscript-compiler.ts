import type { RevisionPlan } from '../presentation-contracts'
import {
  visualDeckV4ProposalDraftSchema,
  type VisualDeckV4CreativeManuscript,
  type VisualDeckV4ProposalDraft,
  type VisualDeckV4ReviewManuscript,
  type VisualDeckV4SlideBrief,
} from '../visual-deck-v4-contracts'
import type { SourceChunk } from './ports'
import {
  compileVisualDeckV4Proposal,
  type VisualDeckV4CompilerInput,
} from './visual-deck-v4-planner'

export class V4ManuscriptCompilationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'V4ManuscriptCompilationError'
  }
}

function compact(value: string, maximum: number) {
  return value.replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function unique(values: readonly string[]) {
  return [...new Set(values.map((value) => compact(value, 1_500)).filter(Boolean))]
}

function normalizedEvidence(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, '')
}

function extractNumbers(values: readonly string[]) {
  return unique(values
    .join('\n')
    .match(/[-+]?\d+(?:[.,]\d+)?(?:[%％])?/g) ?? [])
    .slice(0, 20)
}

function extractFormulas(values: readonly string[]) {
  return unique(values
    .filter((value) => /\d/.test(value) && ['=', '+', '-', '×', '*', '÷', '/'].some((symbol) => value.includes(symbol))))
    .slice(0, 20)
}

export class SourceEvidenceResolver {
  resolve(input: Readonly<{
    sourceMode: 'SOURCE_GROUNDED' | 'OPEN_KNOWLEDGE'
    evidence: VisualDeckV4CreativeManuscript['slides'][number]['sourceEvidence']
    chunks: readonly SourceChunk[]
  }>): readonly string[] {
    if (input.sourceMode === 'OPEN_KNOWLEDGE') return []
    if (input.evidence.length === 0) {
      throw new V4ManuscriptCompilationError('V4_MANUSCRIPT_SOURCE_EVIDENCE_REQUIRED')
    }
    const resolved: string[] = []
    for (const evidence of input.evidence) {
      const excerpt = normalizedEvidence(evidence.excerpt)
      if (excerpt.length < 6) {
        throw new V4ManuscriptCompilationError('V4_MANUSCRIPT_SOURCE_EVIDENCE_TOO_SHORT')
      }
      const matches = input.chunks.filter((chunk) => normalizedEvidence(chunk.text).includes(excerpt))
      if (matches.length === 0) {
        throw new V4ManuscriptCompilationError('V4_MANUSCRIPT_SOURCE_EVIDENCE_UNRESOLVED')
      }
      if (matches.length > 1) {
        throw new V4ManuscriptCompilationError('V4_MANUSCRIPT_SOURCE_EVIDENCE_AMBIGUOUS')
      }
      const match = matches[0]!
      if (!resolved.includes(match.id)) resolved.push(match.id)
    }
    return resolved
  }
}

type ManuscriptSlide = VisualDeckV4CreativeManuscript['slides'][number]

export class V4PlanCompiler {
  constructor(private readonly evidenceResolver = new SourceEvidenceResolver()) {}

  compile(input: VisualDeckV4CompilerInput, manuscript: VisualDeckV4ReviewManuscript): VisualDeckV4ProposalDraft {
    const template = compileVisualDeckV4Proposal(input)
    if (manuscript.slides.length !== input.slideCount) {
      throw new V4ManuscriptCompilationError('V4_MANUSCRIPT_SLIDE_COUNT_MISMATCH')
    }
    const { compilerVersion: _compilerVersion, ...draft } = template
    const slideBriefs = manuscript.slides.map((slide, index) => this.compileSlide({
      input,
      template: draft.slideBriefs[index]!,
      manuscript: slide,
      pageNumber: index + 1,
      allTitles: manuscript.slides.map((candidate) => candidate.title),
    }))
    return visualDeckV4ProposalDraftSchema.parse({
      ...draft,
      deckPlan: {
        ...draft.deckPlan,
        title: compact(manuscript.title, 160),
        narrativeArc: manuscript.narrative.map((item) => compact(item, 500)).slice(0, 20),
      },
      slideBriefs,
    })
  }

  compileSlide(input: Readonly<{
    input: VisualDeckV4CompilerInput
    template: VisualDeckV4SlideBrief
    manuscript: ManuscriptSlide
    pageNumber: number
    allTitles: readonly string[]
  }>): VisualDeckV4SlideBrief {
    const visibleCopy = unique(input.manuscript.userVisibleCopy).slice(0, 8)
    const sourceMode = input.input.config.sourceMode === 'AUTO' ? 'SOURCE_GROUNDED' : input.input.config.sourceMode
    const resolvedSourceChunkIds = this.evidenceResolver.resolve({
      sourceMode,
      evidence: input.manuscript.sourceEvidence,
      chunks: input.input.document.chunks,
    })
    const sourceChunkIds = sourceMode === 'OPEN_KNOWLEDGE'
      ? input.template.sourceChunkIds
      : resolvedSourceChunkIds
    const role = input.template.role
    const previousTitle = input.allTitles[input.pageNumber - 2]
    const nextTitle = input.allTitles[input.pageNumber]
    const visualDescription = compact(input.manuscript.visualDescription, 1_000)
    const narrative = compact(input.manuscript.narrative, 1_000)
    const title = compact(input.manuscript.title, 120)
    return {
      pageNumber: input.pageNumber,
      role,
      title,
      keyClaim: narrative,
      audienceTakeaway: compact(`理解：${narrative}`, 1_000),
      lockedCopy: visibleCopy,
      facts: unique(input.manuscript.factualStatements).map((fact) => compact(fact, 500)).slice(0, 20),
      numbers: extractNumbers([title, ...visibleCopy]),
      formulas: extractFormulas([title, ...visibleCopy]),
      sourceChunkIds: [...sourceChunkIds],
      visualMetaphor: visualDescription,
      composition: this.composition(role, input.pageNumber, input.input.slideCount, visualDescription),
      informationHierarchy: [
        `标题：${title}`,
        `叙事：${narrative}`,
        '用户可见文案优先于装饰信息',
      ].map((item) => compact(item, 300)),
      previousSlideRelation: previousTitle
        ? `承接上一页“${compact(previousTitle, 120)}”并推进当前叙事`
        : null,
      nextSlideRelation: nextTitle
        ? `为下一页“${compact(nextTitle, 120)}”建立认知前提`
        : null,
    }
  }

  private composition(role: VisualDeckV4SlideBrief['role'], pageNumber: number, slideCount: number, visualDescription: string) {
    if (role === 'SINGLE') return compact(`唯一页面以${visualDescription}作为主视觉，同时保留主题和核心结论的自然留白。`, 1_000)
    if (role === 'COVER') return compact(`以${visualDescription}建立主题焦点，保留清晰的标题留白。`, 1_000)
    if (role === 'SUMMARY') return compact(`以${visualDescription}收束全稿，保留结论文案的稳定阅读区。`, 1_000)
    const side = pageNumber % 2 === 0 ? '右侧' : '左侧'
    return compact(`在${side}组织${visualDescription}，另一侧保留连续、无边框的文案留白；这是第 ${pageNumber}/${slideCount} 页。`, 1_000)
  }
}

export class RevisionCompiler {
  constructor(
    private readonly planCompiler = new V4PlanCompiler(),
  ) {}

  compile(input: Readonly<{
    compilerInput: VisualDeckV4CompilerInput
    base: VisualDeckV4ProposalDraft
    plan: RevisionPlan
    manuscript: VisualDeckV4ReviewManuscript
  }>): VisualDeckV4ProposalDraft {
    const operationsByPage = new Map<number, RevisionPlan['operations'][number][]>()
    for (const operation of input.plan.operations) {
      const pageNumber = Number(operation.slideId.split(':').at(-1))
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        throw new V4ManuscriptCompilationError('REVISION_MANUSCRIPT_PAGE_BINDING_INVALID')
      }
      const operations = operationsByPage.get(pageNumber) ?? []
      operations.push(operation)
      operationsByPage.set(pageNumber, operations)
    }
    const targetPages = [...operationsByPage.entries()]
      .filter(([, operations]) => operations.some((operation) => operation.kind !== 'REGENERATE_IMAGE'))
      .sort(([left], [right]) => left - right)
    if (input.manuscript.slides.length !== targetPages.length) {
      throw new V4ManuscriptCompilationError('REVISION_MANUSCRIPT_SLOT_COUNT_MISMATCH')
    }
    const titles = input.base.slideBriefs.map((slide) => slide.title)
    const slideBriefs = input.base.slideBriefs.map((template, index) => {
      const targetIndex = targetPages.findIndex(([pageNumber]) => pageNumber === index + 1)
      if (targetIndex < 0) return structuredClone(template)
      const operations = targetPages[targetIndex]![1]
      const semantic = input.manuscript.slides[targetIndex]!
      const compiled = this.planCompiler.compileSlide({
        input: input.compilerInput,
        template,
        manuscript: semantic,
        pageNumber: index + 1,
        allTitles: titles,
      })
      const hasContent = operations.some((operation) => operation.kind === 'UPDATE_CONTENT')
      if (hasContent) return compiled
      return {
        ...template,
        visualMetaphor: compiled.visualMetaphor,
        composition: compiled.composition,
        informationHierarchy: compiled.informationHierarchy,
        previousSlideRelation: compiled.previousSlideRelation,
        nextSlideRelation: compiled.nextSlideRelation,
      }
    })
    return visualDeckV4ProposalDraftSchema.parse({ ...input.base, slideBriefs })
  }
}

export class ManuscriptCompiler {
  constructor(
    private readonly planCompiler = new V4PlanCompiler(),
    private readonly revisionCompiler = new RevisionCompiler(planCompiler),
  ) {}

  compilePlan(
    input: VisualDeckV4CompilerInput,
    creative: VisualDeckV4CreativeManuscript,
    review: VisualDeckV4ReviewManuscript,
  ) {
    if (creative.slides.length !== review.slides.length || review.slides.length !== input.slideCount) {
      throw new V4ManuscriptCompilationError('V4_MANUSCRIPT_REVIEW_BINDING_INVALID')
    }
    return this.planCompiler.compile(input, review)
  }

  compileRevision(input: Parameters<RevisionCompiler['compile']>[0]) {
    return this.revisionCompiler.compile(input)
  }
}

import type { CreateRunRequest } from '../contracts'
import {
  isSupportedVisualDeckV4CompilerVersion,
  LEGACY_VISUAL_DECK_V4_COMPILER_VERSION,
  VISUAL_DECK_V4_COMPILER_VERSION,
} from '../release-identity'
import { presentationBlueprintSchema, type PresentationBlueprint } from '../presentation-contracts'
import {
  visualDeckV4ProposalSchema,
  type VisualDeckV4Config,
  type VisualDeckV4SourceSpecStage,
  type VisualDeckV4Proposal,
  type VisualDeckV4ProposalDraft,
  type VisualDeckV4SourceRole,
} from '../visual-deck-v4-contracts'
import { hashInput } from './hash'
import type { DocumentResult, SourceMaterial } from './ports'

export { VISUAL_DECK_V4_COMPILER_VERSION }

export type VisualDeckV4PlanningArtifact =
  | 'source-understanding'
  | 'presentation-spec'
  | 'deck-plan'
  | 'slide-briefs'
  | 'visual-contract'

export const LEGACY_V4_PLANNING_STAGES = [
  'source-spec',
  'deck-visual',
  'slide-briefs',
  'final-coherence',
] as const

export const V4_PLANNING_STAGES = [
  'source-spec',
  'deck-visual',
  'reflect-deck-visual',
  'slide-briefs',
  'reflect-slide-briefs',
] as const

export const V4_ALL_PLANNING_STAGES = [
  'source-spec',
  'deck-visual',
  'reflect-deck-visual',
  'slide-briefs',
  'reflect-slide-briefs',
  'final-coherence',
] as const

export type VisualDeckV4PlanningStage = (typeof V4_ALL_PLANNING_STAGES)[number]
export const V4_PLANNING_STAGE_COUNT = V4_PLANNING_STAGES.length

export function visualDeckV4PlanningStagesForCompiler(
  compilerVersion: string,
): readonly VisualDeckV4PlanningStage[] {
  return compilerVersion === LEGACY_VISUAL_DECK_V4_COMPILER_VERSION
    ? LEGACY_V4_PLANNING_STAGES
    : V4_PLANNING_STAGES
}

export function visualDeckV4PlanningStageStepKey(
  runId: string,
  stage: VisualDeckV4PlanningStage,
  attempt = 0,
  repairAttempt = 0,
) {
  const key = stage === 'reflect-deck-visual'
    ? `${runId}:v4:reflect:deck-visual:${attempt}`
    : stage === 'reflect-slide-briefs'
      ? `${runId}:v4:reflect:slide-briefs:${attempt}`
      : `${runId}:v4:${stage}:planning:${attempt}`
  return repairAttempt === 0 ? key : `${key}:repair:${repairAttempt}`
}

export function visualDeckV4PlanningArtifactStepKey(
  runId: string,
  artifact: VisualDeckV4PlanningArtifact,
  attempt = 0,
) {
  return `${runId}:v4:${artifact}:planning:${attempt}`
}

type CompileVisualDeckV4Input = Readonly<{
  runId: string
  inputHash: string
  source: CreateRunRequest['source']
  document: DocumentResult
  config: VisualDeckV4Config
  slideCount: number
  visualDirection: string
  targetAudience?: string
  presentationGoal?: string
  compilerVersion?: string
  createdAt: string
}>

const ROLE_SEQUENCE = [
  'CONTEXT', 'QUESTION', 'EXPLANATION', 'PROCESS', 'COMPARISON', 'EXPLANATION', 'PROCESS', 'PRACTICE',
] as const

const ROLE_LABELS = {
  COVER: '主题', SECTION: '章节', CONTEXT: '情境', QUESTION: '问题', EXPLANATION: '解释',
  COMPARISON: '对比', PROCESS: '过程', PRACTICE: '练习', SUMMARY: '总结',
} as const

function clipped(value: string, maximum: number) {
  return value.replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function compilerVersion(input: CompileVisualDeckV4Input) {
  const version = input.compilerVersion ?? VISUAL_DECK_V4_COMPILER_VERSION
  if (!isSupportedVisualDeckV4CompilerVersion(version)) {
    throw new Error('VISUAL_DECK_V4_COMPILER_UNSUPPORTED')
  }
  return version
}

function resolvedRole(role: VisualDeckV4SourceRole | undefined, fallback: Exclude<VisualDeckV4SourceRole, 'AUTO'>) {
  return !role || role === 'AUTO' ? fallback : role
}

function sourceRoleHints(source: CreateRunRequest['source']) {
  const hints = new Map<string, Exclude<VisualDeckV4SourceRole, 'AUTO'>>()
  if (source.kind === 'TEXT') hints.set('inline-source', resolvedRole(source.roleHint, 'CONTENT_SOURCE'))
  if (source.kind === 'HOST_ATTACHMENT') hints.set(source.attachmentId, resolvedRole(source.roleHint, 'CONTENT_SOURCE'))
  if (source.kind === 'APPROVED_PAGE_DESIGN') hints.set(source.artifactVersionId, 'DESIGN_REFERENCE')
  if (source.kind === 'SOURCE_PACKAGE') {
    for (const item of source.sources) hints.set(item.sourceId, resolvedRole(item.roleHint, 'CONTENT_SOURCE'))
  }
  return hints
}

function fallbackSource(source: CreateRunRequest['source'], document: DocumentResult): SourceMaterial {
  if (source.kind === 'HOST_ATTACHMENT') {
    return { id: source.attachmentId, name: document.name, kind: 'MARKDOWN', status: 'READY' }
  }
  if (source.kind === 'APPROVED_PAGE_DESIGN') {
    return { id: source.artifactVersionId, name: source.title, kind: 'MARKDOWN', status: 'READY' }
  }
  const id = source.kind === 'SOURCE_PACKAGE' ? source.sources[0]!.sourceId : 'inline-source'
  return { id, name: document.name, kind: 'TEXT', status: 'READY' }
}

function compileSourceUnderstanding(input: CompileVisualDeckV4Input) {
  const materials = input.document.sources?.length ? input.document.sources : [fallbackSource(input.source, input.document)]
  const hints = sourceRoleHints(input.source)
  const knownIds = new Set(materials.map((source) => source.id))
  const unassigned = input.document.chunks.filter((chunk) => !chunk.sourceId || !knownIds.has(chunk.sourceId))
  return {
    sourceMode: input.config.sourceMode === 'AUTO' ? 'SOURCE_GROUNDED' as const : input.config.sourceMode,
    instruction: input.config.instruction,
    sources: materials.map((source, index) => ({
      sourceId: source.id,
      name: source.name,
      role: hints.get(source.id) ?? (input.source.kind === 'APPROVED_PAGE_DESIGN' ? 'DESIGN_REFERENCE' as const : 'CONTENT_SOURCE' as const),
      confidence: hints.has(source.id) ? 1 : 0.8,
      status: source.status,
      sourceChunkIds: [
        ...input.document.chunks.filter((chunk) => chunk.sourceId === source.id).map((chunk) => chunk.id),
        ...(index === 0 ? unassigned.map((chunk) => chunk.id) : []),
      ],
      ...(source.failureCode ? { failureCode: source.failureCode } : {}),
    })),
    missingRanges: [...input.document.missingRanges],
  }
}

export function normalizeVisualDeckV4SourceSpecRequestBinding(
  input: CompileVisualDeckV4Input,
  candidate: VisualDeckV4SourceSpecStage,
): VisualDeckV4SourceSpecStage {
  const expected = compileSourceUnderstanding(input)
  const candidatesById = new Map(candidate.sourceUnderstanding.sources.map((source) => [source.sourceId, source]))
  if (candidatesById.size !== expected.sources.length
    || expected.sources.some((source) => !candidatesById.has(source.sourceId))) {
    throw new Error('VISUAL_DECK_V4_SOURCE_REFERENCE_INVALID')
  }
  const sources = expected.sources.map((source) => ({
    ...candidatesById.get(source.sourceId)!,
    sourceId: source.sourceId,
    name: source.name,
    role: source.role,
    status: source.status,
    sourceChunkIds: source.sourceChunkIds,
    ...(source.failureCode ? { failureCode: source.failureCode } : {}),
  }))
  const explicitAudience = input.config.deckOptions.audience ?? input.targetAudience
  const title = clipped(input.document.name.replace(/\.[^.]+$/, ''), 120) || '视觉演示'
  const audience = explicitAudience ?? '需要理解本主题的学习者'
  const goal = input.presentationGoal ?? input.config.instruction
  const focus = input.config.deckOptions.focus
    ? [
        input.config.deckOptions.focus,
        ...candidate.presentationSpec.focus.filter((item) => item !== input.config.deckOptions.focus),
      ].slice(0, 12)
    : [`围绕《${title}》建立清晰理解`]
  return {
    sourceUnderstanding: {
      ...candidate.sourceUnderstanding,
      sourceMode: expected.sourceMode,
      instruction: input.config.instruction,
      sources,
      missingRanges: expected.missingRanges,
    },
    presentationSpec: {
      ...candidate.presentationSpec,
      sourceMode: expected.sourceMode,
      deckType: input.config.deckOptions.deckType,
      language: input.config.deckOptions.language,
      slideCount: input.slideCount,
      audience,
      goal,
      focus,
      style: input.config.deckOptions.styleHint ?? input.visualDirection,
    },
  }
}

function compileChapters(slideCount: number) {
  if (slideCount <= 4) {
    return [{ chapterId: 'story', title: '完整叙事', purpose: '从主题建立到结论收束', slideNumbers: range(1, slideCount) }]
  }
  return [
    { chapterId: 'opening', title: '建立主题', purpose: '建立语境并提出核心问题', slideNumbers: [1, 2] },
    { chapterId: 'development', title: '展开理解', purpose: '解释、比较并组织核心资料', slideNumbers: range(3, slideCount - 2) },
    { chapterId: 'application', title: '应用与收束', purpose: '把理解用于练习并形成总结', slideNumbers: [slideCount - 1, slideCount] },
  ]
}

function range(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

function slideRole(pageNumber: number, slideCount: number) {
  if (pageNumber === 1) return 'COVER' as const
  if (pageNumber === slideCount) return 'SUMMARY' as const
  return ROLE_SEQUENCE[(pageNumber - 2) % ROLE_SEQUENCE.length]!
}

export function compileVisualDeckV4Proposal(input: CompileVisualDeckV4Input): VisualDeckV4Proposal {
  const resolvedCompilerVersion = compilerVersion(input)
  const sourceUnderstanding = compileSourceUnderstanding(input)
  const title = clipped(input.document.name.replace(/\.[^.]+$/, ''), 120) || '视觉演示'
  const focus = input.config.deckOptions.focus ? [input.config.deckOptions.focus] : [`围绕《${title}》建立清晰理解`]
  const audience = input.config.deckOptions.audience ?? input.targetAudience ?? '需要理解本主题的学习者'
  const goal = input.presentationGoal ?? input.config.instruction
  const style = input.config.deckOptions.styleHint ?? input.visualDirection
  const chunks = input.document.chunks
  const slideBriefs = Array.from({ length: input.slideCount }, (_, index) => {
    const pageNumber = index + 1
    const role = slideRole(pageNumber, input.slideCount)
    const chunk = chunks[index % chunks.length]!
    const excerpt = clipped(chunk.text, 220) || `围绕《${title}》的第 ${pageNumber} 页资料要点`
    const pageTitle = pageNumber === 1
      ? title
      : pageNumber === input.slideCount
        ? clipped(`总结：${title}`, 120)
        : clipped(`第${pageNumber}页·${ROLE_LABELS[role]}：${excerpt}`, 120)
    return {
      pageNumber,
      role,
      title: pageTitle,
      keyClaim: excerpt,
      audienceTakeaway: `理解本页如何支持“${clipped(goal, 300)}”`,
      lockedCopy: [pageTitle, excerpt],
      facts: [excerpt],
      numbers: [...new Set(excerpt.match(/\d+(?:\.\d+)?%?/g) ?? [])].slice(0, 20),
      formulas: [],
      sourceChunkIds: [chunk.id],
      visualMetaphor: `用单一、可辨认的${ROLE_LABELS[role]}视觉场景表达本页核心观点`,
      composition: pageNumber % 2 === 0
        ? '主要视觉位于右侧，左侧以清晰层级容纳锁定文案，整页形成一个连续画面'
        : '主要视觉位于左侧，右侧以清晰层级容纳锁定文案，整页形成一个连续画面',
      informationHierarchy: ['核心观点', '来源事实', '视觉关系'],
      previousSlideRelation: pageNumber === 1 ? null : `承接第 ${pageNumber - 1} 页并推进叙事`,
      nextSlideRelation: pageNumber === input.slideCount ? null : `为第 ${pageNumber + 1} 页建立认知前提`,
    }
  })
  return visualDeckV4ProposalSchema.parse({
    compilerVersion: resolvedCompilerVersion,
    sourceUnderstanding,
    presentationSpec: {
      sourceMode: sourceUnderstanding.sourceMode,
      deckType: input.config.deckOptions.deckType,
      language: input.config.deckOptions.language,
      audience,
      goal,
      slideCount: input.slideCount,
      focus,
      style,
      requiredCoverage: [...focus, '覆盖所有已解析来源块'],
      forbidden: ['不得虚构来源事实', '不得把其他页面内容拼入当前页'],
    },
    deckPlan: {
      title,
      slideCount: input.slideCount,
      narrativeArc: ['建立主题和核心问题', '逐步解释并组织来源事实', '通过应用和总结完成认知闭环'],
      chapters: compileChapters(input.slideCount),
    },
    slideBriefs,
    visualContract: {
      artDirection: style,
      palette: ['#F7F8F3', '#1F5A70', '#E8A23A', '#17232B'],
      typography: '清晰中文标题、稳健正文层级和高对比锁定文案',
      medium: '编辑插画、信息图与来源相关场景的统一视觉系统',
      visualDensity: input.config.deckOptions.deckType === 'PRESENTER_SLIDES' ? 'LOW' : 'MEDIUM',
      compositionRules: ['每页只承担一个主要认知任务', '每页只保留一个主要视觉焦点'],
      continuityRules: ['整套保持统一配色、材质和光线逻辑', '相邻页面通过构图变化形成连续节奏'],
      forbidden: ['缩略图拼贴', '无来源装饰', '水印和品牌标志'],
    },
  })
}

export function createVisualDeckV4BlueprintFromProposal(
  input: CompileVisualDeckV4Input,
  draft: VisualDeckV4ProposalDraft,
): PresentationBlueprint {
  const resolvedCompilerVersion = compilerVersion(input)
  const proposal = visualDeckV4ProposalSchema.parse({
    ...draft,
    compilerVersion: resolvedCompilerVersion,
  })
  const expectedSourceMode = input.config.sourceMode === 'AUTO' ? 'SOURCE_GROUNDED' : input.config.sourceMode
  const expectedAudience = input.config.deckOptions.audience ?? input.targetAudience
  if (proposal.sourceUnderstanding.instruction !== input.config.instruction
    || proposal.sourceUnderstanding.sourceMode !== expectedSourceMode
    || proposal.presentationSpec.sourceMode !== expectedSourceMode
    || proposal.presentationSpec.slideCount !== input.slideCount
    || proposal.presentationSpec.deckType !== input.config.deckOptions.deckType
    || proposal.presentationSpec.language !== input.config.deckOptions.language
    || (expectedAudience !== undefined && proposal.presentationSpec.audience !== expectedAudience)
    || (input.presentationGoal !== undefined && proposal.presentationSpec.goal !== input.presentationGoal)
    || (input.config.deckOptions.styleHint !== undefined
      && proposal.presentationSpec.style !== input.config.deckOptions.styleHint)
    || (input.config.deckOptions.focus !== undefined
      && !proposal.presentationSpec.focus.includes(input.config.deckOptions.focus))) {
    throw new Error('VISUAL_DECK_V4_REQUEST_MISMATCH')
  }
  const normalizedSourceSpec = normalizeVisualDeckV4SourceSpecRequestBinding(input, {
    sourceUnderstanding: proposal.sourceUnderstanding,
    presentationSpec: proposal.presentationSpec,
  })
  if (hashInput(normalizedSourceSpec) !== hashInput({
    sourceUnderstanding: proposal.sourceUnderstanding,
    presentationSpec: proposal.presentationSpec,
  })) {
    throw new Error('VISUAL_DECK_V4_REQUEST_MISMATCH')
  }
  const availableChunkIds = new Set(input.document.chunks.map((chunk) => chunk.id))
  const understoodChunks = proposal.sourceUnderstanding.sources.flatMap((source) => source.sourceChunkIds)
  const understoodChunkIds = new Set(understoodChunks)
  if (availableChunkIds.size !== understoodChunkIds.size
    || understoodChunks.length !== understoodChunkIds.size
    || [...availableChunkIds].some((chunkId) => !understoodChunkIds.has(chunkId))) {
    throw new Error('VISUAL_DECK_V4_SOURCE_COVERAGE_INVALID')
  }
  const expectedSourceIds = new Set(
    (input.document.sources?.length ? input.document.sources : [fallbackSource(input.source, input.document)])
      .map((source) => source.id),
  )
  if (proposal.sourceUnderstanding.sources.some((source) => !expectedSourceIds.has(source.sourceId))
    || proposal.slideBriefs.some((brief) => brief.sourceChunkIds.some((chunkId) => !availableChunkIds.has(chunkId)))) {
    throw new Error('VISUAL_DECK_V4_SOURCE_REFERENCE_INVALID')
  }
  const sourceChunkIds = input.document.chunks.map((chunk) => chunk.id)
  const sourceSummary = clipped(input.document.chunks.map((chunk) => chunk.text).join(' '), 4_000)
  return presentationBlueprintSchema.parse({
    id: `blueprint-${hashInput({ runId: input.runId, inputHash: input.inputHash, compiler: resolvedCompilerVersion }).slice(0, 28)}`,
    title: proposal.deckPlan.title,
    curriculum: {
      subject: null,
      grade: null,
      lessonTitle: proposal.deckPlan.title,
      sourceSummary: sourceSummary.length >= 20 ? sourceSummary : `${sourceSummary} ${proposal.presentationSpec.goal}`,
      learningObjectives: [clipped(proposal.presentationSpec.goal, 300)],
      scopeBoundaries: ['规划和后续修订必须保持来源绑定'],
      prohibitedExtensions: ['不得把无来源事实作为用户资料中的事实'],
      sourceChunkIds,
      sourceAssetIds: [],
    },
    slides: proposal.slideBriefs.map((brief) => ({
      pageNumber: brief.pageNumber,
      title: brief.title,
      body: brief.lockedCopy.map((copy) => clipped(copy, 300)),
      layout: brief.role === 'COVER' ? 'HERO' : brief.role === 'SUMMARY' ? 'STATEMENT' : brief.pageNumber % 2 === 0 ? 'SPLIT' : 'EDITORIAL',
      visualIntent: brief.visualMetaphor,
      visualPrompt: `V4页级视觉编译待执行：${brief.keyClaim}；${brief.composition}`,
      sourceChunkIds: brief.sourceChunkIds,
      sourceAssetIds: [],
    })),
    visualDirection: proposal.visualContract.artDirection,
    renderMode: 'VISUAL_DECK_V4',
    visualDeckV4Proposal: proposal,
    sourceManifest: input.document.sources ?? [],
    sourceAssets: (input.document.assets ?? []).map(({ bytes: _bytes, ...asset }) => asset),
    createdAt: input.createdAt,
  })
}

export function createVisualDeckV4Blueprint(input: CompileVisualDeckV4Input): PresentationBlueprint {
  const { compilerVersion: _compilerVersion, ...draft } = compileVisualDeckV4Proposal(input)
  return createVisualDeckV4BlueprintFromProposal(input, draft)
}

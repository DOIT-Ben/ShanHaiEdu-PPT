import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock, MockRevisionApplicationPort } from '../src/adapters/mock-ports'
import { getActiveBlueprint } from '../src/core/active-blueprint'
import { hashInput } from '../src/core/hash'
import { planningStepKey } from '../src/core/planning-runner'
import type { DocumentPort, DocumentResult, RunRecord } from '../src/core/ports'
import { StructuredModelError } from '../src/core/ports'
import { RevisionApplicationRunner } from '../src/core/revision-application-runner'
import { revisionPlanStepKey } from '../src/core/revision-planning-runner'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'
import { revisionPlanSchema } from '../src/presentation-contracts'
import { LEGACY_VISUAL_DECK_V4_COMPILER_VERSION } from '../src/release-identity'

function run(): RunRecord {
  return {
    id: 'run-1', creationKey: 'create-1', requestHash: 'hash',
    host: { tenantId: 'frameflow', externalUserId: 'user-1' },
    source: { kind: 'TEXT', text: '这是局部修订执行器使用的完整测试教材。' },
    slideCount: 2, visualDirection: '课堂科学信息图', imageModel: 'image-2',
    automationLevel: 'SUPERVISED', maxRevisionRounds: 2, revisionRound: 1,
    qualityScore: 72, status: 'REVISING', resumeState: null, version: 8,
    budgetUnits: 100, committedBudgetUnits: 20, qualityOverride: false,
    qualityOverrideReason: null, qualityOverrideBy: null, leaseToken: null,
    leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function blueprint() {
  return {
    id: 'blueprint-r0', title: '光合作用', visualDirection: '课堂科学信息图',
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '生物', grade: '七年级', lessonTitle: '光合作用',
      sourceSummary: '教材介绍绿色植物利用光能制造有机物并释放氧气的基本过程。',
      learningObjectives: ['理解光合作用'], scopeBoundaries: ['教材定性范围'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1', 'chunk-2'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber, title: pageNumber === 1 ? '认识光合作用' : '条件与产物',
      body: [pageNumber === 1 ? '绿色植物利用光能' : '产生有机物并释放氧气'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: `用课堂科学画面表达第 ${pageNumber} 页知识点`,
      visualPrompt: `A clean educational science illustration for page ${pageNumber}, no text or symbols`,
      sourceChunkIds: [`chunk-${pageNumber}`],
    })),
  }
}

function plan(kind: 'UPDATE_CONTENT' | 'REGENERATE_IMAGE' | 'RELAYOUT' = 'UPDATE_CONTENT') {
  return {
    id: 'revision-plan-r1', reviewId: 'deck-review-r0', revisionRound: 1,
    createdAt: '2026-07-21T00:00:00.000Z', summary: '仅修订第二页已经识别的问题。',
    operations: [{
      id: 'operation-1', slideId: 'run-1:slide:2', kind, issueIds: ['issue-1'],
      instruction: '依据教材限定条件修订第二页，不改变其他页面。', sourceChunkIds: ['chunk-2'],
    }],
  }
}

function draft() {
  const { id: _id, visualDirection: _visualDirection, createdAt: _createdAt, ...value } = blueprint()
  return structuredClone(value)
}

function layeredBlueprint() {
  const base = blueprint()
  return {
    ...base,
    renderMode: 'LAYERED_COURSEWARE_V3' as const,
    coverDesignMode: 'FOLLOW_TEMPLATE' as const,
    slides: base.slides.map((slide) => ({
      ...slide,
      layeredDesign: {
        designKind: slide.pageNumber === 1 ? 'COVER' as const : 'CONTENT' as const,
        backgroundColor: '#F7FBFA',
        elements: [
          {
            kind: 'IMAGE' as const, elementId: `base-${slide.pageNumber}`, role: 'BASE_LAYER' as const,
            knowledgePoint: '建立本页知识情境', prompt: 'A wide text-free science classroom background for this lesson',
            negativePrompt: 'text, logo, watermark', sourceChunkIds: slide.sourceChunkIds,
            placement: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 0,
            fit: 'COVER' as const, aspectRatio: '16:9' as const, backgroundMode: 'OPAQUE' as const,
          },
          {
            kind: 'IMAGE' as const, elementId: `knowledge-${slide.pageNumber}`, role: 'KNOWLEDGE_VISUAL' as const,
            knowledgePoint: '展示光合作用知识对象', prompt: 'A transparent leaf cutout explaining photosynthesis',
            negativePrompt: 'text, logo, watermark', sourceChunkIds: slide.sourceChunkIds,
            placement: { x: 0.62, y: 0.2, width: 0.3, height: 0.5 }, zIndex: 10,
            fit: 'CONTAIN' as const, aspectRatio: '1:1' as const, backgroundMode: 'TRANSPARENT' as const,
          },
          {
            kind: 'TEXT' as const, elementId: `title-${slide.pageNumber}`, role: 'TITLE' as const,
            text: slide.title, sourceChunkIds: slide.sourceChunkIds,
            placement: { x: 0.08, y: 0.2, width: 0.4, height: 0.2 }, zIndex: 20,
            style: { fontSize: 30, bold: true, color: '#17202A', align: 'LEFT' as const },
          },
        ],
      },
    })),
  }
}

function layeredDraft() {
  const { id: _id, visualDirection: _visualDirection, createdAt: _createdAt, renderMode: _renderMode,
    coverDesignMode: _coverDesignMode, ...value } = layeredBlueprint()
  return structuredClone(value)
}

function visualDeckV4Blueprint(slideCount = 2) {
  const { source, document, config } = visualDeckV4Input(slideCount)
  return createVisualDeckV4Blueprint({
    runId: 'run-1', inputHash: 'plan-hash', source, document, config,
    slideCount, visualDirection: '课堂科学信息图', createdAt: '2026-07-21T00:00:00.000Z',
  })
}

function visualDeckV4Input(slideCount = 2) {
  const source = {
    kind: 'SOURCE_PACKAGE' as const,
    name: '光合作用教材',
    sources: [
      { kind: 'TEXT' as const, sourceId: 'source-1', name: '定义.txt', text: '绿色植物利用光能。'.repeat(8) },
      { kind: 'TEXT' as const, sourceId: 'source-2', name: '过程.txt', text: '制造有机物并释放氧气。'.repeat(8) },
    ],
  }
  return {
    source,
    document: {
      name: source.name, isComplete: true, missingRanges: [],
      chunks: [
        { id: 'chunk-1', sourceId: 'source-1', text: source.sources[0]!.text, sha256: 'sha-1' },
        { id: 'chunk-2', sourceId: 'source-2', text: source.sources[1]!.text, sha256: 'sha-2' },
      ],
      sources: [
        { id: 'source-1', name: '定义.txt', kind: 'TEXT' as const, status: 'READY' as const },
        { id: 'source-2', name: '过程.txt', kind: 'TEXT' as const, status: 'READY' as const },
      ],
    },
    config: {
      instruction: '制作两页光合作用视觉演示', sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount }, aspectRatio: '16:9',
        audience: '七年级学生', focus: '理解光合作用', styleHint: '课堂科学信息图',
      },
    },
  } as const
}

function v4LayoutPatch(
  brief: NonNullable<ReturnType<typeof visualDeckV4Blueprint>['visualDeckV4Proposal']>['slideBriefs'][number],
  label: string,
) {
  return {
    pageNumber: brief.pageNumber,
    visualMetaphor: `${brief.visualMetaphor}；${label}`,
    composition: `${brief.composition}；${label}`,
    informationHierarchy: [...brief.informationHierarchy, label],
    previousSlideRelation: brief.previousSlideRelation,
    nextSlideRelation: brief.nextSlideRelation,
  }
}

function v4ContentPatch(
  brief: NonNullable<ReturnType<typeof visualDeckV4Blueprint>['visualDeckV4Proposal']>['slideBriefs'][number],
) {
  return {
    pageNumber: brief.pageNumber,
    title: brief.title,
    keyClaim: brief.keyClaim,
    audienceTakeaway: brief.audienceTakeaway,
    lockedCopy: brief.lockedCopy,
    facts: brief.facts,
    numbers: brief.numbers,
    formulas: brief.formulas,
    sourceChunkIds: brief.sourceChunkIds,
    visualMetaphor: brief.visualMetaphor,
    composition: brief.composition,
    informationHierarchy: brief.informationHierarchy,
    previousSlideRelation: brief.previousSlideRelation,
    nextSlideRelation: brief.nextSlideRelation,
  }
}

function realMixedV4RevisionPlan() {
  const operation = (
    pageNumber: number,
    kind: 'UPDATE_CONTENT' | 'REGENERATE_IMAGE' | 'RELAYOUT',
    issueId: string,
    sourceChunkIds: string[] = [],
  ) => ({
    id: `operation-${pageNumber}-${kind.toLowerCase()}`,
    slideId: `run-1:slide:${pageNumber}`,
    kind,
    issueIds: [issueId],
    instruction: `只修订第 ${pageNumber} 页的 ${kind} 问题，不改变其他页面。`,
    sourceChunkIds,
  })
  return {
    id: 'revision-plan-r1', reviewId: 'deck-review-r0', revisionRound: 1,
    createdAt: '2026-07-21T00:00:00.000Z',
    summary: '复现真实九项操作：两页规划不变重绘、两页布局补丁和四页纯素材重绘。',
    operations: [
      operation(3, 'REGENERATE_IMAGE', 'issue-1'),
      operation(9, 'UPDATE_CONTENT', 'issue-2', ['chunk-1']),
      operation(8, 'RELAYOUT', 'issue-3'),
      operation(10, 'RELAYOUT', 'issue-4'),
      operation(5, 'REGENERATE_IMAGE', 'issue-5'),
      operation(6, 'REGENERATE_IMAGE', 'issue-5'),
      operation(7, 'REGENERATE_IMAGE', 'issue-5'),
      operation(8, 'REGENERATE_IMAGE', 'issue-5'),
      operation(1, 'UPDATE_CONTENT', 'issue-6', ['chunk-1']),
    ],
  }
}

class StaticDocumentPort implements DocumentPort {
  constructor(private readonly result: DocumentResult = {
      name: '教材.txt', isComplete: true, missingRanges: [],
      chunks: [
        { id: 'chunk-1', text: '绿色植物利用光能。', sha256: 'sha-1' },
        { id: 'chunk-2', text: '制造有机物并释放氧气。', sha256: 'sha-2' },
      ],
    }) {}
  async resolve() { return structuredClone(this.result) }
}

async function fixture(
  response: unknown,
  revisionPlan = plan(),
  baseBlueprint: unknown = blueprint(),
  options: Readonly<{ runOverrides?: Partial<RunRecord>; documents?: DocumentPort }> = {},
) {
  const repository = new InMemoryAgentRepository()
  const application = new MockRevisionApplicationPort(response)
  await repository.createRun({ ...run(), ...options.runOverrides })
  await repository.transact('run-1', (transaction) => {
    transaction.putStep({
      id: 'step-plan', runId: 'run-1', idempotencyKey: planningStepKey('run-1'), inputHash: 'plan-hash',
      tool: 'create_blueprint', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: baseBlueprint,
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
    transaction.putStep({
      id: 'step-revision-plan', runId: 'run-1', idempotencyKey: revisionPlanStepKey('run-1', 1), inputHash: 'revision-plan-hash',
      tool: 'plan_revision', status: 'COMPLETED', budgetUnits: 0, budgetReservationId: null,
      externalOperationId: null, errorCode: null, output: revisionPlan,
      createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
    })
  })
  return {
    repository, application,
    runner: new RevisionApplicationRunner({
      repository, documents: options.documents ?? new StaticDocumentPort(), application, clock: new FixedClock(),
      sleep: async () => {},
    }),
  }
}

describe('revision application runner', () => {
  test('updates only the planned content slide and returns to deck review', async () => {
    const revised = draft()
    revised.slides[1]!.body = ['在光照条件下制造有机物并释放氧气']
    const { repository, runner } = await fixture(revised)
    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'DECK_REVIEW', requiresMedia: false, replayed: false })
    expect(result.blueprint?.slides[0]?.body).toEqual(blueprint().slides[0]?.body)
    expect(result.blueprint?.slides[1]?.body).toEqual(revised.slides[1]?.body)
    expect((await getActiveBlueprint(repository, 'run-1', 1)).id).toBe('run-1:blueprint:r1')
  })

  test('rejects changes to a slide outside the revision plan', async () => {
    const revised = draft()
    revised.slides[0]!.title = '擅自修改的第一页'
    const { repository, runner } = await fixture(revised)
    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'NEEDS_HUMAN', blueprint: null, step: { errorCode: 'REVISION_APPLICATION_FAILED' } })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'NEEDS_HUMAN' })
  })

  test('keeps the run in revision when the plan requires a regenerated image', async () => {
    const revised = draft()
    revised.slides[1]!.visualPrompt = 'A corrected educational oxygen release illustration, no text or symbols'
    const { repository, runner } = await fixture(revised, plan('REGENERATE_IMAGE'))
    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'REVISING', requiresMedia: true })
    expect(await repository.getRun('run-1')).toMatchObject({ status: 'REVISING', revisionRound: 1 })
  })

  test('retries a transient application provider failure without consuming a contract repair attempt', async () => {
    const revised = draft()
    revised.slides[1]!.body = ['在光照条件下制造有机物并释放氧气']
    const { application, runner } = await fixture(revised)
    const applyOnce = application.apply.bind(application)
    const keys: string[] = []
    application.apply = async (input) => {
      keys.push(input.idempotencyKey)
      if (keys.length < 3) {
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6', `apply-request-${keys.length}`)
      }
      return applyOnce(input)
    }

    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'DECK_REVIEW', blueprint: { id: 'run-1:blueprint:r1' } })
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(1)
  })

  test('persists the final application provider diagnostic after bounded retries are exhausted', async () => {
    const { repository, application, runner } = await fixture(draft())
    let attempts = 0
    application.apply = async () => {
      attempts += 1
      throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, 'gpt-5.6', `apply-request-${attempts}`)
    }

    const result = await runner.apply('run-1')

    expect(attempts).toBe(5)
    expect(result).toMatchObject({
      status: 'NEEDS_HUMAN',
      step: {
        status: 'FAILED',
        errorCode: 'PROVIDER_UNAVAILABLE',
        output: {
          diagnostic: {
            providerAttempt: 5,
            maxProviderAttempts: 5,
            model: 'gpt-5.6',
            requestId: 'apply-request-5',
          },
        },
      },
    })
    const failed = (await repository.listEvents('run-1')).find((event) => event.type === 'tool.failed')
    expect(failed?.payload).toMatchObject({ errorCode: 'PROVIDER_UNAVAILABLE', retryable: false })
  })

  test('preserves the approved v4 plan for a page-only redraw without another model rewrite', async () => {
    const base = visualDeckV4Blueprint()
    const { application, runner } = await fixture({}, plan('REGENERATE_IMAGE'), base)

    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'REVISING', requiresMedia: true, replayed: false })
    expect(result.blueprint?.visualDeckV4Proposal).toEqual(base.visualDeckV4Proposal)
    expect(result.blueprint?.slides).toEqual(base.slides)
    expect(application.requests.size).toBe(0)
  })

  test('applies the real mixed V4 revision shape with scoped patches and redraw-only pages', async () => {
    const slideCount = 12
    const base = visualDeckV4Blueprint(slideCount)
    const input = visualDeckV4Input(slideCount)
    const beforeProposal = structuredClone(base.visualDeckV4Proposal!)
    const response = {
      contentPatches: [],
      layoutPatches: [
        v4LayoutPatch(beforeProposal.slideBriefs[7]!, '修正第8页操作方向'),
        v4LayoutPatch(beforeProposal.slideBriefs[9]!, '澄清第10页填写任务'),
      ],
      redrawOnlyPageNumbers: [1, 9],
    }
    const { application, runner } = await fixture(response, realMixedV4RevisionPlan(), base, {
      runOverrides: {
        source: input.source,
        slideCount,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: input.config,
      },
      documents: new StaticDocumentPort(input.document),
    })

    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'REVISING', requiresMedia: true, replayed: false })
    expect(application.requests.size).toBe(1)
    const after = result.blueprint?.visualDeckV4Proposal
    expect(after).toBeDefined()
    for (const field of ['sourceUnderstanding', 'presentationSpec', 'deckPlan', 'visualContract'] as const) {
      expect(after?.[field]).toEqual(beforeProposal[field])
    }
    expect(after?.slideBriefs[0]).toEqual(beforeProposal.slideBriefs[0])
    expect(after?.slideBriefs[8]).toEqual(beforeProposal.slideBriefs[8])
    expect(after?.slideBriefs[1]).toEqual(beforeProposal.slideBriefs[1])
    expect(after?.slideBriefs[7]?.composition).toContain('修正第8页操作方向')
    expect(after?.slideBriefs[9]?.composition).toContain('澄清第10页填写任务')
  })

  test('keeps chain-1 full-draft revision parsing, persistence and replay', async () => {
    const base = visualDeckV4Blueprint()
    base.visualDeckV4Proposal!.compilerVersion = LEGACY_VISUAL_DECK_V4_COMPILER_VERSION
    const { compilerVersion: _compilerVersion, ...legacyDraft } = structuredClone(base.visualDeckV4Proposal!)
    legacyDraft.slideBriefs[1]!.keyClaim = '绿色植物在光照下制造有机物并释放氧气。'
    legacyDraft.slideBriefs[1]!.facts = ['绿色植物在光照下制造有机物并释放氧气。']
    const input = visualDeckV4Input()
    const revisionPlan = {
      ...plan('UPDATE_CONTENT'),
      operations: [{ ...plan('UPDATE_CONTENT').operations[0]!, sourceChunkIds: ['chunk-2'] }],
    }
    const { application, runner } = await fixture(legacyDraft, revisionPlan, base, {
      runOverrides: {
        source: input.source, presentationMode: 'VISUAL_DECK_V4', visualDeckV4: input.config,
      },
      documents: new StaticDocumentPort(input.document),
    })

    const completed = await runner.apply('run-1')
    const replayed = await runner.apply('run-1')

    expect(completed.blueprint?.renderMode).toBe('VISUAL_DECK_V4')
    expect(completed.blueprint?.visualDeckV4Proposal?.compilerVersion)
      .toBe(LEGACY_VISUAL_DECK_V4_COMPILER_VERSION)
    expect(completed).toMatchObject({ status: 'REVISING', replayed: false, blueprint: expect.any(Object) })
    expect(replayed).toMatchObject({ status: 'REVISING', replayed: true })
    expect(replayed.blueprint).toEqual(completed.blueprint)
    expect(application.applications.size).toBe(1)
  })

  test('repairs an invalid chain-2 patch with one deterministic contract key', async () => {
    const base = visualDeckV4Blueprint()
    const input = visualDeckV4Input()
    const brief = base.visualDeckV4Proposal!.slideBriefs[1]!
    const valid = {
      contentPatches: [],
      layoutPatches: [v4LayoutPatch(brief, '修正布局')],
      redrawOnlyPageNumbers: [],
    }
    const revisionPlan = plan('RELAYOUT')
    const { application, runner } = await fixture(valid, revisionPlan, base, {
      runOverrides: {
        source: input.source, presentationMode: 'VISUAL_DECK_V4', visualDeckV4: input.config,
      },
      documents: new StaticDocumentPort(input.document),
    })
    const applyOnce = application.apply.bind(application)
    const keys: string[] = []
    application.apply = async (modelInput) => {
      keys.push(modelInput.idempotencyKey)
      if (keys.length === 1) return { ...valid, layoutPatches: [] }
      return applyOnce(modelInput)
    }

    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'REVISING', blueprint: expect.any(Object) })
    expect(keys).toEqual([
      'run-1:revision-blueprint:r1',
      `revision-contract-repair-${hashInput({ idempotencyKey: 'run-1:revision-blueprint:r1', attempt: 1 })}`,
    ])
    expect([...application.requests.values()][0]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'REVISION_PATCH_SCOPE_INVALID',
    })
  })

  test('keeps the chain-2 revision key across ambiguous provider retries', async () => {
    const base = visualDeckV4Blueprint()
    const input = visualDeckV4Input()
    const valid = {
      contentPatches: [],
      layoutPatches: [v4LayoutPatch(base.visualDeckV4Proposal!.slideBriefs[1]!, '修正布局')],
      redrawOnlyPageNumbers: [],
    }
    const { application, runner } = await fixture(valid, plan('RELAYOUT'), base, {
      runOverrides: {
        source: input.source, presentationMode: 'VISUAL_DECK_V4', visualDeckV4: input.config,
      },
      documents: new StaticDocumentPort(input.document),
    })
    const applyOnce = application.apply.bind(application)
    const keys: string[] = []
    application.apply = async (modelInput) => {
      keys.push(modelInput.idempotencyKey)
      if (keys.length < 3) {
        throw new StructuredModelError('PROVIDER_TIMEOUT', true, 'gpt-5.6', `request-${keys.length}`)
      }
      return applyOnce(modelInput)
    }

    expect(await runner.apply('run-1')).toMatchObject({ status: 'REVISING', blueprint: expect.any(Object) })
    expect(keys).toHaveLength(3)
    expect(new Set(keys)).toEqual(new Set(['run-1:revision-blueprint:r1']))
  })

  test('rejects missing, unplanned, no-op and source-escaping chain-2 patches', async () => {
    const cases = [
      {
        name: 'missing',
        response: () => ({ contentPatches: [], layoutPatches: [], redrawOnlyPageNumbers: [] }),
        diagnosticCode: 'REVISION_PATCH_SCOPE_INVALID',
      },
      {
        name: 'unplanned',
        response: (base: ReturnType<typeof visualDeckV4Blueprint>) => ({
          contentPatches: [],
          layoutPatches: [v4LayoutPatch(base.visualDeckV4Proposal!.slideBriefs[0]!, '越权')],
          redrawOnlyPageNumbers: [2],
        }),
        diagnosticCode: 'REVISION_PATCH_SCOPE_INVALID',
      },
      {
        name: 'no-op',
        response: (base: ReturnType<typeof visualDeckV4Blueprint>) => {
          const brief = base.visualDeckV4Proposal!.slideBriefs[1]!
          return {
            contentPatches: [],
            layoutPatches: [{
              pageNumber: brief.pageNumber,
              visualMetaphor: brief.visualMetaphor,
              composition: brief.composition,
              informationHierarchy: brief.informationHierarchy,
              previousSlideRelation: brief.previousSlideRelation,
              nextSlideRelation: brief.nextSlideRelation,
            }],
            redrawOnlyPageNumbers: [],
          }
        },
        diagnosticCode: 'REVISION_PATCH_NOOP',
      },
    ] as const

    for (const testCase of cases) {
      const base = visualDeckV4Blueprint()
      const input = visualDeckV4Input()
      const { runner } = await fixture(testCase.response(base), plan('RELAYOUT'), base, {
        runOverrides: {
          source: input.source, presentationMode: 'VISUAL_DECK_V4', visualDeckV4: input.config,
          committedBudgetUnits: 0,
        },
        documents: new StaticDocumentPort(input.document),
      })
      const result = await runner.apply('run-1')
      expect(result, testCase.name).toMatchObject({
        status: 'FAILED',
        step: { output: { diagnostic: { diagnosticCode: testCase.diagnosticCode } } },
      })
    }

    const base = visualDeckV4Blueprint()
    const input = visualDeckV4Input()
    const brief = base.visualDeckV4Proposal!.slideBriefs[1]!
    const contentPlan = {
      ...plan('UPDATE_CONTENT'),
      operations: [{ ...plan('UPDATE_CONTENT').operations[0]!, sourceChunkIds: ['chunk-2'] }],
    }
    const escaping = {
      contentPatches: [{
        pageNumber: brief.pageNumber,
        title: brief.title,
        keyClaim: '越权引用来源的内容修改',
        audienceTakeaway: brief.audienceTakeaway,
        lockedCopy: brief.lockedCopy,
        facts: brief.facts,
        numbers: brief.numbers,
        formulas: brief.formulas,
        sourceChunkIds: ['chunk-1'],
        visualMetaphor: brief.visualMetaphor,
        composition: brief.composition,
        informationHierarchy: brief.informationHierarchy,
        previousSlideRelation: brief.previousSlideRelation,
        nextSlideRelation: brief.nextSlideRelation,
      }],
      layoutPatches: [],
      redrawOnlyPageNumbers: [],
    }
    const { runner } = await fixture(escaping, contentPlan, base, {
      runOverrides: {
        source: input.source, presentationMode: 'VISUAL_DECK_V4', visualDeckV4: input.config,
        committedBudgetUnits: 0,
      },
      documents: new StaticDocumentPort(input.document),
    })
    expect(await runner.apply('run-1')).toMatchObject({
      status: 'FAILED',
      step: { output: { diagnostic: { diagnosticCode: 'REVISION_SOURCE_REFERENCE_INVALID' } } },
    })
  })

  test('rejects a chain-2 content patch that only reorders source lineage', async () => {
    const base = visualDeckV4Blueprint()
    const input = visualDeckV4Input()
    const brief = base.visualDeckV4Proposal!.slideBriefs[1]!
    brief.sourceChunkIds = ['chunk-1', 'chunk-2']
    base.slides[1]!.sourceChunkIds = ['chunk-1', 'chunk-2']
    const response = {
      contentPatches: [{
        ...v4ContentPatch(brief),
        sourceChunkIds: ['chunk-2', 'chunk-1'],
      }],
      layoutPatches: [],
      redrawOnlyPageNumbers: [],
    }
    const { runner } = await fixture(response, plan('UPDATE_CONTENT'), base, {
      runOverrides: {
        source: input.source,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: input.config,
        committedBudgetUnits: 0,
      },
      documents: new StaticDocumentPort(input.document),
    })

    expect(await runner.apply('run-1')).toMatchObject({
      status: 'FAILED',
      step: { output: { diagnostic: { diagnosticCode: 'REVISION_PATCH_NOOP' } } },
    })
  })

  test('applies a source-grounded v4 content correction and requires a full-page redraw', async () => {
    const base = visualDeckV4Blueprint()
    const { compilerVersion: _compilerVersion, ...revisedProposal } = structuredClone(base.visualDeckV4Proposal!)
    revisedProposal.slideBriefs[1]!.title = '光合作用会产生什么？'
    revisedProposal.slideBriefs[1]!.keyClaim = '绿色植物制造有机物并释放氧气。'
    revisedProposal.slideBriefs[1]!.audienceTakeaway = '说出光合作用的两种产物。'
    revisedProposal.slideBriefs[1]!.lockedCopy = ['制造有机物', '释放氧气']
    revisedProposal.slideBriefs[1]!.facts = ['绿色植物制造有机物并释放氧气。']
    revisedProposal.slideBriefs[1]!.visualMetaphor = '一片叶子连接有机物与氧气的单一科学场景'
    revisedProposal.slideBriefs[1]!.composition = '叶片位于中央，两种产物从同一叶片清晰引出'
    const input = visualDeckV4Input()
    const revisionPlan = {
      ...plan('UPDATE_CONTENT'),
      operations: [{
        ...plan('UPDATE_CONTENT').operations[0]!,
        instruction: '依据教材明确说明绿色植物制造有机物并释放氧气。',
        sourceChunkIds: ['chunk-2'],
      }],
    }
    const response = {
      contentPatches: [v4ContentPatch(revisedProposal.slideBriefs[1]!)],
      layoutPatches: [],
      redrawOnlyPageNumbers: [],
    }
    const { application, runner } = await fixture(response, revisionPlan, base, {
      runOverrides: {
        source: input.source,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: input.config,
      },
      documents: new StaticDocumentPort(input.document),
    })

    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'REVISING', requiresMedia: true, replayed: false })
    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs[1]).toMatchObject({
      title: '光合作用会产生什么？',
      lockedCopy: ['制造有机物', '释放氧气'],
    })
    expect(application.requests.size).toBe(1)
  })

  test('stops before model execution when a v4 content revision requires an unsupported compiler', async () => {
    const base = visualDeckV4Blueprint()
    base.visualDeckV4Proposal!.compilerVersion = 'visual-deck-v4-chain-0'
    const { compilerVersion: _compilerVersion, ...revisedProposal } = structuredClone(base.visualDeckV4Proposal!)
    const input = visualDeckV4Input()
    const { application, runner } = await fixture(revisedProposal, plan('UPDATE_CONTENT'), base, {
      runOverrides: {
        source: input.source,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: input.config,
        committedBudgetUnits: 0,
      },
      documents: new StaticDocumentPort(input.document),
    })

    expect(await runner.apply('run-1')).toMatchObject({
      status: 'FAILED', blueprint: null,
    })
    expect(application.requests.size).toBe(0)
  })

  test('stops before a v4 redraw-only revision when the compiler is unsupported', async () => {
    const base = visualDeckV4Blueprint()
    base.visualDeckV4Proposal!.compilerVersion = 'visual-deck-v4-chain-0'
    const input = visualDeckV4Input()
    const { application, runner } = await fixture({}, plan('REGENERATE_IMAGE'), base, {
      runOverrides: {
        source: input.source,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: input.config,
        committedBudgetUnits: 0,
      },
      documents: new StaticDocumentPort(input.document),
    })

    expect(await runner.apply('run-1')).toMatchObject({
      status: 'FAILED', blueprint: null, requiresMedia: false,
    })
    expect(application.requests.size).toBe(0)
  })

  test('persists a v4 relayout proposal before redrawing the target page', async () => {
    const base = visualDeckV4Blueprint()
    const { compilerVersion: _compilerVersion, ...revisedProposal } = structuredClone(base.visualDeckV4Proposal!)
    revisedProposal.slideBriefs[1]!.visualMetaphor = '一片叶子作为唯一视觉中心连接光能与产物'
    revisedProposal.slideBriefs[1]!.composition = '叶片居中，关系箭头沿单一路径从左向右展开'
    revisedProposal.slideBriefs[1]!.informationHierarchy = ['中心叶片', '光能来源', '产物关系']
    const input = visualDeckV4Input()
    const response = {
      contentPatches: [],
      layoutPatches: [{
        pageNumber: revisedProposal.slideBriefs[1]!.pageNumber,
        visualMetaphor: revisedProposal.slideBriefs[1]!.visualMetaphor,
        composition: revisedProposal.slideBriefs[1]!.composition,
        informationHierarchy: revisedProposal.slideBriefs[1]!.informationHierarchy,
        previousSlideRelation: revisedProposal.slideBriefs[1]!.previousSlideRelation,
        nextSlideRelation: revisedProposal.slideBriefs[1]!.nextSlideRelation,
      }],
      redrawOnlyPageNumbers: [],
    }
    const { application, runner } = await fixture(response, plan('RELAYOUT'), base, {
      runOverrides: {
        source: input.source,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: input.config,
      },
      documents: new StaticDocumentPort(input.document),
    })

    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'REVISING', requiresMedia: true })
    expect(result.blueprint?.visualDeckV4Proposal?.slideBriefs[1]?.composition)
      .toBe('叶片居中，关系箭头沿单一路径从左向右展开')
    expect(application.requests.size).toBe(1)
  })

  test('rejects a v4 content correction that escapes the plan source scope', async () => {
    const base = visualDeckV4Blueprint()
    const { compilerVersion: _compilerVersion, ...revisedProposal } = structuredClone(base.visualDeckV4Proposal!)
    revisedProposal.slideBriefs[1]!.sourceChunkIds = ['chunk-1']
    const input = visualDeckV4Input()
    const revisionPlan = {
      ...plan('UPDATE_CONTENT'),
      operations: [{ ...plan('UPDATE_CONTENT').operations[0]!, sourceChunkIds: ['chunk-2'] }],
    }
    const response = {
      contentPatches: [v4ContentPatch(revisedProposal.slideBriefs[1]!)],
      layoutPatches: [],
      redrawOnlyPageNumbers: [],
    }
    const { repository, application, runner } = await fixture(response, revisionPlan, base, {
      runOverrides: {
        source: input.source,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: input.config,
        committedBudgetUnits: 0,
      },
      documents: new StaticDocumentPort(input.document),
    })

    expect(await runner.apply('run-1')).toMatchObject({
      status: 'FAILED', blueprint: null,
    })
    expect(application.requests.size).toBe(2)
    expect((await repository.listEvents('run-1')).some((event) => event.type === 'approval.required')).toBe(false)
    expect([...application.requests.values()][1]?.contractRepairIssues).toContainEqual({
      path: '$', message: 'REVISION_SOURCE_REFERENCE_INVALID',
    })
  })

  test('preserves existing v4 source lineage while requiring the correction source', async () => {
    const base = visualDeckV4Blueprint()
    base.visualDeckV4Proposal!.slideBriefs[1]!.sourceChunkIds = ['chunk-1', 'chunk-2']
    base.slides[1]!.sourceChunkIds = ['chunk-1', 'chunk-2']
    const { compilerVersion: _compilerVersion, ...revisedProposal } = structuredClone(base.visualDeckV4Proposal!)
    revisedProposal.slideBriefs[1]!.facts = ['绿色植物制造有机物并释放氧气。']
    const input = visualDeckV4Input()
    const revisionPlan = {
      ...plan('UPDATE_CONTENT'),
      operations: [{ ...plan('UPDATE_CONTENT').operations[0]!, sourceChunkIds: ['chunk-2'] }],
    }
    const response = {
      contentPatches: [v4ContentPatch(revisedProposal.slideBriefs[1]!)],
      layoutPatches: [],
      redrawOnlyPageNumbers: [],
    }
    const { runner } = await fixture(response, revisionPlan, base, {
      runOverrides: {
        source: input.source,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: input.config,
      },
      documents: new StaticDocumentPort(input.document),
    })

    expect(await runner.apply('run-1')).toMatchObject({
      status: 'REVISING',
      blueprint: { visualDeckV4Proposal: { slideBriefs: [expect.any(Object), {
        sourceChunkIds: ['chunk-1', 'chunk-2'],
      }] } },
    })
  })

  test('rejects a v4 content correction that drops existing source lineage', async () => {
    const base = visualDeckV4Blueprint()
    base.visualDeckV4Proposal!.slideBriefs[1]!.sourceChunkIds = ['chunk-1', 'chunk-2']
    base.slides[1]!.sourceChunkIds = ['chunk-1', 'chunk-2']
    const { compilerVersion: _compilerVersion, ...revisedProposal } = structuredClone(base.visualDeckV4Proposal!)
    revisedProposal.slideBriefs[1]!.sourceChunkIds = ['chunk-2']
    revisedProposal.slideBriefs[1]!.facts = ['绿色植物制造有机物并释放氧气。']
    const input = visualDeckV4Input()
    const revisionPlan = {
      ...plan('UPDATE_CONTENT'),
      operations: [{ ...plan('UPDATE_CONTENT').operations[0]!, sourceChunkIds: ['chunk-2'] }],
    }
    const response = {
      contentPatches: [v4ContentPatch(revisedProposal.slideBriefs[1]!)],
      layoutPatches: [],
      redrawOnlyPageNumbers: [],
    }
    const { application, runner } = await fixture(response, revisionPlan, base, {
      runOverrides: {
        source: input.source,
        presentationMode: 'VISUAL_DECK_V4',
        visualDeckV4: input.config,
        committedBudgetUnits: 0,
      },
      documents: new StaticDocumentPort(input.document),
    })

    expect(await runner.apply('run-1')).toMatchObject({
      status: 'FAILED', blueprint: null, step: { errorCode: 'REVISION_APPLICATION_FAILED' },
    })
    expect(application.requests.size).toBe(2)
  })

  test('rejects v3 content lineage that escapes the approved operation source scope', async () => {
    for (const scope of ['slide', 'text-element'] as const) {
      const revised = layeredDraft()
      revised.slides[1]!.body = ['修订后的光合作用产物说明']
      if (scope === 'slide') {
        revised.slides[1]!.sourceChunkIds = ['chunk-1']
      } else {
        const text = revised.slides[1]!.layeredDesign.elements[2]!
        if (text.kind !== 'TEXT') throw new Error('TEST_TEXT_ELEMENT_MISSING')
        text.text = '修订后的光合作用产物说明'
        text.sourceChunkIds = ['chunk-1']
      }
      const { runner } = await fixture(revised, plan('UPDATE_CONTENT'), layeredBlueprint())

      expect(await runner.apply('run-1')).toMatchObject({
        status: 'NEEDS_HUMAN', blueprint: null, step: { errorCode: 'REVISION_APPLICATION_FAILED' },
      })
    }
  })

  test('does not add revision sources to an unchanged v3 text element', async () => {
    const base = layeredBlueprint()
    const title = base.slides[1]!.layeredDesign.elements[2]!
    if (title.kind !== 'TEXT') throw new Error('TEST_TEXT_ELEMENT_MISSING')
    title.sourceChunkIds = ['chunk-1']
    const {
      id: _id,
      visualDirection: _visualDirection,
      createdAt: _createdAt,
      renderMode: _renderMode,
      coverDesignMode: _coverDesignMode,
      ...revised
    } = structuredClone(base)
    revised.slides[1]!.body = ['在光照条件下制造有机物并释放氧气']
    const { runner } = await fixture(revised, plan('UPDATE_CONTENT'), base)

    expect(await runner.apply('run-1')).toMatchObject({ status: 'DECK_REVIEW', requiresMedia: false })
  })

  test('rejects changes to a non-targeted element during v3 single-asset regeneration', async () => {
    const revised = layeredDraft()
    const target = revised.slides[1]!.layeredDesign.elements[1]!
    const base = revised.slides[1]!.layeredDesign.elements[0]!
    if (target.kind === 'IMAGE') target.prompt = 'A corrected transparent leaf explaining photosynthesis, no text'
    if (base.kind === 'IMAGE') base.prompt = 'An unauthorized replacement classroom background'
    const revisionPlan = {
      ...plan('REGENERATE_IMAGE'),
      operations: [{ ...plan('REGENERATE_IMAGE').operations[0]!, targetElementId: 'knowledge-2' }],
    }
    const { runner } = await fixture(revised, revisionPlan, layeredBlueprint())

    expect(await runner.apply('run-1')).toMatchObject({
      status: 'NEEDS_HUMAN', blueprint: null, step: { errorCode: 'REVISION_APPLICATION_FAILED' },
    })
  })

  test('accepts changing only the targeted v3 image prompt', async () => {
    const revised = layeredDraft()
    const target = revised.slides[1]!.layeredDesign.elements[1]!
    if (target.kind === 'IMAGE') target.prompt = 'A corrected transparent leaf explaining photosynthesis, no text'
    const revisionPlan = {
      ...plan('REGENERATE_IMAGE'),
      operations: [{ ...plan('REGENERATE_IMAGE').operations[0]!, targetElementId: 'knowledge-2' }],
    }
    const { runner } = await fixture(revised, revisionPlan, layeredBlueprint())

    expect(await runner.apply('run-1')).toMatchObject({ status: 'REVISING', requiresMedia: true })
  })

  test('replays a completed application without another model execution', async () => {
    const revised = draft()
    revised.slides[1]!.body = ['在光照条件下制造有机物并释放氧气']
    const { application, runner } = await fixture(revised)
    const first = await runner.apply('run-1')
    const replay = await runner.apply('run-1')

    expect(replay).toMatchObject({ status: 'DECK_REVIEW', replayed: true })
    expect(replay.blueprint).toEqual(first.blueprint)
    expect(application.applications.size).toBe(1)
  })

  test('does not duplicate an in-flight revision application', async () => {
    const revised = draft()
    revised.slides[1]!.body = ['在光照条件下制造有机物并释放氧气']
    const { application, runner } = await fixture(revised)
    const applyOnce = application.apply.bind(application)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    application.apply = async (input) => {
      started()
      await gate
      return applyOnce(input)
    }

    const first = runner.apply('run-1')
    await entered
    const second = runner.apply('run-1')
    release()
    const [completed, concurrent] = await Promise.all([first, second])

    expect(concurrent).toEqual(completed)
    expect(completed).toMatchObject({ status: 'DECK_REVIEW', blueprint: expect.any(Object) })
    expect(application.applications.size).toBe(1)
  })

  test('converges successful application across independent runner instances', async () => {
    const revised = draft()
    revised.slides[1]!.body = ['在光照条件下制造有机物并释放氧气']
    const { repository, runner } = await fixture(revised)
    const delayedApplication = new MockRevisionApplicationPort(revised)
    const applyOnce = delayedApplication.apply.bind(delayedApplication)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    delayedApplication.apply = async (input) => {
      started()
      await gate
      return applyOnce(input)
    }
    const competingRunner = new RevisionApplicationRunner({
      repository,
      documents: new StaticDocumentPort(),
      application: delayedApplication,
      clock: new FixedClock(),
      sleep: async () => {},
    })

    const lateCompletion = competingRunner.apply('run-1')
    await entered
    const completed = await runner.apply('run-1')
    release()
    const converged = await lateCompletion

    expect(completed).toMatchObject({ status: 'DECK_REVIEW', replayed: false })
    expect(converged).toMatchObject({ status: 'DECK_REVIEW', replayed: true })
    const events = await repository.listEvents('run-1')
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'phase.changed')).toHaveLength(1)
  })

  test('resumes a persisted running application after process restart', async () => {
    const revised = draft()
    revised.slides[1]!.body = ['在光照条件下制造有机物并释放氧气']
    const { repository, application, runner } = await fixture(revised)
    const persistedBase = await getActiveBlueprint(repository, 'run-1', 0)
    const persistedPlan = revisionPlanSchema.parse(plan())
    const sourceChunks = [
      { id: 'chunk-1', sha256: 'sha-1' },
      { id: 'chunk-2', sha256: 'sha-2' },
    ]
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-run-1-apply-revision-r1',
        runId: 'run-1',
        idempotencyKey: 'run-1:revision-blueprint:r1',
        inputHash: hashInput({ tool: 'apply_revision', base: persistedBase, plan: persistedPlan, sourceChunks }),
        tool: 'apply_revision',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })

    const result = await runner.apply('run-1')

    expect(result).toMatchObject({ status: 'DECK_REVIEW', replayed: false, blueprint: expect.any(Object) })
    expect(application.applications.size).toBe(1)
    expect((await repository.listSteps('run-1')).find((step) => step.tool === 'apply_revision'))
      .toMatchObject({ status: 'COMPLETED' })
  })

  test('resumes a persisted chain-2 patch application with the original model key', async () => {
    const base = visualDeckV4Blueprint()
    const input = visualDeckV4Input()
    const revisionPlan = revisionPlanSchema.parse(plan('RELAYOUT'))
    const response = {
      contentPatches: [],
      layoutPatches: [v4LayoutPatch(base.visualDeckV4Proposal!.slideBriefs[1]!, '恢复布局修订')],
      redrawOnlyPageNumbers: [],
    }
    const { repository, application, runner } = await fixture(response, revisionPlan, base, {
      runOverrides: {
        source: input.source, presentationMode: 'VISUAL_DECK_V4', visualDeckV4: input.config,
      },
      documents: new StaticDocumentPort(input.document),
    })
    const sourceChunks = input.document.chunks.map(({ id, sha256 }) => ({ id, sha256 }))
    await repository.transact('run-1', (transaction) => {
      transaction.putStep({
        id: 'step-run-1-apply-revision-r1',
        runId: 'run-1',
        idempotencyKey: 'run-1:revision-blueprint:r1',
        inputHash: hashInput({ tool: 'apply_revision', base, plan: revisionPlan, sourceChunks }),
        tool: 'apply_revision',
        status: 'RUNNING',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: null,
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
    })

    expect(await runner.apply('run-1')).toMatchObject({
      status: 'REVISING', replayed: false, blueprint: expect.any(Object),
    })
    expect([...application.requests.values()]).toHaveLength(1)
    expect([...application.requests.values()][0]?.idempotencyKey).toBe('run-1:revision-blueprint:r1')
  })
})

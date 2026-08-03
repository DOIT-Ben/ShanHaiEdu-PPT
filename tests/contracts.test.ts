import { describe, expect, test } from 'bun:test'
import {
  CONTRACT_VERSION,
  agentEventSchema,
  apiErrorSchema,
  createRunRequestSchema,
  deliveryUnavailableErrorSchema,
  runActionSchema,
  runSnapshotSchema,
} from '../src/contracts'

const host = { tenantId: 'frameflow', externalUserId: 'user-1', externalProjectId: 'deck-1' }

const approvedPageDesignSource = {
  kind: 'APPROVED_PAGE_DESIGN' as const,
  schemaVersion: '1' as const,
  artifactVersionId: 'page-design-version-1',
  artifactContentHash: 'a'.repeat(64),
  title: '光合作用公开课',
  subject: '生物',
  gradeBand: '七年级',
  lessonDurationMinutes: 45,
  audience: '七年级学生',
  objectives: ['理解光合作用的条件与产物'],
  pages: [1, 2].map((pageNumber) => ({
    pageNumber,
    title: pageNumber === 1 ? '光从哪里来' : '植物制造了什么',
    teachingPurpose: '建立光合作用的基本心智模型',
    editableCopy: ['观察叶片与光照', '归纳条件和产物'],
    layoutIntent: '左侧保留标题和要点，右侧呈现完整的叶片实验场景',
    visualRequirements: ['真实叶片、阳光和课堂实验器材'],
    teacherNotes: '引导学生先观察再归纳',
    teacherScript: '请观察叶片在光照条件下发生的变化，并说出你的判断。',
    studentActivity: '小组观察并汇报条件和产物',
    animationSequence: ['先出现叶片', '再出现光照关系'],
    boardPlan: '板书光合作用的条件和产物',
    evidence: [{ type: 'FACT' as const, text: '绿色植物通过光合作用制造有机物并释放氧气', source: '七年级生物教材' }],
  })),
}

describe('public v1 contracts', () => {
  test('accepts a host-independent run request', () => {
    const result = createRunRequestSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      host,
      source: { kind: 'HOST_ATTACHMENT', attachmentId: 'attachment-1' },
      slideCount: 15,
      visualDirection: '清晰、克制的课堂信息图风格',
      imageModel: 'image-2',
      automationLevel: 'SUPERVISED',
      budgetUnits: 200,
    })

    expect(result.maxRevisionRounds).toBe(2)
    expect(result.presentationMode).toBe('SLIDE_IMAGE_V2')
    expect(result.coverDesignMode).toBe('INDEPENDENT')
    expect(result.assetAcquisitionPolicy).toBe('AI_FIRST')
    expect(result.maxVisualAssetsPerSlide).toBe(4)
    expect(result.host.tenantId).toBe('frameflow')
    expect(createRunRequestSchema.parse({ ...result, maxRevisionRounds: 4 }).maxRevisionRounds).toBe(4)
    expect(createRunRequestSchema.safeParse({ ...result, maxRevisionRounds: 5 }).success).toBe(false)
  })

  test('accepts the layered courseware mode with an explicit template exception', () => {
    const result = createRunRequestSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      host,
      source: { kind: 'TEXT', text: '这是一段足够长的低年级数学教材正文，用于创建分层课件。' },
      slideCount: 8,
      visualDirection: '明亮清晰的儿童纸黏土课堂插画',
      imageModel: 'image-2',
      automationLevel: 'SUPERVISED',
      budgetUnits: 200,
      presentationMode: 'LAYERED_COURSEWARE_V3',
      coverDesignMode: 'FOLLOW_TEMPLATE',
      assetAcquisitionPolicy: 'SEARCH_FIRST',
      maxVisualAssetsPerSlide: 3,
    })

    expect(result).toMatchObject({
      presentationMode: 'LAYERED_COURSEWARE_V3',
      coverDesignMode: 'FOLLOW_TEMPLATE',
      assetAcquisitionPolicy: 'SEARCH_FIRST',
      maxVisualAssetsPerSlide: 3,
    })
  })

  test('accepts the reflected slide-image mode with explicit audience and goal', () => {
    const result = createRunRequestSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      host,
      source: { kind: 'TEXT', text: '这是一段足够长的产品发布材料，用于生成面向管理层的演示文稿。' },
      slideCount: 6,
      visualDirection: '克制的编辑设计，清晰的信息层级和强视觉焦点',
      targetAudience: '需要快速判断是否投资的公司管理层',
      presentationGoal: '在十分钟内说明市场机会、产品差异和下一步决策',
      imageModel: 'nanobanana',
      automationLevel: 'SUPERVISED',
      budgetUnits: 12,
      presentationMode: 'SLIDE_IMAGE_V2_1',
    })

    expect(result).toMatchObject({
      presentationMode: 'SLIDE_IMAGE_V2_1',
      targetAudience: '需要快速判断是否投资的公司管理层',
      presentationGoal: '在十分钟内说明市场机会、产品差异和下一步决策',
    })
  })

  test('accepts v4 only with a matching visual deck configuration', () => {
    const base = {
      schemaVersion: CONTRACT_VERSION,
      host,
      source: {
        kind: 'SOURCE_PACKAGE' as const,
        sources: [
          {
            kind: 'TEXT' as const,
            sourceId: 'lesson-brief',
            text: '这是一份用于生成资料驱动视觉演示的完整课程说明和内容范围。',
            roleHint: 'CONTENT_SOURCE' as const,
          },
        ],
      },
      slideCount: 12,
      visualDirection: '由智能体根据资料和用户要求编译视觉方向',
      imageModel: 'nanobanana',
      automationLevel: 'SUPERVISED' as const,
      budgetUnits: 12,
      presentationMode: 'VISUAL_DECK_V4' as const,
      visualDeckV4: {
        instruction: '为六年级学生制作一套百分数视觉演示',
        deckOptions: {
          deckType: 'PRESENTER_SLIDES' as const,
          language: 'zh-CN',
          length: { slideCount: 12 },
          aspectRatio: '16:9' as const,
        },
      },
    }

    expect(createRunRequestSchema.parse(base)).toMatchObject({
      presentationMode: 'VISUAL_DECK_V4',
      visualDeckV4: {
        sourceMode: 'AUTO',
        deckOptions: { deckType: 'PRESENTER_SLIDES', language: 'zh-CN', aspectRatio: '16:9' },
      },
    })
    expect(() => createRunRequestSchema.parse({ ...base, visualDeckV4: undefined })).toThrow()
    expect(() => createRunRequestSchema.parse({
      ...base,
      visualDeckV4: { ...base.visualDeckV4, deckOptions: { ...base.visualDeckV4.deckOptions, length: { slideCount: 10 } } },
    })).toThrow()
    expect(() => createRunRequestSchema.parse({ ...base, presentationMode: 'SLIDE_IMAGE_V2' })).toThrow()
  })

  test('accepts an ordered mixed source package and rejects duplicate attachments', () => {
    const base = {
      schemaVersion: CONTRACT_VERSION,
      host,
      source: {
        kind: 'SOURCE_PACKAGE' as const,
        name: '混合教材包',
        sources: [
          { kind: 'TEXT' as const, sourceId: 'outline', name: '课程要求.md', text: '这是根据教师要求整理的完整课程范围和教学目标。' },
          { kind: 'HOST_ATTACHMENT' as const, sourceId: 'image-1', attachmentId: 'attachment-image-1' },
          { kind: 'HOST_ATTACHMENT' as const, sourceId: 'pdf-1', attachmentId: 'attachment-pdf-1' },
        ],
      },
      slideCount: 8,
      visualDirection: '明亮清晰的儿童课堂视觉',
      imageModel: 'image-2',
      automationLevel: 'SUPERVISED' as const,
      budgetUnits: 200,
    }
    expect(createRunRequestSchema.parse(base).source).toMatchObject({ kind: 'SOURCE_PACKAGE' })
    expect(() => createRunRequestSchema.parse({
      ...base,
      source: {
        ...base.source,
        sources: [
          { kind: 'HOST_ATTACHMENT', sourceId: 'image-1', attachmentId: 'attachment-image-1' },
          { kind: 'HOST_ATTACHMENT', sourceId: 'image-2', attachmentId: 'attachment-image-1' },
        ],
      },
    })).toThrow('attachment ids must be unique')
  })

  test('accepts a versioned approved page design and rejects broken page order', () => {
    const base = {
      schemaVersion: CONTRACT_VERSION,
      host,
      source: approvedPageDesignSource,
      slideCount: 2,
      visualDirection: '清晰克制的课堂编辑视觉',
      imageModel: 'nanobanana',
      automationLevel: 'SUPERVISED' as const,
      budgetUnits: 2,
      presentationMode: 'SLIDE_IMAGE_V2' as const,
    }

    expect(createRunRequestSchema.parse(base).source).toEqual(approvedPageDesignSource)
    expect(() => createRunRequestSchema.parse({
      ...base,
      source: {
        ...approvedPageDesignSource,
        pages: approvedPageDesignSource.pages.map((page, index) => ({
          ...page,
          pageNumber: index === 1 ? 3 : page.pageNumber,
        })),
      },
    })).toThrow('page numbers must be continuous')
    expect(() => createRunRequestSchema.parse({
      ...base,
      source: {
        ...approvedPageDesignSource,
        pages: approvedPageDesignSource.pages.map((page, index) => ({
          ...page,
          editableCopy: index === 0 ? Array.from({ length: 9 }, (_, item) => `正文 ${item + 1}`) : page.editableCopy,
        })),
      },
    })).toThrow()
    expect(() => createRunRequestSchema.parse({
      ...base,
      source: {
        ...approvedPageDesignSource,
        pages: approvedPageDesignSource.pages.map((page, index) => ({
          ...page,
          editableCopy: index === 0 ? ['字'.repeat(301)] : page.editableCopy,
        })),
      },
    })).toThrow()
  })

  test('rejects unknown fields and unsupported contract versions', () => {
    expect(() => createRunRequestSchema.parse({
      schemaVersion: '2',
      host,
      source: { kind: 'TEXT', text: '足够长的教材正文，用于验证公共合同不会接受未知版本。' },
      slideCount: 6,
      visualDirection: '课堂插画',
      imageModel: 'image-2',
      automationLevel: 'SUPERVISED',
      budgetUnits: 100,
      frameflowUserId: 'internal-id',
    })).toThrow()
  })

  test('requires an audited reason for quality override', () => {
    expect(() => runActionSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      type: 'ACCEPT_WITH_OVERRIDE',
      expectedVersion: 7,
      reason: '太短',
      issueIds: ['issue-1'],
    })).toThrow()
  })

  test('requires explicit unique issue ids for quality override', () => {
    const action = {
      schemaVersion: CONTRACT_VERSION,
      type: 'ACCEPT_WITH_OVERRIDE',
      expectedVersion: 7,
      reason: '教师已经逐项复核并接受这些低风险视觉问题。',
    } as const
    expect(() => runActionSchema.parse(action)).toThrow()
    expect(() => runActionSchema.parse({ ...action, issueIds: ['issue-1', 'issue-1'] })).toThrow()
    expect(runActionSchema.parse({ ...action, issueIds: ['issue-1'] })).toMatchObject({ issueIds: ['issue-1'] })
  })

  test('accepts explicit planning recovery actions', () => {
    expect(runActionSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_PLANNING',
      expectedVersion: 2,
    }).type).toBe('RETRY_PLANNING')
    expect(runActionSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      type: 'REPLAN',
      expectedVersion: 2,
      slideCount: 8,
      visualDirection: '明亮、清晰、适合低年级课堂的视觉方向',
    })).toMatchObject({ type: 'REPLAN', slideCount: 8 })
  })

  test('accepts an explicit delivery recovery action', () => {
    expect(runActionSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: 8,
    }).type).toBe('RETRY_DELIVERY')
  })

  test('makes cancellation semantics explicit without breaking legacy callers', () => {
    expect(runActionSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      type: 'CANCEL',
      expectedVersion: 2,
      mode: 'STOP_NEW_SUBMISSIONS',
      reason: '用户停止继续提交任务',
    })).toMatchObject({ type: 'CANCEL', mode: 'STOP_NEW_SUBMISSIONS' })
  })

  test('requires a concrete element only for limited asset revision', () => {
    const base = {
      schemaVersion: CONTRACT_VERSION,
      type: 'SUBMIT_LIMITED_REVISION',
      expectedVersion: 7,
      slideId: 'run-1:slide:2',
      instruction: '只重新生成第二页目标知识素材，其他元素保持不变。',
    } as const
    expect(() => runActionSchema.parse({ ...base, repairDomain: 'ASSET' })).toThrow()
    expect(runActionSchema.parse({ ...base, repairDomain: 'ASSET', targetElementId: 'knowledge-2-1' }))
      .toMatchObject({ targetElementId: 'knowledge-2-1' })
    expect(() => runActionSchema.parse({ ...base, repairDomain: 'LAYOUT', targetElementId: 'knowledge-2-1' })).toThrow()
  })

  test('requires resumeState exactly while paused and enforces public quality state invariants', () => {
    const base = {
      schemaVersion: CONTRACT_VERSION,
      id: 'run-1',
      host,
      visualDirection: '清晰、克制的课堂信息图风格',
      targetAudience: null,
      presentationGoal: null,
      imageModel: 'image-2',
      automationLevel: 'SUPERVISED' as const,
      version: 3,
      slideCount: 15,
      revisionRound: 0,
      maxRevisionRounds: 2,
      planningAttempt: 0,
      maxPlanningRetries: 2,
      budgetUnits: 200,
      committedBudgetUnits: 0,
      qualityScore: null,
      qualityOverride: false,
      issues: [],
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    }

    expect(() => runSnapshotSchema.parse({ ...base, status: 'PAUSED', resumeState: null })).toThrow()
    expect(() => runSnapshotSchema.parse({ ...base, status: 'EXECUTING', resumeState: 'PAGE_REVIEW' })).toThrow()
    expect(() => runSnapshotSchema.parse({ ...base, status: 'EXECUTING', resumeState: null, revisionRound: 3 })).toThrow()
    const paused = runSnapshotSchema.parse({ ...base, status: 'PAUSED', resumeState: 'DECK_REVIEW' })
    expect(paused.resumeState).toBe('DECK_REVIEW')
    expect(paused).toMatchObject({
      qualityDisposition: 'PENDING', qualityPolicyAudit: null, qualityOverrideAudit: null,
    })

    const policyAudit = {
      provenance: 'SYSTEM_POLICY' as const,
      policyId: 'v4-non-blocking-quality-v1',
      reason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
      issueIds: ['issue-visual-1'],
      acceptedAt: '2026-07-21T00:00:00.000Z',
    }
    expect(runSnapshotSchema.safeParse({
      ...base,
      status: 'DELIVERING',
      resumeState: null,
      presentationMode: 'VISUAL_DECK_V4',
      qualityDisposition: 'SYSTEM_POLICY_ACCEPTED',
      qualityOverride: false,
      qualityPolicyAudit: policyAudit,
    }).success).toBe(false)
    expect(runSnapshotSchema.safeParse({
      ...base,
      status: 'DELIVERING',
      resumeState: null,
      presentationMode: 'VISUAL_DECK_V4',
      qualityDisposition: 'SYSTEM_POLICY_ACCEPTED',
      qualityOverride: true,
      qualityPolicyAudit: policyAudit,
      qualityOverrideAudit: {
        actorId: 'admin-1', actorRole: 'ADMIN', reason: '管理员已逐项复核并接受当前问题。',
        issueIds: ['issue-visual-1'], acceptedAt: '2026-07-21T00:00:00.000Z',
      },
    }).success).toBe(false)
    expect(runSnapshotSchema.safeParse({
      ...base,
      status: 'DELIVERING',
      resumeState: null,
      qualityDisposition: 'ADMIN_OVERRIDE',
      qualityOverride: true,
      qualityOverrideAudit: null,
    }).success).toBe(false)
    expect(runSnapshotSchema.parse({
      ...base,
      status: 'DELIVERING',
      resumeState: null,
      presentationMode: 'VISUAL_DECK_V4',
      qualityDisposition: 'SYSTEM_POLICY_ACCEPTED',
      qualityOverride: true,
      qualityPolicyAudit: policyAudit,
    })).toMatchObject({ qualityDisposition: 'SYSTEM_POLICY_ACCEPTED', qualityPolicyAudit: policyAudit })
    expect(runSnapshotSchema.parse({
      ...base,
      status: 'DELIVERING',
      resumeState: null,
      qualityDisposition: 'REVIEW_PASSED',
    })).toMatchObject({ qualityOverride: false, qualityDisposition: 'REVIEW_PASSED' })
    expect(runSnapshotSchema.parse({
      ...base,
      status: 'FAILED',
      resumeState: null,
      qualityDisposition: 'HARD_FAILURE',
    })).toMatchObject({ status: 'FAILED', qualityDisposition: 'HARD_FAILURE' })

    const failedWithoutHardFailure = runSnapshotSchema.safeParse({
      ...base, status: 'FAILED', resumeState: null,
    })
    expect(failedWithoutHardFailure.success).toBe(false)
    if (!failedWithoutHardFailure.success) {
      expect(failedWithoutHardFailure.error.issues.map((issue) => issue.message))
        .toContain('failed status requires hard failure disposition')
    }

    const pendingOverride = runSnapshotSchema.safeParse({
      ...base, status: 'EXECUTING', resumeState: null, qualityOverride: true,
    })
    expect(pendingOverride.success).toBe(false)
    if (!pendingOverride.success) {
      expect(pendingOverride.error.issues.map((issue) => issue.message))
        .toContain('pending or review-passed disposition cannot carry quality override provenance')
    }
    expect(runSnapshotSchema.safeParse({
      ...base,
      status: 'COMPLETED',
      resumeState: null,
      qualityDisposition: 'REVIEW_PASSED',
      qualityOverride: true,
    }).success).toBe(false)
    expect(runSnapshotSchema.safeParse({
      ...base, status: 'EXECUTING', resumeState: null, qualityDisposition: 'HARD_FAILURE',
    }).success).toBe(false)
  })

  test('validates event payload by event type', () => {
    const event = {
      schemaVersion: CONTRACT_VERSION,
      id: 'event-1',
      eventId: 'event-1',
      runId: 'run-1',
      sequence: 1,
      createdAt: '2026-07-21T00:00:00.000Z',
      type: 'budget.updated',
      payload: { budgetUnits: 200, committedBudgetUnits: 30 },
    }

    expect(agentEventSchema.parse(event).type).toBe('budget.updated')
    expect(() => agentEventSchema.parse({ ...event, payload: { progress: 50 } })).toThrow()
    expect(agentEventSchema.parse({ ...event, type: 'future.event', payload: { value: 1 } }).type)
      .toBe('future.event')
    expect(() => agentEventSchema.parse({ ...event, type: 'budget.updated', payload: { value: 1 } })).toThrow()
  })

  test('versions the stable machine-readable API error envelope', () => {
    const error = {
      schemaVersion: CONTRACT_VERSION,
      error: {
        code: 'DELIVERY_NOT_AVAILABLE',
        message: 'delivery is not available',
        requestId: 'request-1',
        details: { reason: 'RUN_NOT_COMPLETED' },
      },
    } as const
    expect(apiErrorSchema.parse(error)).toMatchObject({
      schemaVersion: CONTRACT_VERSION, error: { code: 'DELIVERY_NOT_AVAILABLE' },
    })
    expect(deliveryUnavailableErrorSchema.parse(error)).toEqual(error)
    expect(deliveryUnavailableErrorSchema.safeParse({
      ...error,
      error: { ...error.error, details: { reason: 'INTERNAL_PATH_LEAKED' } },
    }).success).toBe(false)
  })

  test('validates stable visual deck v4 lifecycle fields', () => {
    const event = {
      schemaVersion: CONTRACT_VERSION,
      id: 'run-v4:event:4',
      eventId: 'run-v4:event:4',
      runId: 'run-v4',
      sequence: 4,
      createdAt: '2026-07-30T00:00:00.000Z',
      type: 'revision.started',
      payload: {
        presentationMode: 'VISUAL_DECK_V4',
        stage: 'REVISION',
        completed: 0,
        total: 3,
        pageNumbers: [2, 5, 6],
        revisionKind: 'PAGE_VISUAL',
        revisionRound: 1,
        maxRevisionRounds: 2,
        budgetUnits: 12,
        committedBudgetUnits: 6,
        reason: 'PAGE_REVIEW_REJECTED',
        retryable: true,
        requiresUserAction: false,
        nextAction: null,
      },
    } as const

    expect(agentEventSchema.parse(event)).toEqual(event)
    expect(() => agentEventSchema.parse({
      ...event,
      payload: { ...event.payload, completed: 4 },
    })).toThrow()
    expect(() => agentEventSchema.parse({
      ...event,
      payload: { ...event.payload, requiresUserAction: true, nextAction: null },
    })).toThrow()
  })
})

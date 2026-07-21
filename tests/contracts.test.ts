import { describe, expect, test } from 'bun:test'
import {
  CONTRACT_VERSION,
  agentEventSchema,
  createRunRequestSchema,
  runActionSchema,
  runSnapshotSchema,
} from '../src/contracts'

const host = { tenantId: 'frameflow', externalUserId: 'user-1', externalProjectId: 'deck-1' }

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
    expect(result.maxVisualAssetsPerSlide).toBe(4)
    expect(result.host.tenantId).toBe('frameflow')
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
      maxVisualAssetsPerSlide: 3,
    })

    expect(result).toMatchObject({
      presentationMode: 'LAYERED_COURSEWARE_V3',
      coverDesignMode: 'FOLLOW_TEMPLATE',
      maxVisualAssetsPerSlide: 3,
    })
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

  test('requires resumeState exactly while paused', () => {
    const base = {
      schemaVersion: CONTRACT_VERSION,
      runId: 'run-1',
      host,
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
    expect(runSnapshotSchema.parse({ ...base, status: 'PAUSED', resumeState: 'DECK_REVIEW' }).resumeState).toBe('DECK_REVIEW')
  })

  test('validates event payload by event type', () => {
    const event = {
      schemaVersion: CONTRACT_VERSION,
      id: 'event-1',
      runId: 'run-1',
      sequence: 1,
      createdAt: '2026-07-21T00:00:00.000Z',
      type: 'budget.updated',
      payload: { budgetUnits: 200, committedBudgetUnits: 30 },
    }

    expect(agentEventSchema.parse(event).type).toBe('budget.updated')
    expect(() => agentEventSchema.parse({ ...event, payload: { progress: 50 } })).toThrow()
    expect(() => agentEventSchema.parse({ ...event, type: 'internal.debug' })).toThrow()
  })
})

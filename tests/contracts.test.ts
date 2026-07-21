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
    expect(result.host.tenantId).toBe('frameflow')
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
    })).toThrow()
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

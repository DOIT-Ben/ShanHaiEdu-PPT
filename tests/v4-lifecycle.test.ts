import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { agentEventSchema, CONTRACT_VERSION } from '../src/contracts'
import type { RunRecord } from '../src/core/ports'
import {
  appendFixedIssueResolutions,
  appendV4LifecycleEvent,
  failVisualDeckV4Run,
} from '../src/core/v4-lifecycle'

function run(status: RunRecord['status'] = 'PLANNING'): RunRecord {
  return {
    id: 'run-v4', creationKey: 'create-v4', requestHash: 'hash-v4',
    host: { tenantId: 'frameflow', externalUserId: 'user-v4' },
    source: { kind: 'TEXT', text: '这是用于验证 V4 生命周期事件的完整教材内容。'.repeat(3) },
    slideCount: 3, visualDirection: '清晰课堂视觉', imageModel: 'image-2',
    automationLevel: 'SUPERVISED', presentationMode: 'VISUAL_DECK_V4',
    maxRevisionRounds: 2, revisionRound: 0, qualityScore: null,
    status, resumeState: null, version: 0, budgetUnits: 10, committedBudgetUnits: 0,
    qualityOverride: false, qualityOverrideReason: null, qualityOverrideBy: null,
    leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z',
  }
}

describe('visual deck v4 lifecycle', () => {
  test('resolves repaired issues once while preserving issues still reported by the new review', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())

    await repository.transact('run-v4', (transaction) => {
      for (const issueId of ['issue-fixed', 'issue-still-open']) {
        transaction.appendEvent({
          schemaVersion: CONTRACT_VERSION,
          type: 'issue.detected',
          payload: {
            id: issueId, category: 'IMAGE_QUALITY', severity: 'WARNING', summary: '页面需要修订。',
            slideIds: ['run-v4:slide:2'], sourceChunkIds: [], status: 'OPEN',
          },
        })
      }
      appendFixedIssueResolutions(transaction, ['issue-fixed', 'issue-still-open'], ['issue-still-open'])
      appendFixedIssueResolutions(transaction, ['issue-fixed'])
    })

    const resolved = (await repository.listEvents('run-v4')).filter((event) => event.type === 'issue.resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ payload: { issueId: 'issue-fixed', resolution: 'FIXED' } })
  })

  test('deduplicates one active stage but preserves a later retry attempt', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run())

    await repository.transact('run-v4', (transaction) => {
      appendV4LifecycleEvent(transaction, 'planning.started', { completed: 0, total: 1 })
      appendV4LifecycleEvent(transaction, 'planning.started', { completed: 0, total: 1 })
      appendV4LifecycleEvent(transaction, 'planning.completed', {
        completed: 0, total: 1, reason: 'PLANNING_FAILED', retryable: true,
        requiresUserAction: true, nextAction: 'RETRY',
      })
      appendV4LifecycleEvent(transaction, 'planning.started', { completed: 0, total: 1 })
    })

    expect((await repository.listEvents('run-v4')).map((event) => event.type)).toEqual([
      'planning.started', 'planning.completed', 'planning.started',
    ])
  })

  test('moves an active v4 run to a controlled terminal failure event', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-07-30T01:00:00.000Z'))
    await repository.createRun(run('EXECUTING'))
    await repository.transact('run-v4', (transaction) => {
      appendV4LifecycleEvent(transaction, 'generation.started', { completed: 0, total: 3, pageNumbers: [1, 2, 3] })
      appendV4LifecycleEvent(transaction, 'generation.progress', { completed: 1, total: 3, pageNumbers: [1, 2, 3] })
    })

    expect(await failVisualDeckV4Run({ repository, clock, runId: 'run-v4', errorCode: 'WORKER_FATAL' }))
      .toBe(true)

    expect(await repository.getRun('run-v4')).toMatchObject({ status: 'FAILED' })
    const events = await repository.listEvents('run-v4')
    expect(events.map((event) => event.type)).toEqual([
      'generation.started', 'generation.progress', 'generation.completed', 'phase.changed', 'run.failed',
    ])
    expect(events[2]).toMatchObject({
      type: 'generation.completed',
      payload: { completed: 1, total: 3, reason: 'INTERNAL_FAILURE', retryable: false },
    })
    const terminal = events.at(-1)!
    expect(agentEventSchema.parse(terminal)).toEqual(terminal)
    expect(terminal).toMatchObject({
      type: 'run.failed',
      payload: {
        presentationMode: 'VISUAL_DECK_V4', stage: 'RUN', reason: 'INTERNAL_FAILURE',
        errorCode: 'WORKER_FATAL', retryable: false, requiresUserAction: false, nextAction: null,
      },
    })
  })

  test('closes an active revision with its last progress before terminal failure', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-07-30T01:00:00.000Z'))
    await repository.createRun({ ...run('REVISING'), revisionRound: 1 })
    await repository.transact('run-v4', (transaction) => {
      appendV4LifecycleEvent(transaction, 'revision.started', {
        completed: 0, total: 2, pageNumbers: [2, 3], revisionKind: 'DECK_VISUAL', revisionRound: 1,
      })
      appendV4LifecycleEvent(transaction, 'revision.progress', {
        completed: 1, total: 2, pageNumbers: [2, 3], revisionKind: 'DECK_VISUAL', revisionRound: 1,
      })
    })

    expect(await failVisualDeckV4Run({ repository, clock, runId: 'run-v4', errorCode: 'WORKER_FATAL' }))
      .toBe(true)
    const events = await repository.listEvents('run-v4')
    expect(events.map((event) => event.type)).toEqual([
      'revision.started', 'revision.progress', 'revision.completed', 'phase.changed', 'run.failed',
    ])
    expect(events[2]).toMatchObject({
      type: 'revision.completed',
      payload: {
        completed: 1, total: 2, pageNumbers: [2, 3], revisionKind: 'DECK_VISUAL', revisionRound: 1,
        reason: 'INTERNAL_FAILURE', retryable: false,
      },
    })
  })

  test('moves a delivering v4 run to the same controlled terminal failure', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-07-30T01:00:00.000Z'))
    await repository.createRun(run('DELIVERING'))

    expect(await failVisualDeckV4Run({ repository, clock, runId: 'run-v4', errorCode: 'WORKER_FATAL' }))
      .toBe(true)
    expect(await repository.getRun('run-v4')).toMatchObject({ status: 'FAILED' })
    expect((await repository.listEvents('run-v4')).at(-1)).toMatchObject({
      type: 'run.failed', payload: { errorCode: 'WORKER_FATAL' },
    })
  })
})

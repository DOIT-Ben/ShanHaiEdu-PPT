import { describe, expect, test } from 'bun:test'
import { InMemoryAgentRepository } from '../src/adapters/in-memory-repository'
import { FixedClock } from '../src/adapters/mock-ports'
import { agentEventSchema, CONTRACT_VERSION } from '../src/contracts'
import type { RunRecord } from '../src/core/ports'
import {
  appendAcceptedQualityIssueResolutions,
  appendFixedIssueResolutions,
  appendV4LifecycleEvent,
  failVisualDeckV4Run,
  failVisualDeckV4Transaction,
  qualityPolicyAuditForRun,
  reconcileVisualDeckV4TerminalState,
} from '../src/core/v4-lifecycle'

function run(status: RunRecord['status'] = 'PLANNING'): RunRecord {
  return {
    id: 'run-v4', creationKey: 'create-v4', requestHash: 'hash-v4',
    host: { tenantId: 'frameflow', externalUserId: 'user-v4' },
    source: { kind: 'TEXT', text: '这是用于验证 V4 生命周期事件的完整教材内容。'.repeat(3) },
    slideCount: 3, visualDirection: '清晰课堂视觉', imageModel: 'gpt-image-2',
    automationLevel: 'SUPERVISED', presentationMode: 'VISUAL_DECK_V4',
    maxRevisionRounds: 2, revisionRound: 0, qualityScore: null,
    status, resumeState: null, version: 0, budgetUnits: 10, committedBudgetUnits: 0,
    qualityOverride: false, qualityOverrideReason: null, qualityOverrideBy: null,
    leaseToken: null, leaseUntil: null, leaseVersion: 0,
    createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z',
  }
}

describe('visual deck v4 lifecycle', () => {
  test('persists a Usage V2 finalization outbox in the same failure transaction', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-07-30T01:00:00.000Z'))
    await repository.createRun({ ...run('EXECUTING'), accountingProtocol: 'FRAMEFLOW_USAGE_V2' })

    expect(await failVisualDeckV4Run({ repository, clock, runId: 'run-v4', errorCode: 'WORKER_FATAL' }))
      .toBe(true)
    expect((await repository.listSteps('run-v4')).find((step) => step.tool === 'finalize_usage_v2'))
      .toMatchObject({
        status: 'RUNNING', idempotencyKey: 'run-v4:usage-v2:finalize',
        output: { idempotencyKey: 'finalize:run-v4', deliveryState: 'PENDING' },
      })
    expect(await repository.getTerminalEvent('run-v4')).toMatchObject({ type: 'run.failed' })
  })

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

  test('reports every hard blocker without accepting any recommendation in the same decision', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun(run('DECK_REVIEW'))

    const disposition = await repository.transact('run-v4', (transaction) => {
      for (const issue of [{
        id: 'quality-issue', category: 'IMAGE_QUALITY' as const, severity: 'WARNING' as const,
        summary: '第二页构图仍有可优化空间。', slideIds: ['run-v4:slide:2'], sourceChunkIds: [], status: 'OPEN' as const,
      }, {
        id: 'source-issue', category: 'SOURCE_INCOMPLETE' as const, severity: 'CRITICAL' as const,
        summary: '来源材料不完整。', slideIds: [], sourceChunkIds: [], status: 'OPEN' as const,
      }, {
        id: 'billing-issue', category: 'BUDGET_RESERVATION_UNKNOWN' as const, severity: 'CRITICAL' as const,
        summary: '账务预授权状态未知。', slideIds: [], sourceChunkIds: [], status: 'OPEN' as const,
      }, {
        id: 'factual-issue', category: 'FACTUAL_RISK' as const, severity: 'WARNING' as const,
        summary: '第二页存在事实错误。', slideIds: ['run-v4:slide:2'], sourceChunkIds: ['chunk-2'], status: 'OPEN' as const,
      }, {
        id: 'curriculum-issue', category: 'CURRICULUM_GAP' as const, severity: 'WARNING' as const,
        summary: '课程关键事实缺失。', slideIds: ['run-v4:slide:3'], sourceChunkIds: ['chunk-3'], status: 'OPEN' as const,
      }, {
        id: 'critical-visual-issue', category: 'IMAGE_QUALITY' as const, severity: 'CRITICAL' as const,
        summary: '页面存在安全相关的严重视觉错误。', slideIds: ['run-v4:slide:1'], sourceChunkIds: [], status: 'OPEN' as const,
      }, {
        id: 'knowledge-domain-issue', category: 'IMAGE_QUALITY' as const, severity: 'WARNING' as const,
        summary: '页面问题需要修改来源约束内的知识内容。', slideIds: ['run-v4:slide:1'],
        sourceChunkIds: ['chunk-1'], status: 'OPEN' as const, repairDomain: 'KNOWLEDGE' as const,
      }]) {
        transaction.appendEvent({ schemaVersion: CONTRACT_VERSION, type: 'issue.detected', payload: issue })
      }
      return appendAcceptedQualityIssueResolutions(transaction)
    })

    expect(disposition).toEqual({
      acceptedIssueIds: [],
      blockingIssueIds: [
        'source-issue', 'billing-issue', 'factual-issue', 'curriculum-issue', 'critical-visual-issue',
        'knowledge-domain-issue',
      ],
    })
    expect((await repository.listEvents('run-v4')).filter((event) => event.type === 'issue.resolved'))
      .toEqual([])
  })

  test('treats a rejected legacy page review without quality impact as a hard blocker', async () => {
    const repository = new InMemoryAgentRepository()
    await repository.createRun({ ...run('DECK_REVIEW'), automationLevel: 'BOUNDED_AUTO' })

    const disposition = await repository.transact('run-v4', (transaction) => {
      transaction.putStep({
        id: 'step-legacy-page-review',
        runId: 'run-v4',
        idempotencyKey: 'run-v4:slide:2:image:r0:v1:review',
        inputHash: 'legacy-page-review-input',
        tool: 'review_slide_image',
        status: 'COMPLETED',
        budgetUnits: 0,
        budgetReservationId: null,
        externalOperationId: null,
        errorCode: null,
        output: {
          approved: false,
          textDetected: false,
          visualScore: 55,
          reasons: ['对象数量与教材事实不一致。'],
          retryInstruction: 'Render exactly five countable objects and preserve their source-grounded relationship.',
        },
        createdAt: transaction.run.createdAt,
        updatedAt: transaction.run.updatedAt,
      })
      transaction.appendEvent({
        schemaVersion: CONTRACT_VERSION,
        type: 'issue.detected',
        payload: {
          id: 'step-legacy-page-review:visual-review',
          category: 'IMAGE_QUALITY',
          severity: 'WARNING',
          summary: '对象数量与教材事实不一致。',
          slideIds: ['run-v4:slide:2'],
          sourceChunkIds: [],
          status: 'OPEN',
        },
      })
      return appendAcceptedQualityIssueResolutions(transaction)
    })

    expect(disposition).toEqual({
      acceptedIssueIds: [],
      blockingIssueIds: ['step-legacy-page-review:visual-review'],
    })
    expect((await repository.listEvents('run-v4')).some((event) =>
      event.type === 'issue.resolved' && event.payload.resolution === 'ACCEPTED')).toBe(false)
  })

  test('fails closed for indistinguishable legacy quality actors and trusts only explicit policy audit', () => {
    const legacyActor = {
      ...run('DELIVERING'),
      qualityOverride: true,
      qualityOverrideBy: 'ppt-agent-quality-policy',
      qualityOverrideRole: 'ADMIN' as const,
      qualityOverrideIssueIds: ['legacy-quality-issue'],
      qualityOverrideAt: '2026-07-21T00:00:00.000Z',
    }
    expect(qualityPolicyAuditForRun({
      ...legacyActor,
      qualityOverrideReason: '管理员已逐项复核并接受当前问题。',
    })).toBeNull()
    expect(qualityPolicyAuditForRun({
      ...legacyActor,
      qualityOverrideReason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
    })).toBeNull()

    const explicitPolicyAudit = {
      provenance: 'SYSTEM_POLICY' as const,
      policyId: 'v4-non-blocking-quality-v1',
      reason: 'PPT Agent 按非阻断质量策略接受当前版本并继续交付。',
      issueIds: ['legacy-quality-issue'],
      acceptedAt: '2026-07-21T00:00:00.000Z',
    }
    expect(qualityPolicyAuditForRun({
      ...legacyActor,
      qualityOverrideBy: null,
      qualityOverrideRole: null,
      qualityOverrideReason: explicitPolicyAudit.reason,
      qualityDisposition: 'SYSTEM_POLICY_ACCEPTED',
      qualityPolicyAudit: explicitPolicyAudit,
    })).toEqual(explicitPolicyAudit)
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

  test('defers a quality terminal failure into internal accounting recovery instead of replaying review', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-07-30T01:00:00.000Z'))
    await repository.createRun({ ...run('PAGE_REVIEW'), budgetUnits: 3, committedBudgetUnits: 1 })
    const handled = await repository.transact('run-v4', (transaction) => {
      transaction.putStep({
        id: 'step-image-1', runId: 'run-v4', idempotencyKey: 'run-v4:slide:1:image:r0:v1',
        inputHash: 'image-1', tool: 'generate_slide_image', status: 'WAITING', budgetUnits: 1,
        budgetReservationId: 'reservation-batch-1', externalOperationId: 'operation-image-1',
        errorCode: null, output: null,
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-batch-1', runId: 'run-v4', idempotencyKey: 'run-v4:generation-batch:initial:r0:v1',
        inputHash: 'batch-1', tool: 'generate_image_batch', status: 'RUNNING', budgetUnits: 1,
        budgetReservationId: 'reservation-batch-1', externalOperationId: null, errorCode: null,
        output: {
          batchId: `genbatch_${'a'.repeat(32)}`, proposalHash: 'b'.repeat(64), revisionRound: 0,
          submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS', pageCount: 1,
          pages: [{ pageNumber: 1, idempotencyKey: 'run-v4:slide:1:image:r0:v1', promptHash: 'c'.repeat(64) }],
          accounting: {
            estimatedUnits: 1, committedUnits: 1, settledUnits: 0, releasedUnits: 0,
            reconciliationUnits: 0, authorization: 'RESERVED', settlement: 'NOT_READY',
          },
          progress: { submitted: 1, completed: 0, failed: 0 }, status: 'PROCESSING',
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      return failVisualDeckV4Transaction({
        transaction,
        clock,
        errorCode: 'QUALITY_REMEDIATION_EXHAUSTED',
        reason: 'REVISION_LIMIT_REACHED',
      })
    })

    expect(handled).toBe(true)
    expect(await repository.getRun('run-v4')).toMatchObject({
      status: 'RECOVERING',
      pendingTerminalFailure: {
        errorCode: 'QUALITY_REMEDIATION_EXHAUSTED', reason: 'REVISION_LIMIT_REACHED',
      },
      technicalRecovery: { reason: 'TERMINAL_ACCOUNTING_PENDING', active: true },
    })
    expect((await repository.listEvents('run-v4')).some((event) => event.type === 'run.failed')).toBe(false)
    expect((await repository.listEvents('run-v4')).some((event) => event.type === 'approval.required')).toBe(false)

    await repository.transact('run-v4', (transaction) => {
      const image = transaction.getStep('run-v4:slide:1:image:r0:v1')!
      transaction.putStep({ ...image, status: 'COMPLETED', output: { artifactId: 'artifact-1' } })
      const batch = transaction.getStep('run-v4:generation-batch:initial:r0:v1')!
      transaction.putStep({
        ...batch,
        status: 'COMPLETED',
        output: {
          ...(batch.output as Record<string, unknown>),
          accounting: {
            estimatedUnits: 1, committedUnits: 1, settledUnits: 1, releasedUnits: 0,
            reconciliationUnits: 0, authorization: 'RESERVED', settlement: 'SETTLED',
          },
          progress: { submitted: 1, completed: 1, failed: 0 },
          status: 'COMPLETED',
        },
      })
    })
    expect(await repository.transact('run-v4', (transaction) =>
      reconcileVisualDeckV4TerminalState(transaction, clock))).toBe(true)
    expect(await repository.getRun('run-v4')).toMatchObject({
      status: 'FAILED',
      terminalAccounting: { accountingStatus: 'FINAL', settledUnits: 1, releasedUnits: 2 },
    })
    expect((await repository.getRun('run-v4'))?.pendingTerminalFailure).toBeUndefined()
    expect((await repository.listEvents('run-v4')).filter((event) => event.type === 'run.failed')).toHaveLength(1)
    expect(await repository.transact('run-v4', (transaction) =>
      reconcileVisualDeckV4TerminalState(transaction, clock))).toBe(false)
    expect((await repository.listEvents('run-v4')).filter((event) => event.type === 'run.failed')).toHaveLength(1)
  })

  test('defers worker fatal until accounting is final and then publishes one failure', async () => {
    const repository = new InMemoryAgentRepository()
    const clock = new FixedClock(new Date('2026-07-30T02:00:00.000Z'))
    await repository.createRun({ ...run('EXECUTING'), budgetUnits: 3, committedBudgetUnits: 1 })
    await repository.transact('run-v4', (transaction) => {
      transaction.putStep({
        id: 'step-image-1', runId: 'run-v4', idempotencyKey: 'run-v4:slide:1:image:r0:v1',
        inputHash: 'image-1', tool: 'generate_slide_image', status: 'WAITING', budgetUnits: 1,
        budgetReservationId: 'reservation-batch-1', externalOperationId: 'operation-image-1',
        errorCode: null, output: null, createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      transaction.putStep({
        id: 'step-batch-1', runId: 'run-v4', idempotencyKey: 'run-v4:generation-batch:initial:r0:v1',
        inputHash: 'batch-1', tool: 'generate_image_batch', status: 'RUNNING', budgetUnits: 1,
        budgetReservationId: 'reservation-batch-1', externalOperationId: null, errorCode: null,
        output: {
          batchId: `genbatch_${'d'.repeat(32)}`, proposalHash: 'e'.repeat(64), revisionRound: 0,
          submissionMode: 'GATEWAY_INDIVIDUAL_OPERATIONS', pageCount: 1,
          pages: [{ pageNumber: 1, idempotencyKey: 'run-v4:slide:1:image:r0:v1', promptHash: 'f'.repeat(64) }],
          accounting: {
            estimatedUnits: 1, committedUnits: 1, settledUnits: 0, releasedUnits: 0,
            reconciliationUnits: 0, authorization: 'RESERVED', settlement: 'NOT_READY',
          },
          progress: { submitted: 1, completed: 0, failed: 0 }, status: 'PROCESSING',
          createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
        },
        createdAt: transaction.run.createdAt, updatedAt: transaction.run.updatedAt,
      })
      expect(failVisualDeckV4Transaction({
        transaction, clock, errorCode: 'WORKER_FATAL', reason: 'INTERNAL_FAILURE',
      })).toBe(true)
    })
    expect(await repository.getRun('run-v4')).toMatchObject({
      status: 'RECOVERING',
      pendingTerminalFailure: { errorCode: 'WORKER_FATAL', reason: 'INTERNAL_FAILURE' },
      terminalAccounting: { accountingStatus: 'RECONCILIATION_REQUIRED' },
    })
    expect(await repository.getTerminalEvent('run-v4')).toBeNull()

    await repository.transact('run-v4', (transaction) => {
      const image = transaction.getStep('run-v4:slide:1:image:r0:v1')!
      transaction.putStep({ ...image, status: 'COMPLETED', output: { artifactId: 'artifact-1' } })
      const batch = transaction.getStep('run-v4:generation-batch:initial:r0:v1')!
      transaction.putStep({
        ...batch,
        status: 'COMPLETED',
        output: {
          ...(batch.output as Record<string, unknown>),
          accounting: {
            estimatedUnits: 1, committedUnits: 1, settledUnits: 1, releasedUnits: 0,
            reconciliationUnits: 0, authorization: 'RESERVED', settlement: 'SETTLED',
          },
          progress: { submitted: 1, completed: 1, failed: 0 }, status: 'COMPLETED',
        },
      })
      expect(reconcileVisualDeckV4TerminalState(transaction, clock)).toBe(true)
    })
    expect(await repository.getRun('run-v4')).toMatchObject({
      status: 'FAILED', terminalAccounting: { accountingStatus: 'FINAL', settledUnits: 1, releasedUnits: 2 },
    })
    expect(await repository.getTerminalEvent('run-v4')).toMatchObject({ type: 'run.failed' })
    expect((await repository.listEvents('run-v4')).filter((event) => event.type === 'run.failed'))
      .toHaveLength(1)
    expect(await repository.transact('run-v4', (transaction) =>
      reconcileVisualDeckV4TerminalState(transaction, clock))).toBe(false)
    expect((await repository.listEvents('run-v4')).filter((event) => event.type === 'run.failed'))
      .toHaveLength(1)
  })
})

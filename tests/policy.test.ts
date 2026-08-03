import { describe, expect, test } from 'bun:test'
import { CONTRACT_VERSION, type RunAction } from '../src/contracts'
import {
  PolicyError,
  applyRunAction,
  canTransition,
  evaluateBudget,
  releaseBudget,
  recoverMediaExecution,
  recoverMediaRevision,
  reserveBudget,
  type RunPolicyState,
} from '../src/core/policy'

function state(overrides: Partial<RunPolicyState> = {}): RunPolicyState {
  return {
    status: 'EXECUTING',
    resumeState: null,
    version: 3,
    budgetUnits: 100,
    committedBudgetUnits: 20,
    qualityOverride: false,
    ...overrides,
  }
}

describe('run transition policy', () => {
  test('allows deck review to pause for budget and resume exactly', () => {
    const paused = applyRunAction(state({ status: 'DECK_REVIEW' }), {
      schemaVersion: CONTRACT_VERSION,
      type: 'PAUSE',
      expectedVersion: 3,
    })

    expect(paused).toMatchObject({ status: 'PAUSED', resumeState: 'DECK_REVIEW', version: 4 })
    const resumed = applyRunAction(paused, {
      schemaVersion: CONTRACT_VERSION,
      type: 'RESUME',
      expectedVersion: 4,
    })
    expect(resumed).toMatchObject({ status: 'DECK_REVIEW', resumeState: null, version: 5 })
  })

  test('routes accepted human override through delivery with audit flag', () => {
    const result = applyRunAction(state({ status: 'NEEDS_HUMAN' }), {
      schemaVersion: CONTRACT_VERSION,
      type: 'ACCEPT_WITH_OVERRIDE',
      expectedVersion: 3,
      reason: '教师已复核现有问题并明确接受当前版本。',
      issueIds: ['issue-visual-1'],
    })

    expect(result).toMatchObject({ status: 'DELIVERING', qualityOverride: true, version: 4 })
    expect(canTransition('DELIVERING', 'COMPLETED')).toBe(true)
    expect(canTransition('DELIVERING', 'FAILED')).toBe(true)
  })

  test('allows a v4 quality override only in an administrator policy context', () => {
    const action: RunAction = {
      schemaVersion: CONTRACT_VERSION,
      type: 'ACCEPT_WITH_OVERRIDE',
      expectedVersion: 3,
      reason: '内部管理员已经复核所有问题并记录质量放行依据。',
      issueIds: ['issue-visual-1'],
    }
    const v4 = state({ status: 'NEEDS_HUMAN', presentationMode: 'VISUAL_DECK_V4' })

    expect(() => applyRunAction(v4, action, { actorRole: 'USER' }))
      .toThrow('v4 quality override requires administrator context')
    expect(applyRunAction(v4, action, { actorRole: 'ADMIN' }))
      .toMatchObject({ status: 'DELIVERING', qualityOverride: true })
  })

  test('rejects stale actions and invalid terminal transitions', () => {
    expect(() => applyRunAction(state(), {
      schemaVersion: CONTRACT_VERSION,
      type: 'PAUSE',
      expectedVersion: 2,
    })).toThrow(PolicyError)
    expect(canTransition('COMPLETED', 'EXECUTING')).toBe(false)
    expect(canTransition('NEEDS_HUMAN', 'COMPLETED')).toBe(false)
    expect(canTransition('NEEDS_HUMAN', 'EXECUTING')).toBe(false)
  })

  test('allows provider recovery only from the human-review state', () => {
    expect(recoverMediaExecution(state({ status: 'NEEDS_HUMAN' }))).toMatchObject({ status: 'EXECUTING', version: 4 })
    expect(recoverMediaRevision(state({ status: 'NEEDS_HUMAN' }))).toMatchObject({ status: 'REVISING', version: 4 })
    expect(() => recoverMediaExecution(state({ status: 'EXECUTING' }))).toThrow('media recovery requires human-review state')
  })

  test('returns a failed planning run to planning only through recovery actions', () => {
    const recovered = applyRunAction(state({ status: 'NEEDS_HUMAN' }), {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_PLANNING',
      expectedVersion: 3,
    })
    expect(recovered).toMatchObject({ status: 'PLANNING', version: 4 })
    expect(() => applyRunAction(state({ status: 'EXECUTING' }), {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_PLANNING',
      expectedVersion: 3,
    })).toThrow('planning retry requires human-review state')
  })

  test('returns a failed delivery run to delivery through its recovery action', () => {
    const recovered = applyRunAction(state({ status: 'NEEDS_HUMAN' }), {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: 3,
    })
    expect(recovered).toMatchObject({ status: 'DELIVERING', version: 4 })
    expect(() => applyRunAction(state({ status: 'DELIVERING' }), {
      schemaVersion: CONTRACT_VERSION,
      type: 'RETRY_DELIVERY',
      expectedVersion: 3,
    })).toThrow('delivery retry requires human-review state')
  })
})

describe('media budget policy', () => {
  test('reserves and releases integer budget without exceeding the cap', () => {
    const reserved = reserveBudget(state(), 30)
    expect(reserved).toMatchObject({ committedBudgetUnits: 50, version: 4 })
    expect(releaseBudget(reserved, 10)).toMatchObject({ committedBudgetUnits: 40, version: 5 })
  })

  test('blocks initial images and redraws equally when budget is insufficient', () => {
    expect(evaluateBudget(state(), 81)).toEqual({
      allowed: false,
      reason: 'BUDGET_EXCEEDED',
      remainingBudgetUnits: 80,
    })
    expect(() => reserveBudget(state(), 81)).toThrow('media budget reservation rejected')
  })

  test('keeps paused, human-review and terminal runs from creating media', () => {
    for (const status of ['PAUSED', 'NEEDS_HUMAN', 'COMPLETED'] as const) {
      expect(evaluateBudget(state({ status }), 10)).toMatchObject({ allowed: false, reason: 'RUN_NOT_ACTIVE' })
    }
  })
})

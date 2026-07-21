import { describe, expect, test } from 'bun:test'
import { FixedClock } from '../src/adapters/mock-ports'
import {
  RuntimeHealthMonitor,
  safeWorkerErrorCode,
  WorkerTickError,
  workerLogRecord,
} from '../src/observability/runtime-health'

describe('runtime health monitor', () => {
  test('detects a stale worker heartbeat while liveness remains up', async () => {
    const clock = new FixedClock()
    const health = new RuntimeHealthMonitor(clock, { version: '0.2.0', heartbeatStaleMs: 1_000 })
    await health.runTick(async () => ({ scannedRuns: 2, activeRuns: 1 }))
    clock.advance(1_001)

    expect(health.liveness()).toMatchObject({ status: 'UP', version: '0.2.0' })
    expect(health.readiness()).toMatchObject({
      status: 'NOT_READY', reason: 'WORKER_HEARTBEAT_STALE',
      worker: { tickCount: 1, heartbeatAgeMs: 1_001 },
    })
  })

  test('surfaces one failed tick until a later tick succeeds', async () => {
    const clock = new FixedClock()
    const health = new RuntimeHealthMonitor(clock, { version: 'test' })
    await expect(health.runTick(async () => {
      throw new WorkerTickError({ runId: 'run-1', phase: 'EXECUTING', errorCode: 'PROVIDER_TIMEOUT' }, new Error('private detail'))
    })).rejects.toBeInstanceOf(WorkerTickError)
    expect(health.readiness()).toMatchObject({
      status: 'NOT_READY', reason: 'WORKER_TICK_FAILED',
      worker: { lastFailure: { runId: 'run-1', phase: 'EXECUTING', errorCode: 'PROVIDER_TIMEOUT' } },
    })

    clock.advance(500)
    await health.runTick(async () => ({ scannedRuns: 1, activeRuns: 0 }))
    expect(health.readiness()).toMatchObject({ status: 'READY', reason: null, worker: { tickCount: 1 } })
  })

  test('detects a stuck tick even while the event-loop heartbeat remains fresh', async () => {
    const clock = new FixedClock()
    const health = new RuntimeHealthMonitor(clock, { version: 'test', heartbeatStaleMs: 1_000, tickStaleMs: 10_000 })
    let finish!: (summary: { scannedRuns: number; activeRuns: number }) => void
    const operation = new Promise<{ scannedRuns: number; activeRuns: number }>((resolve) => { finish = resolve })
    const pending = health.runTick(() => operation)
    clock.advance(10_001)
    health.heartbeat()

    expect(health.readiness()).toMatchObject({
      status: 'NOT_READY', reason: 'WORKER_TICK_STUCK',
      worker: { tickInProgress: true, heartbeatAgeMs: 0, tickAgeMs: 10_001 },
    })
    finish({ scannedRuns: 1, activeRuns: 1 })
    await pending
  })

  test('redacts arbitrary error messages and emits allowlisted structured fields', () => {
    expect(safeWorkerErrorCode(new Error('prompt contained private lesson text'))).toBe('WORKER_TICK_FAILED')
    expect(safeWorkerErrorCode(new Error('PROVIDER_TIMEOUT'))).toBe('PROVIDER_TIMEOUT')
    const record = workerLogRecord({
      event: 'worker_tick_failed', version: '0.2.0', elapsedMs: 12.7,
      failure: { runId: 'run-1', phase: 'PLANNING', errorCode: 'PROVIDER_TIMEOUT' },
    })
    expect(record).toMatchObject({
      service: 'ppt-agent', event: 'worker_tick_failed', version: '0.2.0', elapsedMs: 13,
      runId: 'run-1', phase: 'PLANNING', errorCode: 'PROVIDER_TIMEOUT',
    })
    expect(JSON.stringify(record)).not.toContain('private lesson text')
  })
})

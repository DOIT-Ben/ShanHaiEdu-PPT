import { AsyncLocalStorage } from 'node:async_hooks'
import type { ClockPort, RunRecord } from '../core/ports'

export type WorkerFailureContext = Readonly<{
  runId: string | null
  phase: RunRecord['status'] | null
  errorCode: string
}>

export type WorkerTickSummary = Readonly<{
  scannedRuns: number
  activeRuns: number
}>

export class WorkerTickError extends Error {
  constructor(
    readonly context: WorkerFailureContext,
    readonly cause: unknown,
  ) {
    super(context.errorCode)
    this.name = 'WorkerTickError'
  }
}

export function safeWorkerErrorCode(error: unknown) {
  const value = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : error instanceof Error
      ? error.message
      : ''
  return /^[A-Z][A-Z0-9_:-]{0,99}$/.test(value) ? value : 'WORKER_TICK_FAILED'
}

export class RuntimeHealthMonitor {
  private readonly startedAt: string
  private lastHeartbeatAt: string | null = null
  private lastTickStartedAt: string | null = null
  private lastTickActivityAt: string | null = null
  private lastTickCompletedAt: string | null = null
  private lastTickFailedAt: string | null = null
  private lastFailure: WorkerFailureContext | null = null
  private readonly tickOperationContext = new AsyncLocalStorage<string>()
  private readonly activeTickOperations = new Map<string, string>()
  private tickInProgress = false
  private tickCount = 0

  constructor(
    private readonly clock: ClockPort,
    private readonly options: Readonly<{
      version: string
      heartbeatStaleMs?: number
      tickStaleMs?: number
    }>,
  ) {
    this.startedAt = clock.now().toISOString()
  }

  heartbeat() {
    this.lastHeartbeatAt = this.clock.now().toISOString()
  }

  tickActivity() {
    if (!this.tickInProgress) return
    const now = this.clock.now().toISOString()
    this.lastTickActivityAt = now
    const operationId = this.tickOperationContext.getStore()
    if (operationId && this.activeTickOperations.has(operationId)) {
      this.activeTickOperations.set(operationId, now)
    }
  }

  async trackTickOperation<T>(operationId: string, operation: () => Promise<T>) {
    const now = this.clock.now().toISOString()
    this.activeTickOperations.set(operationId, now)
    try {
      return await this.tickOperationContext.run(operationId, operation)
    } finally {
      this.activeTickOperations.delete(operationId)
      this.lastTickActivityAt = this.clock.now().toISOString()
    }
  }

  async runTick(operation: () => Promise<WorkerTickSummary>) {
    this.heartbeat()
    this.tickInProgress = true
    this.activeTickOperations.clear()
    this.lastTickStartedAt = this.clock.now().toISOString()
    this.lastTickActivityAt = this.lastTickStartedAt
    try {
      const summary = await operation()
      this.tickInProgress = false
      this.activeTickOperations.clear()
      this.tickCount += 1
      this.lastTickCompletedAt = this.clock.now().toISOString()
      return summary
    } catch (error) {
      this.tickInProgress = false
      this.activeTickOperations.clear()
      this.lastTickFailedAt = this.clock.now().toISOString()
      this.lastFailure = error instanceof WorkerTickError
        ? error.context
        : { runId: null, phase: null, errorCode: safeWorkerErrorCode(error) }
      throw error
    }
  }

  liveness() {
    const now = this.clock.now()
    return {
      service: 'ppt-agent' as const,
      status: 'UP' as const,
      version: this.options.version,
      checkedAt: now.toISOString(),
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, now.getTime() - Date.parse(this.startedAt)),
    }
  }

  readiness() {
    const now = this.clock.now()
    const heartbeatAgeMs = this.lastHeartbeatAt === null
      ? null
      : Math.max(0, now.getTime() - Date.parse(this.lastHeartbeatAt))
    const operationAges = [...this.activeTickOperations.values()]
      .map((timestamp) => Math.max(0, now.getTime() - Date.parse(timestamp)))
    const tickAgeMs = this.tickInProgress
      ? operationAges.length > 0
        ? Math.max(...operationAges)
        : this.lastTickActivityAt ? Math.max(0, now.getTime() - Date.parse(this.lastTickActivityAt)) : null
      : null
    const heartbeatStaleMs = this.options.heartbeatStaleMs ?? 5_000
    const tickStaleMs = this.options.tickStaleMs ?? 25 * 60_000
    let reason: 'WORKER_NOT_STARTED' | 'WORKER_HEARTBEAT_STALE' | 'WORKER_TICK_STUCK' | 'WORKER_TICK_FAILED' | null = null
    if (heartbeatAgeMs === null) reason = 'WORKER_NOT_STARTED'
    else if (heartbeatAgeMs > heartbeatStaleMs) reason = 'WORKER_HEARTBEAT_STALE'
    else if (tickAgeMs !== null && tickAgeMs > tickStaleMs) reason = 'WORKER_TICK_STUCK'
    else if (this.lastTickFailedAt && (!this.lastTickCompletedAt || this.lastTickFailedAt > this.lastTickCompletedAt)) {
      reason = 'WORKER_TICK_FAILED'
    }
    return {
      service: 'ppt-agent' as const,
      status: reason ? 'NOT_READY' as const : 'READY' as const,
      reason,
      version: this.options.version,
      checkedAt: now.toISOString(),
      worker: {
        tickInProgress: this.tickInProgress,
        tickCount: this.tickCount,
        activeOperationCount: this.activeTickOperations.size,
        lastHeartbeatAt: this.lastHeartbeatAt,
        heartbeatAgeMs,
        lastTickStartedAt: this.lastTickStartedAt,
        lastTickActivityAt: this.lastTickActivityAt,
        lastTickCompletedAt: this.lastTickCompletedAt,
        lastTickFailedAt: this.lastTickFailedAt,
        tickAgeMs,
        lastFailure: this.lastFailure,
      },
    }
  }
}

export function workerLogRecord(input: Readonly<{
  event: 'worker_tick_completed' | 'worker_tick_failed' | 'service_started'
  version: string
  elapsedMs?: number
  summary?: WorkerTickSummary
  failure?: WorkerFailureContext
}>) {
  return {
    timestamp: new Date().toISOString(),
    service: 'ppt-agent',
    version: input.version,
    event: input.event,
    ...(input.elapsedMs === undefined ? {} : { elapsedMs: Math.max(0, Math.round(input.elapsedMs)) }),
    ...(input.summary ? { scannedRuns: input.summary.scannedRuns, activeRuns: input.summary.activeRuns } : {}),
    ...(input.failure ? input.failure : {}),
  }
}

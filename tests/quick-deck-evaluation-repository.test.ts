import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryQuickDeckEvaluationRepository } from '../src/adapters/quick-deck-evaluation-in-memory-repository'
import { SqliteQuickDeckEvaluationRepository } from '../src/adapters/quick-deck-evaluation-sqlite-repository'
import type { QuickDeckEvaluationRepository, QuickDeckEvaluationRecord } from '../src/core/quick-deck-evaluation-ports'

const now = '2026-08-07T00:00:00.000Z'
const later = '2026-08-07T00:01:00.000Z'

function record(id: string, overrides: Partial<QuickDeckEvaluationRecord> = {}): QuickDeckEvaluationRecord {
  return {
    id,
    tenantId: 'evaluation-tenant',
    request: {
      schemaVersion: '1',
      source: { kind: 'TEXT', name: 'controlled.txt', text: '这是用于快速评测的受控文本材料，必须保持在隔离评测边界内。'.repeat(3) },
      slideCount: 1,
      visualDirection: '清晰的课堂信息图',
      imageModel: 'gemini-3-pro-image-preview',
    },
    requestHash: 'a'.repeat(64),
    textModel: 'gpt-5.6-terra',
    imageModel: 'gemini-3-pro-image-preview',
    evidenceContext: null,
    status: 'QUEUED',
    phase: 'ACCEPTED',
    blueprint: null,
    pages: [{
      pageNumber: 1, status: 'PENDING', submissionState: 'NOT_SUBMITTED', billingState: 'NOT_CHARGED', idempotencyKey: `quick-deck-evaluation:${id}:slide:1`, operationId: null,
      providerRequestId: null, artifactId: null, width: null, height: null, aspectRatioValidated: false, aspectDiagnostics: null, sha256: null, errorCode: null,
    }],
    pptx: null,
    preview: null,
    errorCode: null,
    pendingFailure: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    expiresAt: '2026-08-08T00:00:00.000Z',
    drainStartedAt: null,
    drainDeadline: null,
    nextAttemptAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function acceptedEvent(jobId: string) {
  return {
    schemaVersion: '1' as const,
    jobId,
    eventId: `event-${jobId}-accepted`,
    type: 'evaluation.accepted' as const,
    payload: { slideCount: 1 },
    occurredAt: now,
  }
}

async function withRepository(
  kind: 'memory' | 'sqlite',
  run: (repository: QuickDeckEvaluationRepository) => Promise<void>,
) {
  if (kind === 'memory') return await run(new InMemoryQuickDeckEvaluationRepository())
  const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-repository-'))
  const repository = new SqliteQuickDeckEvaluationRepository(join(directory, 'quick-deck-evaluations.sqlite'))
  try {
    await run(repository)
  } finally {
    repository.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('quick-deck evaluation repositories', () => {
  for (const kind of ['memory', 'sqlite'] as const) {
    test(`${kind} enforces daily and active limits before accepting a new evaluation`, async () => {
      await withRepository(kind, async (repository) => {
        expect(await repository.create({
          record: record('quick-deck-eval-1'), event: acceptedEvent('quick-deck-eval-1'),
          maxActiveJobs: 1, maxDailyJobs: 2, dayStart: '2026-08-07T00:00:00.000Z',
        })).toBe('CREATED')
        expect(await repository.create({
          record: record('quick-deck-eval-2'), event: acceptedEvent('quick-deck-eval-2'),
          maxActiveJobs: 1, maxDailyJobs: 2, dayStart: '2026-08-07T00:00:00.000Z',
        })).toBe('CONCURRENCY_LIMIT')
        await repository.save({
          record: record('quick-deck-eval-1', {
            status: 'COMPLETED', phase: 'COMPLETE', completedAt: later, nextAttemptAt: null, updatedAt: later,
          }),
        })
        expect(await repository.create({
          record: record('quick-deck-eval-2'), event: acceptedEvent('quick-deck-eval-2'),
          maxActiveJobs: 2, maxDailyJobs: 1, dayStart: '2026-08-07T00:00:00.000Z',
        })).toBe('DAILY_LIMIT')
      })
    })

    test(`${kind} turns an interrupted image submission into a drain without resubmitting it`, async () => {
      await withRepository(kind, async (repository) => {
        const job = record('quick-deck-eval-events')
        await repository.create({
          record: job, event: acceptedEvent(job.id), maxActiveJobs: 2, maxDailyJobs: 10,
          dayStart: '2026-08-07T00:00:00.000Z',
        })
        const generating = record(job.id, {
          status: 'SUBMITTING_IMAGES', phase: 'IMAGE_GENERATION', startedAt: later, nextAttemptAt: null, updatedAt: later,
          pages: [{ ...job.pages[0]!, status: 'PENDING', submissionState: 'UNKNOWN', operationId: null }],
          pendingFailure: null,
          drainStartedAt: null,
          drainDeadline: null,
        })
        await repository.save({
          record: generating,
          event: {
            schemaVersion: '1', jobId: job.id, eventId: `event-${job.id}-submitted`, type: 'images.submitted',
            payload: { submittedPages: 1, totalPages: 1 }, occurredAt: later,
          },
        })
        expect((await repository.readEvents({ jobId: job.id, afterSequence: 0, limit: 10 })).events.map((event) => event.sequence))
          .toEqual([1, 2])
        expect(await repository.recoverInterrupted({
          now: '2026-08-07T00:02:00.000Z', defaultDrainDeadline: '2026-08-07T00:17:00.000Z',
        })).toBe(1)
        expect(await repository.get(job.id)).toMatchObject({
          status: 'GENERATING', phase: 'IMAGE_GENERATION', errorCode: null,
          pendingFailure: 'EVALUATION_IMAGE_SUBMISSION_UNKNOWN',
          drainDeadline: '2026-08-07T00:17:00.000Z', nextAttemptAt: '2026-08-07T00:02:00.000Z',
        })
        const events = await repository.readEvents({ jobId: job.id, afterSequence: 0, limit: 10 })
        expect(events.events.map((event) => event.type)).toEqual([
          'evaluation.accepted', 'images.submitted', 'images.draining',
        ])
        expect(events.terminalSequence).toBeNull()
      })
    })

    test(`${kind} lists expired records without exposing them as runnable`, async () => {
      await withRepository(kind, async (repository) => {
        const job = record('quick-deck-eval-expired', { expiresAt: now, nextAttemptAt: null })
        await repository.create({
          record: job, event: acceptedEvent(job.id), maxActiveJobs: 2, maxDailyJobs: 10,
          dayStart: '2026-08-07T00:00:00.000Z',
        })
        expect(await repository.listRunnable({ now, limit: 10 })).toEqual([])
        expect(await repository.listExpired({ now, limit: 10 })).toMatchObject([{ id: job.id }])
      })
    })
  }
})

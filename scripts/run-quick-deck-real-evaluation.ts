import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  quickDeckEvaluationEnvelopeSchema,
  quickDeckEvaluationEventSchema,
  type QuickDeckEvaluationPublicJob,
} from '../src/quick-deck-evaluation-contracts'
import { hasVisualDeckV4AspectRatio } from '../src/core/blueprint-assets'

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:4311'
export const QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS = [1, 3, 10] as const
const CONTROLLED_SOURCE_TEXT = [
  '水循环由蒸发、凝结、降水和汇集组成。',
  '太阳提供能量，使地表水蒸发形成水汽。',
  '水汽遇冷凝结成云，降水回到地表并再次进入循环。',
].join('')

type EvaluationConfig = Readonly<{
  serviceUrl: string
  apiToken: string
  outputRoot: string
  textModel: string
  imageModel: string
  pollMs: number
  timeoutMs: number
}>

type SseResult = Readonly<{
  events: readonly ReturnType<typeof quickDeckEvaluationEventSchema.parse>[]
  chunkCount: number
}>

export type QuickDeckEvaluationRelease = Readonly<{
  softwareVersion: string
  gitSha: string
  releaseId: string
}>

type QuickDeckCanaryCaseResult = Readonly<{
  passed: boolean
  slideCount: number
  errorCode?: string
}>

type FetchPort = (input: string, init?: RequestInit) => Promise<Response>

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`)
  }
  return value
}

export function resolveQuickDeckEvaluationCanaryPageCounts(value: string | undefined) {
  const values = (value?.trim() || QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS.join(','))
    .split(',')
    .map((item) => Number(item.trim()))
  if (values.length !== QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS.length
    || !values.every((count, index) => count === QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS[index])) {
    throw new Error('QUICK_DECK_EVAL_PAGE_COUNTS_INVALID')
  }
  return QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS
}

function evaluationConfig(): EvaluationConfig {
  const url = new URL(process.env.QUICK_DECK_EVAL_SERVICE_URL?.trim() || DEFAULT_SERVICE_URL)
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('QUICK_DECK_EVAL_SERVICE_URL_MUST_BE_LOOPBACK')
  }
  resolveQuickDeckEvaluationCanaryPageCounts(process.env.QUICK_DECK_EVAL_PAGE_COUNTS)
  if (process.env.QUICK_DECK_EVAL_CODE_VERSION?.trim()) {
    throw new Error('QUICK_DECK_EVAL_CODE_VERSION_UNSUPPORTED')
  }
  return {
    serviceUrl: url.origin,
    apiToken: requiredEnvironment('QUICK_DECK_EVAL_API_TOKEN'),
    outputRoot: path.resolve(requiredEnvironment('QUICK_DECK_EVAL_OUTPUT_ROOT')),
    textModel: requiredEnvironment('QUICK_DECK_EVAL_TEXT_MODEL'),
    imageModel: requiredEnvironment('QUICK_DECK_EVAL_IMAGE_MODEL'),
    pollMs: boundedInteger('QUICK_DECK_EVAL_POLL_MS', 1_000, 250, 30_000),
    timeoutMs: boundedInteger('QUICK_DECK_EVAL_TIMEOUT_MS', 30 * 60_000, 10_000, 4 * 60 * 60_000),
  }
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function headers(config: EvaluationConfig, requestId: string, json = false) {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    'X-Request-ID': requestId,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

function validReleaseField(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
}

export async function readQuickDeckEvaluationReadyRelease(input: Readonly<{
  serviceUrl: string
  timeoutMs: number
  fetch: FetchPort
}>) {
  const response = await input.fetch(`${input.serviceUrl}/health/ready`, {
    headers: { 'X-Request-ID': `quick-deck-real-ready-${randomUUID()}` },
    signal: AbortSignal.timeout(input.timeoutMs),
  })
  const body = await response.json().catch(() => null)
  assert(response.status === 200, `QUICK_DECK_EVAL_READY_HTTP_${response.status}`)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('QUICK_DECK_EVAL_READY_CONTRACT_INVALID')
  }
  const record = body as Readonly<Record<string, unknown>>
  const release = record.release
  if (record.status !== 'READY' || !release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('QUICK_DECK_EVAL_READY_CONTRACT_INVALID')
  }
  const identity = release as Readonly<Record<string, unknown>>
  const { softwareVersion, gitSha, releaseId } = identity
  if (!validReleaseField(softwareVersion)
    || !validReleaseField(gitSha)
    || !validReleaseField(releaseId)
    || ['development', 'unknown', 'unversioned'].includes(gitSha)
    || ['development', 'unknown', 'unversioned'].includes(releaseId)) {
    throw new Error('QUICK_DECK_EVAL_READY_RELEASE_INVALID')
  }
  return {
    softwareVersion,
    gitSha,
    releaseId,
  } satisfies QuickDeckEvaluationRelease
}

function safeFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return /^[A-Z0-9_:.-]{1,160}$/.test(message) ? message : 'QUICK_DECK_REAL_EVALUATION_FAILED'
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

async function createEvaluation(config: EvaluationConfig, slideCount: number) {
  const requestId = `quick-deck-real-create-${slideCount}-${randomUUID()}`
  const response = await fetch(`${config.serviceUrl}/v1/evaluations/quick-decks`, {
    method: 'POST',
    headers: headers(config, requestId, true),
    body: JSON.stringify({
      schemaVersion: '1',
      source: { kind: 'TEXT', name: 'water-cycle-controlled-evaluation.txt', text: CONTROLLED_SOURCE_TEXT },
      slideCount,
      visualDirection: '清晰的自然科学信息图，主题与结论一眼可见，保留稳定阅读区。',
      imageModel: config.imageModel,
      audience: '小学高年级学生',
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  const body = await response.json().catch(() => null)
  assert(response.status === 201, `QUICK_DECK_CREATE_HTTP_${response.status}`)
  const parsed = quickDeckEvaluationEnvelopeSchema.safeParse(body)
  assert(parsed.success, 'QUICK_DECK_CREATE_CONTRACT_INVALID')
  assert(response.headers.get('X-Request-ID') === parsed.data.requestId, 'QUICK_DECK_CREATE_REQUEST_ID_INVALID')
  return { job: parsed.data.data, agentRequestId: parsed.data.requestId }
}

function consumeSseFrame(frame: string, events: Array<ReturnType<typeof quickDeckEvaluationEventSchema.parse>>) {
  const eventType = frame.split('\n').find((line) => line.startsWith('event: '))?.slice('event: '.length)
  const data = frame.split('\n').filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length)).join('\n')
  if (!eventType || !data) return
  const parsed = quickDeckEvaluationEventSchema.safeParse(JSON.parse(data))
  assert(parsed.success && parsed.data.type === eventType, 'QUICK_DECK_SSE_CONTRACT_INVALID')
  events.push(parsed.data)
}

async function collectSseEvents(config: EvaluationConfig, jobId: string, requestId: string): Promise<SseResult> {
  const response = await fetch(`${config.serviceUrl}/v1/evaluations/quick-decks/${encodeURIComponent(jobId)}/events?after=0`, {
    headers: { ...headers(config, requestId), Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  assert(response.status === 200 && response.body, `QUICK_DECK_SSE_HTTP_${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: Array<ReturnType<typeof quickDeckEvaluationEventSchema.parse>> = []
  let buffer = ''
  let chunkCount = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    chunkCount += 1
    buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      consumeSseFrame(buffer.slice(0, boundary), events)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
    }
  }
  buffer += decoder.decode().replace(/\r\n/g, '\n')
  if (buffer.trim()) consumeSseFrame(buffer, events)
  assert(chunkCount > 0 && events.length > 0, 'QUICK_DECK_SSE_EMPTY')
  assert(events.every((event, index) => event.sequence === index + 1), 'QUICK_DECK_SSE_SEQUENCE_INVALID')
  return { events, chunkCount }
}

async function getEvaluation(config: EvaluationConfig, jobId: string, requestId: string) {
  const response = await fetch(`${config.serviceUrl}/v1/evaluations/quick-decks/${encodeURIComponent(jobId)}`, {
    headers: headers(config, requestId),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  const body = await response.json().catch(() => null)
  assert(response.status === 200, `QUICK_DECK_GET_HTTP_${response.status}`)
  const parsed = quickDeckEvaluationEnvelopeSchema.safeParse(body)
  assert(parsed.success && parsed.data.data.jobId === jobId, 'QUICK_DECK_GET_CONTRACT_INVALID')
  return parsed.data.data
}

async function waitForTerminal(config: EvaluationConfig, jobId: string) {
  const deadline = Date.now() + config.timeoutMs
  let attempts = 0
  while (Date.now() <= deadline) {
    attempts += 1
    const job = await getEvaluation(config, jobId, `quick-deck-real-get-${attempts}-${randomUUID()}`)
    if (['COMPLETED', 'FAILED', 'EXPIRED'].includes(job.status)) return job
    await wait(config.pollMs)
  }
  throw new Error('QUICK_DECK_TERMINAL_TIMEOUT')
}

async function downloadArtifact(config: EvaluationConfig, jobId: string, format: 'pptx' | 'preview', job: QuickDeckEvaluationPublicJob) {
  const expected = format === 'pptx' ? job.artifacts.pptx : job.artifacts.preview
  assert(expected, 'QUICK_DECK_ARTIFACT_REFERENCE_MISSING')
  const response = await fetch(`${config.serviceUrl}/v1/evaluations/quick-decks/${encodeURIComponent(jobId)}/content?format=${format}`, {
    headers: headers(config, `quick-deck-real-content-${format}-${randomUUID()}`),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  const artifactFormat = format.toUpperCase()
  assert(response.status === 200, `QUICK_DECK_CONTENT_HTTP_${artifactFormat}_${response.status}`)
  assert(bytes.byteLength === expected.byteLength, `QUICK_DECK_CONTENT_LENGTH_INVALID_${artifactFormat}`)
  assert(sha256(bytes) === expected.sha256, `QUICK_DECK_CONTENT_SHA256_INVALID_${artifactFormat}`)
  assert(response.headers.get('ETag') === `"${expected.sha256}"`, `QUICK_DECK_CONTENT_ETAG_INVALID_${artifactFormat}`)
  return { byteLength: bytes.byteLength, sha256: expected.sha256, mimeType: expected.mimeType }
}

function validateCompletedJob(job: QuickDeckEvaluationPublicJob, config: EvaluationConfig, slideCount: number) {
  assert(job.status === 'COMPLETED' && job.phase === 'COMPLETE', 'QUICK_DECK_NOT_COMPLETED')
  assert(job.models.text === config.textModel && job.models.image === config.imageModel, 'QUICK_DECK_MODEL_IDENTITY_INVALID')
  assert(job.slideCount === slideCount && job.pages.length === slideCount, 'QUICK_DECK_PAGE_COUNT_INVALID')
  for (const page of job.pages) {
    assert(page.status === 'COMPLETED' && page.width !== null && page.height !== null && page.aspectRatioValidated,
      `QUICK_DECK_PAGE_NOT_VALIDATED_${page.pageNumber}`)
    assert(hasVisualDeckV4AspectRatio(page.width, page.height),
      `QUICK_DECK_PAGE_ASPECT_RATIO_INVALID_${page.pageNumber}`)
  }
}

async function writeJson(filename: string, value: unknown) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function runCase(config: EvaluationConfig, slideCount: number) {
  const startedAt = Date.now()
  const created = await createEvaluation(config, slideCount)
  const sse = await collectSseEvents(config, created.job.jobId, `quick-deck-real-events-${slideCount}-${randomUUID()}`)
  const job = await waitForTerminal(config, created.job.jobId)
  validateCompletedJob(job, config, slideCount)
  const [pptx, preview] = await Promise.all([
    downloadArtifact(config, job.jobId, 'pptx', job),
    downloadArtifact(config, job.jobId, 'preview', job),
  ])
  return {
    passed: true,
    slideCount,
    jobId: job.jobId,
    agentRequestId: created.agentRequestId,
    durationMs: Date.now() - startedAt,
    reportedDurationMs: job.durationMs,
    models: job.models,
    sse: { chunkCount: sse.chunkCount, eventTypes: sse.events.map((event) => event.type) },
    pages: job.pages.map((page) => ({
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      aspectRatioValidated: page.aspectRatioValidated,
      sha256: page.sha256,
    })),
    artifacts: { pptx, preview },
  }
}

export async function runQuickDeckEvaluationCanary(input: Readonly<{
  preflight: () => Promise<QuickDeckEvaluationRelease>
  runCase: (slideCount: typeof QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS[number]) => Promise<QuickDeckCanaryCaseResult>
}>) {
  const release = await input.preflight()
  const results: QuickDeckCanaryCaseResult[] = []
  for (const slideCount of QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS) {
    try {
      const result = await input.runCase(slideCount)
      results.push(result)
      if (!result.passed) break
    } catch (error) {
      results.push({ passed: false, slideCount, errorCode: safeFailureCode(error) })
      break
    }
  }
  return {
    release,
    results,
    passed: results.length === QUICK_DECK_EVALUATION_CANARY_PAGE_COUNTS.length
      && results.every((result) => result.passed),
  }
}

async function main() {
  const config = evaluationConfig()
  const canary = await runQuickDeckEvaluationCanary({
    preflight: () => readQuickDeckEvaluationReadyRelease({
      serviceUrl: config.serviceUrl,
      timeoutMs: config.timeoutMs,
      fetch,
    }),
    runCase: (slideCount) => runCase(config, slideCount),
  })
  const reportDirectory = path.join(config.outputRoot, `quick-deck-real-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
  await writeJson(path.join(reportDirectory, 'summary.json'), {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    serviceUrl: config.serviceUrl,
    release: canary.release,
    protocol: { text: 'RESPONSES_JSON_SCHEMA', image: 'IMAGE_TASK', imageRatio: '16:9' },
    results: canary.results,
  })
  console.log(JSON.stringify({ event: 'quick_deck_real_evaluation_completed', passed: canary.passed, reportDirectory, results: canary.results }))
  if (!canary.passed) process.exitCode = 1
}

if (import.meta.main) await main()

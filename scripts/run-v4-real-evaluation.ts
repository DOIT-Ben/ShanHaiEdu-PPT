import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agentEventSchema, createRunRequestSchema, type CreateRunRequest } from '../src/contracts'

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:4320'
const DEFAULT_CASE_IDS = ['01-raw-requirement', '02-planned-outline', '03-page-design'] as const
const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'NEEDS_HUMAN',
  'AWAITING_REVISION_APPROVAL',
  'PAUSED',
])

export const REQUIRED_COMPLETED_LIFECYCLE = [
  'planning.started',
  'planning.completed',
  'generation.started',
  'generation.progress',
  'generation.completed',
  'page_review.started',
  'page_review.completed',
  'deck_review.started',
  'deck_review.completed',
  'delivery.started',
  'delivery.completed',
  'run.completed',
] as const

type RunDetail = Record<string, unknown> & Readonly<{
  id: string
  status: string
  version: number
  slideCount: number
  committedBudgetUnits: number
  qualityScore: number | null
  qualityOverride: boolean
  deliveries?: Array<{ id: string }>
  issues?: unknown[]
}>

type HistoryEvent = Readonly<{
  eventId: string
  sequence: number
  type: string
}>

type RasterPageValidation = Readonly<{
  pageNumber: number
  mediaEntry: string
  sha256: string
  byteLength: number
  pictureObjects: number
  nativeTextObjects: number
}>

type EvaluationConfig = Readonly<{
  serviceUrl: string
  apiToken: string
  inputRoot: string
  outputRoot: string
  evaluationKey: string
  slideCount: number
  caseIds: readonly string[]
  pollMs: number
  planningTimeoutMs: number
  runTimeoutMs: number
  codeVersion: string | null
}>

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name}_INVALID`)
  return value
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

function evaluationConfig(): EvaluationConfig {
  const serviceUrl = new URL(process.env.V4_EVAL_SERVICE_URL?.trim() || DEFAULT_SERVICE_URL)
  if (!['127.0.0.1', 'localhost', '::1'].includes(serviceUrl.hostname)) {
    throw new Error('V4_EVAL_SERVICE_URL_MUST_BE_LOOPBACK')
  }
  const evaluationKey = requiredEnvironment('V4_EVAL_KEY')
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(evaluationKey)) throw new Error('V4_EVAL_KEY_INVALID')
  const caseIds = (process.env.V4_EVAL_CASES?.split(',') ?? [...DEFAULT_CASE_IDS])
    .map((value) => value.trim())
    .filter(Boolean)
  if (caseIds.length === 0 || new Set(caseIds).size !== caseIds.length
    || caseIds.some((value) => !/^[A-Za-z0-9._-]{1,80}$/.test(value))) {
    throw new Error('V4_EVAL_CASES_INVALID')
  }
  return {
    serviceUrl: serviceUrl.origin,
    apiToken: requiredEnvironment('V4_EVAL_API_TOKEN'),
    inputRoot: path.resolve(requiredEnvironment('V4_EVAL_INPUT_ROOT')),
    outputRoot: path.resolve(requiredEnvironment('V4_EVAL_OUTPUT_ROOT')),
    evaluationKey,
    slideCount: boundedInteger('V4_EVAL_SLIDE_COUNT', 10, 2, 50),
    caseIds,
    pollMs: boundedInteger('V4_EVAL_POLL_MS', 3_000, 250, 30_000),
    planningTimeoutMs: boundedInteger('V4_EVAL_PLANNING_TIMEOUT_MS', 15 * 60_000, 10_000, 60 * 60_000),
    runTimeoutMs: boundedInteger('V4_EVAL_RUN_TIMEOUT_MS', 90 * 60_000, 10_000, 4 * 60 * 60_000),
    codeVersion: process.env.V4_EVAL_CODE_VERSION?.trim() || null,
  }
}

function updatePageCountInstruction(instruction: string, slideCount: number) {
  const normalized = instruction
    .replace(/\d+\s*页/g, `${slideCount}页`)
    .replace(/\d+\s*page(?:s)?/gi, `${slideCount} pages`)
  return `${normalized}\n严格输出 ${slideCount} 页；不得增页、减页或把多页内容拼成一页。`
}

export function normalizeEvaluationRequest(value: unknown, slideCount: number): CreateRunRequest {
  const request = createRunRequestSchema.parse(value)
  if (request.presentationMode !== 'VISUAL_DECK_V4' || !request.visualDeckV4) {
    throw new Error('V4_EVAL_REQUEST_MODE_INVALID')
  }
  return createRunRequestSchema.parse({
    ...request,
    slideCount,
    visualDeckV4: {
      ...request.visualDeckV4,
      instruction: updatePageCountInstruction(request.visualDeckV4.instruction, slideCount),
      deckOptions: {
        ...request.visualDeckV4.deckOptions,
        length: { slideCount },
      },
    },
  })
}

export function validateLifecycle(events: readonly HistoryEvent[], status: string) {
  const monotonicSequence = events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)
  const uniqueEventIds = new Set(events.map((event) => event.eventId)).size === events.length
  let cursor = -1
  const missing: string[] = []
  for (const type of REQUIRED_COMPLETED_LIFECYCLE) {
    const index = events.findIndex((event, candidateIndex) => candidateIndex > cursor && event.type === type)
    if (index < 0) missing.push(type)
    else cursor = index
  }
  const terminalEvents = events.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
  return {
    passed: status === 'COMPLETED' && monotonicSequence && uniqueEventIds && missing.length === 0
      && terminalEvents.length === 1 && terminalEvents[0]?.type === 'run.completed',
    monotonicSequence,
    uniqueEventIds,
    missing,
    terminalEventCount: terminalEvents.length,
    terminalEventType: terminalEvents[0]?.type ?? null,
  }
}

export function validateRasterPages(pages: readonly RasterPageValidation[], slideCount: number) {
  const pageNumbers = pages.map((page) => page.pageNumber)
  const continuous = pageNumbers.length === slideCount
    && pageNumbers.every((pageNumber, index) => pageNumber === index + 1)
  const validPages = pages.filter((page) => page.pictureObjects === 1
    && page.nativeTextObjects === 0 && page.byteLength > 0)
  return {
    passed: continuous && validPages.length === slideCount,
    continuous,
    expectedPages: slideCount,
    validPages: validPages.length,
  }
}

async function ensureNewOutputRoot(outputRoot: string, inputRoot: string) {
  if (outputRoot === inputRoot || outputRoot.startsWith(`${inputRoot}${path.sep}`)) {
    throw new Error('V4_EVAL_OUTPUT_MUST_NOT_OVERLAP_INPUT')
  }
  try {
    await access(outputRoot)
    throw new Error('V4_EVAL_OUTPUT_ALREADY_EXISTS')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
}

async function writeJson(filename: string, value: unknown) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function requestHeaders(request: CreateRunRequest, apiToken: string, json = false) {
  return {
    Authorization: `Bearer ${apiToken}`,
    'X-PPT-Agent-Tenant': request.host.tenantId,
    'X-PPT-Agent-User': request.host.externalUserId,
    ...(request.host.externalProjectId ? { 'X-PPT-Agent-Project': request.host.externalProjectId } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function jsonRequest<T>(config: EvaluationConfig, request: CreateRunRequest, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${config.serviceUrl}${pathname}`, init)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`HTTP_${response.status}:${JSON.stringify(body)}`)
  return body as T
}

async function getRun(config: EvaluationConfig, request: CreateRunRequest, runId: string) {
  const body = await jsonRequest<{ data: RunDetail }>(config, request, `/v1/runs/${runId}`, {
    headers: requestHeaders(request, config.apiToken),
  })
  return body.data
}

async function waitFor(
  config: EvaluationConfig,
  request: CreateRunRequest,
  runId: string,
  predicate: (run: RunDetail) => boolean,
  timeoutMs: number,
  timeline: Array<Record<string, unknown>>,
) {
  const startedAt = Date.now()
  let previous = ''
  while (Date.now() - startedAt < timeoutMs) {
    const run = await getRun(config, request, runId)
    const fingerprint = JSON.stringify({
      status: run.status,
      version: run.version,
      committedBudgetUnits: run.committedBudgetUnits,
      issues: run.issues?.length ?? 0,
    })
    if (fingerprint !== previous) {
      const snapshot = { at: new Date().toISOString(), ...JSON.parse(fingerprint) }
      timeline.push(snapshot)
      console.log(JSON.stringify({ event: 'run_progress', runId, ...snapshot }))
      previous = fingerprint
    }
    if (predicate(run)) return run
    await Bun.sleep(config.pollMs)
  }
  throw new Error(`RUN_WAIT_TIMEOUT:${runId}`)
}

async function readEventHistory(config: EvaluationConfig, request: CreateRunRequest, runId: string) {
  const events: HistoryEvent[] = []
  let after = 0
  while (true) {
    const body = await jsonRequest<{
      data: unknown[]
      pagination: { nextAfter: number; hasMore: boolean }
    }>(config, request, `/v1/runs/${runId}/events/history?after=${after}`, {
      headers: requestHeaders(request, config.apiToken),
    })
    const parsed = body.data.map((event) => agentEventSchema.parse(event))
    events.push(...parsed)
    if (!body.pagination.hasMore) return events
    if (body.pagination.nextAfter <= after) throw new Error('EVENT_HISTORY_CURSOR_STALLED')
    after = body.pagination.nextAfter
  }
}

async function unzipEntry(pptxPath: string, entry: string) {
  const child = Bun.spawn(['unzip', '-p', pptxPath, entry], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`UNZIP_FAILED:${entry}:${stderr.trim()}`)
  return new Uint8Array(stdout)
}

async function extractAndValidatePages(caseDirectory: string, pptxPath: string, slideCount: number) {
  const pagesDirectory = path.join(caseDirectory, 'pages')
  await mkdir(pagesDirectory, { recursive: true, mode: 0o700 })
  const validation: RasterPageValidation[] = []
  for (let pageNumber = 1; pageNumber <= slideCount; pageNumber += 1) {
    const slideEntry = `ppt/slides/slide${pageNumber}.xml`
    const relationsEntry = `ppt/slides/_rels/slide${pageNumber}.xml.rels`
    const [slideBytes, relationBytes] = await Promise.all([
      unzipEntry(pptxPath, slideEntry),
      unzipEntry(pptxPath, relationsEntry),
    ])
    const slideXml = new TextDecoder().decode(slideBytes)
    const relationsXml = new TextDecoder().decode(relationBytes)
    const imageRelation = relationsXml.match(/<Relationship\b(?=[^>]*Type="[^"]*\/image")[^>]*>/)?.[0]
    const target = imageRelation?.match(/Target="([^"]+)"/)?.[1]
    if (!target) throw new Error(`PPTX_SLIDE_IMAGE_RELATION_MISSING:${pageNumber}`)
    const mediaEntry = path.posix.normalize(path.posix.join('ppt/slides', target))
    const image = await unzipEntry(pptxPath, mediaEntry)
    const extension = path.extname(mediaEntry) || '.png'
    await writeFile(path.join(pagesDirectory, `page-${String(pageNumber).padStart(2, '0')}${extension}`), image, { mode: 0o600 })
    validation.push({
      pageNumber,
      mediaEntry,
      sha256: sha256(image),
      byteLength: image.byteLength,
      pictureObjects: slideXml.match(/<p:pic>/g)?.length ?? 0,
      nativeTextObjects: slideXml.match(/<a:t>/g)?.length ?? 0,
    })
  }
  return validation
}

async function downloadDelivery(
  config: EvaluationConfig,
  request: CreateRunRequest,
  runId: string,
  deliveryId: string,
  caseDirectory: string,
) {
  const files = {
    pptx: 'presentation.pptx',
    preview: 'contact-sheet.png',
    sources: 'source-manifest.json',
  } as const
  for (const [format, filename] of Object.entries(files)) {
    const response = await fetch(
      `${config.serviceUrl}/v1/runs/${runId}/deliveries/${deliveryId}/content?format=${format}`,
      { headers: requestHeaders(request, config.apiToken) },
    )
    if (!response.ok) throw new Error(`DELIVERY_DOWNLOAD_FAILED:${format}:${response.status}`)
    await writeFile(path.join(caseDirectory, filename), new Uint8Array(await response.arrayBuffer()), { mode: 0o600 })
  }
}

async function runCase(config: EvaluationConfig, caseId: string) {
  const inputPath = path.join(config.inputRoot, caseId, 'request.json')
  const rawInput = await readFile(inputPath, 'utf8')
  const request = normalizeEvaluationRequest(JSON.parse(rawInput), config.slideCount)
  const caseDirectory = path.join(config.outputRoot, caseId)
  await mkdir(caseDirectory, { recursive: true, mode: 0o700 })
  await writeJson(path.join(caseDirectory, 'request.json'), request)
  const timeline: Array<Record<string, unknown>> = []
  const startedAt = Date.now()
  const created = await jsonRequest<{ data: RunDetail; replayed: boolean }>(config, request, '/v1/runs', {
    method: 'POST',
    headers: {
      ...requestHeaders(request, config.apiToken, true),
      'Idempotency-Key': `v4-eval-${caseId}-${config.evaluationKey}`,
    },
    body: JSON.stringify(request),
  })
  const runId = created.data.id
  await writeJson(path.join(caseDirectory, 'created.json'), created)

  const planned = await waitFor(
    config,
    request,
    runId,
    (run) => run.status === 'AWAITING_BLUEPRINT_APPROVAL' || TERMINAL_STATUSES.has(run.status),
    config.planningTimeoutMs,
    timeline,
  )
  await writeJson(path.join(caseDirectory, 'planning.json'), planned)
  if (planned.status === 'AWAITING_BLUEPRINT_APPROVAL') {
    const approved = await jsonRequest<{ data: RunDetail }>(config, request, `/v1/runs/${runId}/actions`, {
      method: 'POST',
      headers: {
        ...requestHeaders(request, config.apiToken, true),
        'Idempotency-Key': `v4-eval-${caseId}-approve-${config.evaluationKey}`,
      },
      body: JSON.stringify({ schemaVersion: '1', type: 'APPROVE_BLUEPRINT', expectedVersion: planned.version }),
    })
    await writeJson(path.join(caseDirectory, 'approval.json'), approved)
  }

  const finalRun = planned.status === 'AWAITING_BLUEPRINT_APPROVAL'
    ? await waitFor(config, request, runId, (run) => TERMINAL_STATUSES.has(run.status), config.runTimeoutMs, timeline)
    : planned
  const events = await readEventHistory(config, request, runId)
  await Promise.all([
    writeJson(path.join(caseDirectory, 'final-run.json'), finalRun),
    writeJson(path.join(caseDirectory, 'timeline.json'), timeline),
    writeJson(path.join(caseDirectory, 'events.json'), events),
  ])

  let rasterGate = { passed: false, continuous: false, expectedPages: config.slideCount, validPages: 0 }
  let pptxSha256: string | null = null
  let pptxByteLength: number | null = null
  if (finalRun.status === 'COMPLETED') {
    const deliveryId = finalRun.deliveries?.[0]?.id
    if (!deliveryId) throw new Error(`DELIVERY_MISSING:${runId}`)
    await downloadDelivery(config, request, runId, deliveryId, caseDirectory)
    const pptxPath = path.join(caseDirectory, 'presentation.pptx')
    const pptxBytes = await Bun.file(pptxPath).bytes()
    const pageValidation = await extractAndValidatePages(caseDirectory, pptxPath, config.slideCount)
    await writeJson(path.join(caseDirectory, 'pptx-validation.json'), pageValidation)
    rasterGate = validateRasterPages(pageValidation, config.slideCount)
    pptxSha256 = sha256(pptxBytes)
    pptxByteLength = pptxBytes.byteLength
  }

  const lifecycleGate = validateLifecycle(events, finalRun.status)
  const qualityGate = {
    passed: finalRun.status === 'COMPLETED'
      && finalRun.slideCount === config.slideCount
      && finalRun.qualityOverride === false
      && rasterGate.passed
      && lifecycleGate.passed,
    terminalStatus: finalRun.status,
    expectedSlideCount: config.slideCount,
    actualSlideCount: finalRun.slideCount,
    qualityScore: finalRun.qualityScore,
    qualityOverride: finalRun.qualityOverride,
    raster: rasterGate,
    lifecycle: lifecycleGate,
  }
  const result = {
    caseId,
    runId,
    status: finalRun.status,
    passed: qualityGate.passed,
    committedBudgetUnits: finalRun.committedBudgetUnits,
    issueCount: finalRun.issues?.length ?? 0,
    elapsedMs: Date.now() - startedAt,
    pptxSha256,
    pptxByteLength,
    eventCount: events.length,
  }
  await Promise.all([
    writeJson(path.join(caseDirectory, 'quality-gate.json'), qualityGate),
    writeJson(path.join(caseDirectory, 'result.json'), result),
  ])
  return result
}

async function main() {
  const config = evaluationConfig()
  await ensureNewOutputRoot(config.outputRoot, config.inputRoot)
  await writeJson(path.join(config.outputRoot, 'evaluation-manifest.json'), {
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    codeVersion: config.codeVersion,
    serviceUrl: config.serviceUrl,
    slideCount: config.slideCount,
    cases: config.caseIds,
    inputRootHash: sha256(config.inputRoot),
    policy: {
      presentationMode: 'VISUAL_DECK_V4',
      intervention: 'Approve the initial plan once; never edit prompts, revise manually, or override quality gates.',
      credentials: 'Environment only; never persisted in evaluation output.',
    },
  })
  const results: Array<Record<string, unknown>> = []
  for (const caseId of config.caseIds) {
    console.log(JSON.stringify({ event: 'case_started', caseId }))
    try {
      results.push(await runCase(config, caseId))
    } catch (error) {
      const result = {
        caseId,
        status: 'HARNESS_ERROR',
        passed: false,
        error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
      }
      await mkdir(path.join(config.outputRoot, caseId), { recursive: true, mode: 0o700 })
      await writeJson(path.join(config.outputRoot, caseId, 'result.json'), result)
      results.push(result)
    }
    await writeJson(path.join(config.outputRoot, 'summary.json'), results)
  }
  const passed = results.every((result) => result.passed === true)
  console.log(JSON.stringify({ event: 'evaluation_completed', passed, results }))
  if (!passed) process.exitCode = 1
}

if (import.meta.main) await main()

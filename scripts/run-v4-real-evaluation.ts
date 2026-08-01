import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  agentEventSchema,
  createRunRequestSchema,
  issueSummarySchema,
  type CreateRunRequest,
} from '../src/contracts'

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:4320'
const DEFAULT_CASE_IDS = ['01-raw-requirement', '02-planned-outline', '03-page-design'] as const
export const V4_EVALUATION_QUALITY_THRESHOLD = 80
const FULL_BLEED_TOLERANCE_EMU = 1_000
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
  revisionRound: number
  committedBudgetUnits: number
  qualityScore: number | null
  qualityOverride: boolean
  deliveries?: Array<{ id: string }>
  issues: unknown[]
}>

type HistoryEvent = Readonly<{
  eventId: string
  sequence: number
  type: string
  payload?: unknown
}>

type RasterPageValidation = Readonly<{
  pageNumber: number
  mediaEntry: string
  sha256: string
  byteLength: number
  pictureObjects: number
  nativeTextObjects: number
  imageXEmu: number | null
  imageYEmu: number | null
  imageWidthEmu: number | null
  imageHeightEmu: number | null
  slideWidthEmu: number
  slideHeightEmu: number
  fullBleed: boolean
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

export function validateLifecycle(events: readonly HistoryEvent[], status: string, expectedRevisionRound: number) {
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
  const stages = validateWorkflowLifecycles(events)
  const revisions = validateRevisionLifecycles(events)
  const revisionRounds = revisions.rounds
  const revisionLifecycleValid = revisions.valid
    && Number.isSafeInteger(expectedRevisionRound)
    && expectedRevisionRound >= 0
    && revisionRounds.length === expectedRevisionRound
    && revisionRounds.every((round, index) => round === index + 1)
  const terminalEvent = terminalEvents[0]
  const terminalLifecycleIsLast = terminalEvent !== undefined
    && !events.some((event) => event.sequence > terminalEvent.sequence && isLifecycleEvent(event.type))
  return {
    passed: status === 'COMPLETED' && monotonicSequence && uniqueEventIds && missing.length === 0
      && terminalEvents.length === 1 && terminalEvents[0]?.type === 'run.completed'
      && stages.valid && revisionLifecycleValid && terminalLifecycleIsLast,
    monotonicSequence,
    uniqueEventIds,
    missing,
    terminalEventCount: terminalEvents.length,
    terminalEventType: terminalEvents[0]?.type ?? null,
    terminalLifecycleIsLast,
    stageLifecyclePairs: stages.pairs,
    stageLifecycleValid: stages.valid,
    revisionLifecyclePairs: revisions.pairs,
    revisionLifecycleValid,
    revisionRounds,
  }
}

function isLifecycleEvent(type: string) {
  return /^(planning|generation|page_review|revision|deck_review|delivery)\.(started|progress|completed)$/.test(type)
    || ['run.completed', 'run.failed', 'run.cancelled'].includes(type)
}

type WorkflowStage = 'PLANNING' | 'GENERATION' | 'PAGE_REVIEW' | 'REVISION' | 'DECK_REVIEW' | 'DELIVERY'

type WorkflowLifecyclePayload = Readonly<{
  completed: number
  total: number
  pageNumbers: readonly number[]
  reason: string | null
  revisionKind: string | null
  revisionRound: number
}>

const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'PLANNING', 'GENERATION', 'PAGE_REVIEW', 'REVISION', 'DECK_REVIEW', 'DELIVERY',
]

function workflowStage(type: string): WorkflowStage | null {
  const value = type.split('.')[0]?.toUpperCase()
  return WORKFLOW_STAGES.includes(value as WorkflowStage) ? value as WorkflowStage : null
}

function workflowLifecyclePayload(value: unknown, stage: WorkflowStage): WorkflowLifecyclePayload | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Record<string, unknown>
  if (payload.stage !== stage
    || !Number.isSafeInteger(payload.completed) || !Number.isSafeInteger(payload.total)
    || (payload.completed as number) < 0 || (payload.total as number) < 1
    || (payload.completed as number) > (payload.total as number)
    || !Array.isArray(payload.pageNumbers)
    || payload.pageNumbers.some((pageNumber) => !Number.isSafeInteger(pageNumber) || pageNumber < 1)
    || new Set(payload.pageNumbers).size !== payload.pageNumbers.length
    || !(payload.reason === undefined || payload.reason === null || typeof payload.reason === 'string')
    || !(payload.revisionKind === undefined || payload.revisionKind === null || typeof payload.revisionKind === 'string')
    || !Number.isSafeInteger(payload.revisionRound) || (payload.revisionRound as number) < 0) {
    return null
  }
  if (stage === 'REVISION'
    && (typeof payload.revisionKind !== 'string' || payload.revisionKind.length === 0
      || (payload.revisionRound as number) < 1)) return null
  return {
    completed: payload.completed as number,
    total: payload.total as number,
    pageNumbers: payload.pageNumbers as number[],
    reason: typeof payload.reason === 'string' ? payload.reason : null,
    revisionKind: typeof payload.revisionKind === 'string' ? payload.revisionKind : null,
    revisionRound: payload.revisionRound as number,
  }
}

function sameWorkflowLifecycle(
  stage: WorkflowStage,
  left: WorkflowLifecyclePayload,
  right: WorkflowLifecyclePayload,
) {
  if (left.total !== right.total) return false
  if (stage === 'REVISION'
    && (left.revisionKind !== right.revisionKind || left.revisionRound !== right.revisionRound)) return false
  if (stage === 'PAGE_REVIEW' && right.reason === 'PAGE_REVIEW_REJECTED') {
    const startedPages = new Set(left.pageNumbers)
    return right.pageNumbers.length > 0 && right.pageNumbers.every((pageNumber) => startedPages.has(pageNumber))
  }
  return JSON.stringify(left.pageNumbers) === JSON.stringify(right.pageNumbers)
}

function allowedLifecycleStart(
  previousStage: WorkflowStage | null,
  previousReason: string | null,
  nextStage: WorkflowStage,
) {
  if (previousStage === null) return nextStage === 'PLANNING'
  if (previousStage === 'PLANNING') return nextStage === 'GENERATION'
  if (previousStage === 'GENERATION') return nextStage === 'PAGE_REVIEW'
  if (previousStage === 'PAGE_REVIEW') {
    return nextStage === (previousReason === 'PAGE_REVIEW_REJECTED' ? 'REVISION' : 'DECK_REVIEW')
  }
  if (previousStage === 'REVISION') return nextStage === 'PAGE_REVIEW'
  if (previousStage === 'DECK_REVIEW') {
    return nextStage === (previousReason === 'DECK_REVIEW_REJECTED' ? 'REVISION' : 'DELIVERY')
  }
  return false
}

function successfulLifecycleCompletion(stage: WorkflowStage, payload: WorkflowLifecyclePayload) {
  const allowedReasons: Record<WorkflowStage, readonly (string | null)[]> = {
    PLANNING: [null, 'USER_CONFIRMATION_REQUIRED'],
    GENERATION: [null],
    PAGE_REVIEW: [null, 'PAGE_REVIEW_REJECTED'],
    REVISION: [null],
    DECK_REVIEW: [null, 'DECK_REVIEW_REJECTED'],
    DELIVERY: [null],
  }
  return payload.completed === payload.total && allowedReasons[stage].includes(payload.reason)
}

function validateWorkflowLifecycles(events: readonly HistoryEvent[]) {
  const pairs = Object.fromEntries(WORKFLOW_STAGES.map((stage) => [stage, 0])) as Record<WorkflowStage, number>
  const progress = Object.fromEntries(WORKFLOW_STAGES.map((stage) => [stage, 0])) as Record<WorkflowStage, number>
  let active: {
    stage: WorkflowStage
    payload: WorkflowLifecyclePayload
    completed: number
    progressEvents: number
  } | null = null
  let previousStage: WorkflowStage | null = null
  let previousReason: string | null = null
  let valid = true
  for (const event of events) {
    const stage = workflowStage(event.type)
    if (!stage || !/\.(started|progress|completed)$/.test(event.type)) continue
    const payload = workflowLifecyclePayload(event.payload, stage)
    if (!payload) {
      valid = false
      continue
    }
    if (event.type.endsWith('.started')) {
      if (active || payload.completed !== 0 || !allowedLifecycleStart(previousStage, previousReason, stage)) {
        valid = false
      }
      active = { stage, payload, completed: payload.completed, progressEvents: 0 }
      continue
    }
    if (!active || active.stage !== stage
      || !sameWorkflowLifecycle(stage, active.payload, payload)
      || payload.completed < active.completed) {
      valid = false
      continue
    }
    active.completed = payload.completed
    if (event.type.endsWith('.progress')) {
      active.progressEvents += 1
      progress[stage] += 1
      continue
    }
    if (stage === 'REVISION' && active.progressEvents === 0) valid = false
    if (!successfulLifecycleCompletion(stage, payload)) valid = false
    pairs[stage] += 1
    previousStage = stage
    previousReason = payload.reason
    active = null
  }
  const exact = pairs.PLANNING === 1 && pairs.GENERATION === 1 && pairs.DELIVERY === 1
    && pairs.PAGE_REVIEW >= 1 && pairs.DECK_REVIEW >= 1 && progress.GENERATION >= 1
  return { pairs, valid: valid && active === null && exact && previousStage === 'DELIVERY' }
}

type RevisionLifecyclePayload = Readonly<{
  completed: number
  total: number
  pageNumbers: readonly number[]
  revisionKind: string
  revisionRound: number
  reason: string | null
}>

function revisionLifecyclePayload(value: unknown): RevisionLifecyclePayload | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Record<string, unknown>
  if (!Number.isSafeInteger(payload.completed) || !Number.isSafeInteger(payload.total)
    || (payload.completed as number) < 0 || (payload.total as number) < 1
    || (payload.completed as number) > (payload.total as number)
    || !Array.isArray(payload.pageNumbers)
    || payload.pageNumbers.some((pageNumber) => !Number.isSafeInteger(pageNumber) || pageNumber < 1)
    || new Set(payload.pageNumbers).size !== payload.pageNumbers.length
    || typeof payload.revisionKind !== 'string' || payload.revisionKind.length === 0
    || !Number.isSafeInteger(payload.revisionRound) || (payload.revisionRound as number) < 1
    || !(payload.reason === undefined || payload.reason === null || typeof payload.reason === 'string')) {
    return null
  }
  return {
    completed: payload.completed as number,
    total: payload.total as number,
    pageNumbers: payload.pageNumbers as number[],
    revisionKind: payload.revisionKind,
    revisionRound: payload.revisionRound as number,
    reason: typeof payload.reason === 'string' ? payload.reason : null,
  }
}

function sameRevisionLifecycle(left: RevisionLifecyclePayload, right: RevisionLifecyclePayload) {
  return left.total === right.total
    && left.revisionKind === right.revisionKind
    && left.revisionRound === right.revisionRound
    && JSON.stringify(left.pageNumbers) === JSON.stringify(right.pageNumbers)
}

function validateRevisionLifecycles(events: readonly HistoryEvent[]) {
  let active: { payload: RevisionLifecyclePayload; completed: number; progressEvents: number } | null = null
  let pairs = 0
  const rounds: number[] = []
  let valid = true
  for (const event of events) {
    if (!['revision.started', 'revision.progress', 'revision.completed'].includes(event.type)) continue
    const payload = revisionLifecyclePayload(event.payload)
    if (!payload) {
      valid = false
      continue
    }
    if (event.type === 'revision.started') {
      if (active || payload.completed !== 0) valid = false
      active = { payload, completed: payload.completed, progressEvents: 0 }
      continue
    }
    if (!active || !sameRevisionLifecycle(active.payload, payload) || payload.completed < active.completed) {
      valid = false
      continue
    }
    active.completed = payload.completed
    if (event.type === 'revision.progress') active.progressEvents += 1
    if (event.type === 'revision.completed') {
      if (payload.reason !== null || payload.completed !== payload.total || active.progressEvents === 0) valid = false
      pairs += 1
      rounds.push(payload.revisionRound)
      active = null
    }
  }
  return { pairs, rounds, valid: valid && active === null }
}

export function validateRasterPages(pages: readonly RasterPageValidation[], slideCount: number) {
  const pageNumbers = pages.map((page) => page.pageNumber)
  const continuous = pageNumbers.length === slideCount
    && pageNumbers.every((pageNumber, index) => pageNumber === index + 1)
  const validPages = pages.filter((page) => page.pictureObjects === 1
    && page.nativeTextObjects === 0 && page.byteLength > 0 && page.fullBleed)
  return {
    passed: continuous && validPages.length === slideCount,
    continuous,
    expectedPages: slideCount,
    validPages: validPages.length,
  }
}

export function presentationSlideEntries(presentationXml: string, relationsXml: string) {
  const slideIds = xmlAttributeList(presentationXml, 'p:sldId')
  if (slideIds.length === 0) throw new Error('PPTX_PRESENTATION_SLIDE_LIST_MISSING')
  const relationshipIds = new Set<string>()
  return slideIds.map((slideId, index) => {
    const relationshipId = slideId.get('r:id')
    if (!relationshipId || relationshipIds.has(relationshipId)) {
      throw new Error('PPTX_PRESENTATION_SLIDE_RELATION_INVALID')
    }
    relationshipIds.add(relationshipId)
    const relationship = requireRelationship(relationsXml, relationshipId, 'slide')
    const slideEntry = packageEntry('ppt', relationship.get('Target'))
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(slideEntry)) {
      throw new Error('PPTX_PRESENTATION_SLIDE_TARGET_INVALID')
    }
    return { pageNumber: index + 1, slideEntry }
  })
}

export function referencedSlideImageEntry(
  slideXml: string,
  relationsXml: string,
  pageNumber: number,
  slideEntry = 'ppt/slides/slide1.xml',
) {
  const pictures = slideXml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []
  if (pictures.length !== 1) throw new Error(`PPTX_SLIDE_PICTURE_COUNT_INVALID:${pageNumber}`)
  const relationshipId = xmlAttributes(pictures[0]!, 'a:blip')?.get('r:embed')
  if (!relationshipId) throw new Error(`PPTX_SLIDE_IMAGE_EMBED_MISSING:${pageNumber}`)
  const relationship = requireRelationship(relationsXml, relationshipId, 'image')
  const mediaEntry = packageEntry(path.posix.dirname(slideEntry), relationship.get('Target'))
  if (!/^ppt\/media\/[^/]+$/.test(mediaEntry)) {
    throw new Error(`PPTX_SLIDE_IMAGE_TARGET_INVALID:${pageNumber}`)
  }
  return mediaEntry
}

export function validateQualityGate(
  run: Pick<RunDetail, 'status' | 'slideCount' | 'qualityScore' | 'qualityOverride'> & { issues?: unknown },
  raster: ReturnType<typeof validateRasterPages>,
  lifecycle: ReturnType<typeof validateLifecycle>,
  slideCount: number,
) {
  const rawIssues = run.issues
  const issuesPresent = Array.isArray(rawIssues)
  const parsedIssues = issuesPresent ? rawIssues.map((issue) => issueSummarySchema.safeParse(issue)) : []
  const issuesValid = issuesPresent && parsedIssues.every((result) => result.success)
  const blockingOpenIssues = parsedIssues.filter((result) => result.success
    && result.data.status === 'OPEN'
    && (result.data.severity === 'CRITICAL' || result.data.category === 'FACTUAL_RISK')).length
  const qualityScorePassed = typeof run.qualityScore === 'number'
    && run.qualityScore >= V4_EVALUATION_QUALITY_THRESHOLD
  return {
    passed: run.status === 'COMPLETED'
      && run.slideCount === slideCount
      && qualityScorePassed
      && run.qualityOverride === false
      && issuesValid
      && blockingOpenIssues === 0
      && raster.passed
      && lifecycle.passed,
    terminalStatus: run.status,
    expectedSlideCount: slideCount,
    actualSlideCount: run.slideCount,
    qualityScore: run.qualityScore,
    qualityThreshold: V4_EVALUATION_QUALITY_THRESHOLD,
    qualityScorePassed,
    qualityOverride: run.qualityOverride,
    issuesPresent,
    issuesValid,
    blockingOpenIssues,
    raster,
    lifecycle,
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

function parseXmlAttributes(raw: string) {
  const attributes = new Map<string, string>()
  for (const match of raw.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g)) {
    attributes.set(match[1]!, match[2]!)
  }
  return attributes
}

function xmlAttributeList(xml: string, tagName: string) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...xml.matchAll(new RegExp(`<${escaped}\\b([^>]*)>`, 'g'))]
    .map((match) => parseXmlAttributes(match[1] ?? ''))
}

function xmlAttributes(xml: string, tagName: string) {
  return xmlAttributeList(xml, tagName)[0] ?? null
}

function requireRelationship(relationsXml: string, relationshipId: string, type: 'slide' | 'image') {
  const matches = xmlAttributeList(relationsXml, 'Relationship')
    .filter((relationship) => relationship.get('Id') === relationshipId)
  const relationship = matches.length === 1 ? matches[0]! : null
  if (!relationship
    || !relationship.get('Type')?.endsWith(`/${type}`)
    || !relationship.get('Target')
    || relationship.get('TargetMode') === 'External') {
    throw new Error(`PPTX_${type.toUpperCase()}_RELATION_INVALID`)
  }
  return relationship
}

function packageEntry(baseDirectory: string, target: string | undefined) {
  if (!target) throw new Error('PPTX_RELATION_TARGET_MISSING')
  const normalizedTarget = target.startsWith('/') ? target.slice(1) : target
  return path.posix.normalize(target.startsWith('/')
    ? normalizedTarget
    : path.posix.join(baseDirectory, normalizedTarget))
}

function integerAttribute(attributes: Map<string, string> | null, name: string) {
  const value = Number(attributes?.get(name))
  return Number.isSafeInteger(value) ? value : null
}

function fullPagePictureGeometry(slideXml: string, slideWidthEmu: number, slideHeightEmu: number) {
  const pictures = slideXml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []
  const shapeProperties = pictures[0]?.match(/<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/)?.[1] ?? ''
  const imageXEmu = integerAttribute(xmlAttributes(shapeProperties, 'a:off'), 'x')
  const imageYEmu = integerAttribute(xmlAttributes(shapeProperties, 'a:off'), 'y')
  const imageWidthEmu = integerAttribute(xmlAttributes(shapeProperties, 'a:ext'), 'cx')
  const imageHeightEmu = integerAttribute(xmlAttributes(shapeProperties, 'a:ext'), 'cy')
  const withinTolerance = (actual: number | null, expected: number) =>
    actual !== null && Math.abs(actual - expected) <= FULL_BLEED_TOLERANCE_EMU
  return {
    pictureObjects: pictures.length,
    imageXEmu,
    imageYEmu,
    imageWidthEmu,
    imageHeightEmu,
    fullBleed: pictures.length === 1
      && withinTolerance(imageXEmu, 0)
      && withinTolerance(imageYEmu, 0)
      && withinTolerance(imageWidthEmu, slideWidthEmu)
      && withinTolerance(imageHeightEmu, slideHeightEmu),
  }
}

export async function extractAndValidatePages(caseDirectory: string, pptxPath: string) {
  const pagesDirectory = path.join(caseDirectory, 'pages')
  await mkdir(pagesDirectory, { recursive: true, mode: 0o700 })
  const [presentationBytes, presentationRelationBytes] = await Promise.all([
    unzipEntry(pptxPath, 'ppt/presentation.xml'),
    unzipEntry(pptxPath, 'ppt/_rels/presentation.xml.rels'),
  ])
  const presentationXml = new TextDecoder().decode(presentationBytes)
  const presentationRelationsXml = new TextDecoder().decode(presentationRelationBytes)
  const slideSize = xmlAttributes(presentationXml, 'p:sldSz')
  const slideWidthEmu = integerAttribute(slideSize, 'cx')
  const slideHeightEmu = integerAttribute(slideSize, 'cy')
  if (!slideWidthEmu || !slideHeightEmu) throw new Error('PPTX_SLIDE_SIZE_INVALID')
  const validation: RasterPageValidation[] = []
  for (const { pageNumber, slideEntry } of presentationSlideEntries(presentationXml, presentationRelationsXml)) {
    const relationsEntry = path.posix.join(
      path.posix.dirname(slideEntry),
      '_rels',
      `${path.posix.basename(slideEntry)}.rels`,
    )
    const [slideBytes, relationBytes] = await Promise.all([
      unzipEntry(pptxPath, slideEntry),
      unzipEntry(pptxPath, relationsEntry),
    ])
    const slideXml = new TextDecoder().decode(slideBytes)
    const relationsXml = new TextDecoder().decode(relationBytes)
    const mediaEntry = referencedSlideImageEntry(slideXml, relationsXml, pageNumber, slideEntry)
    const image = await unzipEntry(pptxPath, mediaEntry)
    const extension = path.extname(mediaEntry) || '.png'
    await writeFile(path.join(pagesDirectory, `page-${String(pageNumber).padStart(2, '0')}${extension}`), image, { mode: 0o600 })
    const geometry = fullPagePictureGeometry(slideXml, slideWidthEmu, slideHeightEmu)
    validation.push({
      pageNumber,
      mediaEntry,
      sha256: sha256(image),
      byteLength: image.byteLength,
      pictureObjects: geometry.pictureObjects,
      nativeTextObjects: slideXml.match(/<a:t>/g)?.length ?? 0,
      imageXEmu: geometry.imageXEmu,
      imageYEmu: geometry.imageYEmu,
      imageWidthEmu: geometry.imageWidthEmu,
      imageHeightEmu: geometry.imageHeightEmu,
      slideWidthEmu,
      slideHeightEmu,
      fullBleed: geometry.fullBleed,
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
    const pageValidation = await extractAndValidatePages(caseDirectory, pptxPath)
    await writeJson(path.join(caseDirectory, 'pptx-validation.json'), pageValidation)
    rasterGate = validateRasterPages(pageValidation, config.slideCount)
    pptxSha256 = sha256(pptxBytes)
    pptxByteLength = pptxBytes.byteLength
  }

  const lifecycleGate = validateLifecycle(events, finalRun.status, finalRun.revisionRound)
  const qualityGate = validateQualityGate(finalRun, rasterGate, lifecycleGate, config.slideCount)
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

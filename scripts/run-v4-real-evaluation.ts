import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import {
  agentEventSchema,
  createRunRequestSchema,
  deliveryAvailabilitySchema,
  issueSummarySchema,
  runSnapshotSchema,
  type CreateRunRequest,
} from '../src/contracts'
import { publicDeliveryRecordSchema, type DeliveryRecord } from '../src/presentation-contracts'
import { hasExactVisualDeckV4AspectRatio } from '../src/core/image-aspect-policy'
import { capabilitiesEnvelopeSchema } from '../src/run-query-contracts'

export const V4_EVALUATION_DEFAULT_SERVICE_URL = 'http://127.0.0.1:4310'
export const V4_EVALUATION_CANARY_PAGE_COUNTS = [1, 3, 10] as const
const DEFAULT_CASE_IDS = ['01-raw-requirement', '02-planned-outline', '03-page-design'] as const
export const V4_EVALUATION_QUALITY_THRESHOLD = 80
const FULL_BLEED_TOLERANCE_EMU = 1_000
const PRODUCTION_RUNTIME_ROOT = '/opt/ppt-agent'
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
  schemaVersion: '1'
  id: string
  status: string
  version: number
  slideCount: number
  revisionRound: number
  committedBudgetUnits: number
  qualityScore: number | null
  qualityOverride: boolean
  deliveries?: unknown[]
  deliveryAvailability?: unknown
  issues?: unknown[]
  presentationMode?: string
  imageModel?: string
  visualDeckV4?: unknown
  release?: unknown
  error?: unknown
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
  imageWidthPx: number | null
  imageHeightPx: number | null
  imageRelativeAspectError: number | null
  imageAspectRatioValidated: boolean
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
  canaryPageCounts: typeof V4_EVALUATION_CANARY_PAGE_COUNTS
  caseIds: readonly string[]
  pollMs: number
  readyTimeoutMs: number
  planningTimeoutMs: number
  runTimeoutMs: number
  expectedRelease: Readonly<{
    gitSha: string | null
    releaseId: string | null
  }>
}>

type FetchPort = (input: string, init?: RequestInit) => Promise<Response>

export type V4EvaluationRelease = Readonly<{
  softwareVersion: string
  gitSha: string
  releaseId: string
}>

export type V4EvaluationTarget = Readonly<{
  service: 'ppt-agent'
  release: V4EvaluationRelease
  runtimeMode: 'GATEWAY'
  textGeneration: Readonly<{
    protocol: 'RESPONSES_JSON_SCHEMA'
    streaming: true
  }>
  models: Readonly<{
    text: string
    vision: string
    image: string
  }>
  imageGeneration: Readonly<{
    asynchronous: true
    protocol: 'IMAGE_TASK'
    validatesActualPixels: true
  }>
}>

type V4EvaluationCanaryCaseResult = Readonly<{
  passed: boolean
  slideCount: typeof V4_EVALUATION_CANARY_PAGE_COUNTS[number]
  caseId: string
  errorCode?: string
}>

export type V4EvaluationInput = Readonly<{
  slideCount: typeof V4_EVALUATION_CANARY_PAGE_COUNTS[number]
  caseId: string
  request: CreateRunRequest
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

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

function optionalReleaseField(name: string) {
  const value = process.env[name]?.trim() || null
  if (value !== null && !validReleaseField(value)) throw new Error(`${name}_INVALID`)
  return value
}

export function resolveV4EvaluationCanaryPageCounts(value: string | undefined) {
  const values = (value?.trim() || V4_EVALUATION_CANARY_PAGE_COUNTS.join(','))
    .split(',')
    .map((item) => Number(item.trim()))
  if (values.length !== V4_EVALUATION_CANARY_PAGE_COUNTS.length
    || !values.every((count, index) => count === V4_EVALUATION_CANARY_PAGE_COUNTS[index])) {
    throw new Error('V4_EVAL_PAGE_COUNTS_INVALID')
  }
  return V4_EVALUATION_CANARY_PAGE_COUNTS
}

export function v4EvaluationIdempotencyKey(
  slideCount: typeof V4_EVALUATION_CANARY_PAGE_COUNTS[number],
  caseId: string,
  batchKey: string,
) {
  return `v4-eval-${slideCount}-${caseId}-${sha256(batchKey).slice(0, 32)}`
}

function evaluationConfig(): EvaluationConfig {
  const serviceUrl = new URL(process.env.V4_EVAL_SERVICE_URL?.trim() || V4_EVALUATION_DEFAULT_SERVICE_URL)
  if (!['127.0.0.1', 'localhost', '::1'].includes(serviceUrl.hostname)) {
    throw new Error('V4_EVAL_SERVICE_URL_MUST_BE_LOOPBACK')
  }
  if (process.env.V4_EVAL_SLIDE_COUNT?.trim()) throw new Error('V4_EVAL_SLIDE_COUNT_UNSUPPORTED')
  if (process.env.V4_EVAL_CODE_VERSION?.trim()) throw new Error('V4_EVAL_CODE_VERSION_UNSUPPORTED')
  const evaluationKey = requiredEnvironment('V4_EVAL_KEY')
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(evaluationKey)) throw new Error('V4_EVAL_KEY_INVALID')
  const caseIds = (process.env.V4_EVAL_CASES?.split(',') ?? [...DEFAULT_CASE_IDS])
    .map((value) => value.trim())
    .filter(Boolean)
  if (caseIds.length === 0 || caseIds.length > DEFAULT_CASE_IDS.length || new Set(caseIds).size !== caseIds.length
    || caseIds.some((value) => !/^[A-Za-z0-9._-]{1,80}$/.test(value))) {
    throw new Error('V4_EVAL_CASES_INVALID')
  }
  const expectedRelease = {
    gitSha: optionalReleaseField('V4_EVAL_EXPECTED_GIT_SHA'),
    releaseId: optionalReleaseField('V4_EVAL_EXPECTED_RELEASE_ID'),
  }
  if (!expectedRelease.gitSha && !expectedRelease.releaseId) {
    throw new Error('V4_EVAL_EXPECTED_RELEASE_REQUIRED')
  }
  return {
    serviceUrl: serviceUrl.origin,
    apiToken: requiredEnvironment('V4_EVAL_API_TOKEN'),
    inputRoot: path.resolve(requiredEnvironment('V4_EVAL_INPUT_ROOT')),
    outputRoot: path.resolve(requiredEnvironment('V4_EVAL_OUTPUT_ROOT')),
    evaluationKey,
    canaryPageCounts: resolveV4EvaluationCanaryPageCounts(process.env.V4_EVAL_PAGE_COUNTS),
    caseIds,
    pollMs: boundedInteger('V4_EVAL_POLL_MS', 3_000, 250, 30_000),
    readyTimeoutMs: boundedInteger('V4_EVAL_READY_TIMEOUT_MS', 10_000, 1_000, 60_000),
    planningTimeoutMs: boundedInteger('V4_EVAL_PLANNING_TIMEOUT_MS', 15 * 60_000, 10_000, 60 * 60_000),
    runTimeoutMs: boundedInteger('V4_EVAL_RUN_TIMEOUT_MS', 90 * 60_000, 10_000, 4 * 60 * 60_000),
    expectedRelease,
  }
}

export function evaluationInputContentHash(files: readonly Readonly<{ caseId: string; bytes: Uint8Array }>[]) {
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file.caseId)
    digest.update('\0')
    digest.update(file.bytes)
    digest.update('\0')
  }
  return digest.digest('hex')
}

function evaluationRequestPath(inputRoot: string, slideCount: number, caseId: string) {
  return path.join(inputRoot, String(slideCount), caseId, 'request.json')
}

export async function loadV4EvaluationInputs(input: Readonly<{
  inputRoot: string
  caseIds: readonly string[]
  pageCounts: typeof V4_EVALUATION_CANARY_PAGE_COUNTS
}>) {
  const inputs = await Promise.all(input.pageCounts.flatMap((slideCount) => input.caseIds.map(async (caseId) => ({
    slideCount,
    caseId,
    request: normalizeEvaluationRequest(
      JSON.parse(await readFile(evaluationRequestPath(input.inputRoot, slideCount, caseId), 'utf8')),
      slideCount,
    ),
  }))))
  assert(inputs.length > 0, 'V4_EVAL_INPUTS_EMPTY')
  const imageModel = inputs[0]!.request.imageModel
  assert(inputs.every((entry) => entry.request.imageModel === imageModel), 'V4_EVAL_IMAGE_MODEL_MISMATCH')
  return inputs satisfies readonly V4EvaluationInput[]
}

function evaluationExecutedRequestHash(inputs: readonly V4EvaluationInput[]) {
  return evaluationInputContentHash(inputs.map((input) => ({
    caseId: `${input.slideCount}/${input.caseId}`,
    bytes: new TextEncoder().encode(JSON.stringify(input.request)),
  })))
}

function evaluationInputFor(
  inputs: readonly V4EvaluationInput[],
  slideCount: typeof V4_EVALUATION_CANARY_PAGE_COUNTS[number],
  caseId: string,
) {
  const input = inputs.find((candidate) => candidate.slideCount === slideCount && candidate.caseId === caseId)
  assert(input, 'V4_EVAL_INPUT_NOT_PREFLIGHTED')
  return input
}

export function normalizeEvaluationRequest(value: unknown, slideCount: number): CreateRunRequest {
  const request = createRunRequestSchema.parse(value)
  if (request.presentationMode !== 'VISUAL_DECK_V4' || !request.visualDeckV4) {
    throw new Error('V4_EVAL_REQUEST_MODE_INVALID')
  }
  const length = request.visualDeckV4.deckOptions.length
  if (request.slideCount !== slideCount || typeof length !== 'object' || length.slideCount !== slideCount) {
    throw new Error('V4_EVAL_SLIDE_COUNT_MISMATCH')
  }
  return request
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
    PLANNING: [null],
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
    && page.nativeTextObjects === 0
    && page.byteLength > 0
    && page.imageAspectRatioValidated
    && page.fullBleed)
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

export function assertV4EvaluationRoots(inputRoot: string, outputRoot: string) {
  const productionRoot = path.resolve(PRODUCTION_RUNTIME_ROOT)
  if (inputRoot === productionRoot || inputRoot.startsWith(`${productionRoot}${path.sep}`)) {
    throw new Error('V4_EVAL_INPUT_PRODUCTION_PATH_FORBIDDEN')
  }
  if (outputRoot === productionRoot || outputRoot.startsWith(`${productionRoot}${path.sep}`)) {
    throw new Error('V4_EVAL_OUTPUT_PRODUCTION_PATH_FORBIDDEN')
  }
  if (outputRoot === inputRoot || outputRoot.startsWith(`${inputRoot}${path.sep}`)) {
    throw new Error('V4_EVAL_OUTPUT_MUST_NOT_OVERLAP_INPUT')
  }
}

async function ensureNewOutputRoot(outputRoot: string, inputRoot: string) {
  assertV4EvaluationRoots(inputRoot, outputRoot)
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

function jsonHash(value: unknown) {
  return sha256(JSON.stringify(value))
}

export function redactedEvaluationRequest(request: CreateRunRequest) {
  return {
    schemaVersion: request.schemaVersion,
    presentationMode: request.presentationMode,
    slideCount: request.slideCount,
    imageModel: request.imageModel,
    automationLevel: request.automationLevel,
    budgetUnits: request.budgetUnits,
    maxRevisionRounds: request.maxRevisionRounds,
    source: { kind: request.source.kind, sha256: jsonHash(request.source) },
    contentHashes: {
      visualDirection: jsonHash(request.visualDirection),
      targetAudience: request.targetAudience ? jsonHash(request.targetAudience) : null,
      presentationGoal: request.presentationGoal ? jsonHash(request.presentationGoal) : null,
      visualDeckV4: request.visualDeckV4 ? jsonHash(request.visualDeckV4) : null,
    },
  }
}

function redactedRunEvidence(run: RunDetail) {
  const rawIssues = Array.isArray(run.issues) ? run.issues : null
  const issues = (rawIssues ?? []).flatMap((issue) => {
    const parsed = issueSummarySchema.safeParse(issue)
    return parsed.success
      ? [{
          id: parsed.data.id,
          category: parsed.data.category,
          severity: parsed.data.severity,
          status: parsed.data.status,
          repairDomain: parsed.data.repairDomain ?? null,
        }]
      : []
  })
  const error = run.error && typeof run.error === 'object' && !Array.isArray(run.error)
    ? (run.error as Readonly<Record<string, unknown>>).code
    : null
  return {
    schemaVersion: run.schemaVersion,
    id: run.id,
    status: run.status,
    version: run.version,
    presentationMode: run.presentationMode ?? null,
    imageModel: run.imageModel ?? null,
    slideCount: run.slideCount,
    revisionRound: run.revisionRound,
    committedBudgetUnits: run.committedBudgetUnits,
    qualityScore: run.qualityScore,
    qualityOverride: run.qualityOverride,
    release: run.release ?? null,
    visualDeckV4ConfigurationHash: run.visualDeckV4 ? jsonHash(run.visualDeckV4) : null,
    deliveryAvailability: run.deliveryAvailability ?? null,
    issuesPresent: rawIssues !== null,
    issues,
    errorCode: typeof error === 'string' ? error : null,
  }
}

function redactedEventHistory(events: readonly HistoryEvent[]) {
  return events.map((event) => ({ eventId: event.eventId, sequence: event.sequence, type: event.type }))
}

export function validateCreatedV4RunIdentity(
  run: Readonly<{ slideCount: number; presentationMode?: unknown; imageModel?: unknown }>,
  request: CreateRunRequest,
  slideCount: typeof V4_EVALUATION_CANARY_PAGE_COUNTS[number],
) {
  assert(run.slideCount === slideCount, 'V4_EVAL_CREATED_SLIDE_COUNT_INVALID')
  assert(run.presentationMode === 'VISUAL_DECK_V4', 'V4_EVAL_CREATED_PRESENTATION_MODE_INVALID')
  assert(run.imageModel === request.imageModel, 'V4_EVAL_CREATED_IMAGE_MODEL_INVALID')
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

function validReleaseField(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
}

function requireHealthyV4RuntimeModel(input: Readonly<{
  role: 'TEXT' | 'VISION' | 'IMAGE'
  models: readonly string[]
  availability: readonly Readonly<{ model: string; state: string }>[]
  selectedModel?: string
}>) {
  const model = input.selectedModel ?? (input.models.length === 1 ? input.models[0] ?? null : null)
  assert(model !== null, `V4_EVAL_${input.role}_MODEL_COUNT_INVALID`)
  assert(input.models.includes(model), `V4_EVAL_${input.role}_MODEL_UNAVAILABLE`)
  const availability = input.availability.find((entry) => entry.model === model)
  assert(availability?.state === 'HEALTHY', `V4_EVAL_${input.role}_MODEL_UNAVAILABLE`)
  return model
}

function releasedV4EvaluationIdentity(value: unknown): V4EvaluationRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('V4_EVAL_READY_CONTRACT_INVALID')
  }
  const record = value as Readonly<Record<string, unknown>>
  if (record.status !== 'READY' || !record.release || typeof record.release !== 'object' || Array.isArray(record.release)) {
    throw new Error('V4_EVAL_READY_CONTRACT_INVALID')
  }
  const release = record.release as Readonly<Record<string, unknown>>
  const { softwareVersion, gitSha, releaseId } = release
  if (!validReleaseField(softwareVersion)
    || !validReleaseField(gitSha)
    || !validReleaseField(releaseId)
    || ['development', 'unknown', 'unversioned'].includes(gitSha)
    || ['development', 'unknown', 'unversioned'].includes(releaseId)) {
    throw new Error('V4_EVAL_READY_RELEASE_INVALID')
  }
  return { softwareVersion, gitSha, releaseId }
}

/**
 * Refuse to spend on a service unless its worker is ready, its release is
 * explicit, and the authenticated public capability contract proves that it
 * is the gateway-backed V4 service rather than a local mock or V2 facade.
 */
export async function readV4EvaluationGatewayTarget(input: Readonly<{
  serviceUrl: string
  apiToken: string
  request: CreateRunRequest
  timeoutMs: number
  fetch: FetchPort
  expectedRelease?: Readonly<{
    gitSha: string | null
    releaseId: string | null
  }>
}>): Promise<V4EvaluationTarget> {
  const readiness = await input.fetch(`${input.serviceUrl}/health/ready`, {
    headers: { 'X-Request-ID': `v4-real-ready-${randomUUID()}` },
    signal: AbortSignal.timeout(input.timeoutMs),
  })
  const readinessBody = await readiness.json().catch(() => null)
  assert(readiness.status === 200, `V4_EVAL_READY_HTTP_${readiness.status}`)
  assert(readinessBody && typeof readinessBody === 'object'
    && !Array.isArray(readinessBody)
    && (readinessBody as Readonly<Record<string, unknown>>).service === 'ppt-agent',
  'V4_EVAL_READY_SERVICE_INVALID')
  const release = releasedV4EvaluationIdentity(readinessBody)
  assert(!input.expectedRelease?.gitSha || release.gitSha === input.expectedRelease.gitSha,
    'V4_EVAL_READY_GIT_SHA_MISMATCH')
  assert(!input.expectedRelease?.releaseId || release.releaseId === input.expectedRelease.releaseId,
    'V4_EVAL_READY_RELEASE_ID_MISMATCH')

  const capabilities = await input.fetch(`${input.serviceUrl}/v1/capabilities`, {
    headers: requestHeaders(input.request, input.apiToken),
    signal: AbortSignal.timeout(input.timeoutMs),
  })
  const capabilitiesBody = await capabilities.json().catch(() => null)
  assert(capabilities.status === 200, `V4_EVAL_CAPABILITIES_HTTP_${capabilities.status}`)
  const parsedCapabilities = capabilitiesEnvelopeSchema.safeParse(capabilitiesBody)
  assert(parsedCapabilities.success, 'V4_EVAL_CAPABILITIES_CONTRACT_INVALID')
  const capability = parsedCapabilities.data.data
  assert(capability.runtimeMode === 'GATEWAY', 'V4_EVAL_RUNTIME_MODE_INVALID')
  assert(capability.visualDeckV4.textGeneration?.protocol === 'RESPONSES_JSON_SCHEMA'
    && capability.visualDeckV4.textGeneration.streaming,
  'V4_EVAL_TEXT_PROTOCOL_INVALID')
  assert(capability.visualDeckV4.imageGeneration.asynchronous
    && capability.visualDeckV4.imageGeneration.protocol === 'IMAGE_TASK'
    && capability.visualDeckV4.imageGeneration.validatesActualPixels,
  'V4_EVAL_IMAGE_PROTOCOL_INVALID')
  assert(capability.visualDeckV4.models.text.length > 0
    && capability.visualDeckV4.models.vision.length > 0
    && capability.visualDeckV4.models.image.includes(input.request.imageModel),
  'V4_EVAL_MODELS_UNAVAILABLE')
  const availability = capability.visualDeckV4.modelAvailability
  assert(availability, 'V4_EVAL_MODEL_AVAILABILITY_MISSING')
  const textModel = requireHealthyV4RuntimeModel({
    role: 'TEXT',
    models: capability.visualDeckV4.models.text,
    availability: availability.text,
  })
  const visionModel = requireHealthyV4RuntimeModel({
    role: 'VISION',
    models: capability.visualDeckV4.models.vision,
    availability: availability.vision,
  })
  const imageModel = requireHealthyV4RuntimeModel({
    role: 'IMAGE',
    models: capability.visualDeckV4.models.image,
    availability: availability.image,
    selectedModel: input.request.imageModel,
  })
  return {
    service: 'ppt-agent',
    release,
    runtimeMode: 'GATEWAY',
    textGeneration: { protocol: 'RESPONSES_JSON_SCHEMA', streaming: true },
    models: { text: textModel, vision: visionModel, image: imageModel },
    imageGeneration: {
      asynchronous: true,
      protocol: 'IMAGE_TASK',
      validatesActualPixels: true,
    },
  }
}

function safeFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return /^[A-Z0-9_:.-]{1,160}$/.test(message) ? message : 'V4_REAL_EVALUATION_FAILED'
}

async function jsonRequest<T>(
  config: EvaluationConfig,
  request: CreateRunRequest,
  pathname: string,
  init: RequestInit = {},
  fetchPort: FetchPort = fetch,
) {
  const response = await fetchPort(`${config.serviceUrl}${pathname}`, init)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`HTTP_${response.status}:${JSON.stringify(body)}`)
  return body as T
}

async function getRun(config: EvaluationConfig, request: CreateRunRequest, runId: string, fetchPort: FetchPort = fetch) {
  const body = await jsonRequest<{ data: RunDetail }>(config, request, `/v1/runs/${runId}`, {
    headers: requestHeaders(request, config.apiToken),
  }, fetchPort)
  return runSnapshotSchema.parse(body.data) as RunDetail
}

async function waitFor(
  config: EvaluationConfig,
  request: CreateRunRequest,
  runId: string,
  predicate: (run: RunDetail) => boolean,
  timeoutMs: number,
  timeline: Array<Record<string, unknown>>,
  timeoutMessage: () => string = () => `RUN_WAIT_TIMEOUT:${runId}`,
  fetchPort: FetchPort = fetch,
) {
  const startedAt = Date.now()
  let previous = ''
  while (Date.now() - startedAt < timeoutMs) {
    const run = await getRun(config, request, runId, fetchPort)
    const fingerprint = JSON.stringify({
      status: run.status,
      version: run.version,
      committedBudgetUnits: run.committedBudgetUnits,
      issues: run.issues?.length ?? 0,
      deliveryAvailability: run.deliveryAvailability ?? null,
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
  throw new Error(timeoutMessage())
}

export function deliveryAvailabilityWaitState(run: RunDetail) {
  if (run.status !== 'COMPLETED') {
    return { state: 'TERMINAL' as const, reason: `RUN_${run.status}` }
  }
  const availability = deliveryAvailabilitySchema.safeParse(run.deliveryAvailability)
  if (!availability.success) {
    return { state: 'WAIT' as const, reason: 'DELIVERY_AVAILABILITY_CONTRACT_INVALID' }
  }
  if (availability.data.state === 'AVAILABLE') {
    return { state: 'AVAILABLE' as const, reason: null }
  }
  return { state: 'WAIT' as const, reason: availability.data.reason }
}

export function requireAvailableDelivery(run: RunDetail) {
  if (run.status !== 'COMPLETED') throw new Error(`DELIVERY_RUN_NOT_COMPLETED:${run.status}`)
  const availability = deliveryAvailabilitySchema.parse(run.deliveryAvailability)
  if (availability.state !== 'AVAILABLE') {
    throw new Error(`DELIVERY_UNAVAILABLE:${availability.reason}`)
  }
  const deliveries = (run.deliveries ?? []).map((delivery) => publicDeliveryRecordSchema.parse(delivery))
  if (deliveries.length !== 1) throw new Error('DELIVERY_PUBLIC_CARDINALITY_INVALID')
  const delivery = deliveries[0]!
  if (delivery.id !== availability.deliveryId || delivery.runId !== run.id) {
    throw new Error('DELIVERY_PUBLIC_IDENTITY_MISMATCH')
  }
  return delivery
}

async function readEventHistory(
  config: EvaluationConfig,
  request: CreateRunRequest,
  runId: string,
  fetchPort: FetchPort = fetch,
) {
  const events: HistoryEvent[] = []
  let after = 0
  while (true) {
    const body = await jsonRequest<{
      data: unknown[]
      pagination: { nextAfter: number; hasMore: boolean }
    }>(config, request, `/v1/runs/${runId}/events/history?after=${after}`, {
      headers: requestHeaders(request, config.apiToken),
    }, fetchPort)
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
    const metadata = await sharp(image).metadata().catch(() => null)
    const imageWidthPx = metadata?.width ?? null
    const imageHeightPx = metadata?.height ?? null
    const imageRelativeAspectError = imageWidthPx !== null && imageHeightPx !== null
      ? Math.abs((imageWidthPx / imageHeightPx) / (16 / 9) - 1)
      : null
    const imageAspectRatioValidated = imageWidthPx !== null
      && imageHeightPx !== null
      && hasExactVisualDeckV4AspectRatio(imageWidthPx, imageHeightPx)
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
      imageWidthPx,
      imageHeightPx,
      imageRelativeAspectError,
      imageAspectRatioValidated,
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
  delivery: DeliveryRecord,
  caseDirectory: string,
  fetchPort: FetchPort = fetch,
) {
  const files = {
    pptx: { filename: 'presentation.pptx', reference: delivery.pptx },
    preview: { filename: 'contact-sheet.png', reference: delivery.preview },
    sources: { filename: 'source-manifest.json', reference: delivery.sources },
  } as const
  const evidence: Record<string, unknown> = {}
  for (const [format, output] of Object.entries(files)) {
    if (!output.reference) throw new Error(`DELIVERY_REFERENCE_MISSING:${format}`)
    const response = await fetchPort(
      `${config.serviceUrl}/v1/runs/${runId}/deliveries/${delivery.id}/content?format=${format}`,
      { headers: requestHeaders(request, config.apiToken) },
    )
    if (!response.ok) throw new Error(`DELIVERY_DOWNLOAD_FAILED:${format}:${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const contentSha256 = sha256(bytes)
    const contentType = response.headers.get('Content-Type')
    const contentLength = response.headers.get('Content-Length')
    const schemaVersion = response.headers.get('X-PPT-Agent-Schema-Version')
    const deliveryId = response.headers.get('X-PPT-Agent-Delivery-ID')
    const headerSha256 = response.headers.get('X-PPT-Agent-Content-SHA256')
    const etag = response.headers.get('ETag')
    if (schemaVersion !== '1'
      || deliveryId !== delivery.id
      || contentType !== output.reference.mimeType
      || contentLength !== String(output.reference.byteLength)
      || bytes.byteLength !== output.reference.byteLength
      || headerSha256 !== output.reference.sha256
      || contentSha256 !== output.reference.sha256
      || etag !== `"${output.reference.sha256}"`) {
      throw new Error(`DELIVERY_DOWNLOAD_CONTRACT_INVALID:${format}`)
    }
    await writeFile(path.join(caseDirectory, output.filename), bytes, { mode: 0o600 })
    evidence[format] = {
      schemaVersion,
      deliveryId,
      contentType,
      byteLength: bytes.byteLength,
      sha256: contentSha256,
      etag,
    }
  }
  return evidence
}

async function runCase(
  config: EvaluationConfig,
  slideCount: typeof V4_EVALUATION_CANARY_PAGE_COUNTS[number],
  caseId: string,
  request: CreateRunRequest,
  evaluationBatchKey: string,
  fetchPort: FetchPort = fetch,
) {
  const caseDirectory = path.join(config.outputRoot, String(slideCount), caseId)
  await mkdir(caseDirectory, { recursive: true, mode: 0o700 })
  await writeJson(path.join(caseDirectory, 'request-manifest.json'), redactedEvaluationRequest(request))
  const timeline: Array<Record<string, unknown>> = []
  const startedAt = Date.now()
  const created = await jsonRequest<{ data: RunDetail; replayed: boolean }>(config, request, '/v1/runs', {
    method: 'POST',
    headers: {
      ...requestHeaders(request, config.apiToken, true),
      'Idempotency-Key': v4EvaluationIdempotencyKey(slideCount, caseId, evaluationBatchKey),
    },
    body: JSON.stringify(request),
  }, fetchPort)
  const createdRun = runSnapshotSchema.parse(created.data) as RunDetail
  validateCreatedV4RunIdentity(createdRun, request, slideCount)
  const runId = createdRun.id
  await writeJson(path.join(caseDirectory, 'created.json'), {
    schemaVersion: '1',
    replayed: created.replayed,
    run: redactedRunEvidence(createdRun),
  })

  const planned = await waitFor(
    config,
    request,
    runId,
    (run) => run.status !== 'PLANNING' || TERMINAL_STATUSES.has(run.status),
    config.planningTimeoutMs,
    timeline,
    undefined,
    fetchPort,
  )
  await writeJson(path.join(caseDirectory, 'planning.json'), redactedRunEvidence(planned))
  let finalRun = TERMINAL_STATUSES.has(planned.status)
    ? planned
    : await waitFor(
      config,
      request,
      runId,
      (run) => TERMINAL_STATUSES.has(run.status),
      config.runTimeoutMs,
      timeline,
      undefined,
      fetchPort,
    )
  let deliveryWaitState = deliveryAvailabilityWaitState(finalRun)
  if (deliveryWaitState.state === 'WAIT') {
    finalRun = await waitFor(
      config,
      request,
      runId,
      (run) => {
        deliveryWaitState = deliveryAvailabilityWaitState(run)
        return deliveryWaitState.state !== 'WAIT'
      },
      config.runTimeoutMs,
      timeline,
      () => `DELIVERY_AVAILABILITY_WAIT_TIMEOUT:${runId}:${deliveryWaitState.reason}`,
      fetchPort,
    )
  }
  const events = await readEventHistory(config, request, runId, fetchPort)
  await Promise.all([
    writeJson(path.join(caseDirectory, 'final-run.json'), redactedRunEvidence(finalRun)),
    writeJson(path.join(caseDirectory, 'timeline.json'), timeline),
    writeJson(path.join(caseDirectory, 'events.json'), redactedEventHistory(events)),
  ])

  let rasterGate: ReturnType<typeof validateRasterPages> = {
    passed: false,
    continuous: false,
    expectedPages: slideCount,
    validPages: 0,
  }
  let pptxSha256: string | null = null
  let pptxByteLength: number | null = null
  if (finalRun.status === 'COMPLETED') {
    const delivery = requireAvailableDelivery(finalRun)
    const contentEvidence = await downloadDelivery(config, request, runId, delivery, caseDirectory, fetchPort)
    await writeJson(path.join(caseDirectory, 'delivery-content.json'), {
      schemaVersion: '1',
      delivery,
      content: contentEvidence,
    })
    const pptxPath = path.join(caseDirectory, 'presentation.pptx')
    const pptxBytes = await Bun.file(pptxPath).bytes()
    const pageValidation = await extractAndValidatePages(caseDirectory, pptxPath)
    await writeJson(path.join(caseDirectory, 'pptx-validation.json'), pageValidation)
    rasterGate = validateRasterPages(pageValidation, slideCount)
    pptxSha256 = sha256(pptxBytes)
    pptxByteLength = pptxBytes.byteLength
  }

  const lifecycleGate = validateLifecycle(events, finalRun.status, finalRun.revisionRound)
  const qualityGate = validateQualityGate(finalRun, rasterGate, lifecycleGate, slideCount)
  const result = {
    caseId,
    slideCount,
    runId,
    status: finalRun.status,
    presentationMode: finalRun.presentationMode ?? null,
    imageModel: finalRun.imageModel ?? null,
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

export async function runV4EvaluationCanary(input: Readonly<{
  preflight: () => Promise<V4EvaluationTarget>
  persistPreflight?: (target: V4EvaluationTarget) => Promise<void>
  caseIds: readonly string[]
  runCase: (
    slideCount: typeof V4_EVALUATION_CANARY_PAGE_COUNTS[number],
    caseId: string,
  ) => Promise<V4EvaluationCanaryCaseResult>
}>) {
  const target = await input.preflight()
  await input.persistPreflight?.(target)
  const results: V4EvaluationCanaryCaseResult[] = []
  for (const slideCount of V4_EVALUATION_CANARY_PAGE_COUNTS) {
    for (const caseId of input.caseIds) {
      try {
        const result = await input.runCase(slideCount, caseId)
        if (result.slideCount !== slideCount || result.caseId !== caseId) {
          results.push({ passed: false, slideCount, caseId, errorCode: 'V4_EVAL_CANARY_RESULT_IDENTITY_INVALID' })
          return { target, results, passed: false }
        }
        results.push(result)
        if (!result.passed) return { target, results, passed: false }
      } catch (error) {
        results.push({ passed: false, slideCount, caseId, errorCode: safeFailureCode(error) })
        return { target, results, passed: false }
      }
    }
  }
  return {
    target,
    results,
    passed: results.length === V4_EVALUATION_CANARY_PAGE_COUNTS.length * input.caseIds.length
      && results.every((result) => result.passed),
  }
}

async function main() {
  const config = evaluationConfig()
  await ensureNewOutputRoot(config.outputRoot, config.inputRoot)
  const evaluationInputs = await loadV4EvaluationInputs({
    inputRoot: config.inputRoot,
    caseIds: config.caseIds,
    pageCounts: config.canaryPageCounts,
  })
  const preflightRequest = evaluationInputs[0]!.request
  const evaluationBatchKey = sha256(`${config.evaluationKey}\0${randomUUID()}`)
  const evaluationBatchFingerprint = sha256(evaluationBatchKey).slice(0, 16)
  const canary = await runV4EvaluationCanary({
    preflight: () => readV4EvaluationGatewayTarget({
      serviceUrl: config.serviceUrl,
      apiToken: config.apiToken,
      request: preflightRequest,
      timeoutMs: config.readyTimeoutMs,
      fetch,
      expectedRelease: config.expectedRelease,
    }),
    persistPreflight: (target) => writeJson(path.join(config.outputRoot, 'preflight.json'), {
      schemaVersion: '1',
      checkedAt: new Date().toISOString(),
      serviceUrl: config.serviceUrl,
      evaluationBatchFingerprint,
      target,
    }),
    caseIds: config.caseIds,
    runCase: async (slideCount, caseId) => {
      console.log(JSON.stringify({ event: 'case_started', slideCount, caseId }))
      try {
        return await runCase(
          config,
          slideCount,
          caseId,
          evaluationInputFor(evaluationInputs, slideCount, caseId).request,
          evaluationBatchKey,
        )
      } catch (error) {
        const result = { passed: false, slideCount, caseId, errorCode: safeFailureCode(error) }
        const caseDirectory = path.join(config.outputRoot, String(slideCount), caseId)
        await mkdir(caseDirectory, { recursive: true, mode: 0o700 })
        await writeJson(path.join(caseDirectory, 'result.json'), result)
        return result
      }
    },
  })
  const summary = {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    serviceUrl: config.serviceUrl,
    target: canary.target,
    evaluationBatchFingerprint,
    pageCounts: config.canaryPageCounts,
    cases: config.caseIds,
    executedRequestHash: evaluationExecutedRequestHash(evaluationInputs),
    protocol: { text: 'RESPONSES_JSON_SCHEMA', textStreaming: true, image: 'IMAGE_TASK', imageRatio: '16:9' },
    results: canary.results,
  }
  await Promise.all([
    writeJson(path.join(config.outputRoot, 'evaluation-manifest.json'), {
      ...summary,
      policy: {
        presentationMode: 'VISUAL_DECK_V4',
        intervention: 'Approve the initial plan once; never edit prompts, revise manually, or override quality gates.',
        credentials: 'Environment only; never persisted in evaluation output.',
      },
    }),
    writeJson(path.join(config.outputRoot, 'summary.json'), summary),
  ])
  console.log(JSON.stringify({ event: 'evaluation_completed', passed: canary.passed, results: canary.results }))
  if (!canary.passed) process.exitCode = 1
}

if (import.meta.main) await main()

import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { LocalArtifactPort } from './adapters/local-artifact-port'
import { PublicAssetDiscoveryPort } from './adapters/public-asset-discovery'
import { GatewayImageGenerationPort } from './adapters/gateway-image-generation'
import {
  GatewayCoursewareModel,
  gatewayCoursewareModelProfile,
  visualDeckV4TextTransport,
} from './adapters/gateway-courseware-model'
import { FallbackCoursewareModel } from './adapters/fallback-courseware-model'
import { HttpFrameFlowBackend } from './adapters/frameflow-http-backend'
import { FrameFlowUsageAccountingAdapter } from './adapters/frameflow-usage-accounting'
import { ExternallyAuthorizedBudgetPort } from './adapters/external-budget'
import { SqliteAgentRepository } from './adapters/sqlite-repository'
import { createAgentRuntime, createMockRuntime } from './runtime/mock-runtime'
import { ServiceTokenAuthentication } from './http/service-token-authentication'
import { safeWorkerErrorCode, WorkerTickError, workerLogRecord } from './observability/runtime-health'
import { buildIdentity, PPT_AGENT_SOFTWARE_VERSION } from './release-identity'
import { resolveUsageV2RuntimeConfig } from './runtime/usage-v2-runtime-config'

const hostname = process.env.PPT_AGENT_HOST?.trim() || '127.0.0.1'
if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
  throw new Error('PPT_AGENT_HOST_MUST_BE_LOOPBACK')
}
const port = Number(process.env.PPT_AGENT_PORT ?? 4310)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PPT_AGENT_PORT_INVALID')
const apiToken = process.env.PPT_AGENT_API_TOKEN?.trim()
if (!apiToken) throw new Error('PPT_AGENT_API_TOKEN_REQUIRED')
const adminApiToken = process.env.PPT_AGENT_ADMIN_API_TOKEN?.trim()
const tenantId = process.env.PPT_AGENT_TENANT_ID?.trim() || 'frameflow'
const budgetMode = process.env.PPT_AGENT_BUDGET_MODE?.trim() || (tenantId === 'frameflow' ? 'frameflow' : '')
if (tenantId === 'frameflow' && budgetMode !== 'frameflow') throw new Error('PPT_AGENT_BUDGET_MODE_INVALID')
if (tenantId !== 'frameflow' && budgetMode !== 'external') throw new Error('PPT_AGENT_EXTERNAL_BUDGET_MODE_REQUIRED')
const authentication = new ServiceTokenAuthentication([{
  tenantId,
  userToken: apiToken,
  ...(adminApiToken ? { adminToken: adminApiToken } : {}),
}])
function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name}_INVALID`)
  return value
}
const dataRoot = path.resolve(process.env.PPT_AGENT_DATA_ROOT?.trim() || '.private/mock-runtime')
await mkdir(dataRoot, { recursive: true, mode: 0o700 })

const repository = new SqliteAgentRepository(path.join(dataRoot, 'agent.sqlite'))
const artifacts = new LocalArtifactPort(path.join(dataRoot, 'artifacts'))
const runtimeMode = process.env.PPT_AGENT_RUNTIME_MODE?.trim() || 'mock'
const usageV2Runtime = resolveUsageV2RuntimeConfig(process.env, await repository.listRuns())
if (usageV2Runtime.requiresUsageV2Runtime && tenantId !== 'frameflow') {
  throw new Error('USAGE_V2_FRAMEFLOW_TENANT_REQUIRED')
}
if (usageV2Runtime.requiresUsageV2Runtime && runtimeMode !== 'gateway') {
  throw new Error('USAGE_V2_GATEWAY_RUNTIME_REQUIRED')
}
const revisionImageModel = process.env.PPT_AGENT_V4_REVISION_IMAGE_MODEL?.trim()
if (runtimeMode === 'gateway' && !revisionImageModel) throw new Error('PPT_AGENT_V4_REVISION_IMAGE_MODEL_REQUIRED')
if (usageV2Runtime.providerBillingCatalog && revisionImageModel) {
  usageV2Runtime.providerBillingCatalog.snapshot({
    model: revisionImageModel,
    operationMode: 'IMAGE_EDIT',
    resolution: '1K',
    aspectRatio: '16:9',
  })
  for (const run of await repository.listRuns()) {
    if (run.accountingProtocol !== 'FRAMEFLOW_USAGE_V2') continue
    usageV2Runtime.providerBillingCatalog.snapshot({
      model: run.imageModel,
      operationMode: 'TEXT_TO_IMAGE',
      resolution: '1K',
      aspectRatio: run.visualDeckV4?.deckOptions.aspectRatio ?? '16:9',
    })
  }
}
const assetSearchEnabled = process.env.PPT_AGENT_ASSET_SEARCH_ENABLED?.trim() === 'true'
const fallbackModelValue = process.env.PPT_AGENT_FALLBACK_MODEL_ENABLED?.trim()
if (fallbackModelValue && fallbackModelValue !== 'true' && fallbackModelValue !== 'false') {
  throw new Error('PPT_AGENT_FALLBACK_MODEL_ENABLED_INVALID')
}
const fallbackModelEnabled = fallbackModelValue === 'true'
const visualDeckV4Transport = visualDeckV4TextTransport(process.env.PPT_AGENT_V4_TEXT_TRANSPORT)
const appVersion = process.env.PPT_AGENT_SOFTWARE_VERSION?.trim()
  || process.env.PPT_AGENT_APP_VERSION?.trim()
  || PPT_AGENT_SOFTWARE_VERSION
const releaseIdentity = buildIdentity({
  softwareVersion: appVersion,
  gitSha: process.env.PPT_AGENT_GIT_SHA?.trim() || 'unknown',
  releaseId: process.env.PPT_AGENT_RELEASE_ID?.trim() || 'unversioned',
})
const heartbeatStaleMs = boundedInteger('PPT_AGENT_HEARTBEAT_STALE_MS', 5_000, 1_000, 60_000)
// A bounded provider retry window can legitimately keep one worker tick busy for ~19 minutes.
const tickStaleMs = boundedInteger('PPT_AGENT_TICK_STALE_MS', 25 * 60_000, 10_000, 60 * 60_000)
const waitingSlaMs = boundedInteger('PPT_AGENT_WAITING_SLA_MS', 15 * 60_000, 10_000, 24 * 60 * 60_000)
const stepSlaMs = boundedInteger('PPT_AGENT_STEP_SLA_MS', 30 * 60_000, 10_000, 24 * 60 * 60_000)
const workerConcurrency = boundedInteger('PPT_AGENT_WORKER_CONCURRENCY', 2, 1, 8)
const imageConcurrency = boundedInteger('PPT_AGENT_IMAGE_CONCURRENCY', 50, 1, 50)
const reviewConcurrency = boundedInteger('PPT_AGENT_REVIEW_CONCURRENCY', 1, 1, 8)
const runLeaseTtlMs = boundedInteger('PPT_AGENT_RUN_LEASE_TTL_MS', 60_000, 5_000, 15 * 60_000)
const createRunRateLimitPerMinute = boundedInteger('PPT_AGENT_CREATE_RUN_RATE_LIMIT_PER_MINUTE', 10, 1, 10_000)
const runActionRateLimitPerMinute = boundedInteger('PPT_AGENT_RUN_ACTION_RATE_LIMIT_PER_MINUTE', 60, 1, 10_000)
if (runtimeMode !== 'mock' && runtimeMode !== 'gateway') throw new Error('PPT_AGENT_RUNTIME_MODE_INVALID')
function loopbackProxy(value: string | undefined) {
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || url.username || url.password) throw new Error('PPT_AGENT_ASSET_HTTP_PROXY_INVALID')
  return url.toString()
}
const assetProxy = loopbackProxy(process.env.PPT_AGENT_ASSET_HTTP_PROXY?.trim())
const discovery = assetSearchEnabled
  ? new PublicAssetDiscoveryPort(assetProxy ? { proxyUrl: assetProxy } : {})
  : undefined
const images = runtimeMode === 'gateway'
  ? new GatewayImageGenerationPort({
      baseUrl: process.env.MODEL_GATEWAY_BASE_URL?.trim() || '',
      apiKey: process.env.MODEL_GATEWAY_IMAGE_KEY?.trim() || '',
      artifacts,
    })
  : undefined
const runtime = runtimeMode === 'gateway'
  ? (() => {
      const frameFlowInternalToken = budgetMode === 'frameflow'
        ? process.env.FRAMEFLOW_INTERNAL_TOKEN?.trim()
        : undefined
      if (budgetMode === 'frameflow' && !frameFlowInternalToken) throw new Error('FRAMEFLOW_INTERNAL_TOKEN_REQUIRED')
      const frameFlowBackend = budgetMode === 'frameflow'
        ? new HttpFrameFlowBackend({
            baseUrl: process.env.FRAMEFLOW_INTERNAL_BASE_URL?.trim() || 'http://127.0.0.1:3010',
            token: frameFlowInternalToken!,
          })
        : undefined
      const textModel = process.env.PPT_AGENT_TEXT_MODEL?.trim() || 'gpt-5.6'
      const visionModel = process.env.PPT_AGENT_VISION_MODEL?.trim() || 'gpt-5.6'
      const primaryModel = new GatewayCoursewareModel({
        baseUrl: process.env.MODEL_GATEWAY_BASE_URL?.trim() || '',
        apiKey: process.env.MODEL_GATEWAY_TEXT_KEY?.trim() || '',
        textModel,
        visionModel,
        artifacts,
        profile: gatewayCoursewareModelProfile({ textModel, visionModel }),
        visualDeckV4Transport,
      })
      const model = fallbackModelEnabled
        ? new FallbackCoursewareModel({
            primary: primaryModel,
            fallback: new GatewayCoursewareModel({
              baseUrl: process.env.MINIMAX_BASE_URL?.trim() || 'https://api.minimaxi.com/v1',
              apiKey: process.env.MINIMAX_API_KEY?.trim() || '',
              textModel: process.env.MINIMAX_TEXT_MODEL?.trim() || 'MiniMax-M3',
              visionModel: process.env.MINIMAX_VISION_MODEL?.trim() || 'MiniMax-M3',
              artifacts,
              profile: 'MINIMAX_M3',
              visualDeckV4Transport,
            }),
          })
        : primaryModel
      return createAgentRuntime({
        repository,
        artifacts,
        ...(discovery ? { discovery } : {}),
        ...(discovery ? { candidateReviewer: model } : {}),
        apiToken,
        authentication,
        images: images!,
        model,
        visualReviewer: model,
        deckReviewer: model,
        revisionPlanner: model,
        revisionApplication: model,
        ...(frameFlowBackend ? {
          frameFlowBackend,
        } : {
          budget: new ExternallyAuthorizedBudgetPort(tenantId),
        }),
        defaultAccountingProtocol: usageV2Runtime.defaultAccountingProtocol,
        ...(usageV2Runtime.requiresUsageV2Runtime ? {
          usageAccounting: new FrameFlowUsageAccountingAdapter(frameFlowBackend!),
          providerBillingCatalog: usageV2Runtime.providerBillingCatalog!,
        } : {}),
        appVersion,
        buildIdentity: releaseIdentity,
        heartbeatStaleMs,
        tickStaleMs,
        waitingSlaMs,
        stepSlaMs,
        workerConcurrency,
        imageConcurrency,
        revisionImageModel: revisionImageModel!,
        reviewConcurrency,
        runLeaseTtlMs,
        createRunRateLimitPerMinute,
        runActionRateLimitPerMinute,
      })
    })()
  : createMockRuntime({
      repository, artifacts, apiToken, appVersion, buildIdentity: releaseIdentity, heartbeatStaleMs, tickStaleMs, waitingSlaMs, stepSlaMs,
      workerConcurrency, imageConcurrency, reviewConcurrency, runLeaseTtlMs, createRunRateLimitPerMinute, runActionRateLimitPerMinute,
      revisionImageModel: revisionImageModel || 'image-2',
      defaultAccountingProtocol: usageV2Runtime.defaultAccountingProtocol,
    })
let ticking = false
const timer = setInterval(async () => {
  runtime.health.heartbeat()
  if (ticking) return
  ticking = true
  const startedAt = performance.now()
  try {
    const summary = await runtime.tick()
    if (summary.activeRuns > 0) {
      console.log(JSON.stringify(workerLogRecord({
        event: 'worker_tick_completed', version: appVersion,
        elapsedMs: performance.now() - startedAt, summary,
      })))
    }
  } catch (error) {
    const failure = error instanceof WorkerTickError
      ? error.context
      : { runId: null, phase: null, errorCode: safeWorkerErrorCode(error) }
    console.error(JSON.stringify(workerLogRecord({
      event: 'worker_tick_failed', version: appVersion,
      elapsedMs: performance.now() - startedAt, failure,
    })))
  } finally {
    ticking = false
  }
}, 500)

const server = Bun.serve({ hostname, port, idleTimeout: 30, fetch: runtime.handler })
console.log(JSON.stringify({
  ...workerLogRecord({ event: 'service_started', version: appVersion }),
  runtimeMode,
  origin: server.url.origin,
}))

const stop = () => {
  clearInterval(timer)
  server.stop(true)
  repository.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

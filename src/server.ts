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
import { FrameFlowHostAdapter } from './adapters/frameflow-host'
import { ExternallyAuthorizedBudgetPort } from './adapters/external-budget'
import {
  InternalPresentationJobV2Provider,
  presentationJobV2InternalTenantId,
} from './adapters/internal-presentation-job-v2-provider'
import { SqliteAgentRepository } from './adapters/sqlite-repository'
import { SqlitePresentationJobV2Repository } from './adapters/presentation-job-v2-sqlite-repository'
import {
  FixedServicePresentationJobBudgetPolicy,
} from './adapters/presentation-job-v2-ports'
import { TenantRoutingBudgetPort } from './adapters/tenant-routing-budget'
import { MockBudgetPort } from './adapters/mock-ports'
import { createAgentRuntime, createMockRuntime, SystemClock } from './runtime/mock-runtime'
import { RunService } from './core/run-service'
import { createPresentationJobV2ProviderFromEnv } from './runtime/presentation-job-v2-provider-config'
import { ServiceTokenAuthentication } from './http/service-token-authentication'
import { safeWorkerErrorCode, WorkerTickError, workerLogRecord } from './observability/runtime-health'
import { buildIdentity, PPT_AGENT_SOFTWARE_VERSION } from './release-identity'
import { resolveMainServerConfig } from './runtime/main-server-config'
import { resolveUsageV2RuntimeConfig } from './runtime/usage-v2-runtime-config'

const {
  hostname,
  port,
  apiToken,
  adminApiToken,
  presentationJobV2ApiToken,
} = resolveMainServerConfig(process.env)
const tenantId = process.env.PPT_AGENT_TENANT_ID?.trim() || 'frameflow'
const budgetMode = process.env.PPT_AGENT_BUDGET_MODE?.trim() || (tenantId === 'frameflow' ? 'frameflow' : '')
if (tenantId === 'frameflow' && budgetMode !== 'frameflow') throw new Error('PPT_AGENT_BUDGET_MODE_INVALID')
if (tenantId !== 'frameflow' && budgetMode !== 'external') throw new Error('PPT_AGENT_EXTERNAL_BUDGET_MODE_REQUIRED')
const authentication = new ServiceTokenAuthentication([{
  tenantId,
  userToken: apiToken,
  ...(adminApiToken ? { adminToken: adminApiToken } : {}),
  ...(presentationJobV2ApiToken ? { v2Token: presentationJobV2ApiToken } : {}),
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
const presentationJobV2Clock = new SystemClock()
const presentationJobV2InternalTenant = presentationJobV2InternalTenantId(tenantId)
const presentationJobV2Runtime = presentationJobV2ApiToken
  ? (() => {
      const presentationJobV2Repository = new SqlitePresentationJobV2Repository(
        path.join(dataRoot, 'presentation-jobs-v2.sqlite'),
      )
      const internalPresentationJobV2Provider = new InternalPresentationJobV2Provider({
        runs: new RunService({
          repository,
          artifacts,
          clock: presentationJobV2Clock,
          buildIdentity: releaseIdentity,
        }),
        repository,
        artifacts,
        internalTenantId: presentationJobV2InternalTenant,
      })
      return {
        repository: presentationJobV2Repository,
        provider: createPresentationJobV2ProviderFromEnv(process.env, {
          internalProvider: internalPresentationJobV2Provider,
        }),
        budget: new ExternallyAuthorizedBudgetPort(presentationJobV2InternalTenant),
      }
    })()
  : null
const presentationJobV2 = presentationJobV2Runtime
  ? {
      repository: presentationJobV2Runtime.repository,
      provider: presentationJobV2Runtime.provider,
      budget: new FixedServicePresentationJobBudgetPolicy(1),
    }
  : undefined
const presentationJobV2Budget = presentationJobV2Runtime?.budget
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
      const hostBudget = frameFlowBackend
        ? new FrameFlowHostAdapter(frameFlowBackend)
        : new ExternallyAuthorizedBudgetPort(tenantId)
      const budget = presentationJobV2Budget
        ? new TenantRoutingBudgetPort({
            routedTenantId: presentationJobV2InternalTenant,
            routed: presentationJobV2Budget,
            fallback: hostBudget,
          })
        : hostBudget
      const textModel = process.env.PPT_AGENT_TEXT_MODEL?.trim() || 'gpt-5.6-terra'
      const visionModel = process.env.PPT_AGENT_VISION_MODEL?.trim() || 'gpt-5.6-terra'
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
        ...(presentationJobV2 ? { presentationJobV2 } : {}),
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
        ...(frameFlowBackend ? { frameFlowBackend } : {}),
        budget,
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
      ...(presentationJobV2 ? { presentationJobV2 } : {}),
      workerConcurrency, imageConcurrency, reviewConcurrency, runLeaseTtlMs, createRunRateLimitPerMinute, runActionRateLimitPerMinute,
      revisionImageModel: revisionImageModel || 'image-2',
      defaultAccountingProtocol: usageV2Runtime.defaultAccountingProtocol,
      budget: presentationJobV2Budget
        ? new TenantRoutingBudgetPort({
            routedTenantId: presentationJobV2InternalTenant,
            routed: presentationJobV2Budget,
            fallback: new MockBudgetPort(),
          })
        : new MockBudgetPort(),
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
  presentationJobV2Runtime?.repository.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

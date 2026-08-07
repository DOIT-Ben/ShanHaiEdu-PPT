import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { LocalArtifactPort } from './adapters/local-artifact-port'
import { PublicAssetDiscoveryPort } from './adapters/public-asset-discovery'
import { GatewayImageGenerationPort } from './adapters/gateway-image-generation'
import { GatewayModelAvailabilityProbe } from './adapters/gateway-model-availability'
import { SharpControlledRasterPort } from './adapters/v4-controlled-raster'
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
import { SqliteQuickDeckEvaluationRepository } from './adapters/quick-deck-evaluation-sqlite-repository'
import { LocalQuickDeckEvaluationArtifactCleanupPort } from './adapters/quick-deck-evaluation-local-artifact-cleanup'
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
import { resolveRuntimeBuildIdentity } from './runtime/release-manifest'
import { V4ModelPolicy } from './core/v4-model-policy'
import {
  resolveGatewayCoursewareModelsConfig,
  resolveMainServerConfig,
  resolveQuickDeckEvaluationConfig,
  assertQuickDeckEvaluationTokenIsolation,
  resolveV4ImageEditAsyncTaskEnabled,
  resolveV4ModelPolicyConfig,
  resolveV4RevisionImageModel,
} from './runtime/main-server-config'
import { QuickDeckEvaluatorModelEligibility } from './runtime/quick-deck-evaluator-preflight'
import { resolveUsageV2RuntimeConfig } from './runtime/usage-v2-runtime-config'

const {
  hostname,
  port,
  apiToken,
  adminApiToken,
  presentationJobV2ApiToken,
  quickDeckEvaluationApiToken,
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
  ...(quickDeckEvaluationApiToken ? { evaluationToken: quickDeckEvaluationApiToken } : {}),
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
const controlledRaster = new SharpControlledRasterPort({ artifacts })
const runtimeMode = process.env.PPT_AGENT_RUNTIME_MODE?.trim() || 'mock'
const usageV2Runtime = resolveUsageV2RuntimeConfig(process.env, await repository.listRuns())
if (usageV2Runtime.requiresUsageV2Runtime && tenantId !== 'frameflow') {
  throw new Error('USAGE_V2_FRAMEFLOW_TENANT_REQUIRED')
}
if (usageV2Runtime.requiresUsageV2Runtime && runtimeMode !== 'gateway') {
  throw new Error('USAGE_V2_GATEWAY_RUNTIME_REQUIRED')
}
const revisionImageModel = resolveV4RevisionImageModel(process.env)
const imageEditTaskEnabled = resolveV4ImageEditAsyncTaskEnabled(process.env)
const assetSearchEnabled = process.env.PPT_AGENT_ASSET_SEARCH_ENABLED?.trim() === 'true'
const visualDeckV4Transport = visualDeckV4TextTransport(process.env.PPT_AGENT_V4_TEXT_TRANSPORT)
const releaseIdentity = resolveRuntimeBuildIdentity({
  env: process.env,
  runtimeEntryUrl: import.meta.url,
})
const appVersion = releaseIdentity.softwareVersion
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
if (quickDeckEvaluationApiToken && runtimeMode !== 'gateway') {
  throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_RUNTIME_REQUIRED')
}
const gatewayCoursewareModels = runtimeMode === 'gateway'
  ? resolveGatewayCoursewareModelsConfig(process.env)
  : null
const v4ModelPolicyConfig = gatewayCoursewareModels
  ? resolveV4ModelPolicyConfig(
      process.env,
      gatewayCoursewareModels,
      revisionImageModel,
    )
  : null
const v4ModelPolicy = v4ModelPolicyConfig
  ? new V4ModelPolicy({
      runtimeMode: 'GATEWAY',
      ...v4ModelPolicyConfig,
      availabilityProbes: {
        text: new GatewayModelAvailabilityProbe({
          baseUrl: process.env.MODEL_GATEWAY_BASE_URL?.trim() || '',
          apiKey: process.env.MODEL_GATEWAY_TEXT_KEY?.trim() || '',
        }),
        image: new GatewayModelAvailabilityProbe({
          baseUrl: process.env.MODEL_GATEWAY_BASE_URL?.trim() || '',
          apiKey: process.env.MODEL_GATEWAY_IMAGE_KEY?.trim() || '',
        }),
      },
    })
  : V4ModelPolicy.mock()
const publishedRevisionImageModels = v4ModelPolicy.publishedModels('IMAGE_EDIT')
if (publishedRevisionImageModels.length > 1) throw new Error('PPT_AGENT_V4_PUBLISHED_IMAGE_EDIT_MODELS_INVALID')
const publishedRevisionImageModel = publishedRevisionImageModels[0] ?? null
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
          v4ModelPolicy,
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
const quickDeckEvaluationConfig = quickDeckEvaluationApiToken
  ? resolveQuickDeckEvaluationConfig(process.env, {
      textModels: v4ModelPolicy.quickDeckResponsesTextModels(),
      imageModels: v4ModelPolicy.quickDeckImageModels(),
    })
  : null
const quickDeckEvaluatorModelEligibility = quickDeckEvaluationConfig
  ? new QuickDeckEvaluatorModelEligibility({
      v4ModelPolicy,
      textProbe: new GatewayModelAvailabilityProbe({
        baseUrl: process.env.MODEL_GATEWAY_BASE_URL?.trim() || '',
        apiKey: quickDeckEvaluationConfig.gatewayTextKey,
      }),
      imageProbe: new GatewayModelAvailabilityProbe({
        baseUrl: process.env.MODEL_GATEWAY_BASE_URL?.trim() || '',
        apiKey: quickDeckEvaluationConfig.gatewayImageKey,
      }),
      ...(v4ModelPolicyConfig ? { directoryTtlMs: v4ModelPolicyConfig.availabilityTtlMs } : {}),
    })
  : null
if (quickDeckEvaluationConfig && quickDeckEvaluatorModelEligibility) {
  const eligibility = await quickDeckEvaluatorModelEligibility.check({
    textModel: quickDeckEvaluationConfig.textModel,
    imageModels: quickDeckEvaluationConfig.allowedImageModels,
  })
  if (eligibility !== 'READY') throw new Error(`PPT_AGENT_QUICK_DECK_EVALUATION_MODEL_${eligibility}`)
}
if (usageV2Runtime.providerBillingCatalog && publishedRevisionImageModel) {
  usageV2Runtime.providerBillingCatalog.snapshot({
    model: publishedRevisionImageModel,
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
const quickDeckEvaluationDataRoot = quickDeckEvaluationConfig
  ? path.resolve(quickDeckEvaluationConfig.dataRoot)
  : null
if (quickDeckEvaluationDataRoot && !quickDeckEvaluationDataRoot.startsWith(`${dataRoot}${path.sep}`)) {
  throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT_OUTSIDE_DATA_ROOT')
}
if (quickDeckEvaluationDataRoot) await mkdir(quickDeckEvaluationDataRoot, { recursive: true, mode: 0o700 })
const quickDeckEvaluationRuntime = quickDeckEvaluationDataRoot
  ? (() => {
      const artifacts = new LocalArtifactPort(path.join(quickDeckEvaluationDataRoot, 'artifacts'))
      return {
        artifacts,
        artifactCleanup: new LocalQuickDeckEvaluationArtifactCleanupPort(path.join(quickDeckEvaluationDataRoot, 'artifacts')),
        repository: new SqliteQuickDeckEvaluationRepository(path.join(quickDeckEvaluationDataRoot, 'evaluations.sqlite')),
        images: new GatewayImageGenerationPort({
          baseUrl: process.env.MODEL_GATEWAY_BASE_URL?.trim() || '',
          apiKey: quickDeckEvaluationConfig!.gatewayImageKey,
          artifacts,
        }),
      }
    })()
  : null
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
      imageEditTaskEnabled,
    })
  : undefined
const runtime = runtimeMode === 'gateway'
  ? (() => {
      const frameFlowInternalToken = budgetMode === 'frameflow'
        ? process.env.FRAMEFLOW_INTERNAL_TOKEN?.trim()
        : undefined
      if (budgetMode === 'frameflow' && !frameFlowInternalToken) throw new Error('FRAMEFLOW_INTERNAL_TOKEN_REQUIRED')
      assertQuickDeckEvaluationTokenIsolation(quickDeckEvaluationApiToken, frameFlowInternalToken)
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
      const primaryModel = new GatewayCoursewareModel({
          ...gatewayCoursewareModels!.primary,
        artifacts,
        profile: gatewayCoursewareModelProfile(gatewayCoursewareModels!.primary),
        visualDeckV4Transport,
      })
      const model = gatewayCoursewareModels!.fallback
        ? new FallbackCoursewareModel({
            primary: primaryModel,
            fallback: new GatewayCoursewareModel({
              ...gatewayCoursewareModels!.fallback,
              artifacts,
              profile: 'MINIMAX_M3',
              visualDeckV4Transport: gatewayCoursewareModels!.fallback.transport,
            }),
          })
        : primaryModel
      const quickDeckEvaluationModel = quickDeckEvaluationRuntime && quickDeckEvaluationConfig
        ? new GatewayCoursewareModel({
            ...gatewayCoursewareModels!.primary,
            apiKey: quickDeckEvaluationConfig.gatewayTextKey,
            textModel: quickDeckEvaluationConfig.textModel,
            artifacts: quickDeckEvaluationRuntime.artifacts,
            profile: gatewayCoursewareModelProfile({ textModel: quickDeckEvaluationConfig.textModel }),
            visualDeckV4Transport: 'RESPONSES',
          })
        : undefined
      return createAgentRuntime({
        repository,
        artifacts,
        controlledRaster,
        ...(presentationJobV2 ? { presentationJobV2 } : {}),
        ...(quickDeckEvaluationRuntime && quickDeckEvaluationConfig && quickDeckEvaluationModel ? {
          quickDeckEvaluation: {
            repository: quickDeckEvaluationRuntime.repository,
            artifacts: quickDeckEvaluationRuntime.artifacts,
            images: quickDeckEvaluationRuntime.images,
            authentication,
            artifactCleanup: quickDeckEvaluationRuntime.artifactCleanup,
            model: quickDeckEvaluationModel,
            textModel: quickDeckEvaluationConfig.textModel,
            allowedImageModels: quickDeckEvaluationConfig.allowedImageModels,
            modelEligibility: quickDeckEvaluatorModelEligibility!,
            maxActiveJobs: quickDeckEvaluationConfig.maxActiveJobs,
            maxDailyJobs: quickDeckEvaluationConfig.maxDailyJobs,
            ttlMs: quickDeckEvaluationConfig.ttlMs,
            tickBatchSize: quickDeckEvaluationConfig.tickBatchSize,
            evidence: {
              runtimeMode: 'GATEWAY',
              softwareVersion: releaseIdentity.softwareVersion,
              gitSha: releaseIdentity.gitSha,
              releaseId: releaseIdentity.releaseId,
              startedAt: new Date().toISOString(),
            },
          },
        } : {}),
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
        revisionImageModel: publishedRevisionImageModel,
        reviewConcurrency,
        runLeaseTtlMs,
        createRunRateLimitPerMinute,
        runActionRateLimitPerMinute,
        v4ModelPolicy,
      })
    })()
  : createMockRuntime({
      repository, artifacts, apiToken, appVersion, buildIdentity: releaseIdentity, heartbeatStaleMs, tickStaleMs, waitingSlaMs, stepSlaMs,
      controlledRaster,
      ...(presentationJobV2 ? { presentationJobV2 } : {}),
      workerConcurrency, imageConcurrency, reviewConcurrency, runLeaseTtlMs, createRunRateLimitPerMinute, runActionRateLimitPerMinute,
      revisionImageModel: publishedRevisionImageModel,
      v4ModelPolicy,
      defaultAccountingProtocol: usageV2Runtime.defaultAccountingProtocol,
      budget: presentationJobV2Budget
        ? new TenantRoutingBudgetPort({
            routedTenantId: presentationJobV2InternalTenant,
            routed: presentationJobV2Budget,
            fallback: new MockBudgetPort(),
          })
        : new MockBudgetPort(),
  })
await runtime.initialize()
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
  quickDeckEvaluationRuntime?.repository.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

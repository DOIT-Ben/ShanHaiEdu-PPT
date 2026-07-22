import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { LocalArtifactPort } from './adapters/local-artifact-port'
import { GatewayImageGenerationPort } from './adapters/gateway-image-generation'
import { GatewayCoursewareModel } from './adapters/gateway-courseware-model'
import { HttpFrameFlowBackend } from './adapters/frameflow-http-backend'
import { SqliteAgentRepository } from './adapters/sqlite-repository'
import { createAgentRuntime, createMockRuntime } from './runtime/mock-runtime'
import { safeWorkerErrorCode, WorkerTickError, workerLogRecord } from './observability/runtime-health'

const hostname = process.env.PPT_AGENT_HOST?.trim() || '127.0.0.1'
if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
  throw new Error('PPT_AGENT_HOST_MUST_BE_LOOPBACK')
}
const port = Number(process.env.PPT_AGENT_PORT ?? 4310)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PPT_AGENT_PORT_INVALID')
const apiToken = process.env.PPT_AGENT_API_TOKEN?.trim()
if (!apiToken) throw new Error('PPT_AGENT_API_TOKEN_REQUIRED')
function boundedMilliseconds(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name}_INVALID`)
  return value
}
const dataRoot = path.resolve(process.env.PPT_AGENT_DATA_ROOT?.trim() || '.private/mock-runtime')
await mkdir(dataRoot, { recursive: true, mode: 0o700 })

const repository = new SqliteAgentRepository(path.join(dataRoot, 'agent.sqlite'))
const artifacts = new LocalArtifactPort(path.join(dataRoot, 'artifacts'))
const runtimeMode = process.env.PPT_AGENT_RUNTIME_MODE?.trim() || 'mock'
const appVersion = process.env.PPT_AGENT_APP_VERSION?.trim() || '0.1.0'
const heartbeatStaleMs = boundedMilliseconds('PPT_AGENT_HEARTBEAT_STALE_MS', 5_000, 1_000, 60_000)
const tickStaleMs = boundedMilliseconds('PPT_AGENT_TICK_STALE_MS', 15 * 60_000, 10_000, 60 * 60_000)
const waitingSlaMs = boundedMilliseconds('PPT_AGENT_WAITING_SLA_MS', 15 * 60_000, 10_000, 24 * 60 * 60_000)
const stepSlaMs = boundedMilliseconds('PPT_AGENT_STEP_SLA_MS', 30 * 60_000, 10_000, 24 * 60 * 60_000)
if (runtimeMode !== 'mock' && runtimeMode !== 'gateway') throw new Error('PPT_AGENT_RUNTIME_MODE_INVALID')
const images = runtimeMode === 'gateway'
  ? new GatewayImageGenerationPort({
      baseUrl: process.env.MODEL_GATEWAY_BASE_URL?.trim() || '',
      apiKey: process.env.MODEL_GATEWAY_IMAGE_KEY?.trim() || '',
      artifacts,
    })
  : undefined
const runtime = runtimeMode === 'gateway'
  ? (() => {
      const model = new GatewayCoursewareModel({
        baseUrl: process.env.MODEL_GATEWAY_BASE_URL?.trim() || '',
        apiKey: process.env.MODEL_GATEWAY_TEXT_KEY?.trim() || '',
        textModel: process.env.PPT_AGENT_TEXT_MODEL?.trim() || 'gpt-5.6',
        visionModel: process.env.PPT_AGENT_VISION_MODEL?.trim() || 'gpt-5.6',
        artifacts,
      })
      return createAgentRuntime({
        repository,
        artifacts,
        apiToken,
        images: images!,
        model,
        visualReviewer: model,
        deckReviewer: model,
        revisionPlanner: model,
        revisionApplication: model,
        frameFlowBackend: new HttpFrameFlowBackend({
          baseUrl: process.env.FRAMEFLOW_INTERNAL_BASE_URL?.trim() || 'http://127.0.0.1:3010',
          token: apiToken,
        }),
        appVersion,
        heartbeatStaleMs,
        tickStaleMs,
        waitingSlaMs,
        stepSlaMs,
      })
    })()
  : createMockRuntime({ repository, artifacts, apiToken, appVersion, heartbeatStaleMs, tickStaleMs, waitingSlaMs, stepSlaMs })
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

const server = Bun.serve({ hostname, port, fetch: runtime.handler })
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

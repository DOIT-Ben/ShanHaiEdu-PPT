import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { LocalArtifactPort } from './adapters/local-artifact-port'
import { GatewayImageGenerationPort } from './adapters/gateway-image-generation'
import { GatewayCoursewareModel } from './adapters/gateway-courseware-model'
import { HttpFrameFlowBackend } from './adapters/frameflow-http-backend'
import { SqliteAgentRepository } from './adapters/sqlite-repository'
import { createAgentRuntime, createMockRuntime } from './runtime/mock-runtime'

const hostname = process.env.PPT_AGENT_HOST?.trim() || '127.0.0.1'
if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
  throw new Error('PPT_AGENT_HOST_MUST_BE_LOOPBACK')
}
const port = Number(process.env.PPT_AGENT_PORT ?? 4310)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PPT_AGENT_PORT_INVALID')
const apiToken = process.env.PPT_AGENT_API_TOKEN?.trim()
if (!apiToken) throw new Error('PPT_AGENT_API_TOKEN_REQUIRED')
const dataRoot = path.resolve(process.env.PPT_AGENT_DATA_ROOT?.trim() || '.private/mock-runtime')
await mkdir(dataRoot, { recursive: true, mode: 0o700 })

const repository = new SqliteAgentRepository(path.join(dataRoot, 'agent.sqlite'))
const artifacts = new LocalArtifactPort(path.join(dataRoot, 'artifacts'))
const runtimeMode = process.env.PPT_AGENT_RUNTIME_MODE?.trim() || 'mock'
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
      })
    })()
  : createMockRuntime({ repository, artifacts, apiToken })
let ticking = false
const timer = setInterval(async () => {
  if (ticking) return
  ticking = true
  try {
    await runtime.tick()
  } catch (error) {
    console.error('[ppt-agent-worker]', error instanceof Error ? error.message : 'unknown error')
  } finally {
    ticking = false
  }
}, 500)

const server = Bun.serve({ hostname, port, fetch: runtime.handler })
console.log(`[ppt-agent] ${runtimeMode} runtime listening on ${server.url.origin}`)

const stop = () => {
  clearInterval(timer)
  server.stop(true)
  repository.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

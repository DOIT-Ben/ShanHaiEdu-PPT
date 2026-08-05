import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { LocalArtifactPort } from './adapters/local-artifact-port'
import { FixedServicePresentationJobBudgetPolicy } from './adapters/presentation-job-v2-ports'
import { SqlitePresentationJobV2Repository } from './adapters/presentation-job-v2-sqlite-repository'
import { PresentationJobV2ServiceTokenAuthentication } from './http/presentation-job-v2-service-authentication'
import { createPresentationJobV2ProviderFromEnv } from './runtime/presentation-job-v2-provider-config'
import { createPresentationJobV2Runtime } from './runtime/presentation-job-v2-runtime'
import { resolvePresentationJobV2ServerConfig } from './runtime/presentation-job-v2-server-config'

const config = resolvePresentationJobV2ServerConfig(process.env)
await mkdir(config.dataRoot, { recursive: true, mode: 0o700 })

const repository = new SqlitePresentationJobV2Repository(
  path.join(config.dataRoot, 'presentation-jobs.sqlite'),
)
const artifacts = new LocalArtifactPort(path.join(config.dataRoot, 'artifacts'))
const runtime = createPresentationJobV2Runtime({
  repository,
  artifacts,
  provider: createPresentationJobV2ProviderFromEnv(process.env),
  budget: new FixedServicePresentationJobBudgetPolicy(1),
  authentication: new PresentationJobV2ServiceTokenAuthentication([{
    tenantId: config.tenantId,
    token: config.apiToken,
  }]),
  tickBatchSize: config.tickBatchSize,
})

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{2,160}$/.test(message)
    ? message
    : 'PRESENTATION_JOB_V2_WORKER_FAILED'
}

let ticking = false
const timer = setInterval(async () => {
  if (ticking) return
  ticking = true
  try {
    const result = await runtime.tick()
    if (result.scannedJobs > 0) {
      console.log(JSON.stringify({ event: 'presentation_job_v2_tick_completed', ...result }))
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: 'presentation_job_v2_tick_failed',
      errorCode: safeErrorCode(error),
    }))
  } finally {
    ticking = false
  }
}, config.tickIntervalMs)

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  idleTimeout: 30,
  fetch: runtime.handler,
})
console.log(JSON.stringify({
  event: 'presentation_job_v2_service_started',
  origin: server.url.origin,
  providerMode: process.env.PPT_AGENT_V2_PROVIDER_MODE?.trim(),
}))

function stop() {
  clearInterval(timer)
  server.stop(true)
  repository.close()
  process.exit(0)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)

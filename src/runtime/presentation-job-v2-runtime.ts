import type { ArtifactPort, ClockPort } from '../core/ports'
import { PresentationJobV2Service } from '../core/presentation-job-v2-service'
import type {
  PresentationJobV2BudgetPolicy,
  PresentationJobV2ProviderPort,
  PresentationJobV2Repository,
} from '../core/presentation-job-v2-ports'
import {
  createPresentationJobV2HttpHandler,
  type PresentationJobV2AuthenticationPort,
} from '../http/presentation-job-v2-handler'
import { PRESENTATION_JOB_V2_OPENAPI_DOCUMENT_JSON } from '../http/presentation-job-v2-openapi-document'
import { PRESENTATION_JOB_V2_CONTRACT_VERSION } from '../presentation-job-v2-contracts'

const defaultClock: ClockPort = { now: () => new Date() }

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-PPT-Agent-Contract-Version': PRESENTATION_JOB_V2_CONTRACT_VERSION,
    },
  })
}

function openApiResponse() {
  return new Response(PRESENTATION_JOB_V2_OPENAPI_DOCUMENT_JSON, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/vnd.oai.openapi+json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-PPT-Agent-Contract-Version': PRESENTATION_JOB_V2_CONTRACT_VERSION,
    },
  })
}

export function createPresentationJobV2Runtime(input: Readonly<{
  repository: PresentationJobV2Repository
  artifacts: ArtifactPort
  provider: PresentationJobV2ProviderPort
  budget: PresentationJobV2BudgetPolicy
  authentication: PresentationJobV2AuthenticationPort
  clock?: ClockPort
  tickBatchSize?: number
}>) {
  const clock = input.clock ?? defaultClock
  const tickBatchSize = input.tickBatchSize ?? 25
  if (!Number.isSafeInteger(tickBatchSize) || tickBatchSize < 1 || tickBatchSize > 1_000) {
    throw new Error('PRESENTATION_JOB_V2_TICK_BATCH_SIZE_INVALID')
  }
  const service = new PresentationJobV2Service({
    repository: input.repository,
    artifacts: input.artifacts,
    provider: input.provider,
    budget: input.budget,
    clock,
  })
  const handleV2 = createPresentationJobV2HttpHandler({
    service,
    artifacts: input.artifacts,
    authentication: input.authentication,
  })

  return {
    async handler(request: Request) {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health/live') {
        return json({
          service: 'ppt-agent-presentation-job-v2',
          status: 'LIVE',
          checkedAt: clock.now().toISOString(),
        })
      }
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        return json({
          service: 'ppt-agent-presentation-job-v2',
          status: 'READY',
          checkedAt: clock.now().toISOString(),
        })
      }
      if (request.method === 'GET' && url.pathname === '/openapi/v2.json') return openApiResponse()
      return handleV2(request)
    },
    tick() {
      return service.tick({ limit: tickBatchSize })
    },
  }
}

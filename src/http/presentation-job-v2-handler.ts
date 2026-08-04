import { createHash, randomUUID } from 'node:crypto'
import type { ArtifactPort } from '../core/ports'
import { PresentationJobV2Error, PresentationJobV2Service } from '../core/presentation-job-v2-service'
import type { PresentationJobV2Owner } from '../core/presentation-job-v2-ports'
import { PRESENTATION_JOB_V2_CONTRACT_VERSION } from '../presentation-job-v2-contracts'

const OPENAPI_PATH = '/openapi/v2.json'
const OPENAPI_LINK = `<${OPENAPI_PATH}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`

export interface PresentationJobV2AuthenticationPort {
  authenticateService(request: Request): Promise<Readonly<{ tenantId: string }> | null>
}

export type PresentationJobV2HandlerDependencies = Readonly<{
  service: PresentationJobV2Service
  artifacts: ArtifactPort
  authentication: PresentationJobV2AuthenticationPort
}>

function validIdentifier(value: string) {
  return value.length >= 1 && value.length <= 160 && value === value.trim()
}

function contractHeaders(headers?: HeadersInit) {
  const result = new Headers(headers)
  result.set('Link', OPENAPI_LINK)
  result.set('X-PPT-Agent-Contract-Version', PRESENTATION_JOB_V2_CONTRACT_VERSION)
  result.set('X-Content-Type-Options', 'nosniff')
  return result
}

function response(data: unknown, status = 200, headers?: HeadersInit) {
  const result = contractHeaders(headers)
  if (!result.has('Cache-Control')) result.set('Cache-Control', 'no-store')
  return Response.json(data, { status, headers: result })
}

function errorResponse(
  status: number,
  code: string,
  requestId: string,
  jobId: string | null = null,
  retryable = false,
) {
  return response({
    contractVersion: PRESENTATION_JOB_V2_CONTRACT_VERSION,
    error: {
      code,
      message: code === 'UNAUTHENTICATED' ? 'authentication is required' : 'request could not be completed',
      retryable,
      action: retryable ? 'WAIT' : 'NONE',
      requestId,
      jobId,
    },
  }, status)
}

async function principal(
  dependencies: PresentationJobV2HandlerDependencies,
  request: Request,
  requestId: string,
): Promise<PresentationJobV2Owner | Response> {
  if (request.headers.has('X-PPT-Agent-Tenant')) {
    return errorResponse(400, 'TENANT_HEADER_NOT_ALLOWED', requestId)
  }
  const authenticated = await dependencies.authentication.authenticateService(request)
  if (!authenticated) return errorResponse(401, 'UNAUTHENTICATED', requestId)
  const externalUserId = request.headers.get('X-PPT-Agent-User')
  const externalProjectId = request.headers.get('X-PPT-Agent-Project')
  if (!externalUserId || !validIdentifier(externalUserId)) {
    return errorResponse(400, 'EXTERNAL_USER_ID_REQUIRED', requestId)
  }
  if (externalProjectId !== null && !validIdentifier(externalProjectId)) {
    return errorResponse(400, 'EXTERNAL_PROJECT_ID_INVALID', requestId)
  }
  return {
    tenantId: authenticated.tenantId,
    externalUserId,
    externalProjectId,
  }
}

function verifiedBody(stream: ReadableStream<Uint8Array>, byteLength: number, sha256: string) {
  const reader = stream.getReader()
  const digest = createHash('sha256')
  let read = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()
      if (next.done) {
        if (read !== byteLength || digest.digest('hex') !== sha256) {
          controller.error(new Error('PRESENTATION_ARTIFACT_INTEGRITY_FAILED'))
        } else {
          controller.close()
        }
        return
      }
      read += next.value.length
      digest.update(next.value)
      if (read > byteLength) {
        controller.error(new Error('PRESENTATION_ARTIFACT_INTEGRITY_FAILED'))
        await reader.cancel()
        return
      }
      controller.enqueue(next.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}

function safeFilename(name: string) {
  return name.replace(/["\\\r\n]/g, '_')
}

function isResponse(value: PresentationJobV2Owner | Response): value is Response {
  return value instanceof Response
}

export async function handlePresentationJobV2Request(
  dependencies: PresentationJobV2HandlerDependencies,
  request: Request,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'v2' || parts[1] !== 'presentation-jobs') {
    return errorResponse(404, 'NOT_FOUND', requestId)
  }
  const owner = await principal(dependencies, request, requestId)
  if (isResponse(owner)) return owner
  const jobId = parts[2]
  try {
    if (parts.length === 2 && request.method === 'POST') {
      const idempotencyKey = request.headers.get('Idempotency-Key')?.trim()
      if (!idempotencyKey || !validIdentifier(idempotencyKey)) {
        return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', requestId)
      }
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse(400, 'INVALID_JSON', requestId)
      const created = await dependencies.service.create(owner, body, idempotencyKey)
      return response({
        contractVersion: PRESENTATION_JOB_V2_CONTRACT_VERSION,
        requestId,
        data: created.job,
        replayed: created.replayed,
      }, created.replayed ? 200 : 201)
    }

    if (!jobId || !validIdentifier(jobId)) return errorResponse(404, 'NOT_FOUND', requestId)
    if (parts.length === 3 && request.method === 'GET') {
      return response({
        contractVersion: PRESENTATION_JOB_V2_CONTRACT_VERSION,
        requestId,
        data: await dependencies.service.getOwned(owner, jobId),
      })
    }
    if (parts.length === 4 && parts[3] === 'usage' && request.method === 'GET') {
      return response({
        contractVersion: PRESENTATION_JOB_V2_CONTRACT_VERSION,
        requestId,
        data: await dependencies.service.getUsageOwned(owner, jobId),
      })
    }
    if (parts.length === 5 && parts[3] === 'artifacts' && request.method === 'GET') {
      const artifactId = parts[4]
      if (!artifactId || !validIdentifier(artifactId)) return errorResponse(404, 'NOT_FOUND', requestId, jobId)
      const artifact = await dependencies.service.getArtifactOwned(owner, jobId, artifactId)
      if (request.headers.has('Range')) {
        return new Response(null, {
          status: 416,
          headers: contractHeaders({
            'Accept-Ranges': 'none',
            'Content-Range': `bytes */${artifact.byteLength}`,
            'Cache-Control': 'no-store',
          }),
        })
      }
      const opened = await dependencies.artifacts.open({ tenantId: owner.tenantId, artifactId: artifact.artifactId })
      if (!opened
        || opened.mimeType !== artifact.mimeType
        || opened.byteLength !== artifact.byteLength
        || opened.sha256 !== artifact.sha256) {
        return errorResponse(404, 'PRESENTATION_ARTIFACT_NOT_FOUND', requestId, jobId)
      }
      return new Response(verifiedBody(opened.stream, artifact.byteLength, artifact.sha256), {
        status: 200,
        headers: contractHeaders({
          'Accept-Ranges': 'none',
          'Cache-Control': 'private, no-store',
          'Content-Disposition': `attachment; filename="${safeFilename(artifact.name)}"`,
          'Content-Length': String(artifact.byteLength),
          'Content-Type': artifact.mimeType,
          ETag: `"${artifact.sha256}"`,
          'X-PPT-Agent-Artifact-ID': artifact.artifactId,
          'X-PPT-Agent-Content-SHA256': artifact.sha256,
        }),
      })
    }
    return errorResponse(404, 'NOT_FOUND', requestId, jobId)
  } catch (error) {
    if (error instanceof PresentationJobV2Error) {
      return errorResponse(
        error.status,
        error.code,
        requestId,
        jobId ?? null,
        error.status >= 500,
      )
    }
    return errorResponse(500, 'INTERNAL_ERROR', requestId, jobId ?? null, true)
  }
}

export function createPresentationJobV2HttpHandler(dependencies: PresentationJobV2HandlerDependencies) {
  return async (request: Request) => {
    const supplied = request.headers.get('X-Request-ID')?.trim()
    const requestId = supplied && validIdentifier(supplied) ? supplied : randomUUID()
    return await handlePresentationJobV2Request(dependencies, request, requestId)
  }
}

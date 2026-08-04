import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { HttpPresentationJobV2Provider } from '../src/adapters/http-presentation-job-v2-provider'
import {
  approvedPageDesignSnapshotHash,
  approvedPageDesignSnapshotSchema,
} from '../src/presentation-job-v2-contracts'

const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])
const pptxSha256 = createHash('sha256').update(pptxBytes).digest('hex')
const snapshot = approvedPageDesignSnapshotSchema.parse({
  schemaVersion: '1',
  title: '植物生长',
  subject: '科学',
  gradeBand: '小学二年级',
  lessonDurationMinutes: 40,
  audience: '小学二年级学生',
  objectives: ['说明植物生长的基本条件'],
  pages: [1, 2].map((pageNumber) => ({
    pageNumber,
    title: `第${pageNumber}页`,
    teachingPurpose: '建立可验证的科学概念。',
    editableCopy: ['阳光', '水', '空气'],
    layoutIntent: '中心主体配合三项条件。',
    visualRequirements: ['主体清晰且没有版权风险'],
    teacherNotes: '引导学生观察。',
    teacherScript: '请说出植物需要什么。',
    studentActivity: '选择正确条件。',
    animationSequence: ['主体出现', '条件依次出现'],
    boardPlan: '写出三个条件。',
    evidence: [{ type: 'FACT', text: '植物生长需要水和适宜光照。', source: '科学教材' }],
  })),
})

const source = {
  kind: 'APPROVED_PAGE_DESIGN' as const,
  artifactVersionId: 'approved-design-v7',
  sha256: approvedPageDesignSnapshotHash(snapshot),
  snapshot,
}

describe('HTTP Presentation Job V2 provider', () => {
  test('submits only the immutable provider input and validates a completed PPTX artifact', async () => {
    const requests: Request[] = []
    let inspection = 0
    const provider = new HttpPresentationJobV2Provider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'provider-token-for-contract-tests',
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (request.method === 'POST') {
          return Response.json({ operationId: 'operation-7' }, { status: 202 })
        }
        if (request.url.endsWith('/artifact')) {
          return new Response(pptxBytes, {
            headers: {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              'Content-Length': String(pptxBytes.length),
              'X-Content-SHA256': pptxSha256,
            },
          })
        }
        inspection += 1
        return inspection === 1
          ? Response.json({ state: 'RUNNING', retryAfterMs: 2_000 })
          : Response.json({
              state: 'COMPLETED',
              quality: 'PASSED',
              billingStatus: 'SETTLED',
              artifact: {
                name: 'lesson.pptx',
                mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                byteLength: pptxBytes.length,
                sha256: pptxSha256,
              },
            })
      },
    })

    const submitted = await provider.submit({
      jobId: 'presentation-job-7',
      owner: { tenantId: 'tenant-a', externalUserId: 'private-user', externalProjectId: 'private-project' },
      source,
      idempotencyKey: 'presentation-job-7:provider:1',
    })
    const running = await provider.inspect({
      jobId: 'presentation-job-7',
      operationId: submitted.operationId,
      idempotencyKey: 'presentation-job-7:provider:1',
    })
    const completed = await provider.inspect({
      jobId: 'presentation-job-7',
      operationId: submitted.operationId,
      idempotencyKey: 'presentation-job-7:provider:1',
    })

    expect(submitted).toEqual({ operationId: 'operation-7' })
    expect(running).toEqual({ state: 'RUNNING', retryAfterMs: 2_000 })
    expect(completed).toEqual({
      state: 'COMPLETED',
      quality: 'PASSED',
      billingStatus: 'SETTLED',
      artifact: {
        bytes: pptxBytes,
        name: 'lesson.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    })
    expect(requests).toHaveLength(4)
    expect(requests[0]!.url).toBe('https://provider.example/v1/presentation-operations')
    expect(requests[0]!.headers.get('Idempotency-Key')).toBe('presentation-job-7:provider:1')
    expect(await requests[0]!.clone().json()).toEqual({
      contractVersion: '1.0',
      jobId: 'presentation-job-7',
      source,
    })
    expect(JSON.stringify(await requests[0]!.clone().json())).not.toContain('private-user')
    expect(requests[3]!.url).toBe('https://provider.example/v1/presentation-operations/operation-7/artifact')
  })

  test('rejects insecure endpoints and corrupted provider artifacts', async () => {
    expect(() => new HttpPresentationJobV2Provider({
      baseUrl: 'http://provider.example/v1',
      apiKey: 'provider-token-for-contract-tests',
    })).toThrow('PRESENTATION_PROVIDER_BASE_URL_INSECURE')

    const provider = new HttpPresentationJobV2Provider({
      baseUrl: 'http://127.0.0.1:4999/v1',
      apiKey: 'provider-token-for-contract-tests',
      fetchImpl: async (input) => String(input).endsWith('/artifact')
        ? new Response(pptxBytes, {
            headers: {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              'Content-Length': String(pptxBytes.length),
              'X-Content-SHA256': '0'.repeat(64),
            },
          })
        : Response.json({
            state: 'COMPLETED', quality: 'PASSED', billingStatus: 'UNKNOWN',
            artifact: {
              name: 'lesson.pptx',
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              byteLength: pptxBytes.length,
              sha256: pptxSha256,
            },
          }),
    })

    await expect(provider.inspect({
      jobId: 'presentation-job-7',
      operationId: 'operation-7',
      idempotencyKey: 'presentation-job-7:provider:1',
    })).rejects.toThrow('PRESENTATION_PROVIDER_ARTIFACT_INTEGRITY_FAILED')
  })

  test('maps provider failures without downloading an artifact', async () => {
    let calls = 0
    const provider = new HttpPresentationJobV2Provider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'provider-token-for-contract-tests',
      fetchImpl: async () => {
        calls += 1
        return Response.json({
          state: 'FAILED',
          errorCode: 'PROVIDER_SAFETY_BLOCKED',
          billingStatus: 'SETTLED',
        })
      },
    })

    expect(await provider.inspect({
      jobId: 'presentation-job-7',
      operationId: 'operation-7',
      idempotencyKey: 'presentation-job-7:provider:1',
    })).toEqual({
      state: 'FAILED',
      errorCode: 'PROVIDER_SAFETY_BLOCKED',
      billingStatus: 'SETTLED',
    })
    expect(calls).toBe(1)
  })

  test('maps delivery-blocking quality to failure without downloading an artifact', async () => {
    let calls = 0
    const provider = new HttpPresentationJobV2Provider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'provider-token-for-contract-tests',
      fetchImpl: async (input) => {
        calls += 1
        if (String(input).endsWith('/artifact')) throw new Error('blocking artifacts must not be downloaded')
        return Response.json({
          state: 'COMPLETED',
          quality: 'BLOCKING_FAILURE',
          billingStatus: 'SETTLED',
          artifact: {
            name: 'blocked.pptx',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            byteLength: pptxBytes.length,
            sha256: pptxSha256,
          },
        })
      },
    })

    await expect(provider.inspect({
      jobId: 'presentation-job-7',
      operationId: 'operation-7',
      idempotencyKey: 'presentation-job-7:provider:1',
    })).resolves.toEqual({
      state: 'FAILED',
      errorCode: 'DELIVERY_BLOCKED_BY_QUALITY',
      billingStatus: 'SETTLED',
    })
    expect(calls).toBe(1)
  })
})

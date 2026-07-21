import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { HttpFrameFlowBackend } from '../src/adapters/frameflow-http-backend'

const token = 'test-agent-token-0001'

describe('FrameFlow internal source backend', () => {
  test('loads a controlled source package with server authentication and verified bytes', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let headers = new Headers()
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010',
      token,
      fetchImpl: async (_url, init) => {
        headers = new Headers(init?.headers)
        return Response.json({ data: {
          name: '叶片.png', kind: 'IMAGE', mimeType: 'image/png', status: 'READY', textTruncated: false,
          chunks: [],
          assets: [{
            id: 'asset-1', sourceId: 'attachment-1', name: '叶片.png', mimeType: 'image/png',
            byteLength: bytes.length, sha256, width: 80, height: 60,
            contentBase64: Buffer.from(bytes).toString('base64'),
          }],
        } })
      },
    })

    const result = await backend.getDocumentAttachment({ externalUserId: 'teacher-1', attachmentId: 'attachment-1' })

    expect(headers.get('Authorization')).toBe(`Bearer ${token}`)
    expect(headers.get('X-PPT-Agent-User')).toBe('teacher-1')
    expect(result).toMatchObject({ status: 'READY', assets: [{ id: 'asset-1', bytes }] })
  })

  test('surfaces one unavailable attachment as a visible source failure', async () => {
    const backend = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token, fetchImpl: async () => new Response(null, { status: 404 }),
    })
    expect(await backend.getDocumentAttachment({ externalUserId: 'teacher-1', attachmentId: 'missing-1' }))
      .toMatchObject({ status: 'FAILED', failureCode: 'SOURCE_ENDPOINT_HTTP_404' })
  })

  test('turns corrupt source image bytes into a visible attachment failure', async () => {
    const client = new HttpFrameFlowBackend({
      baseUrl: 'http://127.0.0.1:3010', token: 'test-internal-token-0001',
      fetchImpl: async () => Response.json({ data: {
        name: '教材图.png', kind: 'IMAGE', mimeType: 'image/png', status: 'READY', textTruncated: false,
        chunks: [], assets: [{
          id: 'asset-1', sourceId: 'attachment-1', name: '教材图.png', mimeType: 'image/png',
          byteLength: 8, sha256: 'a'.repeat(64), width: 32, height: 32,
          contentBase64: Buffer.from('not-image').toString('base64'),
        }],
      } }),
    })

    await expect(client.getDocumentAttachment({ externalUserId: 'teacher-1', attachmentId: 'attachment-1' }))
      .resolves.toMatchObject({ status: 'FAILED', failureCode: 'SOURCE_ASSET_INTEGRITY_MISMATCH' })
  })

  test('rejects non-loopback source endpoints', () => {
    expect(() => new HttpFrameFlowBackend({ baseUrl: 'https://frameflow.example.com', token })).toThrow('MUST_BE_LOOPBACK')
  })
})

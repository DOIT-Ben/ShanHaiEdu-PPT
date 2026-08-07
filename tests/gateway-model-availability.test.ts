import { describe, expect, test } from 'bun:test'
import {
  GatewayModelAvailabilityProbe,
  MAX_GATEWAY_MODEL_DIRECTORY_BYTES,
} from '../src/adapters/gateway-model-availability'

describe('gateway model availability probe', () => {
  test('uses the non-generative gateway model directory and accepts only bounded model identifiers', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = []
    const probe = new GatewayModelAvailabilityProbe({
      baseUrl: 'https://newapi.doitbenai.cloud/v1',
      apiKey: 'test-directory-key-0001',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        return Response.json({ data: [
          { id: 'gpt-5.6-terra' },
          { id: 'gemini-3-pro-image-preview' },
          { id: 'ignored-unknown-field', owner: 'must-not-be-returned' },
        ] })
      },
    })

    await expect(probe.listModels()).resolves.toEqual([
      'gpt-5.6-terra', 'gemini-3-pro-image-preview', 'ignored-unknown-field',
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://newapi.doitbenai.cloud/v1/models')
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer test-directory-key-0001')
    expect(requests[0]?.init?.method).toBe('GET')
  })

  test('fails closed for malformed directories, rejected responses, insecure endpoints and invalid credentials', async () => {
    const malformed = new GatewayModelAvailabilityProbe({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-directory-key-0001',
      fetchImpl: async () => Response.json({ data: [{ id: 'valid' }, { id: '' }] }),
    })
    await expect(malformed.listModels()).rejects.toThrow('GATEWAY_MODEL_DIRECTORY_INVALID')

    const rejected = new GatewayModelAvailabilityProbe({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-directory-key-0001',
      fetchImpl: async () => Response.json({ error: { code: 'provider-private-detail' } }, { status: 503 }),
    })
    await expect(rejected.listModels()).rejects.toThrow('GATEWAY_MODEL_DIRECTORY_UNAVAILABLE')

    expect(() => new GatewayModelAvailabilityProbe({
      baseUrl: 'http://gateway.example/v1', apiKey: 'test-directory-key-0001',
    })).toThrow('GATEWAY_BASE_URL_INSECURE')
    expect(() => new GatewayModelAvailabilityProbe({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'short',
    })).toThrow('GATEWAY_MODEL_DIRECTORY_KEY_REQUIRED')
  })

  test('rejects oversized declared and chunked model directories before JSON parsing', async () => {
    const declaredOversize = new GatewayModelAvailabilityProbe({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-directory-key-0001',
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":[]}'))
          controller.close()
        },
      }), { headers: { 'Content-Length': String(MAX_GATEWAY_MODEL_DIRECTORY_BYTES + 1) } }),
    })
    await expect(declaredOversize.listModels()).rejects.toThrow('GATEWAY_MODEL_DIRECTORY_INVALID')

    let emitted = 0
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024))
    const chunkedOversize = new GatewayModelAvailabilityProbe({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-directory-key-0001',
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) {
          if (emitted >= 17) {
            controller.close()
            return
          }
          emitted += 1
          controller.enqueue(chunk)
        },
      })),
    })
    await expect(chunkedOversize.listModels()).rejects.toThrow('GATEWAY_MODEL_DIRECTORY_INVALID')
  })
})

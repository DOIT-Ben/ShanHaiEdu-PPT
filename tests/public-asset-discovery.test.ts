import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { isPublicAddress, PublicAssetDiscoveryPort } from '../src/adapters/public-asset-discovery'
import type { AssetCandidate } from '../src/core/ports'

const candidate: AssetCandidate = {
  provider: 'OPENVERSE', providerAssetId: 'asset-1', title: 'Earth from space',
  sourceUrl: 'https://example.org/earth', downloadUrl: 'https://cdn.example.org/earth.png',
  creator: 'Example Author', license: 'CC_BY', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Earth from space by Example Author', mimeType: 'image/png', width: 1200, height: 800,
}

describe('public asset discovery', () => {
  test('rejects private, loopback, metadata and documentation addresses', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('10.0.0.8')).toBe(false)
    expect(isPublicAddress('169.254.169.254')).toBe(false)
    expect(isPublicAddress('192.168.1.1')).toBe(false)
    expect(isPublicAddress('203.0.113.8')).toBe(false)
    expect(isPublicAddress('::1')).toBe(false)
    expect(isPublicAddress('2001:db8::1')).toBe(false)
    expect(isPublicAddress('8.8.8.8')).toBe(true)
  })

  test('downloads and verifies a public image before returning controlled bytes', async () => {
    const png = new Uint8Array(await sharp({
      create: { width: 320, height: 240, channels: 4, background: '#2A78C5' },
    }).png().toBuffer())
    const port = new PublicAssetDiscoveryPort({
      resolveHost: async () => ['8.8.8.8'],
      fetchImpl: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    })
    const result = await port.acquire({ tenantId: 'frameflow', candidate, idempotencyKey: 'acquire-1' })

    expect(result.candidate).toMatchObject({ width: 320, height: 240, mimeType: 'image/png' })
    expect(result.bytes).toEqual(png)
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test('blocks downloads when DNS resolves to a private address', async () => {
    let fetched = false
    const port = new PublicAssetDiscoveryPort({
      resolveHost: async () => ['169.254.169.254'],
      fetchImpl: async () => { fetched = true; return new Response() },
    })
    await expect(port.acquire({ tenantId: 'frameflow', candidate, idempotencyKey: 'acquire-2' }))
      .rejects.toThrow('ASSET_URL_REJECTED')
    expect(fetched).toBe(false)
  })

  test('rejects content whose decoded format does not match the candidate MIME', async () => {
    const jpeg = new Uint8Array(await sharp({
      create: { width: 320, height: 240, channels: 3, background: '#2A78C5' },
    }).jpeg().toBuffer())
    const port = new PublicAssetDiscoveryPort({
      resolveHost: async () => ['8.8.8.8'],
      fetchImpl: async () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    })
    await expect(port.acquire({ tenantId: 'frameflow', candidate, idempotencyKey: 'acquire-3' }))
      .rejects.toThrow('ASSET_MIME_MISMATCH')
  })
})

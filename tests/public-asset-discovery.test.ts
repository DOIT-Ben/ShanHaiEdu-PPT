import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import {
  buildAssetSearchQueries,
  candidatePassesTextGate,
  isPublicAddress,
  normalizeWebAssetBytes,
  PublicAssetDiscoveryPort,
} from '../src/adapters/public-asset-discovery'
import type { AssetCandidate } from '../src/core/ports'

const candidate: AssetCandidate = {
  provider: 'OPENVERSE', providerAssetId: 'asset-1', title: 'Earth from space',
  sourceUrl: 'https://example.org/earth', downloadUrl: 'https://cdn.example.org/earth.png',
  creator: 'Example Author', license: 'CC_BY', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Earth from space by Example Author', mimeType: 'image/png', width: 1200, height: 800,
}

describe('public asset discovery', () => {
  test('removes license and view modifiers while preserving the subject noun', () => {
    expect(buildAssetSearchQueries(['NASA Blue Marble full Earth public domain']))
      .toEqual(['nasa blue marble full earth', 'nasa blue marble earth', 'blue marble earth'])
    expect(buildAssetSearchQueries(['flashlight side view CC0'])).toEqual(['flashlight side view', 'flashlight'])
  })

  test('rejects weakly related and child-unsafe titles before download', () => {
    expect(candidatePassesTextGate({ title: 'Grundschule Naußlitz 05.jpg' }, 'classroom globe')).toBe(false)
    expect(candidatePassesTextGate({ title: 'Antique classroom globe' }, 'classroom globe')).toBe(true)
    expect(candidatePassesTextGate({ title: 'FN P90 with flashlight and suppressor' }, 'flashlight')).toBe(false)
    expect(candidatePassesTextGate({ title: 'Small LED flashlight' }, 'flashlight')).toBe(true)
    expect(candidatePassesTextGate({ title: 'Rainbow flashlight e-cig mod' }, 'flashlight')).toBe(false)
  })

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
    expect(result.bytes).not.toEqual(png)
    expect(await sharp(result.bytes).metadata()).toMatchObject({ format: 'png', width: 320, height: 240 })
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

  test('normalizes oversized photos for repeated PPTX placement', async () => {
    const original = new Uint8Array(await sharp({
      create: { width: 3_200, height: 2_400, channels: 3, background: '#2A78C5' },
    }).jpeg({ quality: 95 }).toBuffer())
    const normalized = await normalizeWebAssetBytes(original, 'image/jpeg')
    const metadata = await sharp(normalized.bytes).metadata()

    expect(metadata.width).toBe(2_048)
    expect(metadata.height).toBe(1_536)
    expect(normalized.bytes.length).toBeLessThan(original.length)
  })
})

import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import sharp from 'sharp'
import { z } from 'zod'
import type { AssetCandidate, AssetDiscoveryPort, AssetLicense } from '../core/ports'

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type ResolveHost = (hostname: string) => Promise<readonly string[]>

const MAX_BYTES = 24 * 1024 * 1024
const MAX_PIXELS = 40_000_000
const MAX_REDIRECTS = 3
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])

const openverseSchema = z.object({
  results: z.array(z.object({
    id: z.string(), title: z.string().nullable(), foreign_landing_url: z.string().url(), url: z.string().url(),
    creator: z.string().nullable(), license: z.string(), license_url: z.string().url().nullable(),
    attribution: z.string().nullable(), width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(), mature: z.boolean().default(false),
  }).passthrough()).default([]),
}).passthrough()

const commonsSchema = z.object({
  query: z.object({
    pages: z.record(z.string(), z.object({
      pageid: z.number().int(), title: z.string(),
      imageinfo: z.array(z.object({
        width: z.number().int().positive(), height: z.number().int().positive(), url: z.string().url(),
        descriptionurl: z.string().url(), mime: z.string(),
        extmetadata: z.record(z.string(), z.object({ value: z.unknown() }).passthrough()).default({}),
      }).passthrough()).min(1),
    }).passthrough()).default({}),
  }).passthrough().optional(),
}).passthrough()

function mimeType(value: string) {
  return ALLOWED_MIME.has(value) ? value as AssetCandidate['mimeType'] : null
}

function plainMetadata(value: unknown) {
  if (typeof value !== 'string') return null
  const plain = value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim()
  return plain.length > 0 ? plain.slice(0, 500) : null
}

function commonsLicense(metadata: Record<string, { value: unknown }>) {
  const code = String(metadata.License?.value ?? '').toLowerCase()
  const shortName = String(metadata.LicenseShortName?.value ?? '').toLowerCase()
  if (code.includes('cc-by-sa') || shortName.includes('by-sa')) return null
  if (code === 'cc-zero' || shortName.includes('cc0')) return 'CC0' as const
  if (/^cc-by-[0-9]/.test(code) || /^cc by [0-9]/.test(shortName)) return 'CC_BY' as const
  if (code === 'pd' || shortName.includes('public domain')) return 'PUBLIC_DOMAIN' as const
  return null
}

function openverseLicense(value: string): AssetLicense | null {
  if (value === 'cc0') return 'CC0'
  if (value === 'by') return 'CC_BY'
  if (value === 'pdm') return 'PUBLIC_DOMAIN'
  return null
}

function ipv4Public(address: string) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const a = parts[0]!
  const b = parts[1]!
  const c = parts[2]!
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

export function isPublicAddress(address: string) {
  const normalized = address.toLowerCase()
  if (isIP(normalized) === 4) return ipv4Public(normalized)
  if (isIP(normalized) !== 6) return false
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea')
    || normalized.startsWith('feb') || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  return mapped ? ipv4Public(mapped[1]!) : true
}

function scoreCandidate(candidate: AssetCandidate, query: string, ratio: number, preferTransparent: boolean) {
  const title = candidate.title.toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length >= 3)
  const relevance = words.reduce((score, word) => score + (title.includes(word) ? 8 : 0), 0)
  const candidateRatio = candidate.width / candidate.height
  const ratioScore = Math.max(0, 10 - Math.abs(Math.log(candidateRatio / ratio)) * 8)
  const transparencyScore = preferTransparent && candidate.mimeType === 'image/png' ? 4 : 0
  return relevance + ratioScore + transparencyScore + Math.min(6, Math.log10(candidate.width * candidate.height))
}

export class PublicAssetDiscoveryPort implements AssetDiscoveryPort {
  private readonly fetchImpl: Fetch
  private readonly resolveHost: ResolveHost

  constructor(input: Readonly<{ fetchImpl?: Fetch; resolveHost?: ResolveHost; proxyUrl?: string }> = {}) {
    this.fetchImpl = input.fetchImpl ?? (input.proxyUrl
      ? ((url, init) => fetch(url, { ...init, proxy: input.proxyUrl } as RequestInit)) as Fetch
      : fetch)
    this.resolveHost = input.resolveHost ?? (async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address))
  }

  async search(input: Parameters<AssetDiscoveryPort['search']>[0]) {
    const query = input.intent.searchQueries[0]!
    const results = await Promise.allSettled([this.searchCommons(query), this.searchOpenverse(query)])
    const candidates = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    const ratio = ({ '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '3:4': 3 / 4 } as const)[input.aspectRatio]
    const preferTransparent = input.intent.transparencyPreference === 'PREFER_TRANSPARENT'
    return candidates
      .filter((candidate) => candidate.width >= 256 && candidate.height >= 256)
      .sort((left, right) => scoreCandidate(right, query, ratio, preferTransparent) - scoreCandidate(left, query, ratio, preferTransparent))
      .slice(0, 12)
  }

  async acquire(input: Parameters<AssetDiscoveryPort['acquire']>[0]) {
    const response = await this.safeFetch(new URL(input.candidate.downloadUrl), 0)
    if (!response.ok) throw new Error('ASSET_DOWNLOAD_REJECTED')
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > MAX_BYTES) throw new Error('ASSET_TOO_LARGE')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new Error('ASSET_TOO_LARGE')
    const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata()
    const actualMime = metadata.format === 'png' ? 'image/png'
      : metadata.format === 'jpeg' ? 'image/jpeg'
        : metadata.format === 'webp' ? 'image/webp' : null
    if (!actualMime || actualMime !== input.candidate.mimeType) throw new Error('ASSET_MIME_MISMATCH')
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) throw new Error('ASSET_DIMENSIONS_INVALID')
    return {
      candidate: { ...input.candidate, width: metadata.width, height: metadata.height },
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }

  private async searchOpenverse(query: string) {
    const url = new URL('https://api.openverse.org/v1/images/')
    url.searchParams.set('q', query)
    url.searchParams.set('license', 'cc0,by,pdm')
    url.searchParams.set('page_size', '12')
    const parsed = openverseSchema.parse(await this.fetchJson(url))
    return parsed.results.flatMap((item): AssetCandidate[] => {
      const license = openverseLicense(item.license)
      const inferredMime = mimeType(new URL(item.url).pathname.toLowerCase().endsWith('.png') ? 'image/png'
        : new URL(item.url).pathname.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg')
      if (!license || !inferredMime || item.mature || !item.width || !item.height || !item.license_url) return []
      return [{
        provider: 'OPENVERSE', providerAssetId: item.id, title: item.title ?? query,
        sourceUrl: item.foreign_landing_url, downloadUrl: item.url, creator: item.creator,
        license, licenseUrl: item.license_url, attribution: item.attribution,
        mimeType: inferredMime, width: item.width, height: item.height,
      }]
    })
  }

  private async searchCommons(query: string) {
    const url = new URL('https://commons.wikimedia.org/w/api.php')
    for (const [key, value] of Object.entries({
      action: 'query', generator: 'search', gsrsearch: `filetype:bitmap ${query}`, gsrnamespace: '6', gsrlimit: '12',
      prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', format: 'json', origin: '*',
    })) url.searchParams.set(key, value)
    const parsed = commonsSchema.parse(await this.fetchJson(url))
    return Object.values(parsed.query?.pages ?? {}).flatMap((page): AssetCandidate[] => {
      const image = page.imageinfo[0]!
      const license = commonsLicense(image.extmetadata)
      const parsedMime = mimeType(image.mime)
      const licenseUrl = plainMetadata(image.extmetadata.LicenseUrl?.value)
      if (!license || !parsedMime || !licenseUrl) return []
      const creator = plainMetadata(image.extmetadata.Artist?.value)
      return [{
        provider: 'WIKIMEDIA_COMMONS', providerAssetId: String(page.pageid), title: page.title.replace(/^File:/, ''),
        sourceUrl: image.descriptionurl, downloadUrl: image.url, creator, license, licenseUrl,
        attribution: creator ? `${page.title.replace(/^File:/, '')} by ${creator}` : null,
        mimeType: parsedMime, width: image.width, height: image.height,
      }]
    })
  }

  private async fetchJson(url: URL) {
    const response = await this.fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'PPT-Agent/0.1 asset-discovery' }, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error('ASSET_SEARCH_REJECTED')
    return response.json()
  }

  private async safeFetch(url: URL, redirects: number): Promise<Response> {
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('ASSET_URL_REJECTED')
    const addresses = await this.resolveHost(url.hostname)
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) throw new Error('ASSET_URL_REJECTED')
    const response = await this.fetchImpl(url, {
      redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'image/png,image/jpeg,image/webp', 'User-Agent': 'PPT-Agent/0.1 asset-download' },
    })
    if (response.status < 300 || response.status >= 400) return response
    if (redirects >= MAX_REDIRECTS) throw new Error('ASSET_REDIRECT_LIMIT')
    const location = response.headers.get('location')
    if (!location) throw new Error('ASSET_REDIRECT_INVALID')
    return this.safeFetch(new URL(location, url), redirects + 1)
  }
}

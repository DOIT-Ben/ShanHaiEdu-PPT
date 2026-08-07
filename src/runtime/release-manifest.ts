import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { CONTRACT_VERSION } from '../contract-version'
import {
  buildIdentity,
  PPT_AGENT_SOFTWARE_VERSION,
  type BuildIdentity,
} from '../release-identity'

const identifierSchema = z.string().trim().min(1).max(160)
const releaseManifestSchema = z.object({
  schemaVersion: z.literal('1'),
  softwareVersion: identifierSchema,
  contractVersion: identifierSchema,
  gitSha: z.string().regex(/^[a-f0-9]{40}$/),
  releaseId: identifierSchema,
  builtAt: z.string().datetime(),
}).strict()

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>

function realpathOrFail(target: string) {
  try {
    return realpathSync(target)
  } catch {
    throw new Error('RELEASE_MANIFEST_LAYOUT_INVALID')
  }
}

function physicalDirectory(target: string) {
  try {
    const stats = lstatSync(target)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('RELEASE_MANIFEST_LAYOUT_INVALID')
  } catch (error) {
    if (error instanceof Error && error.message === 'RELEASE_MANIFEST_LAYOUT_INVALID') throw error
    throw new Error('RELEASE_MANIFEST_LAYOUT_INVALID')
  }
}

function physicalFile(target: string) {
  try {
    const stats = lstatSync(target)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('RELEASE_MANIFEST_LAYOUT_INVALID')
  } catch (error) {
    if (error instanceof Error && error.message === 'RELEASE_MANIFEST_LAYOUT_INVALID') throw error
    throw new Error('RELEASE_MANIFEST_LAYOUT_INVALID')
  }
}

function releaseManifestRootForRuntimeEntry(runtimeEntryUrl: string | undefined) {
  if (!runtimeEntryUrl) return null
  const requestedEntryPath = fileURLToPath(runtimeEntryUrl)
  const requestedDistRoot = dirname(requestedEntryPath)
  if (basename(requestedEntryPath) !== 'server.js' || basename(requestedDistRoot) !== 'dist') return null
  const requestedReleaseRoot = dirname(requestedDistRoot)
  const releaseRoot = realpathOrFail(requestedReleaseRoot)
  const distRoot = realpathOrFail(requestedDistRoot)
  const entryPath = realpathOrFail(requestedEntryPath)
  if (distRoot !== join(releaseRoot, 'dist') || entryPath !== join(distRoot, 'server.js')) {
    throw new Error('RELEASE_MANIFEST_LAYOUT_INVALID')
  }
  physicalDirectory(releaseRoot)
  physicalDirectory(distRoot)
  physicalFile(entryPath)
  return releaseRoot
}

function readPublishedManifest(manifestPath: string) {
  try {
    const stats = lstatSync(manifestPath)
    if (stats.isSymbolicLink()) throw new Error('RELEASE_MANIFEST_TARGET_INVALID')
    if (!stats.isFile()) throw new Error('RELEASE_MANIFEST_READ_FAILED')
  } catch (error) {
    if (error instanceof Error && (error.message === 'RELEASE_MANIFEST_TARGET_INVALID' || error.message === 'RELEASE_MANIFEST_READ_FAILED')) {
      throw error
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('RELEASE_MANIFEST_MISSING')
    }
    throw new Error('RELEASE_MANIFEST_READ_FAILED')
  }
  let descriptor: number
  try {
    descriptor = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ELOOP') {
      throw new Error('RELEASE_MANIFEST_TARGET_INVALID')
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('RELEASE_MANIFEST_MISSING')
    }
    throw new Error('RELEASE_MANIFEST_READ_FAILED')
  }
  try {
    return readFileSync(descriptor, 'utf8')
  } catch {
    throw new Error('RELEASE_MANIFEST_READ_FAILED')
  } finally {
    closeSync(descriptor)
  }
}

function releaseManifestFromRuntimeEntry(runtimeEntryUrl: string | undefined) {
  const releaseRoot = releaseManifestRootForRuntimeEntry(runtimeEntryUrl)
  if (!releaseRoot) return null
  const text = readPublishedManifest(join(releaseRoot, 'release-manifest.json'))
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('RELEASE_MANIFEST_INVALID')
  }
  const parsed = releaseManifestSchema.safeParse(payload)
  if (!parsed.success) throw new Error('RELEASE_MANIFEST_INVALID')
  if (parsed.data.softwareVersion !== PPT_AGENT_SOFTWARE_VERSION) {
    throw new Error('RELEASE_MANIFEST_SOFTWARE_VERSION_MISMATCH')
  }
  if (parsed.data.contractVersion !== CONTRACT_VERSION) {
    throw new Error('RELEASE_MANIFEST_CONTRACT_VERSION_MISMATCH')
  }
  return parsed.data
}

export function resolveRuntimeBuildIdentity(input: Readonly<{
  env: RuntimeEnvironment
  runtimeEntryUrl?: string
}>): BuildIdentity {
  const manifest = releaseManifestFromRuntimeEntry(input.runtimeEntryUrl)
  if (manifest) return buildIdentity(manifest)
  return buildIdentity({
    softwareVersion: input.env.PPT_AGENT_SOFTWARE_VERSION?.trim()
      || input.env.PPT_AGENT_APP_VERSION?.trim()
      || PPT_AGENT_SOFTWARE_VERSION,
    gitSha: input.env.PPT_AGENT_GIT_SHA?.trim() || 'unknown',
    releaseId: input.env.PPT_AGENT_RELEASE_ID?.trim() || 'unversioned',
  })
}

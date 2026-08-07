import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))))
const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
const { CONTRACT_VERSION } = await import(new URL('../src/contract-version.ts', import.meta.url).href)

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function lstatOrFail(target, errorCode) {
  try {
    return lstatSync(target)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(errorCode)
    }
    throw error
  }
}

function lstatOrNull(target) {
  try {
    return lstatSync(target)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

function isInsideDirectory(directory, target) {
  const relativeTarget = relative(directory, target)
  return relativeTarget === ''
    || (!relativeTarget.startsWith(`..${sep}`) && relativeTarget !== '..' && !isAbsolute(relativeTarget))
}

const releaseRootOption = option('--root')
if (!releaseRootOption) throw new Error('RELEASE_MANIFEST_ROOT_REQUIRED')
const requestedReleaseRoot = resolve(releaseRootOption)
const releaseRootStats = lstatOrFail(requestedReleaseRoot, 'RELEASE_MANIFEST_ROOT_INVALID')
if (!releaseRootStats.isDirectory() || releaseRootStats.isSymbolicLink()) throw new Error('RELEASE_MANIFEST_ROOT_INVALID')
const releaseRoot = realpathSync(requestedReleaseRoot)
if (isInsideDirectory(sourceRoot, releaseRoot)) throw new Error('RELEASE_MANIFEST_SOURCE_TREE_FORBIDDEN')
const distRoot = join(releaseRoot, 'dist')
const distRootStats = lstatOrFail(distRoot, 'RELEASE_MANIFEST_SERVER_ENTRY_REQUIRED')
if (!distRootStats.isDirectory() || distRootStats.isSymbolicLink()) {
  throw new Error('RELEASE_MANIFEST_SERVER_ENTRY_REQUIRED')
}
const serverEntryStats = lstatOrFail(
  join(distRoot, 'server.js'),
  'RELEASE_MANIFEST_SERVER_ENTRY_REQUIRED',
)
if (!serverEntryStats.isFile() || serverEntryStats.isSymbolicLink()) {
  throw new Error('RELEASE_MANIFEST_SERVER_ENTRY_REQUIRED')
}

const gitSha = option('--git-sha') ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
const releaseId = option('--release-id') ?? `v${packageJson.version}-${gitSha.slice(0, 12)}`
if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new Error('RELEASE_MANIFEST_GIT_SHA_INVALID')
if (!/^[A-Za-z0-9._:-]{1,160}$/.test(releaseId)) throw new Error('RELEASE_MANIFEST_ID_INVALID')

const manifest = {
  schemaVersion: '1',
  softwareVersion: packageJson.version,
  contractVersion: CONTRACT_VERSION,
  gitSha,
  releaseId,
  builtAt: new Date().toISOString(),
}
const manifestPath = resolve(releaseRoot, 'release-manifest.json')
const existingManifest = lstatOrNull(manifestPath)
if (existingManifest && (!existingManifest.isFile() || existingManifest.isSymbolicLink())) {
  throw new Error('RELEASE_MANIFEST_TARGET_INVALID')
}
// This identity is exposed by unauthenticated health endpoints and contains no secret.
const stagingDirectory = mkdtempSync(join(releaseRoot, '.release-manifest-'))
try {
  chmodSync(stagingDirectory, 0o700)
  const stagedManifestPath = join(stagingDirectory, 'release-manifest.json')
  writeFileSync(stagedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  chmodSync(stagedManifestPath, 0o644)
  renameSync(stagedManifestPath, manifestPath)
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true })
}
process.stdout.write(`${JSON.stringify({ softwareVersion: manifest.softwareVersion, contractVersion: manifest.contractVersion, gitSha: manifest.gitSha, releaseId: manifest.releaseId })}\n`)

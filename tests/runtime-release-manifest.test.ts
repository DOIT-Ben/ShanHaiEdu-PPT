import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONTRACT_VERSION } from '../src/contract-version'
import { PPT_AGENT_SOFTWARE_VERSION } from '../src/release-identity'
import { resolveRuntimeBuildIdentity } from '../src/runtime/release-manifest'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'ppt-agent-release-manifest-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function releaseDirectory(manifest: Record<string, unknown>) {
  const directory = await temporaryDirectory()
  await mkdir(join(directory, 'dist'), { recursive: true })
  await writeFile(join(directory, 'dist', 'server.js'), '')
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(manifest))
  return directory
}

function publishedRuntimeEntry(directory: string) {
  return pathToFileURL(join(directory, 'dist', 'server.js')).href
}

async function sourceRuntimeEntry(directory: string) {
  await mkdir(join(directory, 'src'), { recursive: true })
  await writeFile(join(directory, 'src', 'server.ts'), '')
  return pathToFileURL(join(directory, 'src', 'server.ts')).href
}

function prepareRelease(root: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, 'run', 'prepare:release', '--', '--root', root, '--git-sha', 'd'.repeat(40), '--release-id', 'ppt-agent-test-script'],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    softwareVersion: PPT_AGENT_SOFTWARE_VERSION,
    contractVersion: CONTRACT_VERSION,
    gitSha: 'a'.repeat(40),
    releaseId: 'ppt-agent-test-a0795fb',
    builtAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  }
}

describe('runtime release manifest', () => {
  test('uses the published release manifest instead of stale environment build identity', async () => {
    const cwd = await releaseDirectory(manifest())

    expect(resolveRuntimeBuildIdentity({
      runtimeEntryUrl: publishedRuntimeEntry(cwd),
      env: {
        PPT_AGENT_SOFTWARE_VERSION: '4.3.1',
        PPT_AGENT_GIT_SHA: 'b'.repeat(40),
        PPT_AGENT_RELEASE_ID: 'ppt-agent-test-stale',
      },
    })).toEqual({
      softwareVersion: PPT_AGENT_SOFTWARE_VERSION,
      contractVersion: CONTRACT_VERSION,
      gitSha: 'a'.repeat(40),
      releaseId: 'ppt-agent-test-a0795fb',
    })
  })

  test('resolves a physical release through an atomic current symlink', async () => {
    const release = await releaseDirectory(manifest())
    const aliasParent = await temporaryDirectory('ppt-agent-release-manifest-current-alias-')
    const current = join(aliasParent, 'current')
    await symlink(release, current)

    expect(resolveRuntimeBuildIdentity({
      runtimeEntryUrl: publishedRuntimeEntry(current),
      env: {
        PPT_AGENT_GIT_SHA: 'b'.repeat(40),
        PPT_AGENT_RELEASE_ID: 'ppt-agent-test-stale',
      },
    })).toMatchObject({
      gitSha: 'a'.repeat(40),
      releaseId: 'ppt-agent-test-a0795fb',
    })
  })

  test('does not trust a stale manifest when the source entry is running', async () => {
    const cwd = await releaseDirectory(manifest())

    expect(resolveRuntimeBuildIdentity({
      runtimeEntryUrl: await sourceRuntimeEntry(cwd),
      env: {
        PPT_AGENT_SOFTWARE_VERSION: '4.4.0-dev',
        PPT_AGENT_GIT_SHA: 'c'.repeat(40),
        PPT_AGENT_RELEASE_ID: 'ppt-agent-development',
      },
    })).toEqual({
      softwareVersion: '4.4.0-dev',
      contractVersion: CONTRACT_VERSION,
      gitSha: 'c'.repeat(40),
      releaseId: 'ppt-agent-development',
    })
  })

  test('uses environment identity only when no release manifest exists', async () => {
    const cwd = await temporaryDirectory('ppt-agent-release-manifest-missing-')

    expect(resolveRuntimeBuildIdentity({
      runtimeEntryUrl: await sourceRuntimeEntry(cwd),
      env: {
        PPT_AGENT_SOFTWARE_VERSION: '4.4.0-dev',
        PPT_AGENT_GIT_SHA: 'c'.repeat(40),
        PPT_AGENT_RELEASE_ID: 'ppt-agent-development',
      },
    })).toEqual({
      softwareVersion: '4.4.0-dev',
      contractVersion: CONTRACT_VERSION,
      gitSha: 'c'.repeat(40),
      releaseId: 'ppt-agent-development',
    })
  })

  test('fails closed when a compiled release entry has no manifest', async () => {
    const cwd = await temporaryDirectory('ppt-agent-release-manifest-missing-published-')
    await mkdir(join(cwd, 'dist'), { recursive: true })
    await writeFile(join(cwd, 'dist', 'server.js'), '')

    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(cwd), env: {} }))
      .toThrow('RELEASE_MANIFEST_MISSING')
  })

  test('fails closed when a release manifest conflicts with the compiled version', async () => {
    const cwd = await releaseDirectory(manifest({ softwareVersion: '4.3.1' }))

    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(cwd), env: {} }))
      .toThrow('RELEASE_MANIFEST_SOFTWARE_VERSION_MISMATCH')
  })

  test('validates the published manifest even when the release includes source files', async () => {
    const cwd = await releaseDirectory(manifest({ contractVersion: '2' }))
    await sourceRuntimeEntry(cwd)

    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(cwd), env: {} }))
      .toThrow('RELEASE_MANIFEST_CONTRACT_VERSION_MISMATCH')
  })

  test('fails closed when a release manifest conflicts with the public contract version', async () => {
    const cwd = await releaseDirectory(manifest({ contractVersion: '2' }))

    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(cwd), env: {} }))
      .toThrow('RELEASE_MANIFEST_CONTRACT_VERSION_MISMATCH')
  })

  test('fails closed for malformed or non-strict release manifests', async () => {
    const malformed = await temporaryDirectory('ppt-agent-release-manifest-malformed-')
    await mkdir(join(malformed, 'dist'), { recursive: true })
    await writeFile(join(malformed, 'dist', 'server.js'), '')
    await writeFile(join(malformed, 'release-manifest.json'), '{')
    const unexpectedField = await releaseDirectory(manifest({ unexpected: true }))

    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(malformed), env: {} }))
      .toThrow('RELEASE_MANIFEST_INVALID')
    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(unexpectedField), env: {} }))
      .toThrow('RELEASE_MANIFEST_INVALID')
  })

  test('fails closed when the published manifest cannot be read', async () => {
    const cwd = await temporaryDirectory('ppt-agent-release-manifest-unreadable-')
    await mkdir(join(cwd, 'dist'), { recursive: true })
    await writeFile(join(cwd, 'dist', 'server.js'), '')
    await mkdir(join(cwd, 'release-manifest.json'))

    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(cwd), env: {} }))
      .toThrow('RELEASE_MANIFEST_READ_FAILED')
  })

  test('writes a service-readable manifest only to the explicit release root', async () => {
    const root = await temporaryDirectory('ppt-agent-release-manifest-script-')
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'server.js'), '')
    const result = prepareRelease(root)

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(await Bun.file(join(root, 'release-manifest.json')).text())).toMatchObject({
      contractVersion: CONTRACT_VERSION,
      gitSha: 'd'.repeat(40),
      releaseId: 'ppt-agent-test-script',
    })
    expect((await stat(join(root, 'release-manifest.json'))).mode & 0o004).toBe(0o004)
  })

  test('rejects the source tree and symbolic links from release preparation', async () => {
    const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
    const sourceRootResult = prepareRelease(sourceRoot)
    const sourceChildResult = prepareRelease(join(sourceRoot, 'dist'))
    const root = await temporaryDirectory('ppt-agent-release-manifest-symbolic-dist-')
    const externalDist = await temporaryDirectory('ppt-agent-release-manifest-external-dist-')
    await writeFile(join(externalDist, 'server.js'), '')
    await symlink(externalDist, join(root, 'dist'))
    const symbolicDistResult = prepareRelease(root)

    expect(sourceRootResult.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(sourceRootResult.stderr)).toContain('RELEASE_MANIFEST_SOURCE_TREE_FORBIDDEN')
    expect(sourceChildResult.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(sourceChildResult.stderr)).toContain('RELEASE_MANIFEST_SOURCE_TREE_FORBIDDEN')
    expect(symbolicDistResult.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(symbolicDistResult.stderr)).toContain('RELEASE_MANIFEST_SERVER_ENTRY_REQUIRED')
  })

  test('does not follow an existing manifest symbolic link', async () => {
    const root = await temporaryDirectory('ppt-agent-release-manifest-symbolic-target-')
    const externalRoot = await temporaryDirectory('ppt-agent-release-manifest-external-target-')
    const externalManifest = join(externalRoot, 'manifest.json')
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'server.js'), '')
    await writeFile(externalManifest, 'do-not-overwrite')
    await symlink(externalManifest, join(root, 'release-manifest.json'))
    const result = prepareRelease(root)

    expect(result.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toContain('RELEASE_MANIFEST_TARGET_INVALID')
    expect(await readFile(externalManifest, 'utf8')).toBe('do-not-overwrite')
  })

  test('fails closed when a runtime release path uses symbolic links', async () => {
    const symbolicDistRoot = await temporaryDirectory('ppt-agent-release-manifest-runtime-symbolic-dist-')
    const externalDist = await temporaryDirectory('ppt-agent-release-manifest-runtime-external-dist-')
    await writeFile(join(externalDist, 'server.js'), '')
    await writeFile(join(symbolicDistRoot, 'release-manifest.json'), JSON.stringify(manifest()))
    await symlink(externalDist, join(symbolicDistRoot, 'dist'))

    const symbolicEntryRoot = await temporaryDirectory('ppt-agent-release-manifest-runtime-symbolic-entry-')
    await mkdir(join(symbolicEntryRoot, 'dist'), { recursive: true })
    await writeFile(join(symbolicEntryRoot, 'release-manifest.json'), JSON.stringify(manifest()))
    await symlink(join(externalDist, 'server.js'), join(symbolicEntryRoot, 'dist', 'server.js'))

    const symbolicManifestRoot = await releaseDirectory(manifest())
    const externalManifestRoot = await temporaryDirectory('ppt-agent-release-manifest-runtime-external-manifest-')
    const externalManifest = join(externalManifestRoot, 'release-manifest.json')
    await writeFile(externalManifest, JSON.stringify(manifest({ releaseId: 'external-release' })))
    await rm(join(symbolicManifestRoot, 'release-manifest.json'))
    await symlink(externalManifest, join(symbolicManifestRoot, 'release-manifest.json'))

    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(symbolicDistRoot), env: {} }))
      .toThrow('RELEASE_MANIFEST_LAYOUT_INVALID')
    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(symbolicEntryRoot), env: {} }))
      .toThrow('RELEASE_MANIFEST_LAYOUT_INVALID')
    expect(() => resolveRuntimeBuildIdentity({ runtimeEntryUrl: publishedRuntimeEntry(symbolicManifestRoot), env: {} }))
      .toThrow('RELEASE_MANIFEST_TARGET_INVALID')
  })

  test('requires an explicit existing release root when writing a manifest', async () => {
    const root = await temporaryDirectory('ppt-agent-release-manifest-script-invalid-')
    const invalidRoot = join(root, 'not-a-directory')
    const missingEntryRoot = join(root, 'missing-entry')
    await writeFile(invalidRoot, '')
    const script = fileURLToPath(new URL('../scripts/write-release-manifest.mjs', import.meta.url))
    const cwd = fileURLToPath(new URL('..', import.meta.url))
    const missingRoot = Bun.spawnSync({
      cmd: [process.execPath, script],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const fileRoot = Bun.spawnSync({
      cmd: [process.execPath, script, '--root', invalidRoot],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await mkdir(missingEntryRoot)
    const missingEntry = Bun.spawnSync({
      cmd: [process.execPath, script, '--root', missingEntryRoot],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(missingRoot.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(missingRoot.stderr)).toContain('RELEASE_MANIFEST_ROOT_REQUIRED')
    expect(fileRoot.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(fileRoot.stderr)).toContain('RELEASE_MANIFEST_ROOT_INVALID')
    expect(missingEntry.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(missingEntry.stderr)).toContain('RELEASE_MANIFEST_SERVER_ENTRY_REQUIRED')
  })
})

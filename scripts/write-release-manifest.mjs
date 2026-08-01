import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

const gitSha = option('--git-sha') ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const releaseId = option('--release-id') ?? `v${packageJson.version}-${gitSha.slice(0, 12)}`
if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new Error('RELEASE_MANIFEST_GIT_SHA_INVALID')
if (!/^[A-Za-z0-9._:-]{1,160}$/.test(releaseId)) throw new Error('RELEASE_MANIFEST_ID_INVALID')

const manifest = {
  schemaVersion: '1',
  softwareVersion: packageJson.version,
  contractVersion: '1',
  gitSha,
  releaseId,
  builtAt: new Date().toISOString(),
}
writeFileSync(resolve(root, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ softwareVersion: manifest.softwareVersion, contractVersion: manifest.contractVersion, gitSha: manifest.gitSha, releaseId: manifest.releaseId })}\n`)

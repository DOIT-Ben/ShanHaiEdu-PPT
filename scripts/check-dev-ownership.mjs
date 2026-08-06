import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr).trim()
      : ''
    throw new Error(`DEV_OWNERSHIP_COMMAND_FAILED:${command}${stderr ? `:${stderr}` : ''}`)
  }
}

function codexDevGroupId() {
  const record = commandOutput('/usr/bin/getent', ['group', 'codex-dev'])
  const fields = record.split(':')
  const groupId = Number(fields[2])
  if (!Number.isInteger(groupId) || groupId < 0) {
    throw new Error('DEV_OWNERSHIP_CODEX_DEV_GROUP_INVALID')
  }
  return groupId
}

const expectedGroupId = codexDevGroupId()

function relativePath(location) {
  const relative = location.slice(repositoryRoot.length).replace(/^\//, '')
  return relative || '.'
}

function report(message) {
  errors.push(message)
}

function assertSharedDirectory(location) {
  if (!existsSync(location)) {
    report(`missing required directory: ${relativePath(location)}`)
    return
  }
  const stats = lstatSync(location)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    report(`required path is not a physical directory: ${relativePath(location)}`)
    return
  }
  if (stats.uid !== 0 || stats.gid !== expectedGroupId) {
    report(`directory must be root:codex-dev: ${relativePath(location)}`)
  }
  if ((stats.mode & 0o2000) === 0 || (stats.mode & 0o070) !== 0o070) {
    report(`directory must be setgid and group-rwx: ${relativePath(location)}`)
  }
}

function assertDefaultAcl(location) {
  if (!existsSync(location)) return
  const entries = new Set(commandOutput('/usr/bin/getfacl', ['--absolute-names', '--omit-header', location])
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter(Boolean))
  for (const required of ['group::rwx', 'default:group::rwx']) {
    if (!entries.has(required)) {
      report(`shared default ACL missing ${required}: ${relativePath(location)}`)
    }
  }
}

function inspectRootOwnedEntries(location) {
  if (!existsSync(location)) return
  const stats = lstatSync(location)
  if (stats.isSymbolicLink()) {
    report(`symbolic link is not allowed in protected tree: ${relativePath(location)}`)
    return
  }
  if (stats.uid === 0) {
    const groupReadableWritable = (stats.mode & 0o060) === 0o060
    const groupExecutable = !stats.isDirectory() || (stats.mode & 0o010) === 0o010
    if (stats.gid !== expectedGroupId || !groupReadableWritable || !groupExecutable) {
      report(`root-private entry blocks codex-dev: ${relativePath(location)}`)
    }
  }
  if (!stats.isDirectory()) return
  for (const entry of readdirSync(location, { withFileTypes: true })) {
    inspectRootOwnedEntries(join(location, entry.name))
  }
}

const protectedDirectories = [
  repositoryRoot,
  join(repositoryRoot, '.git'),
  join(repositoryRoot, '.git', 'objects'),
  join(repositoryRoot, '.git', 'refs'),
]

for (const directory of protectedDirectories) {
  assertSharedDirectory(directory)
  assertDefaultAcl(directory)
}

for (const directory of [
  join(repositoryRoot, '.git', 'objects'),
  join(repositoryRoot, '.git', 'refs'),
  join(repositoryRoot, 'dist'),
]) {
  inspectRootOwnedEntries(directory)
}

const indexPath = join(repositoryRoot, '.git', 'index')
if (existsSync(indexPath)) inspectRootOwnedEntries(indexPath)

if (errors.length > 0) {
  for (const error of errors) console.error(`DEV_OWNERSHIP_FAILED: ${error}`)
  process.exit(1)
}

console.log('DEV_OWNERSHIP_OK: root:codex-dev sharing, setgid, ACL, Git metadata, and build artifacts are writable.')

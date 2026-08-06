import { Database } from 'bun:sqlite'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip, createGzip } from 'node:zlib'

const execFileAsync = promisify(execFile)
const FINAL_BACKUP_PATTERN = /^ppt-agent-\d{8}T\d{6}Z$/
const TEMPORARY_BACKUP_PATTERN = /^ppt-agent-\d{8}T\d{6}Z\.tmp-(\d+)$/
const DEFAULT_LOW_WATER_BYTES = 5 * 1024 * 1024 * 1024
const SQLITE_BACKUP_PROGRAM = String.raw`
import os
import sqlite3
import sys
from pathlib import Path

source_path = Path(sys.argv[1]).resolve(strict=True)
destination_path = Path(sys.argv[2]).resolve(strict=False)
if destination_path.exists():
    raise FileExistsError(destination_path)

source = sqlite3.connect(f"{source_path.as_uri()}?mode=ro", uri=True, timeout=5)
destination = sqlite3.connect(destination_path)
try:
    source.execute("PRAGMA busy_timeout = 5000")
    source.execute("BEGIN")
    source.execute("SELECT page_count FROM pragma_page_count").fetchone()
    source.backup(destination, pages=4096, sleep=0.01)
    destination.commit()
finally:
    destination.close()
    source.close()

os.chmod(destination_path, 0o600)
with destination_path.open("rb") as backup:
    os.fsync(backup.fileno())
`

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`)
  }
  return value
}

function validateDatabase(path) {
  const database = new Database(path, { readonly: true, strict: true })
  try {
    const integrity = database.query('PRAGMA integrity_check').all()
    const foreignKeys = database.query('PRAGMA foreign_key_check').all()
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || foreignKeys.length > 0) {
      throw new Error('SQLite validation failed')
    }
  } finally {
    database.close()
  }
}

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function filesUnder(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        files.push({ path, relativePath: relative(root, path), size: (await stat(path)).size })
      } else {
        throw new Error('Artifact backup contains an unsupported filesystem entry')
      }
    }
  }
  await visit(root)
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function artifactManifest(root) {
  const files = await filesUnder(root)
  const manifest = []
  for (const file of files) {
    manifest.push({ path: file.relativePath, size: file.size, sha256: await sha256(file.path) })
  }
  return manifest
}

function validateArtifactManifest(value) {
  if (!Array.isArray(value)) throw new Error('Artifact manifest is invalid')
  const seen = new Set()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.path !== 'string' || !entry.path
      || resolve('/artifact-root', entry.path) === '/artifact-root'
      || !resolve('/artifact-root', entry.path).startsWith(`/artifact-root${sep}`)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || seen.has(entry.path)) {
      throw new Error('Artifact manifest is invalid')
    }
    seen.add(entry.path)
  }
  return value
}

async function syncPath(path) {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncTree(root) {
  for (const file of await filesUnder(root)) await syncPath(file.path)
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(join(directory, entry.name))
    }
    await chmod(directory, 0o700)
    await syncPath(directory)
  }
  await visit(root)
}

async function writeDurableFile(path, value) {
  await writeFile(path, value, { mode: 0o600, flag: 'wx' })
  await chmod(path, 0o600)
  await syncPath(path)
}

async function copyDatabase(source, destination) {
  await execFileAsync('python3', ['-c', SQLITE_BACKUP_PROGRAM, source, destination], {
    timeout: 30 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  })
}

async function compressDatabase(path) {
  const compressedPath = `${path}.gz`
  const sourceDigest = createHash('sha256')
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      sourceDigest.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      createReadStream(path),
      hashingStream,
      createGzip({ level: 6 }),
      createWriteStream(compressedPath, { flags: 'wx', mode: 0o600 }),
    )
    const databaseSha256 = sourceDigest.digest('hex')
    let restoredBytes = 0
    const restoredDigest = createHash('sha256')
    for await (const chunk of createReadStream(compressedPath).pipe(createGunzip())) {
      restoredBytes += chunk.length
      restoredDigest.update(chunk)
    }
    const databaseBytes = (await stat(path)).size
    if (restoredBytes !== databaseBytes || restoredDigest.digest('hex') !== databaseSha256) {
      throw new Error('Compressed SQLite backup validation failed')
    }
    await chmod(compressedPath, 0o600)
    await syncPath(compressedPath)
    const compressedDatabaseBytes = (await stat(compressedPath)).size
    await rm(path)
    return { databaseBytes, databaseSha256, compressedDatabaseBytes }
  } catch (error) {
    await rm(compressedPath, { force: true })
    throw error
  }
}

async function restoreDatabase(compressedPath, destination, metadata) {
  const digest = createHash('sha256')
  let bytes = 0
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      digest.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      createReadStream(compressedPath),
      createGunzip(),
      hashingStream,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    )
    await chmod(destination, 0o600)
    await syncPath(destination)
    if (bytes !== metadata.databaseBytes || digest.digest('hex') !== metadata.databaseSha256) {
      throw new Error('Restored SQLite backup hash is invalid')
    }
    validateDatabase(destination)
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
}

function parseMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 2
    || value.databaseFile !== 'agent.sqlite.gz'
    || value.databaseCompression !== 'gzip'
    || !Number.isSafeInteger(value.databaseBytes) || value.databaseBytes < 1
    || !Number.isSafeInteger(value.compressedDatabaseBytes) || value.compressedDatabaseBytes < 1
    || typeof value.databaseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.databaseSha256)
    || value.artifactManifestFile !== 'artifacts.json'
    || typeof value.artifactManifestSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.artifactManifestSha256)
    || !Number.isSafeInteger(value.artifactFiles) || value.artifactFiles < 0
    || !Number.isSafeInteger(value.artifactBytes) || value.artifactBytes < 0
    || value.integrity !== 'ok' || value.foreignKeyViolations !== 0) {
    throw new Error('Backup metadata is invalid')
  }
  return value
}

async function verifyBackup(backupPath) {
  const metadataPath = join(backupPath, 'metadata.json')
  const metadataStat = await stat(metadataPath)
  if (!metadataStat.isFile() || metadataStat.size > 64 * 1024) throw new Error('Backup metadata is invalid')
  const metadata = parseMetadata(JSON.parse(await readFile(metadataPath, 'utf8')))
  const compressedPath = join(backupPath, metadata.databaseFile)
  if ((await stat(compressedPath)).size !== metadata.compressedDatabaseBytes) {
    throw new Error('Compressed SQLite backup size is invalid')
  }
  const manifestPath = join(backupPath, metadata.artifactManifestFile)
  const manifestStat = await stat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.size > 32 * 1024 * 1024
    || await sha256(manifestPath) !== metadata.artifactManifestSha256) {
    throw new Error('Artifact manifest integrity is invalid')
  }
  const expectedManifest = validateArtifactManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  const actualManifest = await artifactManifest(join(backupPath, 'artifacts'))
  if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
    throw new Error('Artifact backup validation failed')
  }
  const artifactBytes = actualManifest.reduce((total, item) => total + item.size, 0)
  if (actualManifest.length !== metadata.artifactFiles || artifactBytes !== metadata.artifactBytes) {
    throw new Error('Artifact backup metadata is invalid')
  }

  const verificationRoot = await mkdtemp(join(tmpdir(), 'ppt-agent-backup-verify-'))
  await chmod(verificationRoot, 0o700)
  try {
    await restoreDatabase(compressedPath, join(verificationRoot, 'agent.sqlite'), metadata)
  } finally {
    await rm(verificationRoot, { recursive: true, force: true })
  }
  console.log(JSON.stringify({
    schemaVersion: metadata.schemaVersion,
    verified: true,
    databaseBytes: metadata.databaseBytes,
    artifactFiles: metadata.artifactFiles,
    artifactBytes: metadata.artifactBytes,
  }))
}

async function processExists(pid) {
  return await stat(`/proc/${pid}`).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false
    throw error
  })
}

async function removeStaleTemporaryBackups(backupRoot) {
  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    const match = entry.isDirectory() ? TEMPORARY_BACKUP_PATTERN.exec(entry.name) : null
    if (!match || await processExists(Number(match[1]))) continue
    await rm(join(backupRoot, entry.name), { recursive: true })
  }
  await syncPath(backupRoot)
}

async function createBackup() {
  const dataRoot = resolve(process.env.PPT_AGENT_DATA_ROOT || '/opt/ppt-agent/shared/data')
  const databasePath = join(dataRoot, 'agent.sqlite')
  const sourceArtifactRoot = join(dataRoot, 'artifacts')
  const backupRoot = resolve(process.env.PPT_AGENT_BACKUP_ROOT || '/opt/ppt-agent/shared/data-backups')
  const retentionDays = integerEnvironment('PPT_AGENT_BACKUP_RETENTION_DAYS', 14, 1, 90)
  const lowWaterBytes = integerEnvironment(
    'PPT_AGENT_BACKUP_LOW_WATER_BYTES',
    DEFAULT_LOW_WATER_BYTES,
    0,
    Number.MAX_SAFE_INTEGER,
  )
  if (backupRoot === dataRoot || backupRoot.startsWith(`${dataRoot}${sep}`)
    || dataRoot.startsWith(`${backupRoot}${sep}`)) {
    throw new Error('Backup root and data root must not contain each other')
  }

  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  await chmod(backupRoot, 0o700)
  await removeStaleTemporaryBackups(backupRoot)
  const sourceDatabaseBytes = (await stat(databasePath)).size
  const sourceArtifacts = await filesUnder(sourceArtifactRoot)
  const sourceArtifactBytes = sourceArtifacts.reduce((total, item) => total + item.size, 0)
  const filesystem = await statfs(backupRoot)
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
  const requiredBytes = sourceDatabaseBytes * 2 + sourceArtifactBytes + lowWaterBytes
  if (!Number.isSafeInteger(requiredBytes) || availableBytes < requiredBytes) {
    throw new Error('PPT_AGENT_BACKUP_DISK_LOW')
  }

  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const finalPath = join(backupRoot, `ppt-agent-${stamp}`)
  const temporaryPath = `${finalPath}.tmp-${process.pid}`
  await mkdir(temporaryPath, { mode: 0o700 })
  try {
    const copiedDatabase = join(temporaryPath, 'agent.sqlite')
    await copyDatabase(databasePath, copiedDatabase)
    await chmod(copiedDatabase, 0o600)
    validateDatabase(copiedDatabase)

    const expectedArtifacts = await artifactManifest(sourceArtifactRoot)
    const copiedArtifactRoot = join(temporaryPath, 'artifacts')
    if (expectedArtifacts.length > 0) {
      await cp(sourceArtifactRoot, copiedArtifactRoot, { recursive: true, force: false })
      for (const file of await filesUnder(copiedArtifactRoot)) await chmod(file.path, 0o600)
    }
    const copiedArtifacts = await artifactManifest(copiedArtifactRoot)
    if (JSON.stringify(copiedArtifacts) !== JSON.stringify(expectedArtifacts)) {
      throw new Error('Artifact backup validation failed')
    }
    const artifactBytes = copiedArtifacts.reduce((total, item) => total + item.size, 0)
    const artifactManifestJson = `${JSON.stringify(copiedArtifacts)}\n`
    const artifactManifestPath = join(temporaryPath, 'artifacts.json')
    await writeDurableFile(artifactManifestPath, artifactManifestJson)
    const artifactManifestSha256 = await sha256(artifactManifestPath)

    const { databaseBytes, databaseSha256, compressedDatabaseBytes } = await compressDatabase(copiedDatabase)
    const metadata = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      databaseBytes,
      databaseFile: 'agent.sqlite.gz',
      databaseCompression: 'gzip',
      databaseSha256,
      compressedDatabaseBytes,
      artifactManifestFile: 'artifacts.json',
      artifactManifestSha256,
      artifactFiles: copiedArtifacts.length,
      artifactBytes,
      integrity: 'ok',
      foreignKeyViolations: 0,
      retentionDays,
    }
    await writeDurableFile(join(temporaryPath, 'metadata.json'), `${JSON.stringify(metadata)}\n`)
    await syncTree(temporaryPath)
    await rename(temporaryPath, finalPath)
    await syncPath(backupRoot)

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !FINAL_BACKUP_PATTERN.test(entry.name)) continue
      const path = join(backupRoot, entry.name)
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true })
    }
    await syncPath(backupRoot)
    console.log(JSON.stringify({ ...metadata, backupDirectory: finalPath }))
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true })
    await syncPath(backupRoot)
    throw error
  }
}

const args = process.argv.slice(2)
if (args[0] === '--verify' && args.length === 2) await verifyBackup(resolve(args[1]))
else if (args.length === 0) await createBackup()
else throw new Error('Usage: backup-ppt-agent-data.mjs [--verify BACKUP_DIRECTORY]')

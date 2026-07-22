import { Database } from 'bun:sqlite'
import {
  chmod,
  cp,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const dataRoot = resolve(process.env.PPT_AGENT_DATA_ROOT || '/opt/ppt-agent/shared/data')
const databasePath = join(dataRoot, 'agent.sqlite')
const artifactRoot = join(dataRoot, 'artifacts')
const backupRoot = resolve(process.env.PPT_AGENT_BACKUP_ROOT || '/opt/ppt-agent/shared/data-backups')
const retentionDays = Number.parseInt(process.env.PPT_AGENT_BACKUP_RETENTION_DAYS || '14', 10)

if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) {
  throw new Error('PPT_AGENT_BACKUP_RETENTION_DAYS must be between 1 and 90')
}
if (
  backupRoot === dataRoot
  || backupRoot.startsWith(`${dataRoot}${sep}`)
  || dataRoot.startsWith(`${backupRoot}${sep}`)
) {
  throw new Error('Backup root and data root must not contain each other')
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

async function filesUnder(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return []
      throw error
    })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push({ path, relativePath: relative(root, path), size: (await stat(path)).size })
    }
  }
  await visit(root)
  return files
}

await mkdir(backupRoot, { recursive: true, mode: 0o700 })
await chmod(backupRoot, 0o700)
validateDatabase(databasePath)

const expectedArtifacts = await filesUnder(artifactRoot)
const source = new Database(databasePath, { readonly: true, strict: true })
let databaseBytes
try {
  databaseBytes = source.serialize()
} finally {
  source.close()
}

const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const finalPath = join(backupRoot, `ppt-agent-${stamp}`)
const temporaryPath = `${finalPath}.tmp-${process.pid}`
await mkdir(temporaryPath, { mode: 0o700 })

try {
  const copiedDatabase = join(temporaryPath, 'agent.sqlite')
  await writeFile(copiedDatabase, databaseBytes, { mode: 0o600, flag: 'wx' })
  await chmod(copiedDatabase, 0o600)
  if (expectedArtifacts.length > 0) {
    await cp(artifactRoot, join(temporaryPath, 'artifacts'), { recursive: true, force: false })
  }
  validateDatabase(copiedDatabase)
  for (const artifact of expectedArtifacts) {
    const copied = await stat(join(temporaryPath, 'artifacts', artifact.relativePath))
    if (!copied.isFile() || copied.size !== artifact.size) throw new Error('Artifact backup validation failed')
  }
  const metadata = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    databaseBytes: databaseBytes.byteLength,
    artifactFiles: expectedArtifacts.length,
    artifactBytes: expectedArtifacts.reduce((total, artifact) => total + artifact.size, 0),
    integrity: 'ok',
    foreignKeyViolations: 0,
    retentionDays,
  }
  await writeFile(join(temporaryPath, 'metadata.json'), `${JSON.stringify(metadata)}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  await rename(temporaryPath, finalPath)

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^ppt-agent-\d{8}T\d{6}Z$/.test(entry.name)) continue
    const path = join(backupRoot, entry.name)
    if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true })
  }
  console.log(JSON.stringify({ ...metadata, backupDirectory: finalPath }))
} catch (error) {
  await rm(temporaryPath, { recursive: true, force: true })
  throw error
}

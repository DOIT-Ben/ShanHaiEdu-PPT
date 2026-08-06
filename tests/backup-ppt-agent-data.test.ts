import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PPT Agent data backup', () => {
  test('pins a bounded-memory WAL snapshot and keeps the production unit fail-closed', async () => {
    const script = await readFile(
      join(import.meta.dir, '..', 'scripts', 'backup-ppt-agent-data.mjs'),
      'utf8',
    )
    const unit = await readFile(
      join(import.meta.dir, '..', 'deploy', 'aliyun', 'ppt-agent-backup.service'),
      'utf8',
    )

    expect(script).not.toContain('.serialize()')
    expect(script).toContain('source.execute("BEGIN")')
    expect(script).toContain('source.backup(destination, pages=4096')
    expect(unit).toContain('ExecStartPre=/usr/bin/test -r /opt/ppt-agent/shared/ops/backup-ppt-agent-data.mjs')
    expect(unit).toContain('TimeoutStartSec=45min')
  })

  test('copies a valid SQLite snapshot and artifacts before pruning expired backups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ppt-agent-backup-'))
    temporaryRoots.push(root)
    const dataRoot = join(root, 'data')
    const backupRoot = join(root, 'backups')
    await mkdir(join(dataRoot, 'artifacts', 'artifact-1'), { recursive: true })
    await writeFile(join(dataRoot, 'artifacts', 'artifact-1', 'content.bin'), new Uint8Array([1, 2, 3]))
    await writeFile(join(dataRoot, 'artifacts', 'artifact-1', 'metadata.json'), '{}\n')
    const database = new Database(join(dataRoot, 'agent.sqlite'), { create: true, strict: true })
    database.run('PRAGMA foreign_keys = ON')
    database.run('PRAGMA journal_mode = WAL')
    database.run('CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    database.run("INSERT INTO sample VALUES ('row-1', 'preserved')")
    database.close()

    const presentationJobs = new Database(join(dataRoot, 'presentation-jobs-v2.sqlite'), { create: true, strict: true })
    presentationJobs.run('PRAGMA foreign_keys = ON')
    presentationJobs.run('PRAGMA journal_mode = WAL')
    presentationJobs.run('CREATE TABLE sample_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    presentationJobs.run("INSERT INTO sample_jobs VALUES ('job-1', 'preserved-v2')")
    presentationJobs.close()

    const expired = join(backupRoot, 'ppt-agent-20200101T000000Z')
    await mkdir(expired, { recursive: true })
    const staleTemporary = join(backupRoot, 'ppt-agent-20200101T000000Z.tmp-999999')
    await mkdir(staleTemporary, { recursive: true })
    await writeFile(join(staleTemporary, 'partial.sqlite'), 'partial')
    const old = new Date('2020-01-01T00:00:00.000Z')
    await utimes(expired, old, old)

    const writer = new Database(join(dataRoot, 'agent.sqlite'), { strict: true })
    let writerSequence = 0
    const writerTimer = setInterval(() => {
      try {
        writer.run('INSERT INTO sample VALUES (?, ?)', [`live-${writerSequence++}`, 'concurrent'])
      } catch {
        // The read snapshot can briefly contend with a test writer.
      }
    }, 1)

    const child = Bun.spawn([
      globalThis.process.execPath,
      join(import.meta.dir, '..', 'scripts', 'backup-ppt-agent-data.mjs'),
    ], {
      env: {
        ...globalThis.process.env,
        PPT_AGENT_DATA_ROOT: dataRoot,
        PPT_AGENT_BACKUP_ROOT: backupRoot,
        PPT_AGENT_BACKUP_RETENTION_DAYS: '1',
        PPT_AGENT_BACKUP_LOW_WATER_BYTES: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    const exitCode = await child.exited
    clearInterval(writerTimer)
    writer.close()
    expect(exitCode, error).toBe(0)
    const metadata = JSON.parse(output) as {
      backupDirectory: string
      artifactFiles: number
      integrity: string
      databaseFile: string
      databaseSha256: string
      presentationJobV2Database: {
        databaseFile: string
        databaseSha256: string
      }
    }

    expect(metadata).toMatchObject({
      artifactFiles: 2,
      integrity: 'ok',
      databaseFile: 'agent.sqlite.gz',
      databaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      presentationJobV2Database: {
        databaseFile: 'presentation-jobs-v2.sqlite.gz',
        databaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect((await stat(expired).catch(() => null))).toBeNull()
    expect((await stat(staleTemporary).catch(() => null))).toBeNull()
    expect((await stat(metadata.backupDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(metadata.backupDirectory, 'artifacts', 'artifact-1'))).mode & 0o777).toBe(0o700)
    expect(await readFile(join(metadata.backupDirectory, 'artifacts', 'artifact-1', 'content.bin')))
      .toEqual(Buffer.from([1, 2, 3]))
    expect(await stat(join(metadata.backupDirectory, 'agent.sqlite')).catch(() => null)).toBeNull()
    expect((await stat(join(metadata.backupDirectory, metadata.databaseFile))).mode & 0o777).toBe(0o600)
    expect(await stat(join(metadata.backupDirectory, 'presentation-jobs-v2.sqlite')).catch(() => null)).toBeNull()
    expect((await stat(join(metadata.backupDirectory, metadata.presentationJobV2Database.databaseFile))).mode & 0o777)
      .toBe(0o600)
    expect((await readdir(backupRoot)).some((name) => name.includes('.tmp-'))).toBeFalse()

    const verification = Bun.spawn([
      globalThis.process.execPath,
      join(import.meta.dir, '..', 'scripts', 'backup-ppt-agent-data.mjs'),
      '--verify',
      metadata.backupDirectory,
    ], { stdout: 'pipe', stderr: 'pipe' })
    const verificationOutput = await new Response(verification.stdout).text()
    const verificationError = await new Response(verification.stderr).text()
    expect(await verification.exited, verificationError).toBe(0)
    expect(JSON.parse(verificationOutput)).toMatchObject({ verified: true, artifactFiles: 2 })

    const restoredPath = join(root, 'restored.sqlite')
    await pipeline(
      createReadStream(join(metadata.backupDirectory, metadata.databaseFile)),
      createGunzip(),
      createWriteStream(restoredPath, { mode: 0o600 }),
    )
    const copied = new Database(restoredPath, { readonly: true, strict: true })
    expect(copied.query('SELECT value FROM sample WHERE id = ?').get('row-1')).toEqual({ value: 'preserved' })
    copied.close()

    const restoredPresentationJobsPath = join(root, 'restored-presentation-jobs-v2.sqlite')
    await pipeline(
      createReadStream(join(metadata.backupDirectory, metadata.presentationJobV2Database.databaseFile)),
      createGunzip(),
      createWriteStream(restoredPresentationJobsPath, { mode: 0o600 }),
    )
    const copiedPresentationJobs = new Database(restoredPresentationJobsPath, { readonly: true, strict: true })
    expect(copiedPresentationJobs.query('SELECT value FROM sample_jobs WHERE id = ?').get('job-1'))
      .toEqual({ value: 'preserved-v2' })
    copiedPresentationJobs.close()

    await writeFile(join(metadata.backupDirectory, 'artifacts', 'artifact-1', 'content.bin'), new Uint8Array([1, 2, 4]))
    const tampered = Bun.spawn([
      globalThis.process.execPath,
      join(import.meta.dir, '..', 'scripts', 'backup-ppt-agent-data.mjs'),
      '--verify',
      metadata.backupDirectory,
    ], { stdout: 'ignore', stderr: 'pipe' })
    const tamperedError = await new Response(tampered.stderr).text()
    expect(await tampered.exited, tamperedError).not.toBe(0)
  })

  test('fails before creating a temporary backup when the low-water requirement cannot be met', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ppt-agent-backup-low-water-'))
    temporaryRoots.push(root)
    const dataRoot = join(root, 'data')
    const backupRoot = join(root, 'backups')
    await mkdir(dataRoot, { recursive: true })
    const database = new Database(join(dataRoot, 'agent.sqlite'), { create: true, strict: true })
    database.run('CREATE TABLE sample (id TEXT PRIMARY KEY)')
    database.close()

    const child = Bun.spawn([
      globalThis.process.execPath,
      join(import.meta.dir, '..', 'scripts', 'backup-ppt-agent-data.mjs'),
    ], {
      env: {
        ...globalThis.process.env,
        PPT_AGENT_DATA_ROOT: dataRoot,
        PPT_AGENT_BACKUP_ROOT: backupRoot,
        PPT_AGENT_BACKUP_LOW_WATER_BYTES: String(Number.MAX_SAFE_INTEGER - 1024),
      },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const error = await new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(error).toContain('PPT_AGENT_BACKUP_DISK_LOW')
    expect(await readdir(backupRoot)).toEqual([])
  })
})

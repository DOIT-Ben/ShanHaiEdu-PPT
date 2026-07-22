import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PPT Agent data backup', () => {
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
    database.run('CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    database.run("INSERT INTO sample VALUES ('row-1', 'preserved')")
    database.close()

    const expired = join(backupRoot, 'ppt-agent-20200101T000000Z')
    await mkdir(expired, { recursive: true })
    const old = new Date('2020-01-01T00:00:00.000Z')
    await utimes(expired, old, old)

    const child = Bun.spawn([
      globalThis.process.execPath,
      join(import.meta.dir, '..', 'scripts', 'backup-ppt-agent-data.mjs'),
    ], {
      env: {
        ...globalThis.process.env,
        PPT_AGENT_DATA_ROOT: dataRoot,
        PPT_AGENT_BACKUP_ROOT: backupRoot,
        PPT_AGENT_BACKUP_RETENTION_DAYS: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
    const metadata = JSON.parse(output) as { backupDirectory: string; artifactFiles: number; integrity: string }

    expect(metadata).toMatchObject({ artifactFiles: 2, integrity: 'ok' })
    expect((await stat(expired).catch(() => null))).toBeNull()
    expect(await readFile(join(metadata.backupDirectory, 'artifacts', 'artifact-1', 'content.bin')))
      .toEqual(Buffer.from([1, 2, 3]))
    const copied = new Database(join(metadata.backupDirectory, 'agent.sqlite'), { readonly: true, strict: true })
    expect(copied.query('SELECT value FROM sample WHERE id = ?').get('row-1')).toEqual({ value: 'preserved' })
    copied.close()
  })
})

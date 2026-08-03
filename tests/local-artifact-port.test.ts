import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalArtifactPort } from '../src/adapters/local-artifact-port'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ppt-agent-artifacts-'))
  cleanupPaths.push(directory)
  return new LocalArtifactPort(directory)
}

describe('local artifact port', () => {
  test('persists and verifies bytes behind a stable opaque artifact id', async () => {
    const artifacts = await fixture()
    const bytes = new TextEncoder().encode('controlled artifact bytes')
    const input = {
      tenantId: 'frameflow',
      runId: 'run-1',
      name: 'preview.png',
      mimeType: 'image/png',
      bytes,
      idempotencyKey: 'run-1:delivery:r0:preview',
    }
    const first = await artifacts.put(input)
    const replay = await artifacts.put(input)
    const stored = await artifacts.get({ tenantId: 'frameflow', artifactId: first.artifactId })
    const resolved = await artifacts.getByIdempotencyKey({
      tenantId: 'frameflow',
      idempotencyKey: input.idempotencyKey,
    })

    expect(first).toEqual(replay)
    expect(first.artifactId).toMatch(/^artifact-[a-f0-9]{40}$/)
    expect(stored?.bytes).toEqual(bytes)
    expect(stored?.sha256).toBe(first.sha256)
    expect(resolved).toMatchObject({ artifactId: first.artifactId, mimeType: 'image/png', sha256: first.sha256 })
    expect(resolved?.bytes).toEqual(bytes)
    expect(artifacts.verifyIntegrity({
      tenantId: 'frameflow', artifactId: first.artifactId, mimeType: 'image/png',
      byteLength: bytes.length, sha256: first.sha256,
    })).toBe(true)
    expect(artifacts.verifyIntegrity({
      tenantId: 'frameflow', artifactId: first.artifactId, mimeType: 'text/plain',
      byteLength: bytes.length, sha256: first.sha256,
    })).toBe(false)
  })

  test('isolates tenant reads and rejects changed bytes under one idempotency key', async () => {
    const artifacts = await fixture()
    const input = {
      tenantId: 'frameflow',
      runId: 'run-1',
      name: 'lesson.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: new TextEncoder().encode('pptx-v1'),
      idempotencyKey: 'run-1:delivery:r0:pptx',
    }
    const stored = await artifacts.put(input)

    expect(await artifacts.get({ tenantId: 'shanhaiedu', artifactId: stored.artifactId })).toBeNull()
    await expect(artifacts.put({ ...input, bytes: new TextEncoder().encode('pptx-v2') }))
      .rejects.toThrow('ARTIFACT_IDEMPOTENCY_CONFLICT')
  })
})

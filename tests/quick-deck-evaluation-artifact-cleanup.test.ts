import { describe, expect, test } from 'bun:test'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalQuickDeckEvaluationArtifactCleanupPort } from '../src/adapters/quick-deck-evaluation-local-artifact-cleanup'

describe('quick-deck local artifact cleanup', () => {
  test('rejects path-like artifact ids without touching neighboring files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-quick-deck-cleanup-'))
    const artifacts = join(directory, 'artifacts')
    const sentinel = join(directory, 'sentinel.txt')
    const cleanup = new LocalQuickDeckEvaluationArtifactCleanupPort(artifacts)
    try {
      await writeFile(sentinel, 'must remain')
      await expect(cleanup.remove({ tenantId: 'evaluation-tenant', artifactId: '../sentinel.txt' }))
        .rejects.toThrow('QUICK_DECK_EVALUATION_ARTIFACT_ID_INVALID')
      await expect(access(sentinel)).resolves.toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

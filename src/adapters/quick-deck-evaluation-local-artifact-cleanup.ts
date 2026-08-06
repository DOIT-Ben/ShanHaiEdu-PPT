import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { QuickDeckEvaluationArtifactCleanupPort } from '../core/quick-deck-evaluation-ports'

const artifactIdPattern = /^artifact-[a-f0-9]{40}$/

/** Deletes only LocalArtifactPort directories beneath the dedicated evaluator root. */
export class LocalQuickDeckEvaluationArtifactCleanupPort implements QuickDeckEvaluationArtifactCleanupPort {
  readonly #rootDirectory: string

  constructor(rootDirectory: string) {
    this.#rootDirectory = path.resolve(rootDirectory)
  }

  async remove(input: Parameters<QuickDeckEvaluationArtifactCleanupPort['remove']>[0]) {
    if (!artifactIdPattern.test(input.artifactId)) throw new Error('QUICK_DECK_EVALUATION_ARTIFACT_ID_INVALID')
    const directory = path.resolve(this.#rootDirectory, input.artifactId)
    if (path.dirname(directory) !== this.#rootDirectory) {
      throw new Error('QUICK_DECK_EVALUATION_ARTIFACT_PATH_INVALID')
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
  }
}

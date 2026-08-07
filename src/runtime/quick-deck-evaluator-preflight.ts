import type { V4ModelPolicy } from '../core/v4-model-policy'
import type {
  QuickDeckEvaluationModelEligibility,
  QuickDeckEvaluationModelEligibilityPort,
} from '../core/quick-deck-evaluation-service'

export interface QuickDeckEvaluatorDirectoryProbe {
  listModels(): Promise<readonly string[]>
}

type DirectoryChannel = 'TEXT' | 'IMAGE'

type QuickDeckEvaluatorDirectoryInput = Readonly<{
  textModel: string
  allowedImageModels: readonly string[]
  textProbe: QuickDeckEvaluatorDirectoryProbe
  imageProbe: QuickDeckEvaluatorDirectoryProbe
}>

type DirectoryCacheInput = Readonly<{
  textProbe: QuickDeckEvaluatorDirectoryProbe
  imageProbe: QuickDeckEvaluatorDirectoryProbe
  directoryTtlMs?: number
  now?: () => Date
}>

type DirectorySnapshot = Readonly<{
  models: ReadonlySet<string>
  refreshAt: number
}>

const DEFAULT_DIRECTORY_TTL_MS = 120_000

async function listedModels(probe: QuickDeckEvaluatorDirectoryProbe, channel: DirectoryChannel) {
  try {
    return new Set(await probe.listModels())
  } catch {
    throw new Error(`PPT_AGENT_QUICK_DECK_EVALUATION_${channel}_MODEL_DIRECTORY_UNAVAILABLE`)
  }
}

class QuickDeckEvaluatorDirectory {
  readonly #probes: Readonly<Record<DirectoryChannel, QuickDeckEvaluatorDirectoryProbe>>
  readonly #directoryTtlMs: number
  readonly #now: () => Date
  readonly #snapshots = new Map<DirectoryChannel, DirectorySnapshot>()
  readonly #refreshing = new Map<DirectoryChannel, Promise<DirectorySnapshot>>()

  constructor(input: DirectoryCacheInput) {
    const directoryTtlMs = input.directoryTtlMs ?? DEFAULT_DIRECTORY_TTL_MS
    if (!Number.isSafeInteger(directoryTtlMs) || directoryTtlMs < 1_000 || directoryTtlMs > 60 * 60_000) {
      throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_DIRECTORY_TTL_INVALID')
    }
    this.#probes = { TEXT: input.textProbe, IMAGE: input.imageProbe }
    this.#directoryTtlMs = directoryTtlMs
    this.#now = input.now ?? (() => new Date())
  }

  async models(channel: DirectoryChannel) {
    const now = this.#now().getTime()
    const snapshot = this.#snapshots.get(channel)
    if (snapshot && now < snapshot.refreshAt) return snapshot.models
    const inFlight = this.#refreshing.get(channel)
    if (inFlight) return (await inFlight).models
    const refresh = listedModels(this.#probes[channel], channel)
      .then((models) => {
        const next = { models, refreshAt: now + this.#directoryTtlMs }
        this.#snapshots.set(channel, next)
        return next
      })
      .finally(() => this.#refreshing.delete(channel))
    this.#refreshing.set(channel, refresh)
    return (await refresh).models
  }

  async includes(input: Readonly<{ textModel: string; imageModels: readonly string[] }>) {
    const [textModels, imageModels] = await Promise.all([
      this.models('TEXT'),
      this.models('IMAGE'),
    ])
    return textModels.has(input.textModel)
      && input.imageModels.every((model) => imageModels.has(model))
  }
}

export type QuickDeckEvaluatorModelEligibilityInput = Readonly<{
  v4ModelPolicy: Pick<V4ModelPolicy, 'allowsQuickDeckModels'>
  textProbe: QuickDeckEvaluatorDirectoryProbe
  imageProbe: QuickDeckEvaluatorDirectoryProbe
  directoryTtlMs?: number
  now?: () => Date
}>

/**
 * Combines current V4 attestation eligibility with a TTL-bounded directory
 * read performed using evaluator-only credentials.
 */
export class QuickDeckEvaluatorModelEligibility implements QuickDeckEvaluationModelEligibilityPort {
  readonly #v4ModelPolicy: Pick<V4ModelPolicy, 'allowsQuickDeckModels'>
  readonly #directory: QuickDeckEvaluatorDirectory

  constructor(input: QuickDeckEvaluatorModelEligibilityInput) {
    this.#v4ModelPolicy = input.v4ModelPolicy
    this.#directory = new QuickDeckEvaluatorDirectory(input)
  }

  async check(input: Readonly<{ textModel: string; imageModels: readonly string[] }>): Promise<QuickDeckEvaluationModelEligibility> {
    if (!this.#v4ModelPolicy.allowsQuickDeckModels(input)) return 'NOT_READY'
    try {
      return await this.#directory.includes(input) ? 'READY' : 'UNAVAILABLE'
    } catch {
      return 'UNAVAILABLE'
    }
  }
}

/** Confirms that isolated evaluator credentials can see every configured evaluator model. */
export async function assertQuickDeckEvaluatorModelsAvailable(input: QuickDeckEvaluatorDirectoryInput) {
  const directory = new QuickDeckEvaluatorDirectory(input)
  const [textModels, imageModels] = await Promise.all([
    directory.models('TEXT'),
    directory.models('IMAGE'),
  ])
  if (!textModels.has(input.textModel)) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_MODEL_UNAVAILABLE')
  }
  if (input.allowedImageModels.some((model) => !imageModels.has(model))) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODEL_UNAVAILABLE')
  }
}

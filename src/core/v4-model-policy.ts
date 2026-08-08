import type { CreateRunRequest } from '../contracts'
import { VISUAL_DECK_V4_COMPILER_VERSION } from '../release-identity'
import {
  createPublicCapabilities,
  v4TextGenerationCapabilitySchema,
  type PublicCapabilities,
  type V4TextGenerationCapability,
} from '../run-query-contracts'
import type { StructuredGenerationProtocol } from './ports'

export type V4RuntimeMode = 'GATEWAY' | 'MOCK'
export type V4ModelRole = 'TEXT' | 'VISION' | 'IMAGE' | 'IMAGE_EDIT'
export type V4ModelReadinessStatus = 'PASSED' | 'NOT_EVALUATED' | 'FAILED'
export type V4ModelAvailabilityState = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE'

/**
 * Frozen at V4 Run creation. Runtime configuration may change after a worker
 * restart, but an accepted Run must continue on the same model contract.
 */
export type V4RunModelSnapshot = Readonly<{
  schemaVersion: '1'
  textModel: string
  visionModel: string
  imageModel: string
  imageEditModel: string | null
}>

type V4SnapshotCarrier = Readonly<{
  presentationMode?: CreateRunRequest['presentationMode']
  v4ModelSnapshot?: V4RunModelSnapshot
  imageModel?: string
  release?: Readonly<{ compilerVersion?: string }>
  v4StructuredGenerationProtocol?: StructuredGenerationProtocol
}>

export class V4LegacyModelSnapshotError extends Error {
  constructor() {
    super('V4_LEGACY_MODEL_SNAPSHOT_UNAVAILABLE')
    this.name = 'V4LegacyModelSnapshotError'
  }
}

export class V4Chain4ProtocolError extends Error {
  constructor() {
    super('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
    this.name = 'V4Chain4ProtocolError'
  }
}

/**
 * A chain-4 identity can be persisted on the Run or supplied by a durable
 * Blueprint/step identity while recovering an older Run record.
 */
export function isV4Chain4Run(run: V4SnapshotCarrier, compilerVersion?: string) {
  return run.presentationMode === 'VISUAL_DECK_V4'
    && (compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION
      || run.release?.compilerVersion === VISUAL_DECK_V4_COMPILER_VERSION)
}

function legacyImageModel(run: V4SnapshotCarrier) {
  if (typeof run.imageModel !== 'string' || !run.imageModel.trim()) {
    throw new V4LegacyModelSnapshotError()
  }
  return run.imageModel.trim()
}

export function v4ModelOverride(
  run: V4SnapshotCarrier,
  role: 'TEXT' | 'VISION' | 'IMAGE',
  compilerVersion?: string,
) {
  if (run.presentationMode !== 'VISUAL_DECK_V4') return undefined
  const snapshot = run.v4ModelSnapshot
  if (snapshot === undefined) {
    if (isV4Chain4Run(run, compilerVersion)) throw new V4LegacyModelSnapshotError()
    return role === 'IMAGE' ? legacyImageModel(run) : undefined
  }
  if (!snapshot || snapshot.schemaVersion !== '1') throw new V4LegacyModelSnapshotError()
  const model = role === 'TEXT'
    ? snapshot.textModel
    : role === 'VISION'
      ? snapshot.visionModel
      : snapshot.imageModel
  if (typeof model !== 'string') throw new V4LegacyModelSnapshotError()
  const normalized = model.trim()
  if (!normalized) throw new V4LegacyModelSnapshotError()
  return normalized
}

export function v4ImageEditModelOverride(run: V4SnapshotCarrier, compilerVersion?: string) {
  if (run.presentationMode !== 'VISUAL_DECK_V4') return undefined
  const snapshot = run.v4ModelSnapshot
  if (snapshot === undefined) {
    if (isV4Chain4Run(run, compilerVersion)) throw new V4LegacyModelSnapshotError()
    return undefined
  }
  if (!snapshot || snapshot.schemaVersion !== '1') throw new V4LegacyModelSnapshotError()
  if (snapshot.imageEditModel !== null && typeof snapshot.imageEditModel !== 'string') {
    throw new V4LegacyModelSnapshotError()
  }
  if (snapshot.imageEditModel !== null && !snapshot.imageEditModel.trim()) {
    throw new V4LegacyModelSnapshotError()
  }
  return snapshot.imageEditModel?.trim() ?? null
}

/**
 * Chain-4 must never revive a persisted Function/Chat fallback. Older
 * compiler generations retain their historical protocol unchanged.
 */
export function v4StructuredGenerationProtocolOverride(
  run: V4SnapshotCarrier,
  compilerVersion?: string,
) {
  const protocol = run.v4StructuredGenerationProtocol
  if (isV4Chain4Run(run, compilerVersion)
    && protocol !== undefined
    && protocol !== 'RESPONSES_JSON_SCHEMA') {
    throw new V4Chain4ProtocolError()
  }
  return protocol
}

/** A chain-4 provider call may only happen after a durable Responses preflight. */
export function requireV4StructuredGenerationProtocol(
  run: V4SnapshotCarrier,
  compilerVersion?: string,
) {
  const protocol = v4StructuredGenerationProtocolOverride(run, compilerVersion)
  if (isV4Chain4Run(run, compilerVersion) && protocol !== 'RESPONSES_JSON_SCHEMA') {
    throw new V4Chain4ProtocolError()
  }
  return protocol
}

/**
 * A real evaluation attestation is configured outside source and expires by
 * policy. It is deliberately separate from live gateway-directory health.
 */
export type V4ModelReadinessRecord = Readonly<{
  status: V4ModelReadinessStatus
  evaluationRelease: string | null
  gatewayContractVersion: string | null
  /** Text-model evaluator attestation; images use their asynchronous task contract instead. */
  structuredGenerationProtocol?: 'RESPONSES_JSON_SCHEMA' | null
  evaluatedAt: string | null
  evaluationSuite: string | null
  expiresAt: string | null
}>

export type V4ConfiguredModel = Readonly<{
  model: string
  roles: readonly V4ModelRole[]
  evaluationEnabled: boolean
  published: boolean
  readiness: V4ModelReadinessRecord
}>

/**
 * A quick-deck job persists these names at acceptance, but they must still be
 * eligible at the moment a new evaluator call is about to be made.
 */
export type V4QuickDeckModelSelection = Readonly<{
  textModel: string
  imageModels: readonly string[]
}>

/** A directory lookup only establishes gateway visibility; it is not a generation test. */
export interface V4ModelAvailabilityProbe {
  listModels(): Promise<readonly string[]>
}

export class V4ModelPolicyError extends Error {
  constructor(
    readonly code: 'V4_IMAGE_MODEL_NOT_ALLOWED' | 'V4_MODEL_NOT_READY' | 'V4_MODEL_UNAVAILABLE'
      | 'V4_CHAIN4_PROTOCOL_UNSUPPORTED',
    readonly status: 422 | 503,
  ) {
    super(code)
    this.name = 'V4ModelPolicyError'
  }
}

type AvailabilityGroup = 'text' | 'image'

type ModelAvailabilitySnapshot = Readonly<{
  state: V4ModelAvailabilityState
  checkedAt: string | null
}>

type ModelAvailabilityRequirement = Readonly<{
  model: V4ConfiguredModel
  group: AvailabilityGroup
}>

type V4ModelPolicyInput = Readonly<{
  runtimeMode: V4RuntimeMode
  models: readonly V4ConfiguredModel[]
  textGeneration?: V4TextGenerationCapability
  availabilityProbes?: Readonly<Partial<Record<AvailabilityGroup, V4ModelAvailabilityProbe>>>
  availabilityTtlMs?: number
  now?: () => Date
}>

function modelRoleGroup(role: V4ModelRole): AvailabilityGroup {
  return role === 'TEXT' || role === 'VISION' ? 'text' : 'image'
}

function uniqueModels(models: readonly string[]) {
  return [...new Set(models)]
}

function uniqueConfiguredModels(models: readonly V4ConfiguredModel[]) {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.model)) return false
    seen.add(model.model)
    return true
  })
}

function availabilityKey(group: AvailabilityGroup, model: string) {
  return `${group}\u0000${model}`
}

function uniqueAvailabilityRequirements(requirements: readonly ModelAvailabilityRequirement[]) {
  const seen = new Set<string>()
  return requirements.filter((requirement) => {
    const key = availabilityKey(requirement.group, requirement.model.model)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function initialSnapshot(): ModelAvailabilitySnapshot {
  return { state: 'UNKNOWN', checkedAt: null }
}

function completeAttestationText(value: string | null) {
  return typeof value === 'string' && value.trim().length > 0
}

export class V4ModelPolicy {
  readonly runtimeMode: V4RuntimeMode
  private readonly models: readonly V4ConfiguredModel[]
  private readonly availabilityProbes: Readonly<Partial<Record<AvailabilityGroup, V4ModelAvailabilityProbe>>>
  private readonly availabilityTtlMs: number
  private readonly now: () => Date
  private readonly availability = new Map<string, ModelAvailabilitySnapshot>()
  private readonly nextRefreshAt = new Map<AvailabilityGroup, number>()
  private readonly refreshing = new Map<AvailabilityGroup, Promise<void>>()
  private readonly textGeneration: V4TextGenerationCapability

  constructor(input: V4ModelPolicyInput) {
    if (input.models.length < 1 || input.models.length > 20) throw new Error('V4_MODEL_POLICY_MODELS_INVALID')
    if (!Number.isSafeInteger(input.availabilityTtlMs ?? 120_000)
      || (input.availabilityTtlMs ?? 120_000) < 10_000
      || (input.availabilityTtlMs ?? 120_000) > 60 * 60_000) {
      throw new Error('V4_MODEL_AVAILABILITY_TTL_INVALID')
    }
    const seen = new Set<string>()
    this.models = input.models.map((model) => {
      const name = model.model.trim()
      if (name.length < 1 || name.length > 120 || seen.has(name)) {
        throw new Error('V4_MODEL_POLICY_MODELS_INVALID')
      }
      if (model.roles.length < 1 || model.roles.length > 4 || new Set(model.roles).size !== model.roles.length) {
        throw new Error('V4_MODEL_POLICY_ROLES_INVALID')
      }
      seen.add(name)
      for (const role of model.roles) {
        this.availability.set(availabilityKey(modelRoleGroup(role), name), initialSnapshot())
      }
      return {
        ...model,
        model: name,
        roles: [...model.roles],
        readiness: { ...model.readiness },
      }
    })
    this.runtimeMode = input.runtimeMode
    this.textGeneration = v4TextGenerationCapabilitySchema.parse(input.textGeneration ?? (
      input.runtimeMode === 'MOCK'
        ? { protocol: 'LOCAL_MOCK', streaming: false }
        : { protocol: 'UNAVAILABLE', streaming: false }
    ))
    this.availabilityProbes = input.availabilityProbes ?? {}
    this.availabilityTtlMs = input.availabilityTtlMs ?? 120_000
    this.now = input.now ?? (() => new Date())
  }

  evaluationModels(role: V4ModelRole) {
    return uniqueModels(this.models
      .filter((model) => model.evaluationEnabled && model.roles.includes(role))
      .map((model) => model.model))
  }

  quickDeckResponsesTextModels() {
    return uniqueModels(this.models
      .filter((model) => model.evaluationEnabled
        && model.roles.includes('TEXT')
        && this.readinessPassed(model)
        && model.readiness.structuredGenerationProtocol === 'RESPONSES_JSON_SCHEMA')
      .map((model) => model.model))
  }

  quickDeckImageModels() {
    return uniqueModels(this.models
      .filter((model) => model.evaluationEnabled
        && model.roles.includes('IMAGE')
        && this.readinessPassed(model))
      .map((model) => model.model))
  }

  allowsQuickDeckModels(selection: V4QuickDeckModelSelection) {
    const textModel = selection.textModel.trim()
    const imageModels = uniqueModels(selection.imageModels.map((model) => model.trim()))
    return textModel.length > 0
      && imageModels.length > 0
      && this.quickDeckResponsesTextModels().includes(textModel)
      && imageModels.every((model) => model.length > 0 && this.quickDeckImageModels().includes(model))
  }

  publishedModels(role: V4ModelRole) {
    return uniqueModels(this.models
      .filter((model) => model.published
        && this.readinessPassed(model)
        && model.roles.includes(role)
        && (role === 'TEXT' || role === 'VISION'
          ? model.readiness.structuredGenerationProtocol === 'RESPONSES_JSON_SCHEMA'
          : true))
      .map((model) => model.model))
  }

  async assertNewRunAllowed(request: CreateRunRequest) {
    await this.createNewRunSnapshot(request)
  }

  async createNewRunSnapshot(request: CreateRunRequest): Promise<V4RunModelSnapshot | null> {
    if (request.presentationMode !== 'VISUAL_DECK_V4') return null
    if (this.runtimeMode === 'GATEWAY'
      && this.textGeneration.protocol !== 'RESPONSES_JSON_SCHEMA') {
      throw new V4ModelPolicyError('V4_CHAIN4_PROTOCOL_UNSUPPORTED', 422)
    }
    const image = this.models.find((model) => model.model === request.imageModel && model.roles.includes('IMAGE'))
    if (!image || !image.published) {
      throw new V4ModelPolicyError('V4_IMAGE_MODEL_NOT_ALLOWED', 422)
    }
    if (!this.readinessPassed(image)) throw new V4ModelPolicyError('V4_MODEL_NOT_READY', 422)
    const text = this.newRunModelForRole('TEXT')
    const vision = this.newRunModelForRole('VISION')
    const imageEdit = this.modelsForRole('IMAGE_EDIT').filter((model) => model.published && this.readinessPassed(model))
    if (imageEdit.length > 1) throw new V4ModelPolicyError('V4_MODEL_NOT_READY', 422)
    const required = uniqueConfiguredModels([
      text,
      vision,
      image,
      ...imageEdit,
    ])
    if (required.some((model) => !model.published || !this.readinessPassed(model))) {
      throw new V4ModelPolicyError('V4_MODEL_NOT_READY', 422)
    }
    const availabilityRequirements = uniqueAvailabilityRequirements([
      { model: text, group: 'text' as const },
      { model: vision, group: 'text' as const },
      { model: image, group: 'image' as const },
      ...imageEdit.map((model) => ({ model, group: 'image' as const })),
    ])
    await this.refreshAvailability(availabilityRequirements)
    if (availabilityRequirements.some((requirement) => this.modelAvailability(requirement).state !== 'HEALTHY')) {
      throw new V4ModelPolicyError('V4_MODEL_UNAVAILABLE', 503)
    }
    return {
      schemaVersion: '1',
      textModel: text.model,
      visionModel: vision.model,
      imageModel: image.model,
      imageEditModel: imageEdit[0]?.model ?? null,
    }
  }

  async publicCapabilities(quickDeckAvailable = false): Promise<PublicCapabilities> {
    const text = this.publishedModels('TEXT')
    const vision = this.publishedModels('VISION')
    const image = this.publishedModels('IMAGE')
    const imageEdit = this.publishedModels('IMAGE_EDIT')
    await this.refreshAvailability(this.availabilityRequirements(
      this.models.filter((model) => model.published && this.readinessPassed(model)),
    ))
    return createPublicCapabilities({
      runtimeMode: this.runtimeMode,
      textModels: text,
      visionModels: vision,
      imageModels: image,
      imageEditModels: imageEdit,
      modelAvailability: {
        text: this.publicAvailability(text, 'text'),
        vision: this.publicAvailability(vision, 'text'),
        image: this.publicAvailability(image, 'image'),
        imageEdit: this.publicAvailability(imageEdit, 'image'),
      },
      textGeneration: this.textGeneration,
      quickDeckAvailable,
    })
  }

  private modelsForRole(role: V4ModelRole) {
    return this.models.filter((model) => model.roles.includes(role))
  }

  private newRunModelForRole(role: 'TEXT' | 'VISION') {
    const models = this.modelsForRole(role).filter((model) => model.published
      && this.readinessPassed(model)
      && model.readiness.structuredGenerationProtocol === 'RESPONSES_JSON_SCHEMA')
    if (models.length !== 1) throw new V4ModelPolicyError('V4_MODEL_NOT_READY', 422)
    return models[0]!
  }

  private readinessPassed(model: V4ConfiguredModel) {
    const readiness = model.readiness
    if (readiness.status !== 'PASSED'
      || !completeAttestationText(readiness.evaluationRelease)
      || !completeAttestationText(readiness.gatewayContractVersion)
      || !completeAttestationText(readiness.evaluationSuite)
      || !readiness.evaluatedAt
      || !readiness.expiresAt) return false
    const evaluatedAt = new Date(readiness.evaluatedAt).getTime()
    const expiresAt = new Date(readiness.expiresAt).getTime()
    const now = this.now().getTime()
    return Number.isFinite(evaluatedAt)
      && Number.isFinite(expiresAt)
      && evaluatedAt <= now
      && now < expiresAt
  }

  private modelAvailability(requirement: ModelAvailabilityRequirement) {
    return this.availability.get(availabilityKey(requirement.group, requirement.model.model)) ?? initialSnapshot()
  }

  private publicAvailability(models: readonly string[], group: AvailabilityGroup) {
    return models.map((model) => {
      const snapshot = this.availability.get(availabilityKey(group, model)) ?? initialSnapshot()
      return { model, state: snapshot.state, checkedAt: snapshot.checkedAt }
    })
  }

  private availabilityRequirements(models: readonly V4ConfiguredModel[]) {
    return uniqueAvailabilityRequirements(models.flatMap((model) =>
      model.roles.map((role) => ({ model, group: modelRoleGroup(role) })),
    ))
  }

  private async refreshAvailability(requirements: readonly ModelAvailabilityRequirement[]) {
    const groups = new Set(requirements.map((requirement) => requirement.group))
    await Promise.all([...groups].map((group) => this.refreshGroup(group)))
  }

  private async refreshGroup(group: AvailabilityGroup): Promise<void> {
    const now = this.now()
    const nextRefreshAt = this.nextRefreshAt.get(group) ?? 0
    if (now.getTime() < nextRefreshAt) return
    const inFlight = this.refreshing.get(group)
    if (inFlight) return inFlight
    const refresh = this.refreshGroupNow(group, now).finally(() => this.refreshing.delete(group))
    this.refreshing.set(group, refresh)
    return refresh
  }

  private async refreshGroupNow(group: AvailabilityGroup, now: Date) {
    const scoped = this.models.filter((model) => model.roles.some((role) => modelRoleGroup(role) === group))
    const probe = this.availabilityProbes[group]
    if (!probe && this.runtimeMode === 'MOCK') {
      for (const model of scoped) {
        this.availability.set(availabilityKey(group, model.model), { state: 'HEALTHY', checkedAt: null })
      }
      this.nextRefreshAt.set(group, now.getTime() + this.availabilityTtlMs)
      return
    }
    if (!probe) return
    try {
      const visible = new Set(await probe.listModels())
      for (const model of scoped) {
        this.availability.set(availabilityKey(group, model.model), {
          state: visible.has(model.model) ? 'HEALTHY' : 'UNAVAILABLE',
          checkedAt: now.toISOString(),
        })
      }
    } catch {
      for (const model of scoped) {
        this.availability.set(availabilityKey(group, model.model), { state: 'DEGRADED', checkedAt: now.toISOString() })
      }
    } finally {
      this.nextRefreshAt.set(group, now.getTime() + this.availabilityTtlMs)
    }
  }

  static mock() {
    const ready: V4ModelReadinessRecord = {
      status: 'PASSED',
      evaluationRelease: 'local-mock',
      gatewayContractVersion: 'LOCAL_MOCK',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      evaluatedAt: '2026-01-01T00:00:00.000Z',
      evaluationSuite: 'local-mock',
      expiresAt: '9999-12-31T23:59:59.999Z',
    }
    return new V4ModelPolicy({
      runtimeMode: 'MOCK',
      textGeneration: { protocol: 'LOCAL_MOCK', streaming: false },
      models: [
        { model: 'local-mock-text', roles: ['TEXT'], evaluationEnabled: true, published: true, readiness: ready },
        { model: 'local-mock-vision', roles: ['VISION'], evaluationEnabled: true, published: true, readiness: ready },
        { model: 'local-mock-image', roles: ['IMAGE'], evaluationEnabled: true, published: true, readiness: ready },
      ],
    })
  }
}

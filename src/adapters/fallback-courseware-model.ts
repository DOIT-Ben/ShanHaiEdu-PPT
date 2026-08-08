import type {
  AssetCandidateReviewPort,
  DeckReviewPort,
  RevisionApplicationPort,
  RevisionPlanningPort,
  StructuredGenerationRequestContractPort,
  StructuredGenerationPreflightPort,
  StructuredModelPort,
  VisualReviewPort,
} from '../core/ports'
import { StructuredModelError } from '../core/ports'

export type CoursewareModelPorts = StructuredModelPort
  & AssetCandidateReviewPort
  & VisualReviewPort
  & DeckReviewPort
  & RevisionPlanningPort
  & RevisionApplicationPort
  & Readonly<{ modelName: string }>

const FALLBACK_ERROR_CODES = new Set<StructuredModelError['code']>([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
])

function isChain4ManuscriptOperation(input: unknown) {
  if (!input || typeof input !== 'object' || !('operation' in input)) return false
  return input.operation === 'create_visual_deck_v4_creative_manuscript'
    || input.operation === 'review_visual_deck_v4_manuscript'
}

export class FallbackCoursewareModel implements CoursewareModelPorts, StructuredGenerationRequestContractPort {
  readonly modelName: string

  constructor(private readonly dependencies: Readonly<{
    primary: CoursewareModelPorts
    fallback: CoursewareModelPorts
  }>) {
    this.modelName = dependencies.primary.modelName
  }

  execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    return this.withFallback('execute', input)
  }

  async preflightStructuredGeneration(input: Parameters<StructuredGenerationPreflightPort['preflightStructuredGeneration']>[0]) {
    const primary = this.dependencies.primary as CoursewareModelPorts & Partial<StructuredGenerationPreflightPort>
    const fallback = this.dependencies.fallback as CoursewareModelPorts & Partial<StructuredGenerationPreflightPort>
    if (!primary.preflightStructuredGeneration || !fallback.preflightStructuredGeneration) {
      throw new Error('STRUCTURED_GENERATION_PREFLIGHT_UNAVAILABLE')
    }
    try {
      return await primary.preflightStructuredGeneration(input)
    } catch (error) {
      if (input.requiredProtocol === 'RESPONSES_JSON_SCHEMA' || input.modelOverride) throw error
      if (!(error instanceof StructuredModelError) || !FALLBACK_ERROR_CODES.has(error.code)) throw error
      return fallback.preflightStructuredGeneration(input)
    }
  }

  async describeStructuredGenerationRequest(input: Parameters<StructuredGenerationRequestContractPort['describeStructuredGenerationRequest']>[0]) {
    const primary = this.dependencies.primary as CoursewareModelPorts & Partial<StructuredGenerationRequestContractPort>
    const fallback = this.dependencies.fallback as CoursewareModelPorts & Partial<StructuredGenerationRequestContractPort>
    if (!primary.describeStructuredGenerationRequest) {
      throw new Error('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
    }
    try {
      return await primary.describeStructuredGenerationRequest(input)
    } catch (error) {
      if (isChain4ManuscriptOperation(input)
        || input.structuredGenerationProtocol === 'RESPONSES_JSON_SCHEMA'
        || input.modelOverride) throw error
      if (!fallback.describeStructuredGenerationRequest
        || !(error instanceof StructuredModelError)
        || !FALLBACK_ERROR_CODES.has(error.code)) throw error
      return fallback.describeStructuredGenerationRequest(input)
    }
  }

  reviewCandidate(input: Parameters<AssetCandidateReviewPort['reviewCandidate']>[0]) {
    return this.withFallback('reviewCandidate', input)
  }

  review(input: Parameters<VisualReviewPort['review']>[0]) {
    return this.withFallback('review', input)
  }

  evaluate(input: Parameters<DeckReviewPort['evaluate']>[0]) {
    return this.withFallback('evaluate', input)
  }

  plan(input: Parameters<RevisionPlanningPort['plan']>[0]) {
    return this.withFallback('plan', input)
  }

  apply(input: Parameters<RevisionApplicationPort['apply']>[0]) {
    return this.withFallback('apply', input)
  }

  private async withFallback<
    Method extends keyof Pick<CoursewareModelPorts, 'execute' | 'reviewCandidate' | 'review' | 'evaluate' | 'plan' | 'apply'>,
  >(method: Method, input: Parameters<CoursewareModelPorts[Method]>[0]) {
    try {
      return await (this.dependencies.primary[method] as (value: typeof input) => Promise<unknown>)(input)
    } catch (error) {
      if (isChain4ManuscriptOperation(input)
        || ('structuredGenerationProtocol' in input
          && (input.structuredGenerationProtocol === 'RESPONSES_JSON_SCHEMA' || input.modelOverride))) throw error
      if (!(error instanceof StructuredModelError) || !FALLBACK_ERROR_CODES.has(error.code)) throw error
      return (this.dependencies.fallback[method] as (value: typeof input) => Promise<unknown>)(input)
    }
  }
}

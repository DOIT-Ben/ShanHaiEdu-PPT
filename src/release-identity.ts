import { z } from 'zod'

export const PPT_AGENT_SOFTWARE_VERSION = '4.3.1'
export const PPT_AGENT_CONTRACT_VERSION = '1'
export const LEGACY_VISUAL_DECK_V4_COMPILER_VERSION = 'visual-deck-v4-chain-1'
export const CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION = 'visual-deck-v4-chain-2'
export const CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION = 'visual-deck-v4-chain-3'
export const VISUAL_DECK_V4_COMPILER_VERSION = 'visual-deck-v4-chain-4'
export const SUPPORTED_VISUAL_DECK_V4_COMPILER_VERSIONS = [
  LEGACY_VISUAL_DECK_V4_COMPILER_VERSION,
  CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION,
  CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION,
  VISUAL_DECK_V4_COMPILER_VERSION,
] as const

export function isSupportedVisualDeckV4CompilerVersion(value: string) {
  return (SUPPORTED_VISUAL_DECK_V4_COMPILER_VERSIONS as readonly string[]).includes(value)
}

export function usesPatchRevisionContract(value: string) {
  return value === CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION
    || value === CHAIN_3_VISUAL_DECK_V4_COMPILER_VERSION
}

const identifierSchema = z.string().trim().min(1).max(160)

export const releaseIdentitySchema = z.object({
  softwareVersion: identifierSchema,
  presentationMode: z.enum([
    'SLIDE_IMAGE_V2',
    'SLIDE_IMAGE_V2_1',
    'LAYERED_COURSEWARE_V3',
    'VISUAL_DECK_V4',
  ]),
  compilerVersion: identifierSchema,
  contractVersion: identifierSchema,
  gitSha: identifierSchema,
  releaseId: identifierSchema,
}).strict()

export type ReleaseIdentity = z.infer<typeof releaseIdentitySchema>
export type PresentationModeIdentity = ReleaseIdentity['presentationMode']

export type BuildIdentity = Readonly<{
  softwareVersion: string
  contractVersion: string
  gitSha: string
  releaseId: string
}>

export function buildIdentity(input: Partial<BuildIdentity> = {}): BuildIdentity {
  return {
    softwareVersion: input.softwareVersion ?? PPT_AGENT_SOFTWARE_VERSION,
    contractVersion: input.contractVersion ?? PPT_AGENT_CONTRACT_VERSION,
    gitSha: input.gitSha ?? 'development',
    releaseId: input.releaseId ?? 'development',
  }
}

export function compilerVersionForMode(mode: PresentationModeIdentity) {
  switch (mode) {
    case 'VISUAL_DECK_V4': return VISUAL_DECK_V4_COMPILER_VERSION
    case 'LAYERED_COURSEWARE_V3': return 'layered-courseware-v3-1'
    case 'SLIDE_IMAGE_V2_1': return 'slide-image-v2.1-1'
    case 'SLIDE_IMAGE_V2': return 'slide-image-v2-1'
  }
}

export function releaseIdentityForMode(build: BuildIdentity, presentationMode: PresentationModeIdentity): ReleaseIdentity {
  return releaseIdentitySchema.parse({
    ...build,
    presentationMode,
    compilerVersion: compilerVersionForMode(presentationMode),
  })
}

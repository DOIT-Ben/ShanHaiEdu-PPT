import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import packageMetadata from '../package.json'
import {
  PPT_AGENT_CONTRACT_VERSION,
  PPT_AGENT_SOFTWARE_VERSION,
  SUPPORTED_VISUAL_DECK_V4_COMPILER_VERSIONS,
  VISUAL_DECK_V4_COMPILER_VERSION,
} from '../src/release-identity'

describe('PPT Agent V4 release identity', () => {
  test('keeps chain-1/2/3 recovery identities while new runs use the semantic compiler', () => {
    expect(PPT_AGENT_SOFTWARE_VERSION).toBe('4.4.0')
    expect(packageMetadata.version).toBe(PPT_AGENT_SOFTWARE_VERSION)
    expect(VISUAL_DECK_V4_COMPILER_VERSION).toBe('visual-deck-v4-chain-4')
    expect(SUPPORTED_VISUAL_DECK_V4_COMPILER_VERSIONS).toEqual([
      'visual-deck-v4-chain-1',
      'visual-deck-v4-chain-2',
      'visual-deck-v4-chain-3',
      'visual-deck-v4-chain-4',
    ])
    expect(PPT_AGENT_CONTRACT_VERSION).toBe('1')
  })

  test('keeps the deployment environment example on the same software version', () => {
    const environmentExample = readFileSync(
      new URL('../deploy/aliyun/ppt-agent.env.example', import.meta.url),
      'utf8',
    )
    expect(environmentExample).toContain(`PPT_AGENT_SOFTWARE_VERSION=${PPT_AGENT_SOFTWARE_VERSION}`)
    expect(environmentExample).toContain('PPT_AGENT_V4_REVISION_IMAGE_MODEL=gpt-image-2')
    expect(environmentExample).toContain('"model":"gemini-3-pro-image-preview"')
    expect(environmentExample).not.toContain('PPT_AGENT_V4_REVISION_IMAGE_MODEL=image-2')
    expect(environmentExample).not.toContain('"model":"image-2"')
    expect(environmentExample).not.toContain('"model":"nano-banana-pro"')
    expect(environmentExample).not.toContain('nanobanana')
    expect(environmentExample).not.toContain('PPT_AGENT_SOFTWARE_VERSION=4.0.0')
  })
})

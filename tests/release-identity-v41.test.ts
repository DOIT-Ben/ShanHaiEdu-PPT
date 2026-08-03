import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import packageMetadata from '../package.json'
import {
  PPT_AGENT_CONTRACT_VERSION,
  PPT_AGENT_SOFTWARE_VERSION,
  SUPPORTED_VISUAL_DECK_V4_COMPILER_VERSIONS,
  VISUAL_DECK_V4_COMPILER_VERSION,
} from '../src/release-identity'

describe('PPT Agent V4.2 release identity', () => {
  test('distinguishes the five-stage reflection compiler from the old four-stage compiler', () => {
    expect(PPT_AGENT_SOFTWARE_VERSION).toBe('4.2.0')
    expect(packageMetadata.version).toBe(PPT_AGENT_SOFTWARE_VERSION)
    expect(VISUAL_DECK_V4_COMPILER_VERSION).toBe('visual-deck-v4-chain-3')
    expect(SUPPORTED_VISUAL_DECK_V4_COMPILER_VERSIONS).toEqual([
      'visual-deck-v4-chain-1',
      'visual-deck-v4-chain-2',
      'visual-deck-v4-chain-3',
    ])
    expect(PPT_AGENT_CONTRACT_VERSION).toBe('1')
  })

  test('keeps the deployment environment example on the same software version', () => {
    const environmentExample = readFileSync(
      new URL('../deploy/aliyun/ppt-agent.env.example', import.meta.url),
      'utf8',
    )
    expect(environmentExample).toContain(`PPT_AGENT_SOFTWARE_VERSION=${PPT_AGENT_SOFTWARE_VERSION}`)
    expect(environmentExample).toContain('PPT_AGENT_V4_REVISION_IMAGE_MODEL=image-2')
    expect(environmentExample).not.toContain('PPT_AGENT_SOFTWARE_VERSION=4.0.0')
  })
})

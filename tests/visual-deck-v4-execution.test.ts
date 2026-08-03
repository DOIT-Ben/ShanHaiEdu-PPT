import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { SharpPptxPresentationRenderer } from '../src/adapters/presentation-renderer'
import { blueprintImageRequirements } from '../src/core/blueprint-assets'
import { createVisualDeckV4Blueprint } from '../src/core/visual-deck-v4-planner'

function blueprint() {
  const source = {
    kind: 'SOURCE_PACKAGE' as const,
    name: '分数课程资料',
    sources: [
      { kind: 'TEXT' as const, sourceId: 'lesson', name: '教材.md', roleHint: 'CONTENT_SOURCE' as const, text: '把一个蛋糕平均分成两份，其中一份是二分之一。'.repeat(4) },
      { kind: 'TEXT' as const, sourceId: 'practice', name: '练习.md', roleHint: 'TEACHING_GUIDE' as const, text: '判断图形是否平均分，并说出涂色部分表示的分数。'.repeat(4) },
    ],
  }
  return createVisualDeckV4Blueprint({
    runId: 'run-v4-execution',
    inputHash: 'input-v4-execution',
    source,
    document: {
      name: source.name,
      chunks: [
        { id: 'chunk-lesson', sourceId: 'lesson', text: source.sources[0]!.text, sha256: 'a'.repeat(64) },
        { id: 'chunk-practice', sourceId: 'practice', text: source.sources[1]!.text, sha256: 'b'.repeat(64) },
      ],
      sources: [
        { id: 'lesson', name: '教材.md', kind: 'MARKDOWN', status: 'READY' },
        { id: 'practice', name: '练习.md', kind: 'MARKDOWN', status: 'READY' },
      ],
      isComplete: true,
      missingRanges: [],
    },
    config: {
      instruction: '制作一套学生能够理解分数意义的完整视觉演示',
      sourceMode: 'SOURCE_GROUNDED',
      deckOptions: {
        deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 }, aspectRatio: '16:9',
        audience: '小学三年级学生', focus: '平均分与二分之一', styleHint: '温暖的儿童绘本课堂视觉',
      },
    },
    slideCount: 2,
    visualDirection: '温暖的儿童绘本课堂视觉',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
}

describe('visual deck v4 execution', () => {
  test('compiles one isolated full-slide image instruction per approved brief', () => {
    const planned = blueprint()
    planned.visualDeckV4Proposal!.slideBriefs[0]!.facts = [
      '教材对应第20—21页，并引导学生说出本课学习结论。',
    ]
    const requirements = blueprintImageRequirements({ id: 'run-v4-execution', revisionRound: 0 }, planned)
    const briefs = planned.visualDeckV4Proposal!.slideBriefs

    expect(requirements).toHaveLength(2)
    expect(requirements[0]?.prompt).toContain('single raster image')
    expect(requirements[0]?.prompt).toContain('Allowed on-slide copy')
    expect(requirements[0]?.prompt).toContain('CLOSED VISIBLE TEXT ALLOWLIST')
    expect(requirements[0]?.prompt).toContain('NON-VISIBLE facts for semantic and counting accuracy only')
    expect(requirements[0]?.prompt).toContain('Never transcribe, quote, paraphrase, summarize, caption, or display')
    expect(requirements[0]?.negativePrompt).toContain('page citations or page ranges')
    expect(requirements[0]?.negativePrompt).toContain('facts-field prose')
    expect(requirements[0]?.prompt).toContain(briefs[0]!.title)
    expect(requirements[0]?.prompt).toContain(briefs[0]!.lockedCopy[0]!)
    expect(requirements[0]?.prompt).toContain('Do not invent any additional labels')
    expect(requirements[0]?.prompt).toContain('COUNTABLE OBJECT SAFETY')
    expect(requirements[0]?.prompt).toContain('Never duplicate solid objects')
    expect(requirements[0]?.prompt).toContain('视觉元素独立性要求')
    expect(requirements[0]?.prompt).toContain('不得将两个或多个主要元素绑定、粘合、嵌套或合成为不可分割的组合主体')
    expect(requirements[0]?.prompt).toContain('除非用户明确要求物理接触')
    expect(requirements[0]?.prompt).not.toContain(briefs[1]!.title)
    expect(requirements[0]?.prompt).not.toContain(briefs[1]!.keyClaim)
    expect(requirements[1]?.prompt).not.toContain(briefs[0]!.keyClaim)
  })

  test('renders previews and pptx pages as one full-slide raster without native text', async () => {
    const planned = blueprint()
    planned.title = '5以内数的分与合'
    const renderer = new SharpPptxPresentationRenderer()
    const images = await Promise.all([
      sharp({ create: { width: 800, height: 450, channels: 3, background: '#E5484D' } }).png().toBuffer(),
      sharp({ create: { width: 800, height: 450, channels: 3, background: '#1F6FEB' } }).png().toBuffer(),
    ])
    const input = {
      blueprint: planned,
      slides: images.map((image, index) => ({ pageNumber: index + 1, image, imageMimeType: 'image/png' })),
    }
    const previews = await renderer.renderSlidePreviews(input)
    const first = await sharp(previews[0]!.image).raw().toBuffer({ resolveWithObject: true })
    expect(first.info).toMatchObject({ width: 1600, height: 900 })
    expect([...first.data.subarray(0, 3)]).toEqual([229, 72, 77])

    const pptx = await renderer.renderPptx(input)
    const directory = await mkdtemp(join(tmpdir(), 'ppt-agent-v4-raster-'))
    try {
      const path = join(directory, 'visual-deck.pptx')
      await writeFile(path, pptx)
      const process = Bun.spawn(['unzip', '-p', path, 'ppt/slides/slide1.xml'], { stdout: 'pipe', stderr: 'pipe' })
      const xml = await new Response(process.stdout).text()
      expect(await process.exited).toBe(0)
      expect(xml.match(/<p:pic>/g)).toHaveLength(1)
      expect(xml).toContain('visual-deck-page-1')
      expect(xml).not.toContain('<a:t>')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

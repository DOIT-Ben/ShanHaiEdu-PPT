import { describe, expect, test } from 'bun:test'
import { presentationBlueprintSchema } from '../src/presentation-contracts'

function image(elementId: string, role: 'BASE_LAYER' | 'KNOWLEDGE_VISUAL', x: number, reuseKey?: string) {
  return {
    kind: 'IMAGE' as const,
    elementId,
    role,
    knowledgePoint: role === 'BASE_LAYER' ? '建立本页知识情境' : '用具体对象解释数量关系',
    prompt: `A text-free classroom illustration for ${elementId}, directly supporting the lesson knowledge point`,
    negativePrompt: 'text, numbers, formulas, logos, watermarks',
    sourceChunkIds: ['chunk-1'],
    placement: { x, y: role === 'BASE_LAYER' ? 0 : 0.22, width: role === 'BASE_LAYER' ? 1 : 0.28, height: role === 'BASE_LAYER' ? 1 : 0.46 },
    zIndex: role === 'BASE_LAYER' ? 0 : 10,
    fit: 'CONTAIN' as const,
    aspectRatio: role === 'BASE_LAYER' ? '16:9' as const : '1:1' as const,
    backgroundMode: role === 'BASE_LAYER' ? 'OPAQUE' as const : 'TRANSPARENT' as const,
    ...(reuseKey ? { reuseKey } : {}),
  }
}

function text(elementId: string, role: 'TITLE' | 'BODY', value: string, y: number) {
  return {
    kind: 'TEXT' as const,
    elementId,
    role,
    text: value,
    sourceChunkIds: ['chunk-1'],
    placement: { x: 0.08, y, width: 0.42, height: role === 'TITLE' ? 0.16 : 0.28 },
    zIndex: 20,
    style: { fontSize: role === 'TITLE' ? 30 : 18, bold: role === 'TITLE', color: '#17202A', align: 'LEFT' as const },
  }
}

function shape(elementId: string) {
  return {
    kind: 'SHAPE' as const,
    elementId,
    role: 'CONTENT_PANEL' as const,
    shape: 'RECTANGLE' as const,
    placement: { x: 0.05, y: 0.08, width: 0.48, height: 0.82 },
    zIndex: 15,
    fillColor: '#FFFFFF',
    transparency: 8,
  }
}

function layeredBlueprint() {
  return {
    id: 'blueprint-v3-1',
    title: '1～5的认识',
    visualDirection: '纸黏土儿童课堂插画，明亮清晰，知识对象准确',
    renderMode: 'LAYERED_COURSEWARE_V3' as const,
    coverDesignMode: 'INDEPENDENT' as const,
    createdAt: '2026-07-21T00:00:00.000Z',
    curriculum: {
      subject: '数学', grade: '一年级', lessonTitle: '1～5的认识',
      sourceSummary: '教材通过具体物体帮助学生建立一到五的数量对应关系。',
      learningObjectives: ['建立数量与数字的对应关系'], scopeBoundaries: ['只学习一到五'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: pageNumber === 1 ? '1～5的认识' : '认识数量 3',
      body: ['观察三个苹果，理解数量 3'],
      layout: pageNumber === 1 ? 'HERO' as const : 'SPLIT' as const,
      visualIntent: pageNumber === 1 ? '用独立封面建立课程期待' : '用三个苹果解释数量三',
      visualPrompt: `A text-free educational illustration for page ${pageNumber}`,
      sourceChunkIds: ['chunk-1'],
      layeredDesign: {
        designKind: pageNumber === 1 ? 'COVER' as const : 'CONTENT' as const,
        backgroundColor: '#F7FBFA',
        elements: pageNumber === 1 ? [
          image('base-1', 'BASE_LAYER', 0),
          image('apples-1', 'KNOWLEDGE_VISUAL', 0.62, 'apples-three'),
          text('title-1', 'TITLE', '1～5的认识', 0.18),
        ] : [
          image(`base-${pageNumber}`, 'BASE_LAYER', 0),
          image(`apples-${pageNumber}`, 'KNOWLEDGE_VISUAL', 0.62, 'apples-three'),
          shape(`panel-${pageNumber}`),
          text(`title-${pageNumber}`, 'TITLE', '认识数量 3', 0.18),
          text(`body-${pageNumber}`, 'BODY', '观察三个苹果，理解数量 3', 0.44),
        ],
      },
    })),
  }
}

describe('layered courseware v3 contract', () => {
  test('accepts an independent cover and knowledge-grounded editable layers', () => {
    const parsed = presentationBlueprintSchema.parse(layeredBlueprint())
    expect(parsed.renderMode).toBe('LAYERED_COURSEWARE_V3')
    expect(parsed.slides[0]?.layeredDesign?.designKind).toBe('COVER')
    expect(parsed.slides[1]?.layeredDesign?.elements).toHaveLength(5)
  })

  test('requires the first page to be a cover and defaults it to independent design', () => {
    const missingMode = layeredBlueprint()
    delete (missingMode as { coverDesignMode?: string }).coverDesignMode
    const parsed = presentationBlueprintSchema.parse(missingMode)
    expect(parsed.coverDesignMode).toBe('INDEPENDENT')

    const invalid = layeredBlueprint()
    invalid.slides[0]!.layeredDesign.designKind = 'CONTENT'
    expect(() => presentationBlueprintSchema.parse(invalid)).toThrow('first layered slide must be COVER')
  })

  test('rejects a body template on an independent cover but allows the explicit template exception', () => {
    const invalid = layeredBlueprint()
    invalid.slides[0]!.layeredDesign.elements.push(
      shape('cover-panel'),
      text('cover-body', 'BODY', '这是不应出现在独立封面中的正文。', 0.44),
    )
    expect(() => presentationBlueprintSchema.parse(invalid)).toThrow('independent cover requires title and hero visual')

    expect(presentationBlueprintSchema.parse({ ...invalid, coverDesignMode: 'FOLLOW_TEMPLATE' }).coverDesignMode)
      .toBe('FOLLOW_TEMPLATE')
  })

  test('rejects out-of-bounds placement and images without curriculum grounding', () => {
    const overflow = layeredBlueprint()
    const element = overflow.slides[1]!.layeredDesign.elements[1]!
    if (element.kind === 'IMAGE') element.placement.x = 0.9
    expect(() => presentationBlueprintSchema.parse(overflow)).toThrow('element placement must stay inside the slide')

    const ungrounded = layeredBlueprint()
    const imageElement = ungrounded.slides[1]!.layeredDesign.elements[1]!
    if (imageElement.kind === 'IMAGE') imageElement.sourceChunkIds = []
    expect(() => presentationBlueprintSchema.parse(ungrounded)).toThrow()
  })

  test('allows one base layer and at most four knowledge visuals with unique element ids', () => {
    const duplicate = layeredBlueprint()
    duplicate.slides[1]!.layeredDesign.elements[1]!.elementId = 'base-2'
    expect(() => presentationBlueprintSchema.parse(duplicate)).toThrow('layer element ids must be unique')

    const crowded = layeredBlueprint()
    crowded.slides[1]!.layeredDesign.elements.push(
      image('extra-1', 'KNOWLEDGE_VISUAL', 0.02),
      image('extra-2', 'KNOWLEDGE_VISUAL', 0.16),
      image('extra-3', 'KNOWLEDGE_VISUAL', 0.30),
      image('extra-4', 'KNOWLEDGE_VISUAL', 0.44),
    )
    expect(() => presentationBlueprintSchema.parse(crowded)).toThrow('at most four knowledge visual assets')
  })

  test('records source asset lineage and requires it for reuse or reference generation', () => {
    const reusable = layeredBlueprint()
    const element = reusable.slides[1]!.layeredDesign.elements[1]!
    if (element.kind !== 'IMAGE') throw new Error('expected image element')
    Object.assign(element, {
      sourceAssetIds: ['source-asset-1'],
      sourceAssetStrategy: 'REUSE_ORIGINAL',
    })
    const parsed = presentationBlueprintSchema.parse(reusable)
    const parsedElement = parsed.slides[1]!.layeredDesign!.elements[1]!
    expect(parsedElement.kind === 'IMAGE' && parsedElement.sourceAssetIds).toEqual(['source-asset-1'])

    Object.assign(element, { sourceAssetIds: [] })
    expect(() => presentationBlueprintSchema.parse(reusable)).toThrow('source asset reuse requires a source asset id')
  })
})

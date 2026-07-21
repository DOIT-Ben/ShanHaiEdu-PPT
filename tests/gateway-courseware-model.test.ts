import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { GatewayCoursewareModel } from '../src/adapters/gateway-courseware-model'
import { MockArtifactPort } from '../src/adapters/mock-ports'
import { blueprintDraftSchema } from '../src/presentation-contracts'

function blueprintDraft() {
  return blueprintDraftSchema.parse({
    title: '认识数量三',
    curriculum: {
      subject: '数学', grade: '一年级', lessonTitle: '认识数量三',
      sourceSummary: '教材通过三个苹果帮助学生建立数量三和具体物体的对应关系。',
      learningObjectives: ['建立数量三与具体物体的对应关系'], scopeBoundaries: ['只学习数量三'],
      prohibitedExtensions: [], sourceChunkIds: ['chunk-1'],
    },
    slides: [1, 2].map((pageNumber) => ({
      pageNumber,
      title: pageNumber === 1 ? '认识数量三' : '找出三个苹果',
      body: ['观察三个苹果并说出它们的数量'],
      layout: pageNumber === 1 ? 'HERO' : 'SPLIT',
      visualIntent: '用三个苹果建立数量三的直观认识',
      visualPrompt: 'Three red apples in a child-friendly educational illustration, no text or numbers',
      sourceChunkIds: ['chunk-1'],
    })),
  })
}

function layeredBlueprintDraft() {
  const value = blueprintDraft()
  return {
    ...value,
    slides: value.slides.map((slide, index) => ({
      ...slide,
      layeredDesign: {
        designKind: index === 0 ? 'COVER' as const : 'CONTENT' as const,
        backgroundColor: '#F5F8FF',
        elements: [
          {
            kind: 'IMAGE' as const, elementId: `base-${index}`, role: 'BASE_LAYER' as const,
            knowledgePoint: '建立数量三和苹果的直观联系', prompt: 'A bright classroom background with soft daylight and no text',
            negativePrompt: 'text, watermark, logo', sourceChunkIds: ['chunk-1'],
            placement: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 0, fit: 'COVER' as const,
            aspectRatio: '16:9' as const, backgroundMode: 'OPAQUE' as const,
          },
          {
            kind: 'IMAGE' as const, elementId: `hero-${index}`, role: 'KNOWLEDGE_VISUAL' as const,
            knowledgePoint: '用苹果呈现具体数量', prompt: 'Three red apples isolated for a child-friendly math lesson, no text',
            negativePrompt: 'text, watermark, logo', sourceChunkIds: ['chunk-1'],
            placement: { x: 0.55, y: 0.18, width: 0.35, height: 0.58 }, zIndex: 10, fit: 'CONTAIN' as const,
            aspectRatio: '1:1' as const, backgroundMode: 'TRANSPARENT' as const,
          },
          {
            kind: 'TEXT' as const, elementId: `title-${index}`, role: 'TITLE' as const, text: slide.title,
            sourceChunkIds: ['chunk-1'], placement: { x: 0.08, y: 0.2, width: 0.4, height: 0.2 }, zIndex: 20,
            style: { fontSize: 36, bold: true, color: '#172033', align: 'LEFT' as const },
          },
        ],
      },
    })),
  }
}

function completion(argumentsValue: unknown) {
  return Response.json({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(argumentsValue) } }] } }] })
}

describe('gateway courseware model', () => {
  test('requests a source-grounded blueprint through a typed tool', async () => {
    const artifacts = new MockArtifactPort()
    let requestBody: Record<string, unknown> | null = null
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6', artifacts,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return completion(layeredBlueprintDraft())
      },
    })

    const result = await model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', idempotencyKey: 'plan-1',
      payload: {
        slideCount: 2, presentationMode: 'LAYERED_COURSEWARE_V3', coverDesignMode: 'INDEPENDENT',
        document: { name: '数学教材.txt', chunks: [{ id: 'chunk-1', text: '三个苹果表示数量三。' }] },
      },
    })

    expect(result).toEqual(layeredBlueprintDraft())
    expect(requestBody).toMatchObject({
      model: 'gpt-5.6', stream: true,
      tool_choice: { type: 'function', function: { name: 'submit_courseware_blueprint' } },
    })
    expect(requestBody).not.toBeNull()
    const messages = (requestBody! as unknown as { messages: { content: string }[] }).messages
    expect(messages[0]!.content).toContain('封面构图')
    const parameters = (requestBody! as unknown as {
      tools: { function: { parameters: { properties: { slides: { items: { required?: string[] } } } } } }[]
    }).tools[0]!.function.parameters
    expect(parameters.properties.slides.items.required).toContain('layeredDesign')
    expect((parameters.properties.slides.items as unknown as {
      properties: { layeredDesign: { properties: { elements: { contains: unknown } } } }
    }).properties.layeredDesign.properties.elements.contains).toEqual({
      type: 'object',
      properties: { kind: { const: 'IMAGE' }, role: { const: 'BASE_LAYER' } },
      required: ['kind', 'role'],
    })
  })

  test('keeps layered design optional for legacy slide-image blueprints', async () => {
    let requestBody: Record<string, unknown> | null = null
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return completion(blueprintDraft())
      },
    })

    await model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', idempotencyKey: 'plan-v2',
      payload: {
        slideCount: 2, presentationMode: 'SLIDE_IMAGE_V2',
        document: { name: '数学教材.txt', chunks: [{ id: 'chunk-1', text: '三个苹果表示数量三。' }] },
      },
    })

    const parameters = (requestBody! as unknown as {
      tools: { function: { parameters: { properties: { slides: { items: { required?: string[] } } } } } }[]
    }).tools[0]!.function.parameters
    expect(parameters.properties.slides.items.required).not.toContain('layeredDesign')
  })

  test('sends the controlled image to the vision reviewer and parses streamed tool arguments', async () => {
    const artifacts = new MockArtifactPort()
    const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#f4f0e8' } }).png().toBuffer()
    const stored = await artifacts.put({
      tenantId: 'frameflow', runId: 'run-1', name: 'page.png', mimeType: 'image/png', bytes: png,
      idempotencyKey: 'page-source',
    })
    let requestBody: Record<string, unknown> | null = null
    const review = { approved: true, textDetected: false, visualScore: 91, reasons: [], retryInstruction: null }
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
      visionModel: 'gpt-5.6', artifacts,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        const value = JSON.stringify(review)
        return new Response([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: value.slice(0, 20) } }] }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: value.slice(20) } }] }, finish_reason: 'tool_calls' }] })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })

    expect(await model.review({
      tenantId: 'frameflow', artifactId: stored.artifactId, visualIntent: '检查完整页面',
      layout: 'COMPOSITE:HERO', visualDirection: '儿童课堂风格', idempotencyKey: 'review-1',
    })).toEqual(review)
    expect(requestBody).not.toBeNull()
    const messages = (requestBody! as unknown as { messages: { content: unknown }[] }).messages
    const userContent = messages[1]!.content as { type: string; image_url?: { url: string } }[]
    expect(userContent.some((part) => part.image_url?.url.startsWith('data:image/jpeg;base64,'))).toBe(true)
  })

  test('rejects insecure public endpoints and hides network failure details', async () => {
    expect(() => new GatewayCoursewareModel({
      baseUrl: 'http://example.com/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6', artifacts: new MockArtifactPort(),
    })).toThrow('GATEWAY_BASE_URL_INSECURE')

    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
      artifacts: new MockArtifactPort(), fetchImpl: async () => { throw new Error('private detail') },
    })
    await expect(model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-fail',
    })).rejects.toThrow('GATEWAY_MODEL_UNAVAILABLE')
  })
})

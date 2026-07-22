import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { GatewayCoursewareModel, MAX_GATEWAY_TOOL_ARGUMENT_BYTES } from '../src/adapters/gateway-courseware-model'
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

function strictLayeredBlueprintDraft() {
  const value = structuredClone(layeredBlueprintDraft()) as Record<string, any>
  value.curriculum.sourceAssetIds = null
  for (const slide of value.slides) {
    slide.sourceAssetIds = null
    for (const element of slide.layeredDesign.elements) {
      if (element.kind === 'IMAGE') {
        element.sourceAssetIds = null
        element.sourceAssetStrategy = null
        element.assetIntent = null
        element.reuseKey = null
      } else if (element.kind === 'TEXT') {
        element.sourceAssetIds = null
      }
    }
  }
  return value
}

function expectStrictObjectSchemas(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) expectStrictObjectSchemas(item)
    return
  }
  if (!value || typeof value !== 'object') return
  const node = value as Record<string, unknown>
  if (node.properties && typeof node.properties === 'object') {
    const propertyNames = Object.keys(node.properties)
    expect(new Set(node.required as string[])).toEqual(new Set(propertyNames))
    expect(node.additionalProperties).toBe(false)
  }
  for (const child of Object.values(node)) expectStrictObjectSchemas(child)
}

describe('gateway courseware model', () => {
  test('requests a source-grounded blueprint through a typed tool', async () => {
    const artifacts = new MockArtifactPort()
    let requestBody: Record<string, unknown> | null = null
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6', artifacts,
      fetchImpl: async (url, init) => {
        requestUrl = String(url)
        requestInit = init
        requestBody = JSON.parse(String(init?.body))
        return completion(strictLayeredBlueprintDraft())
      },
    })

    const result = await model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', idempotencyKey: 'plan-1',
      payload: {
        slideCount: 2, presentationMode: 'LAYERED_COURSEWARE_V3', coverDesignMode: 'INDEPENDENT',
        assetAcquisitionPolicy: 'SEARCH_FIRST',
        document: { name: '数学教材.txt', chunks: [{ id: 'chunk-1', text: '三个苹果表示数量三。' }] },
      },
    })

    expect(result).toEqual(layeredBlueprintDraft())
    expect(requestUrl).toBe('https://newapi.doitbenai.cloud/v1/chat/completions')
    expect(requestInit?.method).toBe('POST')
    const headers = new Headers(requestInit?.headers)
    expect(headers.get('Accept')).toBe('text/event-stream')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Idempotency-Key')).toBe('plan-1')
    expect(headers.get('Authorization')).toBe('Bearer test-text-key')
    expect(requestBody).toMatchObject({
      model: 'gpt-5.6', stream: true, parallel_tool_calls: false,
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'submit_courseware_blueprint', strict: true } }],
      tool_choice: { type: 'function', function: { name: 'submit_courseware_blueprint' } },
    })
    expect(requestBody).not.toBeNull()
    const messages = (requestBody! as unknown as { messages: { content: string }[] }).messages
    expect(messages[0]!.content).toContain('封面构图')
    expect(messages[0]!.content).toContain('素材检索优先策略')
    expect(messages[0]!.content).toContain('不得把地球、太阳、箭头和标签预先合成一张图片')
    const parameters = (requestBody! as unknown as {
      tools: { function: { parameters: { properties: { slides: { items: { required?: string[] } } } } } }[]
    }).tools[0]!.function.parameters
    expectStrictObjectSchemas(parameters)
    expect(parameters.properties.slides.items.required).toContain('layeredDesign')
    expect((parameters.properties.slides.items as unknown as {
      properties: { layeredDesign: { properties: { elements: { contains: unknown } } } }
    }).properties.layeredDesign.properties.elements.contains).toEqual({
      type: 'object',
      properties: { kind: { const: 'IMAGE' }, role: { const: 'BASE_LAYER' } },
      required: ['kind', 'role'],
      additionalProperties: false,
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

    const slide = (requestBody! as unknown as {
      tools: { function: { parameters: { properties: { slides: { items: {
        required: string[]
        properties: { layeredDesign: { anyOf: { type?: string }[] } }
      } } } } } }[]
    }).tools[0]!.function.parameters.properties.slides.items
    expect(slide.required).toContain('layeredDesign')
    expect(slide.properties.layeredDesign.anyOf).toContainEqual({ type: 'null' })
  })

  test('sends source assets as labeled multimodal content without embedding bytes in JSON metadata', async () => {
    let requestBody: Record<string, unknown> | null = null
    const bytes = new Uint8Array(await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#68A678' },
    }).png().toBuffer())
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return completion(layeredBlueprintDraft())
      },
    })

    await model.execute({
      tenantId: 'frameflow', operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', idempotencyKey: 'plan-assets',
      payload: {
        slideCount: 2, presentationMode: 'LAYERED_COURSEWARE_V3',
        document: { assets: [{ id: 'source-asset-1', name: '叶片.png', byteLength: bytes.length }] },
      },
      sourceAssets: [{
        id: 'source-asset-1', sourceId: 'source-image-1', name: '叶片.png', mimeType: 'image/png',
        byteLength: bytes.length, sha256: 'a'.repeat(64), width: 120, height: 80, bytes,
      }],
    })

    const messages = (requestBody! as unknown as { messages: { content: unknown }[] }).messages
    const content = messages[1]!.content as { type: string; text?: string; image_url?: { url: string } }[]
    expect(content.some((part) => part.text?.includes('来源图片 source-asset-1'))).toBe(true)
    expect(content.some((part) => part.image_url?.url.startsWith('data:image/jpeg;base64,'))).toBe(true)
    expect(JSON.stringify(content[0])).not.toContain(Buffer.from(bytes).toString('base64'))
  })

  test('sends the controlled image to the vision reviewer and parses streamed tool arguments', async () => {
    const artifacts = new MockArtifactPort()
    const png = await sharp({
      create: { width: 80, height: 60, channels: 4, background: { r: 24, g: 24, b: 24, alpha: 0 } },
    }).composite([{
      input: await sharp({ create: { width: 40, height: 30, channels: 4, background: '#D24A3A' } }).png().toBuffer(),
      left: 20,
      top: 15,
    }]).png().toBuffer()
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
    const imageUrl = userContent.find((part) => part.image_url)?.image_url?.url
    expect(imageUrl?.startsWith('data:image/jpeg;base64,')).toBe(true)
    const { data } = await sharp(Buffer.from(imageUrl!.split(',')[1]!, 'base64')).raw().toBuffer({ resolveWithObject: true })
    expect([...data.subarray(0, 3)].every((channel) => channel >= 240)).toBe(true)
  })

  test('reviews downloaded asset bytes against knowledge and style without sending source URLs', async () => {
    const artifacts = new MockArtifactPort()
    const png = await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#F4F7FA' },
    }).png().toBuffer()
    let requestBody: Record<string, unknown> | null = null
    const review = { approved: true, textDetected: false, visualScore: 88, reasons: [], retryInstruction: null }
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6', artifacts,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return Response.json({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(review) } }] } }] })
      },
    })

    expect(await model.reviewCandidate({
      tenantId: 'frameflow',
      candidate: {
        provider: 'OPENVERSE', providerAssetId: 'asset-1', title: 'Classroom globe',
        sourceUrl: 'https://example.org/private-source-path', downloadUrl: 'https://cdn.example.org/private-download-path',
        creator: 'Example', license: 'CC_BY', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        attribution: 'Classroom globe by Example', mimeType: 'image/png', width: 120, height: 80,
      },
      bytes: new Uint8Array(png),
      intent: {
        searchQueries: ['classroom globe'], mediaType: 'PHOTO',
        styleKeywords: ['bright classroom', 'clean composition'], transparencyPreference: 'EITHER',
      },
      knowledgePoint: '使用地球仪解释地轴倾斜',
      role: 'KNOWLEDGE_VISUAL',
      visualDirection: '明亮、统一的儿童课堂视觉',
      idempotencyKey: 'candidate-review-1',
    })).toEqual(review)

    const serialized = JSON.stringify(requestBody)
    expect(serialized).toContain('使用地球仪解释地轴倾斜')
    expect(serialized).toContain('bright classroom')
    expect(serialized).not.toContain('private-source-path')
    expect(serialized).not.toContain('private-download-path')
    expect(serialized).toContain('data:image/jpeg;base64,')
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
    })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, model: 'gpt-5.6', requestId: null,
    })
  })

  test('classifies rate limits and malformed model JSON without exposing response content', async () => {
    const request = {
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-diagnostic',
    }
    const rateLimited = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => new Response('private provider response', {
        status: 429,
        headers: { 'x-request-id': 'request-safe-1' },
      }),
    })
    await expect(rateLimited.execute(request)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT', retryable: true, model: 'gpt-5.6', requestId: 'request-safe-1',
    })

    const invalidJson = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => Response.json({
        choices: [{ message: { tool_calls: [{ function: { arguments: '{private invalid content' } }] } }],
      }, { headers: { 'x-request-id': 'request-safe-2' } }),
    })
    await expect(invalidJson.execute(request)).rejects.toMatchObject({
      code: 'MODEL_JSON_INVALID', retryable: true, model: 'gpt-5.6', requestId: 'request-safe-2',
    })
  })

  test('logs only allowlisted provider rejection metadata', async () => {
    const records: string[] = []
    const original = console.error
    console.error = (...values) => records.push(values.join(' '))
    try {
      const model = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
        artifacts: new MockArtifactPort(),
        fetchImpl: async () => Response.json({
          error: {
            code: 'invalid_tool_schema',
            type: 'invalid_request_error',
            param: 'tools.0.function.parameters',
            message: 'private provider response must not be logged',
          },
        }, { status: 400, headers: { 'x-request-id': 'request-safe-400' } }),
      })
      await expect(model.execute({
        operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-rejected',
      })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, requestId: 'request-safe-400' })
    } finally {
      console.error = original
    }
    expect(records).toHaveLength(1)
    expect(JSON.parse(records[0]!)).toEqual({
      service: 'ppt-agent', event: 'gateway_model_rejected', status: 400, requestId: 'request-safe-400',
      model: 'gpt-5.6', providerCode: 'invalid_tool_schema', providerType: 'invalid_request_error',
      providerParam: 'tools.0.function.parameters',
    })
    expect(records[0]).not.toContain('private provider response')
  })

  test('treats a gateway upstream error as retryable even when wrapped in HTTP 404', async () => {
    const original = console.error
    console.error = () => undefined
    try {
      const model = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
        artifacts: new MockArtifactPort(),
        fetchImpl: async () => Response.json({ error: { code: '404', type: 'upstream_error' } }, {
          status: 404,
          headers: { 'x-request-id': 'request-upstream-404' },
        }),
      })
      await expect(model.execute({
        operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-upstream',
      })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE', retryable: true, requestId: 'request-upstream-404', model: 'gpt-5.6',
      })
    } finally {
      console.error = original
    }
  })

  test('classifies an aborted gateway request as a provider timeout', async () => {
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
      artifacts: new MockArtifactPort(), fetchImpl: async () => { throw new DOMException('private timeout detail', 'TimeoutError') },
    })
    await expect(model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-timeout',
    })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true, model: 'gpt-5.6' })
  })

  test('classifies an interrupted response stream as provider unavailable instead of invalid JSON', async () => {
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('private stream detail')) },
      }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'request-stream-1' } }),
    })
    await expect(model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-stream',
    })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, requestId: 'request-stream-1', model: 'gpt-5.6',
    })
  })

  test('rejects streamed tool arguments above the bounded response size', async () => {
    const privateOversizedArguments = 'x'.repeat(MAX_GATEWAY_TOOL_ARGUMENT_BYTES + 1)
    let cancelled = false
    const payload = new TextEncoder().encode([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: privateOversizedArguments } }] } }] })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'))
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(payload) },
        cancel() { cancelled = true },
      }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'request-oversized-1' } }),
    })

    await expect(model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-oversized',
    })).rejects.toMatchObject({
      code: 'MODEL_JSON_INVALID', retryable: true, requestId: 'request-oversized-1', model: 'gpt-5.6',
    })
    expect(cancelled).toBe(true)
  })
})

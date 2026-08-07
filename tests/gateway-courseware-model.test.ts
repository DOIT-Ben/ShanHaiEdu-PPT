import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import * as ts from 'typescript'
import {
  GatewayCoursewareModel,
  gatewayCoursewareModelProfile,
  visualDeckV4TextTransport,
  MAX_GATEWAY_TOOL_ARGUMENT_BYTES,
} from '../src/adapters/gateway-courseware-model'
import { MockArtifactPort } from '../src/adapters/mock-ports'
import { hashInput } from '../src/core/hash'
import { blueprintDraftSchema } from '../src/presentation-contracts'
import { compileVisualDeckV4Proposal } from '../src/core/visual-deck-v4-planner'
import {
  CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION,
  LEGACY_VISUAL_DECK_V4_COMPILER_VERSION,
  VISUAL_DECK_V4_COMPILER_VERSION,
} from '../src/release-identity'

const LEDGER_SYSTEM_PROMPT_IDS = [
  'TXT-00',
  'V4-11',
  'V4-12',
  'V4-01',
  'V4-02',
  'V4-07',
  'V4-08',
  'V4-04',
  'V4-09',
  'V4-10',
  'V4-03L',
  'V4-05L',
  'V4-06',
  'REV-01',
  'REV-02',
  'REV-03L',
  'REV-05',
  'TXT-10',
  'TXT-11',
  'TXT-20',
  'REV-04',
  'VIS-01',
  'VIS-02',
  'VIS-03',
  'VIS-05',
  'VIS-04',
] as const

function ledgerSystemPrompt(markdown: string, id: typeof LEDGER_SYSTEM_PROMPT_IDS[number]) {
  const heading = `### \`${id}\``
  const headingStart = markdown.indexOf(heading)
  if (headingStart < 0) throw new Error(`LEDGER_PROMPT_HEADING_MISSING:${id}`)
  const nextHeading = markdown.indexOf('\n### ', headingStart + heading.length)
  const section = markdown.slice(headingStart, nextHeading < 0 ? markdown.length : nextHeading)
  const codeBlock = /```text\n([\s\S]*?)\n```/.exec(section)?.[1]
  if (codeBlock === undefined) throw new Error(`LEDGER_SYSTEM_PROMPT_MISSING:${id}`)
  return codeBlock
}

function staticSystemPrompts(sourceText: string, fileName: string) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const prompts: string[] = []
  const collect = (expression: ts.Expression): void => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      prompts.push(expression.text)
      return
    }
    if (ts.isTemplateExpression(expression)) {
      prompts.push([
        expression.head.text,
        ...expression.templateSpans.flatMap((span) => ['{{DYNAMIC}}', span.literal.text]),
      ].join(''))
      return
    }
    if (ts.isConditionalExpression(expression)) {
      collect(expression.whenTrue)
      collect(expression.whenFalse)
      return
    }
    if (ts.isParenthesizedExpression(expression)) collect(expression.expression)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === 'system') collect(node.initializer)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === 'system' && node.initializer) collect(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return prompts
}

function normalizeDynamicPrompt(value: string) {
  return value.replace(/\{\{[^{}]+\}\}/g, '{{DYNAMIC}}')
}

function promptOpeningSentence(value: string) {
  const end = value.indexOf('。')
  return end < 0 ? value : value.slice(0, end + 1)
}

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

function blueprintReflection() {
  const dimensions = [
    'AUDIENCE_FIT',
    'GOAL_ALIGNMENT',
    'NARRATIVE',
    'INFORMATION_HIERARCHY',
    'COMPOSITION',
    'VISUAL_COHERENCE',
    'PROMPT_EXECUTABILITY',
  ] as const
  return {
    deckBrief: {
      targetAudience: '一年级学生',
      presentationGoal: '帮助学生建立数量三与具体物体的对应关系',
      useContext: '教师课堂讲授与互动练习',
      audienceNeeds: ['具体、直观、低信息负担的视觉表达'],
      narrativeArc: ['用三个苹果建立直观认识', '通过课堂任务巩固数量对应'],
      visualSystem: {
        artDirection: '明亮自然的儿童教育编辑插画，主体真实且轮廓清晰',
        palette: '苹果红、叶片绿、暖白和少量天蓝',
        compositionRules: ['每页只突出一个数量关系', '文字区域保留自然留白'],
        continuityRules: ['统一苹果造型和光线', '相邻页面改变景别和主体位置'],
      },
    },
    findings: dimensions.map((dimension) => ({
      dimension,
      score: 4,
      diagnosis: '初稿基础正确，但该维度还缺少清晰且可执行的页面约束。',
      revisionInstruction: '在修订稿中补足具体设计选择，同时保持来源引用和事实不变。',
    })),
    revisedBlueprint: blueprintDraft(),
  }
}

function completion(argumentsValue: unknown) {
  return Response.json({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(argumentsValue) } }] } }] })
}

function responsesCompletion(name: string, argumentsValue: unknown) {
  return Response.json({
    object: 'response',
    status: 'completed',
    output: [{ type: 'function_call', name, arguments: JSON.stringify(argumentsValue) }],
  })
}

function streamedResponsesTextCompletion(
  value: string,
  usage?: Readonly<{ input_tokens: number; output_tokens: number; total_tokens: number }>,
  terminateWithBlank = true,
) {
  const events = [
    `data: ${JSON.stringify({ type: 'response.created', response: { status: 'in_progress', usage: null } })}`,
    `data: ${JSON.stringify({
      type: 'response.output_text.delta', delta: value.slice(0, Math.ceil(value.length / 2)),
    })}`,
    `data: ${JSON.stringify({
      type: 'response.output_text.delta', delta: value.slice(Math.ceil(value.length / 2)),
    })}`,
    `data: ${JSON.stringify({
      type: 'response.output_text.done', text: value,
    })}`,
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: usage ?? null } })}`,
  ]
  if (terminateWithBlank) events.push('')
  return new Response(events.join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } })
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
  test('assigns a distinct role with 20 years of experience to every internal prompt stage', async () => {
    const [gatewaySource, reflectionSource, promptLedger] = await Promise.all([
      readFile(new URL('../src/adapters/gateway-courseware-model.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/adapters/gateway/v4-reflection.ts', import.meta.url), 'utf8'),
      readFile(new URL('../docs/internal-prompt-ledger.md', import.meta.url), 'utf8'),
    ])
    const runtimePrompts = `${gatewaySource}\n${reflectionSource}`
    const stageRoles = [
      '演示文稿创意作者',
      '独立演示文稿内容与视觉质量审查员',
      '演示文稿需求分析与资料研究专家',
      '演示文稿叙事架构师与视觉总监',
      '演示文稿叙事与视觉一致性审稿专家',
      '演示文稿叙事与视觉方案局部修订专家',
      'PPT 大纲与逐页视觉规划专家',
      '逐页视觉施工单质量审稿专家',
      '逐页视觉施工单局部修订专家',
      '独立演示文稿叙事与视觉方案审查修订专家',
      '独立逐页视觉施工单审查修订专家',
      '演示文稿质量总审专家',
      '整页视觉演示局部修订专家',
      '整页视觉演示完整规划修订专家',
      '演示文稿语义修订作者',
    ]
    for (const role of stageRoles) {
      expect(runtimePrompts).toContain(role)
      expect(promptLedger).toContain(role)
    }
    const runtimeRoleLines = runtimePrompts.split('\n').filter((line) => line.includes('你是'))
    const ledgerRoleLines = LEDGER_SYSTEM_PROMPT_IDS
      .map((id) => ledgerSystemPrompt(promptLedger, id))
      .filter((line) => line.startsWith('你是'))
    expect(runtimeRoleLines).toHaveLength(ledgerRoleLines.length)
    expect(ledgerRoleLines.length).toBeGreaterThan(stageRoles.length)
    for (const line of [...runtimeRoleLines, ...ledgerRoleLines]) {
      expect(line).toContain('你是一位拥有 20 年经验的')
    }
    expect(runtimePrompts).not.toContain('NotebookLM')
    expect(promptLedger).not.toContain('NotebookLM')
    expect(runtimePrompts).not.toMatch(/你是[^。]*(Critic|Optimizer)/)
    expect(promptLedger).not.toMatch(/你是[^。]*(Critic|Optimizer)/)
  })

  test('keeps every text and visual system prompt identical to the internal prompt ledger', async () => {
    const [gatewaySource, reflectionSource, promptLedger] = await Promise.all([
      readFile(new URL('../src/adapters/gateway-courseware-model.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/adapters/gateway/v4-reflection.ts', import.meta.url), 'utf8'),
      readFile(new URL('../docs/internal-prompt-ledger.md', import.meta.url), 'utf8'),
    ])
    const runtimePrompts = [
      ...staticSystemPrompts(gatewaySource, 'gateway-courseware-model.ts'),
      ...staticSystemPrompts(reflectionSource, 'v4-reflection.ts'),
    ]
    expect(runtimePrompts).toHaveLength(LEDGER_SYSTEM_PROMPT_IDS.length)
    const runtimeByOpening = new Map(runtimePrompts.map((prompt) => [promptOpeningSentence(prompt), prompt]))
    expect(runtimeByOpening.size).toBe(runtimePrompts.length)

    for (const id of LEDGER_SYSTEM_PROMPT_IDS) {
      const expected = normalizeDynamicPrompt(ledgerSystemPrompt(promptLedger, id))
      const actual = runtimeByOpening.get(promptOpeningSentence(expected))
      expect({ [id]: actual }).toEqual({ [id]: expected })
    }
  })

  test('selects the MiniMax profile when either configured model is MiniMax M3', () => {
    expect(gatewayCoursewareModelProfile({ textModel: 'MiniMax-M3', visionModel: 'gpt-5.6-terra' })).toBe('MINIMAX_M3')
    expect(gatewayCoursewareModelProfile({ textModel: 'gpt-5.6-terra', visionModel: 'minimax-m3' })).toBe('MINIMAX_M3')
    expect(gatewayCoursewareModelProfile({ textModel: 'gpt-5.6-terra', visionModel: 'gpt-5.6-terra' })).toBe('DEFAULT')
  })

  test('accepts only Responses for the primary V4 text transport', () => {
    expect(visualDeckV4TextTransport(undefined)).toBe('RESPONSES')
    expect(visualDeckV4TextTransport('RESPONSES')).toBe('RESPONSES')
    expect(() => visualDeckV4TextTransport('CHAT_COMPLETIONS')).toThrow('PPT_AGENT_V4_TEXT_TRANSPORT_RESPONSES_REQUIRED')
    expect(() => visualDeckV4TextTransport('AUTO')).toThrow('PPT_AGENT_V4_TEXT_TRANSPORT_INVALID')
  })

  test('rejects the removed one-shot V4 planning operation', async () => {
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
    })
    await expect(model.execute({
      operation: 'create_visual_deck_v4_proposal', schemaName: 'ppt_agent_visual_deck_v4_proposal_v1',
      idempotencyKey: 'removed-v4-one-shot-0001', payload: {},
    })).rejects.toThrow('V4_ONE_SHOT_PLANNING_REMOVED')
  })

  test('preflights Responses JSON Schema and falls back to strict Responses Function only when unsupported', async () => {
    const requests: { body: Record<string, unknown>; key: string | null }[] = []
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get('Idempotency-Key'),
        })
        if (requests.length === 1) {
          return Response.json({ error: { code: 'json_schema_unsupported', type: 'invalid_request_error' } }, { status: 400 })
        }
        return responsesCompletion('confirm_structured_generation_ready', {
          ready: true,
          contract: {
            decision: 'UNCHANGED',
            checks: [
              { dimension: 'REQUEST_BINDING', passed: true, evidence: 'request contract accepted' },
              { dimension: 'SOURCE_GROUNDING', passed: true, evidence: 'nested array contract accepted' },
            ],
          },
        })
      },
    })
    const original = console.error
    console.error = () => undefined
    try {
      expect(await model.preflightStructuredGeneration({
        idempotencyKey: 'v4-preflight-0001', modelOverride: 'frozen-v4-text',
      }))
        .toEqual({ protocol: 'RESPONSES_FUNCTION' })
    } finally {
      console.error = original
    }
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.body.model)).toEqual(['frozen-v4-text', 'frozen-v4-text'])
    expect((requests[0]!.body.text as { format: { type: string; strict: boolean } }).format)
      .toMatchObject({ type: 'json_schema', strict: true })
    const preflightSchema = (requests[0]!.body.text as {
      format: { schema: Record<string, any> }
    }).format.schema
    expect(preflightSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        ready: { const: true },
        contract: {
          type: 'object',
          additionalProperties: false,
          properties: {
            decision: expect.objectContaining({ enum: ['UNCHANGED', 'REVISED'] }),
            checks: expect.objectContaining({ type: 'array' }),
          },
        },
      },
    })
    expect(requests[0]!.body.tools).toBeUndefined()
    expect((requests[1]!.body.tools as { strict: boolean }[])[0]).toMatchObject({ strict: true })
    expect(requests.map((request) => request.key)).toEqual([
      'v4-preflight-0001:responses-json-schema',
      'v4-preflight-0001:responses-function',
    ])
  })

  test('treats a successful Responses payload without output text as JSON Schema incompatibility during preflight', async () => {
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { text?: unknown }
        return body.text
          ? Response.json({ object: 'response', status: 'completed', output: [{ type: 'function_call', name: 'unexpected', arguments: '{}' }] })
          : responsesCompletion('confirm_structured_generation_ready', {
              ready: true,
              contract: {
                decision: 'UNCHANGED',
                checks: [
                  { dimension: 'REQUEST_BINDING', passed: true, evidence: 'request contract accepted' },
                  { dimension: 'SOURCE_GROUNDING', passed: true, evidence: 'nested array contract accepted' },
                ],
              },
            })
      },
    })
    expect(await model.preflightStructuredGeneration({ idempotencyKey: 'v4-preflight-missing-text-0001' }))
      .toEqual({ protocol: 'RESPONSES_FUNCTION' })
  })

  test('flushes the final Responses JSON Schema event when the stream ends without a blank line', async () => {
    let requests = 0
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => {
        requests += 1
        return streamedResponsesTextCompletion(JSON.stringify({
          ready: true,
          contract: {
            decision: 'UNCHANGED',
            checks: [
              { dimension: 'REQUEST_BINDING', passed: true, evidence: 'request contract accepted' },
              { dimension: 'SOURCE_GROUNDING', passed: true, evidence: 'nested array contract accepted' },
            ],
          },
        }), undefined, false)
      },
    })

    await expect(model.preflightStructuredGeneration({
      idempotencyKey: 'v4-preflight-eof-flush-0001',
      requiredProtocol: 'RESPONSES_JSON_SCHEMA',
    })).resolves.toEqual({ protocol: 'RESPONSES_JSON_SCHEMA' })
    expect(requests).toBe(1)
  })

  test('keeps transient strict preflight failures distinct from protocol incompatibility', async () => {
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => { throw new DOMException('private timeout detail', 'TimeoutError') },
    })

    await expect(model.preflightStructuredGeneration({
      idempotencyKey: 'v4-preflight-strict-timeout-0001',
      requiredProtocol: 'RESPONSES_JSON_SCHEMA',
    })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' })
  })

  test('does not hide an exact wrapped model 404 behind the Function compatibility fallback', async () => {
    let calls = 0
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) {
          return Response.json({ error: { code: '404', type: 'upstream_error' } }, {
            status: 404, headers: { 'x-request-id': 'request-preflight-model-not-found' },
          })
        }
        return responsesCompletion('confirm_structured_generation_ready', {
          ready: true,
          contract: {
            decision: 'UNCHANGED',
            checks: [
              { dimension: 'REQUEST_BINDING', passed: true, evidence: 'request contract accepted' },
              { dimension: 'SOURCE_GROUNDING', passed: true, evidence: 'nested array contract accepted' },
            ],
          },
        })
      },
    })
    const original = console.error
    console.error = () => undefined
    try {
      await expect(model.preflightStructuredGeneration({ idempotencyKey: 'v4-preflight-model-not-found-0001' }))
        .rejects.toMatchObject({
          code: 'MODEL_NOT_FOUND', retryable: false, requestId: 'request-preflight-model-not-found',
        })
    } finally {
      console.error = original
    }
    expect(calls).toBe(1)
  })

  test('requests the first V4 planning stage through streamed Structured Outputs', async () => {
    const source = { kind: 'TEXT' as const, name: '分数教材.txt', text: '把一个蛋糕平均分成两份，其中一份就是这个蛋糕的二分之一。'.repeat(4) }
    const document = {
      name: source.name,
      chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
      isComplete: true,
      missingRanges: [] as string[],
    }
    const config = {
      instruction: '为三年级学生制作一套认识二分之一的视觉演示',
      sourceMode: 'SOURCE_GROUNDED' as const,
      deckOptions: {
        deckType: 'DETAILED_DECK' as const, language: 'zh-CN', length: { slideCount: 2 },
        aspectRatio: '16:9' as const, audience: '小学三年级学生', focus: '平均分和二分之一',
        styleHint: '温暖的儿童绘本课堂视觉',
      },
    }
    const proposal = compileVisualDeckV4Proposal({
      runId: 'run-v4-gateway', inputHash: 'input-v4-gateway', source, document, config,
      slideCount: 2, visualDirection: '温暖的儿童绘本课堂视觉', createdAt: '2026-07-30T00:00:00.000Z',
    })
    const sourceSpec = {
      sourceUnderstanding: proposal.sourceUnderstanding,
      presentationSpec: proposal.presentationSpec,
    }
    let requestBody: Record<string, unknown> | null = null
    let requestUrl = ''
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (url, init) => {
        requestUrl = String(url)
        requestBody = JSON.parse(String(init?.body))
        return streamedResponsesTextCompletion(JSON.stringify(sourceSpec))
      },
    })

    expect(await model.execute({
      operation: 'create_visual_deck_v4_source_spec',
      schemaName: 'ppt_agent_v4_source_spec_v1',
      idempotencyKey: 'v4-plan-1',
      payload: {
        presentationMode: 'VISUAL_DECK_V4', instruction: config.instruction, sourceMode: config.sourceMode,
        deckOptions: config.deckOptions, slideCount: 2, visualDirection: '温暖的儿童绘本课堂视觉', document,
      },
    })).toEqual(sourceSpec)
    expect(requestUrl).toBe('https://newapi.doitbenai.cloud/v1/responses')
    const body = requestBody! as unknown as {
      input: { content: { type: string; text?: string }[] }[]
      text: { format: { type: string; name: string; strict: boolean; schema: unknown } }
      tools?: unknown
      tool_choice?: unknown
    }
    expect(body.text.format).toMatchObject({
      type: 'json_schema', name: 'ppt_agent_v4_source_spec_v1', strict: true,
    })
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect((requestBody! as { stream?: boolean }).stream).toBe(true)
    expect(body.input[0]?.content[0]?.text).toContain('当前只执行第一阶段')
    expect(body.input[0]?.content[0]?.text).toContain('不要规划章节或页面')
    expect(JSON.stringify(body.text.format.schema)).toContain('chunk-1')

    const compatibilityModel = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(), visualDeckV4Transport: 'CHAT_COMPLETIONS',
      fetchImpl: async (url) => {
        requestUrl = String(url)
        return completion(sourceSpec)
      },
    })
    await compatibilityModel.execute({
      operation: 'create_visual_deck_v4_source_spec',
      schemaName: 'ppt_agent_v4_source_spec_v1',
      idempotencyKey: 'v4-plan-chat-fallback',
      payload: {
        presentationMode: 'VISUAL_DECK_V4', instruction: config.instruction, sourceMode: config.sourceMode,
        deckOptions: config.deckOptions, slideCount: 2, visualDirection: '温暖的儿童绘本课堂视觉', document,
      },
    })
    expect(requestUrl).toBe('https://newapi.doitbenai.cloud/v1/chat/completions')
  })

  test('uses small Responses schemas for chain-4 manuscripts with null lifecycle usage', async () => {
    const creative = {
      title: '水循环',
      narrative: ['建立主题', '解释循环关系'],
      slides: [{
        title: '水循环',
        narrative: '水通过蒸发、凝结和降水持续循环。',
        userVisibleCopy: ['水循环', '水不断循环'],
        factualStatements: ['太阳加热水面形成水汽。'],
        visualDescription: '连续自然场景中的水面、云和降水关系',
        sourceEvidence: [{ excerpt: '太阳加热水面形成水汽' }],
      }],
    }
    const review = { ...creative, revisionSuggestions: [] }
    const requests: Record<string, any>[] = []
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        requests.push(body)
        return streamedResponsesTextCompletion(JSON.stringify(
          body.text.format.name === 'ppt_agent_v4_creative_manuscript_v1' ? creative : review,
        ), undefined, false)
      },
    })
    const payload = {
      frozenConstraints: { slideCount: 1, sourceMode: 'SOURCE_GROUNDED' },
      trustedEvidence: { sourceChunks: [{ id: 'chunk-1', text: '太阳加热水面形成水汽，水汽凝结成云。' }] },
    }

    await model.execute({
      operation: 'create_visual_deck_v4_creative_manuscript',
      schemaName: 'ppt_agent_v4_creative_manuscript_v1',
      idempotencyKey: 'run-v4-manuscript-creative',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload,
    })
    await model.execute({
      operation: 'review_visual_deck_v4_manuscript',
      schemaName: 'ppt_agent_v4_review_manuscript_v1',
      idempotencyKey: 'run-v4-manuscript-review',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: { ...payload, creativeManuscript: creative },
    })

    expect(model.takeExecutionMetrics('run-v4-manuscript-creative')).toMatchObject({
      outcome: 'SUCCEEDED', sseEventCount: 5, inputTokens: null, outputTokens: null, totalTokens: null,
    })

    expect(requests).toHaveLength(2)
    expect(requests.map((body) => body.text.format.name)).toEqual([
      'ppt_agent_v4_creative_manuscript_v1',
      'ppt_agent_v4_review_manuscript_v1',
    ])
    for (const body of requests) {
      expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true })
      expect(JSON.stringify(body.text.format.schema)).not.toContain('pageNumber')
      expect(JSON.stringify(body.text.format.schema)).not.toContain('sourceChunkId')
      expect(JSON.stringify(body.text.format.schema)).not.toContain('compilerVersion')
      expect(body.input[0].content[0].text).toContain('严禁输出 pageNumber')
    }
  })

  test('accepts a CJK chain-4 manuscript payload by characters rather than UTF-8 bytes', async () => {
    let requests = 0
    const creative = {
      title: '中文资料',
      narrative: ['保留完整中文资料窗口'],
      slides: [{
        title: '中文资料',
        narrative: '中文资料用于验证网关模型上下文的字符合同。',
        userVisibleCopy: ['中文资料'],
        factualStatements: ['该请求在字符上限内。'],
        visualDescription: '一页清晰的中文资料视觉概览',
        sourceEvidence: [{ excerpt: '中文资料用于验证' }],
      }],
    }
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => {
        requests += 1
        return streamedResponsesTextCompletion(JSON.stringify(creative))
      },
    })

    await model.execute({
      operation: 'create_visual_deck_v4_creative_manuscript',
      schemaName: 'ppt_agent_v4_creative_manuscript_v1',
      idempotencyKey: 'chain-4-cjk-character-boundary',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        frozenConstraints: { slideCount: 1, sourceMode: 'SOURCE_GROUNDED' },
        trustedEvidence: { sourceChunks: [{ id: 'chunk-cjk', text: '汉'.repeat(80_000) }] },
      },
    })

    expect(requests).toBe(1)
  })

  test('counts the final Chain-4 system and user messages in the 220k input budget', async () => {
    let requests = 0
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => {
        requests += 1
        throw new Error('MODEL_FETCH_SHOULD_NOT_RUN')
      },
    })

    await expect(model.execute({
      operation: 'create_visual_deck_v4_creative_manuscript',
      schemaName: 'ppt_agent_v4_creative_manuscript_v1',
      idempotencyKey: 'chain-4-final-message-over-220k',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        frozenConstraints: { slideCount: 1, sourceMode: 'SOURCE_GROUNDED' },
        trustedEvidence: { sourceChunks: [{ id: 'chunk-1', text: 'x'.repeat(219_500) }] },
      },
    })).rejects.toThrow('V4_MODEL_PAYLOAD_TOO_LARGE')

    expect(requests).toBe(0)
  })

  test('requires streamed Responses JSON Schema for strict chain-4 preflight and manuscripts', async () => {
    let requests = 0
    const probeResult = {
      ready: true,
      contract: {
        decision: 'UNCHANGED',
        checks: [
          { dimension: 'REQUEST_BINDING', passed: true, evidence: 'request contract accepted' },
          { dimension: 'SOURCE_GROUNDING', passed: true, evidence: 'nested array contract accepted' },
        ],
      },
    }
    const creative = {
      title: '流式合同', narrative: ['必须由 SSE 交付结构化语义结果'],
      slides: [{
        title: '流式合同', narrative: '模型只经 SSE 输出语义内容。', userVisibleCopy: ['SSE'],
        factualStatements: ['严格 Chain-4 使用流式 Responses。'], visualDescription: '连续的流式数据路径视觉隐喻',
        sourceEvidence: [{ excerpt: '严格 Chain-4 使用流式 Responses' }],
      }],
    }
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => {
        requests += 1
        return Response.json(requests === 1 ? probeResult : creative)
      },
    })

    await expect(model.preflightStructuredGeneration({
      idempotencyKey: 'chain-4-preflight-json-response', requiredProtocol: 'RESPONSES_JSON_SCHEMA',
    })).rejects.toThrow('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
    await expect(model.execute({
      operation: 'create_visual_deck_v4_creative_manuscript',
      schemaName: 'ppt_agent_v4_creative_manuscript_v1',
      idempotencyKey: 'chain-4-manuscript-json-response',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        frozenConstraints: { slideCount: 1, sourceMode: 'SOURCE_GROUNDED' },
        trustedEvidence: { sourceChunks: [{ id: 'chunk-1', text: '严格 Chain-4 使用流式 Responses。' }] },
      },
    })).rejects.toThrow('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
    expect(requests).toBe(2)

    const nonSseHeaderModel = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => new Response('data: {"type":"response.completed"}\n\n', {
        headers: { 'content-type': 'text/plain' },
      }),
    })
    await expect(nonSseHeaderModel.preflightStructuredGeneration({
      idempotencyKey: 'chain-4-preflight-non-sse-content-type', requiredProtocol: 'RESPONSES_JSON_SCHEMA',
    })).rejects.toThrow('V4_CHAIN4_PROTOCOL_UNSUPPORTED')

    const lookalikeSseModel = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => {
        const response = streamedResponsesTextCompletion(JSON.stringify(probeResult))
        return new Response(response.body, { headers: { 'content-type': 'text/event-streaming; charset=utf-8' } })
      },
    })
    await expect(lookalikeSseModel.preflightStructuredGeneration({
      idempotencyKey: 'chain-4-preflight-lookalike-sse-content-type', requiredProtocol: 'RESPONSES_JSON_SCHEMA',
    })).rejects.toThrow('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
  })

  test('rejects 220k-to-240k chain-4 deck review and revision payloads before the gateway', async () => {
    let requests = 0
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => {
        requests += 1
        throw new Error('MODEL_FETCH_SHOULD_NOT_RUN')
      },
    })
    const blueprint = {
      renderMode: 'VISUAL_DECK_V4',
      visualDeckV4Proposal: {
        compilerVersion: VISUAL_DECK_V4_COMPILER_VERSION,
        presentationSpec: { slideCount: 1, sourceMode: 'SOURCE_GROUNDED', language: 'zh-CN' },
        slideBriefs: [],
      },
    } as never

    await expect(model.evaluate({
      tenantId: 'frameflow', blueprint,
      sourceChunks: [{ id: 'chunk-review', text: 'x'.repeat(230_000), sha256: 'a'.repeat(64) }],
      slides: [], idempotencyKey: 'chain-4-deck-review-over-220k',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
    })).rejects.toThrow('V4_MODEL_PAYLOAD_TOO_LARGE')

    await expect(model.apply({
      tenantId: 'frameflow', blueprint,
      plan: { operations: [] } as never,
      sourceChunks: Array.from({ length: 56 }, (_, index) => ({
        id: `chunk-revision-${index + 1}`, text: 'x'.repeat(4_000), sha256: 'a'.repeat(64),
      })),
      idempotencyKey: 'chain-4-revision-over-220k',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
    })).rejects.toThrow('V4_MODEL_PAYLOAD_TOO_LARGE')

    await expect(model.execute({
      operation: 'create_visual_deck_v4_creative_manuscript',
      schemaName: 'ppt_agent_v4_creative_manuscript_v1',
      idempotencyKey: 'chain-4-serialized-request-over-220k',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        frozenConstraints: { slideCount: 1, sourceMode: 'SOURCE_GROUNDED' },
        trustedEvidence: { sourceChunks: [{ id: 'chunk-serialized', text: 'x'.repeat(218_500) }] },
      },
    })).rejects.toThrow('V4_MODEL_PAYLOAD_TOO_LARGE')

    expect(requests).toBe(0)
  })

  test('bounds Chain-4 deck review imagery before the complete Responses payload gate', async () => {
    const artifacts = new MockArtifactPort()
    const pixels = Buffer.alloc(800 * 450 * 3)
    let seed = 0x9e3779b9
    for (let index = 0; index < pixels.length; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      pixels[index] = seed >>> 24
    }
    const bytes = await sharp(pixels, { raw: { width: 800, height: 450, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()
    const stored = await artifacts.put({
      tenantId: 'frameflow', runId: 'run-v4', name: 'noisy-slide.jpg', mimeType: 'image/jpeg', bytes,
      idempotencyKey: 'chain-4-deck-review-image-payload',
    })
    const manuscript = {
      qualityScore: 92,
      curriculumCoverageScore: 92,
      narrativeCoherenceScore: 92,
      visualConsistencyScore: 92,
      compositionScore: 92,
      summary: '总览图和逐页数据均已在受控请求载荷内完成审查。',
      slides: [{ findings: [] }],
    }
    let requestBody: Record<string, any> | null = null
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      visionModel: 'gpt-5.6-terra', artifacts,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return streamedResponsesTextCompletion(JSON.stringify(manuscript))
      },
    })

    const reviewed = await model.evaluate({
      tenantId: 'frameflow',
      blueprint: {
        renderMode: 'VISUAL_DECK_V4',
        visualDeckV4Proposal: { compilerVersion: VISUAL_DECK_V4_COMPILER_VERSION },
      } as never,
      sourceChunks: [{ id: 'chunk-image-payload', text: '受信来源用于验证整稿总览审查。', sha256: 'a'.repeat(64) }],
      slides: [{
        pageNumber: 1, slideId: 'run-v4:slide:1', artifactId: stored.artifactId,
        title: '高熵图片', body: ['必须计算图片 data URI。'], layout: 'HERO',
        visualIntent: '验证完整请求载荷门禁', sourceChunkIds: ['chunk-image-payload'],
      }],
      idempotencyKey: 'chain-4-deck-review-image-payload',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
    })
    expect(reviewed).toMatchObject({ issues: [] })

    const body = requestBody! as { input: Array<{ content: Array<{ type: string; image_url?: string }> }> }
    const images = body.input[1]!.content.filter((part) => part.type === 'input_image')
    expect(images).toHaveLength(1)
    expect(images[0]!.image_url!.length).toBeLessThanOrEqual(72_000)
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(220_000)
  })

  test('rejects non-Responses protocols for chain-4 manuscripts before any gateway request', async () => {
    let requests = 0
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => {
        requests += 1
        return new Response('unexpected gateway request', { status: 500 })
      },
    })

    for (const protocol of [undefined, 'RESPONSES_FUNCTION', 'CHAT_LEGACY'] as const) {
      await expect(model.execute({
        operation: 'create_visual_deck_v4_creative_manuscript',
        schemaName: 'ppt_agent_v4_creative_manuscript_v1',
        idempotencyKey: `chain-4-protocol-${protocol ?? 'missing'}`,
        ...(protocol === undefined ? {} : { structuredGenerationProtocol: protocol }),
        payload: { frozenConstraints: { slideCount: 1 } },
      })).rejects.toThrow('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
    }

    expect(requests).toBe(0)
  })

  test('projects chain-4 revision input to semantic content slots before the Responses call', async () => {
    const source = { kind: 'TEXT' as const, name: '水循环.txt', text: '太阳加热水面形成水汽，水汽凝结成云，降水回到地面。'.repeat(4) }
    const document = {
      name: source.name,
      chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
      isComplete: true,
      missingRanges: [] as string[],
    }
    const proposal = compileVisualDeckV4Proposal({
      runId: 'run-v4', inputHash: 'input-v4', source, document,
      config: {
        instruction: '制作水循环视觉演示', sourceMode: 'SOURCE_GROUNDED',
        deckOptions: {
          deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 }, aspectRatio: '16:9',
          audience: '小学高年级学生', focus: '水循环关系', styleHint: '清晰自然科学信息图',
        },
      },
      slideCount: 2, visualDirection: '清晰自然科学信息图',
      compilerVersion: VISUAL_DECK_V4_COMPILER_VERSION,
      createdAt: '2026-08-07T00:00:00.000Z',
    })
    const review = {
      title: '水循环', narrative: ['说明水循环'],
      slides: [{
        title: '水汽如何形成？', narrative: '太阳加热水面形成水汽。',
        userVisibleCopy: ['太阳加热水面', '形成水汽'],
        factualStatements: ['太阳加热水面形成水汽。'],
        visualDescription: '水面上方自然上升的水汽和阳光关系',
        sourceEvidence: [{ excerpt: '太阳加热水面形成水汽' }],
      }],
      revisionSuggestions: ['突出水汽形成关系。'],
    }
    let requestBody: Record<string, any> | null = null
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return streamedResponsesTextCompletion(JSON.stringify(review))
      },
    })
    await model.apply({
      tenantId: 'frameflow',
      blueprint: { id: 'run-v4:blueprint:r0', renderMode: 'VISUAL_DECK_V4', visualDeckV4Proposal: proposal } as never,
      plan: {
        id: 'revision-plan', reviewId: 'review', revisionRound: 1, createdAt: '2026-08-07T00:00:00.000Z', summary: '修订第一页',
        operations: [{
          id: 'operation-1', slideId: 'run-v4:slide:1', kind: 'UPDATE_CONTENT', issueIds: ['issue-1'],
          instruction: '依据资料修订水汽形成关系。', sourceChunkIds: ['chunk-1'],
        }],
      } as never,
      sourceChunks: document.chunks,
      idempotencyKey: 'run-v4-revision-manuscript',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      contractRepairIssues: [{ path: 'modelOnlyRevisionPath', message: 'MODEL_ONLY_REVISION_PATH' }],
    })

    const body = requestBody! as Record<string, any>
    expect(body.text.format).toMatchObject({
      type: 'json_schema', name: 'ppt_agent_v4_review_manuscript_v1', strict: true,
    })
    const payload = JSON.parse(body.input[1].content[0].text)
    expect(payload).toHaveProperty('contentSlots')
    expect(payload).not.toHaveProperty('blueprint')
    expect(payload).not.toHaveProperty('plan')
    expect(payload).toMatchObject({ contentSlotCompletion: true })
    expect(JSON.stringify(payload)).not.toContain('pageNumber')
    expect(JSON.stringify(payload)).not.toContain('sourceChunkId')
    expect(JSON.stringify(payload)).not.toContain('modelOnlyRevisionPath')
    expect(JSON.stringify(payload)).not.toContain('MODEL_ONLY_REVISION_PATH')
  })

  test('requires visual element independence throughout V4 visual planning', async () => {
    const source = {
      kind: 'TEXT' as const,
      name: '分数教材.txt',
      text: '把一个蛋糕平均分成两份，其中一份就是这个蛋糕的二分之一。'.repeat(4),
    }
    const document = {
      name: source.name,
      chunks: [{ id: 'chunk-1', text: source.text, sha256: 'a'.repeat(64) }],
      isComplete: true,
      missingRanges: [] as string[],
    }
    const proposal = compileVisualDeckV4Proposal({
      runId: 'run-v4-separable-elements', inputHash: 'input-v4-separable-elements', source, document,
      config: {
        instruction: '为三年级学生制作一套认识二分之一的视觉演示', sourceMode: 'SOURCE_GROUNDED',
        deckOptions: {
          deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 }, aspectRatio: '16:9',
          audience: '小学三年级学生', focus: '平均分和二分之一', styleHint: '温暖儿童绘本风格',
        },
      },
      slideCount: 2, visualDirection: '温暖儿童绘本风格', createdAt: '2026-08-04T00:00:00.000Z',
    })
    const requestBodies: Record<string, any>[] = []
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        requestBodies.push(body)
        return streamedResponsesTextCompletion(JSON.stringify(
          body.text.format.name === 'ppt_agent_v4_deck_visual_v1'
            ? { deckPlan: proposal.deckPlan, visualContract: proposal.visualContract }
            : { slideBriefs: proposal.slideBriefs },
        ))
      },
    })

    await model.execute({
      operation: 'create_visual_deck_v4_deck_visual', schemaName: 'ppt_agent_v4_deck_visual_v1',
      idempotencyKey: 'run-v4-separable-elements:deck-visual', structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        sourceUnderstanding: proposal.sourceUnderstanding,
        presentationSpec: proposal.presentationSpec,
      },
    })
    await model.execute({
      operation: 'create_visual_deck_v4_slide_briefs', schemaName: 'ppt_agent_v4_slide_briefs_v1',
      idempotencyKey: 'run-v4-separable-elements:slide-briefs', structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        sourceUnderstanding: proposal.sourceUnderstanding,
        presentationSpec: proposal.presentationSpec,
        deckPlan: proposal.deckPlan,
        visualContract: proposal.visualContract,
      },
    })

    const deckSystemPrompt = requestBodies[0]!.input[0].content[0].text as string
    const slideSystemPrompt = requestBodies[1]!.input[0].content[0].text as string
    expect(deckSystemPrompt).toContain('视觉元素独立性要求')
    expect(deckSystemPrompt).toContain('不可分割的组合主体')
    expect(slideSystemPrompt).toContain('视觉元素独立性要求')
    expect(slideSystemPrompt).toContain('不得将两个或多个主要元素绑定、粘合、嵌套或合成为不可分割的组合主体')
    expect(slideSystemPrompt).toContain('除非用户明确要求物理接触')
    expect(slideSystemPrompt).toContain('你是一位拥有 20 年经验的 PPT 大纲与逐页视觉规划专家')
    expect(slideSystemPrompt).toContain('拆解为清晰、连贯且可执行的逐页 Slide Brief')
    expect(slideSystemPrompt).not.toContain('PPT Agent 的逐页视觉施工单规划器')
    expect(slideSystemPrompt).not.toContain('NotebookLM')
  })

  test('keeps the chain-1 final coherence operation on its original strict structured contract', async () => {
    const review = {
      decision: 'APPROVED' as const,
      summary: '请求、来源、叙事、页面覆盖和视觉系统保持一致。',
      checks: [
        'REQUEST_BINDING',
        'SOURCE_GROUNDING',
        'NARRATIVE_COHERENCE',
        'SLIDE_COVERAGE',
        'VISUAL_COHERENCE',
      ].map((dimension) => ({ dimension, passed: true as const, evidence: `${dimension} 已通过。` })),
    }
    let requestBody: Record<string, any> | null = null
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return streamedResponsesTextCompletion(JSON.stringify(review))
      },
    })

    expect(await model.execute({
      operation: 'review_visual_deck_v4_coherence',
      schemaName: 'ppt_agent_v4_final_coherence_v1',
      idempotencyKey: 'run-chain-1:v4:final-coherence:planning:0',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        sourceUnderstanding: { sources: [{ sourceChunkIds: ['chunk-1'] }] },
        presentationSpec: { slideCount: 2 },
        slideBriefs: [
          { pageNumber: 1, sourceChunkIds: ['chunk-1'] },
          { pageNumber: 2, sourceChunkIds: ['chunk-1'] },
        ],
      },
    })).toEqual(review)
    expect(requestBody!.text.format).toMatchObject({
      type: 'json_schema', name: 'ppt_agent_v4_final_coherence_v1', strict: true,
    })
    expect(requestBody!.input[0].content[0].text).toContain('最终连贯性审查')
    expect(requestBody!.input[0].content[0].text).toContain('视觉元素独立性要求')
  })

  test('delegates the four chain-3 reflection contracts to strict staged Structured Outputs', async () => {
    const sourceText = '把五个圆片分成两个非空组，可以分成一和四，也可以分成二和三。'
    const source = { kind: 'TEXT' as const, name: '分与合教材.txt', text: sourceText }
    const document = {
      name: source.name,
      chunks: [{ id: 'chunk-1', sourceId: 'inline-source', text: sourceText, sha256: 'a'.repeat(64) }],
      isComplete: true,
      missingRanges: [] as string[],
    }
    const config = {
      instruction: '为一年级学生制作五以内数的分与合课堂演示',
      sourceMode: 'SOURCE_GROUNDED' as const,
      deckOptions: {
        deckType: 'DETAILED_DECK' as const, language: 'zh-CN', length: { slideCount: 2 },
        aspectRatio: '16:9' as const, audience: '小学一年级学生', focus: '两个非空组',
        styleHint: '清晰活泼的儿童课堂信息图',
      },
    }
    const proposal = compileVisualDeckV4Proposal({
      runId: 'run-v4-reflection-gateway', inputHash: 'input-v4-reflection-gateway', source, document, config,
      slideCount: 2, visualDirection: '清晰活泼的儿童课堂信息图', createdAt: '2026-08-03T00:00:00.000Z',
    })
    const deckCandidate = { deckPlan: proposal.deckPlan, visualContract: proposal.visualContract }
    const slideCandidate = { slideBriefs: proposal.slideBriefs }
    const outputs: Record<string, unknown> = {
      ppt_agent_v4_deck_consistency_critic_v1: { issues: [] },
      ppt_agent_v4_deck_consistency_optimizer_v1: {
        titleChanges: [], narrativeArcChanges: [], artDirectionChanges: [], paletteChanges: [],
        typographyChanges: [], mediumChanges: [], visualDensityChanges: [], compositionRuleChanges: [],
        continuityRuleChanges: [], forbiddenChanges: [],
      },
      ppt_agent_v4_slide_brief_critic_v1: { issues: [] },
      ppt_agent_v4_slide_brief_optimizer_v1: {
        roleChanges: [], visualMetaphorChanges: [], compositionChanges: [], informationHierarchyChanges: [],
        previousSlideRelationChanges: [], nextSlideRelationChanges: [],
      },
    }
    const requests: { url: string; body: Record<string, any>; key: string | null }[] = []
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, any>
        requests.push({ url: String(url), body, key: new Headers(init?.headers).get('Idempotency-Key') })
        return streamedResponsesTextCompletion(
          JSON.stringify(outputs[body.text.format.name]),
          { input_tokens: 321, output_tokens: 123, total_tokens: 444 },
        )
      },
    })

    await model.execute({
      operation: 'critique_v4_deck_consistency', schemaName: 'ppt_agent_v4_deck_consistency_critic_v1',
      idempotencyKey: 'run-v4:deck-reflection:critic', structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        presentationSpec: proposal.presentationSpec,
        candidate: deckCandidate,
        sourceSummary: sourceText,
      },
    })
    await model.execute({
      operation: 'optimize_v4_deck_consistency', schemaName: 'ppt_agent_v4_deck_consistency_optimizer_v1',
      idempotencyKey: 'run-v4:deck-reflection:optimizer', structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        candidate: deckCandidate,
        issues: [{
          issueId: 'reflection-issue-deck-1', pageNumbers: [1, 2], category: 'NARRATIVE_BREAK',
          field: 'deckPlan.narrativeArc', problem: '叙事没有收束', desiredChange: '补充结论收束',
        }],
      },
    })
    await model.execute({
      operation: 'critique_v4_slide_briefs', schemaName: 'ppt_agent_v4_slide_brief_critic_v1',
      idempotencyKey: 'run-v4:slide-reflection:critic', structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        presentationSpec: proposal.presentationSpec,
        deckVisual: deckCandidate,
        candidate: slideCandidate,
        sourceSummary: sourceText,
      },
    })
    await model.execute({
      operation: 'optimize_v4_slide_briefs', schemaName: 'ppt_agent_v4_slide_brief_optimizer_v1',
      idempotencyKey: 'run-v4:slide-reflection:optimizer', structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      payload: {
        candidate: slideCandidate,
        issues: [{
          issueId: 'reflection-issue-slide-1', pageNumber: 2, category: 'COUNTABILITY_RISK',
          field: 'composition', problem: '可能重复圆片', desiredChange: '只保留一个权威集合',
        }],
      },
    })

    expect(requests.map((request) => request.url)).toEqual(Array(4).fill('https://newapi.doitbenai.cloud/v1/responses'))
    expect(requests.map((request) => request.key)).toEqual([
      'run-v4:deck-reflection:critic', 'run-v4:deck-reflection:optimizer',
      'run-v4:slide-reflection:critic', 'run-v4:slide-reflection:optimizer',
    ])
    for (const request of requests) {
      expect(request.body.text.format).toMatchObject({ type: 'json_schema', strict: true })
      expect(request.body.text.format.schema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(request.body.text.format.schema.oneOf).toBeUndefined()
      expect(request.body.text.format.schema.anyOf).toBeUndefined()
      expect(request.body.tools).toBeUndefined()
      expect(request.body.tool_choice).toBeUndefined()
      expect(request.body.stream).toBe(true)
      const userText = request.body.input[1].content[0].text as string
      expect(userText).toContain('candidate')
      expect(userText).not.toContain('candidateArtifactHash')
      expect(userText).not.toContain('reviewContextHash')
      expect(userText).not.toContain('rubricVersion')
      const system = request.body.input[0].content[0].text as string
      expect(system).toContain('不输出思维过程')
      expect(system).toContain('不要返回哈希')
      expect(system).toContain('不要返回完整候选')
    }
    expect(requests[0]!.body.text.format.schema.properties).toEqual({ issues: expect.any(Object) })
    expect(requests[2]!.body.text.format.schema.properties).toEqual({ issues: expect.any(Object) })
    expect(requests[1]!.body.text.format.schema.properties).not.toHaveProperty('chapterChanges')
    expect(Object.keys(requests[3]!.body.text.format.schema.properties).sort()).toEqual([
      'compositionChanges', 'informationHierarchyChanges', 'nextSlideRelationChanges',
      'previousSlideRelationChanges', 'roleChanges', 'visualMetaphorChanges',
    ])
    expect(requests[2]!.body.input[0].content[0].text).toContain('重复绘制可数对象')
    expect(requests[2]!.body.input[0].content[0].text).toContain('不可分割的组合主体')
    expect(requests[3]!.body.input[0].content[0].text).toContain('冻结教学字段')
    expect(requests[3]!.body.input[0].content[0].text).toContain('视觉元素独立性要求')
    expect(model.takeExecutionMetrics('run-v4:deck-reflection:critic')).toMatchObject({
      inputTokens: 321, outputTokens: 123, totalTokens: 444,
    })
    expect(model.takeExecutionMetrics('run-v4:slide-reflection:optimizer')).toMatchObject({
      inputTokens: 321, outputTokens: 123, totalTokens: 444,
    })
    expect(model.takeExecutionMetrics('run-v4:deck-reflection:critic')).toBeNull()
  })

  test('keeps strict Responses Function as the explicit reflection compatibility encoding', async () => {
    const candidate = {
      deckPlan: {
        title: '分与合', slideCount: 2, narrativeArc: ['观察五个圆片', '总结两种分法'],
        chapters: [{ chapterId: 'story', title: '完整叙事', purpose: '建立分与合', slideNumbers: [1, 2] }],
      },
      visualContract: {
        artDirection: '儿童课堂信息图', palette: ['#FFFFFF', '#227755'], typography: '清晰中文字体',
        medium: '编辑插画', visualDensity: 'LOW' as const, compositionRules: ['每页一个焦点', '数量对象唯一'],
        continuityRules: ['统一圆片造型', '统一配色'], forbidden: ['额外编号'],
      },
    }
    const result = {
      decision: 'UNCHANGED' as const,
      checks: [
        'REQUEST_BINDING', 'SOURCE_GROUNDING', 'NARRATIVE_COHERENCE', 'SLIDE_COVERAGE',
        'VISUAL_COHERENCE', 'IMAGE_MODEL_EXECUTABILITY', 'COUNTABILITY_RISK',
        'UNAUTHORIZED_TEXT_RISK', 'VISUAL_DENSITY_RISK', 'CROSS_SLIDE_REPETITION',
        'SOURCE_ROLE_INTEGRITY', 'PEDAGOGICAL_SEQUENCE',
      ].map((dimension) => ({ dimension, passed: true, evidence: `${dimension} 已通过。` })),
      findings: [],
      baseArtifactHash: hashInput(candidate),
      reviewContextHash: 'f'.repeat(64),
      appliedFindingIds: [],
      revisedArtifact: candidate,
    }
    let body: Record<string, any> = {}
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return responsesCompletion('submit_visual_deck_v4_deck_visual_reflection', result)
      },
    })

    await model.execute({
      operation: 'reflect_and_revise_deck_visual', schemaName: 'ppt_agent_v4_deck_visual_reflection_v1',
      idempotencyKey: 'run-v4:reflect:deck-visual:0', structuredGenerationProtocol: 'RESPONSES_FUNCTION',
      payload: {
        originalRequest: { instruction: '制作分与合演示', targetAudience: null, presentationGoal: null, visualDirection: '儿童课堂信息图' },
        trustedEvidence: {
          sourceManifest: [{ sourceId: 'source-1', name: '教材', role: 'CONTENT_SOURCE', status: 'READY', sourceChunkIds: ['chunk-1'] }],
          sourceChunks: [{ id: 'chunk-1', sourceId: 'source-1', sha256: 'a'.repeat(64), text: '五可以分成一和四。', pageStart: null, pageEnd: null, region: null }],
        },
        frozenConstraints: {
          slideCount: 2, language: 'zh-CN', sourceMode: 'SOURCE_GROUNDED', presentationMode: 'VISUAL_DECK_V4',
          deckType: 'DETAILED_DECK', audience: '小学一年级学生', goal: '理解分与合', aspectRatio: '16:9', forbidden: [],
        },
        governanceContext: { presentationSpec: compileVisualDeckV4Proposal({
          runId: 'run-v4-reflection-compatibility', inputHash: 'input-v4-reflection-compatibility',
          source: { kind: 'TEXT', name: '教材.txt', text: '五可以分成一和四。' },
          document: {
            name: '教材.txt', chunks: [{ id: 'chunk-1', text: '五可以分成一和四。', sha256: 'a'.repeat(64) }],
            isComplete: true, missingRanges: [],
          },
          config: {
            instruction: '制作分与合演示', sourceMode: 'SOURCE_GROUNDED',
            deckOptions: {
              deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 },
              aspectRatio: '16:9', audience: '小学一年级学生',
            },
          },
          slideCount: 2, visualDirection: '儿童课堂信息图',
          presentationGoal: '理解分与合', createdAt: '2026-08-03T00:00:00.000Z',
        }).presentationSpec },
        candidateArtifact: candidate, candidateArtifactHash: hashInput(candidate),
        reviewContextHash: 'f'.repeat(64), rubricVersion: 'v4-reflection-1',
        providerCapabilities: { deliveryModel: 'RASTER_SLIDES_IN_PPTX' },
      },
    })

    expect(body.text).toBeUndefined()
    expect(body.tools[0]).toMatchObject({
      name: 'submit_visual_deck_v4_deck_visual_reflection', strict: true,
    })
  })

  test('uses patch-only Responses for chain-2 revision application and preserves chain-1', async () => {
    const requestUrls: string[] = []
    const requests: Array<{ key: string | null; body: any }> = []
    const revisionPlan = {
      summary: '只修订第一页的数量条件。',
      operations: [{
        id: 'operation-1', slideId: 'run-1:slide:1', kind: 'UPDATE_CONTENT', issueIds: ['issue-1'],
        instruction: '依据教材修正第一页的数量条件。', sourceChunkIds: ['chunk-1'],
      }],
    }
    const v4Draft = compileVisualDeckV4Proposal({
      runId: 'run-v4-revision', inputHash: 'input-v4-revision',
      source: { kind: 'TEXT', name: '教材.txt', text: '把一个完整图形平均分成两份，其中一份是二分之一。' },
      document: {
        name: '教材.txt', chunks: [{ id: 'chunk-1', text: '把一个完整图形平均分成两份，其中一份是二分之一。', sha256: 'a'.repeat(64) }],
        isComplete: true, missingRanges: [],
      },
      config: {
        instruction: '为三年级学生制作二分之一复习课件', sourceMode: 'SOURCE_GROUNDED',
        deckOptions: {
          deckType: 'DETAILED_DECK', language: 'zh-CN', length: { slideCount: 2 }, aspectRatio: '16:9',
          audience: '小学三年级学生', focus: '二分之一', styleHint: '温暖儿童绘本风格',
        },
      },
      slideCount: 2, visualDirection: '温暖儿童绘本风格',
      compilerVersion: CHAIN_2_VISUAL_DECK_V4_COMPILER_VERSION,
      createdAt: '2026-08-01T00:00:00.000Z',
    })
    const { compilerVersion: _compilerVersion, ...revisedDraft } = v4Draft
    const patchResult = {
      contentPatches: [],
      layoutPatches: [],
      redrawOnlyPageNumbers: [1],
    }
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (url, init) => {
        requestUrls.push(String(url))
        const request = JSON.parse(String(init?.body)) as { text?: { format?: { name?: string } } }
        const key = new Headers(init?.headers).get('Idempotency-Key')
        requests.push({ key, body: request })
        return request.text?.format?.name === 'ppt_agent_v4_revision_plan_v1'
          ? streamedResponsesTextCompletion(JSON.stringify(revisionPlan))
          : key === 'v4-revision-apply-chain-2'
            ? streamedResponsesTextCompletion(JSON.stringify(patchResult))
            : streamedResponsesTextCompletion(JSON.stringify(revisedDraft))
      },
    })
    const blueprint = { renderMode: 'VISUAL_DECK_V4', visualDeckV4Proposal: v4Draft } as never
    const legacyProposal = {
      ...structuredClone(v4Draft),
      compilerVersion: LEGACY_VISUAL_DECK_V4_COMPILER_VERSION,
    }
    const legacyBlueprint = { renderMode: 'VISUAL_DECK_V4', visualDeckV4Proposal: legacyProposal } as never

    await model.plan({
      tenantId: 'frameflow', blueprint, review: {} as never, sourceChunks: [],
      targetRevisionRound: 1, idempotencyKey: 'v4-revision-plan',
    })
    await model.apply({
      tenantId: 'frameflow', blueprint, plan: {} as never, sourceChunks: [],
      idempotencyKey: 'v4-revision-apply-chain-2',
    })
    await model.apply({
      tenantId: 'frameflow', blueprint: legacyBlueprint, plan: {} as never, sourceChunks: [],
      idempotencyKey: 'v4-revision-apply-chain-1',
    })

    expect(requestUrls).toEqual([
      'https://newapi.doitbenai.cloud/v1/responses',
      'https://newapi.doitbenai.cloud/v1/responses',
      'https://newapi.doitbenai.cloud/v1/responses',
    ])
    const chain2 = requests.find((request) => request.key === 'v4-revision-apply-chain-2')!.body
    const chain1 = requests.find((request) => request.key === 'v4-revision-apply-chain-1')!.body
    expect(chain2.text.format).toMatchObject({
      type: 'json_schema', name: 'ppt_agent_v4_revision_application_patch_v1', strict: true,
    })
    expect(Object.keys(chain2.text.format.schema.properties).sort()).toEqual([
      'contentPatches', 'layoutPatches', 'redrawOnlyPageNumbers',
    ])
    expect(JSON.stringify(chain2.input)).toContain('只返回局部补丁')
    expect(JSON.stringify(chain2.input)).toContain('视觉元素独立性要求')
    expect(chain2.text.format.schema.properties).not.toHaveProperty('sourceUnderstanding')
    expect(chain1.text.format).toMatchObject({
      type: 'json_schema', name: 'ppt_agent_v4_revision_application_v1', strict: true,
    })
    expect(chain1.text.format.schema.properties).toHaveProperty('sourceUnderstanding')
    expect(chain1.text.format.schema.properties).toHaveProperty('slideBriefs')
    expect(JSON.stringify(chain1.input)).toContain('视觉元素独立性要求')
  })

  test('rejects an incomplete V4 staged response before using its structured text', async () => {
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => Response.json({
        object: 'response', status: 'incomplete',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
      }),
    })

    await expect(model.execute({
      operation: 'create_visual_deck_v4_source_spec', schemaName: 'ppt_agent_v4_source_spec_v1',
      idempotencyKey: 'v4-incomplete-response',
      payload: { document: { chunks: [{ id: 'chunk-1' }] } },
    })).rejects.toMatchObject({ code: 'MODEL_JSON_INVALID', retryable: true, model: 'gpt-5.6-terra' })
  })

  test('requests a source-grounded blueprint through a typed tool', async () => {
    const artifacts = new MockArtifactPort()
    let requestBody: Record<string, unknown> | null = null
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra', artifacts,
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
      model: 'gpt-5.6-terra', stream: true, parallel_tool_calls: false,
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
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
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

  test('uses a V2.1-specific initial planning prompt', async () => {
    let requestBody: Record<string, unknown> | null = null
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return completion(blueprintDraft())
      },
    })

    await model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', idempotencyKey: 'plan-v21',
      payload: {
        slideCount: 2,
        presentationMode: 'SLIDE_IMAGE_V2_1',
        targetAudience: '一年级学生',
        presentationGoal: '建立数量三和具体物体的对应关系',
        document: {
          name: '数学教材.txt',
          chunks: [
            { id: 'chunk-1', text: '三个苹果表示数量三。' },
            { id: 'chunk-2', text: '观察苹果并完成数量对应。' },
          ],
        },
      },
    })

    const messages = (requestBody! as unknown as { messages: { content: string }[] }).messages
    expect(messages[0]!.content).toContain('整页生图 V2.1')
    expect(messages[0]!.content).toContain('目标受众')
    expect(messages[0]!.content).toContain('自然留白')
    expect(messages[0]!.content).toContain('不得绘制文字')
    const initialSlide = (requestBody! as unknown as {
      tools: { function: { parameters: { properties: { slides: { items: {
        required: string[]
        properties: Record<string, unknown>
      } } } } } }[]
    }).tools[0]!.function.parameters.properties.slides.items
    expect(initialSlide.required).not.toContain('layeredDesign')
    expect(initialSlide.properties).not.toHaveProperty('layeredDesign')
    const initialParameters = (requestBody! as unknown as {
      tools: { function: { parameters: { properties: {
        curriculum: { properties: { sourceChunkIds: Record<string, any> } }
        slides: { items: { properties: { sourceChunkIds: Record<string, any> } } }
      } } } }[]
    }).tools[0]!.function.parameters.properties
    expect(initialParameters.curriculum.properties.sourceChunkIds).toMatchObject({
      minItems: 2,
      maxItems: 2,
      uniqueItems: true,
      items: { enum: ['chunk-1', 'chunk-2'] },
    })
    expect(initialParameters.slides.items.properties.sourceChunkIds.items.enum).toEqual(['chunk-1', 'chunk-2'])
  })

  test('returns a structured critique and revised blueprint for V2.1 reflection', async () => {
    let requestBody: Record<string, unknown> | null = null
    const expected = blueprintReflection()
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return completion(expected)
      },
    })

    const result = await model.execute({
      operation: 'reflect_blueprint', schemaName: 'ppt_agent_blueprint_reflection_v1', idempotencyKey: 'reflect-v21',
      payload: {
        presentationMode: 'SLIDE_IMAGE_V2_1',
        slideCount: 2,
        visualDirection: '明亮自然的儿童教育编辑插画',
        originalBlueprint: blueprintDraft(),
      },
    })

    expect(result).toEqual(expected)
    expect(requestBody).toMatchObject({
      tools: [{ type: 'function', function: { name: 'submit_blueprint_reflection', strict: true } }],
      tool_choice: { type: 'function', function: { name: 'submit_blueprint_reflection' } },
    })
    const messages = (requestBody! as unknown as { messages: { content: string }[] }).messages
    expect(messages[0]!.content).toContain('七个维度')
    expect(messages[0]!.content).toContain('不得只做同义改写')
    expect(messages[1]!.content).toContain('originalBlueprint')
    const revisedSlide = (requestBody! as unknown as {
      tools: { function: { parameters: { properties: { revisedBlueprint: {
        properties: { slides: { items: { required: string[]; properties: Record<string, unknown> } } }
      } } } } }[]
    }).tools[0]!.function.parameters.properties.revisedBlueprint.properties.slides.items
    expect(revisedSlide.required).not.toContain('layeredDesign')
    expect(revisedSlide.properties).not.toHaveProperty('layeredDesign')
    const reflectedParameters = (requestBody! as unknown as {
      tools: { function: { parameters: { properties: { revisedBlueprint: { properties: {
        curriculum: { properties: { sourceChunkIds: Record<string, any> } }
        slides: { items: { properties: { sourceChunkIds: Record<string, any> } } }
      } } } } } }[]
    }).tools[0]!.function.parameters.properties.revisedBlueprint.properties
    expect(reflectedParameters.curriculum.properties.sourceChunkIds).toMatchObject({
      minItems: 1,
      maxItems: 1,
      uniqueItems: true,
      items: { enum: ['chunk-1'] },
    })
    expect(reflectedParameters.slides.items.properties.sourceChunkIds.items.enum).toEqual(['chunk-1'])
  })

  test('sends source assets as labeled multimodal content without embedding bytes in JSON metadata', async () => {
    let requestBody: Record<string, unknown> | null = null
    const bytes = new Uint8Array(await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#68A678' },
    }).png().toBuffer())
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
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

  test('sends the controlled image to the V4 Responses vision reviewer', async () => {
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
    let requestUrl = ''
    const review = {
      approved: true, textDetected: false, visualScore: 91, reasons: [], retryInstruction: null,
      qualityImpact: 'PASS' as const,
    }
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      visionModel: 'gpt-5.6-terra', artifacts,
      fetchImpl: async (url, init) => {
        requestUrl = String(url)
        requestBody = JSON.parse(String(init?.body))
        return streamedResponsesTextCompletion(JSON.stringify(review))
      },
    })

    expect(await model.review({
      tenantId: 'frameflow', artifactId: stored.artifactId,
      visualIntent: '允许文字：5可以分成3和2；非展示事实核对项：整页只有5个实体圆片',
      layout: 'VISUAL_DECK_V4', visualDirection: '儿童课堂风格', idempotencyKey: 'review-1',
      v4CompilerVersion: VISUAL_DECK_V4_COMPILER_VERSION,
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      contractRepairIssues: [{ path: 'modelOnlyVisualPath', message: 'MODEL_ONLY_VISUAL_PATH' }],
    })).toEqual(review)
    expect(requestUrl).toBe('https://newapi.doitbenai.cloud/v1/responses')
    expect(requestBody).not.toBeNull()
    const input = (requestBody! as unknown as {
      input: { content: { type: string; text?: string; image_url?: string }[] }[]
    }).input
    expect(input[0]?.content[0]?.text).toContain('非展示事实核对项')
    expect(input[0]?.content[0]?.text).toContain('视觉元素独立性要求')
    expect(input[0]?.content[0]?.text).toContain('绑定、粘合、嵌套或合成')
    expect(input[0]?.content[0]?.text).toContain('NON_BLOCKING_RECOMMENDATION')
    const userContent = input[1]!.content
    const userMetadata = JSON.stringify(userContent)
    expect(userMetadata).toContain('contentSlotCompletion')
    expect(userMetadata).not.toContain('contractRepairIssues')
    expect(userMetadata).not.toContain('modelOnlyVisualPath')
    expect(userMetadata).not.toContain('MODEL_ONLY_VISUAL_PATH')
    const imageUrl = userContent.find((part) => part.type === 'input_image')?.image_url
    expect(imageUrl?.startsWith('data:image/jpeg;base64,')).toBe(true)
    const { data } = await sharp(Buffer.from(imageUrl!.split(',')[1]!, 'base64')).raw().toBuffer({ resolveWithObject: true })
    expect([...data.subarray(0, 3)].every((channel) => channel >= 240)).toBe(true)
  })

  test('compiles chain-4 deck review control fields from semantic findings', async () => {
    const artifacts = new MockArtifactPort()
    const bytes = await sharp({
      create: { width: 160, height: 90, channels: 3, background: '#F5F8FF' },
    }).png().toBuffer()
    const stored = await artifacts.put({
      tenantId: 'frameflow', runId: 'run-v4', name: 'slide-1.png', mimeType: 'image/png', bytes,
      idempotencyKey: 'run-v4-slide-1',
    })
    const manuscript = {
      qualityScore: 72,
      curriculumCoverageScore: 70,
      narrativeCoherenceScore: 78,
      visualConsistencyScore: 76,
      compositionScore: 74,
      summary: '页面整体结构清晰，但事实表达仍缺少教材中的准确限定。',
      slides: [{
        findings: [{
          category: 'FACTUAL_RISK', severity: 'CRITICAL',
          summary: '页面中的数量关系需要与教材原文保持一致。', repairDomain: 'KNOWLEDGE',
          sourceEvidence: '三个苹果表示数量三',
        }],
      }],
    }
    let requestBody: Record<string, any> | null = null
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      visionModel: 'gpt-5.6-terra', artifacts,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body))
        return streamedResponsesTextCompletion(JSON.stringify(manuscript))
      },
    })

    const result = await model.evaluate({
      tenantId: 'frameflow',
      blueprint: {
        renderMode: 'VISUAL_DECK_V4',
        curriculum: { sourceChunkIds: ['chunk-1'] },
        visualDeckV4Proposal: { compilerVersion: VISUAL_DECK_V4_COMPILER_VERSION },
      } as never,
      sourceChunks: [{ id: 'chunk-1', text: '教材明确说明：三个苹果表示数量三。', sha256: 'a'.repeat(64) }],
      slides: [{
        pageNumber: 1, slideId: 'run-v4:slide:1', artifactId: stored.artifactId,
        title: '认识数量三', body: ['观察三个苹果'], layout: 'HERO',
        visualIntent: '用三个苹果建立数量三的直观认识', sourceChunkIds: ['chunk-1'],
      }],
      idempotencyKey: 'run-v4-deck-review',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
      contractRepairIssues: [{ path: 'modelOnlyDeckPath', message: 'MODEL_ONLY_DECK_PATH' }],
    })

    const body = requestBody! as Record<string, any>
    expect(body.text.format).toMatchObject({
      type: 'json_schema', name: 'ppt_agent_v4_deck_review_manuscript_v1', strict: true,
    })
    const schema = JSON.stringify(body.text.format.schema)
    expect(schema).not.toContain('issueId')
    expect(schema).not.toContain('slideId')
    expect(schema).not.toContain('sourceChunkId')
    const userMetadata = JSON.stringify((body.input as unknown as unknown[])[1])
    expect(userMetadata).toContain('contentSlotCompletion')
    expect(userMetadata).not.toContain('contractRepairIssues')
    expect(userMetadata).not.toContain('modelOnlyDeckPath')
    expect(userMetadata).not.toContain('MODEL_ONLY_DECK_PATH')
    expect(result).toMatchObject({
      reviewedSourceChunkIds: ['chunk-1'],
      issues: [{
        category: 'FACTUAL_RISK', severity: 'CRITICAL', slideIds: ['run-v4:slide:1'],
        sourceChunkIds: ['chunk-1'], status: 'OPEN', repairDomain: 'KNOWLEDGE',
      }],
    })
    if (!('issues' in result)) throw new Error('CHAIN4_DECK_REVIEW_NOT_COMPILED')
    expect(result.issues[0]?.id).toMatch(/^issue-[a-f0-9]{32}$/)
  })

  test.each(['RESPONSES_FUNCTION', 'CHAT_LEGACY'] as const)(
    'fails closed before any direct chain-4 %s request',
    async (structuredGenerationProtocol) => {
      const artifacts = new MockArtifactPort()
      const stored = await artifacts.put({
        tenantId: 'frameflow',
        runId: 'run-v4',
        name: 'slide-1.png',
        mimeType: 'image/png',
        bytes: new Uint8Array(await sharp({
          create: { width: 160, height: 90, channels: 3, background: '#F5F8FF' },
        }).png().toBuffer()),
        idempotencyKey: 'run-v4-slide-1',
      })
      let fetchCalls = 0
      const model = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1',
        apiKey: 'test-text-key',
        textModel: 'gpt-5.6-terra',
        artifacts,
        fetchImpl: async () => {
          fetchCalls += 1
          throw new Error('MODEL_FETCH_SHOULD_NOT_RUN')
        },
      })
      const blueprint = {
        renderMode: 'VISUAL_DECK_V4',
        visualDeckV4Proposal: { compilerVersion: VISUAL_DECK_V4_COMPILER_VERSION },
      } as never

      await expect(model.review({
        tenantId: 'frameflow',
        artifactId: stored.artifactId,
        visualIntent: '验证 Chain-4 严格协议。',
        layout: 'HERO',
        visualDirection: '课堂科学信息图',
        idempotencyKey: `chain4-direct-review-${structuredGenerationProtocol}`,
        v4CompilerVersion: VISUAL_DECK_V4_COMPILER_VERSION,
        structuredGenerationProtocol,
      })).rejects.toThrow('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
      await expect(model.evaluate({
        tenantId: 'frameflow',
        blueprint,
        sourceChunks: [],
        slides: [],
        idempotencyKey: `chain4-direct-deck-review-${structuredGenerationProtocol}`,
        structuredGenerationProtocol,
      })).rejects.toThrow('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
      await expect(model.plan({
        tenantId: 'frameflow',
        blueprint,
        review: {} as never,
        sourceChunks: [],
        targetRevisionRound: 1,
        idempotencyKey: `chain4-direct-revision-plan-${structuredGenerationProtocol}`,
        structuredGenerationProtocol,
      })).rejects.toThrow('V4_CHAIN4_PROTOCOL_UNSUPPORTED')
      await expect(model.apply({
        tenantId: 'frameflow',
        blueprint,
        plan: {} as never,
        sourceChunks: [],
        idempotencyKey: `chain4-direct-revision-apply-${structuredGenerationProtocol}`,
        structuredGenerationProtocol,
      })).rejects.toThrow('V4_CHAIN4_PROTOCOL_UNSUPPORTED')

      expect(fetchCalls).toBe(0)
    },
  )

  test('keeps open-knowledge chain-4 findings source-free without contract repair', async () => {
    const artifacts = new MockArtifactPort()
    const bytes = await sharp({
      create: { width: 160, height: 90, channels: 3, background: '#F5F8FF' },
    }).png().toBuffer()
    const stored = await artifacts.put({
      tenantId: 'frameflow', runId: 'run-open', name: 'slide-1.png', mimeType: 'image/png', bytes,
      idempotencyKey: 'run-open-slide-1',
    })
    const manuscript = {
      qualityScore: 72,
      curriculumCoverageScore: 70,
      narrativeCoherenceScore: 78,
      visualConsistencyScore: 76,
      compositionScore: 74,
      summary: '页面整体结构清晰，但开放知识中的事实表达仍需要进一步核验。',
      slides: [{ findings: [{
        category: 'FACTUAL_RISK', severity: 'CRITICAL',
        summary: '页面中的开放知识事实需要由下游进一步核验。', repairDomain: 'KNOWLEDGE',
      }] }],
    }
    let calls = 0
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      visionModel: 'gpt-5.6-terra', artifacts,
      fetchImpl: async () => {
        calls += 1
        return streamedResponsesTextCompletion(JSON.stringify(manuscript))
      },
    })

    const result = await model.evaluate({
      tenantId: 'frameflow',
      blueprint: {
        renderMode: 'VISUAL_DECK_V4',
        curriculum: { sourceChunkIds: ['chunk-request'] },
        visualDeckV4Proposal: {
          compilerVersion: VISUAL_DECK_V4_COMPILER_VERSION,
          presentationSpec: { sourceMode: 'OPEN_KNOWLEDGE' },
        },
      } as never,
      sourceChunks: [{ id: 'chunk-request', text: '用户请求制作一页开放知识演示。', sha256: 'b'.repeat(64) }],
      slides: [{
        pageNumber: 1, slideId: 'run-open:slide:1', artifactId: stored.artifactId,
        title: '开放知识主题', body: ['待核验事实'], layout: 'HERO',
        visualIntent: '清晰展示开放知识主题', sourceChunkIds: ['chunk-request'],
      }],
      idempotencyKey: 'run-open-deck-review',
      structuredGenerationProtocol: 'RESPONSES_JSON_SCHEMA',
    })

    expect(calls).toBe(1)
    expect(result).toMatchObject({
      reviewedSourceChunkIds: ['chunk-request'],
      issues: [{
        category: 'FACTUAL_RISK', repairDomain: 'KNOWLEDGE', sourceChunkIds: [],
        slideIds: ['run-open:slide:1'], status: 'OPEN',
      }],
    })
  })

  test('reviews downloaded asset bytes against knowledge and style without sending source URLs', async () => {
    const artifacts = new MockArtifactPort()
    const png = await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#F4F7FA' },
    }).png().toBuffer()
    let requestBody: Record<string, unknown> | null = null
    const review = {
      approved: true, textDetected: false, visualScore: 88, reasons: [], retryInstruction: null,
      qualityImpact: 'PASS' as const,
    }
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra', artifacts,
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

  test('uses the MiniMax M3 request profile and preserves its request id', async () => {
    const png = new Uint8Array(await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#F4F7FA' },
    }).png().toBuffer())
    let requestBody: Record<string, unknown> | null = null
    const requestUrls: string[] = []
    const original = console.error
    console.error = () => undefined
    try {
      const model = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'MiniMax-M3',
        visionModel: 'MiniMax-M3', artifacts: new MockArtifactPort(), profile: 'MINIMAX_M3',
        visualDeckV4Transport: 'CHAT_COMPLETIONS',
        fetchImpl: async (url, init) => {
          requestUrls.push(String(url))
          requestBody = JSON.parse(String(init?.body))
          return Response.json({ error: { type: 'upstream_error' } }, {
            status: 503,
            headers: { 'minimax-request-id': 'minimax-request-safe-1' },
          })
        },
      })

      await expect(model.reviewCandidate({
        tenantId: 'frameflow',
        candidate: {
          provider: 'OPENVERSE', providerAssetId: 'asset-minimax', title: 'Classroom globe',
          sourceUrl: 'https://example.org/source', downloadUrl: 'https://example.org/download',
          creator: null, license: 'CC0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
          attribution: null, mimeType: 'image/png', width: 120, height: 80,
        },
        bytes: png,
        intent: {
          searchQueries: ['classroom globe'], mediaType: 'PHOTO', styleKeywords: ['bright classroom'],
          transparencyPreference: 'EITHER',
        },
        knowledgePoint: '使用地球仪解释地轴倾斜', role: 'KNOWLEDGE_VISUAL',
        visualDirection: '明亮的儿童课堂视觉', idempotencyKey: 'candidate-review-minimax',
      })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE', model: 'MiniMax-M3', requestId: 'minimax-request-safe-1',
      })
    } finally {
      console.error = original
    }

    const body = requestBody! as unknown as {
      thinking: { type: string }
      reasoning_split: boolean
      messages: { content: unknown }[]
    }
    expect(requestUrls).toEqual(['https://newapi.doitbenai.cloud/v1/chat/completions'])
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_split).toBe(true)
    const content = body.messages[1]!.content as { image_url?: { detail: string } }[]
    expect(content.find((part) => part.image_url)?.image_url?.detail).toBe('default')
  })

  test('rejects insecure public endpoints and hides network failure details', async () => {
    expect(() => new GatewayCoursewareModel({
      baseUrl: 'http://example.com/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra', artifacts: new MockArtifactPort(),
    })).toThrow('GATEWAY_BASE_URL_INSECURE')

    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(), fetchImpl: async () => { throw new Error('private detail') },
    })
    await expect(model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-fail',
    })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, model: 'gpt-5.6-terra', requestId: null,
    })
  })

  test('classifies rate limits and malformed model JSON without exposing response content', async () => {
    const request = {
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-diagnostic',
    }
    const rateLimited = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => new Response('private provider response', {
        status: 429,
        headers: { 'x-request-id': 'request-safe-1' },
      }),
    })
    await expect(rateLimited.execute(request)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT', retryable: true, model: 'gpt-5.6-terra', requestId: 'request-safe-1',
    })

    const invalidJson = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => Response.json({
        choices: [{ message: { tool_calls: [{ function: { arguments: '{private invalid content' } }] } }],
      }, { headers: { 'x-request-id': 'request-safe-2' } }),
    })
    await expect(invalidJson.execute(request)).rejects.toMatchObject({
      code: 'MODEL_JSON_INVALID', retryable: true, model: 'gpt-5.6-terra', requestId: 'request-safe-2',
      submissionState: 'ACCEPTED',
      contractFailure: { layer: 'JSON_PARSE', responseHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    })

    const invalidContract = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => Response.json({
        choices: [{ message: { tool_calls: [{ function: { arguments: '{}' } }] } }],
      }, { headers: { 'x-request-id': 'request-safe-3' } }),
    })
    await expect(invalidContract.execute(request)).rejects.toMatchObject({
      code: 'MODEL_JSON_INVALID', retryable: true, model: 'gpt-5.6-terra', requestId: 'request-safe-3',
      submissionState: 'ACCEPTED',
      contractFailure: { layer: 'JSON_SCHEMA', responseHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    })
  })

  test('logs only allowlisted provider rejection metadata', async () => {
    const records: string[] = []
    const original = console.error
    console.error = (...values) => records.push(values.join(' '))
    try {
      const model = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
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
      model: 'gpt-5.6-terra', providerCode: 'invalid_tool_schema', providerType: 'invalid_request_error',
      providerParam: 'tools.0.function.parameters',
    })
    expect(records[0]).not.toContain('private provider response')
  })

  test('retries only ambiguous invalid-request rejections without an explicit client error', async () => {
    const original = console.error
    console.error = () => undefined
    try {
      const ambiguous = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
        artifacts: new MockArtifactPort(),
        fetchImpl: async () => Response.json({ error: { type: 'invalid_request_error' } }, { status: 400 }),
      })
      await expect(ambiguous.execute({
        operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-ambiguous-400',
      })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true })

      const explicit = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
        artifacts: new MockArtifactPort(),
        fetchImpl: async () => Response.json({
          error: { code: 'invalid_tool_schema', type: 'invalid_request_error', param: 'tools.0.function.parameters' },
        }, { status: 400 }),
      })
      await expect(explicit.execute({
        operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-explicit-400',
      })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false })

      for (const [idempotencyKey, error] of [
        ['plan-numeric-code-400', { type: 'invalid_request_error', code: 400 }],
        ['plan-unsafe-param-400', { type: 'invalid_request_error', param: 'tools[0] invalid parameter' }],
      ] as const) {
        const malformedDetail = new GatewayCoursewareModel({
          baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
          artifacts: new MockArtifactPort(),
          fetchImpl: async () => Response.json({ error }, { status: 400 }),
        })
        await expect(malformedDetail.execute({
          operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey,
        })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false })
      }

      const detailCode = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
        artifacts: new MockArtifactPort(),
        fetchImpl: async () => Response.json({
          error: { type: 'invalid_request_error', code: ' ' },
          detail: { code: 'invalid_tool_schema' },
        }, { status: 400 }),
      })
      await expect(detailCode.execute({
        operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-detail-code-400',
      })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false })
    } finally {
      console.error = original
    }
  })

  test.each([
    [401, '401', 'MODEL_AUTH_FAILED'],
    [401, 401, 'MODEL_AUTH_FAILED'],
    [403, '403', 'MODEL_FORBIDDEN'],
    [403, 403, 'MODEL_FORBIDDEN'],
    [404, '404', 'MODEL_NOT_FOUND'],
    [404, 404, 'MODEL_NOT_FOUND'],
  ] as const)('classifies explicit matching wrapped HTTP %i / %s as %s', async (status, providerCode, expectedCode) => {
    const original = console.error
    console.error = () => undefined
    try {
      const model = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
        artifacts: new MockArtifactPort(),
        fetchImpl: async () => Response.json({ error: { code: providerCode, type: 'upstream_error' } }, {
          status,
          headers: { 'x-request-id': `request-upstream-${status}` },
        }),
      })
      await expect(model.execute({
        operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {},
        idempotencyKey: `plan-upstream-${status}-${typeof providerCode}`,
      })).rejects.toMatchObject({
        code: expectedCode, retryable: false, requestId: `request-upstream-${status}`, model: 'gpt-5.6-terra',
      })
    } finally {
      console.error = original
    }
  })

  test.each([
    ['missing inner code', undefined, true],
    ['conflicting inner code', '404', false],
  ] as const)('does not mistake wrapped 403 with %s for a matching permission error', async (_label, providerCode, retryable) => {
    const original = console.error
    console.error = () => undefined
    try {
      const model = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
        artifacts: new MockArtifactPort(),
        fetchImpl: async () => Response.json({ error: { type: 'upstream_error', ...(providerCode ? { code: providerCode } : {}) } }, {
          status: 403,
          headers: { 'x-request-id': 'request-upstream-ambiguous-403' },
        }),
      })
      await expect(model.execute({
        operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {},
        idempotencyKey: `plan-upstream-ambiguous-${providerCode ?? 'missing'}`,
      })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE', retryable, requestId: 'request-upstream-ambiguous-403', model: 'gpt-5.6-terra',
      })
    } finally {
      console.error = original
    }
  })

  test('treats a gateway bad response status as retryable even when wrapped in HTTP 403', async () => {
    const original = console.error
    console.error = () => undefined
    try {
      const model = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
        artifacts: new MockArtifactPort(),
        fetchImpl: async () => Response.json({
          error: { code: 'bad_response_status_code', type: 'bad_response_status_code' },
        }, {
          status: 403,
          headers: { 'x-request-id': 'request-upstream-403' },
        }),
      })
      await expect(model.execute({
        operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {},
        idempotencyKey: 'plan-upstream-403',
      })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE', retryable: true, requestId: 'request-upstream-403', model: 'gpt-5.6-terra',
      })
    } finally {
      console.error = original
    }
  })

  test('classifies a direct gateway 403 as a non-retryable model permission failure', async () => {
    const original = console.error
    console.error = () => undefined
    try {
      const model = new GatewayCoursewareModel({
        baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
        artifacts: new MockArtifactPort(),
        fetchImpl: async () => Response.json({
          error: { code: 'model_forbidden', type: 'insufficient_permissions' },
        }, { status: 403, headers: { 'x-request-id': 'request-model-forbidden' } }),
      })
      await expect(model.execute({
        operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {},
        idempotencyKey: 'plan-model-forbidden',
      })).rejects.toMatchObject({
        code: 'MODEL_FORBIDDEN', retryable: false, requestId: 'request-model-forbidden', model: 'gpt-5.6-terra',
      })
    } finally {
      console.error = original
    }
  })

  test('classifies an aborted gateway request as a provider timeout', async () => {
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(), fetchImpl: async () => { throw new DOMException('private timeout detail', 'TimeoutError') },
    })
    await expect(model.execute({
      operation: 'create_visual_deck_v4_source_spec', schemaName: 'ppt_agent_v4_source_spec_v1',
      payload: { document: { chunks: [{ id: 'chunk-1' }] } }, idempotencyKey: 'plan-timeout',
    })).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT', retryable: true, model: 'gpt-5.6-terra', submissionState: 'UNKNOWN',
    })
    expect(model.takeExecutionMetrics('plan-timeout')).toMatchObject({
      outcome: 'FAILED', errorCode: 'PROVIDER_TIMEOUT', status: null,
      requestId: null, responseAccepted: false, sseEventCount: 0,
      submissionState: 'UNKNOWN',
      durationMs: expect.any(Number),
    })
  })

  test('classifies an interrupted response stream as provider unavailable instead of invalid JSON', async () => {
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('private stream detail')) },
      }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'request-stream-1' } }),
    })
    await expect(model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-stream',
    })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, requestId: 'request-stream-1', model: 'gpt-5.6-terra',
      submissionState: 'ACCEPTED',
    })
  })

  test('classifies a response stream timeout as provider timeout', async () => {
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.error(new DOMException('private stream timeout detail', 'TimeoutError')) },
      }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'request-stream-timeout-1' } }),
    })
    await expect(model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-stream-timeout',
    })).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT', retryable: true, requestId: 'request-stream-timeout-1', model: 'gpt-5.6-terra',
      submissionState: 'ACCEPTED',
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
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(payload) },
        cancel() { cancelled = true },
      }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'request-oversized-1' } }),
    })

    await expect(model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-oversized',
    })).rejects.toMatchObject({
      code: 'MODEL_JSON_INVALID', retryable: true, requestId: 'request-oversized-1', model: 'gpt-5.6-terra',
    })
    expect(cancelled).toBe(true)
  })

  test('cancels an unframed SSE event before its buffer can grow without bound', async () => {
    let cancelled = false
    const payload = new TextEncoder().encode(
      `data: ${'x'.repeat(MAX_GATEWAY_TOOL_ARGUMENT_BYTES + 256 * 1024 + 1)}`,
    )
    const model = new GatewayCoursewareModel({
      baseUrl: 'https://newapi.doitbenai.cloud/v1', apiKey: 'test-text-key', textModel: 'gpt-5.6-terra',
      artifacts: new MockArtifactPort(),
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(payload) },
        cancel() { cancelled = true },
      }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'request-unframed-1' } }),
    })

    await expect(model.execute({
      operation: 'create_blueprint', schemaName: 'ppt_agent_blueprint_v1', payload: {}, idempotencyKey: 'plan-unframed',
    })).rejects.toMatchObject({
      code: 'MODEL_JSON_INVALID', retryable: true, requestId: 'request-unframed-1', model: 'gpt-5.6-terra',
    })
    expect(cancelled).toBe(true)
  })
})

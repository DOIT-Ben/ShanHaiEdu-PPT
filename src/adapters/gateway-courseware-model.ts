import sharp from 'sharp'
import { z } from 'zod'
import {
  blueprintDraftSchema,
  deckReviewDraftSchema,
  layeredBlueprintDraftSchema,
  revisionPlanDraftSchema,
  slideVisualReviewSchema,
} from '../presentation-contracts'
import type {
  ArtifactPort,
  DeckReviewPort,
  RevisionApplicationPort,
  RevisionPlanningPort,
  StructuredModelPort,
  VisualReviewPort,
} from '../core/ports'
import { StructuredModelError } from '../core/ports'

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type ToolContent = string | readonly (
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'image_url'; image_url: Readonly<{ url: string; detail: 'auto' }> }>
)[]

const streamChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      tool_calls: z.array(z.object({
        function: z.object({ arguments: z.string().optional() }).passthrough().optional(),
      }).passthrough()).optional(),
    }).passthrough(),
    finish_reason: z.string().nullable().optional(),
  }).passthrough()).default([]),
}).passthrough()

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      tool_calls: z.array(z.object({
        function: z.object({ arguments: z.string().min(1) }).passthrough(),
      }).passthrough()).min(1),
    }).passthrough(),
  }).passthrough()).min(1),
}).passthrough()

function normalizedBaseUrl(value: string) {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('GATEWAY_BASE_URL_INSECURE')
  }
  return url.toString().replace(/\/$/, '')
}

function jsonSchema(schema: z.ZodType) {
  const value = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  delete value.$schema
  return value
}

function requireLayeredBaseImage(schema: Record<string, unknown>) {
  const properties = schema.properties as Record<string, unknown> | undefined
  const slides = properties?.slides as Record<string, unknown> | undefined
  const slide = slides?.items as Record<string, unknown> | undefined
  const slideProperties = slide?.properties as Record<string, unknown> | undefined
  const layeredDesign = slideProperties?.layeredDesign as Record<string, unknown> | undefined
  const designProperties = layeredDesign?.properties as Record<string, unknown> | undefined
  const elements = designProperties?.elements as Record<string, unknown> | undefined
  if (!elements) throw new Error('LAYERED_BLUEPRINT_SCHEMA_INVALID')
  elements.contains = {
    type: 'object',
    properties: {
      kind: { const: 'IMAGE' },
      role: { const: 'BASE_LAYER' },
    },
    required: ['kind', 'role'],
  }
  return schema
}

function boundedJson(value: unknown, maxLength = 240_000) {
  const text = JSON.stringify(value)
  if (text.length > maxLength) throw new Error('MODEL_CONTEXT_TOO_LARGE')
  return text
}

function safeProviderField(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value) ? value : null
}

function providerRejectionMetadata(payload: unknown) {
  const parsed = z.object({
    error: z.object({
      code: z.unknown().optional(),
      type: z.unknown().optional(),
      param: z.unknown().optional(),
    }).passthrough().optional(),
    detail: z.object({ code: z.unknown().optional() }).passthrough().optional(),
  }).passthrough().safeParse(payload)
  if (!parsed.success) return { providerCode: null, providerType: null, providerParam: null }
  return {
    providerCode: safeProviderField(parsed.data.error?.code ?? parsed.data.detail?.code),
    providerType: safeProviderField(parsed.data.error?.type),
    providerParam: safeProviderField(parsed.data.error?.param),
  }
}

export class GatewayCoursewareModel implements
  StructuredModelPort,
  VisualReviewPort,
  DeckReviewPort,
  RevisionPlanningPort,
  RevisionApplicationPort {
  readonly modelName: string
  private readonly baseUrl: string
  private readonly fetchImpl: Fetch

  constructor(private readonly dependencies: Readonly<{
    baseUrl: string
    apiKey: string
    textModel: string
    visionModel?: string
    artifacts: ArtifactPort
    fetchImpl?: Fetch
  }>) {
    this.baseUrl = normalizedBaseUrl(dependencies.baseUrl)
    if (dependencies.apiKey.trim().length < 8) throw new Error('GATEWAY_TEXT_KEY_REQUIRED')
    if (dependencies.textModel.trim().length === 0) throw new Error('GATEWAY_TEXT_MODEL_REQUIRED')
    this.modelName = dependencies.textModel
    this.fetchImpl = dependencies.fetchImpl ?? fetch
  }

  async execute(input: Parameters<StructuredModelPort['execute']>[0]) {
    if (input.operation !== 'create_blueprint') throw new Error('MODEL_OPERATION_UNSUPPORTED')
    const layered = z.object({ presentationMode: z.literal('LAYERED_COURSEWARE_V3') }).passthrough().safeParse(input.payload).success
    const system = `你是学校采购场景的资深课件总设计师。根据教材创建完整教学蓝图，知识正确优先于视觉效果。
V3 要求每页 elements 必须且只能有一个 kind=IMAGE、role=BASE_LAYER 的可编辑底图对象，包括封面和所有内容页；另可有最多四个与知识点直接相关的独立图片素材、原生文字和原生形状。所有素材必须引用真实 sourceChunkIds。
输入可能包含带真实 sourceAssetId 的教材图片或 PDF 页图。必须把每个来源图片映射到 curriculum、目标 slide 和相关 IMAGE/TEXT 元素；需要原样保留时用 REUSE_ORIGINAL，作为指定生图参考时用 REFERENCE_GENERATION，仅在不采用原图时用 REGENERATE。不得虚构 sourceAssetIds。
当 coverDesignMode=INDEPENDENT 时，第一页必须采用与正文明显不同的封面构图，以课程主题、标题和单一强主视觉建立冲击力；不得套用正文内容面板。当值为 FOLLOW_TEMPLATE 时才允许跟随正文结构。
如果输入包含 contractRepairIssues，必须重新生成完整蓝图并逐项修正这些合同问题。
只提交工具参数，不输出解释或思维过程。`
    return this.request({
      model: this.dependencies.textModel,
      system,
      user: input.sourceAssets && input.sourceAssets.length > 0
        ? [
            { type: 'text' as const, text: `请依据以下受信教材数据创建蓝图：\n${boundedJson(input.payload)}` },
            ...(await Promise.all(input.sourceAssets.flatMap((asset) => [
              Promise.resolve({
                type: 'text' as const,
                text: `来源图片 ${asset.id}（${asset.name}${asset.pageNumber ? `，第 ${asset.pageNumber} 页` : ''}）`,
              }),
              this.sourceImageContent(asset),
            ]))),
          ]
        : `请依据以下受信教材数据创建蓝图：\n${boundedJson(input.payload)}`,
      toolName: 'submit_courseware_blueprint',
      description: '提交知识驱动、分层可编辑的完整课件蓝图。',
      schema: layered ? layeredBlueprintDraftSchema : blueprintDraftSchema,
      requireLayeredBaseImage: layered,
      idempotencyKey: input.idempotencyKey,
    })
  }

  async review(input: Parameters<VisualReviewPort['review']>[0]) {
    const image = await this.imageContent(input.tenantId, input.artifactId)
    return this.request({
      model: this.dependencies.visionModel ?? this.dependencies.textModel,
      system: `你是儿童课件视觉质检员。严格检查图片内错误文字、数字、公式、Logo、水印、知识不相关、年龄不适宜、主体残缺和低质量问题。
当 layout 以 COMPOSITE: 开头时，还必须检查最终页面中的文字可读性、遮挡、越界、层级、留白和元素冲突；合成页中的原生课件文字允许存在，不得因此判 textDetected=true。
只有所有检查通过才可 approved=true。拒绝时给出可直接用于重新生成或重新布局的明确指令。`,
      user: [
        { type: 'text', text: boundedJson({ visualIntent: input.visualIntent, layout: input.layout, visualDirection: input.visualDirection }) },
        image,
      ],
      toolName: 'submit_visual_review',
      description: '提交单素材或完整组装页的严格视觉审查结果。',
      schema: slideVisualReviewSchema,
      idempotencyKey: input.idempotencyKey,
    })
  }

  async evaluate(input: Parameters<DeckReviewPort['evaluate']>[0]) {
    const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }> = [{
      type: 'text',
      text: `请审查整套课件。页面数据、教材来源和蓝图如下：\n${boundedJson({
        blueprint: input.blueprint,
        sourceChunks: input.sourceChunks,
        slides: input.slides.map(({ artifactId: _artifactId, ...slide }) => slide),
      })}`,
    }]
    for (const slide of input.slides) {
      content.push({ type: 'text', text: `第 ${slide.pageNumber} 页最终组装预览：` })
      content.push(await this.imageContent(input.tenantId, slide.artifactId))
    }
    return this.request({
      model: this.dependencies.visionModel ?? this.dependencies.textModel,
      system: `你是学校课件终审专家。对照教材和全部最终组装页，检查知识覆盖、事实准确、教学叙事、封面冲击力、跨页一致性、重复素材、布局冲突和儿童可读性。
每个问题必须定位到真实 slideId；知识或事实问题必须引用真实 sourceChunkIds，并把 repairDomain 标为 KNOWLEDGE、ASSET 或 LAYOUT。不得虚构引用。`,
      user: content,
      toolName: 'submit_deck_review',
      description: '提交整套课件质量评分和可执行问题清单。',
      schema: deckReviewDraftSchema,
      idempotencyKey: input.idempotencyKey,
    })
  }

  async plan(input: Parameters<RevisionPlanningPort['plan']>[0]) {
    return this.request({
      model: this.dependencies.textModel,
      system: `你是课件修订规划器。只处理审查发现的问题，不得扩大范围。
KNOWLEDGE 使用 UPDATE_CONTENT，ASSET 使用 REGENERATE_IMAGE，LAYOUT 使用 RELAYOUT。V3 的 REGENERATE_IMAGE 必须填写 targetElementId，确保只重做目标素材并保持其他元素不变。`,
      user: boundedJson(input),
      toolName: 'submit_revision_plan',
      description: '提交严格限定范围的课件修订计划。',
      schema: revisionPlanDraftSchema,
      idempotencyKey: input.idempotencyKey,
    })
  }

  async apply(input: Parameters<RevisionApplicationPort['apply']>[0]) {
    return this.request({
      model: this.dependencies.textModel,
      system: `你是课件蓝图修订执行器。严格按 revision plan 返回完整 BlueprintDraft。
未被操作命中的页面和元素必须逐字逐字段保持不变；REGENERATE_IMAGE 只能更新目标元素的提示词，RELAYOUT 不得触发重新出图，UPDATE_CONTENT 必须有教材来源。`,
      user: boundedJson(input),
      toolName: 'submit_revised_blueprint',
      description: '提交按计划局部修改后的完整课件蓝图。',
      schema: blueprintDraftSchema,
      idempotencyKey: input.idempotencyKey,
    })
  }

  private async imageContent(tenantId: string, artifactId: string) {
    const artifact = await this.dependencies.artifacts.get({ tenantId, artifactId })
    if (!artifact || !artifact.mimeType.startsWith('image/') || artifact.bytes.length === 0) {
      throw new Error('REVIEW_ARTIFACT_NOT_FOUND')
    }
    const jpeg = await sharp(artifact.bytes)
      .rotate()
      .resize({ width: 1_600, height: 1_600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#F3F6F9' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer()
    return { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'auto' as const } }
  }

  private async sourceImageContent(asset: NonNullable<Parameters<StructuredModelPort['execute']>[0]['sourceAssets']>[number]) {
    const jpeg = await sharp(asset.bytes)
      .rotate()
      .resize({ width: 1_600, height: 1_600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#F3F6F9' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer()
    return { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'auto' as const } }
  }

  private async request<T extends z.ZodType>(input: Readonly<{
    model: string
    system: string
    user: ToolContent
    toolName: string
    description: string
    schema: T
    idempotencyKey: string
    requireLayeredBaseImage?: boolean
  }>): Promise<z.output<T>> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.dependencies.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }],
          tools: [{
            type: 'function',
            function: {
              name: input.toolName,
              description: input.description,
              strict: false,
              parameters: input.requireLayeredBaseImage
                ? requireLayeredBaseImage(jsonSchema(input.schema))
                : jsonSchema(input.schema),
            },
          }],
          tool_choice: { type: 'function', function: { name: input.toolName } },
          parallel_tool_calls: false,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(180_000),
      })
    } catch (error) {
      const timeout = error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)
      throw new StructuredModelError(
        timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        true,
        input.model,
        null,
      )
    }
    const requestId = this.requestId(response)
    if (!response.ok) {
      const rejection = providerRejectionMetadata(await response.clone().json().catch(() => null))
      console.error(JSON.stringify({
        service: 'ppt-agent',
        event: 'gateway_model_rejected',
        status: response.status,
        requestId,
        model: input.model,
        ...rejection,
      }))
      const code = response.status === 429
        ? 'PROVIDER_RATE_LIMIT'
        : [408, 504].includes(response.status)
          ? 'PROVIDER_TIMEOUT'
          : 'PROVIDER_UNAVAILABLE'
      const retryable = response.status === 429 || response.status === 408 || response.status >= 500 ||
        rejection.providerType === 'upstream_error'
      throw new StructuredModelError(code, retryable, input.model, requestId)
    }
    let raw: string
    try {
      raw = response.headers.get('content-type')?.includes('application/json')
        ? completionSchema.parse(await response.json()).choices[0]!.message.tool_calls[0]!.function.arguments
        : await this.readStream(response)
    } catch (error) {
      if (error instanceof Error && ['GATEWAY_MODEL_STREAM_MISSING', 'GATEWAY_MODEL_STREAM_INCOMPLETE'].includes(error.message)) {
        throw new StructuredModelError('PROVIDER_UNAVAILABLE', true, input.model, requestId)
      }
      const code = error instanceof SyntaxError || error instanceof z.ZodError
        ? 'MODEL_JSON_INVALID'
        : 'PROVIDER_UNAVAILABLE'
      throw new StructuredModelError(code, true, input.model, requestId)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new StructuredModelError('MODEL_JSON_INVALID', true, input.model, requestId)
    }
    return input.schema.parse(parsed)
  }

  private requestId(response: Response) {
    const value = response.headers.get('x-request-id') ?? response.headers.get('request-id')
    return value && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : null
  }

  private async readStream(response: Response) {
    if (!response.body) throw new Error('GATEWAY_MODEL_STREAM_MISSING')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let argumentsText = ''
    let terminal = false
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          if (data === '[DONE]') { terminal = true; continue }
          const chunk = streamChunkSchema.parse(JSON.parse(data))
          for (const choice of chunk.choices) {
            if (choice.finish_reason) terminal = true
            for (const call of choice.delta.tool_calls ?? []) argumentsText += call.function?.arguments ?? ''
          }
        }
      }
      if (done) break
    }
    if (!terminal || !argumentsText.trim()) throw new Error('GATEWAY_MODEL_STREAM_INCOMPLETE')
    return argumentsText
  }
}

# ADR-013：DeepSeek V4 Flash 作为 V4 语义文本模型

## 状态

Proposed

## 日期

2026-08-07

## 背景

PPT-Agent V4 需要模型生成创意文稿、审查文稿和可见文案，但程序仍应确定性拥有
Run/Step ID、页码、角色、来源引用、预算、状态、哈希和交付身份。当前 Chain-4 将这种
“可可靠编译的语义输出”硬编码为 `RESPONSES_JSON_SCHEMA`，使模型的业务能力与其网络
协议实现不必要地耦合。

DeepSeek 官方文档确认 `deepseek-v4-flash` 支持 OpenAI 兼容 Chat、Responses API、
Responses SSE 和 `text.format` JSON Schema。官方同时说明 `deepseek-v4-pro` 当前不支持
Responses API。本决策只引入 Flash，不引入 Pro。

本仓库的通用 `GatewayCoursewareModel` 已经具备与 DeepSeek Flash 对齐的 Responses JSON
Schema 请求和 SSE 读取能力；当前缺口是模型能力注册、来源图片边界、网关公开合同、Run
快照和验收，而不是另写一套直接 Provider SDK。

## 决策

### 1. 模型范围

- 新增的唯一 DeepSeek V4 模型为 `deepseek-v4-flash`。
- `deepseek-v4-pro` 不进入 PPT-Agent V4 白名单、Quick-deck evaluator 白名单或 fallback
  白名单。
- PPT-Agent 不持有 DeepSeek API Key，不直连 `api.deepseek.com`；全部请求继续通过
  `MODEL_GATEWAY_BASE_URL` 和统一网关 Text Key。

### 2. 统一的是语义合同，不是 HTTP 协议

新增内部能力合同。模型适配器必须声明实际能力，而不是由 Chain-4 猜测其协议：

```ts
type SemanticModelCapability = Readonly<{
  model: string
  transport: 'RESPONSES' | 'CHAT_COMPLETIONS'
  structuredOutput: 'JSON_SCHEMA' | 'FUNCTION' | 'JSON_OBJECT'
  streaming: 'RESPONSES_TYPED_SSE' | 'CHAT_SSE'
  terminalEvents: readonly string[]
  acceptsText: true
  acceptsImages: boolean
  published: boolean
}>
```

`deepseek-v4-flash` 的首个注册值为：

```ts
{
  model: 'deepseek-v4-flash',
  transport: 'RESPONSES',
  structuredOutput: 'JSON_SCHEMA',
  streaming: 'RESPONSES_TYPED_SSE',
  terminalEvents: ['response.completed', 'response.incomplete', 'response.failed'],
  acceptsText: true,
  acceptsImages: false,
  published: false,
}
```

Chain-4 的前置条件改为 `SEMANTIC_JSON_SCHEMA` 能力，而不是把网络传输名称当作业务能力。
现有 GPT-5.6 Terra 和 DeepSeek Flash 都可以通过其各自的 Responses JSON Schema 适配器满足
该能力；未来仅支持 Chat JSON/strict tool 的模型可通过另一个适配器满足同一语义合同。

### 3. DeepSeek Flash 适配器

第一版不创建直连 DeepSeek SDK。新增 `DEEPSEEK_V4_FLASH` profile 或等价的 capability
registry 条目，复用 `GatewayCoursewareModel.requestResponsesJsonSchema()`：

- 请求端点：统一网关的 `/v1/responses`。
- 请求格式：`input`、`text.format.type = json_schema`、`strict = true`、`stream = true`。
- 响应解析：只接收 `response.output_text.delta`、`response.output_text.done` 和最终
  `response.completed`；`response.incomplete`、`response.failed` 和直接 EOF 都失败关闭。
- 得到的 JSON 必须经过现有 Zod schema 校验，随后交给 `ManuscriptCompiler`。
- 语义载荷不合法时最多执行一次内容槽位补全；不得把完整 Blueprint、Run 状态或业务 Patch
  回传给模型修复。

DeepSeek Flash 官方的 Responses SSE 不使用 `data: [DONE]`。现有 Responses 文本流读取器已以
`response.completed` 为完成条件；新增回归必须锁定此语义，避免将 Chat SSE 终止规则套用到
Responses。

### 4. 文本与视觉职责分离

DeepSeek Flash 在 V4 中只承担纯文本语义阶段：

- 创意文稿和审查文稿。
- 来源文本的摘要、叙事、用户可见文案、事实表述和视觉说明。

它不接收来源图片、文件图片、`input_image` 或视觉审查输入。来源包含图像时，系统必须：

1. 使用冻结的 Vision 模型（首期为 `gpt-5.6-terra`）提取受信的文字证据；
2. 将该证据连同来源 ID、哈希和窗口信息交给 DeepSeek Flash；
3. 由程序继续验证引用、页码和控制字段。

如果没有冻结的 Vision 能力，图片来源的 V4 Run 在任何计费调用前以稳定错误码失败。不得把
图片占位文字静默发送给 DeepSeek，也不得改用未冻结模型。

### 5. 公开能力、模型快照与回退

- `GET /v1/capabilities` 应只在模型已发布且 readiness 通过时列出 DeepSeek Flash，并标明
  `textOnly`、Responses JSON Schema 和 SSE 能力。
- 新 V4 Run 创建时冻结模型 ID、能力版本、transport、结构化输出方式、terminal event 集合和
  Vision 模型身份。历史 Run 按冻结快照恢复。
- 首期不允许 DeepSeek Flash 静默回退到 GPT 或 MiniMax。可恢复故障由显式策略决定，默认返回
  可诊断失败，避免调用方以为始终由同一模型生成。
- Quick-deck 仅在使用独立 evaluator Text Key、网关已发布且该 Key 的 `/v1/models` 明确列出
  Flash 时才允许选择 Flash。

## 接口影响

现有 `/v1/runs`、Quick-deck 和 SSE 资源路径不新增版本。新增字段必须是可选、追加式字段：

```ts
type PublicTextModelCapability = Readonly<{
  model: string
  modalities: readonly ['TEXT']
  structuredOutput: readonly ['JSON_SCHEMA']
  streaming: 'RESPONSES_TYPED_SSE'
  published: boolean
  readiness: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE'
}>
```

公开接口不返回 DeepSeek 账号、上游 URL、Key、路由权重、原始 Prompt 或 Responses 原文。内部
审计只保存脱敏 request ID、模型、能力版本、协议和安全错误码。

## 实施顺序

1. Model-Gateway：为 `deepseek-v4-flash` 增加并验证 `/v1/responses` 的 JSON Schema/SSE
   合同；更新 OpenAPI 和模型能力声明，不公开 Pro Responses。
2. PPT-Agent：引入模型能力 registry，将 Chain-4 前置条件从协议名改为语义能力。
3. PPT-Agent：注册 DeepSeek Flash profile，保持视觉模型独立，并实现图片来源的 Vision
   证据桥接或失败关闭。
4. PPT-Agent：将 capability、Run snapshot、Quick-deck evaluator 和错误码纳入公共合同与
   OpenAPI/Zod parity。
5. 先完成 Mock/契约测试，再在隔离 evaluator 凭据下执行一次 DeepSeek Flash 文本 Responses
   JSON Schema SSE 和 1 页 V4 真实验收；未通过前不发布给正式新 Run。

## 验收标准

- `deepseek-v4-flash` 的 Responses JSON Schema 流能够输出并通过 CreativeManuscript 与
  ReviewManuscript 的 Zod 校验。
- SSE 使用 `response.completed` 正常结束；`response.incomplete`、`response.failed` 和无终态
  EOF 都产生稳定失败码。
- DeepSeek Flash 不会收到任何图片输入；带图片来源的请求要么经冻结 Vision 模型转换为证据，
  要么在付费调用前失败。
- `deepseek-v4-pro` 不出现在 V4、Quick-deck 或 fallback 白名单。
- 模型和能力快照在服务重启、环境变更和幂等重放后保持不变。
- 未发布或 readiness 不健康的 Flash 不进入新 Run 白名单。
- 模型适配器、OpenAPI、Zod、Mock、SSE、gateway contract 和真实隔离验收均有回归。

## 后果

- DeepSeek Flash 可以提供其文本推理和生成能力，而 PPT-Agent 仍保持一个确定性的编译与交付
  后半段。
- 未来接入 Chat-only 模型不需要篡改 ManuscriptCompiler，只需实现并验证新的语义适配器。
- 模型能力矩阵成为 Gateway 与 PPT-Agent 的共同合同，避免“模型在 `/models` 可见”被误解为
  所有协议、输入模态和任务阶段都可用。

## 关联

- [PPT-Agent #47](https://github.com/DOIT-Ben/ShanHaiEdu-PPT/issues/47)：DeepSeek Flash
  语义文本适配层的实现、测试和隔离验收。
- [Model-Gateway #77](https://github.com/DOIT-Ben/model-gateway/issues/77)：发布 Flash 的
  Responses JSON Schema / typed SSE 能力合同；此项是 #47 的外部前置条件。
- #10：全链路 Provider 能力预检。
- #41：创建时冻结 V4 模型和协议快照。
- #42：公开 capabilities 的 configured/published/readiness 口径。

# FrameFlow 对接 PPT Agent V4

本文是 FrameFlow 服务端对接 PPT Agent V4 的 HTTP 接口说明。接口实现位于统一的
`/v1` 合同中，**没有单独的 `/v4` URL**。V4 通过以下三个字段识别：

| 字段 | 固定值 |
| --- | --- |
| 产品能力 | `V4` |
| `presentationMode` | `VISUAL_DECK_V4` |
| HTTP `schemaVersion` | `"1"` |

完整机器合同见 [`docs/openapi-v1.json`](./openapi-v1.json)。本文只说明 FrameFlow 必须实现的
调用顺序和用户交互语义。

## 1. 边界与部署地址

PPT Agent 是独立服务，FrameFlow 负责用户、会话、附件、积分/预算和前端展示；PPT Agent 负责
资料理解、整套规划、逐页图片生成、页面审查、有限修订和图片型 PPTX 交付。

生产服务默认只监听回环地址 `127.0.0.1:4310`，因此应由 FrameFlow 服务端调用，不应让浏览器
直接携带服务 Token 调用。以下记法中的 `PPT_AGENT_BASE_URL` 是 FrameFlow 服务端配置，不能写死
在前端：

```text
PPT_AGENT_BASE_URL = http://127.0.0.1:4310
```

V4 交付是整页图片型 PPTX，页面元素不可独立编辑。当前 HTTP 交付接口提供 PNG 总览、PPTX 和
素材来源清单；PDF 不在当前下载接口中。

## 2. 认证和公共请求头

除健康检查外，每个请求都需要：

```http
Authorization: Bearer <PPT_AGENT_API_TOKEN>
X-PPT-Agent-Tenant: frameflow
X-PPT-Agent-User: <externalUserId>
X-PPT-Agent-Project: <externalProjectId>       # 可选
```

管理员动作使用租户独立的管理员 Token。不要把管理员 Token 发给浏览器：

```http
Authorization: Bearer <PPT_AGENT_ADMIN_API_TOKEN>
X-PPT-Agent-Tenant: frameflow
X-PPT-Agent-User: <externalUserId>
```

请求体中的 `host` 必须与认证上下文一致；不能通过请求体把普通用户提升为管理员。建议由
FrameFlow 服务端统一生成 `host`，不要让客户端直接提交租户和用户身份。

可选的 `X-Request-ID` 会原样用于错误关联；没有提供时 Agent 会生成一个安全的请求 ID。

## 3. 标准调用链

```text
POST /v1/runs
        |
        |  PLANNING（V4 四个持久化阶段）
        v
GET  /v1/runs/{runId}
GET  /v1/runs/{runId}/events/history 或 GET /v1/runs/{runId}/events（SSE）
        |
        |  AWAITING_BLUEPRINT_APPROVAL
        |  FrameFlow 展示 generationPlan，用户确认
        v
POST /v1/runs/{runId}/actions  { type: "APPROVE_BLUEPRINT" }
        |
        v
EXECUTING -> PAGE_REVIEW -> DECK_REVIEW -> DELIVERING -> COMPLETED
        |
        v
GET /v1/runs/{runId}
GET /v1/runs/{runId}/deliveries/{deliveryId}/content?format=pptx
```

规划、出图和审查都是异步过程。创建接口只负责创建 Run，不应等待整个 PPT 完成；FrameFlow
应使用 SSE，或按游标轮询事件历史和 Run 详情。

## 4. 创建 V4 Run

### 请求

```http
POST /v1/runs
Idempotency-Key: frameflow-ppt-20260801-user123-request456
Content-Type: application/json
```

`Idempotency-Key` 必须是稳定的业务请求键，长度 8-160，字符只能是字母、数字、`.`、`_`、`:`、`-`。
网络超时或客户端断线后，必须使用**同一个键和完全相同的请求体重放**，禁止换键提交。

下面是教材 + 设计要求的十页 V4 示例：

```json
{
  "schemaVersion": "1",
  "host": {
    "tenantId": "frameflow",
    "externalUserId": "user-123",
    "externalProjectId": "lesson-456"
  },
  "source": {
    "kind": "SOURCE_PACKAGE",
    "name": "百分数课程资料",
    "sources": [
      {
        "kind": "TEXT",
        "sourceId": "textbook",
        "name": "教材.md",
        "roleHint": "CONTENT_SOURCE",
        "text": "百分数表示一个数是另一个数的百分之几。这里放教材原文，长度至少 20 个字符。"
      },
      {
        "kind": "TEXT",
        "sourceId": "design-guide",
        "name": "设计要求.md",
        "roleHint": "DESIGN_REFERENCE",
        "text": "要求使用 16:9 画布、清晰层级、统一色彩，并让每页只表达一个主要观点。"
      }
    ]
  },
  "slideCount": 10,
  "visualDirection": "清晰、克制、适合课堂投影的视觉叙事",
  "targetAudience": "小学六年级学生",
  "presentationGoal": "让学生理解百分数的含义并能在生活情境中比较",
  "imageModel": "nano-banana-pro",
  "automationLevel": "BOUNDED_AUTO",
  "budgetUnits": 100,
  "maxRevisionRounds": 2,
  "presentationMode": "VISUAL_DECK_V4",
  "visualDeckV4": {
    "instruction": "制作一套帮助学生理解百分数的十页视觉演示",
    "sourceMode": "SOURCE_GROUNDED",
    "deckOptions": {
      "deckType": "DETAILED_DECK",
      "language": "zh-CN",
      "length": { "slideCount": 10 },
      "aspectRatio": "16:9",
      "audience": "小学六年级学生",
      "focus": "统一比较标准",
      "styleHint": "现代教育信息图与温和编辑插画结合"
    }
  }
}
```

`source` 也可以是：

- `TEXT`：FrameFlow 直接传入一段原始文字；
- `HOST_ATTACHMENT`：传入 FrameFlow 已保存的 `attachmentId`；
- `SOURCE_PACKAGE`：混合多个文字来源和附件；
- `APPROVED_PAGE_DESIGN`：传入已经审核过的逐页设计稿。V4 会把它当作高优先级设计资料完成
  来源理解和视觉规划；规划完成后会直接进入执行，不再等待一次额外的蓝图确认。

有用户资料时建议使用 `SOURCE_GROUNDED`。只有没有来源、用户明确要求开放知识生成时才使用
`OPEN_KNOWLEDGE`；此时仍应以 `TEXT` 传入用户的原始需求作为最小来源，不能发送空资料。两种模式
不要在 FrameFlow 中静默混用。

### 响应

- `201`：首次创建，响应 `{ data: PublicRun, replayed: false }`；
- `200`：同一幂等键和同一请求体的重放，响应 `{ data: PublicRun, replayed: true }`；
- `409 IDEMPOTENCY_CONFLICT`：同一幂等键绑定了不同请求。停止重试并记录错误。

创建后通常为：

```json
{
  "data": {
    "id": "run-...",
    "status": "PLANNING",
    "version": 0,
    "presentationMode": "VISUAL_DECK_V4",
    "slideCount": 10,
    "budgetUnits": 100,
    "committedBudgetUnits": 0,
    "qualityOverride": false,
    "revisionRound": 0,
    "maxRevisionRounds": 2,
    "createdAt": "2026-08-01T00:00:00.000Z",
    "updatedAt": "2026-08-01T00:00:00.000Z"
  },
  "replayed": false
}
```

管理员在后台设置的租户修订轮次（`0-4`）对之后新建的 Run 优先级更高；因此 FrameFlow 应以
响应中的 `maxRevisionRounds` 为准，不要假设请求里的值一定生效。

## 5. 用户确认页：读取完整生成规划

```http
GET /v1/runs/{runId}
```

当规划完成后，状态为 `AWAITING_BLUEPRINT_APPROVAL`，详情中的 `generationPlan` 是给用户看的
结构化规划，FrameFlow 应展示它，而不是展示内部 Prompt 或模型原始输出。其结构为：

```json
{
  "schemaVersion": "1",
  "title": "百分数课程资料",
  "summary": "这套 PPT 面向小学六年级学生，围绕统一比较标准展开，通过建立主题、提出问题、解释、比较、练习和总结完成讲述。",
  "audience": "小学六年级学生",
  "slideCount": 10,
  "aspectRatio": "16:9",
  "presentationType": "完整视觉演示",
  "flow": ["建立主题和核心问题", "逐步解释并组织来源事实", "通过应用和总结完成认知闭环"],
  "pages": [
    {
      "pageNumber": 1,
      "title": "百分数课程资料",
      "content": "本套演示要解决的核心问题",
      "visual": "以单一主视觉建立主题，保持统一留白和视觉焦点"
    }
  ],
  "style": {
    "summary": "现代教育信息图与温和编辑插画结合",
    "palette": ["#F7F8F3", "#1F5A70", "#E8A23A", "#17232B"],
    "pageCharacteristics": ["每页只承担一个主要认知任务", "整套保持统一配色、材质和光线逻辑"]
  },
  "output": {
    "format": "IMAGE_BASED_PPTX",
    "description": "每页是一张完整的 16:9 视觉页面并封装为图片型 PPTX",
    "editable": false
  }
}
```

`pages` 实际会包含 `slideCount` 个页面；上例只展示一个页面以节省篇幅。规划对应的内部四个
持久化阶段是：

1. `Source Understanding + Presentation Spec`；
2. `Deck Plan + Visual Contract`；
3. `Slide Briefs`；
4. `Final Coherence Review`。

FrameFlow 不需要也不应该重建这四个内部工件。用户确认页可以展示 `generationPlan` 的摘要、流程、
逐页标题/内容/视觉说明、风格和不可编辑提示。

## 6. 确认规划并开始付费出图

读取详情中的最新 `version` 后提交：

```http
POST /v1/runs/{runId}/actions
Idempotency-Key: frameflow-ppt-20260801-user123-run-approve-1
Content-Type: application/json
```

```json
{
  "schemaVersion": "1",
  "type": "APPROVE_BLUEPRINT",
  "expectedVersion": 1
}
```

`expectedVersion` 必须是用户确认前刚读取的 Run 版本。动作幂等键按“一次用户动作”生成并永久复用；
不能把创建 Run 的键复用于动作。

确认成功后状态进入 `EXECUTING`，Agent 会在图片 Provider 允许的并发范围内提交独立页面任务。
FrameFlow 不需要也不能自行调用 Nano Banana；图片任务的幂等、计费、轮询和断点恢复由 Agent 负责。

常用动作：

| `type` | 用途 | 允许的主要状态 |
| --- | --- | --- |
| `APPROVE_BLUEPRINT` | 确认规划并开始生成 | `AWAITING_BLUEPRINT_APPROVAL` |
| `PAUSE` / `RESUME` | 暂停或恢复 | 运行中 / `PAUSED` |
| `CANCEL` | 停止新提交 | 所有非终态 |
| `RETRY_PLANNING` | 规划失败后重试 | `NEEDS_HUMAN` |
| `RETRY_DELIVERY` | 交付失败后重试 | `NEEDS_HUMAN` |
| `APPROVE_REVISION` | 确认 Agent 生成的修订计划 | `AWAITING_REVISION_APPROVAL` |
| `SUBMIT_LIMITED_REVISION` | 用户指定单页局部修订 | `NEEDS_HUMAN` |
| `ACCEPT_WITH_OVERRIDE` | 接受仍有质量问题的结果 | `NEEDS_HUMAN`，必须确认全部开放 issue |

`ACCEPT_WITH_OVERRIDE` 必须携带当前所有开放问题的 `issueIds` 和不少于 10 个字符的原因；涉及关键
教学问题时需要管理员凭据。普通用户不能绕过这个权限检查。

## 7. 实时进度和断线恢复

### SSE

```http
GET /v1/runs/{runId}/events?after=0
Accept: text/event-stream
```

每条业务事件的 SSE 格式为：

```text
id: 12
event: generation.progress
data: {"schemaVersion":"1","id":"...","eventId":"...","runId":"run-...","sequence":12,"createdAt":"...","type":"generation.progress","payload":{...}}

```

服务可能发送 `: heartbeat` 注释，它不是业务事件。客户端按 `sequence` 去重和排序，不能按到达
时间排序。连接断开时使用最后处理的序号重连：

```http
GET /v1/runs/{runId}/events?after=12
```

也可以使用 `Last-Event-ID: 12`。不要把 `eventId` 当作游标；游标是数值 `sequence`。

### 历史事件

```http
GET /v1/runs/{runId}/events/history?after=12
```

响应为 `{ data: AgentEvent[], pagination: { nextAfter, hasMore } }`。单页最多 100 条且受大小限制；
`hasMore=true` 时先继续读取历史，再打开 SSE。

### V4 生命周期事件

V4 关键事件包括：

```text
planning.started / planning.completed
generation.started / generation.progress / generation.completed
page_review.started / page_review.completed
revision.started / revision.progress / revision.completed
deck_review.started / deck_review.completed
delivery.started / delivery.completed
run.paused / run.resumed / run.completed / run.failed / run.cancelled
```

V4 事件的 `payload` 至少包含：`stage`、`completed`、`total`、`pageNumbers`、`revisionRound`、
`maxRevisionRounds`、`budgetUnits`、`committedBudgetUnits`、`reason`、`retryable`、
`requiresUserAction` 和 `nextAction`。FrameFlow 应优先用这些字段更新进度，不要从事件文本中解析数字。

例如规划完成且等待用户确认：

```json
{
  "type": "planning.completed",
  "sequence": 8,
  "payload": {
    "presentationMode": "VISUAL_DECK_V4",
    "stage": "PLANNING",
    "completed": 4,
    "total": 4,
    "pageNumbers": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "revisionKind": null,
    "revisionRound": 0,
    "maxRevisionRounds": 2,
    "budgetUnits": 100,
    "committedBudgetUnits": 0,
    "reason": "USER_CONFIRMATION_REQUIRED",
    "retryable": null,
    "requiresUserAction": true,
    "nextAction": "APPROVE_BLUEPRINT"
  }
}
```

## 8. 状态处理规则

| 状态 | FrameFlow 行为 |
| --- | --- |
| `PLANNING` | 显示“正在理解资料和规划”，继续监听事件 |
| `AWAITING_BLUEPRINT_APPROVAL` | 展示 `generationPlan` 和费用/预算说明，等待用户确认 |
| `EXECUTING` | 显示图片生成进度；`generation.progress` 的 `completed/total` 是页面进度 |
| `PAGE_REVIEW` | 显示逐页质量检查，不要重复提交图片 |
| `DECK_REVIEW` | 显示整套连贯性检查，不要重复提交图片 |
| `AWAITING_REVISION_APPROVAL` | 展示修订摘要，等待 `APPROVE_REVISION` 或拒绝 |
| `REVISING` | 显示局部修订进度；未受影响页面不会重做 |
| `DELIVERING` | 等待 Agent 组装预览和 PPTX |
| `COMPLETED` | 展示交付下载入口 |
| `PAUSED` | 按 `resumeState` 显示可恢复状态，用户确认后发送 `RESUME` |
| `NEEDS_HUMAN` | 读取 `issues` 和最新事件的 `nextAction`；按要求重试、修订、接受或联系管理员 |
| `FAILED` / `CANCELLED` | 终止进度监听，保留错误/取消原因和已有审计记录 |

技术故障进入 `NEEDS_HUMAN` 时，不要把它当作用户质量确认。应展示机器可读的 `reason`、`retryable`
和 `nextAction`，并只重试失败阶段。未知计费或提交状态时，Agent 会保留原幂等键等待恢复；FrameFlow
不得通过换键强制重新扣费。

## 9. 交付下载

在 `COMPLETED` 详情的 `deliveries` 中读取 `id`，然后：

```http
GET /v1/runs/{runId}/deliveries/{deliveryId}/content?format=preview
GET /v1/runs/{runId}/deliveries/{deliveryId}/content?format=pptx
GET /v1/runs/{runId}/deliveries/{deliveryId}/content?format=sources
```

响应是二进制流，不是 JSON：

| `format` | Content-Type | 用途 |
| --- | --- | --- |
| `preview` | `image/png` | 整套预览图 |
| `pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | 图片型 PPTX |
| `sources` | `application/json` | 素材来源与许可清单 |

下载请求必须继续带认证和宿主身份头。FrameFlow 应使用响应的 `Content-Disposition`、`Content-Length`
和 `X-Content-Type-Options`，不要把 `artifactId` 暴露成可跨租户访问的裸路径。

## 10. 错误、预算和重试

错误统一为：

```json
{
  "error": {
    "code": "RUN_VERSION_CONFLICT",
    "message": "run version does not match expectedVersion",
    "requestId": "request-...",
    "details": {}
  }
}
```

常见 HTTP 语义：

| HTTP | 含义 | FrameFlow 处理 |
| --- | --- | --- |
| `400` | 缺少幂等键、非法 JSON、游标错误 | 修正请求，不重试原请求 |
| `401` | Token 缺失或无效 | 检查服务端凭据，不把 Token 下发浏览器 |
| `403` | 宿主不匹配或需要管理员 | 检查身份边界/切管理员流程 |
| `404` | 资源不属于当前宿主或不存在 | 按资源不存在处理，不泄漏详情 |
| `409` | 版本冲突、幂等冲突、状态前置条件不满足 | 重新 GET 最新 Run；幂等冲突不能换键盲重试 |
| `422` | 合同字段或动作不合法 | 修正字段或引导用户 |
| `429` | 限流 | 使用 `Retry-After`；保持原幂等键 |
| `500` | Agent 内部错误 | 使用 `requestId` 联系运维，避免并发重复提交 |

预算字段的语义是：

- `budgetUnits`：Run 的积分/预算上限，由 FrameFlow 在创建时传入；
- `committedBudgetUnits`：Agent 已提交或保留的媒体预算累计值；
- FrameFlow 负责把积分换算成用户可理解的价格，Agent 不返回价格字符串；
- 任务超预算会进入 `PAUSED` 或等待预算动作，不能由模型自行提高预算；
- 任何出图 POST 超时都必须用原幂等键恢复，不能以“看起来没返回”为理由再次收费。

## 11. FrameFlow 最小实现清单

- [ ] 服务端保存一个稳定的创建 `Idempotency-Key`，并在超时后原样重放。
- [ ] 只从认证上下文生成 `host`；不信任浏览器传入的租户、用户和角色。
- [ ] 创建请求使用 `presentationMode: VISUAL_DECK_V4` 和 `visualDeckV4` 配置。
- [ ] 规划完成时读取 `GET /v1/runs/{runId}`，向用户展示 `generationPlan`。
- [ ] 确认动作使用新的、稳定的动作幂等键和最新 `expectedVersion`。
- [ ] 使用事件 `sequence` 去重；断线先读 `events/history`，再从 `after` 打开 SSE。
- [ ] 不在 FrameFlow 生成 Deck Plan、Slide Brief、Visual Contract 或图片 Prompt。
- [ ] 不自行调用 Nano Banana、不轮询未知的 Provider 任务、不重复扣费。
- [ ] 对 `NEEDS_HUMAN` 显示机器可读原因和下一动作，不把所有技术错误翻译成“请人工审核”。
- [ ] 只从 `deliveries` 的受保护内容接口下载 PNG/PPTX/来源清单。

# FrameFlow 对接 PPT Agent V4

本文是 FrameFlow 服务端对接 PPT Agent V4 的 HTTP 接口说明。接口实现位于统一的
`/v1` 合同中，**没有单独的 `/v4` URL**。V4 通过以下三个字段识别：

| 字段 | 固定值 |
| --- | --- |
| 产品能力 | `V4` |
| `presentationMode` | `VISUAL_DECK_V4` |
| HTTP `schemaVersion` | `"1"` |

统一版本身份以 Run 详情的 `release` 为准，不能只看目录名、历史发布记录或模式名。健康接口
的 `version` 必须与 `release.softwareVersion` 一致：

| 字段 | 语义 |
| --- | --- |
| `softwareVersion` | PPT Agent 软件发布版本，当前为 `4.3.1` |
| `presentationMode` | 本次 Run 的能力模式，V4 固定为 `VISUAL_DECK_V4` |
| `compilerVersion` | V4 链式规划与整页图片编译器版本 |
| `contractVersion` | HTTP/SSE 数据合同版本，当前为 `"1"` |
| `gitSha` / `releaseId` | 可用于生产问题定位和发布追溯 |

完整机器合同见 [`docs/openapi-v1.json`](./openapi-v1.json)。运行中服务通过无认证
`GET /openapi/v1.json` 返回同一份 release 合同；无认证 `GET /health/live` 只表示进程存活，
`GET /health/ready` 以 `200 READY` 或 `503 NOT_READY` 表示 worker 是否可接单。两个健康响应都携带
`X-PPT-Agent-Contract-Version`，并用 `Link` 的 `rel="service-desc"` 指向合同发现 URL。宿主无关的能力与
账务端口见 [`docs/ppt-agent-v4-api.md`](./ppt-agent-v4-api.md)；本文只说明 FrameFlow 必须实现的调用顺序和
用户交互语义。

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
        |  PLANNING（V4 五个持久化阶段）
        v
GET  /v1/runs/{runId}
GET  /v1/runs/{runId}/events/history 或 GET /v1/runs/{runId}/events（SSE）
        |
        v
EXECUTING -> PAGE_REVIEW -> DECK_REVIEW -> DELIVERING -> COMPLETED
        |
        v
GET /v1/runs/{runId}
仅当 deliveryAvailability.state == AVAILABLE
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
  "imageModel": "gemini-3-pro-image-preview",
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
    "schemaVersion": "1",
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

## 5. 读取完整生成规划

```http
GET /v1/runs/{runId}
```

当规划完成后，V4 会直接进入 `EXECUTING`；详情中的 `generationPlan` 可用于向用户展示当前正在
执行的结构化规划，而不是展示内部 Prompt 或模型原始输出。其结构为：

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

`pages` 实际会包含 `slideCount` 个页面；上例只展示一个页面以节省篇幅。规划对应的内部五个
持久化阶段是：

1. `Source Understanding + Presentation Spec`；
2. `Deck Plan + Visual Contract` 初稿；
3. `Reflect-and-Revise Deck/Visual`；
4. `Slide Briefs` 初稿；
5. `Reflect-and-Revise Slide Briefs`。

旧 Final Coherence 调用已由第五阶段替换。每个质量节点只执行一次 Critic；只有发现问题时才执行一次
Optimizer，模型不会拥有 Hash、冻结字段或完整候选的写权限，也不会逐页请求文本模型。
FrameFlow 不需要也不应该重建或解释这五个内部工件。可在生成进度中展示 `generationPlan` 的摘要、流程、
逐页标题/内容/视觉说明、风格和不可编辑提示。

## 6. 自动开始付费出图

V4 的五个规划阶段完成后，Agent 自动冻结规划并进入 `EXECUTING`，随后在图片 Provider 允许的
并发范围内提交独立页面任务。
FrameFlow 不需要也不能自行调用 `gemini-3-pro-image-preview`；图片任务的幂等、计费、轮询和断点恢复由 Agent 负责。

### 批次并发与统一计费

Agent 进入执行阶段时会冻结完整规划，并建立一个持久化的 `generationBatch`。当前 `gemini-3-pro-image-preview` 网关提供的是
逐页 `image-task` 操作，而不是网关原生 batch API，因此 `generationBatch.submissionMode` 固定为
`GATEWAY_INDIVIDUAL_OPERATIONS`：它是 **PPT Agent 的业务批次**，不是伪造的 Provider `batchId`。

- Agent 在受控并发上限内全量提交相互独立的页面；每页持有稳定图片幂等键，崩溃恢复不会重复出图；
- 规划完成自动进入执行时，PPT Agent 通过宿主实现的 `BatchBudgetPort` 创建一笔整单预授权/积分冻结；用户界面只展示整套预算，不展示逐页扣费；
- 页面步骤只记录本地进度与账务分摊，不能调用宿主的预授权、结算或释放接口；整笔 reservation 由持久化的批次步骤持有；
- 所有页面终态后，宿主以同一 `finalize:<batch-key>` 原子结算已收费页面并释放明确未收费余额；全完成和全未提交只是这个操作的两个特例。提交或计费未知会保留原键并进入恢复，绝不以新键重扣。

Run 详情在出图开始后会返回：

```json
{
  "generationBatch": {
    "batchId": "genbatch_...",
    "submissionMode": "GATEWAY_INDIVIDUAL_OPERATIONS",
    "pageCount": 10,
    "status": "PROCESSING",
    "accounting": {
      "estimatedUnits": 100,
      "committedUnits": 100,
      "settledUnits": 0,
      "releasedUnits": 0,
      "reconciliationUnits": 0,
      "authorization": "RESERVED",
      "settlement": "PENDING"
    },
    "progress": { "submitted": 10, "completed": 0, "failed": 0 }
  }
}
```

`pages` 中的 `promptHash` 与原始 Provider 幂等键只用于可审计恢复，不应展示给终端用户。

常用动作：

| `type` | 用途 | 允许的主要状态 |
| --- | --- | --- |
| `PAUSE` / `RESUME` | 暂停或恢复 | 运行中 / `PAUSED` |
| `CANCEL` | 停止新提交 | 所有非终态 |
| `RETRY_PLANNING` | 规划失败后重试 | `NEEDS_HUMAN` |
| `RETRY_DELIVERY` | 交付失败后重试；或恢复 4.3.0 遗留的 V4 质量耗尽 Run | `NEEDS_HUMAN`；以及满足下述硬门禁的 `FAILED(QUALITY_REMEDIATION_EXHAUSTED)` |
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

`KnownAgentEventType` 是运行时已知事件的完整集合。`run.started`、`phase.changed`、`approval.*`、
`tool.*`、`issue.*`、`budget.updated`、`run.resumed` 以及下列 V4 生命周期事件都有各自的严格
payload variant；只有不在该枚举中的未来类型才按 forward-compatible 事件忽略未知业务语义。

### V4 生命周期事件

V4 关键事件包括：

```text
planning.started / planning.completed
generation.started / generation.progress / generation.completed
generation.batch.created / generation.batch.updated
technical.recovery.started / technical.recovery.completed
page_review.started / page_review.completed
revision.started / revision.progress / revision.completed
deck_review.started / deck_review.completed
delivery.started / delivery.completed
run.paused / run.resumed / run.completed / run.failed / run.cancelled
```

V4 事件的 `payload` 至少包含：`stage`、`completed`、`total`、`pageNumbers`、`revisionRound`、
`maxRevisionRounds`、`budgetUnits`、`committedBudgetUnits`、`reason`、`retryable`、
`requiresUserAction` 和 `nextAction`。FrameFlow 应优先用这些字段更新进度，不要从事件文本中解析数字。

例如规划完成并自动进入出图：

```json
{
  "type": "planning.completed",
  "sequence": 8,
  "payload": {
    "presentationMode": "VISUAL_DECK_V4",
    "stage": "PLANNING",
    "completed": 5,
    "total": 5,
    "pageNumbers": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "revisionKind": null,
    "revisionRound": 0,
    "maxRevisionRounds": 2,
    "budgetUnits": 100,
    "committedBudgetUnits": 0,
    "reason": null,
    "retryable": null,
    "requiresUserAction": false,
    "nextAction": null
  }
}
```

## 8. 状态处理规则

| 状态 | FrameFlow 行为 |
| --- | --- |
| `PLANNING` | 显示“正在理解资料和规划”，继续监听事件 |
| `EXECUTING` | 显示图片生成进度；`generation.progress` 的 `completed/total` 是页面进度 |
| `RECOVERING` | 显示“正在自动恢复技术任务”；读取 `technicalRecovery.nextAttemptAt`，不显示用户审批按钮，也不得重新创建 Run 或更换幂等键 |
| `PAGE_REVIEW` | 显示逐页质量检查，不要重复提交图片 |
| `DECK_REVIEW` | 显示整套连贯性检查，不要重复提交图片 |
| `AWAITING_REVISION_APPROVAL` | 展示修订摘要，等待 `APPROVE_REVISION` 或拒绝 |
| `REVISING` | 显示局部修订进度；未受影响页面不会重做 |
| `DELIVERING` | 等待 Agent 组装预览和 PPTX |
| `COMPLETED` | 重新读取详情；仅当 `deliveryAvailability.state=AVAILABLE` 时展示“已生成”和下载入口，否则按稳定 `reason` 继续等待或报错 |
| `PAUSED` | 只按版本化原因处理明确的用户暂停或预算/业务门；满足相应条件后发送 `RESUME`，技术故障不得靠该状态或文案猜测 |
| `NEEDS_HUMAN` | 仅处理合同明确保留的人工业务动作；标准 V4 质量耗尽或技术故障不得依赖普通用户放行 |
| `FAILED` / `CANCELLED` | 保留稳定错误/取消原因、终态账务和已有审计记录；`FAILED` 的账务仍为 `RECONCILIATION_REQUIRED` 时继续监听。仅 4.3.0 遗留的 `FAILED(QUALITY_REMEDIATION_EXHAUSTED)` 可在硬门禁通过后用稳定动作键发送 `RETRY_DELIVERY` |

超时、限流、网关波动、已知任务的查询失败和审查服务暂时不可用，会进入 `RECOVERING`，由 Agent 在
有界退避后恢复原阶段；同一恢复阶段累计第五次失败会明确进入
`FAILED(TECHNICAL_RECOVERY_EXHAUSTED)`，不会无限重试或转成普通用户待办。`MODEL_AUTH_FAILED`、
`MODEL_FORBIDDEN` 与 `MODEL_NOT_FOUND` 等模型鉴权、权限和配置故障进入
`FAILED(TECHNICAL_CONFIGURATION_REQUIRED)`，**不产生** `approval.required`，只能由管理员修复上游配置。
图片提示、来源引用、蓝图页、返修产物或交付输入违反内部硬合同时进入
`FAILED(TECHNICAL_CONTRACT_INVALID)`；该状态同样不要求普通用户确认。FrameFlow 只能读取版本化
`run.failed.payload.errorCode`，不能匹配模型文案、`actorId` 或提示关键字。
质量反射的非法 JSON、Schema 不匹配或局部 Patch 无效不会阻断主链，而是记录跳过并沿用已经通过硬合同
校验的候选。只有提交结果未知时才允许用原反射键恢复一次，不从 Source 阶段重新提交，也不创建新 Run。
未知计费或提交状态时，Agent 会保留原幂等键等待恢复；FrameFlow 不得通过换键强制重新扣费。
`maxRevisionRounds=0` 表示不返修，不表示发现质量建议后失败。4.3.1 对非阻断质量问题保留当前图片，记录
`*_REJECTED` 和 `issue.resolved(ACCEPTED)`，继续套审与交付；来源、蓝图、图片素材、Provider、账务、
安全和文件合法性等硬问题仍然阻断。

质量处理期间账务未确定时，Run 以 `pendingTerminalFailure` 留在内部 `RECOVERING`，不会重新进入页审、
套审或用户审批。若 `run.failed` 已发出但其中 `terminalAccounting.accountingStatus` 为
`RECONCILIATION_REQUIRED`，该事件不是 SSE 关闭点；FrameFlow 必须继续监听，直到收到
`run.accounting.finalized`，并以该事件和最新 Run 详情中的 `terminalAccounting` 为最终费用事实。
Usage V2 事件被宿主以确定性 4xx 硬拒绝时也遵循该技术终态流程：管理员修复冲突后只能按原身份重投事件；
成功确认只推进账务归并，不表示 Run 恢复执行，也不允许 FrameFlow 创建新 Run、换 Key 或再次提交图片。

恢复 4.3.0 遗留质量失败时，Agent 仅在以下条件全部成立后执行 `FAILED -> DECK_REVIEW`：最近失败码确为
`QUALITY_REMEDIATION_EXHAUSTED`，本地终态账务重新归约为 `FINAL`，Usage V2（如启用）已完成且宿主确认，
活动 V4 Blueprint 合法，每页 Step 身份与受控图片 Artifact 完整一致，并且尚未创建 Delivery。条件不满足
返回 `409`，不得换动作键、新建 Run、重提图片或重复计费。

## 9. 交付下载

`COMPLETED` 只是必要条件，不是可下载信号。FrameFlow 必须同时确认：

```json
{
  "schemaVersion": "1",
  "status": "COMPLETED",
  "deliveryAvailability": {
    "state": "AVAILABLE",
    "deliveryId": "run-...:delivery:r0",
    "disposition": "FINAL",
    "identityStatus": "VERIFIED"
  },
  "deliveries": [
    {
      "schemaVersion": "1",
      "id": "run-...:delivery:r0",
      "runId": "run-...",
      "disposition": "FINAL",
      "identity": { "status": "VERIFIED" }
    }
  ]
}
```

`deliveryAvailability.deliveryId` 必须等于唯一公开 Delivery 的 `id`，且 Delivery `runId` 必须等于 Run
`data.id`。`AVAILABLE` 必须对应恰好一条 Delivery；`UNAVAILABLE` 时 `deliveries` 必须为空。不要根据
`actorId`、原因文本、`run.completed` 的显示文案或本地缓存猜测可用性。
`UNAVAILABLE` 的稳定原因包括 `RUN_NOT_COMPLETED`、`RUN_FAILED`、`RUN_CANCELLED`、
`QUALITY_RECOVERY`、`ACCOUNTING_PENDING`、`VERIFIED_FINAL_DELIVERY_MISSING`、
`DELIVERY_CONTRACT_INVALID` 和 `DELIVERY_CONTENT_INVALID`。特别是 Usage V2 已进入 `COMPLETED` 但终态
账务尚未确认时仍为 `ACCOUNTING_PENDING`，应继续轮询详情，不得显示预览或 PPTX。

门禁通过后使用 `deliveryAvailability.deliveryId` 请求：

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

下载请求必须继续带认证和宿主身份头。FrameFlow 应核对 `X-PPT-Agent-Schema-Version: 1`、
`X-PPT-Agent-Delivery-ID`、`X-PPT-Agent-Content-SHA256`、`ETag`、`Content-Disposition`、
`Content-Length` 和 `Content-Type`，不要把 `artifactId` 暴露成可跨租户访问的裸路径。若门禁或内容完整性
复核失败，接口返回 `409 DELIVERY_NOT_AVAILABLE`，`error.details.reason` 是上述稳定枚举。

## 10. 错误、预算和重试

错误统一为：

```json
{
  "schemaVersion": "1",
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
| `409` | 版本冲突、幂等冲突、状态前置条件不满足或 Delivery 不可用 | 重新 GET 最新 Run；按 `error.code/details.reason` 分支，幂等冲突不能换键盲重试 |
| `422` | 合同字段或动作不合法 | 修正字段或引导用户 |
| `429` | 限流 | 使用 `Retry-After`；保持原幂等键 |
| `500` | Agent 内部错误 | 使用 `requestId` 联系运维，避免并发重复提交 |

预算字段的语义是：

- `budgetUnits`：Run 的积分/预算上限，由宿主在创建时传入；
- `committedBudgetUnits`：Agent 已提交或保留的媒体预算累计值；
- 规划完成自动进入执行后，PPT Agent 通过 `BatchBudgetPort` 为整套初始页面执行**一次**预授权；并发页面只写本地分摊状态，不能逐页调用宿主积分接口；
- 全部页面完成后，PPT Agent 使用同一批次幂等键执行**一次**结算。`generationBatch.accounting.authorization` 与 `settlement` 公开授权、结算和恢复状态，但不公开宿主 reservationId；
- 授权或结算响应未知时，保留 `batchId`、内部 reservationId 和原幂等键进入 `RECOVERING`，不得创建第二笔预授权；
- `generationBatch.accounting` 是整单对账汇总；宿主不能将内部页面分摊映射成多次用户扣费记录；
- 任务超预算会进入 `PAUSED` 或等待预算动作，不能由模型自行提高预算；
- 任何出图 POST 超时都必须用原幂等键恢复，不能以“看起来没返回”为理由再次收费。

## 11. FrameFlow 最小实现清单

- [ ] 服务端保存一个稳定的创建 `Idempotency-Key`，并在超时后原样重放。
- [ ] 只从认证上下文生成 `host`；不信任浏览器传入的租户、用户和角色。
- [ ] 创建请求使用 `presentationMode: VISUAL_DECK_V4` 和 `visualDeckV4` 配置。
- [ ] 规划完成时读取 `GET /v1/runs/{runId}`，向用户展示 `generationPlan`。
- [ ] 使用事件 `sequence` 去重；断线先读 `events/history`，再从 `after` 打开 SSE。
- [ ] 不在 FrameFlow 生成 Deck Plan、Slide Brief、Visual Contract 或图片 Prompt。
- [ ] 不自行调用 `gemini-3-pro-image-preview`、不轮询未知的 Provider 任务、不重复扣费。
- [ ] 展示 `release` 作为唯一版本身份，记录 `gitSha` 和 `releaseId` 以便问题追溯。
- [ ] 对 `RECOVERING` 显示自动恢复状态；标准 V4 的质量/技术失败按 `FAILED` 展示，不提供普通用户质量放行入口。
- [ ] 将 `generationBatch` 作为整单进度和账务汇总展示，不将内部页级 reservation 映射为多次用户扣费。
- [ ] 只在 `COMPLETED + deliveryAvailability.state=AVAILABLE` 时使用其 `deliveryId` 下载，并核对版本、Delivery ID 与 SHA-256 响应头。

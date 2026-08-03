# PPT Agent V4 宿主接口合同

PPT Agent V4 是独立服务。宿主只提供经认证的用户身份、源资料、预算端口和最终交付展示；资料理解、
五阶段规划、整页视觉生成、审查、修订、批次恢复和 PPTX 封装均由 Agent 负责。本文不假定任何特定
宿主项目或前端框架。

## 发布身份

| 字段 | 固定值 | 用途 |
| --- | --- | --- |
| 软件版本 | `4.3.0` | 部署与故障定位 |
| 演示模式 | `VISUAL_DECK_V4` | NotebookLM 风格整页视觉链路 |
| HTTP/SSE 合同 | `"1"` | 公共 API 数据格式 |
| V4 编译器 | `visual-deck-v4-chain-3` | 一轮 Critic/Optimizer 规划身份；旧 `chain-1/chain-2` Run 仍按持久化身份恢复 |

`GET /health/live` 与每个 Run 详情的 `release` 都必须返回这些身份字段。模式名不是软件发布版本。

## Agent HTTP API

完整机器可读定义见 [`openapi-v1.json`](./openapi-v1.json)。所有资源均在 `/v1` 下，模式由请求
中的 `presentationMode: "VISUAL_DECK_V4"` 和 `visualDeckV4` 配置选择，不存在专用 `/v4` URL。

| 操作 | API | 幂等要求 |
| --- | --- | --- |
| 创建任务 | `POST /v1/runs` | 稳定业务 `Idempotency-Key` |
| 查询规划、状态、批次和交付 | `GET /v1/runs/{runId}` | 无 |
| 实时进度 | `GET /v1/runs/{runId}/events?after={sequence}` | 按 `sequence` 断线续传 |
| 历史进度 | `GET /v1/runs/{runId}/events/history?after={sequence}` | 按 `sequence` 断线续传 |
| 下载交付 | `GET /v1/runs/{runId}/deliveries/{deliveryId}/content?format=pptx` | 无 |

除健康检查外，调用由服务端携带 Bearer 凭据和宿主身份头：

```http
Authorization: Bearer <PPT_AGENT_API_TOKEN>
X-PPT-Agent-Tenant: <tenantId>
X-PPT-Agent-User: <externalUserId>
X-PPT-Agent-Project: <externalProjectId>  # 可选
```

身份由认证层绑定，请求体的 `host` 只能与该上下文一致。浏览器不得直接持有任一服务 Token。

## 自动执行的规划

正常 V4 规划使用三次生成调用和两个质量 Critic：

```text
Source Understanding + Presentation Spec
-> Deck Plan + Visual Contract 初稿
-> Deck/Visual Critic
-> 仅发现问题时：Deck/Visual Optimizer
-> Slide Briefs 初稿
-> Slide Briefs Critic
-> 仅发现问题时：Slide Briefs Optimizer
-> 确定性 Proposal 校验和图片提示词编译
```

无质量问题时共 5 次文本调用；两个 Critic 都发现问题时最多 7 次。每个节点最多执行 1 次 Critic 和
1 次可选 Optimizer，不存在 Critic repair、Optimizer repair 或第三轮业务调用。Critic 只返回问题，
Optimizer 只返回被授权字段的局部新值；候选哈希、冻结字段、Patch 合并和确定性复验由 Agent 后端负责。

页数、连续页码、公式、来源、冻结文案和 Proposal 合法性属于程序硬校验，失败会阻断规划。审美、表达、
构图和叙事属于可降级质量反射：Critic 合同/Provider 失败或 Optimizer Patch 无效时记录
`REFLECTION_SKIPPED`，沿用反射前已验证方案继续出图，不进入五轮技术恢复，也不伪造“已通过”。
请求结果未知时，同一业务调用最多用同一输入、协议和 Idempotency-Key 恢复 1 次。内部问题、候选哈希、
Slide Brief 和模型原始输出不属于宿主公共 UI 合同。

V4 规划完成后自动进入 `EXECUTING`。详情中的 `generationPlan` 是生成进度页的唯一内容源，宿主应
展示标题、受众、页数、叙事流程、每页标题/内容/视觉说明、整体风格与“整页图片型 PPTX，不可编辑”的
输出说明；不得展示模型原始提示词、内部 Slide Brief 或 Provider 请求。

Agent 冻结规划，并自行向视觉 Provider 受控并发提交页面。宿主不得自行提交页面图片任务，
也不得从事件文案推断状态；应使用详情的状态字段和 SSE 的结构化 payload。

## 图片生成与自动返修

V4 初始页面仍使用 Run 请求中的图片模型（生产默认 Nano Banana）整页生成。页审或套审确认需要返修时，
Agent 读取该页最新一版受控 16:9 图片，并使用服务端配置
`PPT_AGENT_V4_REVISION_IMAGE_MODEL=image-2` 调用 `/images/edits` 做局部编辑；规划模型不能指定或改写
Provider 模型。该配置在 gateway 模式为必填，修改只影响尚未创建返修批次的新 Run。

每个返修页在冻结预算前生成严格 Repair Contract，绑定问题 ID、局部修改、冻结文案、事实/数量/公式、
原图 Artifact/SHA、返修模型和模式。内部图片 Key 固定为
`<runId>:slide:<page>:image:r<round>:v1:edit:<24hex>`；旧 `:rN:v1` Key 继续可读。Repair Contract、
图片 Key、原图字节和模型任一变化都会触发幂等冲突，不会静默整页重生或切回 Nano。

初稿与返修都按一张图片一个 Agent 图片单位计量，宿主仍负责把图片单位换算为积分。10 页 Run 在管理员
允许 2 轮返修时，理论最大值是 `10 + 10 + 10 = 30` 图片单位；按宿主当前 10 积分/图即为 300 积分
冻结上限。Usage V2 由宿主在 Run 级父授权内按实际操作结算，未使用部分在 Run 终态释放；PPT Agent
不硬编码用户积分价格。

若 `/images/edits` 响应丢失，`SUBMITTING/SUBMISSION_UNKNOWN` 只允许用原 Key 和持久化
`IMAGE_EDIT` 模式查询。只有网关权威返回 `NOT_SUBMITTED` 才能在后续恢复轮次用同一 Key 重提；
`SUBMITTED` 继续查询原任务，`UNKNOWN` 保持待恢复，禁止换模型、换 Key 或再次 POST。

## Usage V2 账务端口

初始 V4 出图是一个业务批次，最多 50 张独立页面并发。`generationBatch.submissionMode` 当前为
`GATEWAY_INDIVIDUAL_OPERATIONS`，表示 Provider 尚无原生批次任务，并不意味着逐页向用户扣费。

`4.3.0` 新增宿主无关的 `UsageAccountingPort`。协议由 Run 创建时的 `accountingProtocol` 冻结：

- `FRAMEFLOW_USAGE_V2`：新 V4 Run 使用 Run 级父授权、逐操作 permit、Usage 事件和终态 finalize。
- `LEGACY_RESERVATION_V1`：旧 Run 与未启用 V2 的新 Run继续使用原 reservation 合同。
- 缺少 `accountingProtocol` 的历史 Run 一律解释为 V1；运行中修改环境变量不会改变既有 Run。

### 图片操作 permit

每次真实图片 Provider 调用前，Agent 调用：

```http
POST /api/internal/ppt-agent/usage/v2/runs/{runId}/permits
Authorization: Bearer <FRAMEFLOW_INTERNAL_TOKEN>
X-PPT-Agent-User: <externalUserId>
Idempotency-Key: <providerOperationKey>
Content-Type: application/json

{
  "operationIdempotencyKey": "<providerOperationKey>",
  "pageNumber": 3,
  "revisionRound": 1,
  "model": "image-2"
}
```

permit 未明确返回 `allowed: true` 时，Agent 不调用 Provider。响应未知时保留同一个操作 Key 恢复；明确
拒绝时终止该操作，不新建 Run、换 Key 或重复提交。

### Usage 事件

Provider 接受操作后，Agent 将不可变事件写入本地 SQLite Outbox，再按 Run 内严格递增的 `sequence`
依次调用：

```http
POST /api/internal/ppt-agent/usage/v2/events
Idempotency-Key: <event.idempotencyKey>
```

- `OPERATION_OBSERVED`：每个已接受的 Provider 操作恰好一次。同步完成可直接携带最终 `CHARGED`。
- `BILLING_RESOLVED`：仅当 observed 的费用为 `UNKNOWN` 且后续得到最终收费事实时追加。
- observed 的 Key 等于 Provider operation Key；resolved 的 Key 固定为 `<operationKey>:billing-resolved`。
- 事件响应丢失时原 `eventId`、`sequence`、body 和 Header 原样重放，禁止重排或分配新身份。

固定 Provider 成本只来自服务端 `PPT_AGENT_PROVIDER_BILLING_CATALOG_JSON`，并在 Provider 调用前快照到
媒体 Step；重启或价格配置变化不得改写已经发生的操作。该目录记录 Provider 成本事实，不是用户积分价格。
新建 V2 Run 的初稿模型若缺少对应 `TEXT_TO_IMAGE/1K` 成本档案，Agent 在持久化 Run 和执行规划前返回
`USAGE_V2_PROVIDER_BILLING_PROFILE_NOT_FOUND`，不会把配置缺项包装成 permit 响应未知。

管理员对费用未知的页面执行 `MARK_CHARGED` 或 `MARK_NOT_CHARGED` 时，V2 不调用旧 reservation API：
存在已观察 Provider 操作时先以冻结成本和稳定 Key 创建 `BILLING_RESOLVED` Outbox，再归约本地批次。
两种人工裁决都必须具备 GenerationBatch、Provider operation ID 和 observed 事件；任一缺失即明确失败关闭，
不能只修改 Agent 本地账本。

宿主以确定性 4xx 明确拒绝 Usage 事件时，Agent 保留原事件，停止自动等价重试并把 Run 置为管理员处理状态。
运维列表会为该 `report_usage_v2` Step 暴露现有 `REINSPECT` 动作；宿主冲突修复后，该动作只重投原
`eventId/sequence/body/Idempotency-Key`，成功后恢复先前执行阶段，不会重新提交 Provider 图片任务。

### Run 终态 finalize

初稿批次和返修批次完成时只归约 Agent 本地进度，不调用宿主 finalize。只有 Run 在同一事务进入
`COMPLETED`、`FAILED` 或 `CANCELLED` 并创建 `finalize_usage_v2` Outbox 后，worker 才调用：

```http
POST /api/internal/ppt-agent/usage/v2/runs/{runId}/finalize
Idempotency-Key: finalize:{runId}
```

`SETTLED` 与 `CAP_EXCEEDED` 结束 Outbox；`RECONCILING` 保持可恢复；`REVIEW_REQUIRED` 与
`LEGACY_RECONCILIATION` 保存宿主账单并停止自动等价重试。网络结果未知时只用同一个
`finalize:{runId}` 恢复。

### V1 兼容期

V1 Run 仍使用 `/credits/reservations`、`/credits/reservations/{id}/finalize` 和原有
`BatchBudgetPort`，行为不变。V2 Run 的初稿与返修整条路径不得调用这些旧端点。只要 SQLite 中仍存在
V2 Run，就不得回退到不包含 V2 恢复器的 `4.2.x` 或更早版本。
`4.3.x` 不把 V2 的页码与返修轮次计入既有 Provider Step 输入 hash，因此 `4.2.x` 已持久化的 V1
`RESERVED/SUBMITTING` 页面能够用原 Provider Key 恢复，不会在升级后产生幂等冲突。

公开 Run 详情中的 `generationBatch.accounting` 用于展示：`estimatedUnits`、`settledUnits`、
`releasedUnits`、`authorization`、`settlement` 和 `reconciliationUnits`。它不公开图片 prompt、页面幂等键
、宿主 reservation 标识、Provider 成本或内部 Usage 账单。

## 恢复与交付

网络、限流和短暂上游错误进入 `RECOVERING` 并以原幂等键重试。认证、模型权限和模型不存在属于管理员
技术处置，不会伪装成终端用户确认。用户取消会停止新的图片提交，但已经提交的 Provider 任务和批次账务
仍会在后台对账，Run 不会被重新激活。

标准 V4 Run 的消费者终态只有三类：

| Run 状态 | 宿主可依赖的结果 |
| --- | --- |
| `COMPLETED` | 存在完整性校验通过的 `FINAL` PNG 总览和图片型 PPTX |
| `FAILED` | `run.failed` 提供稳定错误码、是否可重试和终态账务投影 |
| `CANCELLED` | 停止新提交；已提交任务和批次账务继续以原幂等键对账 |

达到自动返修轮次、页审无法继续返修或历史质量 Issue 状态不一致时，V4 不再创建普通用户
`HUMAN_REVIEW` 待办。对应稳定失败码为：

- `QUALITY_REMEDIATION_EXHAUSTED`
- `QUALITY_ISSUE_STATE_INCONSISTENT`
- `TECHNICAL_RECOVERY_EXHAUSTED`
- `TECHNICAL_CONFIGURATION_REQUIRED`
- `WORKER_FATAL`

新 V4 `run.failed` 事件可携带 `terminalAccounting`：

```json
{
  "authorizedUnits": 36,
  "submittedUnits": 15,
  "settledUnits": 15,
  "releasedUnits": 21,
  "reconciliationUnits": 0,
  "accountingStatus": "FINAL"
}
```

`accountingStatus: "FINAL"` 表示授权已由 `settledUnits + releasedUnits` 完整分配；
`RECONCILIATION_REQUIRED` 表示仍有提交或计费事实待确认，宿主不得自行猜测收费结果，也不得换幂等键重建任务。
该字段对历史事件保持可选兼容。

质量返修已耗尽但账务尚未确定时，Run 会进入内部 `RECOVERING`，详情同时返回
`pendingTerminalFailure` 与最新 `terminalAccounting`；它不会回到页审/套审，也不会产生普通用户审批。
若技术失败已经先进入 `FAILED`，且其 `run.failed.terminalAccounting.accountingStatus` 为
`RECONCILIATION_REQUIRED`，SSE 必须继续监听。账务最终确定后 Agent 追加一次
`run.accounting.finalized`，Run 详情中的 `terminalAccounting` 同步变为 `FINAL`，此时消费者才关闭流。

Run 详情中的每个新交付都具有以下消费者身份：

```json
{
  "disposition": "FINAL",
  "qualityStatus": "APPROVED",
  "openIssueIds": [],
  "identity": {
    "status": "VERIFIED",
    "slideCount": 12,
    "pageNumbers": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    "blueprintHash": "<sha256>",
    "proposalHash": "<sha256>"
  },
  "preview": {},
  "pptx": {}
}
```

`COMPLETED` 只允许引用页集、修订轮次、活动 Blueprint/Proposal 哈希均匹配的 `VERIFIED FINAL` 交付。
历史交付在读取时归一化为 `identity.status: "LEGACY_UNVERIFIED"`，不会伪造旧记录中不存在的页集或哈希证据。
当前合同不产出 DRAFT；未审核页面不得冒充 FINAL。

V4 的 `ACCEPT_WITH_OVERRIDE` 仅供已认证的 `ADMIN` 内部治理使用，必须保存操作者、原因、Issue 列表和时间；
普通用户不能借此取得 FINAL 交付。质量审查或技术错误尚未完成时，宿主应按 Run 状态显示可恢复进度，
不能通过重建任务、替换幂等键或直接调用 Provider 来绕过 Agent 状态机。

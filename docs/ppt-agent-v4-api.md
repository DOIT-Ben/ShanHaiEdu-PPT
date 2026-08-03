# PPT Agent V4 宿主接口合同

PPT Agent V4 是独立服务。宿主只提供经认证的用户身份、源资料、预算端口和最终交付展示；资料理解、
五阶段规划、整页视觉生成、审查、修订、批次恢复和 PPTX 封装均由 Agent 负责。本文不假定任何特定
宿主项目或前端框架。

## 发布身份

| 字段 | 固定值 | 用途 |
| --- | --- | --- |
| 软件版本 | `4.3.1` | 部署与故障定位 |
| 演示模式 | `VISUAL_DECK_V4` | NotebookLM 风格整页视觉链路 |
| HTTP/SSE 合同 | `"1"` | 公共 API 数据格式 |
| V4 编译器 | `visual-deck-v4-chain-3` | 一轮 Critic/Optimizer 规划身份；旧 `chain-1/chain-2` Run 仍按持久化身份恢复 |

无认证 `GET /health/live` 只表示 HTTP 进程存活；无认证 `GET /health/ready` 以 `200 READY` 或
`503 NOT_READY` 表示 worker 是否可接单。两者的 `release` 返回软件版本、合同版本、Git SHA 与 release ID，
Run 详情的 `release` 另外冻结本次 Run 的模式和编译器版本。两个健康响应都携带
`X-PPT-Agent-Contract-Version: 1`，并通过 `Link: </openapi/v1.json>; rel="service-desc"` 发现机器合同。
模式名不是软件发布版本，liveness 也不能替代 readiness。

## Agent HTTP API

完整机器可读定义见 [`openapi-v1.json`](./openapi-v1.json)，运行中服务以无认证
`GET /openapi/v1.json` 返回该 release 的同一份版本化定义。业务资源均在 `/v1` 下，模式由请求中的
`presentationMode: "VISUAL_DECK_V4"` 和 `visualDeckV4` 配置选择，不存在专用 `/v4` URL。

| 操作 | API | 幂等要求 |
| --- | --- | --- |
| 合同发现 | `GET /openapi/v1.json` | 无；无需认证 |
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

Run 快照、每条 `AgentEvent`、公开 Delivery 和 JSON 错误体都携带同一个
`schemaVersion: "1"`。Run 的身份字段固定为 `data.id`；事件和 Delivery 分别使用 `runId` 指回该值。
宿主不得从 `actorId`、原因文本、工具摘要或未列入 OpenAPI 的字段推断生命周期或交付状态。
OpenAPI 的 `KnownAgentEventType` 与运行时 Zod 已知事件集合一一对应；枚举内类型必须使用各自的严格
payload variant，只有枚举外的新类型才进入 forward-compatible 分支。

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

permit 未明确返回 `allowed: true` 时，Agent 不调用 Provider。响应未知时保留同一个操作 Key 恢复；
`AUTHORIZATION_CAP_REACHED` 作为额度决策将 V4 Run 暂停为 `BUDGET_INSUFFICIENT`，宿主展示
`ADD_BUDGET`，补充额度并恢复后仍只用原操作 Key 重新取 permit。`PROVIDER_SAFETY_CAP_REACHED` 保持为
独立的 Provider 安全帽处理，不得映射成用户预算不足；两类拒绝都不得换 Key 或提交未获 permit 的任务。

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

宿主以确定性 4xx 明确拒绝 Usage 事件时，Agent 保留原事件并停止自动等价重试。V4 Run 不进入普通用户
审批：账务仍未闭环时以 `pendingTerminalFailure.errorCode=TECHNICAL_CONFIGURATION_REQUIRED` 留在
`RECOVERING`，账务闭环后发布结构化 `run.failed`。运维列表会为该 `report_usage_v2` Step 暴露现有
`REINSPECT` 动作；宿主冲突修复后，该动作只重投原 `eventId/sequence/body/Idempotency-Key`。重投成功只
归并原账务事实并继续技术终态收敛，不恢复旧执行阶段，也不会重新提交 Provider 图片任务。非 V4 Run 保留
历史的管理员处理与恢复行为。

Provider 已接受操作后，如果本地 Usage V2 的合同、媒体身份、元数据或事件一致性检查失败，媒体 Step 会
保留原 Provider operation ID、操作 Key、失败阶段、已知结果和原始诊断码，并进入同一类型化技术终态。
该路径不产生普通 `approval.required`，也不得由 worker 包装成 `WORKER_FATAL`；恢复只能查询原操作并修复
原账务身份，不能重新提交 Provider。

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
| `COMPLETED` | Run 生命周期已完成；只有详情的 `deliveryAvailability.state` 为 `AVAILABLE` 时才存在可消费交付 |
| `FAILED` | `run.failed` 提供稳定错误码、是否可重试和终态账务投影 |
| `CANCELLED` | 停止新提交；已提交任务和批次账务继续以原幂等键对账 |

Run 详情的 `qualityDisposition` 明确区分质量结果：

| `qualityDisposition` | 含义 |
| --- | --- |
| `PENDING` | 页面审查或整稿审查尚未形成最终质量结论 |
| `REVIEW_PASSED` | 页面审查和整稿审查均通过，Delivery 的 `qualityStatus` 为 `APPROVED` |
| `SYSTEM_POLICY_ACCEPTED` | 两级审查已经完成，系统仅接受了明确列入策略的非阻断建议 |
| `ADMIN_OVERRIDE` | 真实管理员通过 `ACCEPT_WITH_OVERRIDE` 接受全部开放问题 |
| `HARD_FAILURE` | Run 因硬合同、硬阻断或不可恢复技术错误失败；以 `run.failed` 为准 |

`maxRevisionRounds` 表示最多允许执行的图片返修轮次。对 `BOUNDED_AUTO`，`0` 的准确语义是“不返修”。页审结果
使用 `qualityImpact: PASS | NON_BLOCKING_RECOMMENDATION | HARD_BLOCKER` 显式分类；旧结果缺失该字段时，拒绝
默认按 `HARD_BLOCKER` 处理。页审发现明确的非阻断建议时，Run 进入 `DECK_REVIEW` 后仍保持
`qualityDisposition: PENDING`，不会提前生成系统策略审计。只有整稿审查也完成且没有硬阻断，Agent 才按固定的
`v4-non-blocking-quality-v1` 策略追加 `issue.resolved(resolution: "ACCEPTED")` 并交付当前图片版本。该路径不会
创建新图片 Step、不会增加 `committedBudgetUnits`，也不会伪造成审查通过。

整稿审查达到分数阈值但仍返回任何开放 finding 时，也不能标记为 `REVIEW_PASSED`。非阻断 finding 必须通过上述
显式系统策略形成 `SYSTEM_POLICY_ACCEPTED`；硬 finding 只能先修复或进入硬失败。

`SUPERVISED` 不适用自动质量策略。页面被拒绝且未启动自动修订时进入 `NEEDS_HUMAN` 内部审查门；普通用户不能
接受缺陷，V4 最终放行只能由已认证管理员执行 `ACCEPT_WITH_OVERRIDE`。系统策略也不得通过伪造管理员身份绕过该门。

系统策略只允许接受 `DUPLICATION`、`COVER_IMPACT`、`VISUAL_CONSISTENCY`、`COMPOSITION_CONFLICT`、
`IMAGE_QUALITY`、`ASSET_RELEVANCE`、`LAYERING_CONFLICT` 和 `CHILD_READABILITY` 的非 `CRITICAL` 建议。
任意 `CRITICAL`、任意 `repairDomain: KNOWLEDGE`，以及事实、课程覆盖、来源边界、规划、Provider、账务、安全、
媒体或文件完整性问题都是硬阻断，
不得追加 `ACCEPTED`，不得进入系统策略交付路径。对应稳定失败码包括：

- `QUALITY_REMEDIATION_EXHAUSTED`
- `QUALITY_ISSUE_STATE_INCONSISTENT`
- `TECHNICAL_RECOVERY_EXHAUSTED`
- `TECHNICAL_CONFIGURATION_REQUIRED`
- `TECHNICAL_CONTRACT_INVALID`
- `WORKER_FATAL`

`TECHNICAL_CONTRACT_INVALID` 表示图片提示、来源引用、蓝图页、返修产物或交付输入等内部硬合同不合法；
`TECHNICAL_CONFIGURATION_REQUIRED` 表示 Provider 权限、模型配置或宿主账务合同等需要运维修复的技术故障。
两者都不要求普通用户确认，消费者只按版本化 `run.failed.payload.errorCode` 分支。

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

质量处理过程中若账务尚未确定，Run 会进入内部 `RECOVERING`，详情同时返回
`pendingTerminalFailure` 与最新 `terminalAccounting`；它不会回到页审/套审，也不会产生普通用户审批。
若技术失败已经先进入 `FAILED`，且其 `run.failed.terminalAccounting.accountingStatus` 为
`RECONCILIATION_REQUIRED`，SSE 必须继续监听。账务最终确定后 Agent 追加一次
`run.accounting.finalized`，Run 详情中的 `terminalAccounting` 同步变为 `FINAL`，此时消费者才关闭流。

`4.3.0` 已产生的 `FAILED(QUALITY_REMEDIATION_EXHAUSTED)` Run 可复用现有动作合同恢复：

```http
POST /v1/runs/{runId}/actions
Idempotency-Key: <stable-action-key>
Content-Type: application/json

{"schemaVersion":"1","type":"RETRY_DELIVERY","expectedVersion":<currentVersion>}
```

Agent 仅在以下条件全部满足时执行 `FAILED -> DECK_REVIEW` 并追加 `run.resumed`：当前失败确为 V4 质量耗尽、
权威 Step 归约和 Run 投影的终态账务均为 `FINAL`、Usage V2（如启用）已由宿主确认完成、活动 V4 Blueprint
合法、每页图片 Step 的 Run/页码/版本身份一致、受控 Artifact 为同租户非空完整图片，并且尚无 Delivery。
恢复不会追加 `approval.resolved` 或提前追加 `delivery.started`，也不会创建、换 Key 或重提任何图片任务。
条件不满足时返回 `409` 并保持原 Run 不变。

Run 详情始终返回机器可判定的 `deliveryAvailability`。只有以下对象出现时，宿主才可声明“已生成”、
展示预览或请求 PPTX：

```json
{
  "state": "AVAILABLE",
  "deliveryId": "run-...:delivery:r0",
  "disposition": "FINAL",
  "identityStatus": "VERIFIED"
}
```

其余情况统一为 `{ "state": "UNAVAILABLE", "reason": "..." }`。稳定原因包括
`RUN_NOT_COMPLETED`、`RUN_FAILED`、`RUN_CANCELLED`、`QUALITY_RECOVERY`、`ACCOUNTING_PENDING`、
`VERIFIED_FINAL_DELIVERY_MISSING`、`DELIVERY_CONTRACT_INVALID` 和 `DELIVERY_CONTENT_INVALID`。
Usage V2 的 Run 即使已经进入 `COMPLETED`，在宿主终态 finalize 得到确认前仍返回
`ACCOUNTING_PENDING`；宿主应继续读取 Run 详情，不能提前暴露下载。

`deliveryAvailability.state` 为 `AVAILABLE` 时，`deliveries` 必须且只能包含一个公开交付；为
`UNAVAILABLE` 时必须为空。可用交付的 `runId` 必须等于 Run `data.id`、`id` 必须等于
`deliveryAvailability.deliveryId`，其消费者身份为：

```json
{
  "schemaVersion": "1",
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

`COMPLETED` 只允许引用页集、修订轮次、活动 Blueprint/Proposal 哈希均匹配的 `VERIFIED FINAL` 交付。V4 在写入
终态前会读回持久化 Artifact，复核 MIME、长度和 SHA-256；PNG 必须可完整解码，PPTX 必须通过 ZIP CRC、必需条目
和实际 `ppt/slides/slideN.xml` 数量校验。非空但损坏或页数不符的文件进入技术恢复，不会成为 FINAL。若 Artifact 已写入
但首次读回暂时失败，恢复会按原交付幂等键读取并复用已验证字节，只补写缺失 Artifact，不用重新渲染出的变化字节覆盖
同一身份。
历史 `LEGACY_UNVERIFIED` 交付只在持久化兼容层归一化，不会出现在公开 `deliveries` 中，也不能访问内容接口。
当前公开合同不产出 DRAFT 或未验证 Delivery；未审核页面不得冒充 FINAL。

内容接口会在每次读取时再次核对 Run/Delivery 合同以及 Artifact 的 MIME、长度和 SHA-256。成功响应携带
`X-PPT-Agent-Schema-Version`、`X-PPT-Agent-Delivery-ID`、`X-PPT-Agent-Content-SHA256` 和 `ETag`。
门禁未通过时返回 `409 DELIVERY_NOT_AVAILABLE`，并在版本化错误体的 `details.reason` 中返回上述稳定原因；
响应不会包含磁盘路径、Provider 原始响应或凭据。

当质量模型未通过但 `BOUNDED_AUTO` 返修被禁用或已耗尽，且没有硬阻断时，Delivery 的 `qualityStatus` 为
`SYSTEM_POLICY_ACCEPTED`。`qualityPolicyAudit` 保存 `provenance: "SYSTEM_POLICY"`、策略 ID、原因、被接受的
Issue 和时间；它不包含 `actorId` 或 `actorRole`。该状态表示“按非阻断策略交付当前版本”，不表示模型审查通过。
完整接受清单保留在 `issue.resolved(ACCEPTED)` 事件中；超过交付合同 50 项枚举上限时，Delivery 只保留有界
代表项和一个汇总 Issue，不丢失事件级审计事实。

V4 的 `ACCEPT_WITH_OVERRIDE` 仅供已认证的 `ADMIN` 内部治理使用，必须保存操作者、原因、Issue 列表和时间；
对应 `qualityDisposition: "ADMIN_OVERRIDE"`、Delivery `qualityStatus: "OVERRIDDEN_INTERNAL"` 和
`qualityOverrideAudit`，其中 `actorRole` 必须是真实的 `ADMIN`。普通用户不能借此取得 FINAL 交付。质量审查或
技术错误尚未完成时，宿主应按 Run 状态显示可恢复进度，
不能通过重建任务、替换幂等键或直接调用 Provider 来绕过 Agent 状态机。

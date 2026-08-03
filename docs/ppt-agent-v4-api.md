# PPT Agent V4 宿主接口合同

PPT Agent V4 是独立服务。宿主只提供经认证的用户身份、源资料、预算端口和最终交付展示；资料理解、
五阶段规划、整页视觉生成、审查、修订、批次恢复和 PPTX 封装均由 Agent 负责。本文不假定任何特定
宿主项目或前端框架。

## 发布身份

| 字段 | 固定值 | 用途 |
| --- | --- | --- |
| 软件版本 | `4.2.0` | 部署与故障定位 |
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
冻结上限。实际完成后仍按 GenerationBatch 原子结算，未使用部分释放，PPT Agent 不硬编码积分价格。

若 `/images/edits` 响应丢失，`SUBMITTING/SUBMISSION_UNKNOWN` 只允许用原 Key 和持久化
`IMAGE_EDIT` 模式查询。只有网关权威返回 `NOT_SUBMITTED` 才能在后续恢复轮次用同一 Key 重提；
`SUBMITTED` 继续查询原任务，`UNKNOWN` 保持待恢复，禁止换模型、换 Key 或再次 POST。

## 批次预算端口

初始 V4 出图是一个业务批次，最多 50 张独立页面并发。`generationBatch.submissionMode` 当前为
`GATEWAY_INDIVIDUAL_OPERATIONS`，表示 Provider 尚无原生批次任务，并不意味着逐页向用户扣费。

宿主实现的 `BatchBudgetPort` 必须提供两项幂等操作：

```ts
preflightBatchFinalization({ host })
  -> confirms atomic batch finalization support

reserveBatch({ host, model, units, batchId, idempotencyKey })
  -> { reservationId }

finalizeBatch({
  host, reservationId, batchId,
  settledUnits, releasedUnits,
  idempotencyKey: `finalize:${batchKey}`
})
```

`preflightBatchFinalization` 在任何图片提交前调用，必须明确确认宿主具备原子账务能力。`reserveBatch`
随后只调用一次。`finalizeBatch` 是一个**原子账务动作**，只能调用一次，且必须满足
`settledUnits + releasedUnits = reservedUnits`：已确认完成或已收费的页面计入 `settledUnits`，明确未收费的
页面计入 `releasedUnits`。宿主不得将它拆成“先结算再释放”两次调用。

若调用响应丢失，Agent 保留 `batchId`、`reservationId` 和同一个 `finalize:` 键进入恢复队列；不会创建
新预授权或新扣费。宿主在接入前必须支持该原子能力，否则 Agent 必须在出图前拒绝启用 V4，而不是降级为
逐页计费或对未生成页面全额扣费。

公开 Run 详情中的 `generationBatch.accounting` 用于展示：`estimatedUnits`、`settledUnits`、
`releasedUnits`、`authorization`、`settlement` 和 `reconciliationUnits`。它不公开图片 prompt、页面幂等键
或宿主 reservation 标识。

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

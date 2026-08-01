# PPT Agent V4 宿主接口合同

PPT Agent V4 是独立服务。宿主只提供经认证的用户身份、源资料、预算端口和最终交付展示；资料理解、
四阶段规划、整页视觉生成、审查、修订、批次恢复和 PPTX 封装均由 Agent 负责。本文不假定任何特定
宿主项目或前端框架。

## 发布身份

| 字段 | 固定值 | 用途 |
| --- | --- | --- |
| 软件版本 | `4.0.0` | 部署与故障定位 |
| 演示模式 | `VISUAL_DECK_V4` | NotebookLM 风格整页视觉链路 |
| HTTP/SSE 合同 | `"1"` | 公共 API 数据格式 |
| V4 编译器 | `visual-deck-v4-chain-1` | 链式规划实现身份 |

`GET /health/live` 与每个 Run 详情的 `release` 都必须返回这些身份字段。模式名不是软件发布版本。

## Agent HTTP API

完整机器可读定义见 [`openapi-v1.json`](./openapi-v1.json)。所有资源均在 `/v1` 下，模式由请求
中的 `presentationMode: "VISUAL_DECK_V4"` 和 `visualDeckV4` 配置选择，不存在专用 `/v4` URL。

| 操作 | API | 幂等要求 |
| --- | --- | --- |
| 创建任务 | `POST /v1/runs` | 稳定业务 `Idempotency-Key` |
| 查询规划、状态、批次和交付 | `GET /v1/runs/{runId}` | 无 |
| 用户确认规划 | `POST /v1/runs/{runId}/actions`，`APPROVE_BLUEPRINT` | 每次动作一把稳定键 |
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

## 用户确认的规划

当 Run 到达 `AWAITING_BLUEPRINT_APPROVAL`，详情中的 `generationPlan` 是确认页的唯一内容源。宿主应
展示标题、受众、页数、叙事流程、每页标题/内容/视觉说明、整体风格与“整页图片型 PPTX，不可编辑”的
输出说明；不得展示模型原始提示词、内部 Slide Brief 或 Provider 请求。

确认使用详情中的最新 `version`：

```json
{
  "schemaVersion": "1",
  "type": "APPROVE_BLUEPRINT",
  "expectedVersion": 7
}
```

确认后 Agent 冻结规划，并自行向视觉 Provider 受控并发提交页面。宿主不得自行提交页面图片任务，
也不得从事件文案推断状态；应使用详情的状态字段和 SSE 的结构化 payload。

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

完成后交付 PNG 总览和图片型 PPTX。质量审查或技术错误尚未完成时，宿主应按 Run 状态显示可恢复进度；
不能通过重建任务、替换幂等键或直接调用 Provider 来绕过 Agent 状态机。

# Quick-Deck 快速评测接口

Quick-deck 是用于验证 PPT Agent V4 创意规划、真实出图、像素比例和 PPTX 封装能力的隔离实验通道。它不是正式 Run 的快捷别名，也不代表质量认证或可结算交付。

## 边界

- 只接受受控 `TEXT` 资料，页数为 `1-10`，比例固定 `16:9`；原始 JSON 请求体上限为 `1 MiB`，超限返回 `413 EVALUATION_REQUEST_TOO_LARGE`。
- 每个任务只执行一次 `CreativeManuscript` Responses JSON Schema 调用，再并行提交真实异步图片任务并读取实际像素；只有全部页面为 `16:9` 才会封装 PPTX。
- 不创建 V1 Run，不写 Usage V2，不调用预算、审查、返修、自动恢复或宿主回调。
- 所有任务使用专属 SQLite、专属 artifact 根和专属 evaluator Token。过期时先删除每页图片、预览和 PPTX，再把任务公开为 `EXPIRED`。
- 评测数据不进入正式 Run/V2 备份。它只用于短期实验，不能作为恢复或对外交付来源。

## 认证

四个资源都只接受 `PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN`：

```http
Authorization: Bearer <PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN>
```

服务凭据绑定 tenant。请求不得携带 `X-PPT-Agent-Tenant`，也不需要 `X-PPT-Agent-User`、`X-PPT-Agent-Project` 或 `Idempotency-Key`。即使调用方附带相同的 `Idempotency-Key`，每一次 `POST` 都是新实验；超时重发会创建新的 `jobId`。

## 资源

| 操作 | 接口 | 说明 |
| --- | --- | --- |
| 创建实验 | `POST /v1/evaluations/quick-decks` | 返回 `201` 与独立 `jobId` |
| 查询 | `GET /v1/evaluations/quick-decks/{jobId}` | 只返回公开状态、模型、耗时、像素、比例和摘要 |
| 实时事件 | `GET /v1/evaluations/quick-decks/{jobId}/events` | SSE，以单调 `sequence` 断线续传 |
| 下载 | `GET /v1/evaluations/quick-decks/{jobId}/content?format=pptx` | 仅 `COMPLETED` 后可读；`preview` 可请求 PNG 总览 |

请求、响应和事件的机器可读定义以 [`openapi-v1.json`](./openapi-v1.json) 为准。

## 创建示例

```json
{
  "schemaVersion": "1",
  "source": {
    "kind": "TEXT",
    "name": "water-cycle.txt",
    "text": "受控测试资料，长度至少二十个字符。"
  },
  "slideCount": 3,
  "visualDirection": "清晰的自然科学信息图",
  "imageModel": "gemini-3-pro-image-preview",
  "audience": "小学高年级学生"
}
```

图片模型必须位于服务端公布的 V4 初始图片白名单内。查询结果固定返回本次实际选择的文本与图片模型、每页 `width`、`height`、`aspectRatioValidated` 和 SHA-256；不会返回 Provider URL、密钥、内部 Prompt、完整蓝图、来源正文或 artifact ID。

## 事件与内容

事件按顺序发送 `evaluation.accepted`、`planning.started`、`planning.completed`、`images.submitted`、可选 `images.progress`、`packaging.started`，最终为 `packaging.completed`、`evaluation.failed` 或 `evaluation.expired`。终态事件后 SSE 关闭。

下载接口拒绝 HTTP Range。`409 EVALUATION_CONTENT_NOT_READY` 表示仍在执行，`410 EVALUATION_CONTENT_EXPIRED` 表示 TTL 已完成清理。PPTX 和预览响应携带长度、ETag、artifact ID 和 SHA-256，服务端在开始流式传输前验证制品元数据。

## 运行配置

Quick-deck 只在主进程 `gateway` 模式配置以下变量后启用：

| 变量 | 含义 |
| --- | --- |
| `PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN` | 仅用于该评测接口的独立入站 Token |
| `PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT` | 必须位于 `PPT_AGENT_DATA_ROOT` 下的独立 SQLite/制品根 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_MODEL` | V4 文本模型白名单中的模型，默认首个 V4 文本模型 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODELS` | V4 初始图片白名单的子集，逗号分隔 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_MAX_ACTIVE_JOBS` | 每个 evaluator tenant 的并发实验数，默认 `2` |
| `PPT_AGENT_QUICK_DECK_EVALUATION_MAX_DAILY_JOBS` | 每个 evaluator tenant 的 UTC 日实验数，默认 `10` |
| `PPT_AGENT_QUICK_DECK_EVALUATION_TTL_HOURS` | 实验及其制品 TTL，默认 `24`，范围 `1-720` 小时 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_TICK_BATCH_SIZE` | 每次 worker 评测扫描数，默认 `10` |

未配置专属 Token 时，接口返回不可用，`GET /v1/capabilities` 中的 `quickDeckEvaluation.available` 为 `false`。启用、禁用或回退均不迁移正式 Run、Usage 或交付数据。

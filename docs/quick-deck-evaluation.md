# Quick-Deck 快速评测接口

Quick-deck 是用于验证 PPT Agent V4 创意规划、真实出图、像素比例和 PPTX 封装能力的隔离实验通道。它不是正式 Run 的快捷别名，也不代表质量认证或可结算交付。

## 边界

- 只接受受控 `TEXT` 资料，页数为 `1-10`，比例固定 `16:9`；原始 JSON 请求体上限为 `1 MiB`，超限返回 `413 EVALUATION_REQUEST_TOO_LARGE`。
- 每个任务只执行一次 `CreativeManuscript` Responses JSON Schema 调用，再并行提交真实异步图片任务并读取实际像素；只有全部页面为 `16:9` 才会封装 PPTX。
- 不创建 V1 Run，不写 Usage V2，不调用预算、审查、返修、自动恢复或宿主回调。
- 所有任务使用专属 SQLite、专属 artifact 根和专属 evaluator Token。过期时先删除每页图片、预览和 PPTX，再把任务公开为 `EXPIRED`。
- 评测数据不进入正式 Run/V2 备份。它只用于短期实验，不能作为恢复或对外交付来源。

## 认证

全部资源都只接受 `PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN`：

```http
Authorization: Bearer <PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN>
```

服务凭据绑定 tenant。请求不得携带 `X-PPT-Agent-Tenant`，也不需要 `X-PPT-Agent-User`、`X-PPT-Agent-Project` 或 `Idempotency-Key`。即使调用方附带相同的 `Idempotency-Key`，每一次 `POST` 都是新实验；超时重发会创建新的 `jobId`。

## 资源

| 操作 | 接口 | 说明 |
| --- | --- | --- |
| 创建实验 | `POST /v1/evaluations/quick-decks` | 返回 `201` 与独立 `jobId` |
| 查询 | `GET /v1/evaluations/quick-decks/{jobId}` | 只返回公开状态、模型、耗时、像素、比例和摘要 |
| 证据 | `GET /v1/evaluations/quick-decks/{jobId}/evidence` | 返回脱敏的请求/operation 摘要、提交/账务状态、比例诊断和创建时运行身份 |
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

文本和图片模型必须在服务端模型注册表中标记为 `evaluationEnabled=true`；它们可以尚未发布，且不会因此出现于正式 Run 的公开模型数组。查询结果固定返回本次实际选择的文本与图片模型、每页 `width`、`height`、`aspectRatioValidated` 和 SHA-256。证据资源额外返回稳定摘要形式的 Agent 请求与 operation、提交/账务状态、比例正规化诊断和创建时运行版本；不会返回 Provider URL、密钥、内部 Prompt、完整蓝图、来源正文、artifact ID、路由账号或原始 Provider 响应。

## 事件与内容

事件按顺序发送 `evaluation.accepted`、`planning.started`、`planning.completed`、`images.submitted`、可选 `images.progress`、`packaging.started`，最终为 `packaging.completed`、`evaluation.failed` 或 `evaluation.expired`。终态事件后 SSE 关闭。

下载接口拒绝 HTTP Range。`409 EVALUATION_CONTENT_NOT_READY` 表示仍在执行，`410 EVALUATION_CONTENT_EXPIRED` 表示 TTL 已完成清理。PPTX 和预览响应携带长度、ETag、artifact ID 和 SHA-256，服务端在开始流式传输前验证制品元数据。

## 运行配置

Quick-deck 只在主进程 `gateway` 模式配置以下变量后启用：

| 变量 | 含义 |
| --- | --- |
| `PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN` | 仅用于该评测接口的独立入站 Token |
| `PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT` | 必须位于 `PPT_AGENT_DATA_ROOT` 下的独立 SQLite/制品根 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_TEXT_KEY` | 仅供评测文本与视觉请求使用的独立统一网关 Key；必须与正式文本、图片 Key 均不同 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_IMAGE_KEY` | 仅供评测图片任务使用的独立统一网关 Key；必须与正式文本、图片 Key 均不同 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_MODEL` | 注册表 `evaluationEnabled=true` 的 V4 文本模型，默认首个可评测模型 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODELS` | 注册表 `evaluationEnabled=true` 的初始图片模型子集，逗号分隔 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_MAX_ACTIVE_JOBS` | 每个 evaluator tenant 的并发实验数，默认 `2` |
| `PPT_AGENT_QUICK_DECK_EVALUATION_MAX_DAILY_JOBS` | 每个 evaluator tenant 的 UTC 日实验数，默认 `10` |
| `PPT_AGENT_QUICK_DECK_EVALUATION_TTL_HOURS` | 实验及其制品 TTL，默认 `24`，范围 `1-720` 小时 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_TICK_BATCH_SIZE` | 每次 worker 评测扫描数，默认 `10` |

未配置专属 Token 时，接口返回不可用，`GET /v1/capabilities` 中的 `quickDeckEvaluation.available` 为 `false`。启用、禁用或回退均不迁移正式 Run、Usage 或交付数据。

## 真实验收

`scripts/run-quick-deck-real-evaluation.ts` 只调用回环地址的 quick-deck 资源，固定按 `1 -> 3 -> 10` 页执行受控测试；任一案例失败即停止，绝不提交后续案例。每次提交前脚本必须读取 `GET /health/ready` 并取得 `READY` 的服务端 `softwareVersion`、`gitSha` 与 `releaseId`，将其写入评测报告，而不接受调用方自报代码版本。它通过 SSE 等到终态，验证模型身份、每页实际像素与 `16:9` 比例，并重新计算 PPTX/预览 SHA-256；结果只写入显式配置的测试输出根，不写入正式 Run 或 Usage 数据。

运行时必须通过环境提供 `QUICK_DECK_EVAL_API_TOKEN`、`QUICK_DECK_EVAL_OUTPUT_ROOT`、`QUICK_DECK_EVAL_TEXT_MODEL` 和 `QUICK_DECK_EVAL_IMAGE_MODEL`。可选 `QUICK_DECK_EVAL_SERVICE_URL`（默认 `http://127.0.0.1:4311`）、`QUICK_DECK_EVAL_POLL_MS` 与 `QUICK_DECK_EVAL_TIMEOUT_MS` 仅影响本次验收。为兼容旧脚本保留的 `QUICK_DECK_EVAL_PAGE_COUNTS` 只能为精确序列 `1,3,10`；`QUICK_DECK_EVAL_CODE_VERSION` 已被拒绝，防止伪造报告身份。脚本不会输出 Token、来源正文、内部 Prompt、Provider URL 或 artifact ID。

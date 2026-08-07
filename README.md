# PPT Agent

PPT Agent 是一个宿主无关的课件智能体。它拥有自己的 Run、Step、Issue 和 Event 语义，通过版本化合同接收教材、规划页面、生成视觉素材、执行质量审查、有限修订并交付可编辑 PPTX。

演示模式包括兼容的整页生图 `SLIDE_IMAGE_V2`、增加一次结构化 Reflection 与提示词编译的 `SLIDE_IMAGE_V2_1`、素材分层可编辑的 `LAYERED_COURSEWARE_V3`，以及 NotebookLM 风格整页视觉链路 `VISUAL_DECK_V4`。V2.1 每页仍只生成一张图片，不增加图片调用次数；V4 交付不可编辑的整页图片型 PPTX。

FrameFlow 是第一个验证宿主，不是核心依赖。ShanHaiEdu 后续通过相同 API 和宿主端口接入。

## 当前阶段

- 已冻结独立产品边界、v1 HTTP/SSE 合同和宿主无关核心状态机。
- 已实现 SQLite 持久化、lease、预算/媒体幂等、教材完整性、蓝图、逐页质检、整套审查和有限修订决策。
- 已通过独立 Renderer/Artifact Port 生成 PNG 整套预览和包含可编辑文字对象的 PPTX，并提供归属隔离下载接口。
- 15 页 Mock 已从教材规划完整运行到交付，测试默认不调用真实模型或计费 Provider。
- V3 分层课件默认独立设计封面，每页输出独立底图、最多 4 个知识素材、原生文字和原生形状；跨页素材按复用键只生成一次。
- 生产 `gateway` 运行模式通过统一模型网关生成真实图片；`mock` 模式只允许测试使用。
- 模型工具调用使用严格 JSON Schema，流式工具参数按 UTF-8 累计并限制为 4 MiB；超限结果不会进入业务合同。
- 入站用户 Token、管理员 Token 与 FrameFlow 出站 Token 相互独立；角色和项目身份由认证层确定，不能由请求 body 提权。
- 创建和动作接口按 `tenantId + externalUserId` 分别限流，默认每分钟 10 次和 60 次，超限返回 `429` 与 `Retry-After`。
- Run 列表使用 SQLite Keyset 分页；宿主、状态和 Step 查询字段有显式索引，旧库只回填缺失查询列。
- RevisionPlan 可限定页面执行内容更新、重排和预算保护的局部重绘，并重新进入逐页与整套审查。
- V4 从规划、逐页生成、页级审查、局部修订、整套审查到交付均发射结构化生命周期事件；历史接口与 SSE 使用同一 `AgentEvent` 信封，并以单调 `sequence` 支持断线恢复和去重。
- 已增加参考 ShanHaiEdu 页合同的图片文字 V1 渲染与宿主锚定交付边界；正式山海 Adapter 尚未进入山海仓库。
- FrameFlow Agent API Client 与工作台已通过功能开关在生产受控启用；后续宿主继续复用同一公共合同。
- Presentation Job V2 的公共 Job、Artifact 和 Usage 边界独立于 V1。主进程配置专用 V2 Token 后，通过内部 Provider 在派生 tenant 下复用完整 `VISUAL_DECK_V4` 智能体链；未配置时只运行 V1，V2 路由返回不可用。独立 `presentation-job-v2-server` 只装配 V2 SQLite、Artifact、固定服务级预算和显式 HTTP Provider，并在发布 Artifact 前校验完整 PPTX 结构。
- Quick-deck 评测资源以独立 Token、SQLite 和 TTL 制品根验证真实 V4 创意规划、异步出图、像素比例与 PPTX 封装；它不创建 Run，不计入预算或 Usage，也不构成质量认证。

## 目录

| 路径 | 职责 |
|---|---|
| `src/contracts.ts` | 版本化公共输入、动作、快照和事件合同 |
| `src/core/` | 状态机、预算、Runner 和宿主端口 |
| `src/adapters/` | 内存、FrameFlow、ShanHaiEdu 和 Provider 适配器 |
| `tests/` | 合同、策略、恢复和宿主兼容测试 |
| `docs/decisions/` | 架构决策 |
| `docs/ppt-agent-v4-api.md` | 宿主无关的 V4 HTTP、SSE、幂等、批次账务和交付接口文档 |
| `docs/quick-deck-evaluation.md` | 隔离 quick-deck 真实评测的认证、接口、TTL 和结果边界 |
| `docs/openapi-v2.json` | 宿主无关 Presentation Job V2 HTTP 合同 |
| `docs/presentation-job-v2-changelog.md` | Presentation Job V2 兼容性、交付和 Usage 语义 |
| `docs/decisions/ADR-010-presentation-job-v2-internal-agent-provider.md` | V2 内部智能体 Provider、预算隔离和操作硬上限 |
| `docs/decisions/ADR-011-quick-deck-evaluation-isolation.md` | 快速评测的独立鉴权、数据和清理决策 |
| `docs/decisions/ADR-012-v4-image-edit-capability-gate.md` | V4 图片编辑的真实验收门禁与恢复边界 |
| `docs/frameflow-v4-integration.md` | FrameFlow 作为首个宿主的接入示例与迁移约束 |
| `docs/deployment-20260723-hardening-plan.md` | 本轮加固的发布、备份、验证与回退 runbook |
| `docs/deployment-20260723-hardening.md` | 本轮加固正式部署、备份与回退记录 |
| `docs/shanhai-v1-integration.md` | ShanHaiEdu V1 节点、身份、制品与幂等接入规范 |
| `tasks/` | 规格、计划和任务清单 |

## 本地验证

```bash
bun install --frozen-lockfile
bun run check
```

测试默认只使用 Mock Provider，不会调用真实计费模型。

## 运行配置

| 变量 | 用途 |
|---|---|
| `PPT_AGENT_TENANT_ID` | 当前服务凭据绑定的宿主租户，默认 `frameflow` |
| `PPT_AGENT_API_TOKEN` | 宿主服务端调用普通 Run API 的入站 Token |
| `PPT_AGENT_ADMIN_API_TOKEN` | 调用管理员 API 的独立入站 Token；不得与普通 Token 相同 |
| `FRAMEFLOW_INTERNAL_TOKEN` | PPT Agent 调用 FrameFlow 内部附件与预算 API 的独立出站 Token |
| `PPT_AGENT_CREATE_RUN_RATE_LIMIT_PER_MINUTE` | 每租户、每用户的 Run 创建上限，默认 `10` |
| `PPT_AGENT_RUN_ACTION_RATE_LIMIT_PER_MINUTE` | 每租户、每用户的普通及管理员动作上限，默认 `60` |
| `PPT_AGENT_WORKER_CONCURRENCY` | 同时推进的 Run 数，默认 `2`，最大 `8` |
| `PPT_AGENT_IMAGE_CONCURRENCY` | V4 整套独立页面图片任务的并发提交上限，默认 `50`，最大 `50` |
| `PPT_AGENT_REVIEW_CONCURRENCY` | 同时执行的页面视觉审查数，默认 `1`，最大 `8` |
| `PPT_AGENT_TEXT_MODEL` | 规划与修订的文本模型，默认 `gpt-5.6-terra` |
| `PPT_AGENT_VISION_MODEL` | 页面与整套质量审查的多模态模型，默认 `gpt-5.6-terra` |
| `PPT_AGENT_V4_INITIAL_IMAGE_MODELS` | 配置的初始 V4 图片候选清单，逗号分隔，默认 `gemini-3-pro-image-preview`；候选本身不等于已发布能力 |
| `PPT_AGENT_V4_MODEL_REGISTRY_JSON` | 模型的 `evaluationEnabled`、`published` 和真实验收记录；正式 Run 与公开模型数组只接受 `published=true`、未过期 `PASSED` 的记录 |
| `PPT_AGENT_V4_MODEL_AVAILABILITY_TTL_SECONDS` | 只读网关 `/models` 目录预检缓存，默认 `120` 秒；只更新 `modelAvailability`，不替代真实验收 |
| `PPT_AGENT_V4_IMAGE_EDIT_ENABLED` | V4 局部图片编辑路由开关，默认 `false`；打开后仅允许隔离验收配置，公开发布仍由模型注册表决定 |
| `PPT_AGENT_V4_REVISION_IMAGE_MODEL` | 仅在两个图片编辑路由开关均为 `true` 时的候选编辑模型；未满足发布记录时不会出现在能力接口或正式返修路径中 |
| `PPT_AGENT_V4_TEXT_TRANSPORT` | Chain-1/2/3 的 V4 文本 API，默认 `RESPONSES`；可显式设为 `CHAT_COMPLETIONS` 以恢复历史链路。Chain-4 始终要求流式 Responses JSON Schema；Chat 配置下新 Chain-4 预检会以 `V4_CHAIN4_PROTOCOL_UNSUPPORTED` 失败关闭。MiniMax Chat 仅用于统一网关内的旧链路兜底。 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN` | 启用 quick-deck 的独立 evaluator Token；不可与 V1、管理员、V2 或 FrameFlow Token 复用 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_DATA_ROOT` | 位于 `PPT_AGENT_DATA_ROOT` 内的 quick-deck SQLite/制品根；TTL 后物理删除，不进入正式备份 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_TEXT_KEY` | quick-deck 文本与视觉请求的独立统一网关 Key；必须不同于 `MODEL_GATEWAY_TEXT_KEY` 与 `MODEL_GATEWAY_IMAGE_KEY` |
| `PPT_AGENT_QUICK_DECK_EVALUATION_GATEWAY_IMAGE_KEY` | quick-deck 图片任务的独立统一网关 Key；必须不同于 `MODEL_GATEWAY_TEXT_KEY` 与 `MODEL_GATEWAY_IMAGE_KEY` |
| `PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_MODEL` / `PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODELS` | `evaluationEnabled=true` 的实际评测模型；可评测与已发布能力相互独立 |
| `PPT_AGENT_QUICK_DECK_EVALUATION_MAX_ACTIVE_JOBS` / `PPT_AGENT_QUICK_DECK_EVALUATION_MAX_DAILY_JOBS` | 每个 evaluator tenant 的并发与 UTC 日实验额度，默认 `2` / `10` |
| `PPT_AGENT_QUICK_DECK_EVALUATION_TTL_HOURS` / `PPT_AGENT_QUICK_DECK_EVALUATION_TICK_BATCH_SIZE` | 短期制品 TTL（默认 `24` 小时）和每 tick 扫描数（默认 `10`） |
| `MODEL_GATEWAY_BASE_URL` | 文本、视觉和图片模型共用的统一网关 API 根地址 |
| `MODEL_GATEWAY_TEXT_KEY` | 文本与视觉模型的网关业务 Key；启用兜底时其模型白名单必须同时包含主模型和兜底模型 |
| `MODEL_GATEWAY_IMAGE_KEY` | 图片生成与返修模型的独立网关业务 Key |
| `PPT_AGENT_FALLBACK_MODEL_ENABLED` | 是否启用统一网关内的文本与视觉兜底，默认关闭 |
| `PPT_AGENT_FALLBACK_TEXT_MODEL` / `PPT_AGENT_FALLBACK_VISION_MODEL` | 统一网关内的兜底模型 ID，默认均为 `MiniMax-M3`；MiniMax 兜底固定使用 Chat Completions |
| `PPT_AGENT_V2_TENANT_ID` | V2-only 服务凭据绑定的宿主租户；无默认值，必须显式配置 |
| `PPT_AGENT_V2_API_TOKEN` | V2 宿主服务凭据；主进程仅在配置后启用 V2，V2-only 服务始终必填；必须与 V1、管理员及宿主回调 Token 分离 |
| `PPT_AGENT_V2_HOST` / `PPT_AGENT_V2_PORT` | V2-only 监听地址，默认 `127.0.0.1:4320`，仅允许回环地址 |
| `PPT_AGENT_V2_DATA_ROOT` | V2-only SQLite 与不可变 Artifact 根目录 |
| `PPT_AGENT_V2_PROVIDER_MODE` | 主进程注入内部 Provider 时默认 `internal`；独立 V2 进程必须显式使用 `http`，`deterministic` 仅限测试 |

完整配置见 `deploy/aliyun/ppt-agent.env.example`。所有 Token 和模型密钥仅保存在权限 `600` 的服务端环境文件中，不进入仓库、请求 body 或日志。

本地启动隔离 V2 Mock/SQLite 服务：

```bash
PPT_AGENT_V2_TENANT_ID=local-host \
PPT_AGENT_V2_API_TOKEN=replace-with-local-test-token \
PPT_AGENT_V2_PROVIDER_MODE=deterministic \
bun run dev:v2
```

## 生产部署

- 发布目录：`/opt/ppt-agent/releases/<timestamp>`，当前版本由 `/opt/ppt-agent/current` 原子软链接指向。
- 持久化目录：`/opt/ppt-agent/shared/data`，环境文件为 `/opt/ppt-agent/shared/ppt-agent.env`，权限 `600`。
- `ppt-agent-backup.timer` 通过 `/opt/ppt-agent/shared/ops/backup-ppt-agent-data.mjs` 每日一致性备份 `agent.sqlite`、存在时的 `presentation-jobs-v2.sqlite` 与受控产物到 `/opt/ppt-agent/shared/data-backups`；脚本以固定 WAL 读快照分页复制 SQLite，不把整库载入 JavaScript 内存，再以流式 gzip、每个数据库的 SHA-256 和产物 SHA-256 清单压缩落盘。quick-deck 评测 SQLite 与其 TTL 制品不属于该备份集。备份前按“两份原始 SQLite 总量 + 产物 + 5 GiB 低水位”检查空间，默认保留 14 天且不受应用版本回退影响。
- 每次安装备份 unit 时必须同时把同一 release 的 `scripts/backup-ppt-agent-data.mjs` 安装到 `/opt/ppt-agent/shared/ops/backup-ppt-agent-data.mjs`；unit 以 `ExecStartPre` 明确拒绝缺失脚本，并通过 `flock` 防止并发执行。
- 恢复前先执行 `bun /opt/ppt-agent/shared/ops/backup-ppt-agent-data.mjs --verify <backup>`；该命令在权限 `0700/0600` 的临时目录流式解压，校验数据库/产物 SHA-256、SQLite 完整性和外键后删除副本。真正恢复必须另建暂存文件、复核 SHA-256、停服务后原子替换，并先备份当前生产数据；禁止原位解压覆盖生产数据库。
- 服务只监听 `127.0.0.1:4310`，由 FrameFlow 服务端调用，不经 Nginx 暴露公网。
- systemd 模板和环境示例位于 `deploy/aliyun/`。
- 2026-07-23 加固版本已发布生产；SQLite 查询列和索引迁移已在停服备份及完整性校验后完成。
- FrameFlow 必须先接受新的 `FRAMEFLOW_INTERNAL_TOKEN`；回退窗口内保留旧出站凭据兼容，避免旧版本回退后无法读取附件或结算预算。

发布、验证和数据回退条件见 `docs/deployment-20260723-hardening-plan.md`。真实计费 Provider 预检仍需单独授权，正式验收不以产生费用为前提。

回退时把 `current` 指回上一版本并重启：

```bash
systemctl restart ppt-agent
systemctl is-active ppt-agent
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4310/v1/runs)" = 401
```

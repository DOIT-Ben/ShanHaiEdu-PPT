# PPT-Agent V4 真实验收阻塞与自身缺陷

## 文档信息

- 日期：2026-08-07
- 源码基线：`main@4e855b7d789c24d525335ce512fce71db0740636`
- 软件版本：`4.4.0`
- 范围：PPT-Agent V4、Quick-deck 真实评测、统一网关适配器和公开能力口径
- 不在本文范围：Model-Gateway、NewAPI、Nginx、具体供应商渠道的修复
- 结论：文本链路可真实工作；图片链路尚不能完成可交付 PPT。主要阻塞既有上游输出问题，也有 PPT-Agent 自身合同、状态和验收工具缺陷。

## 真实流程与阻塞位置

| 阶段 | 实际结果 | 是否阻塞 | PPT-Agent 责任判断 |
|---|---|---:|---|
| 独立 evaluator 凭据 | 文本与图片凭据完成隔离，未复用正式 Key | 否 | 隔离设计有效 |
| `gpt-5.6-terra` 创意规划 | Responses JSON Schema 流式成功 | 否 | Chain-4 严格协议有效 |
| `MiniMax-M3` 旧链路 smoke | Chat Completions 流式成功，收到终止事件 | 否 | 旧链路可用，未进入 Chain-4 回退 |
| Gemini 1/3/10 页异步出图 | 重启后 14 个 operation 全部在网关侧完成 | 否 | 异步提交和轮询基本有效 |
| Gemini 图片入库 | 14 张均为 `1376x768`，被 V4 精确比例门禁拒绝 | 是 | V4 严格门禁与当前语义比例请求之间缺少共享合同，见 PA-001 |
| Quick-deck 任务收口 | 一页失败后任务立即终止，其他已提交页长期显示 `SUBMITTED` | 是 | 终态和 drain/cleanup 生命周期不完整，见 PA-003 |
| 失败报告 | 汇总只保留 `QUICK_DECK_NOT_COMPLETED` | 是 | 证据丢失，见 PA-004 |
| `gpt-image-2` 返修 | HTTP 200 后图片比例不合格 | 是 | 上游输出另行追踪；PPT-Agent 对已接受调用仍记 `UNKNOWN`，见 PA-002 |
| PPTX 封装 | 因图片未通过门禁而未开始 | 是 | 拒绝不合格图片是正确行为，但当前没有可用的近似比例正规化路径 |

### 比例事实

本轮 Gemini 图片的实际计算如下：

```text
expected = 16 / 9 = 1.7777777778
actual   = 1376 / 768 = 1.7916666667
relative error = abs(actual / expected - 1) = 0.78125%

V4 exact check:
1376 * 9 = 12384
768 * 16 = 12288
12384 != 12288
```

因此，同一张图在 PPT-Agent 自己的非 V4“允许 3% 误差”分支下可以通过，在 V4 的“整数像素严格相等”分支下必然失败。本文没有证据证明 3% 是网关的公开承诺，不能把这个内部合同差异直接归因成 Gemini 供应商故障。

## 缺陷清单

### PA-001 P0：V4 精确比例要求与现有比例请求能力不一致

**现象**

- PPT-Agent 提交 `size: "16:9"`，没有提交确定的目标像素。
- Quick-deck 检查时固定传入 `exactAspectRatio: true`。
- V4 只接受 `width * 9 === height * 16`，而同一适配器的非 V4 路径允许 3% 相对误差。
- Gemini 连续 14 张 `1376x768` 均因 0.78125% 的误差失败，导致 1/3/10 页全部无法封装。

**源码证据**

- `src/adapters/gateway-image-generation.ts:22`：PPT-Agent 非精确分支的本地容差为 `0.03`，这不是网关公开合同的证据。
- `src/adapters/gateway-image-generation.ts:79`：`exactAspectRatio` 分支改用严格检查。
- `src/adapters/gateway-image-generation.ts:191`：请求只发送比例枚举和 `1K`，没有确定像素。
- `src/core/blueprint-assets.ts:27`：V4 使用整数像素等式。
- `src/core/quick-deck-evaluation-service.ts:439`：Quick-deck 强制 `16:9 + exactAspectRatio`。

**根因**

PPT-Agent 把“语义比例请求”解释为“返回结果必须满足数学上完全相等的像素”，但当前调用只提交比例枚举和 `1K`，没有协商比例策略、目标像素或误差阈值。严格门禁本身没有错，错误在于缺少能满足门禁的生成或正规化合同。

**整改方案**

1. 与 Model-Gateway 定义共享 `ImageAspectContract`，至少包含 `requestedRatio`、`policy`、`maxRelativeError`、`targetWidth`、`targetHeight` 和 `normalizationOwner`；在共享合同落地前，不宣称本地 3% 常量代表网关承诺。
2. V4 对误差不超过明确阈值的图片执行确定性正规化，例如通过 Sharp 居中裁切/缩放到 `1600x900`；超阈值结果继续失败关闭。
3. 正规化前后都记录实际尺寸、相对误差、裁切区域和输出 SHA-256。
4. 对整页含文字图片设置安全区，避免轻微裁切破坏边缘文字；无法满足安全区时不得静默裁切。
5. `gpt-image-2` 的 `2048x2048` 相对误差远超阈值，必须继续拒绝，不能用正规化掩盖供应商合同错误。
6. 正规化必须发生在 PPTX 渲染前；当前 `src/adapters/presentation-renderer.ts:312` 会把整页图片直接拉伸到页面宽高，不能把它当作比例修复。

**验收标准**

- `1376x768` 能按明确策略正规化为精确 16:9，并完成 PPTX 封装。
- 方形、4:3、3:2 等超阈值图片仍以稳定错误码失败。
- 公开文档、OpenAPI、代码和 Model-Gateway 准则使用同一误差公式。

### PA-002 P0：同步图片编辑的“已接受”状态被错误表示为 `UNKNOWN`

**现象**

`/images/edits` 已返回 HTTP 200 和图片数据后，若图片解析或比例检查失败，适配器抛出 `MediaSubmissionError(..., "UNKNOWN", ...)`。此时可以确定请求已被接受并返回最终响应，所以“提交状态未知”在语义上不成立；但没有权威计费回执时，仍不能仅凭 HTTP 200 断言已经计费。

**源码证据**

- `src/adapters/gateway-image-generation.ts:202`：图片编辑使用最长 600 秒的同步 HTTP 请求。
- `src/adapters/gateway-image-generation.ts:236`：HTTP 200 后才解析和校验图片。
- `src/adapters/gateway-image-generation.ts:241`：校验失败仍写成 `UNKNOWN`。
- `src/core/ports.ts:170`：`MediaSubmissionError` 类型禁止表达 `SUBMITTED`，迫使实现写入错误状态。

**风险**

- Usage、恢复逻辑和人工审计无法区分“已提交但计费未知”和“是否提交也未知”。
- 上层可能把 `UNKNOWN` 当作需要幂等查询或可恢复提交，而实际上调用已经得到最终响应。
- 600 秒同步连接中断时缺少稳定 operation ID，恢复能力弱于初始异步出图。

**整改方案**

1. 图片编辑统一改为异步 `IMAGE_TASK`，提交后立即持久化 operation ID、提交状态和幂等键。
2. 扩展媒体失败结果，支持 `submissionState: SUBMITTED` 与 `billingState: CHARGED | NOT_CHARGED | UNKNOWN` 分离表达。
3. HTTP 200 后的合同错误必须至少返回 `SUBMITTED + CONTRACT/NON_RETRYABLE`；无权威账务证据时使用 `billingState: UNKNOWN`，只有账务回执确认后才能标记 `CHARGED`。
4. 未完成异步改造前，禁止对 `UNKNOWN` 自动换 Key 或重提。

**验收标准**

- 编辑请求在进程重启和网络超时后能仅凭原幂等键恢复。
- HTTP 200 后的坏图片不会被记录成 `submissionState: NOT_SUBMITTED | UNKNOWN`，计费状态则严格服从账务证据。
- Usage V2 能明确展示这类调用是否计费。

### PA-003 P1：Quick-deck 遇到首个失败后过早进入终态

**现象**

3 页和 10 页评测在并行提交后，只要当前轮询中有一页失败，整个 job 立即变成 `FAILED`。其他 operation 后续已经在网关侧完成，但 Quick-deck 页面仍保持 `SUBMITTED`，直到 TTL 到期才做 best-effort 检查。

**源码证据**

- `src/core/quick-deck-evaluation-service.ts:436`：并行检查所有当前 pending 页。
- `src/core/quick-deck-evaluation-service.ts:475`：任意页面失败立即终止 job。
- `src/core/quick-deck-evaluation-service.ts:602`：`fail()` 直接清除 `nextAttemptAt`。
- `src/core/quick-deck-evaluation-service.ts:626`：剩余 operation 只在过期流程中再次发现。
- SQLite 只有 evaluations/events 表，没有独立、持久化的 cleanup/drain 队列表。

**风险**

- 公开状态与真实网关终态不一致。
- 无法统计一次评测到底成功、失败或计费了多少页。
- 已提交任务的资源清理和审计最多延迟一个 TTL。

**整改方案**

1. 增加内部 `DRAINING` 阶段或独立 durable cleanup 表。
2. 首个失败后停止新提交，但继续用原 operation ID/幂等键检查全部已提交页，绝不重提。
3. 所有页终结或达到 drain TTL 后再固定最终审计结果。
4. 公共 job 可以尽早报告整体失败，但内部审计状态必须继续推进，并允许查询最终逐页摘要。

**验收标准**

- 部分失败后，每个已提交页最终都有 `COMPLETED | FAILED | UNKNOWN_EXPIRED`。
- 重启不会丢失 drain 工作。
- 不产生第二次 Provider 提交。

### PA-004 P1：失败报告丢失关键真实证据

**现象**

真实评测脚本失败时只写 `passed`、`slideCount` 和一个高层错误码。job ID、Agent request ID、operation ID、逐页错误、耗时、实际像素和 SSE 摘要全部丢失。本轮不得不直接读取 Quick-deck SQLite 和 media-router SQLite 才能定位问题。

**源码证据**

- `scripts/run-quick-deck-real-evaluation.ts:224`：成功路径保留完整证据。
- `scripts/run-quick-deck-real-evaluation.ts:262`：失败路径压缩为三个字段。
- 脚本只在整个 case 结束后写汇总；进程中断时可能留下空目录而没有可恢复检查点。

**整改方案**

1. 创建 job 后立即原子写入 `case-state.json`，后续每次状态变化覆盖临时文件并 rename。
2. 失败报告必须包含 job ID、脱敏 request ID、operation ID、逐页状态、错误码、尺寸和耗时。
3. 增加 `--resume <report-dir>`，仅查询现有 job，不创建新实验。
4. 默认不记录 Token、Prompt、来源正文、B64 图片或带签名 URL。

**验收标准**

- 任意阶段 `SIGTERM` 后可从报告目录恢复查询，且不会创建新 job。
- 失败报告本身足够列出合同、状态和成本的全部已知证据，并明确标注未知归因；不得承诺在 Provider lineage 缺失时必然完成供应商归因。

### PA-005 P1：失败诊断丢弃实际图片尺寸和误差

**现象**

比例错误发生在图片入库前，适配器最终只返回 `GATEWAY_IMAGE_ASPECT_RATIO_INVALID`。Quick-deck 页面的 `width`、`height` 保持 `null`，无法从公开接口判断是 0.78125% 近似误差还是 43.75% 的方形错误。

**源码证据**

- `src/adapters/gateway-image-generation.ts:84`：Sharp 已经读取到真实尺寸。
- `src/adapters/gateway-image-generation.ts:24`：错误类型没有尺寸字段。
- `src/adapters/gateway-image-generation.ts:328`：返回结果只保留错误码和技术分类。
- `src/core/quick-deck-evaluation-service.ts:450`：失败页只写 `errorCode`。

**整改方案**

- 将安全诊断扩展为 `expectedRatio`、`actualWidth`、`actualHeight`、`actualRatio`、`relativeError` 和 `ratioPolicy`。
- 公共接口可公开尺寸与误差，不公开 Provider URL、账号、Key 或内部 Prompt。
- 区分 `IMAGE_RATIO_NEAR_MISS` 与 `IMAGE_RATIO_GROSS_MISMATCH`，但二者都不得被伪装成成功。

### PA-006 P1：公开 capabilities 只反映静态配置，不反映实时可调用性

**现象**

`GET /v1/capabilities` 由环境变量和本地模型白名单生成。网关渠道禁用、模型暂时不在 evaluator `/models` 或实际调用失败时，PPT-Agent 仍可能把模型公开为可用。

**源码证据**

- `src/core/v4-model-policy.ts:34`：能力由构造时模型数组生成。
- `src/runtime/main-server-config.ts:157`：模型来自静态环境配置。
- `src/http/handler.ts:778`：handler 直接返回预构建能力对象。

**整改方案**

1. 保留稳定的“已配置能力”，另增 `availability: UNKNOWN | HEALTHY | DEGRADED | UNAVAILABLE`。
2. 使用低成本、非生成的模型目录/协议预检维护短 TTL 健康快照。
3. 新 Run 创建前执行必要预检；历史 Run 仍按冻结快照恢复。
4. 不把 `/models` 可见等同于业务生成成功，真实验收结果应形成独立 readiness 记录。

### PA-007 P1：图片编辑的“测试启用”和“已发布能力”使用同一开关

**现象**

ADR-012 要求只有真实验收通过后才开启 `PPT_AGENT_V4_IMAGE_EDIT_ENABLED`。但要做真实验收又必须打开该开关；一旦打开，capabilities 就把模型列为正式可用。测试状态与发布状态被混为一体。

**源码证据**

- `docs/decisions/ADR-012-v4-image-edit-capability-gate.md:20`：同一开关承担“验收通过后开放”语义。
- `src/runtime/main-server-config.ts:176`：开关解析出的 revision model 直接进入 `imageEditModels`。
- `src/core/v4-model-policy.ts:34`：该数组直接生成公开 capabilities。

**整改方案**

- 将 `evaluationEnabled`、`published`、`readiness` 拆开。
- evaluator 可调用未发布模型，但正式 `/v1/runs` 和公共 capabilities 只能使用 `published && readiness=PASSED` 的模型。
- readiness 记录包含验收版本、网关合同版本、时间、测试集和有效期；退化后可自动降级为 `DEGRADED`，但不得迁移历史 Run。

### PA-008 P1：真实评测默认继续扩大失败模型的后续费用

**现象**

评测脚本默认依次执行 1、3、10 页，即使前一个 case 失败也继续下一个 case。单页已经证明模型/比例合同失败后，继续提交 3 页和 10 页没有增加结论可信度，却会继续产生费用。

**源码证据**

- `scripts/run-quick-deck-real-evaluation.ts:259`：循环捕获错误后继续下一页数组合。

**整改方案**

- 默认启用 canary：1 页的协议、像素和终态全部通过后才允许 3 页；3 页通过后才允许 10 页。
- 增加显式 `--continue-after-failure`，仅在用户授权扩大真实费用时使用。
- 同一路由出现确定性合同失败后，在验收批次内熔断。

### PA-009 P2：Quick-deck 不能证明完整 V4 返修能力

**现象**

Quick-deck 按设计跳过正式 Run 的页审、整稿审查、返修、Usage V2 和自动恢复。因此它只能验证“规划 -> 初始出图 -> 封装”，不能证明 `gpt-image-2` 返修或完整 V4 Agent 能力。

**源码与决策证据**

- `docs/decisions/ADR-011-quick-deck-evaluation-isolation.md:17`：流程被明确限定为一次创意规划、异步图片和封装。
- `docs/decisions/ADR-011-quick-deck-evaluation-isolation.md:21`：明确排除审查、返修、Usage V2 和自动恢复。
- `src/core/quick-deck-evaluation-service.ts:360`：实现从创意规划直接进入初始图片提交。

**整改方案**

- 保持 Quick-deck 的隔离定位不变。
- 新增仅供验收脚本使用的正式 V4 full-chain 测试场景，通过现有 `/v1/runs` 驱动单页固定资料，覆盖页审、一次返修、恢复和交付。
- 报告必须明确标注 `QUICK_DECK` 或 `FULL_V4_RUN`，禁止把前者当作完整能力认证。

### PA-010 P2：端到端路由证据没有进入评测记录

**现象**

PPT-Agent 记录模型和 operation ID，但没有持久化脱敏的 gateway request ID、路由身份是否已知、合同版本或 Provider lineage 完整性。本轮只能跨库关联，且 Gemini operation 的下游账号和 Provider 字段为空，无法做确定供应商归因。

**源码与真实证据**

- `src/quick-deck-evaluation-contracts.ts:58`：公开页合同只包含页码、状态、尺寸、比例结果和哈希，不含 gateway request ID 或 lineage 完整性。
- `docs/decisions/ADR-011-quick-deck-evaluation-isolation.md:19`：公网隐藏 Provider 路由是刻意的正确边界，但内部评测证据没有对应替代记录。
- 2026-08-07 对 media-router SQLite 的只读快照显示，本轮 14 个已完成 Gemini operation 的 `account_id`、`provider`、`upstream_task_id` 均为 `NULL`；证据位置和 job 列表见“验收证据索引”。

**整改方案**

- 在内部评测记录中保存脱敏 request ID、gateway contract version、route identity status 和 provider evidence completeness。
- 公共 API 只返回适合下游的 request ID 与模型身份；渠道、账号等内部字段只进入受控验收报告。
- lineage 缺失时明确输出 `ROUTE_IDENTITY_UNKNOWN`，不得用当前启用渠道反推为事实。

### PA-011 P1：图片提交异常被无差别改写为 `UNKNOWN`

**现象**

Quick-deck 使用 `Promise.allSettled` 并行提交图片，但任何 rejected promise 都被统一写成 `submissionState: UNKNOWN` 和 `EVALUATION_IMAGE_SUBMISSION_UNKNOWN`。适配器原本可能已经明确给出 `NOT_SUBMITTED`、认证失败、模型不允许或其他稳定错误，这些语义在服务层被丢弃。

**源码证据**

- `src/core/quick-deck-evaluation-service.ts:380`：并行提交使用 `Promise.allSettled`。
- `src/core/quick-deck-evaluation-service.ts:392`：所有 rejection 都被改写为 `UNKNOWN`。
- `src/core/ports.ts:170`：`MediaSubmissionError` 本身携带 submission state 和技术分类。

**风险**

- 将明确未提交的请求误报为可能计费。
- cleanup 队列无法区分不需要查询的 `NOT_SUBMITTED` 与必须继续核对的 `UNKNOWN`。
- 认证、模型白名单和 Provider 故障最终都变成同一个公开错误，增加人工查库成本。

**整改方案**

- 对 rejected reason 做严格类型收窄；仅接受 `MediaSubmissionError` 的安全字段，不回显上游正文。
- 持久化真实的 `submissionState`、稳定错误码和 technical failure 分类。
- 非受信异常才回退为 `UNKNOWN + INTERNAL`。
- 增加全失败、部分失败、明确未提交和混合 unknown 的回归测试。

### PA-012 P1：真实验收脚本不核验实际运行版本和进程身份

**现象**

报告中的 `codeVersion` 完全来自调用者设置的 `QUICK_DECK_EVAL_CODE_VERSION`，脚本不会读取 `/health/live` 或 `/health/ready` 的真实 build identity，也不验证目标端口是否由预期 release 启动。本轮曾出现端口占用、重复启动报 `EADDRINUSE`，tmux 会话结束后 Bun 子进程仍残留，最终需要按 PID 手工停止。

**源码证据**

- `scripts/run-quick-deck-real-evaluation.ts:62`：只校验服务 URL 是回环地址。
- `scripts/run-quick-deck-real-evaluation.ts:76`：源码版本接受环境变量自报。
- `scripts/run-quick-deck-real-evaluation.ts:267`：未经服务端核验的版本直接写入报告。

**整改方案**

1. 发起任何计费请求前读取 health，固定并记录服务端报告的 `softwareVersion`、`gitSha`、release ID 和启动代次；同时把 `runtimeMode` 纳入健康合同。
2. 报告参数版本与服务端版本不一致时失败关闭。
3. 每次轮询检查服务启动代次；测试中发生重启时标记 `EVALUATION_ENVIRONMENT_CHANGED`，不得归因供应商稳定性。
4. 提供受控的 start/stop/doctor 脚本，验证端口 PID、工作目录、release 和进程树；停止后确认端口释放。

**验收标准**

- 报告版本只能来自服务端报告的构建身份，不能由调用者环境变量冒充；若未来需要防篡改，再另行增加签名/证明机制。
- 旧进程、错误 release 或执行中重启都会在首次付费调用前或发生时被识别。

### PA-013 P2：Quick-deck 运行文档漏写两把强制网关 Key

**现象**

源码启动 Quick-deck 时强制要求独立的 evaluator Text/Image 网关 Key，并要求它们不能与正式 Key 相同；运行文档的配置表只写了 evaluator 入站 Token，没有写这两把 Key。本轮最初因此无法直接启动真实验收。

**源码证据**

- `src/runtime/main-server-config.ts:96`：要求 evaluator 入站 Token。
- `src/runtime/main-server-config.ts:98`：同时强制要求 Text/Image 两把网关 Key。
- `src/runtime/main-server-config.ts:100`：强制与正式网关 Key 隔离。
- `docs/quick-deck-evaluation.md:59`：当前配置表缺少这两项。

**整改方案**

- 在 Quick-deck 运行文档中补充两个变量名、隔离要求、权限和创建后 `/models` 预检；现有 `deploy/aliyun/ppt-agent.env.example` 已包含变量，不重复增加，也不提供任何密钥正文。
- 启动错误返回缺失的变量名和安全修复指引，不打印 Key 或指纹原文。
- 文档契约测试校验所有 `required(env, ...)` 配置都在运行文档中出现。

## 验收证据索引

以下是 2026-08-07 本轮验收结束时的脱敏证据快照。数据库属于可丢弃测试数据，后续可能按 TTL 清理；因此本文同时固化了 job、operation 数量、尺寸和结论，不依赖未来仍能读取运行目录。

| 页数 | Quick-deck job | 图片 operation | 网关终态 | Sharp 实测像素 | PPT-Agent job 终态 | 已持久化页级错误 |
|---:|---|---:|---|---|---|---|
| 1 | `quick-deck-evaluation-064428f522f848af8fc768fa13243cb8` | 1 | 1/1 `completed` | 1/1 为 `1376x768` | `FAILED / EVALUATION_IMAGE_TASK_FAILED` | 第 1 页 `GATEWAY_IMAGE_ASPECT_RATIO_INVALID` |
| 3 | `quick-deck-evaluation-f7f0288cd04b4c8a9d9aeb095906c4d7` | 3 | 3/3 `completed` | 3/3 为 `1376x768` | `FAILED / EVALUATION_IMAGE_TASK_FAILED` | 第 1 页 `GATEWAY_IMAGE_ASPECT_RATIO_INVALID` |
| 10 | `quick-deck-evaluation-14c2080623374eddb5ae3bd7288b5a32` | 10 | 10/10 `completed` | 10/10 为 `1376x768` | `FAILED / EVALUATION_IMAGE_TASK_FAILED` | 第 4 页 `GATEWAY_IMAGE_ASPECT_RATIO_INVALID` |

只读证据位置：

- Quick-deck 状态库：`/opt/ppt-agent-test/shared/real-eval-4e855b7/data/quick-deck/evaluations.sqlite`
- 网关 operation 状态库：`/var/lib/docker/volumes/litellm-gateway_media-router-data/_data/media-router.db`
- 隔离实例日志：`/opt/ppt-agent-test/shared/real-eval-4e855b7/server.log`
- 3/10 页摘要：`/opt/ppt-agent-test/shared/real-eval-4e855b7/output/quick-deck-real-2026-08-07T07-46-06-629Z-db4faf00/summary.json`
- 源码构建目录：`/opt/ppt-agent-test/releases/20260807-151633-4e855b7-real-eval`

核验方法：从 Quick-deck job 的 `pages[].operationId` 建立 operation 集合；只读查询 media-router 的 `status` 与 `result_json`；只在内存中 Base64 解码 `data[0].b64_json` 并用 Sharp `metadata()` 读取宽高，不写出图片、不访问 Provider、不产生新请求。14 个 Gemini operation 的下游 `account_id`、`provider` 和 `upstream_task_id` 均为空，因此本文只确认统一网关 operation 完成，明确保留外部供应商归因未知。

## 不应归入 PPT-Agent 的问题

以下问题由 Model-Gateway 任务单独记录和处理，本文只保留边界：

- `gpt-image-2` 编辑请求返回 `2048x2048`，未满足请求的 `16:9`。
- multipart 请求曾因 Nginx body/proxy 临时目录权限返回 500。
- Gemini 渠道/ability 在重启前不可用、重启后恢复，具体缓存或配置生效原因需由网关侧确认。
- Gemini operation 未提供 account/provider/upstream task ID，无法下钻到具体外部供应商。
- 一次 `gpt-image-2` 初始出图在网关重启期间进入 `SUBMISSION_UNKNOWN`，该样本受并发重启污染，不能单独作为稳定性结论。

## 落地顺序

1. 先统一比例合同并实现受控正规化，解除全部 V4 图片的主阻塞。
2. 修正图片编辑的异步协议、提交状态和计费语义。
3. 增加 drain/cleanup 状态，保证部分失败后逐页终态完整。
4. 补齐失败尺寸、误差和路由证据。
5. 将 capabilities 拆成 configured、readiness 和 published 三层。
6. 保留媒体提交的真实 submission state，禁止统一压成 unknown。
7. 改造真实评测脚本为 canary、fail-fast、版本预检、增量持久化和可恢复查询。
8. 补齐 Quick-deck 强制配置文档和文档契约测试。
9. 增加正式 V4 full-chain 验收，单独证明返修与恢复能力。

## 最终验收门槛

- 1/3/10 页真实评测均能生成精确 16:9 的入库产物并完成 PPTX。
- 任意单页合同失败不会导致其他已提交页永久停留在 `SUBMITTED`。
- 真实调用失败报告无需读数据库即可还原逐页状态、尺寸、误差和计费语义。
- 图片编辑使用可恢复的异步 operation；HTTP 已接受的坏输出不会记为提交未知。
- capabilities 不再把“配置了模型”表述为“模型当前真实可用”。
- 真实报告的版本来自被测服务，执行期间发生重启会明确污染并终止该案例。
- 启动文档覆盖所有强制 evaluator 配置，且不会引导复用正式 Key。
- Quick-deck 与正式 V4 full-chain 的能力结论严格分开。

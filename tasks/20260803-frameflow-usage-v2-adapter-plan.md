# PPT Agent FrameFlow Usage V2 适配实施计划

## 1. 目标与范围

在 PPT Agent 内新增 FrameFlow Usage V2 适配能力，使新建的 `VISUAL_DECK_V4` Run 可以在服务端配置明确开启后执行以下合同：

1. Run 创建时持久化账务协议，运行中不得因配置变化在 V1/V2 间漂移。
2. 每个真实图片 Provider 操作提交前，以原 Provider 幂等键申请 operation permit。
3. Provider 接受操作后，上报不可变 `OPERATION_OBSERVED`；只有 observed 时费用为 `UNKNOWN` 的异步操作，才在费用状态最终确定后追加 `BILLING_RESOLVED`。
4. 并发页面的 Usage 事件在 Run 内使用持久化、严格递增的 sequence，并按序发送。
5. 只在 Run 进入 `COMPLETED`、`FAILED` 或 `CANCELLED` 后，以稳定键 `finalize:<runId>` 调用 Run 级 finalize；初稿批次和返修批次结束时不得提前 finalize Run。
6. 网络结果未知时保留原 permit、事件和 finalize 身份恢复，禁止换 Key、新建 Run、重复提交 Provider 或重复计费。

## 2. 验收标准

- `PPT_AGENT_FRAMEFLOW_ACCOUNTING_PROTOCOL=FRAMEFLOW_USAGE_V2` 只影响配置开启后新建的 FrameFlow V4 Run；默认值为 `LEGACY_RESERVATION_V1`。
- SQLite 重启及环境变量切换后，既有 Run 继续使用创建时持久化的协议。
- V2 Run 的媒体路径不调用 `/credits/reservations`、`/credits/reservations/{id}/finalize`；V1 回归仍调用原接口。
- permit 明确拒绝或响应未知时，Provider 提交次数为 0；恢复使用相同 operation idempotency key。
- Provider 已接受但 Usage 事件响应未知时，原 Provider operation 保留；事件使用相同 eventId、sequence、body 和 Idempotency-Key 重放。
- 10 页并发出图的 Usage 事件 sequence 严格递增、无重复；每个已接受操作恰好一条 observed；observed 已经携带最终费用时不得再生成 resolved，首次 observed 为 `UNKNOWN` 时最终恰好追加一条 resolved。
- 初稿批次完成和返修批次完成均不调用 Run finalize；Run 终态只用 `finalize:<runId>` 幂等恢复。
- V2 初稿与返修批次在完成本地预算、permit、Provider 和 Usage outbox 归约后，仍能进入页审/套审/交付；其整个路径对旧 credit reservation API 的调用次数为 0。
- 完成、失败、取消三个终态转换与 `finalize_usage_v2` outbox 的创建处于同一仓库事务；事务提交后崩溃并重启仍能发现并恢复。
- 外部响应全部经严格 Zod Schema 校验；认证信息、宿主 reservation、Provider 成本细节不进入公共 Run API 或日志。
- 定向单元、HTTP 合同、SQLite 恢复、并发集成和旧账务回归通过，随后全量 `bun test`、`bun run typecheck`、`bun run build` 通过。

## 3. 实现方案

### 3.1 稳定合同与端口

- 在核心层定义宿主无关的 `UsageAccountingPort`、`UsageAccountingProtocol`、permit、Usage Event、Run Bill 类型。
- FrameFlow HTTP 适配器实现：
  - `POST /api/internal/ppt-agent/usage/v2/runs/{runId}/permits`
  - `POST /api/internal/ppt-agent/usage/v2/events`
  - `GET /api/internal/ppt-agent/usage/v2/runs/{runId}`
  - `POST /api/internal/ppt-agent/usage/v2/runs/{runId}/finalize`
- 沿用现有内部 Token 和 `X-PPT-Agent-User`，不引入浏览器凭据或新密钥传递方式。
- 明确区分确定性拒绝与结果未知；未知响应只允许原身份恢复。
- 固定下列身份公式，任何恢复不得重算为其他值：
  - Provider operation key `K`：沿用媒体 Step 现有稳定 `idempotencyKey`。
  - permit：header `Idempotency-Key=K`，body `operationIdempotencyKey=K`。
  - observed：`eventId=pptu_obs_<sha256(runId + NUL + K)[0:32]>`；body/header `idempotencyKey=K`；`batchId` 使用媒体 Step 在调用前冻结的真实批次 ID。
  - resolved：`eventId=pptu_res_<sha256(runId + NUL + K + NUL + providerOperationId)[0:32]>`；body/header `idempotencyKey=K + ':billing-resolved'`。
  - sequence：事件写入本地 outbox 的事务内取该 Run 已分配最大值加一；分配后永久冻结，响应丢失时原 payload 原样重放，不允许补洞、重排或复用。

### 3.2 协议冻结与兼容

- `RunRecord` 增加持久化 `accountingProtocol`；缺失字段按 `LEGACY_RESERVATION_V1` 解释，保证旧 SQLite Run 可读。
- 运行时配置只决定新建 FrameFlow V4 Run 的初始协议；非 V4 和非 FrameFlow 宿主保持原模式。
- 旧 `BudgetPort` / `BatchBudgetPort` 不删除、不改 HTTP 合同；V2 使用独立端口，避免把 Run Usage 语义伪装成 reservation。
- V2 配置切回 V1 只影响后续新建 Run；已持久化的 V2 Run 仍由同一 V2 协调器恢复。启动时若存在 V2 Run 而运行时缺少 V2 端口或成本快照，必须失败关闭，不能降级到旧端点。

### 3.3 Provider 调用门禁与持久化 Outbox

- 媒体 Step 在 Provider 调用前持久化 permit 结果、operation 创建时间及本次调用的不可变成本快照。快照至少包含模型、操作模式、分辨率、宽高比、固定单次金额（micros）、币种和 Provider 定价版本。
- permit 未明确成功时不调用 Provider。
- 使用 `report_usage_v2` Step 作为 durable outbox：事件 payload、eventId、sequence、幂等键在发送前事务落库。
- Run 内发送加串行门禁；恢复时先发送最小未完成 sequence，避免并发乱序。
- Provider 提交返回 `QUEUED/PROCESSING` 时生成 `OPERATION_OBSERVED(PROCESSING, UNKNOWN)`；提交直接返回 `COMPLETED` 时生成 `OPERATION_OBSERVED(COMPLETED, CHARGED)`，并携带调用前快照的实际固定成本，不虚构中间状态，也不再追加 resolved。
- 异步 Provider 终态明确后才生成 `BILLING_RESOLVED`；其模型、模式、创建时间、币种、金额和 Provider 定价版本只能读取媒体 Step 的调用前快照，禁止读取重启后的新配置。
- Provider 成本由启动时必填的、按模型和操作模式配置的固定单次账务目录提供；V2 开启但目标模型缺少成本/币种/Provider 定价版本，或模型不是固定单次价格时启动/Run 预检失败，不猜测或硬编码生产价格。

### 3.4 协议化 GenerationBatch 归约

- `GenerationBatch` 的准备、Agent 内部预算占用和页面成员关系继续共用现有确定性实现。
- V1 归约器保持 `preflightBatchFinalization -> reserveBatch -> finalizeBatch` 原路径。
- V2 归约器不得调用上述三个旧宿主动作：
  1. 批次开始时只在同一事务内占用 Agent 本地预算并写入 `accountingProtocol=FRAMEFLOW_USAGE_V2` 的本地批次身份；
  2. 每页以 operation permit 作为唯一 Provider 调用准入；
  3. 页面 Provider 终态及其应有 Usage outbox 均已被宿主确认后，按页面 `CHARGED/NOT_CHARGED/UNKNOWN` 结果归约本地 `settledUnits/releasedUnits/reconciliationUnits`；
  4. 没有未确认 Usage outbox、没有活动/提交未知页面时，批次 Step 才进入 `COMPLETED`，从而允许初稿进入页审、返修进入重新页审；
  5. 批次字段在 V2 中只表示 Agent 本地操作分配，不能触发或冒充宿主 Run 已 finalize。
- 终态会计继续从所有初稿/返修批次精确归并；V2 的宿主最终账单只以来自 Run finalize 的 Bill 为真源。

### 3.5 Run 终态结算

- 初稿/返修 GenerationBatch 在 V2 下只汇总本地操作状态，不调用宿主 Run finalize。
- Run 完成、失败或取消的状态、终态事件与 `finalize_usage_v2` durable Step 必须在同一 SQLite 事务创建；不能在终态事务提交后再补 Step。
- Worker 在同一 Run lease 下先刷新 Provider、再清空 Usage outbox、最后调用 V2 finalize。
- finalize 响应未知时保留 RUNNING Step；重启后使用 `finalize:<runId>` 恢复。
- SQLite/InMemory pending-reconciliation 查询及 lease 必须识别 `report_usage_v2` 和 `finalize_usage_v2`，包括已经处于 `COMPLETED/FAILED/CANCELLED` 的 Run。
- 宿主 Bill 状态固定映射：
  - `SETTLED` / `CAP_EXCEEDED`：finalize Step 才能 `COMPLETED`；保存最终 Bill 摘要。
  - `RECONCILING`：finalize Step 保持可恢复；继续查询 Provider、发送 resolved，随后用同一个 `finalize:<runId>` 再调用。
  - `REVIEW_REQUIRED` / `LEGACY_RECONCILIATION`：保存宿主事实并标记管理员处理，停止自动等价重试；不得写成 settled/completed。
  - 网络/响应结果未知：保留同一个 RUNNING Step、请求身份和有界退避时间。
- finalize 前必须先按序送达所有已经持久化的 Usage outbox；任何 hard conflict 都阻止伪终结并保留审计证据。

## 4. 修改模块与开发顺序

1. 合同与测试夹具：核心端口、HTTP Schema、协议字段及成本配置解析测试。
2. FrameFlow HTTP V2 适配器：请求、响应、错误分类、幂等测试。
3. Run 协议冻结：RunService、SQLite 重启及配置漂移测试。
4. permit 门禁：MediaStepRunner 的 V2 分支与零 Provider 副作用测试。
5. 协议化批次归约：初稿/返修 V2 零旧接口调用并可继续主链，V1 行为不变。
6. durable outbox：精确身份、并发顺序、响应丢失、调用前价格快照和重启配置漂移测试。
7. 终态 finalize：完成/失败/取消事务原子性、崩溃恢复、六态映射、批次不得提前 finalize、旧 V1 回归测试。
8. 文档与回退门禁：运行配置、宿主接入、两阶段上线、激活前置条件和版本回退检查。

## 5. 不做事项

- 不修改、提交或部署 FrameFlow。
- 不修改模型网关，不伪造 Gateway 不提供的实际费用事实。
- 不部署生产，不把生产环境从 V1 切到 V2。
- 不改变用户公开定价、300 积分父授权规则或管理员返修轮次。
- 不处理教学内容正确性和图片审美质量。
- 不删除旧账务接口或迁移已存在的 V1 Run。

## 6. 已知跨服务阻塞

以下问题不在 PPT Agent 仓库内绕过；代码完成后仍阻塞生产切换：

1. FrameFlow 当前父授权只冻结一个 `authorizedModel`，而 V4 初稿使用 Nano Banana、返修默认使用 `image-2`。FrameFlow 必须支持授权模型集合或稳定计价族，否则第二模型 permit 会被 `PPT_USAGE_MODEL_MISMATCH` 拒绝。
2. FrameFlow 当前 V2 finalize 在 `generatedOperations=0` 时返回 `PPT_USAGE_EVENTS_REQUIRED`。如果 permit 已成功但 Provider 明确未提交，Agent 不能伪造 providerOperationId；宿主必须允许零 observed operation 释放全部父授权，或提供等价的安全终结合同。
3. 模型网关只提供收费状态，不提供金额、币种和 Provider 定价版本。PPT Agent V2 启用前必须配置可审计的按模型/操作模式固定成本快照；若真实价格不是固定单次价格，则网关仍需补充实际费用合同。

## 7. 风险与回退

- 风险：并发事件乱序、permit 成功响应丢失、Provider 已提交但 observed 未送达、终态先于结算、旧 Run 协议漂移。
- 控制：事务 Outbox、稳定身份、按序发送、Run lease、协议持久化、V2 默认关闭、严格外部 Schema。
- 上线分两步：先发布理解两种协议、持久化协议且默认 V1 的兼容版本；验证后才允许 FrameFlow 和 PPT Agent 同时为新 V4 Run 开启 V2。
- 开启 V2 后，配置回切 V1只停止新 V2 Run，不能改变既有 V2 Run。只要 SQLite 中存在未完成/未结算 V2 Run，发布脚本必须拒绝回退到不认识 V2 的 `4.2.x` 或更旧版本；只能回退到仍包含 V2 恢复器的兼容版本。
- 增加“V2 Run 创建后以 V1 配置重启仍走 V2”和“缺少 V2 依赖时启动失败”的自动化测试；部署 runbook 记录检查命令与允许的回退目标。

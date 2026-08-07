# PPT-Agent V4 真实缺陷统一整改计划

## 1. 目标与基线

- 规划基线：`main@4e855b7d789c24d525335ce512fce71db0740636`，与 `origin/main` 一致。
- 规划日期：2026-08-07。
- 候选版本：`4.5.0`。本轮包含新增公开诊断字段和能力状态，属于向后兼容的 minor 版本。
- 范围：仅 PPT-Agent V4、Quick-deck、媒体 Port、能力策略、验收脚本和相关公开合同。
- 不直接修改：FrameFlow、NewAPI、Model-Gateway 路由、其他 PPT 模式和正式部署。
- 实施方式：唯一 `main` 工作树线性推进；不新建 worktree、不 rebase、不覆盖现有未跟踪文件。
- 真实 Provider：本计划阶段不调用。实施完成、源码门禁和子智能体复审通过后，才在当次明确授权下使用独立 evaluator Key 验收。

完成定义不是“测试变绿”，而是下面 13 个问题都能由最终源码、自动化测试和真实验收证据逐项证明已经关闭。

## 2. 问题归纳

### 2.1 媒体合同与像素处理

| 编号 | 问题 | 根因 | 归属任务 |
|---|---|---|---|
| 1 | V4 把轻微近似比例也全部拒绝 | 只提交语义比例，却要求结果像素绝对相等；没有正规化层 | T1 |
| 2 | HTTP 200 后的图片编辑失败仍记为提交未知 | `MediaSubmissionError` 无法表达 `SUBMITTED`，提交和计费状态耦合 | T2、T3 |
| 5 | 比例失败不保留实际尺寸和误差 | 适配器已读尺寸，但错误结果只保留错误码 | T1、T5 |
| 11 | 不同提交错误被统一压成 `UNKNOWN` | Quick-deck 丢弃 `MediaSubmissionError` 的稳定字段 | T2、T4 |

### 2.2 Quick-deck 生命周期与清理

| 编号 | 问题 | 根因 | 归属任务 |
|---|---|---|---|
| 3 | 一页失败后整个任务立即终止 | 没有 drain 阶段；`fail()` 清除下一次执行时间 | T4 |
| 4 | 失败报告只保留笼统错误 | 报告只在 case 结束时写，catch 丢失 job/page/operation 证据 | T5、T7 |

### 2.3 能力发布和可用性

| 编号 | 问题 | 根因 | 归属任务 |
|---|---|---|---|
| 6 | capabilities 只代表 env，不代表当前可调用 | 模型数组在启动时静态生成，无 readiness/availability | T6 |
| 7 | 测试启用与正式发布共用一个开关 | evaluation、published、readiness 没有分层 | T6 |
| 10 | 评测没有完整的脱敏调用链证据 | job 只记录模型和内部 operation，未定义 evidence 合同 | T5 |

### 2.4 验收工具与能力证明

| 编号 | 问题 | 根因 | 归属任务 |
|---|---|---|---|
| 8 | 单页失败后仍继续 3/10 页 | runner 对每个 case 捕获失败后继续循环 | T7 |
| 9 | Quick-deck 不能证明完整 V4 返修能力 | 其设计明确排除审查、返修、Usage V2 和恢复 | T8 |
| 12 | 报告版本由环境变量自报 | runner 不读取 health，也不检查测试期间是否重启 | T7 |
| 13 | Quick-deck 文档漏写两把 evaluator 网关 Key | 源码 required 配置与运行文档没有 parity 门禁 | T7 |

## 3. 固定架构决策

### 3.1 比例策略

新增纯核心 `ImageAspectPolicy` 和 `ImageAspectNormalizer`，不把供应商名称硬编码进业务代码。

对请求的 16:9 图片按以下规则处理：

1. 读取原始宽高并计算 `relativeError = abs((width / height) / (16 / 9) - 1)`。
2. 原始像素已经满足 `width * 9 === height * 16` 时原样入库，不重复编码。
3. `relativeError <= 0.03` 时，确定性居中裁切到最大的内接精确 16:9 区域，再缩放为 `1600x900`。
4. `1376x768` 的固定结果是裁切为 `1360x765`：左/右各 8 像素，上 1、下 2 像素，然后缩放为 `1600x900`。
5. 超过 3% 时失败关闭；`2048x2048` 的误差为 43.75%，必须拒绝。
6. 记录原始尺寸、原始 SHA-256、裁切区域、目标尺寸、误差、是否正规化和最终 SHA-256。
7. PPTX renderer 只能接收已正规化的精确比例图片，不允许通过 `w/h` 拉伸掩盖比例问题。

3% 是 PPT-Agent 的应用安全阈值；只有在共享合同落地后，才可把它描述为跨系统承诺。

### 3.2 提交状态和计费状态

媒体失败统一使用两个独立维度：

```text
submissionState = NOT_SUBMITTED | SUBMITTED | UNKNOWN
billingState    = NOT_CHARGED | CHARGED | UNKNOWN
```

- 请求在本地或 4xx 明确拒绝：`NOT_SUBMITTED + NOT_CHARGED`。
- 网络在响应前断开且无法查询：`UNKNOWN + UNKNOWN`。
- HTTP 200 已返回但输出合同失败：`SUBMITTED + UNKNOWN`；只有权威账务回执才改为 `CHARGED`。
- 已有异步 operation 且 Provider 最终失败：`SUBMITTED + gateway billing evidence`，缺失证据时为 `UNKNOWN`。
- 只有 `NOT_SUBMITTED` 可以在原幂等键下按既有策略重新提交；`SUBMITTED` 和 `UNKNOWN` 绝不换 Key 重提。

### 3.3 图片编辑协议

- 发布态图片编辑最终只接受异步、可按原幂等键查询的 `IMAGE_TASK`。
- PPT-Agent 增加 `operationMode: IMAGE_EDIT` 的异步 Port 合同和恢复测试。
- 在 Model-Gateway 尚未公开并验收异步 edit task 前，图片编辑只能处于 `EVALUATION` 或 `UNAVAILABLE`，不能进入 `PUBLISHED` capabilities。
- 临时同步编辑路径仍必须正确表达 `SUBMITTED + billing UNKNOWN`，但不再被视为正式稳定能力。

### 3.4 Quick-deck drain

- 任一页面失败后立即停止所有新提交，但不立即把 job 设为终态。
- job 保持可运行状态，持久化 `pendingFailure`、`drainStartedAt` 和 `drainDeadline`。
- 对所有 `SUBMITTED` 或 `UNKNOWN` 页面，只使用原 operation ID/幂等键查询，绝不重新提交。
- 所有已提交页终结后，job 才进入 `FAILED`；超出 drain deadline 的页以稳定超时错误失败。
- 进程重启后从 SQLite 继续 drain。
- 公共 status 枚举保持兼容；drain 期间仍为 `GENERATING / IMAGE_GENERATION`，通过新增进度字段表达 pending failure。

### 3.5 能力三层模型

每个 V4 模型分别维护：

```text
publication = EVALUATION | PUBLISHED | DISABLED
readiness   = PASSED | FAILED | STALE | UNKNOWN
availability = AVAILABLE | UNAVAILABLE | UNKNOWN
```

- 新正式 Run：仅允许 `PUBLISHED + PASSED + AVAILABLE`。
- Quick-deck evaluator：允许 `EVALUATION` 模型，但仍要求 evaluator Key 可见。
- 历史 Run 和精确幂等重放：继续使用持久化快照，不受新 availability 变化影响。
- `/v1/capabilities` 保留现有模型字符串数组；数组只列正式可用于新 Run 的模型，同时新增详细状态投影。
- `/models` 目录检查只证明“当前可见”，不冒充真实生成质量认证。

### 3.6 评测证据边界

新增 evaluator 专用只读资源：

```text
GET /v1/evaluations/quick-decks/{jobId}/evidence
```

它返回服务端构建身份、启动时间、模型、Agent request ID、网关 operation ID、提交/计费状态、逐页安全错误、实际尺寸和证据完整性。它不返回 Key、Prompt、来源正文、B64、签名 URL、Provider 账号或内部路由配置。

## 4. 依赖顺序

```text
T0 回归基线
  -> T1 比例与正规化
  -> T2 状态/计费语义
      -> T3 异步编辑与恢复
      -> T4 Quick-deck drain
          -> T5 证据 API
              -> T6 capabilities/readiness
                  -> T7 可恢复评测 runner
                      -> T8 完整 V4 验收
                          -> T9 全门禁与子智能体源码复审
```

共享合同任务必须串行。只有测试、OpenAPI parity 和文档检查可在合同冻结后并行补充。

## 5. 实施任务

### T0：冻结基线并增加失败回归

**覆盖问题：** 全部 13 项的可复现基线。

**动作：**

- 固定 `main == origin/main` 和当前 SHA，保留两份未跟踪文档。
- 先增加必定失败的回归，不改生产实现。
- 建立问题到测试名称的机器可读矩阵，后续子智能体按矩阵审查源码。

**重点测试：**

- `1376x768` V4 近似比例正规化。
- `2048x2048` 严重失衡拒绝。
- HTTP 200 后合同失败为 `SUBMITTED + billing UNKNOWN`。
- Quick-deck 保留 `NOT_SUBMITTED/SUBMITTED/UNKNOWN`。
- 一页失败后其他页继续 drain，且不产生第二次 submit。
- capabilities 的 publication/readiness/availability 组合。
- runner fail-fast、resume、build identity 漂移。

**验收：** 新测试只因对应缺陷失败，不能因导入不存在符号或错误 fixture 失败。

**预计文件：** 相关 `tests/*.test.ts`，不改 `src/`。

### T1：实现比例合同、诊断和确定性正规化

**覆盖问题：** 1、5。

**动作：**

- 新增 `src/core/image-aspect-policy.ts`，包含比例计算、阈值决策和裁切计算。
- 将适配器的 `assertImageAspectRatio()` 改为返回结构化决策。
- 对近似 16:9 结果执行 Sharp 正规化，严重失衡继续返回合同失败。
- 扩展媒体成功/失败诊断：原始尺寸、目标尺寸、误差、裁切和正规化标记。
- renderer 增加防御性断言：V4 输入不是精确 16:9 时拒绝，而不是拉伸。

**验收：**

- `1376x768 -> 1360x765 crop -> 1600x900` 的尺寸、裁切和哈希稳定。
- exact 16:9 不重复编码。
- 方形、3:2、4:3 均失败，artifact 不入库。
- 非 V4 旧模式行为保持不变。

**预计文件：**

- `src/core/image-aspect-policy.ts`
- `src/core/ports.ts`
- `src/adapters/gateway-image-generation.ts`
- `src/adapters/presentation-renderer.ts`
- `tests/gateway-image-generation.test.ts`
- `tests/presentation-renderer.test.ts`

### T2：拆分提交状态、计费状态和错误语义

**覆盖问题：** 2、11。

**动作：**

- 允许媒体失败表达 `submissionState: SUBMITTED`。
- `MediaSubmissionError` 增加独立 `billingState`、可选 operation ID 和安全图片诊断。
- 删除 `SUBMITTED => CHARGED` 的隐式推导；没有网关账务证据时保持 `UNKNOWN`。
- 修改 `MediaStepRunner`、Quick-deck 和 revision coordinator，使其按真实状态处理。
- 任何 `SUBMITTED/UNKNOWN` 失败均禁止换 Key 重提。

**验收：**

- HTTP 422 为 `NOT_SUBMITTED + NOT_CHARGED`。
- 网络断开为 `UNKNOWN + UNKNOWN`。
- HTTP 200 坏图片为 `SUBMITTED + UNKNOWN + CONTRACT/NON_RETRYABLE`。
- 明确账务回执才能产生 `CHARGED`。
- Usage V2、预算释放和人工对账路径全部有回归。

**预计文件：**

- `src/core/ports.ts`
- `src/core/media-step-runner.ts`
- `src/core/quick-deck-evaluation-service.ts`
- `src/core/revision-media-coordinator.ts`
- `src/adapters/gateway-image-generation.ts`
- 对应四组测试

### T3：将正式图片编辑迁移到异步 operation

**覆盖问题：** 2、7、9 的编辑能力部分。

**动作：**

- 为 `ImageGenerationPort.submit()` 冻结 `operationMode: TEXT_TO_IMAGE | IMAGE_EDIT`。
- edit 通过异步 task 返回 operation ID，并复用 inspect/lookup 恢复路径。
- 参考图以受控 artifact 引用或 multipart task 提交，不把 B64 写入状态。
- 上游未声明异步 edit capability 时，新正式 Run 在预算和 Provider 调用前失败关闭。
- 同步编辑只保留为 evaluation compatibility，不允许发布。

**外部依赖：** Model-Gateway 必须先提供并验收 `IMAGE_TASK + IMAGE_EDIT + by-idempotency`。依赖未满足时本任务不能标记完成，只能保持安全禁用。

**验收：**

- 提交后进程立即退出，重启后仅凭原 key 恢复同一 operation。
- UNKNOWN 不重提；NOT_SUBMITTED 只在原 key 下按策略重试。
- 任务完成、合同失败、下载失败和账务未知分别有稳定状态。

### T4：实现 Quick-deck drain 和逐页最终状态

**覆盖问题：** 3、11。

**动作：**

- 扩展内部 record schema，增加 pending failure 和 drain 元数据，旧记录使用默认值兼容。
- submission rejection 保留真实 `MediaSubmissionError` 状态。
- 首个失败后停止新提交，继续查询全部已接受/未知页面。
- drain deadline 后将未决页标记为稳定超时，不恢复成功、不进入 Usage V2。
- SSE 新增安全的 draining 进度事件，sequence 继续单调。

**验收：**

- 3/10 页部分失败后每页最终都是 COMPLETED 或 FAILED，不残留 SUBMITTED。
- 重启中断后继续 drain，submit 调用次数不增加。
- job 在 drain 完成前不是终态；终态 SSE 只发一次。
- TTL 清理和现有 artifact cleanup 回归保持通过。

**预计文件：**

- `src/core/quick-deck-evaluation-ports.ts`
- `src/core/quick-deck-evaluation-service.ts`
- `src/adapters/quick-deck-evaluation-sqlite-repository.ts`
- `src/quick-deck-evaluation-contracts.ts`
- Quick-deck repository/service/http/SSE 测试

### T5：补齐逐页诊断和 evaluator evidence API

**覆盖问题：** 4、5、10。

**动作：**

- Quick-deck 页投影新增向后兼容字段：submission state、error code、observed dimensions、relative error、normalization disposition。
- 新增 evidence 资源，返回构建身份、启动代次和受控 operation 证据。
- operation/request ID 缺失时明确 `evidenceCompleteness: PARTIAL | UNKNOWN`，不反推供应商。
- 为 evidence 增加 quickDeck evaluator auth、TTL、统一错误和 OpenAPI/Zod 双向 parity。

**验收：**

- 近似比例和方形失败能仅通过 API 区分。
- 一次失败报告无需查数据库即可列出全部已知证据和未知项。
- 响应不包含 Prompt、正文、密钥、Provider URL、B64 或签名 URL。

### T6：建立模型 publication/readiness/availability 策略

**覆盖问题：** 6、7。

**动作：**

- 用 `V4ModelRegistry` 替换仅由字符串数组组成的策略，但保留 `V4ModelPolicy` 兼容入口。
- 分离 evaluation models 和 published models；旧编辑开关只开启 evaluation，不再自动发布。
- 增加只读 `GatewayModelAvailabilityPort`，分别用正式/评测 Text/Image Key 查询模型目录并短 TTL 缓存。
- capabilities 保留原数组并新增详细状态；新 Run 使用三层门禁。
- 精确幂等重放和历史恢复绕过新 availability 重算。

**验收：**

- 配置了但网关不可见的模型不会进入新 Run。
- evaluation 模型可被 Quick-deck 使用，但不出现在正式 imageEdit 数组。
- readiness 过期或失败时能力明确显示，不伪装稳定。
- Mock 能力仍只返回 `local-mock-*`。

### T7：重构真实评测 runner、运行身份门禁和配置文档

**覆盖问题：** 4、8、12、13。

**动作：**

- 付费调用前读取 `/health/live`、`/health/ready`、capabilities 和 evaluator 模型目录。
- 记录服务端报告的 software version、git SHA、release ID、startedAt 和 runtimeMode。
- 每次轮询比较 startedAt；发生重启时以 `EVALUATION_ENVIRONMENT_CHANGED` 失败，不归因供应商。
- 创建 job 后立即以 0600 原子写 `case-state.json`；每次状态变化增量更新。
- 增加 `--resume`，只查询已存在 job；禁止创建新实验。
- 默认 1 -> 3 -> 10 canary fail-fast；只有显式 `--continue-after-failure` 才继续。
- 失败 summary 保留 job、request、page、operation、尺寸、状态和 evidence completeness。
- 补 Quick-deck 两把 evaluator 网关 Key 文档，并增加 required-env/document parity 测试。

**验收：**

- SIGTERM 后可恢复且 job 数不增加。
- 错误端口、旧 release、Mock runtime、模型不可见均在付费调用前失败。
- 单页失败后默认不会产生 3/10 页请求。
- 报告不接受调用者自报版本覆盖服务端身份。

### T8：建立完整 V4 源码与真实能力验收

**覆盖问题：** 9，并复验 1-13。

Quick-deck 保持轻量定位，不向其中塞入正式审查和返修。新增两个互补验收场景：

1. `FULL_V4_REAL`：通过现有 `/v1/runs`、actions、SSE 和 content 接口运行真实单页 V4，真实执行规划、初始图、页审、整稿审查和交付；自然产生返修时继续验证返修。
2. `FULL_V4_FORCED_REVISION`：仅在隔离测试 runtime 通过依赖注入让 reviewer 返回一个固定、合法的 ASSET revision；规划、初始图、图片编辑和 PPTX 仍使用真实受控线路。该模式不增加公共 API 后门，只证明返修协调、幂等、恢复和交付机制。

另保留 Mock full-chain 测试，确定性覆盖 Usage V2、重启和所有状态分支。

**验收：**

- 单页正式 Run 完成创建、规划、批准、初始图、审查、交付、SSE 和下载。
- forced revision 只提交一次 edit operation，重启后恢复并产生新 revision delivery。
- PPTX/预览尺寸、SHA-256、revision round 和 Usage V2 状态一致。
- 报告明确区分 Quick-deck、真实自然审查和强制返修机械验收，不把后两者混称质量认证。

### T9：全量门禁、原子提交和子智能体源码复审

**覆盖问题：** 全部 13 项。

每个前置任务使用独立原子提交，提交格式遵循项目规则。每 2-3 个任务执行一次检查点：

```bash
bun test <focused tests>
bun run typecheck
bun run build
bun run check:boundaries
bun run verify:ownership
git diff --check
```

公共合同变更额外执行 OpenAPI/Zod parity 和新增行敏感信息扫描。最终执行 `bun run check`。

## 6. 子智能体源码审查方案

子智能体只在实现、测试和本地全门禁完成后启动。它们不以本计划或问题文档为证据，不编辑文件，不调用真实 Provider。

### 6.1 调度方式

- 使用三个子智能体，占满可用的三个并行槽位。
- `fork_turns="none"`，避免它们继承实现者解释和设计结论。
- Prompt 只提供：仓库绝对路径、最终 commit SHA、13 个问题的简短行为定义、必须检查的源码边界和测试命令。
- 明确要求从源码、测试和运行结果独立得出结论；禁止引用计划文档作为“已解决”证据。

### 6.2 审查分工

**Agent A：媒体合同与恢复**

- 审查问题：1、2、5、11，以及 T3 异步编辑。
- 必看源码：`ports.ts`、`image-aspect-policy.ts`、`gateway-image-generation.ts`、`media-step-runner.ts`、`revision-media-coordinator.ts`、renderer。
- 必须验证：1376x768 正规化、2048x2048 拒绝、SUBMITTED/billing UNKNOWN、幂等恢复、无拉伸。

**Agent B：Quick-deck 生命周期与公共合同**

- 审查问题：3、4、6、7、10、13。
- 必看源码：Quick-deck service/repository/contracts/http/SSE、V4 model registry、capabilities、OpenAPI、配置解析。
- 必须验证：drain 不重提、逐页终态、evidence 脱敏、publication/readiness/availability、历史兼容。

**Agent C：验收工具与完整 V4 链路**

- 审查问题：8、9、12，以及所有问题的验收可证明性。
- 必看源码：两个真实验收 runner、health、正式 Run actions、full-chain E2E、报告 schema。
- 必须验证：fail-fast、resume、版本漂移、自然审查与 forced revision 的边界、PPTX/SSE/Usage 证据。

### 6.3 审查输出合同

每个 Agent 必须逐问题返回：

```text
Issue N: RESOLVED | PARTIAL | UNRESOLVED
Source evidence: absolute file:line
Test evidence: test file + exact test name + fresh result
Behavioral proof: 为什么实现真正关闭了问题
Missing coverage: 无则写 none
Severity: Blocking | Required | Suggestion | None
```

只报告“测试通过”不算审查完成；必须解释源码状态转换、错误语义和失败边界。

### 6.4 收口规则

1. 任一 Agent 出现 Blocking 或 Required，主智能体必须修复并运行相关门禁。
2. 修复后把同一最终 SHA 交给三名 Agent 重新审查受影响问题，不能只让实现者自证。
3. 三名 Agent 的 Blocking/Required 均为 0，才允许进行隔离真实验收。
4. 真实验收后，再让三个 Agent 对最终源码和脱敏 evidence 做一次只读复核。
5. 最终只有 13 项全部为 RESOLVED、全量门禁通过、真实单页和受控返修通过，才能声明完成。

## 7. 问题关闭矩阵

| 问题 | 自动化证明 | 真实/运行证明 | 最终审查者 |
|---:|---|---|---|
| 1 | 近似比例正规化、严重失衡拒绝、renderer 不拉伸 | Gemini 单页实际像素与最终 1600x900 | A |
| 2 | HTTP 200、断网、4xx、异步失败状态表 | edit operation 账务/提交证据 | A |
| 3 | 部分失败、重启、deadline、零重提 | 3 页受控部分失败演练 | B |
| 4 | 失败 report snapshot | 仅凭报告完成已知/未知证据复盘 | B、C |
| 5 | 错误包含尺寸、误差、处置 | 方形与近似比例可区分 | A、B |
| 6 | availability 组合表 | evaluator `/models` 与 capabilities 对照 | B |
| 7 | evaluation/published 隔离 | 未验收 edit 不出现在正式能力 | B |
| 8 | canary fail-fast | 单页失败时调用计数不增长 | C |
| 9 | Mock full-chain + forced revision | 正式单页与真实 edit 交付 | C |
| 10 | evidence schema/脱敏测试 | request/operation 证据完整性状态 | B |
| 11 | rejected reason 状态表 | 明确未提交不再显示 unknown | A、B |
| 12 | health/version/restart 测试 | 测试中重启被标记环境污染 | C |
| 13 | required-env/doc parity | 按文档可启动隔离 evaluator | B |

## 8. 风险与回退

| 风险 | 缓解 |
|---|---|
| 裁切破坏边缘文字 | 仅允许 3% 内正规化；固定安全区；记录裁切；超限失败 |
| 新状态影响 Usage V2 | submission/billing 正交建模；所有组合表驱动测试 |
| capability 探针抖动导致新 Run 暂停 | 短 TTL 缓存、明确 UNKNOWN/UNAVAILABLE；历史恢复不受影响 |
| drain 长时间占用 evaluator 并发 | 有界 deadline；不提交新请求；终态前持续可观察 |
| evidence 暴露内部信息 | 独立 evaluator auth、严格 schema、敏感字段禁止测试 |
| forced revision 被误用为产品后门 | 仅依赖注入到隔离 CLI，不注册公共 HTTP 路由 |
| 上游异步 edit 尚未就绪 | imageEdit 保持 evaluation/unavailable，绝不提前发布 |

回退以原子提交为单位。公共字段只做新增，不移除旧字段；旧 Run、旧 Quick-deck 记录和精确幂等重放均有兼容测试。不得通过清库或迁移历史 Run 代替兼容实现。

## 9. 发布边界

- 本计划完成不等于正式部署。
- 源码、子智能体复审和隔离真实验收通过后，只能形成测试候选。
- `/opt/ppt-agent` 当前仍是个人验收站；正式对外生产必须由新的明确指令授权。
- 真实验收失败时停止扩容调用，保留原幂等键和脱敏证据，不修改 Model-Gateway/NewAPI 逃避失败。

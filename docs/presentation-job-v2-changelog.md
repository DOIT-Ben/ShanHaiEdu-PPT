# Presentation Job V2 Changelog

## [2.0] - 2026-08-05

### Added

- 独立、宿主无关的 Presentation Job HTTP 合同：创建、读取 Job、下载 Artifact 与读取 Usage。
- 服务凭据绑定 tenant；V2 拒绝 `X-PPT-Agent-Tenant`，只接受必填的外部用户和可选项目范围。
- `APPROVED_PAGE_DESIGN` 不可变快照输入，包含 artifactVersionId、SHA-256、完整严格 schema 与可复算哈希向量。
- 稳定 Job 状态 `QUEUED`、`RUNNING`、`COMPLETED`、`FAILED`，以及独立的 `PENDING`、`RECONCILING`、`FINALIZED` Usage 投影。
- 流式 PPTX Artifact 下载，声明 Content-Type、Length、Disposition、ETag、Artifact ID、SHA-256 与合同版本；V2.0 对 Range 返回 `416`。
- 主进程内部智能体 Provider：把冻结逐页设计映射为隔离 tenant 下的 `VISUAL_DECK_V4` Run，复用规划、生图、质检、最多 4 轮有限返修和 PPTX 交付链。
- 独立 V2-only server/runtime 只装配 V2 SQLite、Artifact、固定服务级操作上限与宿主无关 Provider port；不初始化内部 Run 或宿主 adapter。
- 可选通用 HTTP Provider adapter；未注入内部 Provider 时必须显式配置模式，deterministic Provider 仅在显式测试配置下启用。
- Usage 按模型公开可计费、明确未收费和待核对的图片操作数；总数必须与 `byModel` 汇总一致，供宿主按自己的价格表幂等结算。
- Job 和 Usage 公开每页最多 5 次可计费图片操作策略；Provider 接收绝对上限，超限结果以 `PROVIDER_USAGE_CAP_EXCEEDED` 失败且不发布 Artifact。
- 失败 Job 和已交付 Job 的未知 Usage 都可继续对账；转为 `FINALIZED` 时不改变既有 Job 终态，也不会再次提交 Provider Operation。

### Fixed

- 内部 Provider 找不到已经提交对应的私有 Run 时，不再返回零用量；该 Operation 保持一项 `unknown`，由 Usage 对账恢复，禁止误报 `FINALIZED`。
- 对账返回超过公开每页 5 次硬上限的 Usage 时，不再自动最终确认；已交付 Job 与 Artifact 保持终态不变，Usage 继续 `RECONCILING` 并记录 `PROVIDER_USAGE_CAP_EXCEEDED`。
- V2 SQLite repository 对存储 JSON 做结构化校验，并把仍使用 `billingStatus`、`unknownOperationCount` 的旧提交记录保守升级为 `RECONCILING`。已有 Provider Operation 一律保留未知用量，不伪造零用量；历史 deterministic 记录多出的根级 `model` 是唯一兼容读取边界，读取时剥离，其他未知字段继续拒绝。
- 通用 HTTP Provider 提交请求复用冻结的 `PRESENTATION_JOB_V2_CONTRACT_VERSION`，请求与响应均为 `2.0`，不再发送旧的 `1.0` 字面量。

### Compatibility

- V2 与 V1 Run、V1 SSE/Event、V1 Delivery 和历史账务记录完全隔离；V1 行为与公共合同不变。
- 主进程内部实现可以在派生 tenant 下复用成熟 Run 执行图，但这些私有记录不会进入 V2 公共响应或要求宿主理解 V1 合同。
- V2-only 使用独立 tenant、服务 Token、端口和数据根；V1 继续保留现有 FrameFlow adapter 作为历史兼容边界。
- 同一 tenant、external user、external project（可为空）和 Idempotency-Key 的规范化请求可重放；同键不同请求返回不可重试冲突。
- 上述恢复修复不改变 `ppt-agent-contract-v2.0.0` 的 OpenAPI、Samples、Hash vectors 或公共 Zod 合同；只收紧 Provider port 与本地持久化边界。

### Delivery And Usage

- `COMPLETED` 必须具有可读取的 PPTX 且质量为 `PASSED` 或明确的 `BEST_EFFORT`。
- 安全、完整性、版权/隐私、关键教学内容等交付阻断结果为 `FAILED`，不公开 Artifact；返修耗尽本身不会生成 `BEST_EFFORT`。
- 已交付 Job 的 Usage 若需对账，Job 仍为 `COMPLETED`，Usage 仅投影 `RECONCILING` + `WAIT`；`FINALIZED` 时未知操作数为零且终态不可变。
- 失败 Job 的 Usage 若需对账，Job 仍为 `FAILED`；对账只把 Usage 从 `RECONCILING` 推进到 `FINALIZED`。

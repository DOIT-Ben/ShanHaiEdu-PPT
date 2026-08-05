# Presentation Job V2 Changelog

## [2.0] - 2026-08-05

### Added

- 独立、宿主无关的 Presentation Job HTTP 合同：创建、读取 Job、下载 Artifact 与读取 Usage。
- 服务凭据绑定 tenant；V2 拒绝 `X-PPT-Agent-Tenant`，只接受必填的外部用户和可选项目范围。
- `APPROVED_PAGE_DESIGN` 不可变快照输入，包含 artifactVersionId、SHA-256、完整严格 schema 与可复算哈希向量。
- 稳定 Job 状态 `QUEUED`、`RUNNING`、`COMPLETED`、`FAILED`，以及独立的 `PENDING`、`RECONCILING`、`FINALIZED` Usage 投影。
- 流式 PPTX Artifact 下载，声明 Content-Type、Length、Disposition、ETag、Artifact ID、SHA-256 与合同版本；V2.0 对 Range 返回 `416`。
- 独立 V2-only server/runtime，只装配 V2 SQLite、Artifact、固定服务级操作上限与宿主无关 Provider port；不初始化 V1 Run 或宿主 adapter。
- 可选通用 HTTP Provider adapter；默认仍为 deterministic Provider，只有显式配置时才会发起 Provider HTTP 操作。
- Usage 按模型公开可计费、明确未收费和待核对的图片操作数；总数必须与 `byModel` 汇总一致，供宿主按自己的价格表幂等结算。

### Compatibility

- V2 与 V1 Run、V1 SSE/Event、V1 Delivery 和历史账务记录完全隔离；V1 行为与公共合同不变。
- V2-only 使用独立 tenant、服务 Token、端口和数据根；V1 继续保留现有 FrameFlow adapter 作为历史兼容边界。
- 同一 tenant、external user、external project（可为空）和 Idempotency-Key 的规范化请求可重放；同键不同请求返回不可重试冲突。

### Delivery And Usage

- `COMPLETED` 必须具有可读取的 PPTX 且质量为 `PASSED` 或明确的 `BEST_EFFORT`。
- 安全、完整性、版权/隐私、关键教学内容等交付阻断结果为 `FAILED`，不公开 Artifact；返修耗尽本身不会生成 `BEST_EFFORT`。
- 已交付 Job 的 Usage 若需对账，Job 仍为 `COMPLETED`，Usage 仅投影 `RECONCILING` + `WAIT`；`FINALIZED` 时未知操作数为零且终态不可变。

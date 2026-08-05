# ADR-009：Presentation Job V2 宿主无关提供方边界

## 状态

Accepted

## 日期

2026-08-05

## 背景

既有 V1 Run 是历史兼容路径，包含宿主文档、预算回调、SSE、人工审批和内部执行状态。新的服务到服务合同需要让任意宿主提交已认证范围内的不可变课件设计快照，并只消费稳定的 Job、Artifact 和 Usage 事实。把四个 V2 URL 映射到 V1 Run 会泄露既有内部投影，并让交付后账务恢复再次影响用户可见终态。

## 决策

- V2 使用独立的 Presentation Job repository、provider port、服务级授权策略和 Artifact 引用，不创建或读取 V1 Run、Step、Event、Delivery 或宿主数据库记录。
- V2 核心和 HTTP facade 只理解 tenant、external user、optional external project、不可变来源快照、通用 Provider Operation 与交付质量；它们不导入具体宿主 adapter。
- 服务凭据决定 tenant。V2 拒绝租户覆盖头；对象所有权不匹配一律返回 404。
- Provider Operation 在 PPT-Agent 内以稳定幂等键记录，固定服务级操作上限在执行前强制。V2 不调用宿主预算、结算、释放、完成或文档 HTTP callback。
- Job 交付和 Usage 终态独立。已交付 Job 不能因为后续对账或历史 V1 Event 改为 FAILED；Usage `FINALIZED` 后不能变更。
- Usage 只公开按模型聚合的可计费、未收费和未知图片操作事实，不包含宿主价格或积分；聚合总数必须与 `byModel` 一致。
- V1 继续使用现有 adapter 和 Run 语义以兼容历史。V2 提供独立进程入口，只构造 V2 SQLite repository、Artifact port、固定服务级预算、服务认证和通用 Provider port；它不通过 `createAgentRuntime` 或 `createMockRuntime` 初始化 V1 执行图。

## 后果

- 新宿主只需提供服务凭据、外部身份范围和已预授权的不可变来源快照；宿主自行决定如何消费 Job/Artifact/Usage。
- 真实通用 Provider 由独立 V2 provider port 注入；本仓库测试使用本地 Mock Provider，不调用计费模型。
- V2 SQLite 采用专属 `presentation_jobs_v2` 表，避免与 V1 记录发生状态耦合。
- V2-only 服务使用独立 tenant、Token、监听端口和数据根配置，因此可与 V1 兼容服务并行部署或单独回退。

## 回退

回退本功能仅移除 V2 路由和独立运行时注入；不得将 V2 Job 数据迁移或伪装为 V1 Run。已写入的 V2 SQLite 表保留，直到有单独的数据保留和迁移决策。

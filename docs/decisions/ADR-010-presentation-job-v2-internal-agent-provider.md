# ADR-010：Presentation Job V2 内部智能体 Provider

## 状态

Accepted

## 日期

2026-08-05

## 背景

Presentation Job V2 已经把宿主侧合同收敛为不可变来源、Job、Artifact 和 Usage，但仅有 deterministic 或外部 HTTP Provider 时，主 PPT-Agent 进程并不会执行现有的规划、生图、质检、有限返修和 PPTX 交付链。FrameFlow 需要消费稳定 V2 合同，同时复用已经验证的 `VISUAL_DECK_V4` 能力，不能再依赖 V1 Run、Event 或内部预算接口。

## 决策

- 主 `server.ts` 默认注入 `InternalPresentationJobV2Provider`。它把 V2 的冻结逐页设计映射为派生 tenant 下的私有 `VISUAL_DECK_V4` Run，固定 `BOUNDED_AUTO`、最多 4 轮返修和每页最多 5 次图片操作预算。
- 派生 tenant 只用于内部记录和 Artifact 读取；外部 tenant、user、project 经过不可逆摘要映射。V2 响应不公开内部 Run ID、Step、Event、Delivery、提示词或模型诊断。
- 主进程 V2 路由只接受独立 `PPT_AGENT_V2_API_TOKEN`；V1 用户 Token、管理员 Token 和宿主回调 Token 均不能调用 V2。
- 内部 Run 使用宿主已经完成的整单预授权。`TenantRoutingBudgetPort` 仅对派生 tenant 使用 `ExternallyAuthorizedBudgetPort`，其他 V1 tenant 继续使用原有 FrameFlow 或外部预算链。
- Provider 从真实图片 Step 汇总 `billable`、`notCharged`、`unknown` 用量并按模型分组。Job 和 Usage 都公开固定策略 `maximumBillableImageOperationsPerPage: 5`；服务在提交前传递绝对上限，并拒绝超过页数乘 5 的 Provider Usage。
- 未配置 `PPT_AGENT_V2_PROVIDER_MODE` 时，只有注入内部 Provider 的主进程可以默认选择 `internal`。独立 `presentation-job-v2-server` 必须显式选择 `http`；`deterministic` 只能显式用于测试和本地合同验证。
- 失败 Job 与已交付 Job 的 Usage 都可以从 `RECONCILING` 恢复到 `FINALIZED`，恢复只更新 Usage，不改写既有 Job 终态或重新提交 Provider Operation。
- 已记录 Provider Operation 但私有 Run 缺失、旧 SQLite 记录无法证明逐模型实际用量、或对账结果超过公开硬上限时，Usage 必须保持 `RECONCILING`；不得用空汇总伪造零用量，也不得因交付后的账务异常改写已交付 Job 终态。

## 后果

- FrameFlow 只消费 V2 公共合同，不再理解 PPT-Agent 内部 Run 或回调协议；PPT-Agent 可以在不改变宿主合同的前提下演进内部执行图。
- 主进程与 V1 共享 repository、Artifact 和 worker，但通过 tenant、幂等键和预算路由隔离；V1 的 Presentation Mode、Provider、预算和 Usage V2 行为保持不变。
- 每页 5 次是公开硬上限，不是承诺一定调用 5 次。宿主按最终 Usage 实际结算并释放剩余预授权。
- 生产启用前仍需在隔离环境验证真实 Provider 配置；本决策和自动化测试不授权真实付费调用。

## 回退

回退内部 Provider 时，将主进程显式配置为已验证的 `http` Provider 并重启，或回退到上一应用版本。回退不得迁移、删除或伪装已经存在的 V2 Job、内部 Run 和 Artifact；未完成账务继续按 V2 Usage 恢复规则处理。

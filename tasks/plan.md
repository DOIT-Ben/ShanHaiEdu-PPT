# PPT Agent 实施计划

## 总体路径

独立核心先用 Mock 证明状态、预算和恢复，再接 HTTP/SSE 与持久化 Worker；随后以 FrameFlow 适配器完成首个真实宿主验收。ShanHaiEdu 不在第一轮开发中耦合，但必须持续通过边界检查保证只需新增适配器。

## 阶段 0：合同和纯核心

- 冻结 Run、Action、Event、Snapshot 和 Error Schema。
- 实现状态转换、预算门禁、人工覆盖和停止策略。
- 定义 Repository、Document、Model、Image、Budget、Artifact 和 Clock Port。
- 使用内存适配器完成单步 Runner 测试。

检查点：核心无宿主/框架导入；测试、类型检查、构建通过。

## 阶段 1：持久化与恢复

- 实现 Run、Step、Issue、Event 和 Delivery Repository。
- 实现 lease、单步领取、事件 sequence 和故障恢复。
- 创建媒体任务与预算占用使用同一业务幂等键；未知提交进入人工处理。

检查点：四个崩溃边界恢复不重复提交、不重复预算。

## 阶段 2：HTTP/SSE 服务

- 实现 `/v1/runs`、快照、动作、事件和交付物 API。
- 增加租户认证适配器、cursor 分页、`expectedVersion` 和统一错误。
- SSE 支持持久化回放、心跳和跨进程可见的新事件轮询或通知。

检查点：OpenAPI、合同测试、断线重连和跨租户访问测试通过。

## 阶段 3：PPT 能力纵向切片

- 抽取教材分析、规划、Sharp 预览和 PptxGenJS 导出。
- 分块教材并保存来源定位，禁止静默截断。
- 单页质检只返回结论，Runner 决定是否在预算内重绘。
- 实现整套评估与最多两轮局部修订。

检查点：15 页 Mock 全流程和四种停止路径通过。

## 阶段 4：FrameFlow 首宿主

- FrameFlow 服务端使用独立 Agent API，不直接读取 Agent 数据库。
- 身份、附件、额度、对象存储通过 FrameFlow Adapter 映射。
- UI 使用功能开关接入 Run 列表、蓝图批准、进度、问题和交付物。
- 原快速 PPT、教材蓝图、PNG/PPTX 导出保持回归。

检查点：隔离数据库、Mock Provider、桌面和移动浏览器验收；真实请求数为 0。

## 阶段 5：测试环境验证

- 独立部署 Agent API、Worker 和数据库。
- FrameFlow 测试站执行真实但受限的 2 页验证，需另行授权。
- 记录成本、恢复、日志、备份和回退证据。

检查点：董事长验收后才进入 ShanHaiEdu 适配设计或生产发布。

## 风险

| 风险 | 缓解 |
|---|---|
| 把 FrameFlow 逻辑搬进独立仓库 | 核心边界脚本禁止宿主和框架导入 |
| 自动质检重绘绕过预算 | 质检改为无副作用结论，Runner 独占重绘决策 |
| 教材被截断仍声称完整 | chunk 来源清单、`isComplete` 和强制人工状态 |
| 双系统身份或额度混用 | tenant 外部 ID、宿主 Port 和合同测试 |
| 未知 Provider 状态重复计费 | 稳定幂等键、保留预算、人工对账，禁止换 Key |
| UI 技术栈不同 | API/SSE 为必选合同，React UI 仅为可选 SDK |

# ADR-001：PPT Agent 采用独立运行时和宿主适配器

## 状态

Accepted

## 日期

2026-07-21

## 背景

PPT 智能体首先需要在 FrameFlow 中验证，之后迁移到 ShanHaiEdu。若 Run、任务、预算和事件直接使用 FrameFlow 数据模型，第二次接入将变成重写而不是适配。

## 决策

- PPT Agent 作为独立仓库、独立服务和独立状态真源开发。
- 核心只依赖版本化领域合同和端口，不依赖 Next.js、Prisma、FrameFlow 或 ShanHaiEdu。
- FrameFlow 是第一个宿主适配器，用于验证产品闭环，不拥有 Agent 生命周期。
- ShanHaiEdu 使用相同 `/v1` API 和事件合同，差异仅存在于身份、额度、存储和产品 UI 适配器。
- 模型调用通过 Provider Port 接入现有统一模型网关。
- assist-ui 或其他 React 库只属于可替换 UI 层，不进入核心状态或持久化模型。

## 后果

- 初期需要维护独立服务和宿主适配层，开发量高于直接写入 FrameFlow。
- 运行时可独立测试、部署、升级和迁移，第二宿主不复制核心代码。
- FrameFlow 原有 PPT 流程保持为独立回退路径。
- 宿主间不会共享 Cookie、用户主键或账务表，只共享稳定外部标识和协议。

## 回退

关闭 FrameFlow 的 PPT Agent 功能开关并停止新 Run。独立服务保留既有 Run 供诊断或恢复；FrameFlow 固定 PPT 流程和数据不需要回滚。

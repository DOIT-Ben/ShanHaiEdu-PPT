# 项目工作规则

## 项目概况

- 项目名称：PPT Agent
- 项目目标：提供可独立部署、可恢复、可嵌入不同宿主系统的 PPT 智能体。
- 首个宿主：FrameFlow。
- 后续宿主：ShanHaiEdu 课件系统。
- 技术栈：TypeScript、Bun；HTTP、SSE、数据库和 UI 通过适配层接入。

## 边界

- `src/core/` 不得导入 FrameFlow、ShanHaiEdu、Next.js、Prisma 或具体 Provider SDK。
- `src/contracts.ts` 是宿主与运行时共享的稳定公共合同。
- 宿主身份使用 `tenantId`、`externalUserId` 和 `externalProjectId`，不得保存宿主 Cookie 或会话。
- 计费媒体调用必须携带稳定幂等键；未知提交状态禁止自动换 Key 重试。
- 测试默认只使用内存适配器和 Mock Provider，禁止调用真实计费模型。
- 新增外部依赖前说明用途并优先保持核心包无框架依赖。

## 命令

- 安装：`bun install --frozen-lockfile`
- 测试：`bun test`
- 类型检查：`bun run typecheck`
- 构建：`bun run build`

## 完成标准

- 公共合同、状态转换、预算和幂等行为有自动化测试。
- 核心层独立性检查不允许出现宿主或框架导入。
- FrameFlow 接入必须由功能开关保护，关闭后原 PPT 流程无行为变化。
- 生产部署、数据库迁移和真实 Provider 请求必须另行明确授权。

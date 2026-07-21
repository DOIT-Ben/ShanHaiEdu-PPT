# PPT Agent

PPT Agent 是一个宿主无关的课件智能体。它拥有自己的 Run、Step、Issue 和 Event 语义，通过版本化合同接收教材、规划页面、生成视觉素材、执行质量审查、有限修订并交付可编辑 PPTX。

FrameFlow 是第一个验证宿主，不是核心依赖。ShanHaiEdu 后续通过相同 API 和宿主端口接入。

## 当前阶段

- 已冻结独立产品边界、v1 HTTP/SSE 合同和宿主无关核心状态机。
- 已实现 SQLite 持久化、lease、预算/媒体幂等、教材完整性、蓝图、逐页质检、整套审查和有限修订决策。
- 已通过独立 Renderer/Artifact Port 生成 PNG 整套预览和包含可编辑文字对象的 PPTX，并提供归属隔离下载接口。
- 15 页 Mock 已从教材规划完整运行到交付，默认不调用真实模型或计费 Provider。
- RevisionPlan 可限定页面执行内容更新、重排和预算保护的局部重绘，并重新进入逐页与整套审查。
- 下一阶段是以功能开关接入 FrameFlow Agent API Client 和工作台。

## 目录

| 路径 | 职责 |
|---|---|
| `src/contracts.ts` | 版本化公共输入、动作、快照和事件合同 |
| `src/core/` | 状态机、预算、Runner 和宿主端口 |
| `src/adapters/` | 内存、FrameFlow、ShanHaiEdu 和 Provider 适配器 |
| `tests/` | 合同、策略、恢复和宿主兼容测试 |
| `docs/decisions/` | 架构决策 |
| `tasks/` | 规格、计划和任务清单 |

## 本地验证

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run build
```

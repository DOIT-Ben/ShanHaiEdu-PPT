# Spec: 独立可插拔 PPT Agent

## Objective

构建一个独立部署的 PPT 智能体。它不属于 FrameFlow 或 ShanHaiEdu 的内部模块，而是通过稳定 API、事件协议和宿主适配器为多个产品提供教材分析、蓝图确认、页面生成、单页质检、整套审查、有限修订和 PPTX 交付能力。

首个可验收输出是在 FrameFlow 中完整运行，但关闭接入开关后 FrameFlow 原有快速 PPT 和教材蓝图流程不发生变化。第二个宿主 ShanHaiEdu 不得要求复制或重写 Agent 核心。

## Product Boundary

PPT Agent 自己拥有：

- Run、Step、Issue、Event、Blueprint、RevisionPlan 和 Delivery 的领域语义。
- 状态机、lease、恢复、幂等、预算门禁和停止策略。
- 教材分块、来源定位、规划、整套评估和局部修订决策。
- 稳定的 `/v1` API、SSE 事件和结构化错误合同。

宿主拥有：

- 用户、租户、课程和项目身份。
- 产品入口、导航、业务权限和最终用户会话。
- 宿主额度或计费账本。
- 可选的宿主对象存储与资产目录。

模型网关拥有模型路由、上游凭据和 Provider 幂等状态。PPT Agent 不保存宿主 Cookie、网关密钥、上游真实模型 ID 或 Provider task ID 到公开事件。

## User Flow

1. 宿主使用 `tenantId`、`externalUserId`、教材和配置创建 Run。
2. Agent 分块读取教材并生成带来源范围的教学蓝图。
3. 用户确认蓝图前不创建图片任务、不占用媒体预算。
4. Agent 创建页面和图片任务，等待结果并执行单页质检。
5. 单页拒绝只产生结论；是否重绘由 Runner 在预算事务内决定。
6. 全部页面完成后生成受控预览并执行整套审查。
7. 通过质量门禁则交付；否则在最多两轮内局部修订。
8. 人工覆盖质量门禁时必须记录覆盖人、原因和原始问题，交付物标记 `qualityOverride=true`。

## Public Contracts

- API 前缀固定为 `/v1`。
- 所有创建和动作请求要求 `Idempotency-Key`。
- 所有状态动作要求 `expectedVersion`。
- 列表使用不透明 cursor 分页。
- SSE 使用持久化 `sequence`，支持 `Last-Event-ID` 和 `after`。
- 事件信封包含 `schemaVersion`，每类 payload 是可区分联合类型。
- 错误统一为 `{ error: { code, message, requestId, details? } }`。

核心资源：

- `POST /v1/runs`
- `GET /v1/runs`
- `GET /v1/runs/:runId`
- `POST /v1/runs/:runId/actions`
- `GET /v1/runs/:runId/events`
- `GET /v1/runs/:runId/deliveries/:deliveryId/content`

## State Machine

Run 状态：

- `PLANNING`
- `AWAITING_BLUEPRINT_APPROVAL`
- `EXECUTING`
- `PAGE_REVIEW`
- `DECK_REVIEW`
- `AWAITING_REVISION_APPROVAL`
- `REVISING`
- `PAUSED`
- `NEEDS_HUMAN`
- `DELIVERING`
- `COMPLETED`
- `FAILED`
- `CANCELLED`

任何非终态都允许用户取消。`EXECUTING`、`PAGE_REVIEW`、`DECK_REVIEW`、`AWAITING_REVISION_APPROVAL` 和 `REVISING` 可因预算门禁进入 `PAUSED`。`PAUSED` 只能回到已持久化的 `resumeState`。`NEEDS_HUMAN` 只有用户明确接受结果或提交限定修订后才能继续。交付失败从 `DELIVERING` 进入 `NEEDS_HUMAN`，不得把已通过审查的 Run 误标为整体失败。

## Budget Semantics

- 预算单位为整数 `budgetUnits`，由宿主适配器解释为积分、额度或内部配额。
- 初始页面、单页重绘和整套修订创建的每个媒体任务都必须计入 Run 预算。
- Runner 在创建媒体任务前原子增加 `committedBudgetUnits`；创建失败后释放，提交未知则保持占用并转人工处理。
- Agent 预算不替代宿主余额检查；两者任一拒绝都不能提交媒体任务。
- 模型不能提高预算、质量阈值或最大修订轮次。

## Curriculum Integrity

- 文档摄取返回 chunk、页码或段落定位、哈希及 `isComplete`。
- 截断、解析失败或缺页不能静默进入规划；Run 转 `NEEDS_HUMAN` 并说明缺失范围。
- 蓝图页面和事实风险必须引用相关 source chunk ID。
- 整套覆盖率基于来源清单和蓝图映射计算，不能只依据单段模型摘要。

## Tech Stack

- TypeScript 5，Bun 1.x。
- 核心层无 Web 框架和 ORM 依赖。
- 公共边界使用 Zod 4 严格校验。
- API、数据库和 Worker 通过适配器实现；首个生产适配器的具体框架在合同测试后确定。
- PPTX 组装复用经抽取后的 PptxGenJS 能力，PNG 预览复用经抽取后的 Sharp 能力。

## Commands

- Install: `bun install --frozen-lockfile`
- Test: `bun test`
- Typecheck: `bun run typecheck`
- Build: `bun run build`
- Independence: `bun run check:boundaries`

## Project Structure

```text
src/contracts.ts        公共协议
src/core/               纯领域状态机和编排
src/adapters/           基础设施与宿主适配器
src/http/               后续 HTTP/SSE 传输层
src/worker/             后续持久化 Runner
tests/                  单元、合同和集成测试
docs/decisions/         ADR
tasks/                  规格、计划和任务清单
```

## Code Style

```ts
export type HostContext = Readonly<{
  tenantId: string
  externalUserId: string
  externalProjectId?: string
}>

export interface BudgetPort {
  reserve(input: ReserveBudgetInput): Promise<ReserveBudgetResult>
}
```

- 公共枚举使用 `UPPER_SNAKE`，字段使用 camelCase。
- 核心函数接收显式依赖，不读取全局环境或数据库。
- 外部输入只在边界校验，核心内部使用已验证类型。
- 计费和状态转换不得使用静默 fallback。

## Testing Strategy

- 合同测试：所有事件、动作、错误和快照的合法/非法样例。
- 表驱动策略测试：全部合法状态转换、预算边界和终止路径。
- 故障注入：媒体任务创建前、创建后、Step 提交前后的崩溃恢复。
- 宿主兼容测试：同一核心测试套件分别运行 FrameFlow 和 Mock ShanHaiEdu 适配器。
- 端到端测试：15 页 Mock 教材完成规划、确认、生成、审查、最多两轮局部修订和交付，真实 Provider 请求数为 0。

## Boundaries

- Always：版本化合同、owner/tenant 隔离、稳定幂等键、结构化错误、Mock 先行。
- Ask first：生产数据库迁移、真实模型调用、新基础设施、正式部署和宿主账务改变。
- Never：核心导入宿主代码、保存宿主 Cookie、自动重提未知计费任务、把模型思维链写入事件、用完整教材正文写日志。

## Success Criteria

- 核心包在不安装 FrameFlow 或 ShanHaiEdu 代码的环境中构建和测试通过。
- FrameFlow 通过适配器完成 15 页 Mock 全流程，关闭开关后原功能回归通过。
- 进程在任意单步边界重启后不重复媒体提交或预算占用。
- 教材截断和来源缺失可见且阻止虚假的覆盖率结论。
- 事件重放不丢失、不乱序，未知 payload 被拒绝。
- ShanHaiEdu 接入只新增适配器、配置和 UI 集成，不修改 `src/core/`。

## Open Questions

- ShanHaiEdu 的认证、课程 ID、额度和对象存储合同，需要源码同步到服务器后映射。
- 独立服务生产数据库选择在完成 SQLite/PostgreSQL 负载基准后冻结。
- React 工作台采用 npm 包、iframe 还是宿主原生实现，在读取 ShanHaiEdu 前保持可选。

## V3：知识驱动分层课件

### Objective

为学校采购场景提供教师可直接使用、儿童观看效果出色的分层课件模式。V3 与现有“整页主视觉 + 可编辑文字”模式并存，不改变旧 Run 的行为。V3 的第一原则是知识正确，第二原则是所有可见元素可独立编辑，第三原则才是生成速度和成本。

### Product Contract

- 创建 Run 时显式选择 `LAYERED_COURSEWARE_V3`；未选择时保持 V2。
- 第一页必须是 `COVER`，默认 `INDEPENDENT` 独立设计；只有用户明确要求统一模板时才使用 `FOLLOW_TEMPLATE`。
- 每页允许 1 个独立底图对象和最多 4 个独立 AI 图片素材。底图不得写死为 PowerPoint slide background。
- AI 图片、原生文字和原生形状分别成为 PPTX 中独立对象，可移动、缩放、删除、替换和添加动画。
- 每个 AI 素材必须声明知识点、来源 chunk、用途、生成提示词、位置、尺寸、层级和可选复用键；没有知识绑定的装饰图不进入生成队列。
- 相同复用键只生成一次，可在多页作为独立图片实例复用。
- 封面不复用正文模板布局，但必须继承整套视觉方向和课程主题。
- 自动复杂动画不属于 V3 MVP；对象独立性是教师添加动画的前置保证。

### Quality And Revision

- 页面审查覆盖事实/知识相关性、图片内文字、素材质量、遮挡、越界、层级和低龄可读性。
- 整套审查额外覆盖封面冲击力、教学叙事、跨页一致性和素材重复。
- `KNOWLEDGE` 问题回到蓝图规划；`ASSET` 问题仅重生成目标素材；`LAYOUT` 问题仅重新组装，不消耗图片预算。
- 单元素重生成保持页面其他元素和复用素材不变，并使用稳定幂等键。

### V3 Success Criteria

- 合同拒绝非独立默认封面、越界位置、重复元素 ID、无来源/知识点图片和每页超过 4 个知识素材。
- Mock V3 至少生成 2 页，每页包含独立底图、多图片元素、原生文字和原生形状。
- 导出的 PPTX 中图片数量与蓝图素材数量一致，底图不是 slide background；文字仍可编辑。
- 预览按 z-index 正确合成，所有元素在 16:9 画布内且不遮挡保留文字区。
- V2 全部既有测试无回归；`bun run check` 通过。

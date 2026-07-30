# ADR-005：新增资料驱动整页视觉演示 V4

- 状态：提议
- 日期：2026-07-30
- 范围：`VISUAL_DECK_V4`

## 背景

PPT Agent 当前同时提供整页主视觉加原生文字的 V2、增加蓝图 Reflection 的 V2.1，以及素材和文字分层的 V3。它们主要在 PowerPoint 页面结构和编辑性上取舍，但用户还需要一种接近 NotebookLM Slide Deck 的能力：直接提交原始需求和多种资料，由 Agent 自主理解、规划叙事、设计逐页视觉并交付高完成度的图片型 Deck。

该能力不能继续作为 V2/V3 中的特殊分支实现。V4 的输入语义、规划工件、页面生成、OCR 门禁、修订和交付结构均与旧模式不同；若继续增加散落的模式判断，会使旧 Run 恢复、预算、缓存和质量规则互相污染。

## 决策

1. 新增公共模式 `VISUAL_DECK_V4`，与 `SLIDE_IMAGE_V2`、`SLIDE_IMAGE_V2_1`、`LAYERED_COURSEWARE_V3` 并存。
2. V4 每页交付一张完成态图片，PPTX 只作为整页图片容器，不承诺元素可编辑。
3. V4 的资料理解、PresentationSpec、DeckPlan、Slide Brief、Visual Contract 和 DeckManifest 由 PPT Agent 生成并拥有；宿主只提供原始输入和业务能力。
4. V4 初始生成和后续修订均绑定 Sources，不采用脱离来源的自由修订作为默认行为。
5. 页面内部可以使用全生成或确定性栅格合成，但最终交付结构和质量门禁一致。
6. 在实现 V4 前建立显式的 `PresentationModeStrategy` 边界，模式负责规划、素材需求、质量策略、修订和交付；Run、Repository、预算、幂等、事件、附件和 Artifact Port 继续复用。
7. 旧 Run 按创建时保存的 `presentationMode`、`compilerVersion` 和输入哈希恢复，不自动升级或迁移。

建议的内部策略接口只表达能力边界，不要求一次性重写全部旧实现：

```ts
interface PresentationModeStrategy {
  plan(input: PlanInput): Promise<PlanResult>
  compile(input: CompileInput): Promise<CompileResult>
  imageRequirements(input: ImageRequirementInput): readonly ImageRequirement[]
  reviewPolicy(input: ReviewPolicyInput): ReviewPolicy
  revise(input: RevisionInput): Promise<RevisionResult>
  deliver(input: DeliveryInput): Promise<DeliveryResult>
}
```

旧模式可以先由兼容适配器包裹，再逐步移动实现。策略选择必须在 Run 创建时冻结，运行中不得根据来源类型或宿主请求静默切换模式。

## 兼容性约束

- 新增 V4 字段使用可区分联合类型，不给旧模式增加无意义的必填字段。
- V2、V2.1、V3 的默认值、预算单位、缓存键和交付结构保持不变。
- V4 的缓存键必须包含模式、编译器版本、Visual Contract、Slide Brief 和页面修订版本。
- V4 的事件可以扩展新 payload，但必须保持版本化信封和未知事件拒绝语义。
- FrameFlow 通过功能开关启用 V4；关闭后不得改变现有模式的请求和界面行为。
- V4 的图片型交付必须在报价和确认界面明确标注“页面元素不可独立编辑”。

## 后果

### 优点

- PPT Agent 可以直接从原始资料完成理解、规划和高完成度视觉创作。
- 图片型页面绕开 PowerPoint 原生复杂布局，获得更高视觉自由度。
- 结构化中间工件使来源、规划、页面、审查和修订可验证、可恢复。
- 模式隔离降低新增 V4 对旧能力和旧 Run 的回归风险。

### 代价

- 整页图片不可精细编辑，中文、数字和公式必须增加 OCR/确定性修正门禁。
- 多阶段规划和页级质量重试增加延迟、存储和模型成本。
- 模式策略边界需要先处理现有分支逻辑，不能只增加一个枚举完成集成。
- V4 质量必须依赖固定资料集和同题版本评测，不能只以主观视觉评价发布。

## 发布门禁

1. V4 规格和公共合同经人工确认。
2. V2、V2.1、V3 全量回归通过。
3. Mock V4 从原始来源运行到图片型 PPTX/PDF 交付。
4. 固定测试集验证来源、锁定文案、页数、跨页污染、修订隔离和恢复。
5. 隔离测试环境完成受控真实图片验证后，才允许申请生产发布。

## 回退

V4 通过独立功能开关和模式枚举接入。回退时关闭宿主 V4 入口并停止创建新 V4 Run；已创建 Run 保持可查询和可下载，不得把 V4 Run 改按 V2/V3 恢复。代码回退必须保留对已有 V4 快照和事件的只读兼容。

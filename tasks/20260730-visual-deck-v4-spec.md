# Spec：PPT Agent V4 资料驱动整页视觉演示

## 0. 当前假设

1. 本版本正式命名为 `V4`；对话中出现的“V10”不表示另一个并行版本。
2. 公共模式标识暂定为 `VISUAL_DECK_V4`，最终名称在公共合同变更前冻结。
3. V4 与 V2、V2.1、V3 并存，不迁移旧 Run，不改变旧模式的生成、计费、恢复和交付行为。
4. V4 的最终 PPTX 每页是一张铺满 16:9 画布的完成态图片，不承诺页面元素可编辑。
5. FrameFlow 只传递原始指令、相关对话、附件引用和用户明确约束；理解、规划、视觉编译、生成、审查和修订归 PPT Agent。

## 1. 目标

构建接近 NotebookLM Slide Deck 体验的资料驱动演示模式。用户可以只输入一句话，也可以同时提供教材、教案、设计稿、参考 PPT、品牌手册和图片。PPT Agent 自主判断资料角色、提取依据、规划整套叙事和逐页视觉表达，最终交付高完成度的图片型 PPTX/PDF。

V4 的成功不以“模型生成了一组图片”为标准，而以以下结果为标准：

- 用户不需要由 FrameFlow 预先编写大纲、逐页设计或图片 Prompt。
- 每页有可追溯的内容依据、明确认知任务和独立视觉简报。
- 整套 Deck 有统一视觉语言和连续叙事，不出现跨页 Prompt 污染。
- 锁定文案、数字和公式经过确定性核对，不能以视觉效果替代正确性。
- 单页失败和修订只影响对应页面，旧合格页面不重做。

## 2. 产品定位与版本矩阵

| 模式 | 页面结构 | 核心用途 | 编辑性 | 本轮处理 |
|---|---|---|---|---|
| `SLIDE_IMAGE_V2` | 无文字底图 + 原生标题/正文 | 稳定图文课件 | 文字可编辑 | 保持原行为 |
| `SLIDE_IMAGE_V2_1` | V2 + 蓝图 Reflection | 更强规划质量 | 文字可编辑 | 保持原行为 |
| `LAYERED_COURSEWARE_V3` | 图片、文字、形状分层 | 高编辑性课件 | 高 | 保持原行为 |
| `VISUAL_DECK_V4` | 每页一张完成态视觉图片 | NotebookLM 式视觉叙事 | 低 | 新增 |

FrameFlow 的普通用户界面不得要求教师理解内部版本号。产品名称建议映射为“图文可编辑”“精细可编辑”“视觉演示”，具体技术模式由服务端保存并在诊断视图展示。

## 3. 职责边界

### FrameFlow

- 判断当前需求是否为 PPT 制作任务。
- 保存用户、会话、附件、权限、报价、积分和交付入口。
- 传递用户原始指令、相关对话原文、附件引用和明确约束。
- 展示 Agent 的必要追问、Deck Proposal、逐页进度、问题、修订和交付物。
- 明确告知 V4 为图片型 PPT，页面元素不可独立编辑。

FrameFlow 不得生成 Deck Plan、Slide Brief、Visual Contract、页面 Prompt 或版式坐标，也不得用摘要替代原始输入。

### PPT Agent

- 解析资料并判断内容来源、教学约束、结构参考、视觉参考、品牌规范和可复用素材。
- 编译 PresentationSpec，必要时返回最少量澄清问题。
- 基于来源规划 Deck、Slide Brief 和全局视觉契约。
- 逐页生成、核验、重试、持久化和聚合完成态图片。
- 执行页面及整套质量门禁，处理有来源约束的页级修订。
- 输出图片型 PPTX、PDF、预览及可追溯 Delivery Manifest。

## 4. 用户输入合同

V4 创建请求至少表达以下语义：

```ts
type VisualDeckV4Request = Readonly<{
  presentationMode: 'VISUAL_DECK_V4'
  instruction: string
  conversationContext?: readonly MessageReference[]
  sources: readonly SourceReference[]
  deckOptions: {
    deckType: 'DETAILED_DECK' | 'PRESENTER_SLIDES'
    language: string
    length: 'SHORT' | 'DEFAULT' | 'LONG' | { slideCount: number }
    aspectRatio: '16:9'
    audience?: string
    focus?: string
    styleHint?: string
  }
}>
```

`SourceReference` 可以携带用户明确给出的 `roleHint`，但 `AUTO` 必须可用。角色候选包括 `CONTENT_SOURCE`、`TEACHING_GUIDE`、`STRUCTURE_REFERENCE`、`DESIGN_REFERENCE`、`BRAND_GUIDE` 和 `ASSET`。

有来源时默认进入 `SOURCE_GROUNDED`；只有 Prompt 而没有来源时进入显式的 `OPEN_KNOWLEDGE`，Proposal 必须提示内容不是基于用户资料生成。两种模式不得静默混用。

## 5. 可持久化中间工件

V4 不采用一个不可检查的长 Prompt 贯穿全流程。每一步输出结构化、版本化、可重放的工件：

1. `SourceUnderstanding`：资料角色、解析状态、可用范围和缺失范围。
2. `PresentationSpec`：受众、目标、Deck 类型、语言、长度、重点、风格、禁区和来源模式。
3. `DeckPlan`：故事主线、章节、页面预算、覆盖要求和顺序。
4. `SlideBrief[]`：每页角色、核心观点、锁定文案、来源依据、视觉隐喻、构图和与前后页关系。
5. `VisualContract`：整套配色、媒介、字体感觉、人物/场景、信息密度、禁用样式和跨页一致性规则。
6. `RenderedSlide[]`：完成态图片、版本、哈希、生成策略和质量结果。
7. `DeckManifest`：输入、编译器、工件、页面、审查、修订和交付哈希链。

`PresentationSpec`、`DeckPlan`、`SlideBrief[]` 和 `VisualContract` 共同组成 V4 Proposal。用户确认 Proposal 和费用上限后才允许提交付费图片任务。

## 6. 规划与页面生成

### 资料理解

- 教材事实不能被设计稿或品牌手册覆盖。
- 设计稿只约束页面结构、内容锁定项和视觉表达，不直接成为图片 Prompt。
- 参考 PPT 必须区分内容复用与风格参考；低置信度且会改变结果时才询问用户。
- 来源缺页、解析失败或关键区域不可读时，不得声称已完整理解。

### Deck 规划

Deck Planner 先确定故事主线、章节、页面数量和每页功能，再生成页面。不得把来源摘要平均拆页，也不得一开始逐页独立创作后再拼成整套。

### Slide Brief

每页只承担一个主要认知或沟通任务。Slide Brief 至少包含：

- `role`、`keyClaim`、`audienceTakeaway`；
- `lockedCopy`、`facts`、`numbers`、`formulas`；
- `sourceEvidence` 和允许推断范围；
- `visualMetaphor`、`composition`、`informationHierarchy`；
- `previousSlideRelation`、`nextSlideRelation`。

### 整页生成

最终每页必须是一张完整 16:9 图片。内部允许两种执行策略，由 Agent 按页面风险选择：

- `FULL_GENERATIVE`：图像模型直接生成完成态页面，适合封面、章节、故事和低文字视觉页。
- `CONTROLLED_RASTER`：先生成视觉，再用确定性排版写入锁定文字、数字、公式或图表，最终扁平化为一张图片。

两种策略的交付结构完全相同。`CONTROLLED_RASTER` 不是 V2/V3 的可编辑输出，不得在产品上承诺元素可编辑。

## 7. Prompt 编译约束

单页图片请求只能包含：

- 当前 Slide Brief；
- Visual Contract 中与当前页相关的稳定约束；
- 必要的参考图片和相邻页低分辨率风格参考；
- 当前页修订指令。

不得包含其他页面全文、整套逐页设计稿、内部状态、用户权限或计费信息。全局风格必须先压缩为稳定的 Visual Contract，不得再次把原始整套设计稿拼入每页 Prompt。

## 8. 质量门禁

### 页级门禁

1. `CONTENT_GROUNDING`：关键观点、事实、数字和公式与 Slide Brief/来源一致。
2. `OCR_COPY_MATCH`：锁定文案与完成态图片 OCR 结果一致；关键标题、数字和公式不得容错。
3. `VISUAL_QUALITY`：无裁切、拼贴、异常字符、水印、遮挡和不可读区域。
4. `INSTRUCTION_FOLLOWING`：当前页构图、重点和视觉隐喻符合 Slide Brief。

### 整套门禁

- 来源覆盖完整，叙事连续，页面顺序合理。
- 配色、媒介、人物、场景和信息密度符合 Visual Contract。
- 不存在重复页面、跨页内容泄漏或相邻页逻辑断裂。
- 所有页级阻断问题关闭后才允许交付。

质量失败最多执行有界页级修订；同一失败重复达到上限后进入 `NEEDS_HUMAN`，不得无限消耗预算。平台质量重试与用户主动改稿在账务上必须区分。

## 9. 修订与版本

- 用户可以修改单页文字、布局、视觉，删除或重排页面。
- 修订必须重新载入该页来源依据，不复制 NotebookLM“修订脱离 Sources”的缺陷。
- 每次修订产生新的不可变 Deck/Slide 版本，保留父版本和差异摘要。
- 未受影响页面复用原图片、审查结果和哈希，不重新生成或收费。
- 最终 DeckManifest 必须指向实际交付的每页版本。

## 10. 状态与集成

V4 复用现有 Run 主状态：

```text
PLANNING
→ AWAITING_BLUEPRINT_APPROVAL
→ EXECUTING
→ PAGE_REVIEW
→ DECK_REVIEW
→ DELIVERING
→ COMPLETED
```

`PLANNING` 内部用持久化 Step 区分资料理解、PresentationSpec、DeckPlan、Slide Brief 和 Visual Contract。页级生成、审查、修订和恢复继续使用稳定幂等键。旧 Run 必须按创建时保存的 `presentationMode` 和 `compilerVersion` 恢复原策略。

## 11. 交付合同

V4 交付至少包含：

- 逐页完成态 PNG；
- 整套预览；
- 每页一张铺满画布图片的 PPTX；
- PDF；
- `DeckManifest`，记录来源、模式、编译器、页面版本、质量结果和交付哈希。

预览、PPTX 和 PDF 必须复用同一组 `RenderedSlide`，不得各自重新排版或重新生成。

## 12. 非目标

- 不在 V4 中提供可编辑文字、Shape、图表或动画承诺。
- 不迁移或替换 V2、V2.1、V3。
- 不允许 FrameFlow 预编译页面 Prompt 或复制 PPT Agent 规划逻辑。
- 不做无限自主重试，不让模型调整预算和质量阈值。
- 不以某一个课程名称、教材标题或固定 12 页内容建立专用生产分支。
- 不在第一阶段同时扩展所有输入格式和任意页数。

## 13. MVP 范围

- 输入：单课时教材 PDF；可选教案、逐页设计稿、参考 PPT 或图片。
- 输出：16:9，默认约 12 页，支持 `DETAILED_DECK` 和 `PRESENTER_SLIDES`。
- 页面：封面、章节、情境、解释、对比、过程、练习、总结等通用角色。
- 修订：页级文字/视觉修改、删除、重排；不新增复杂动画。
- 交付：逐页 PNG、总览、图片型 PPTX、PDF 和 DeckManifest。

## 14. 验收标准

- 五类输入场景通过：纯 Prompt、教材、教材+教案、教材+设计稿、教材+参考 PPT/图片。
- FrameFlow 请求不包含 Deck Plan、Slide Brief 或图片 Prompt，PPT Agent 可独立完成规划与制作。
- 默认 12 页运行产生 12 个独立 Slide Brief、12 张完成态图片和同页数 PPTX/PDF。
- 每页只引用自身 Brief 和必要全局视觉约束，不出现其他页标题、缩略图或流程拼贴。
- 所有锁定标题、关键数字和公式与 Slide Brief 一致；不一致页面不得交付。
- 预览、PPTX 和 PDF 使用同一组图片，页面像素内容一致。
- 修改一页只产生该页新版本，其他页面哈希、质量结果和计费不变。
- Worker 在规划、生成、审查和交付边界重启后不重复提交媒体任务。
- V2、V2.1、V3 合同、Mock E2E、恢复、预算和交付回归全部通过。

## 15. 后续规格门禁

本规格经人工确认后，下一阶段才允许：

1. 冻结公共枚举、V4 请求和中间工件 Schema。
2. 设计模式策略接口与旧模式兼容适配。
3. 编写分阶段实施计划和任务清单。
4. 实现 Mock V4 纵向切片。

生产数据库迁移、真实模型调用、测试环境部署和生产发布均需另行明确授权。

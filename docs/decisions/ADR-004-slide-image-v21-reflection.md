# ADR-004：整页生图 V2.1 使用结构化 Reflection

- 状态：已采纳
- 日期：2026-07-24
- 范围：`SLIDE_IMAGE_V2_1`

## 背景

`SLIDE_IMAGE_V2` 每页生成一张 16:9 主视觉，再由 Renderer 叠加标题和正文。现有规划只生成一次 Blueprint；合同修复只能纠正字段、页数和来源引用，不能判断受众、叙事、构图和提示词是否足够好。

Gemini Notebook 官方帮助说明，Slide Deck 在生成前允许选择 Detailed Deck 或 Presenter Slides，并允许指定受众、风格、重点、大纲、长度和语言；生成后还可以逐页修改文字、版式和视觉，再生成整套修订版。这些公开能力说明高质量结果依赖明确的输出意图和修订闭环，而不只是更强的图片模型：

- https://support.google.com/gemininotebook/answer/16757456?hl=en
- https://support.google.com/gemininotebook/answer/16206563?hl=en

Google 公开确认 Nano Banana 用于 NotebookLM Video Overviews 的来源相关插画，但没有公开确认 Slide Deck 使用的具体模型或内部编排。因此 V2.1 不把“NotebookLM Slide Deck 使用 Nano Banana 或 Reflection”当作已知事实：

- https://blog.google/innovation-and-ai/products/nano-banana-google-products/
- https://blog.google/innovation-and-ai/models-and-research/google-labs/video-overviews-nano-banana/

Andrew Ng 对 Reflection 的定义是：先生成初稿，再自动给出批评，最后把初稿和批评共同作为上下文进行重写：

- https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-2-reflection/

## 决策

新增显式模式 `SLIDE_IMAGE_V2_1`，保留 `SLIDE_IMAGE_V2` 和 `LAYERED_COURSEWARE_V3` 的原行为。

V2.1 的规划链路为：

1. 使用现有来源约束生成初稿 Blueprint。
2. 把初稿、用户视觉方向、可选目标受众和演示目标交给同一结构化模型。
3. 模型必须先按七项 rubric 输出诊断，再返回完整修订 Blueprint。
4. 核心层重新执行页数、来源引用和 Blueprint 合同校验。
5. 只有修订稿通过校验才进入人工蓝图确认和后续图片生成。

七项 rubric 为：受众适配、目标一致、叙事、信息层级、构图、跨页视觉一致性、提示词可执行性。

图片提交前，V2.1 还会用确定性规则补齐 16:9、版式安全区、全局画风、无文字、无水印、无边框和自然留白约束。模型负责创意判断，程序负责不可省略的执行约束。

## 成本与失败语义

- 每次规划增加一次文本模型调用。
- 不增加图片生成次数，仍为每页一张图。
- Reflection 的 Provider 或合同失败会使规划失败并进入现有人工恢复流程，不静默降级到未反射初稿。
- 旧模式不自动迁移；FrameFlow 必须显式选择 V2.1。

## 后果

优点：受众和目标进入规划上下文；提示词有独立质量评审；跨页风格和页面叙事在出图前修正；失败可观察且可重放。

代价：规划延迟和文本模型成本增加；Reflection 仍不能保证图片模型完全遵循构图；真实质量提升必须通过同题 A/B 图片验收确认。

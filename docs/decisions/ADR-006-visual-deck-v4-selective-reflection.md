# ADR-006：Visual Deck V4 使用选择性 Reflect-and-Revise

- 状态：已被 ADR-008 取代（保留为 chain-2 历史决策）
- 日期：2026-08-03
- 范围：`VISUAL_DECK_V4`

## 背景

V4 原链路使用 Source/Spec、Deck/Visual、Slide Briefs 和 Final Coherence 四次结构化调用。
Final Coherence 只能确认五项高层一致性，不能修正已经进入逐页施工单的图片模型执行风险。真实
《5以内数的分与合》用例中，第 6 页的重复圆片构图和第 12 页的三段式视觉提示均通过该审查，
随后分别诱发数量矛盾和未授权编号。

本决策参考以下公开方法，但不把论文结果直接当作本产品质量承诺：

- Self-Refine：候选产物经过具体反馈和有界迭代，无需额外训练；
  <https://arxiv.org/abs/2303.17651>
- Anthropic Evaluator-Optimizer：评价标准明确、反馈可验证时，生成与评价循环才值得增加成本；
  <https://www.anthropic.com/engineering/building-effective-agents>
- CRITIC：关键约束不能只依赖模型自评，需要工具或程序反馈；
  <https://arxiv.org/abs/2305.11738>
- Reflexion：跨尝试的语言记忆与立即修订当前产物是不同机制；本决策只实现后者；
  <https://arxiv.org/abs/2303.11366>
- 内生自我纠正存在退化风险，因此不能使用无证据、无边界的重复反问；
  <https://arxiv.org/abs/2310.01798>

## 决策

正常规划链路固定为五次文本模型调用：

```text
Source Understanding + Presentation Spec
-> Deck Plan + Visual Contract draft
-> Reflect-and-Revise Deck/Visual
-> Slide Briefs draft
-> Reflect-and-Revise Slide Briefs
-> deterministic validation and prompt compilation
```

旧 Final Coherence 调用由 Slide Brief 反射替换；正常任务只比旧链路增加一次调用。反射以整套
Deck/Visual 或整套 Slide Briefs 为单位，禁止逐页调用。

每个反射请求必须分别传递原始请求、受信来源、冻结约束、候选产物及哈希、Rubric 版本和整页
图片型 PPTX 的 Provider 能力。资料只作为数据，CONTENT_SOURCE 决定事实，DESIGN_REFERENCE
只约束视觉。

模型一次返回审查与定向修订结果：

- `UNCHANGED`：12 个 Rubric 维度全部通过，候选产物保持不变；
- `REVISED`：每个 finding 包含证据、风险、页码、字段路径和可执行指令；Deck/Visual 返回完整
  修订产物，Slide Briefs 只返回受影响页面的视觉字段补丁。

核心层而非模型负责最终裁决：校验候选哈希、Zod 合同、冻结字段、来源引用、页数页序、可见文字、
字段级深差分和局部合并。每个变化必须被已应用 finding 覆盖，每个已应用 finding 必须产生实际变化。

Slide Brief 反射允许修改 `role`、视觉隐喻、构图、信息层级及前后页关系；页码、标题、核心主张、
受众收获、锁定文字、事实、数字、公式和来源引用均冻结。这样可以修正图片执行风险而不让反射阶段
破坏教学事实。

Slide Brief 补丁必须且只能回传页码与上述六类可修改字段，不能回传任何冻结内容。核心按页码把补丁
合并到已验证候选产物，冻结值直接从候选产物继承。真实 12 页验收证明，让模型回传“完整受影响页”
会迫使它重复抄写冻结字段，并因轻微改写触发 `V4_REFLECTION_FROZEN_FIELD_MUTATION`；因此冻结约束
必须通过输出能力边界实现，不能只依赖提示词要求模型逐字复制。

## 持久化、恢复与成本

- `reflect-deck-visual` 和 `reflect-slide-briefs` 使用独立稳定幂等键；候选哈希、Rubric 版本和已预检
  协议进入 Step 输入哈希。
- 每个成功结果立即持久化；重启只恢复当前阶段，不重新执行已完成阶段。
- Provider 超时沿用 V4 技术恢复并使用原键；响应未知时不得换键提交。
- 默认每个节点只反射一次，不启用逐页循环或无限自我修订。
- 独立 Evaluator + Optimizer 作为未来高风险升级点保留，但只有质量语料证明额外调用有收益后才能启用。

## 后果

优点：高杠杆规划错误在图片计费前被定位和定向修正；未命中页面不会被整套重写；反射结果可审计、
可重放并可用程序验证。

代价：正常规划增加一次文本模型调用和相应延迟；模型反射仍不能代替图片生成后的页审与整套审查。

## 拒绝方案

- 所有阶段机械执行两遍：延迟和成本翻倍，且简单抽取阶段没有相应收益。
- 固定 Evaluator 再固定 Optimizer：每个反射点增加两次调用，不符合当前成本边界。
- 每页单独反射：10 页即增加 10 次调用，破坏整套叙事视角和延迟目标。
- 只提示“请优化”：没有证据、修改范围和验收条件，无法审计或验证。
- 反射后整套自由重写：可能修复一页却破坏其余页面，无法证明冻结内容保持不变。
- 无限循环到模型自称通过：缺少外部证据，成本无界且结果不保证单调提高。

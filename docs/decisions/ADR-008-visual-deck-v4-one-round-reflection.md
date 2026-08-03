# ADR-008：Visual Deck V4 使用节点专用的一轮质量反射

- 状态：已采纳
- 日期：2026-08-03
- 范围：`VISUAL_DECK_V4`，编译器 `visual-deck-v4-chain-3`
- 取代：ADR-006 的单次 Reflect-and-Revise 合同

## 决策

统一的是边界原则，不是万能反射合同：

```text
已验证候选
-> 程序硬规则校验
-> Critic 1 次
-> 有问题时 Optimizer 1 次
-> 程序合并与复验
-> 继续主链
```

Deck 一致性和 Slide Brief 质量使用各自的 issue 枚举、可写字段和 Patch Schema。Critic 只报告问题；
Optimizer 只返回被 issue 授权字段的新值。Hash、稳定 ID、冻结字段、Patch 合并、元数据和最终裁决均由
后端维护。模型不返回完整候选，也不拥有页数、章节、教学文案、事实、数字、公式和来源的写权限。

每个节点最多一次 Critic 和一次可选 Optimizer。响应已经提交但结果未知时，可以用完全相同的输入、协议
和 Idempotency-Key 恢复一次；这属于同一业务调用的传输恢复，不增加反射轮次。不存在 Critic repair、
Optimizer repair、第三次业务调用或 Run 级五轮反射恢复。

## 失败边界

- 页数、连续页码、公式、来源、冻结文案和 Proposal 合法性是程序硬校验，失败必须阻断。
- Critic 合同或 Provider 失败时记录 `REFLECTION_SKIPPED`，使用反射前候选继续。
- Optimizer 无效、越权、no-op 或不可用时丢弃 Patch，使用反射前候选继续。
- 跳过原因只记录 `CONTRACT_INVALID`、`PROVIDER_UNAVAILABLE` 或 `PATCH_REJECTED`，不能伪造
  `APPROVED`、`UNCHANGED` 或人工审批。
- 质量反射不替代生成后的 OCR/视觉页审、问题页重生成和整套审查。

## 依据与取舍

本决策继续采用 ADR-006 已记录的 Evaluator-Optimizer、Self-Refine 和程序反馈原则，但收窄其工程实现：
只在两个高杠杆质量节点使用反射，不让确定性校验进入模型循环，也不让所有节点机械执行两次。

正常路径包含 3 次生成和 2 次 Critic，共 5 次文本调用；每个 Critic 发现问题时最多增加 1 次 Optimizer，
整套规划最多 7 次文本调用。该上限控制延迟和成本，同时避免前序规划偏差直接传递到付费图片生成。

# ADR-011：Quick-Deck 真实评测隔离边界

## 状态

Accepted

## 日期

2026-08-07

## 背景

PPT Agent 需要一个能真实评测 V4 创意规划、异步出图、16:9 像素比例和 PPTX 封装的快速通道。把此类实验复用为 V1 Run 会触发宿主资料、预算、Usage V2、质量审查、返修和恢复合同，既增加费用与状态耦合，也会把测试结果伪装成正式交付。

## 决策

- 新增 `/v1/evaluations/quick-decks` 资源族。它只接受受控文本和 `1-10` 页 V4 请求，执行一次 `CreativeManuscript` Responses JSON Schema 调用、异步图片 submit/inspect、实际像素比例检查和 PPTX 封装。
- 使用独立 `PPT_AGENT_QUICK_DECK_EVALUATION_API_TOKEN`。该 Token 只能调用评测资源，不能调用 V1 或 V2；普通、管理员、V2 Token 也不能调用评测资源。Token 决定 tenant，显式 tenant 覆盖头被拒绝。
- 每次创建都是独立实验，不使用调用方幂等键。SQLite、事件序列和制品根独立于 V1/V2；公开响应不包含内部 Prompt、来源正文、蓝图、Provider 路由、artifact ID 或密钥。
- 文本和图片模型必须来自 V4 已公布白名单。quick-deck 文本传输固定为 `RESPONSES`，图片通过统一网关的异步任务协议执行；封装前必须读取实际像素并拒绝非 `16:9` 图像。
- 评测不进入 Run、Usage V2、预算、审查、返修、宿主回调或自动恢复。进程重启时未终态评测写为 `EVALUATION_INTERRUPTED`，不会重提交付费请求。
- TTL 到期后先在专属本地 artifact 根删除所有页面图、预览和 PPTX；全部删除成功后才公开 `EXPIRED`。评测 SQLite/制品不纳入正式 Run/V2 备份。

## 后果

- 评测可以记录真实模型、耗时、比例和交付摘要，同时不会污染正式产品口径或预算事实。
- 调用方必须把 `COMPLETED` 与“真实一次实验完成”区分于质量认证；质量分数保持 `NOT_ASSESSED`，需要固定评测集或人工 Rubric 才能另行产生。
- 主进程必须使用 gateway 模式、专属 Token、专属数据根和 V4 模型白名单才能启用该通道。未配置时路由不可用，既有 V1/V2 行为不变。
- 当前 SQLite 根是单进程写边界。横向扩展评测 worker 前必须增加跨进程 lease 或 compare-and-swap，不能仅增加进程数。

## 回退

取消专属 Token 配置或回退到上一版本即可停止新增实验；不得把已有评测任务迁移为 V1 Run、V2 Job 或正式 Delivery。过期任务仍按专属 TTL 清理；未到期的评测目录可保留到 TTL 后自动删除。

# ADR-012：V4 图片编辑必须经真实验收显式启用

## 状态

Accepted

## 日期

2026-08-07

## 背景

V4 已把初稿图片固定为异步网关任务，并在入库前检查实际像素比例。此前运行时仍把
`gpt-image-2` 作为默认局部编辑模型公开和调用，但真实验收显示该模型的文生图结果可为
`3:2`，而图片编辑请求也未满足统一网关的编辑合同。仅因环境变量存在模型名就把它列为
可用，会让 V4 返修进入已知不可用的付费路径。

## 决策

- `PPT_AGENT_V4_IMAGE_EDIT_ENABLED` 与 `PPT_AGENT_V4_IMAGE_EDIT_ASYNC_TASK_ENABLED` 默认均为
  `false`。两者同时显式启用、网关已声明 `IMAGE_TASK + IMAGE_EDIT + by-idempotency` 后，
  `PPT_AGENT_V4_REVISION_IMAGE_MODEL` 仅成为可做隔离验收的候选模型，不自动成为公开能力。
- 候选模型必须另外在 `PPT_AGENT_V4_MODEL_REGISTRY_JSON` 中拥有 `published=true`、未过期
  `readiness.status=PASSED` 的真实验收记录，且只读网关目录预检为 `HEALTHY`，新 V4 返修批次才能使用图片编辑。
  `evaluationEnabled` 只决定隔离评测资格，与发布资格完全独立。
- 新 V4 返修始终提交异步 `/image-tasks`，持久化 operation ID、模式和原幂等键后再轮询；不得退回
  同步 `/images/edits`。同步接口仅保留给不属于已发布 V4 返修的兼容验收路径。
- 未发布、验收过期或目录不可用时，`GET /v1/capabilities` 返回 `visualDeckV4.models.imageEdit: []` 或
  相应 `modelAvailability` 状态。空数组表示当前没有已发布的编辑能力，不以占位模型名代替；目录可见
  不能代替真实请求、像素和恢复验收。
- 需要 Provider 局部图片编辑的新 V4 返修在预算冻结和 Provider 提交前以 `IMAGE_EDIT_UNAVAILABLE` 结束；不得静默改用
  其他模型、重写幂等键或伪装为成功。
- 已经持久化图片编辑步骤或返修批次的 Run 继续读取其冻结的模型、模式、Repair Contract 和
  幂等键恢复。开关只影响尚未建立返修路由的新批次。

## 后果

- 当前可公开的 V4 图片能力是通过实际比例验收的异步初稿图；图片编辑不会再造成已知的
  合同错误或无效计费。
- 下游必须读取 capabilities，而不是假定编辑模型总是存在。启用任何新编辑模型前，需要完成
  真实请求、网关合同、实际像素和恢复幂等性验收，并补充对应的 Usage V2 成本档案。
- 旧的已持久化 Run 仍可恢复，但不能据此把该模型重新发布给新 Run。

## 回退

在隔离环境完成上述验收后，设置
`PPT_AGENT_V4_IMAGE_EDIT_ENABLED=true`、`PPT_AGENT_V4_IMAGE_EDIT_ASYNC_TASK_ENABLED=true` 与候选模型名，并写入
有效的已发布注册表记录，即可重新开放新批次的局部编辑。若验收失败、记录过期或网关退化，撤销发布或等待
预检恢复即可停止新增编辑调用；不得删除或迁移仍在恢复的历史图片编辑步骤。

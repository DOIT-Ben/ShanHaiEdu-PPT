# ShanHaiEdu 图片文字 V1 接入规范

负责人：PPT Agent

受众：PPT Agent 与 ShanHaiEdu 后端开发者

规范路径：本文件记录 Agent 侧接入边界；山海运行时事实以 ShanHaiEdu 的 Issue、合同、代码和数据库为准。正式 Adapter 合并后，如机器合同发生变化，应更新或替代本文件。

## 目标

第一版只验证一条最短纵向链：读取已批准的逐页规格和图片 Artifact，将图片放入固定槽位，再叠加 PPT 原生可编辑文字，输出页面联系表和可打开的 PPTX。PPT Agent 保持独立包，ShanHaiEdu 通过 Adapter 调用，不复制渲染业务逻辑。

对齐基线为 ShanHaiEdu `origin/main` 的 `4a320c7`：其目录已声明 `ppt.pages.assemble`、`pptx.export`、`ppt.final.validate` 和 `ppt.final.approve`，但当前状态明确说明 PPTX 装配、媒体生成和最终交付仍需独立 Issue 实现。

## 责任边界

| 责任 | PPT Agent | ShanHaiEdu |
|---|---|---|
| 图片文字页合同与校验 | 实现 | 通过发布内容合同选择版本 |
| 图片归一化、布局、文字叠加 | 实现 | 不复制 |
| PNG 联系表和 PPTX 字节生成 | 实现 | 调用并接收结果 |
| 组织、用户、项目和课时权限 | 不保存业务真相 | 唯一事实源 |
| WorkflowRun、BranchRun、NodeRun | 不建立山海镜像 | 唯一事实源 |
| ContentRelease、WorkflowDefinitionVersion | 只接收冻结标识 | 唯一事实源 |
| Artifact、ArtifactVersion、关系与 stale | 通过 Port 读写 | 唯一事实源 |
| Provider 路由、密钥、用量与 Attempt 恢复 | 不直接持有 | 统一模型网关与运行时负责 |
| 最终技术校验和人工批准 | 不越权通过 | `ppt.final.validate` 与 `ppt.final.approve` 负责 |

FrameFlow 可以继续使用 Agent 自有 Run/Step 状态机。山海嵌入模式使用宿主锚定的交付服务，不把 Agent 自有数据库变成第二套山海工作流事实源。

## V1 节点映射

山海正式拓扑把页面装配和 PPTX 导出拆成两个确定性节点，Adapter 必须保留该边界：

| 山海节点 | 输入 | V1 输出与处理 |
|---|---|---|
| `ppt.pages.assemble` | `artifact:ppt_page_specs`、`asset:image_collection`、`contract:ppt_style` | 校验页规格与固定槽位，调用 `ShanHaiPptDeliveryServiceV1`；将 PNG 预览登记为 `artifact:ppt_page_previews` |
| `pptx.export` | 页面预览、页规格、图片集合 | 将同次确定性渲染产生的 PPTX 登记为 `asset:pptx`，建立来源关系；不得把 PPTX 记为页面装配节点的活动产物 |
| `ppt.final.validate` | PPTX、页规格、批准教案 | 继续使用山海的可打开性、渲染一致性、教学范围和布局校验 |
| `ppt.final.approve` | PPTX、最终质量报告 | 继续使用山海人工批准门禁 |

当前 Agent 为减少 V1 重复渲染，在一次调用中同时生成联系表和 PPTX。这个组合调用是 Agent 内部优化，不改变山海的两个节点语义。正式 Adapter 应在同一受控编排中保存两份字节，再分别由对应 NodeRun 原子登记；下一版可把组合服务拆成显式 `assemble` 和 `export` 方法。

## 合同映射

`shanHaiPptDeliveryRequestV1Schema` 接收以下冻结上下文：

- `organization_id`、`project_id`：必须与认证后的 `HostContext` 一致；
- `workflow_run_id`、`node_run_id`：由山海创建，Agent 不生成；
- `content_release_id`、`workflow_definition_version_id`：用于证明本次执行使用的发布版本；
- `lesson_unit_id`、`lesson_key`、`branch_key=ppt`：限定课时和分支；
- `node_key=ppt.pages.assemble`：限定当前组合调用只能从页面装配边界进入；
- `deck`：5 至 60 页图片文字 V1 页规格；
- `image_artifacts`：固定 `target_slot_key` 到受控 Artifact ID 的映射。

这个 Schema 是 Agent 首版渲染子集，不是 ShanHaiEdu 的权威 `ppt-page-spec` 副本。山海合同还包含 `safe_area`、文本块 `layout`、多资产要求和可编辑数学图形等字段。Adapter 必须先用山海发布合同验证完整 Artifact，再显式投影到 V1；不支持的页面必须拒绝或停在人工门禁，不能静默丢字段。

Agent 读取图片后使用页面合同、执行上下文、目标槽位和图片 SHA-256 计算 `input_hash`。Artifact ID 可以变化，但内容、槽位和其他输入完全一致时仍视为同一确定性输入。

## Artifact Adapter

山海 Adapter 实现 `ArtifactPort` 时必须满足：

1. 读取前校验 organization、project、lesson unit 和当前 ArtifactVersion 的归属；不能只凭 ID 下载对象存储文件。
2. 只向 Agent 提供已采用的 PNG/JPEG，不提供未保存候选、外部 URL、Cookie 或 Provider 文件 ID。
3. 输出字节先写受控对象存储，再在同一山海事务中创建或复用 ArtifactVersion、关系和 NodeRun 活动输出。
4. 页面预览关系应指向页规格和采用图片；PPTX 应指向页面预览、页规格和图片集合。
5. 单页输入变化时由山海现有 ArtifactRelation/stale 语义精准使页面预览和当前 PPTX 过期。

Agent 返回的 `artifact_id` 是 Port 的逻辑标识。正式 Adapter 可将它映射为山海文件资产或 ArtifactVersion，但不得把 Agent 内存 ID 写成新的业务主键体系。

## 幂等与恢复

`ShanHaiPptDeliveryReceiptPortV1` 由山海实现，键为 organization、project 和 `node_run_id`：

- 首次完成保存 `inputHash + deliveryResult`；
- 相同 NodeRun 和相同 input hash 直接返回原结果，不重新渲染；
- 相同 NodeRun 输入变化返回 `SHANHAI_V1_NODE_RUN_INPUT_CONFLICT`；
- `save` 必须是原子插入或读取，不允许覆盖已完成收据。

PptxGenJS 会把生成时间写入包内容，所以重放时重新渲染不能保证 PPTX 字节相同。收据不是缓存优化，而是防止同一幂等键出现不同字节的正确性边界。

当前 Port 仍存在“输出字节已写入、完成收据尚未保存”时进程崩溃的窗口。正式山海 Adapter 必须在持有 NodeRun/GenerationAttempt 租约时，将输出登记、NodeRun 终态和完成收据纳入同一 PostgreSQL 事务；未知提交状态不得换键重试。完成这一点前不能宣称山海崩溃恢复已经闭环。

## V1 范围

已支持：

- 16:9、5 至 60 页；
- 第一页封面主视觉；
- 正文纯白背景；
- `IMAGE_LEFT`、`IMAGE_RIGHT`、`IMAGE_TOP` 三种正文布局；
- 每页一个主视觉槽位；
- 标题、正文和备注的 PPT 原生可编辑输出；
- PNG 联系表和可打开 PPTX；
- 宿主归属、受控图片、输入哈希和重放收据校验。

暂不支持：

- 可编辑数学图形、公式、表格、关系线和逐步揭示；
- 动态 `contract:ppt_style` 投影；当前字体、颜色和固定布局由 V1 Renderer 冻结；
- 逐页独立预览 Artifact 集合；
- 教师单页编辑与局部重新装配；
- 真实图片 Provider 调用；
- 山海 Adapter、数据库迁移、正式部署和真实课程验收。

## 接入顺序

1. 在 ShanHaiEdu 建立独立 Issue，冻结 Adapter 输入、输出、事务和验收标准。
2. 从最新 `main` 创建短分支，实现 `ppt.pages.assemble` 与 `pptx.export` Adapter，不修改 Agent 核心。
3. 用山海已发布页规格和确定性图片 Fake 运行合同测试。
4. 验证跨租户拒绝、NodeRun 输入冲突、相同请求重放和崩溃恢复。
5. 验证页面预览只归属装配节点、PPTX 只归属导出节点，关系和 stale 传播正确。
6. 完成山海独立审查与全量门禁后，再申请受控真实图片 Provider 冒烟。

关闭或回退 Adapter 后，山海现有工作流、Artifact 数据和已生成文件保持不变；PPT Agent 没有权限删除或改写山海业务事实。

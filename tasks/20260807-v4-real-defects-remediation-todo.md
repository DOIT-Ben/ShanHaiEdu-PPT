# PPT-Agent V4 真实缺陷整改清单

## 基线

- [ ] 确认唯一工作树为 `/srv/codex-workspace/PPT-Agent`
- [ ] 确认 `main == origin/main` 并记录 SHA
- [ ] 保留现有未跟踪问题文档和快速生成设计文档
- [ ] 确认不修改 FrameFlow、Model-Gateway、NewAPI 或正式服务

## T0 回归基线

- [ ] 为 13 个问题建立问题到测试矩阵
- [ ] 添加 1376x768、2048x2048、HTTP 200 坏输出等红色测试
- [ ] 添加 partial drain、状态保真、capabilities、resume 和版本漂移红色测试
- [ ] 确认红测因真实缺陷失败，不因测试搭建错误失败

## T1 比例和正规化

- [ ] 新增纯核心 ImageAspectPolicy
- [ ] 实现 3% 内确定性居中裁切和 1600x900 正规化
- [ ] 保存原始/最终尺寸、误差、裁切和哈希
- [ ] 拒绝方形、3:2、4:3 等严重失衡结果
- [ ] renderer 拒绝非精确比例输入，不允许拉伸
- [ ] 保持非 V4 旧模式兼容

## T2 状态和计费

- [ ] submissionState 支持 NOT_SUBMITTED/SUBMITTED/UNKNOWN
- [ ] billingState 独立为 NOT_CHARGED/CHARGED/UNKNOWN
- [ ] HTTP 200 坏输出映射为 SUBMITTED + billing UNKNOWN
- [ ] 删除 SUBMITTED 自动推导 CHARGED
- [ ] Quick-deck、MediaStepRunner、revision 和 Usage V2 全部适配
- [ ] 只有 NOT_SUBMITTED 可按原 key 重试

## T3 异步图片编辑

- [ ] 冻结 IMAGE_EDIT 异步 task 合同
- [ ] 持久化 edit operation ID、模式和原幂等键
- [ ] 覆盖进程重启、unknown、failed、completed 恢复
- [ ] 上游异步 edit 未验收前保持 evaluation/unavailable
- [ ] 禁止同步编辑被发布为稳定正式能力

## T4 Quick-deck drain

- [ ] 增加 pending failure、drain started/deadline 持久化字段
- [ ] 首个失败后停止新提交但继续查询已提交页
- [ ] 保留 rejected MediaSubmissionError 的真实状态
- [ ] drain 重启恢复且零重复提交
- [ ] deadline 后产生稳定逐页失败状态
- [ ] SSE 终态只发送一次

## T5 诊断和 evidence API

- [ ] 页面投影增加状态、错误、尺寸、误差和正规化信息
- [ ] 新增 evaluator evidence 资源和严格认证
- [ ] 记录服务构建身份、request/operation ID 和证据完整性
- [ ] Provider lineage 缺失时显式 UNKNOWN，不反推
- [ ] 完成 OpenAPI/Zod 双向 parity 和敏感字段测试

## T6 模型能力治理

- [ ] 建立 publication/readiness/availability 三层模型
- [ ] 分离 evaluation 与 published 模型
- [ ] 增加正式/评测 Key 对应的模型目录检查和短 TTL 缓存
- [ ] 新 Run 只允许 PUBLISHED + PASSED + AVAILABLE
- [ ] 历史 Run 和精确重放继续使用冻结快照
- [ ] capabilities 保持旧数组并新增详细状态

## T7 真实评测 runner

- [ ] 付费前核验 health、capabilities 和模型可见性
- [ ] 使用服务端版本、SHA、release、startedAt 和 runtimeMode
- [ ] 运行期间重启以环境污染失败关闭
- [ ] 创建 job 后立即原子写 0600 case-state
- [ ] 实现 --resume 且不创建新 job
- [ ] 默认 1 -> 3 -> 10 fail-fast
- [ ] 失败报告保留完整已知证据和明确未知项
- [ ] 补两把 evaluator 网关 Key 运行文档
- [ ] 添加 required-env/document parity 测试

## T8 完整 V4 验收

- [ ] Mock full-chain 覆盖审查、返修、Usage、恢复和交付
- [ ] FULL_V4_REAL 使用现有正式 Run API 完成真实单页
- [ ] 隔离 forced revision 注入固定合法 ASSET revision
- [ ] forced revision 使用真实异步 edit 并验证重启恢复
- [ ] 验证 PPTX/预览/SSE/SHA/revision/Usage 一致
- [ ] 报告区分真实自然审查、强制机械验收和质量认证

## 本地门禁

- [ ] 所有定向测试通过
- [ ] `bun run typecheck` 通过
- [ ] `bun run build` 通过
- [ ] `bun run check:boundaries` 通过
- [ ] `bun run verify:ownership` 通过
- [ ] OpenAPI/Zod parity 通过
- [ ] `bun run check` 通过
- [ ] `git diff --check` 通过
- [ ] 本轮新增行敏感信息扫描通过

## 子智能体源码审查

- [ ] 冻结最终候选 SHA
- [ ] Agent A 从源码审查问题 1/2/5/11 和异步编辑
- [ ] Agent B 从源码审查问题 3/4/6/7/10/13
- [ ] Agent C 从源码审查问题 8/9/12 和完整验收可证明性
- [ ] 每个 Agent 逐问题给出源码行号、测试名称和行为证明
- [ ] 禁止以计划文档或实现者总结作为解决证据
- [ ] 所有 Blocking/Required 修复后重新交给原 Agent 审查
- [ ] 三名 Agent 最终 Blocking=0、Required=0

## 隔离真实验收与最终收口

- [ ] 获得当次真实 Provider 调用授权
- [ ] 先执行单页 canary，失败时停止
- [ ] 单页通过后才执行 3 页，3 页通过后才执行 10 页
- [ ] 执行正式单页 V4 和受控异步返修
- [ ] 三名 Agent 复核最终源码与脱敏 evidence
- [ ] 13 个问题全部标记 RESOLVED
- [ ] 形成测试候选；未经新指令不正式部署

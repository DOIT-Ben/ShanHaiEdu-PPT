# PPT Agent 任务清单

## 0. 独立边界

- [x] 创建独立仓库、规格和 ADR
- [x] 明确 FrameFlow 首宿主、ShanHaiEdu 第二宿主
- [x] 明确 Agent 自有状态与宿主端口边界
- [x] 冻结 v1 合同 Schema
- [x] 建立核心独立性检查

## 1. 纯核心

- [x] 实现状态转换策略
- [x] 实现预算预检、占用、释放和未知状态策略
- [x] 定义 Repository 与外部能力 Ports
- [x] 实现单步 Runner
- [x] 实现内存 Repository 和 Mock Provider
- [ ] 完成合同、策略和故障注入测试

## 2. 持久化与服务

- [x] 实现独立 SQLite Repository；生产数据库晋升条件待基准验证
- [x] 实现 lease、过期恢复扫描和旧 token 防护
- [x] 实现 HTTP API 与 OpenAPI v1 合同
- [x] 实现基于持久化事件轮询的 SSE 回放和实时订阅
- [ ] 实现租户认证与限流

## 3. PPT 能力

- [x] 实现教材分块、来源定位和完整性检查
- [x] 实现宿主无关的教材分析与蓝图规划核心并接入真实模型适配器
- [x] 实现宿主无关、无副作用单页质检核心并接入真实视觉模型适配器
- [x] 抽取 PNG 预览和 PPTX 导出，并通过独立 Artifact Port 交付
- [x] 实现整套评估、严格 RevisionPlan 和监督/有限自动决策
- [x] 按 RevisionPlan 执行局部内容更新、重排与受预算保护的重绘
- [x] 完成 15 页 Mock E2E（无真实 Provider 请求）

## 4. FrameFlow Adapter

- [x] 实现服务端身份与附件适配
- [x] 实现额度适配；素材回传待 Artifact Port 接入
- [x] 增加功能开关和 Agent API Client
- [x] 接入蓝图批准、进度、问题、限定修订和交付 UI
- [ ] 运行原 PPT 全量回归
- [ ] 完成桌面与移动浏览器验收

## 5. 发布门禁

- [ ] 类型、测试、Lint、构建全部通过
- [ ] 秘密和宿主耦合扫描通过
- [ ] 隔离测试环境部署和备份回退演练
- [ ] 经授权完成两页真实 Provider 验证
- [ ] 董事长验收后再规划生产或 ShanHaiEdu 接入

## 6. ShanHaiEdu 图片文字 V1

- [x] 冻结山海兼容的逐页图片文字 V1 子集、正文白底和可编辑文字责任
- [x] 实现封面整图、正文单主视觉槽位和 PNG/PPTX 组合渲染
- [x] 增加山海执行上下文、受控制品读取、宿主归属和完成收据边界
- [ ] 在山海仓库建立 Issue 后实现 `ppt.pages.assemble` Adapter
- [ ] 将预览与 PPTX 分别归属到 `ppt.pages.assemble` 和 `pptx.export`
- [ ] 使用山海 PostgreSQL `NodeRun`、`ArtifactVersion` 和事务实现完成收据
- [ ] 通过山海合同、运行时、跨租户和崩溃恢复门禁

## 7. 知识驱动分层课件 V3

- [x] 冻结 Run 模式、默认独立封面和分层元素合同
- [x] 实现知识素材规划、跨页复用和唯一素材预算任务
- [x] 实现 Sharp 分层预览和 PptxGenJS 独立对象导出
- [x] 实现知识、素材、布局三类审查修复路由
- [x] 完成 Mock V3 E2E、PPTX 结构断言和 V2 回归
- [x] 接入 FrameFlow 功能开关并完成隔离浏览器验收
- [x] 备份、发布内测 Alpha 并记录回滚与公网验证证据

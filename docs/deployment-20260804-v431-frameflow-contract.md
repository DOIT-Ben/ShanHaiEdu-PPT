# PPT Agent 4.3.1 FrameFlow 终态合同生产发布

> 发布时间：2026-08-04 16:50-17:48（Asia/Shanghai）。本次未调用真实 Provider、未创建或取消 Run、未修改 SQLite Schema 或业务数据。

## 发布身份

- Git 提交：`906adec36413930a95dbbd042b50f4b0cb3026d7`，已位于 `origin/main`。
- 软件版本：`4.3.1`。
- 合同版本：`1`。
- release：`/opt/ppt-agent/releases/20260804-164104-906adec-v4.3.1`。
- 上一 release：`/opt/ppt-agent/releases/20260803-210733-02ded85-v4.3.0`。

## 范围

- 修复 Usage V2 终态账务恢复中的 datetime 合同、管理员 REINSPECT 后的可恢复状态和 OpenAPI/Zod release 一致性。
- 公共 HTTP/SSE 合同明确 `deliveryAvailability`、终态账务、恢复事件与图片型 V4 PPTX 的下载门禁。
- FrameFlow 同步发布严格消费者，避免将账务等待、终态失败或恢复后的完成错误投影给用户。

## 备份与切换

- 数据备份：`/opt/ppt-agent/shared/data-backups/ppt-agent-20260804T084733Z`。
- 备份元数据：SQLite `1037512704` bytes、制品 `426` 个、完整性 `ok`、外键违规 `0`。
- 服务停止后将 `current` 原子切换到新 release，再启动既有 `ppt-agent.service`；持久化数据目录和凭据未覆盖。
- 首次健康检查仍报告旧 release identity，定位为环境文件中的旧非敏感版本/SHA/release ID。已在停服状态原子同步四个发布身份字段，Token 与其他配置保持不变，文件权限仍为 `0600`。

## 验证

- 发布前 `bun run check` 执行核心边界检查、测试、类型检查和构建；候选工作树干净。
- 发布后 `ppt-agent.service` 为 `active`、`NRestarts=0`。
- `/health/live` 返回 `UP`，`/health/ready` 返回 `READY`。
- 健康 release 为 `4.3.1`、`906adec36413930a95dbbd042b50f4b0cb3026d7`、`v4.3.1-906adec36413`、`contractVersion=1`。
- 服务仅监听 `127.0.0.1:4310`；未认证 `GET /v1/runs` 返回 `401`。

## 回退

若仅回退程序且不存在需要新程序解释的数据副作用：停止 `ppt-agent.service`，将 `/opt/ppt-agent/current` 指回 `20260803-210733-02ded85-v4.3.0`，恢复对应非敏感发布身份字段，再启动服务并验证 health 与未认证边界。不得覆盖 `/opt/ppt-agent/shared/data`。

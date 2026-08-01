# PPT Agent V4 FrameFlow 合同生产发布记录

## 发布结果

- 发布时间：2026-08-01 23:33 CST
- 运行提交：`78310f558e45b15febd4ba90b8b7be3eb3eb01fa`
- 合并 PR：[PPT Agent #18](https://github.com/DOIT-Ben/ShanHaiEdu-PPT/pull/18)
- 正式 release：`/opt/ppt-agent/releases/20260801-232500-78310f5-v4-frameflow-contract`
- 本次历史发布的软件版本：`0.1.0`
- 范围：V4 FrameFlow HTTP/SSE/幂等/交付合同文档、管理员修订轮次设置公开响应修复。

FrameFlow 未在本次发布中修改。V4 继续通过统一 `/v1/runs` 接口和
`presentationMode: VISUAL_DECK_V4` 接入。

> 本文记录的是 2026-08-01 的历史发布。运行中的准确软件、模式和合同身份必须读取
> `/health/*` 与 Run 详情的 `release`，不能把这份历史记录当作当前版本来源。

## 验证证据

- 合并前 `bun run check` 通过：核心边界、`439 pass / 0 fail`、类型检查和构建通过。
- 新 release 在隔离 Mock 运行时以 `ppt-agent` 服务账户启动，`/health/live`、`/health/ready`
  均为 200，未认证 `GET /v1/runs` 为 401。
- 生产切换后，`ppt-agent.service` 为 `active`，`NRestarts=0`。
- 生产 `/health/live`、`/health/ready` 为 200，未认证 `GET /v1/runs` 为 401。
- 已验证普通凭据读取 Run 为 200、普通凭据读取管理员设置为 403、管理员读取修订轮次设置为 200。
- 生产 SQLite 和保留的在线快照均通过 `PRAGMA integrity_check`，且无外键违规。

## 备份与清理

- 上线后在线数据快照：
  `/opt/ppt-agent/shared/data-backups/ppt-agent-20260801T153430Z`。
- 按发布授权清理历史 production release、部署备份和旧在线快照，只保留当前活动 release 和上述一份
  数据快照。
- 清理后不保留本地程序回退 release。若必须回退程序，需要从 Git 重新构建此前提交；不得覆盖当前
  `/opt/ppt-agent/shared/data`。

## 发布过程中的修正

第一次切换发现新 release 中 `dist/` 保留了构建用户的 `700/600` 权限，`ppt-agent` 服务账户无法读取
`dist/server.js`。服务立即恢复到旧 release，数据未覆盖且 SQLite 校验通过。随后将新 release 调整为
只读可执行目录权限并以 `ppt-agent` 账户完成隔离预检，再次切换后稳定运行。

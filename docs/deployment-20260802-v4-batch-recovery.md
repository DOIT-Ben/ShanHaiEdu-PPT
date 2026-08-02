# PPT Agent V4 批次恢复生产发布

## 发布身份

- 发布时间：2026-08-02 13:13 CST
- Git 提交：`ef1dc0e00739418ac7af219490b5e22563f402ad`
- GitHub 合并：PPT Agent PR #20
- 软件版本：`4.0.0`
- 合同版本：`1`
- 正式 release：`/opt/ppt-agent/releases/20260802-131138-ef1dc0e-v4-batch-recovery`

本次发布包含 V4 的受控页面并发、整单预授权、原子批次最终结算和可恢复账务状态机。V4 的模式名仍为
`VISUAL_DECK_V4`，不能将模式名当作软件发布版本。

## 发布前验证

- `origin/main` 已包含候选提交；
- `bun run check` 通过；
- 磁盘可用空间为 26 GiB；
- 候选以 `ppt-agent` 服务账户、独立 SQLite、端口 `4312` 启动，`/health/live` 为 `UP`、
  `/health/ready` 为 `READY`，未认证 `GET /v1/runs` 返回 `401`；
- 未调用真实模型、图片 Provider 或 FrameFlow 账务接口。

## 备份与切换

- 发布前备份：`/opt/ppt-agent/backups/20260802-131328-pre-20260802-131138-ef1dc0e-v4-batch-recovery`
- 备份保留了切换前 release、服务文件、权限 `600` 的环境文件和完整数据副本；
- 备份 SQLite `integrity_check=ok`，`foreign_key_check=0`；
- 切换前运行版本：`/opt/ppt-agent/releases/20260801-232500-78310f5-v4-frameflow-contract`；
- `/opt/ppt-agent/current` 已原子指向本次 release，随后重启既有 `ppt-agent.service`。

## 发布后验证

- `ppt-agent.service`：`active`，`NRestarts=0`；
- `GET /health/live`：`UP`；
- `GET /health/ready`：`READY`；
- 返回的软件版本：`4.0.0`；
- 返回的 Git SHA：`ef1dc0e00739418ac7af219490b5e22563f402ad`；
- 未认证 `GET /v1/runs`：`401`；
- 生产数据文件可读取，未迁移或恢复数据。

## 已知联调边界

PPT Agent V4 已上线，但真实付费出图的宿主批次账务预检仍依赖 FrameFlow 实现
`batch-finalization-capability` 与 `reservations/{id}/finalize` 两条内部接口。接口尚未发布前，V4 会在
付费出图前停止，避免重复或错误扣费。

## 回退

若需要程序回退且未发生需要新代码解释的数据副作用，停止服务后把 `current` 指回备份记录的切换前
release，再启动服务：

```bash
systemctl stop ppt-agent
ln -sfn /opt/ppt-agent/releases/20260801-232500-78310f5-v4-frameflow-contract /opt/ppt-agent/current
systemctl start ppt-agent
systemctl is-active ppt-agent
```

回退程序时保留 `/opt/ppt-agent/shared/data`；不得覆盖上线后的业务、账务或交付数据。

# PPT Agent 事件历史恢复正式部署记录

2026-07-22 19:58 CST 将运行提交 `cb46b3a` 发布到
`/opt/ppt-agent/releases/20260722-195800-cb46b3a-event-history`，并由
`/opt/ppt-agent/current` 原子切换。上一版本为
`/opt/ppt-agent/releases/20260722-141500-18eda19-v31-scheduler`。

本次新增属主隔离的 `GET /v1/runs/{runId}/events/history`。接口复用持久化事件仓库，按游标返回
最多 100 条、256 KiB 的 JSON 分页，供 FrameFlow 在连接 SSE 前恢复完整过程。原 SSE 合同、数据库
结构、环境变量和 Provider 配置均未改变。

发布前备份位于 `/opt/ppt-agent/backups/20260722-195301-pre-ppt-event-recovery`，包含旧 release
指针、systemd unit、权限 600 的环境文件和 SQLite 一致性快照。快照为 `integrity_check=ok`、
外键违规 0。

候选服务在独立数据副本和 `127.0.0.1:4313` 验证 liveness、readiness、认证边界与历史接口后关闭。
正式服务启动后，真实持久化 Run 的历史接口返回 5 条事件，SSE 返回 `200 text/event-stream` 且首包
非空；服务 `NRestarts=0`，正式数据库再次验证完整。

程序回退时保留当前数据库和产物：

```bash
systemctl stop ppt-agent.service
ln -sfn /opt/ppt-agent/releases/20260722-141500-18eda19-v31-scheduler /opt/ppt-agent/current
systemctl start ppt-agent.service
systemctl is-active ppt-agent.service
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4310/v1/runs)" = 401
```

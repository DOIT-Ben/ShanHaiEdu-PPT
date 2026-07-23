# PPT Agent 生产加固正式部署记录

## 发布结果

- 发布时间：2026-07-23 07:55 CST
- 运行提交：`9304abf`，应用代码包含冻结账户分类修复 `adc387f`
- 运维配置提交：`b182597`
- 正式发布：`/opt/ppt-agent/releases/20260723-075345-9304abf-hardening-backup`
- 上一发布：`/opt/ppt-agent/releases/20260723-071209-7e1f57d-hardening`
- 宿主发布：`/opt/frameflow/releases/20260723-081022-8be4f89-idempotency-boundary`

本次上线收紧用户、管理员和 FrameFlow 出站凭据边界，增加租户用户级限流、SQLite Keyset 查询与
索引、模型工具输出上限、预览复用和视觉审查并发。FrameFlow 返回冻结账户 `423` 时被明确分类为
未预留，Agent 不调用 Provider 并释放自身预算；提交或计费状态未知时继续保留预留并要求人工对账。
本次验收未创建真实 Run，未调用计费 Provider。

## 备份

- 发布前停机备份：`/opt/ppt-agent/backups/20260723-075529-pre-final-hardening`
- 备份单元解耦前配置：`/opt/ppt-agent/backups/20260723-080540-pre-backup-unit-decouple`
- 最新在线备份：`/opt/ppt-agent/shared/data-backups/ppt-agent-20260723T000540Z`
- 运维脚本：`/opt/ppt-agent/shared/ops/backup-ppt-agent-data.mjs`

发布前与在线快照均为 10 Run、28 Step、113 Event；在线快照包含 9 个产物、18 个文件和
15,167,874 字节。SQLite 为 `integrity_check=ok`、外键违规 0，逐产物字节数与 SHA-256 校验通过。

`ppt-agent-backup.timer` 每日 03:00 执行，随机延迟最多 15 分钟，保留 14 天。脚本位于 shared
运维目录，不依赖 `current` Release，因此程序回退不会中断定时备份。

## 验证证据

- `bun run check`：核心边界通过，`265 pass / 0 fail`，类型检查和生产构建通过。
- live/ready 为 `200`；未认证 Run 为 `401`；普通 Token 的 Run 列表为 `200`、管理接口为 `403`；
  普通 Token 伪造管理员角色为 `401`；管理员 Token 的管理接口为 `200`。
- `ppt-agent.service` 为 `active/running`、`NRestarts=0`，仅监听 `127.0.0.1:4310`。
- `ppt-agent-backup.timer` 为 active/enabled，手动备份 `Result=success`、`ExecMainStatus=0`。
- 环境文件权限为 600，三把 Token 保持互异且未写入仓库、日志或部署记录。

## 回退

常规程序回退保留当前数据库、产物和 shared 备份服务：

```bash
systemctl stop ppt-agent.service
ln -sfn /opt/ppt-agent/releases/20260723-071209-7e1f57d-hardening /opt/ppt-agent/current
systemctl start ppt-agent.service
curl -fsS http://127.0.0.1:4310/health/live >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4310/v1/runs)" = 401
```

回退窗口内 FrameFlow 保留旧出站凭据兼容。若新版本已经产生 Run、动作、产物或计费副作用，不得
恢复旧数据目录；仅回退程序并保留现有数据库，随后执行针对性对账。

# PPT Agent 2026-07-23 加固待部署 Runbook

## 状态

本文件是待执行计划，不是部署记录。当前代码未因此文档而发布、迁移或重启生产服务；真实 Provider 预检和正式上线需要另行明确授权。

## 变更范围

- 用户、管理员和 FrameFlow 出站凭据分离，租户与角色由认证层绑定。
- 创建与动作接口增加单实例、租户用户级限流。
- Run 列表改为 SQLite Keyset 分页，并为 Run/Step 热字段增加派生列和索引。
- 模型工具调用启用严格 Schema，流式参数限制为 4 MiB。
- 页面预览复用、视觉审查并发和网络素材质量门禁随同一候选版本发布。

## 发布前条件

1. `bun run check` 全部通过，工作区只包含授权提交，`output/` 不进入发布包。
2. 系统盘使用率低于 80%，剩余空间不少于 5 GiB。
3. `/opt/ppt-agent/shared/ppt-agent.env` 权限为 `600`，并存在三个互不相同且至少 16 字符的 Token：
   - `PPT_AGENT_API_TOKEN`
   - `PPT_AGENT_ADMIN_API_TOKEN`
   - `FRAMEFLOW_INTERNAL_TOKEN`
4. FrameFlow 内部附件和预算接口已接受新的 `FRAMEFLOW_INTERNAL_TOKEN`。回退窗口内继续接受旧版本出站凭据。
5. 新 release、候选数据目录和候选端口与生产目录、数据库和 `4310` 完全隔离。

## 停机备份

以下操作会停止生产服务，应在正式发布授权和维护窗口内执行：

```bash
stamp="$(date +%Y%m%d-%H%M%S)"
backup="/opt/ppt-agent/backups/${stamp}-pre-hardening"
command -v sqlite3 >/dev/null
install -d -m 700 "$backup"
readlink -f /opt/ppt-agent/current > "$backup/current-release.txt"
systemctl stop ppt-agent.service
cp -a /opt/ppt-agent/shared/data "$backup/data"
install -m 600 /opt/ppt-agent/shared/ppt-agent.env "$backup/ppt-agent.env"
cp -a /etc/systemd/system/ppt-agent.service "$backup/ppt-agent.service"
sqlite3 "$backup/data/agent.sqlite" 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
```

验收备份时，`integrity_check` 必须只返回 `ok`，`foreign_key_check` 必须无结果。记录实际 `$backup` 路径；备份未通过时重新启动旧 release 并停止发布。

## 发布顺序

1. 构建一次 release，并保持 `dist/`、`package.json`、lockfile 和部署配置来自同一提交。
2. 使用独立 SQLite 副本启动候选实例，验证启动迁移、`/health/live`、`/health/ready` 和未认证 `/v1/runs` 返回 `401`，随后关闭候选实例。
3. 更新权限 `600` 的生产环境文件，不在终端输出、日志或命令参数中展示 Token。
4. 原子切换 `/opt/ppt-agent/current` 到新 release，启动 `ppt-agent.service`。
5. 不调用真实计费 Provider，除非本次发布授权明确包含真实预检。

## 发布后验证

```bash
systemctl is-active ppt-agent.service
systemctl show ppt-agent.service -p NRestarts --value
curl -fsS http://127.0.0.1:4310/health/live >/dev/null
curl -fsS http://127.0.0.1:4310/health/ready >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4310/v1/runs)" = 401
sqlite3 /opt/ppt-agent/shared/data/agent.sqlite \
  "SELECT name FROM pragma_table_info('agent_runs') WHERE name IN ('tenant_id','external_user_id','status','updated_at') ORDER BY name;"
sqlite3 /opt/ppt-agent/shared/data/agent.sqlite \
  "SELECT name FROM pragma_table_info('agent_steps') WHERE name IN ('tool','status') ORDER BY name;"
```

再由 FrameFlow 服务端客户端验证：普通 Token 可以创建和查询自己的 Run；普通 Token 请求管理员接口返回 `403`；管理员 Token 可以读取租户运维报告；超过测试阈值后返回 `429` 且 `Retry-After` 为正整数。检查日志中没有 Token、模型响应正文或任意异常详情。

## 程序回退

派生列和索引是加法变更，优先保留当前数据库并只回退程序：

```bash
backup="/opt/ppt-agent/backups/REPLACE-WITH-VERIFIED-BACKUP"
systemctl stop ppt-agent.service
ln -sfn "$(cat "$backup/current-release.txt")" /opt/ppt-agent/current
install -m 600 "$backup/ppt-agent.env" /opt/ppt-agent/shared/ppt-agent.env
systemctl start ppt-agent.service
systemctl is-active ppt-agent.service
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4310/v1/runs)" = 401
```

执行前把 `backup` 改为本次已验证备份的绝对路径，并确认 FrameFlow 仍接受旧版本出站凭据。

## 数据恢复

只有迁移损坏且新版本启动后没有产生新 Run、动作、制品或 Provider/预算副作用时才恢复数据库。先停止服务并保留失败现场，不直接覆盖：

```bash
stamp="$(date +%Y%m%d-%H%M%S)"
backup="/opt/ppt-agent/backups/REPLACE-WITH-VERIFIED-BACKUP"
systemctl stop ppt-agent.service
mv /opt/ppt-agent/shared/data "/opt/ppt-agent/shared/data.failed-${stamp}"
cp -a "$backup/data" /opt/ppt-agent/shared/data
systemctl start ppt-agent.service
```

若已经产生新业务或计费副作用，只能回退程序并保留当前数据库，随后做针对性修复。

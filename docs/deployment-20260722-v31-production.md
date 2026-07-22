# PPT Agent V3.1 正式部署记录

2026-07-22 14:19 CST 将运行提交 `18eda19` 发布到
`/opt/ppt-agent/releases/20260722-141500-18eda19-v31-scheduler`，并由
`/opt/ppt-agent/current` 原子切换。上一版本为
`/opt/ppt-agent/releases/20260721-215813-7bda62c-v3-core-contract-repair`。

本次上线 Run 级 `AI_FIRST` / `SEARCH_FIRST` 素材策略、可索引的限定调度查询、2 Worker 有限并发、
60 秒 Run Lease 续租与过期接管，以及终态待媒体对账。生产启用网络素材检索；服务仍只监听
`127.0.0.1:4310`，凭据保留在权限 600 的共享环境文件中。

发布前备份位于 `/opt/ppt-agent/backups/20260722-141112-pre-v31-production`，SQLite 快照通过
`integrity_check` 且外键违规为 0。候选服务使用独立 preflight 数据目录，在 `4312` 验证存活、就绪和
未认证访问边界后关闭。

全量测试为 `225 pass / 0 fail`，TypeScript、边界检查和生产构建通过。正式服务启动后 liveness、
readiness 为 200，未认证 Run 接口为 401；FrameFlow 代理的 SSE 返回 `text/event-stream`。

程序回退时保留当前数据库和产物，将 `current` 指回上一 release 后重启 `ppt-agent`。上线后产生新
任务或 Provider 副作用时不得直接恢复旧数据库。

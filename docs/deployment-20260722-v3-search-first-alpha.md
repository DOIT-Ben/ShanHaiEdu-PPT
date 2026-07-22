# PPT Agent V3.1 网络素材优先隔离发布

2026-07-22 11:17 CST，提交 `d6d8f4e` 发布到隔离测试目录
`/opt/ppt-agent-test/releases/20260722-112500-d6d8f4e-retry-action`。服务只监听
`127.0.0.1:4311`，生产 PPT Agent 进程和 `4310` 均未变更。

本次默认先从 Wikimedia Commons 和 Openverse 检索可商用公共素材，仅接受 Public Domain、CC0
和 CC BY；检索无可接受结果时才回退到 AI 生图。下载链路包含 HTTPS、SSRF、MIME、像素、重定向
和文件大小防护，交付包含 `asset-sources.json`。网络素材会归一化到最长边 2048px，PPTX 保留 JPEG，
避免重复转码造成体积膨胀。失败交付可通过 `RETRY_DELIVERY` 使用原 Step 和原幂等键重试。

发布前完整门禁为 `218 pass / 0 fail`，核心边界、TypeScript 类型检查和构建通过。发布后 `/health/live`
为 `UP`、`/health/ready` 为 `READY`，数据库 `integrity_check=ok`。教材课件 Run
`run-79987eeb9d16bc08015930e85199` 已完成：8 页、22 个独立图片对象、23 个可编辑文字对象、17 个
原生形状、5 项 CC BY 来源、AI 图片调用 0、预算消耗 0。正式 PPTX 为 5.6MB，Open XML ZIP 校验通过。

发布前备份为 `/opt/ppt-agent-test/backups/20260722-112600-pre-d6d8f4e`，包含停机状态下的数据库、
测试环境文件和上一 release 指针。回退时将 `current` 原子指回
`/opt/ppt-agent-test/releases/20260722-111700-82aae2c-delivery-retry` 并重启 `ppt-agent-test`；只有在确认
需要回退数据时，才停止测试服务并恢复备份目录中的 `data` 和 `ppt-agent-test.env`。

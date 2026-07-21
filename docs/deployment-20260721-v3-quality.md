# PPT Agent V3 质量闭环生产发布

2026-07-21 20:07 CST，提交 `5aca93d` 发布到
`/opt/ppt-agent/releases/20260721-193734-5aca93d-v3-quality-rc`，上一版本为
`/opt/ppt-agent/releases/20260721-164200-6f6a27f-v3-alpha`。

本次将真实 GPT-5.6 多模态蓝图规划、单素材与完整页面视觉审查、整套课件审查、修订计划和限定修订
执行接入生产 gateway runtime。文本规划和视觉审查模型均固定为 `gpt-5.6`，图片生成仍使用独立媒体
网关能力。服务继续监听 `127.0.0.1:4310`，环境凭据保存在权限 `600` 的共享文件中，未进入发布包
或仓库。

发布前 `134 pass / 0 fail`，核心边界、TypeScript 和构建通过；候选版本在备用端口 `4311` 启动
成功。正式切换后服务为 `active/running`、`NRestarts=0`，未认证请求为 `401`，带宿主服务身份的
列表请求为 `200`，数据库 `integrity_check=ok`、外键违规为 `0`。

即时回退点位于 `/opt/ppt-agent/backups/20260721-200103-pre-v3-quality-live`。正常回退切换到旧发布
目录并恢复其中的 `ppt-agent.env`，保留现有 Agent 数据和产物；只有确认没有新 Provider 或用户数据
副作用时才能恢复数据库快照。完整的 FrameFlow 联动发布、浏览器证据和回退命令见 FrameFlow 的
`deploy/aliyun/production-deployment-20260721-v3-quality.md`。

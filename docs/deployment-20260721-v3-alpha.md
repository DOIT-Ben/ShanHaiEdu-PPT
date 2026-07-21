# V3 Alpha 生产部署

2026-07-21 16:45 CST，提交 `6f6a27f` 发布到
`/opt/ppt-agent/releases/20260721-164200-6f6a27f-v3-alpha`，由
`/opt/ppt-agent/current` 原子指向。服务运行用户为 `ppt-agent`，监听 `127.0.0.1:4310`，数据位于
`/opt/ppt-agent/shared/data`。

真实验证包括：`image-2` 未知提交状态安全停止、`nanobanana` 2 页/4 图完整交付、PPTX 每页 2 个
图片对象与 3 个原生文字/形状对象、底图不是 slide background、透明素材棋盘格去除后的真实 PNG
透明像素比例 59.23%。

当前为内测 Alpha：真实视觉审查、整套审查和自动修订 Runner 尚未接入生产模型。完整发布证据、
FrameFlow 回退步骤和数据库一致性备份见 FrameFlow 的
`deploy/aliyun/production-deployment-20260721-v3-alpha.md`。

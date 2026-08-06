# PPT Agent V4 Usage V2 上线与回退门禁

## 目标

`4.3.0` 同时理解 `LEGACY_RESERVATION_V1` 与 `FRAMEFLOW_USAGE_V2`。发布兼容代码和启用新账务协议是
两个独立动作：先以 V1 默认值发布并验证，再在宿主合同准备完成后只对新建 FrameFlow V4 Run 启用 V2。

## 激活前置条件

启用 `PPT_AGENT_FRAMEFLOW_ACCOUNTING_PROTOCOL=FRAMEFLOW_USAGE_V2` 前必须同时满足：

1. FrameFlow 生产已提供 permit、event、bill 和 Run finalize 四个 Usage V2 端点。
2. 若显式开启图片编辑，一个 Run 的父授权能够接受初稿 `gemini-3-pro-image-preview` 与已验收返修模型，或二者被宿主归入同一稳定计价族；未开启时只允许初稿模型。
3. FrameFlow 允许没有任何 `OPERATION_OBSERVED` 的终态 Run安全释放整单父授权；Agent 不会伪造 Provider 操作。
4. `PPT_AGENT_PROVIDER_BILLING_CATALOG_JSON` 包含所有活动初稿模型、显式启用的返修模型和仍可能恢复的冻结历史路由的固定单次成本、币种和 Provider
   定价版本；不允许用用户积分价格代替 Provider 成本。
5. PPT Agent 与 FrameFlow 使用同一个 Run 身份和稳定操作幂等键；响应未知恢复时不得生成新身份。

上述任一项不满足时保持 V1，不在 PPT Agent 内绕过宿主合同。

## 两阶段上线

第一阶段发布 `4.3.0`，保持：

```dotenv
PPT_AGENT_FRAMEFLOW_ACCOUNTING_PROTOCOL=LEGACY_RESERVATION_V1
```

验证旧 V1 Run 的创建、初稿、返修、取消和批次原子结算无回归。此阶段不产生新 V2 Run。

第二阶段先发布 FrameFlow Usage V2，再配置经审计的 Provider 成本目录，最后将 PPT Agent 默认协议切为
`FRAMEFLOW_USAGE_V2`。重启后应创建一个隔离 Run，检查：

- Run 持久化 `accountingProtocol=FRAMEFLOW_USAGE_V2`；
- 每个 Provider POST 前存在成功 permit；
- V2 Run 对旧 `/credits/reservations` 和旧 batch finalize 的调用数为 0；
- Usage 事件 sequence 严格递增，终态只调用一次稳定的 `finalize:<runId>`；
- 缺少初稿模型成本档案的新 Run 在规划前失败，Provider 调用数和 Usage 事件数均为 0；
- 人工 `MARK_CHARGED/MARK_NOT_CHARGED` 生成稳定 `BILLING_RESOLVED`，且旧 credit API 调用数为 0；
- 模拟一次 Event 409 后，Run 停止空转并出现在管理员对账列表；修复宿主后用 `REINSPECT` 重投的事件
  body 和幂等键与首次完全一致；
- PPTX 交付和账单分别以 Agent 交付合同与 FrameFlow Bill 为真源。

## 回退

把默认协议切回 V1只会阻止新 V2 Run，已经持久化的 V2 Run 仍必须由 `4.3.x` 恢复。回退二进制前先在
SQLite 检查未闭环 V2 Run：

```sql
SELECT r.id, r.status
FROM agent_runs AS r
WHERE json_extract(r.data, '$.accountingProtocol') = 'FRAMEFLOW_USAGE_V2'
  AND (
    r.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
    OR NOT EXISTS (
      SELECT 1
      FROM agent_steps AS s
      WHERE s.run_id = r.id
        AND s.tool = 'finalize_usage_v2'
        AND s.status = 'COMPLETED'
    )
    OR EXISTS (
      SELECT 1
      FROM agent_steps AS s
      WHERE s.run_id = r.id
        AND s.tool = 'report_usage_v2'
        AND s.status <> 'COMPLETED'
    )
  );
```

查询有结果时禁止回退到 `4.2.x` 或更早版本；只能回退到仍包含 V2 Outbox、事件恢复和终态 finalize
恢复器的兼容版本。数据库文件和 Artifact 目录必须按现有生产 runbook 先备份，再执行任何正式发布或回退。

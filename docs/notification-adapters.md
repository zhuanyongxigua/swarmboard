# 通知适配注册与投递决策

[返回架构说明](architecture.md) · [Harness 适配与扩展](harness-adapters.md)

`src/harness/` 解决的是**启动时选择哪一个执行后端**；本文件描述的是**并存的通知通道**：哪些适配器存在、服务哪些稳定成员与会话、哪些共享事件应当送达。两者刻意分开，避免把"跑哪个后端"与"谁该收到通知"混成同一套语义。

模块：`src/notification-adapters.ts`（纯函数，无 I/O、不启动进程、不调用模型）。

## 注册

`NotificationAdapterRegistration`：

| 字段 | 语义 |
| --- | --- |
| `id` | 进程内唯一稳定标识 |
| `displayName` / `harness` | 展示名与**自由文本**的 harness 标签；内核不对其分支 |
| `enabled` | 当前是否启用 |
| `capabilities` | 声明能力：`durableDelivery`、`receipt`、`sameSessionContinuation`、`approvalSignals`、`timedReminder` |
| `members` | 所服务的稳定成员：`{memberId, sessionRef, taskIds}`；`taskIds` 为空表示只收定向消息 |

`createNotificationRegistry().register()` 会拒绝：重复 `id`、未知能力位、缺少 `displayName`/`harness`、**没有任何成员**（"只列 identity"不构成通道）、成员缺 `memberId`/`sessionRef`、同一成员重复登记。登记会被冻结，调用方无法事后自行扩大范围。

> **注册不等于启动**：登记一份声明不会创建会话、不会拉起进程、也不代表成员在线。

## 投递决策

`resolveNotificationTargets(entry, adapters, {capability?})` 返回 `{targets, skipped}`：

1. 是否"可唤醒"**直接复用** `src/wake-policy.ts` 的 `actionableWake`。因此 FACT/CLAIM/PATCH_SUMMARY 等同伴证据保持为**参考上下文**，只有 MESSAGE、FAIL、人类/宿主控制类 OBSERVED 才投递——"可见/扫描到"不等于"已通知"。
2. 适配器需 `enabled`，并按需具备本次要求的 `capability`。
3. 成员的 `taskIds` 决定任务范围；**没有 taskId 也没有 `recipientId` 的看板级条目不是定向唤醒**，不会投给未订阅成员。
4. 跳过自己发布的事件（`self-authored`）。
5. 每个不投递的组合都给出原因码：`invalid-registration`、`disabled`、`reference-only`、`out-of-scope`、`self-authored`、`no-capability`。

**一个适配器异常不影响其他通道**：非法声明只让该通道记 `invalid-registration`，其余通道照常解析。

## 投递、回执与未知

- 投递前先落**持久意图** `DeliveryIntent{adapterId, memberId, sequence, entryIds, createdAt}`。
- `reconcileDelivery(intent, receipt)`：只有收到**同序号且 consumed** 的回执才算 `delivered`；无回执为 `pending`；回执未消费、早于或晚于意图一律 `unknown`。
- `unknown` **禁止自动重放**，必须由调用方与适配器核对后处置——与执行侧的 `UncertainDelivery` 同一原则。
- 分页重复用 `dedupeEntries` 按 `id` 保序去重，重复投递不会变成多个模型回合。

> **通知到达不等于执行或完成**：通道确认消费只证明消息被接手；是否有用贡献仍以该成员会话的新动作与产物证据为准。

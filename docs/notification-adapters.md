# 通知适配注册与投递决策

[返回架构说明](architecture.md) · [Harness 适配与扩展](harness-adapters.md)

`src/harness/` 解决的是**启动时选择哪一个执行后端**；本文件描述的是**并存的通知通道**：哪些适配器存在、服务哪些稳定成员与会话、哪些共享事件应当送达。两者刻意分开，避免把"跑哪个后端"与"谁该收到通知"混成同一套语义。

模块：`src/notification-adapters.ts`（纯函数，无 I/O、不启动进程、不调用模型）。

## 注册

`NotificationAdapterRegistration`：

| 字段 | 语义 |
| --- | --- |
| `id` | 进程内唯一稳定标识 |
| `version` | 单调递增的声明版本；替换必须严格更大 |
| `displayName` / `harness` | 展示名与**自由文本**的 harness 标签；内核不对其分支 |
| `enabled` | 当前是否启用 |
| `capabilities` | 声明能力：`durableDelivery`、`receipt`、`sameSessionContinuation`、`approvalSignals`、`timedReminder` |
| `members` | 所服务的稳定成员：`{memberId, sessionRef, taskIds, boardWide?}`；`taskIds` 为空表示只收定向消息，`boardWide: true` 额外接收无 task 的板级可唤醒事件 |

`createNotificationRegistry().register()` 会拒绝：重复 `id`、未知能力位、缺少 `version`/`displayName`/`harness`、**没有任何成员**（"只列 identity"不构成通道）、成员缺 `memberId`/`sessionRef`、同一成员重复登记。登记会被冻结，调用方无法事后自行扩大范围。

成员获得**新任务范围**时用 `replace()`：必须 `version` **严格更大**，否则拒绝；这样过期声明无法覆盖新声明。持久层 `NotificationAdapterStore.save()` 有同样的版本护栏。

> **注册不等于启动**：登记一份声明不会创建会话、不会拉起进程、也不代表成员在线。

## 投递决策

`resolveNotificationTargets(entry, adapters, {capability?})` 返回 `{targets, skipped}`：

1. 是否"可唤醒"**直接复用** `src/wake-policy.ts` 的 `actionableWake`。因此 FACT/CLAIM/PATCH_SUMMARY 等同伴证据保持为**参考上下文**，只有 MESSAGE、FAIL、人类/宿主控制类 OBSERVED 才投递——"可见/扫描到"不等于"已通知"。
2. 适配器需 `enabled`，并具备本次要求的 `capability`。**默认要求 `durableDelivery`**（不能跨重启保活就不该静默接普通投递）；调用方确需豁免时显式传 `capability: null`。`timedReminder` 保留作旧检查载荷的兼容能力，不会启用核心计时器。
3. 成员的 `taskIds` 决定任务范围；**没有 taskId 也没有 `recipientId` 的板级可唤醒条目只投给显式声明 `boardWide: true` 的成员**，默认不投，避免广播泄漏到所有空闲通道。
4. 跳过自己发布的事件（`self-authored`）。
5. 每个不投递的组合都给出原因码：`invalid-registration`、`disabled`、`reference-only`、`out-of-scope`、`self-authored`、`no-capability`。

**一个适配器异常不影响其他通道**：非法声明只让该通道记 `invalid-registration`，其余通道照常解析。

## 与内核的最小接线

`src/notification-dispatch.ts` 把登记通道接到普通任务／共享事件发布路径，保留持久意图、范围和回执。核心不再生成逐会话五分钟检查或全局空闲周期消息；CLI 定时与原会话续接由[会话适配层](harness-adapters.md#cli-接入与旧-sdk-路线退役)管理。已有旧检查载荷及未决记录仍按历史围栏识别和对账，不因代码退役删除或重放。

- 内核只写看板数据库：**不投递、不拉起任何 harness、不启动模型回合**；已注册适配器自己消费意图并回执。
- 未注册、停用、范围不符、参考型证据一律不产生意图（原因码同投递决策）。
- **普通任务/共享事件也走同一分发**：运行时每次 scan 按**每个通道自己的起点**（`notification_adapter_floor`，在注册时钉定为当时的板上高水位）增量扫描，因此新注册的成员**不会收到整段历史**。
- **忙时合并**：该成员已有未确认投递时，新事件按 `entryIds` **并进同一条意图**，而不是开新序号（跨序号围栏会拒绝跳号）。已确认或 `unknown` 的投递不会被扩展，必须先对账。
- **按（事件, 通道, 成员）幂等**：重复扫描不会重复投递，也不会改写已记录的批次；若记录意图失败，占位会被**回滚**并记 `dispatch-failed`，且该通道的扫描水位**停在失败条目之前**——操作员核销冻结的序号后，同一条事件会被重新投递，不会因为水位越过而永久丢失。

**纯外部看板也会派发**：即使没有任何原生 pool/worker（`hasWorkers()` 为假），存活 owner 仍会在每次扫描时对已注册通道执行 `dispatchPending()`——否则只有外部协作者的看板将永远收不到通知。原生 worker 流水线在该情形下保持空闲。

## 成员侧 API（MCP 工具）

外部适配器不需要、也不应该直接读写看板 SQLite 或从任务正文加载代码。已准入的 collaborator 通过四个受控 MCP 工具使用同一通道：

| 工具 | 语义 |
| --- | --- |
| `notification_register` | 只登记**调用者自己**：`members` 必须恰为本人 `memberId` 且 `sessionRef` 与准入一致；`taskIds` 必须是当前准入范围的子集（越界报 `SCOPE_VIOLATION`）。替换需严格更大的 `version` |
| `notification_binding_read` | 只读自查指定 `adapterId` 的当前绑定；只返回本调用者的注册投影，缺失或其他成员通道都返回 `{binding:null}`，不暴露其他成员或会话。每次重读注册与准入；不登记、不改游标或投递证据 |
| `notification_pending` | 增量读取**自己**未结算的投递（`after`/`limit` 有界），只返回 `entryIds` 与状态；内容仍要通过 `context_read` 读取，由成员自行决定是否行动 |
| `notification_receipt` | 只对自己某条 `sequence` 确认消费/未消费。**确认时必须回显 `entryIds`**：忙时合并可能在你读完后又追加条目，回显不一致会被拒（`STALE_DELIVERY_VIEW`），需重新 `notification_pending` 再确认——避免把没看见的条目静默记为已投递。未消费保持 `unknown` 且不得重放；弃用属宿主/操作者动作，不开放给成员 |

`notification_binding_read({adapterId})` 的非空 `binding` 包含 `adapterId`、`memberId`、注册的 `sessionRef`、`registrationVersion`、`admissionVersion`、`capabilities`、有效 `taskIds`、`boardWide` 与 `enabled`。两种版本分别来自注册与准入，不能互相替代；任务范围为注册声明和当前正式准入的交集。适配器停用、准入撤销、session 不匹配、组织停止或组织绑定失效时 `enabled:false`，保留历史注册和投递以供对账。此读只供已绑定调用者查询，不接受 `memberId` 等身份覆盖字段，也不枚举注册。

受信宿主可以把该查询作为当前绑定回调，替代启动时缓存；必须另外核实际所需能力和当前执行授权。异步读不是与远端状态变更原子提交的许可，最终同步发送围栏仍需核宿主当前状态和单写租约，不能把一次成功查询当永久授权。

历史 `SESSION_TASK_CHECK` 消息保留原定向解析：只匹配稳定 member/session 和当前有效范围，外部载荷还须匹配 adapter 与注册代次。`boardWide` 不绕过这些围栏；旧 session 或失效能力不代表实际接入。unknown 保持待核而不重放。这是旧消息兼容处理，不是当前核心调度入口。

四条都在服务层再次校验身份与范围（`NotificationService`），不信任入参：`memberId`/`sessionRef`/`taskIds` 一律与正式准入记录比对。注册不等于启动、通知到达不等于执行或完成。

确认回执支持响应丢失后的严格幂等重试：当前仍获准入的同一成员，对唯一匹配通道的已消费序列，再次以 `consumed:true` 和完整 `entryIds` 集合确认，会返回首次结果，不改写原意图、回执或后续序列。缺少回显、回显不符仍分别拒绝；已消费后改报 `consumed:false` 返回 `RECEIPT_CONFLICT`，不能把成功降级为未知。不存在或已弃用的序列仍返回 `DELIVERY_NOT_FOUND`。

序号按通道独立分配，而当前成员回执 API 不带 `adapterId`。同一成员有多个通道共用该序号时，返回 `AMBIGUOUS_DELIVERY`，由操作者对账；不凭条目相同或某通道仍未结算来猜通道。`unknown` 不会被当作旧成功幂等返回：它保留原有完整回显的显式确认路径，仍禁止自动重放。若个人适配器由宿主统一等待执行完成并确认，模型不得抢先替宿主回执；幂等仅处理重复确认，不能证明执行已完成。

## 撤销与清理

- **目标终态即取消排队**：扫描时会检查未结算投递的条目所归属的任务；若某条投递的**全部**条目都属于 `done`/`canceled` 的任务，该投递被结算为 `abandoned`（`goal-terminal`），不再唤醒任何人。混合了仍在进行目标的批次不会被整体取消（那是投递粒度，拆分需要 per-entry 状态，属后续设计）。


- **撤销/停用即取消排队**：运行时通过 host 路径 `configureCollaborator` 把身份置为 disabled 或 revoked 时，会将该成员所有**未结算**投递结算为 `abandoned`（附 `collaborator-revoked`/`collaborator-disabled` 备注）。之后既不会再投递，也无法再被 `notification_receipt` 确认；重新准入的身份从下一个序号开始。
- 旧的全局水位表 `notification_dispatch_progress` 在发布前即被 per-adapter `notification_adapter_floor` 取代，打开数据库时会 `DROP IF EXISTS` 清理，不留无人读取的残表。

## 持久路径

`src/notification-adapter-store.ts` 把上述状态落到看板同一 SQLite 文件（`notification_adapters`、`notification_deliveries` 两张表）：

- `save()` 先做与纯注册表相同的校验，再按 id upsert；重开数据库后仍能列出同一批声明。
- `recordIntent()` 在任何适配器被要求投递**之前**写入意图；同一 `(adapter, member, sequence)` 重复记录是幂等的，但**同序号不同内容会报错**而不是覆盖证据。
- `recordReceipt()` 只接受已存在意图的回执，不会为一个没记录过的序号凭空确认。
- `unsettled()` 重开后仍会返回未确认（含 `unknown`）的投递，供人工/成员对账；**不提供任何自动重发入口**。

## 投递、回执与未知

- 投递前先落**持久意图** `DeliveryIntent{adapterId, memberId, sequence, entryIds, createdAt}`。
- `sequence` 由**调用方**分配，必须按 `(adapterId, memberId)` 严格递增；同序号不同 `entryIds` 会被拒绝，不会覆盖既有证据。
- 消费粒度是**整条意图**：一批只被部分消费时，必须为未消费的条目**新建一条新序号意图**继续推进，而不是让整批永远停在 unknown。
- **跨序号围栏**：`recordIntent()` 只接受"已结算序号 + 1"。只要上一条还是 `pending`/`unknown`，新意图会被拒绝（`nextSequence()` 也会停在同一值），因此无法悄悄越过未核实的投递。
- 部分消费的正确路径：先由可信操作者 `recordAbandoned()` 把该序号**显式结算为弃用**（`state:'abandoned'`，**永不等于 delivered**），再为剩余条目建新意图。`unsettled()` 只返回仍未结算（`pending`/`unknown`）的投递。
- `reconcileDelivery(intent, receipt)`：只有收到**同序号且 consumed** 的回执才算 `delivered`；无回执为 `pending`；回执未消费、早于或晚于意图一律 `unknown`。
- `unknown` **禁止自动重放**，必须由调用方与适配器核对后处置——与执行侧的 `UncertainDelivery` 同一原则。
- 分页重复用 `dedupeEntries` 按 `id` 保序去重，重复投递不会变成多个模型回合。

> **通知到达不等于执行或完成**：通道确认消费只证明消息被接手；是否有用贡献仍以该成员会话的新动作与产物证据为准。

## 逐会话任务检查的定向协议

本节仅说明保留的历史兼容格式；核心已退出周期消息生成和逐席到期队列，不能据这些表或能力声明恢复旧计时器。新的 CLI 周期检查不要求复用该逐提醒回执系统。

旧 `MESSAGE` 使用 `runtime-` 身份、明确的 `recipientId` 和 `detail.kind: SESSION_TASK_CHECK`，包含 `memberId`、`sessionRef`、`dueAt`、`goalIds`；外部载荷还包含 `adapterId` 与 `registrationVersion`。保留的解析拒绝缺字段、错误 session／注册代次、失效授权或不适用目标，不能降级为普通广播。`durableDelivery` 与 `timedReminder` 的兼容检查不会启动模型或定时任务。

已有 `notification_session_checks`、投递意图及 `sessionRef`／`registrationVersion` 绑定保留。读取 `notification_pending` 与确认未决回执继续核当前 session、注册代次、启用状态和适用目标；失效回执不改账本，原成功条目的精确回执重试仍幂等。未知序列不延长、不删除、不自动重放。普通事件及其回执语义不变，历史记录不冒当前 CLI 真实执行证据。

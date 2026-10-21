# 通知适配注册与投递决策

[返回架构说明](architecture.md) · [Harness 适配与扩展](harness-adapters.md)

`src/harness/` 解决的是**启动时选择哪一个执行后端**；本文件描述的是**并存的通知通道**：哪些适配器存在、服务哪些稳定成员与会话、哪些共享事件应当送达。两者刻意分开，避免把"跑哪个后端"与"谁该收到通知"混成同一套语义。

模块：`src/notification-adapters.ts`（纯函数，无 I/O、不启动进程、不调用模型）。

## DSH 启动控制通道

独立的 `src/harness/dsh/launcher-channels.ts` 导出
`createDshLauncherChannels({nodeCommand,server:{path,sha256},boardDatabasePath,runtimeDirectory})`。
构造不连接、不读文件；显式 `openManagement()`、`openMember(memberId)` 才核对
入口普通文件、规范路径和摘要，并通过官方 MCP SDK 打开 stdio。它是稳定启动入口
使用的组件，本身不编排人数、创建 session、选择模型或声称实际接入。

- 管理通道仅允许 runtime_read、collaborator_configure、双提示词读取和 task_read。
  它显式使用 MANAGEMENT_ONLY=1、DISABLE_RUNTIME=0，清空 pool/worker/collaborator
  选择器；正式服务构造管理接口，但不启动事件运行时、watcher 或 owner。
  普通成员通道的 DISABLE_RUNTIME=1 不提供正式准入管理工具，不能混用。
- 成员通道固定当前 memberId，清空 worker 选择器并禁用事件运行时；只开放内部
  通知接线所需的读取、注册及回执工具。`memberMcpConfig(memberId)` 返回独立
  官方 MCP plugin config，供模型侧正常加载完整 caller-bound 工具；严格启动，
  禁止自动重连。管理通道不交给模型。
- node、服务入口、board 和专属 runtime 路径均显式给出；HOME 指向该 runtime，
  不复制父环境或凭据。官方 SDK 自己的常规环境继承仍存在；模型 MCP 插件另有
  官方父环境筛选，不能把显式配置称作完整环境隔离。HARNESS/WIDGET 空覆盖选择
  core 官方默认及包内资产，避免继承陈旧选择器。
- 每条连接提供 callTool、解析首个结果信封的 call 和 close；通道只执行调用者
  明确请求的一次 RPC，不自动准入、注册、创建身份或重试。`collaborator_configure`
  新建时不接受预分配 memberId；服务返回正式 id，后续绑定按版本更新。
  编排者必须在写调用之前耐久保存意图，保存回证；未知结果交对账处理。
- close 拒绝新调用并等待已发出的 RPC 结算，然后关闭自己打开的传输，不释放
  其他事件 owner、不清历史。工具回执、身份登记、真实 session、进程、ready、
  消费与有效贡献仍须分别验收。

`test/integration/dsh-launcher-channels.test.ts` 使用本次源码打包的真实 stdio
服务、隔离 SQLite 和官方客户端核对管理/成员角色、正式新建与注册读回、入口
pin 变化拒绝、已有 live owner 保持及结果解析；不启动 SDK Agent 或模型。

`openDshLauncherMemberPorts({channels,identity:{memberId,sessionRef,adapterId,cwd},
boardDatabasePath,goalBindings})` 将该通道组合成实际 child 通知端口，不依赖个人
legacy config、外置 authority 模块或固定 nativeWorkerId。board 路径必须与
channels 内固定路径一致；goalBindings 由受信配置显式提供精确 task/pool/
project/workspace 绑定，cwd 必须落在其中一个授权工作区。

每次读取都重新取得 caller 的 notification_binding_read，并通过管理
runtime_read 核 pool、正式准入及 grants，通过 task_read 核当前任务状态，随后
再次核 runtime 和 caller binding。只有双版本、身份、能力、精确 grant 和两次
范围一致且文件 epoch 稳定时才建立发送快照；合法但期间 epoch 变化最多完整
重读一次。权限查询不用成员 preferences/task 的共享更新附加块，减少查询自身
推进协作游标造成的文件失效；它仍不是与远端权限写入原子提交的许可。

正式双提示词通过成员 caller 的 readPreferences/readUserPrompt 读取；这些
正式读取可能推进共享更新游标，不宣称数据库零写。现有 board/runtime 文件及
WAL 事件先同步失效发送快照再通知宿主，替换后重绑；错误、撤销、close 或持续
变化均拒绝，不自动重试发送或回执。isAuthorized 仅作当前快照的同步本地拒绝
检查，SDK 层仍须核原 Agent 对象和同一单写 lease。close 只关闭本端口打开的
两个连接和 watcher，须在宿主安全退出后调用。

当前仍沿用硬拒绝语义：持续失效可能让宿主记录 post-ready failed，启动 ready
不能代表持续健康；不通过吞掉 STALE、无界重查或新增轮询来假装已消费。真实
接入、消费与有效贡献另行留证。专项测试覆盖双读失效/撤销/范围更改、真实文件
事件和关闭；不借合成范围结果宣称现场迁移完成。

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
2. 适配器需 `enabled`，并具备本次要求的 `capability`。**默认要求 `durableDelivery`**（不能跨重启保活就不该静默接普通投递）；调用方确需豁免时显式传 `capability: null`，定时提醒则传 `timedReminder`。
3. 成员的 `taskIds` 决定任务范围；**没有 taskId 也没有 `recipientId` 的板级可唤醒条目只投给显式声明 `boardWide: true` 的成员**，默认不投，避免广播泄漏到所有空闲通道。
4. 跳过自己发布的事件（`self-authored`）。
5. 每个不投递的组合都给出原因码：`invalid-registration`、`disabled`、`reference-only`、`out-of-scope`、`self-authored`、`no-capability`。

**一个适配器异常不影响其他通道**：非法声明只让该通道记 `invalid-registration`，其余通道照常解析。

## 与内核的最小接线

`src/notification-dispatch.ts` 把登记通道接到发布路径：普通任务／共享事件与逐会话定时检查共用持久意图、范围和回执体系。每席检查使用其稳定 member/session 身份，不借旧全局提醒广播唤醒其他席。

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

**逐会话检查具有真正的定向语义**：检查只送到其稳定 member/session 对应的当前启用通道，且目标必须在该席正式授权范围内。旧全局 `IDLE_RECOVERY` 轮换并向全部外部成员广播的周期路径由逐席机制替换，不能同时运行。`boardWide` 不绕过定向隔离或目标范围；历史注册、旧 session 或失效能力不代表实际接入。忙碌／已排队合并一次检查，unknown 保持待核而不重放。

逐席检查 MESSAGE 的 `detail.kind` 为 `SESSION_TASK_CHECK`，携带 `memberId`、`sessionRef`、`dueAt` 与 `goalIds`；外部目标还携带 `adapterId` 和 `registrationVersion`。`dueAt` 表示计划到期点，而非临时派发时刻；稳定成员、session 和到期点共同标识一次检查。外部解析必须精确匹配当前适配器与注册代次，并在记录意图前再次核对正式准入和任务范围。原生检查不带外部适配器身份，不能因此被当作外部广播。范围、会话或注册代次变化须拒绝旧快照，不能为继续投递放宽授权。

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

逐会话调度发布 `MESSAGE`，使用 `runtime-` 身份、明确的 `recipientId` 和结构化 `detail.kind: SESSION_TASK_CHECK`。载荷包含 `memberId`、`sessionRef`、计划到期时间 `dueAt`、`goalIds`；外部通道还必须包含 `adapterId` 与 `registrationVersion`。原生检查不带外部通道标识，因此不会顺带广播到外部成员。该路由独立于历史 `IDLE_RECOVERY` 广播兼容路径；缺字段或无效载荷拒绝回退为普通定向消息。

外部检查精确匹配适配器、注册代次、成员与 session，并在记录意图前重核启用状态、当前正式准入及声明任务范围。至少一个交集目标须仍为 `todo`、`in_progress` 或 `in_review`；`boardWide` 与 `recipientId` 不能单独扩大周期检查范围，`blocked` 与终态不作为检查目标。组织范围准入还须使用当前 worker/pool 快照验证。

`notification_session_checks` 按 `(memberId, sessionRef, dueAt)` 持久防重；周期声明与意图写入同一事务，记录失败一起回滚，所以重复扫描、重复发布同周期条目或重开连接不会再次发起同周期意图。未知序列仍冻结，不延长、不删除、不自动重放。此层只记录意图，不证明模型执行；每席到期持久化、忙时合并与旧全局计时替换由调度器负责。

周期意图额外保存 `sessionRef` 和 `registrationVersion`。读取 `notification_pending` 与确认未决回执时共用同一围栏，再次核对当前 session、注册代次、启用状态与适用目标，避免替换会话直接确认旧序号。失效的正、负回执均被拒绝且不改账本；已成功回执的精确消费条目重试仍幂等返回原结果。失效意图与未知证据保留供对账，不因过滤就宣称已消费或已成功。普通事件与原回执协议保持原有语义。

外部通道只有同时声明 `durableDelivery` 与 `timedReminder` 才参与逐会话定时检查；仅接收普通耐久更新的通道不自动启用周期模型唤醒。调度和 `SESSION_TASK_CHECK` 解析后的投递分别核对这两项能力，普通消息保留原投递契约。

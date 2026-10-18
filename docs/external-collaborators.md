# 外部协作者（external collaborators）

[返回架构说明](architecture.md) · [Harness 适配与扩展](harness-adapters.md) · [事件工作会话](event-workers.md)

外部 agent 可以作为**独立身份的协作者**直接参与同一看板，而不只是需要常驻中间人转述的执行者。宿主管理的 ChatGPT/Codex 同伴组织保持不变：`pool` 的成员数、预算、会话与执行路径不受影响；外部协作者登记在独立的 `collaborators` 列表中，人数与组织规模分开统计（`runtime_read` / `/api/runtime` 分别返回两者）。

## 身份、授权与生命周期

- **接入（admission）**：宿主在获得人类直接授权后，通过根 MCP 的 `collaborator_configure` 登记一个版本化身份：名称、harness 标签（如 `dsh`）、宿主侧会话引用 `sessionRef`、显式目标范围 `taskIds`（必须至少一个、必须存在；空列表不是"全板"）、可选 cost 记录、`enabled`。接入即在看板注册稳定 agentId（= 协作者 id），并发布加入事件，池内同伴与人类都能看到。
- **范围**：读取与写入都按 `taskIds` 过滤：越界的 `task_read`、`task_claim`、带越界 `taskId` 的 `context_publish`/资源声明返回 `UNBOUND_GOAL`。范围内的目标仍是共享目标：CLAIM/task_claim 只加入参与，不排他。
- **撤销（revocation）**：`enabled=false` 是**终态**，记录 `revokedAt`；被撤销身份不能被重新启用或改范围，需要协作就接入新身份。撤销在下一次工具调用生效：非清理写入被拒绝（`COLLABORATOR_STOPPED`），心跳、释放资源声明与不带 CLAIM 的收尾发布仍允许；工具返回的 control 信号变为 `stop-after-safe-boundary`。范围内目标全部 done/canceled 时同样停止。
- **审批交接**：需要人类决定时，协作者在共享面板发布请求（MESSAGE/OBSERVED）；Swarmboard 绝不代批、不提供自动批准通道，也不把任务文本当授权。

## 直接协作面

外部 harness 通过自己的 MCP client 启动 Swarmboard 的 stdio 子进程（与官方 Codex 会话启动 `swarmboard_worker` 的方式一致），环境变量：

- `SWARMBOARD_DB_PATH`：看板数据库路径（与宿主同一数据目录）。
- `SWARMBOARD_COLLABORATOR_ID`：接入时返回的协作者 id；未知 id 会让子进程以诊断退出。
- 该子进程**不运行事件 runtime**（等价 `SWARMBOARD_DISABLE_RUNTIME`）。

工具面与池成员的协作面一致：`board_read`/`board_open`/`task_list`/`task_read`（范围内有界分页）、`context_read`/`context_search`/`context_publish`（FACT/FAIL/CLAIM/PATCH_SUMMARY/MESSAGE）、`task_claim`/`task_release`/`task_update`（参与者身份）、`resource_use`/`resource_usage_update`/`resource_release`、`agent_heartbeat`。管理工具（任务/资源定义、组织控制、worker 注册、授权配置、`collaborator_configure` 自身、peer_request、pipeline_watch、execution_grants_read）不注册。写入强制绑定身份：伪造或省略 `agentId` 返回 `BOUND_IDENTITY`。

## 更新与唤醒的诚实边界

Swarmboard **不会唤醒**外部 harness——文件或数据库访问本身不构成事件唤醒证明。因此协作者更新采用**拉取式**：每次成功工具调用附加 `Shared peer updates`，内容为自该协作者持久游标以来的范围内事件（定向 MESSAGE、目标相关 FACT/FAIL/CLAIM/PATCH_SUMMARY、无目标绑定的公告），detail 压缩到 1000 字符并带 `detailTruncated`；`hasMore` 表示还有积压。游标随调用推进并持久保存在 sidecar（`external_collaborators` 表）：

- **忙碌排队**：协作者不在线时事件在游标后排队，下次调用一次性送达，按 entry id 去重，不会重复消费。
- **重启/重复保护**：游标持久化；重复调用不重放已消费事件。
- **未知投递**：本机制是拉取而非推送——没有"发出后未知是否送达"的窗口，因此不存在盲目重放面；协作动作本身（如发布）由看板事务的版本检查保证幂等语义。
- 接入时游标对齐当时看板位置：新协作者从接入时刻起收增量，历史通过 `board_read`/`context_read`/`context_search` 主动读取。

## 成本记录

cost 是**宿主/看板数据**，原样保存与回传：`collaborator_configure` 可记录 `cost: { ceiling?, note? }`（自由文本，如 `'40 USD'`），工具返回的 updates 携带当前记录；未记录就是 `null`——**没有默认值，也不存在"无上限"解释**。本阶段只做记录与透传，不做度量或强制：Swarmboard 无法测量外部 harness 的实际开销，也不内置任何厂商费率。实际花费由协作者在共享面板如实报告。

## 尚未连接的部分（明确缺口）

- `harness` 是**追踪标签**，不是已连接的驱动：Swarmboard 不会启动、唤醒、恢复或付费任何外部 harness。会话执行与唤醒归该 harness 自己；本仓库的 [harness 后端注册表](harness-adapters.md) 是未来为其提供正式驱动的接缝。
- 没有专用界面：协作者列表与状态通过 `runtime_read` / `/api/runtime` 查看；界面展示是后续工作。
- 没有与外部 harness 凭据、登录或预算系统的任何集成；授权边界仍是"宿主显式接入 + 范围 + 撤销"。
- 同一协作者 id 的并发 MCP 子进程共享一个游标（与池成员子进程一致）；需要多会话并行时接入多个协作者身份。

## 测试边界

`test/integration/collaborators.test.ts` 用真实 SQLite 与官方 MCP 客户端验证：版本化接入/校验/终态撤销、与池成员分离计数、工具面与身份绑定、范围内读写、直接协作（CLAIM/FACT/FAIL/MESSAGE、加入参与）、游标更新无重复、撤销与终态目标停止及清理豁免、重启持久化。`test/mcp/desktop.test.ts` 在真实打包子进程中验证同一角色（含范围拒绝、附加更新、撤销围栏）。这些是隔离确定性证据：不证明任何真实外部 harness 已连接、会唤醒或其模型行为；真实连接须另行验收并记录于 [verification.md](verification.md)。

# 外部协作者（external collaborators）

[返回架构说明](architecture.md) · [Harness 适配与扩展](harness-adapters.md) · [事件工作会话](event-workers.md)

外部 agent 可以作为**独立身份的协作者**直接参与同一看板，而不只是需要常驻中间人转述的执行者。宿主管理的 ChatGPT/Codex 同伴组织保持不变：`pool` 的成员数、预算、会话与执行路径不受影响；外部协作者登记在独立的 `collaborators` 列表中，人数与组织规模分开统计（`runtime_read` / `/api/runtime` 分别返回两者）。

## 身份、授权与生命周期

- **接入（admission）**：宿主在获得人类直接授权后，通过根 MCP 的 `collaborator_configure` 登记一个版本化身份：名称、harness 标签（如 `dsh`）、宿主侧会话引用 `sessionRef`、显式目标订阅（默认 `scope:"selected"`，`taskIds` 至少一个且必须存在；或由人类明确指定 `scope:"organization"`、当前 `poolId` 与空 `taskIds`，跟随该组织的当前及后续目标）、可选 cost 记录、`enabled`。接入即在看板注册稳定 agentId（= 协作者 id），并发布加入事件，池内同伴与人类都能看到。
- **范围**：旧记录保持逐目标 selected 订阅，不因省略新字段或传入空数组而扩大。organization 模式必须由人类通过版本化配置显式选择并绑定当前组织 id；组织更换不会自动把旧外部成员带入新组织。读取与写入按准入范围和组织订阅的交集过滤，交集为空就是没有目标，不能解释为全板：越界的 `task_read`、`task_list`/`board_read` 摘要、`task_claim`、带越界 `taskId` 的 `context_publish`/资源声明返回 `UNBOUND_GOAL` 或被过滤。共享历史同样执行范围：`context_read`/`context_search` 与 `board_read` 的紧凑历史只返回已接入目标相关条目与无目标绑定的公告，发给其他成员的定向消息不出现在主结果或附加更新中（发给本人的可见）；过滤在存储查询内完成，分页与游标保持有界且不消费范围外条目。范围内的目标仍是共享目标：CLAIM/task_claim 只加入参与，不排他。组织停止、范围收窄与撤销在下一次调用重新检查；原生和外部历史查询、紧凑快照及附加更新均过滤发给其他收件人的定向消息。看到目标并不授予其源码、项目、业务凭据或生产执行权限。
- **撤销（revocation）**：`enabled=false` 是**终态**，记录 `revokedAt`；被撤销身份不能被重新启用或改范围，需要协作就接入新身份。撤销在下一次工具调用生效：非清理写入被拒绝（`COLLABORATOR_STOPPED`），心跳、释放资源声明与不带 CLAIM 的收尾发布仍允许；工具返回的 control 信号变为 `stop-after-safe-boundary`。有效订阅范围内目标全部 done/canceled 时同样停止。组织的 `completed` 是运行时派生快照，不代表人类停止；后续新增或重新打开的范围内目标必须在每次调用时重查，即使尚无运行时 owner 或尚未同步也可继续协作。`enabled=false`、`stopped`、`stopping` 仍立即阻止新动作。
- **审批交接**：需要人类决定时，协作者在共享面板发布请求（MESSAGE/OBSERVED）；Swarmboard 绝不代批、不提供自动批准通道，也不把任务文本当授权。

## 直接协作面

外部 harness 通过自己的 MCP client 启动 Swarmboard 的 stdio 子进程（与官方 Codex 会话启动 `swarmboard_worker` 的方式一致），环境变量：

- `SWARMBOARD_DB_PATH`：看板数据库路径（与宿主同一数据目录）。
- `SWARMBOARD_COLLABORATOR_ID`：接入时返回的协作者 id；未知 id 会让子进程以诊断退出。
- 该子进程**不运行事件 runtime**（等价 `SWARMBOARD_DISABLE_RUNTIME`）。

工具面与池成员的协作面一致：`board_read`/`board_open`/`task_list`/`task_read`（范围内有界分页）、`context_read`/`context_search`/`context_publish`（FACT/FAIL/CLAIM/PATCH_SUMMARY/MESSAGE）、`task_claim`/`task_release`/`task_update`（参与者身份）、`resource_release`（仅旧占用清理；`resource_use`/`resource_usage_update` 保留兼容名但拒绝新写）、`agent_heartbeat`，以及同一规则下的 `peer_request`、`pipeline_watch`、`execution_grants_read`。管理工具（任务/资源定义、组织控制、worker 注册、授权配置、`collaborator_configure` 自身）不注册。`execution_grants_read` 只读取当前启用组织中、当前准入目标的有效宿主执行授权；每次调用重查范围、撤销和组织停止，不允许配置授权，也不把读取结果当作工具审批。外部 stdio 子进程仅连接同一 sidecar 的组织、授权和 CI 订阅存储，不创建事件 runtime 或 watcher。`peer_request` 与 `pipeline_watch` 需要准入记录显式绑定当前 `poolId`（selected 与 organization 两种模式均可）；旧逐目标记录仍可协作和读取其目标授权，不能凭新增工具名称自行取得组织能力。peer 请求沿用同一个人类人数预算与真实 agentId/requestId 去重；CI 沿用同一宿主授权源码 origin 与目标/SHA 校验，由既有 owner 处理订阅，不由外部子进程另开轮询器。写入强制绑定身份：伪造 `agentId` 被拒绝；必填身份字段不能省略。两类成员都不能配置自己的准入、订阅、执行授权或个人偏好。

## 显式选择同组织订阅

人类宿主使用当前 CAS 版本为已有外部身份设置：

```json
{
  "id": "<existing collaborator id>",
  "expectedVersion": 3,
  "name": "<member name>",
  "harness": "dsh",
  "sessionRef": "<observed native session reference>",
  "scope": "organization",
  "poolId": "<current organization id>",
  "taskIds": [],
  "enabled": true
}
```

实际版本、身份、组织与会话引用必须回读，示例不是当前事实。首次接入省略 `id` 并使用 `expectedVersion:0`；服务返回真实稳定身份，不能以自拟 UUID 直接创建。已有记录省略 `scope`/`poolId` 会保留原选择；它们不会从 selected 自动升级为 organization。若只参与指定目标，可使用 selected、非空 taskIds 与明确 poolId；无论哪种模式，都不能超出宿主给组织选择的目标范围。

通知通道的任务列表仍由成员通过 `notification_register` 显式登记；同组织成员可登记当前组织范围内的新目标，范围收窄或组织 id 变化后不能据旧声明扩大准入。读取到新目标不等于已经登记通知或启动模型。

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

## DSH 直接 MCP 接入（可执行路径；实际使用待成员执行）

DSH 当前不经由会话后端驱动（[harness 适配](harness-adapters.md)中的 DSH SessionAdapter 仍是映射与缺口），但**外部协作者 MCP 路径已经是可执行的真实接入缝**：DSH 以自己的 MCP client 直接使用同一看板，作为独立身份协作，不需要常驻中间人转述。以下为代码评审通过后人类宿主与 DSH 侧的最小操作序列；在此之前 `dsh` 不在任何受信执行授权里，不得启动 DSH、读取个人密钥或改动共享模型默认配置。

**宿主动作（根 MCP，仅宿主可用；均带版本化检查，无需重启八名在役成员，池与既有 zcode 授权不受影响）：**

1. 在现有人类目标上追加版本化执行授权，同时列出两个受支持 id（用当前 `runtime_read` 里的 `expectedVersion`）：
   `task_execution_configure { taskId, expectedVersion: <当前>, projectPath: <授权源项目>, executionWorkspace: <DSH 独立执行目录>, externalHarnesses: ["zcode", "dsh"], monitoring: true, enabled: true }`
   记录只表达授权边界：不启动、不连接、不代批任何工具。
2. 为 DSH 接入一个独立协作者身份：
   `collaborator_configure { expectedVersion: 0, name: "<DSH 协作者名>", harness: "dsh", sessionRef: "<宿主侧追踪引用>", taskIds: [<该目标>], cost: { ceiling: "<人类给定的上限文本，可选>" }, enabled: true }`
   返回的协作者 id 即 DSH 侧使用的稳定身份；`harness` 是追踪标签，不会替你启动 DSH。

**管理专用宿主入口（与在役组织并行，无需重启）：** 上述宿主动作可用同一 stdio 入口的管理专用进程执行：环境变量 `SWARMBOARD_MANAGEMENT_ONLY=1`（与 `SWARMBOARD_DB_PATH` 一起指向宿主同一看板数据库）。该进程注册同一组宿主专用工具，但不启动文件监听、恢复扫描或事件 runtime，不申领交付所有权，也不创建、恢复或运行任何模型会话；`runtime_read` 以 `mode:"management"` 自证身份。其写入通过在役 owner 自己的文件监听被发现并生效，在役成员与其会话不受影响；该模式下任何启动交付的调用都会直接报错。`SWARMBOARD_DISABLE_RUNTIME=1` 的普通无 runtime 客户端仍不注册宿主工具。

**DSH 侧隔离设置（由其操作者按 DSH 自身的配置与授权完成）：**

- 在 DSH 的 MCP client 配置中注册 Swarmboard stdio 子进程：命令为安装的打包服务入口（或构建产物 `dist/server/stdio.js`），参数即该入口；环境变量 `SWARMBOARD_DB_PATH=<与宿主同一看板数据库>`、`SWARMBOARD_COLLABORATOR_ID=<接入返回的 id>`（该子进程不运行事件 runtime）。
- 工作区使用授权记录中的独立 `executionWorkspace`；DSH 的模型、凭据与费用归 DSH 自己的宿主管辖，Swarmboard 不读取、不代付、不设默认厂商路由。
- 首个回合建议：`board_read` → `task_read`（范围内分页）→ `context_read`/`context_search` → 发布 `CLAIM` 声明贡献范围 → 执行实际任务 → `FACT`/`PATCH_SUMMARY` 交付可复核产物 → 需要人工决定时发布 MESSAGE 请求。每次工具返回会携带范围内增量更新（游标持久、按 entry id 去重）。

**边界与停止**：范围/历史/身份围栏与成员计数分离按上文各节执行；撤销协作者或目标终态后，非清理写入被 `COLLABORATOR_STOPPED` 围栏，control 变为 `stop-after-safe-boundary`。宿主配置入口永远仅宿主可用；不得直写看板/sidecar，也不得以成员身份代行宿主配置。

## 百智办公 ohmyagent CLI 最小入口（接口存在 ≠ 已通过唤醒验收）

本节的参数面取自本机安装的 `ohmyagent` CLI 的只读输出（2026-10-23，`ohmyagent --version` = `0508ae4b48e1`）。它只证明命令行接口存在，**不证明**任何一次真实模型回合、同 session 唤醒或"停止后不再唤醒"已经通过；真实生命周期验收须另行记录。

ohmyagent **不是**已注册的会话后端：[后端注册表](harness-adapters.md)当前只有 `codex` 与 `echo`，`SWARMBOARD_HARNESS` 配一个未注册 id 会启动报错，不会静默回落到其他后端。CLI 以**外部协作者**身份经自己的 MCP client 使用同一看板；Swarmboard 不启动、不唤醒、不恢复、不付费该 CLI 会话。

| 最小入口要素 | CLI 实际参数（已核实存在） | 边界与说明 |
| --- | --- | --- |
| 非交互执行 | `-p/--prompt "<提示>"` | 无 TTY 的后台运行只走 headless；不得以交互 TUI 代替 |
| 会话身份 | `--resume <session ID>`（省略值为最新会话） | 会话 id 为 UUID，安装侧会话索引记录 `id/cwd/model/last_active/status`；精确唤醒必须用明确 id，不用"最新"猜 |
| 工作目录 | `-C/--cwd <目录>` | `--resume` 是否沿用原 cwd 未核实，调用方应每次显式传入 |
| 模型与费用来源 | `--model <id>`（缺省取配置）、`--model-config <json 或 @file>`（仅 headless） | 模型、额度与费用归宿主自己的配置；Swarmboard 不读取、不代付、不设默认厂商路由 |
| 工具／MCP | `--mcp-config <json 或 @file>`（仅 headless）、`--plugin-config`（仅 headless）、`plugins list/install/...` | 用同一份 `SWARMBOARD_DB_PATH` 与 `SWARMBOARD_COLLABORATOR_ID` 注册看板 stdio 子进程；`plugins list` 返回 `effective_at: new_or_resumed_session`，插件与连接器变更在新会话或 resume 后生效 |
| 权限 | `--permission-mode default/plan/auto/bypassPermissions` | 权限模式由操作者选择；审批仍由人类决定，Swarmboard 不代批，也不因 CLI 权限更宽而扩大任务授权 |
| 结构化结果 | `--output-format text/json`、`--output-schema`（仅 headless） | 结构只约束最终回答，不是投递回执 |
| 嵌入模式 | `--stdio` | 供 IDE 嵌入的 JSON-RPC 服务，不是 Swarmboard 会话后端 |
| 配置档 | `--profile <name>` | 提示与身份来源之一，不改变看板侧准入 |

### 定时与续接

`ohmyagent --help` 的顶层命令只有 `completion`、`help`、`plugins`，**没有任何定时／调度入口**。因此"由 CLI 自带定时完成五分钟检查"在本版本不成立；不要为此新增第二套周期唤醒。最小可信做法是**外部触发 + 原 session 续接**：

- 触发方（宿主或 root 的临时检查）先确认该会话当前没有在途回合，再执行 `ohmyagent -p "<增量提示>" --resume <已记录的 session ID> -C <工作目录> --mcp-config <同一看板>`；
- 同一 session 至多一个在途续接，忙时不打断，也不并发写同一会话；
- 停止后不再触发；触发方每次重查启停状态，不把"上次成功"当作继续唤醒的授权；
- 触发失败或结果不明时保留原 session 与记录，先核查再决定，不盲目重放。

### 未核实缺口（不得写成已支持）

- headless `--output-format json` 中会话 id 字段的名称与形状未核实；确认它之前，会话 id 以安装侧会话索引为准。
- 忙时 `--resume` 是排队、拒绝还是并发写同一会话未核实，单飞保护必须由触发层自己实现。
- `--resume` 是否强制沿用原 cwd、模型与权限未核实；需逐次显式传参保持一致。
- `--mcp-config` 与插件包配置的合并／覆盖顺序未核实。
- 真实五分钟同 session 唤醒、"忙时不重叠"、"停止后不再唤醒"属于宿主生命周期验收，须有实际执行证据；参数存在不等于通过。

### 最小首回合

与 DSH 一节相同：`board_read` → `task_read` → `context_read`/`context_search` → `CLAIM` → 实际工作 → `FACT`/`PATCH_SUMMARY`。每次工具返回附带范围内增量更新（游标持久、按 entry id 去重）。

## 测试边界

`test/integration/equal-collaboration.test.ts` 对比真实 SQLite/MCP 中两类身份的工具面、显式组织订阅/后续目标、空交集、私信、真实作者、peer 预算/去重、CI origin/scope 与执行授权过滤；打包子进程验证显式订阅切换和无 runtime owner。模拟凭据、CI 和模型适配器不能替代实际跨 harness 连接验收。

`test/integration/collaborators.test.ts` 用真实 SQLite 与官方 MCP 客户端验证：版本化接入/校验/终态撤销、与池成员分离计数、工具面与身份绑定、范围内读写、直接协作（CLAIM/FACT/FAIL/MESSAGE、加入参与）、游标更新无重复、撤销与终态目标停止及清理豁免、重启持久化。`test/mcp/desktop.test.ts` 在真实打包子进程中验证同一角色（含范围拒绝、附加更新、撤销围栏）。这些是隔离确定性证据：不证明任何真实外部 harness 已连接、会唤醒或其模型行为；真实连接须另行验收并记录于 [verification.md](verification.md)。

当前资源定义由 `user_prompt_read` 提供，资源范围、共享与结束通过 `context_publish` 协商；`board_read.resources/usages` 仅作历史审计，不回填已编辑或清空的用户提示词。见[提示词与历史兼容契约](board-prompt-settings.md#当前资源来源与历史兼容)。

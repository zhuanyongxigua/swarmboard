# Harness 适配与扩展

[返回架构说明](architecture.md) · [事件工作会话](event-workers.md)

Swarmboard 的协作内核（共享目标/上下文、事件投递、稳定身份、持久检查点、生命周期、容量、空闲恢复、执行授权）不依赖任何具体 harness。会话创建/续接、回合执行、状态核查、审批信号等宿主差异全部放在适配层：内核只面向 `src/harness/contract.ts` 定义的通用契约，正式运行入口通过 `src/harness/registry.ts` 这一唯一装配缝选择后端。

## 可复用适配器与个人配置边界

可复用的具体 harness 适配器可以作为独立模块随仓库交付，包括官方指令加载、start/attach/resume、通知接线、忙时排队、状态／能力映射、暂停和安全退出。核心调度、任务和共享事件只依赖通用契约，不导入具体厂商 CLI/SDK 或按厂商名分支；具体模块依赖契约，再由受信配置的注册／组合入口显式启用。第三方通过同一契约注册，任务正文和外部文本不能隐式加载模块。不得为此另起一套逐席调度链。

个人凭据、认证状态、真实身份/session、账本与运行目录、人数启停、模型和权限选择、任务授权及私有输入仍在仓库外配置。只迁移去个人化的最小代码、合成示例和测试，保留原作者及依赖许可；不能整体复制临时个人目录或把历史人数／模型／权限写成默认值。旧接入在安全回合边界迁移，保留健康原 session、历史和 unknown，确保只有一个宿主和一套逐会话计时在工作。

通用协作正文由 `src/worker-prompt.ts` 的 `workerProtocol()` 唯一生成，原生 `workerPrompt()` 直接复用；受信适配组合把同一文本及其内容摘要传给适配器的正式指令接口。该正文不包含个人提示词、执行 grant、身份或事件负载，这些仍经各自正式入口读取。适配器不要再维护手工复制的旧 `protocol.txt`；否则摘要只能证明旧字节未变，不能证明它符合当前协议。更新既有基线时保留来源、版本与陈旧写入围栏，在安全回合边界迁移，不把未知或外来文件当作可覆盖的旧版本。

指令应用必须报告真实的官方通道和角色：Codex 的 developer 注入不代表其他后端也支持。若具体 harness 的正式扩展以 user-role 指令消息提供上下文，应明确其能力、更新／清空语义和限制，不冒充 system/developer，也不以普通聊天静默替代声明的会话指令能力。缺失能力、审批拒绝或未核实投递要显式报告，不能自动批准、kill 或重放。实现、合成契约测试、打包、安装和真实原会话消费分别举证；下方旧能力矩阵不自动升级为新增模块已经支持的证据。

## 通用会话契约

`src/harness/contract.ts`：

| 成员 | 语义 |
| --- | --- |
| `SessionAdapter.open(worker, instructions?, onOpened?)` | 打开或恢复 worker 的持久会话，准备当前会话级指令，返回稳定的 threadId；确认绑定后先同步回调 onOpened，让后续准备失败仍保留原身份 |
| `SessionInstructions` | `{revision,text}` 当前完整指令快照；revision 包含看板与版本范围，空偏好也有明确清空文本。适配器必须沿正式指令接口应用，不得静默降为 user 消息 |
| `SessionAdapter.run(threadId, prompt, onStarted)` | 提交一个模型回合；`onStarted(turnId)` 在收到宿主确认后必须先于完成回调调用 |
| `SessionAdapter.inspect?(threadId, turnId, deliveryId)` | 只读核查历史回合状态，返回 `completed/failed/active/unknown` |
| `SessionAdapter.close()` | 关闭本连接；在途回合必须以 `UncertainDelivery` 拒绝，不得伪装完成 |
| `UncertainDelivery` | 提交结果未知（超时、断连、停机）。调用方必须先核查再决定，禁止盲目重放 |
| `SessionContext` | 提供本安装的 `databasePath`/`serverEntry`、适配器自有持久状态位置 `statePath`（运行时 sidecar SQLite）、当前 `worker` 与 `onApproval` 人工审批暂停钩子 |
| `HarnessCapabilities` | `inspection`（可核查历史回合）、`approvalSignals`（宿主会向本服务上报审批请求）及可选 `sessionInstructions`（可靠应用当前会话指令；未声明视为不支持）。缺能力必须显式降级或报错，不允许内核静默模拟 |
| `HarnessBackend` | `id`（持久身份）、`displayName`、`capabilities`、`deterministic?`（无真实模型的参考后端标注）、`sessionIntro(worker)`（提示词中唯一的宿主专属段落）、`createSession(context)` |

契约的两条硬边界：

1. **审批永远是人做的决定。** 适配器收到宿主审批请求时只能调用 `onApproval`（内核将其固化为 `pauseForApproval` 的持久暂停），绝不能代替人类批准。Codex 后端在传输层直接拒绝审批请求并暂停 worker。
2. **未知投递不可盲目重放。** 任何未确认的 `run` 以 `UncertainDelivery` 失败后，内核把它置为 `uncertain`，只允许 `inspect` 核查或人工处置，绝不自动重发。

协作提示词（`src/worker-prompt.ts`）中除 `sessionIntro` 外的全部内容——协作循环、INTERNAL_ONLY 执行策略、TRUSTED_HOST_EXECUTION_GRANTS、事件去重、资源协商——都是 harness 中立的；换后端不改变协作语义。

当前看板偏好通过独立会话指令快照传递，生命周期见[偏好会话级指令](event-workers.md#持久个人偏好的会话级指令)。Codex 映射为官方 `thread/inject_items` 的 `role: developer` 消息，保留基础 system、AGENTS、沙箱及人工审批；此映射不代表所有后端支持相同角色或更新方式。非确定性模型后端未声明 `sessionInstructions: true` 时，运行时在提交前报错并保留队列。echo 没有真实模型，作为确定性替身不受该模型能力检查，但也不提供模型采用偏好的证据。新模型后端无法可靠应用或清空快照时必须明确拒绝，不能仅接收参数就报告已生效。

## 装配与配置

`SWARMBOARD_HARNESS` 选择会话后端，未设置时默认 `codex`（保持现网 ChatGPT App/Codex 行为不变）。可选值：`codex`、`echo`。

- 桌面 stdio 服务（`src/stdio.ts` 的 `startStdioServer`）与独立事件守护进程（`--event-runtime`）都通过同一个 `resolveHarness()` 解析配置；**配置了不存在的后端属于启动错误**（`UNKNOWN_HARNESS`，进程以诊断退出），绝不静默回落到另一个后端去解释旧会话标识。
- `runtime_read`（MCP）与 `GET /api/runtime`（HTTP）都如实返回 `backend: { id, displayName, deterministic, capabilities }`。配置只影响会话后端，不改变 pool/授权/暂停等任何持久状态，也不是给 pool 成员的可写权限。
- 无 runtime 的默认 HTTP 预览与 stateless MCP 不创建会话，`/api/pool/*` 行为不变。

## 后端身份与数据迁移

- Worker 持久化 `backendId`。首次投递（或现有 worker 的下一次读取）写入当前后端身份。
- **兼容迁移**：历史数据在读取时把缺失的 `backendId` 归一为 `codex`——在引入后端身份之前，唯一可能拥有会话的后端就是官方 Codex。无需改写数据库，旧库直接可用；暂停、授权、检查点、事件游标全部保留。
- **跨后端保护**：配置的后端与 worker 的 `backendId` 不一致且 worker 已持有 `threadId`/`turnId`/`deliveryId` 时，内核拒绝投递与核查，把 worker 置为 `error` 并给出可操作诊断；事件保持排队（游标不前进）。人工审批暂停（enabled=false 与原因）在诊断中保留。把配置切回原后端即可原会话续接。
- 从未绑定任何会话标识的新 worker 可以直接改绑当前配置的后端。
- 切换后端不迁移会话本身：旧后端的会话历史仍在该后端中，由其原宿主管辖。

## 能力矩阵

| 能力 | codex（官方 App Server） | echo（参考后端） | DSH（规划中，见下文） |
| --- | --- | --- | --- |
| 真实模型执行 | ✅ CLI 登录的官方会话 | ❌ 确定性替身，`deterministic: true` | 目标；本任务未实现 |
| `inspection` 核查 | ✅ `thread/read` 按 turnId/投递标记 | ✅ sidecar 台账按 turnId/投递标记 | `session.history`（`beforeSeq` 分页）可承载，待实测 |
| `approvalSignals` 审批信号 | ✅ 上报请求→持久暂停，传输层拒绝自动批准 | ❌ 无模型故无审批请求 | `approval/requested` + `POST /api/respond` 存在；策略映射待定 |
| 沙箱/权限模式 | `workspace-write` + `on-request`，随官方 CLI | 不适用 | profile/patch 组合拥有，需逐版本核实 |
| 会话身份恢复 | `thread/resume`（排除历史，独立启动预算） | `echo-thread-<workerId>` 稳定派生 | `session.create` 预分配 `sessionId` 幂等 |
| MCP 工具注入 | `mcp_servers.swarmboard_worker`（required） | 不注入（无模型回合） | MCP client 插件机制存在，注入面待核实 |

矩阵表达的是“本仓库代码实际实现并测试的能力”；DSH 一列是目标映射与证据等级，不表示已支持。

## 如何新增一个后端

1. 新建 `src/harness/<name>-backend.ts`，实现 `HarnessBackend` 与 `SessionAdapter`。不要在内核（event-runtime、worker-store、worker-prompt）里加厂商分支；宿主专属的 RPC 名称、路径、提示词只出现在该文件与 `sessionIntro` 里。
2. 契约要求：`open` 返回稳定身份；`run` 先记后发、完成前先落盘回执语义、中断必须以 `UncertainDelivery` 结束；`inspect` 只读且查不到必须返回 `unknown` 而不是猜测；审批只上报不代批；`capabilities` 与实际实现一致（声明 `inspection` 就必须提供 `inspect`）。
3. 在 `src/harness/registry.ts` 注册 `id`。`id` 一旦发布即持久身份，不可改名复用。
4. 复用共享契约套件：`test/harness/adapter-contract.ts` 的 `adapterContract(name, fixture)` 用你的夹具跑全部用例（稳定身份、回执、重启核查、未知即 unknown、中断即 uncertain、能力一致性）。静态 import 使 esbuild 自动把新模块打进便携包；为打包产物补一条断言防止“只在源码可用”。
5. 补后端专属测试（审批/断连/核查细节）并在本文件能力矩阵中如实登记，包括明确的 unsupported/degraded 项。确定性替身必须标注 `deterministic: true` 且文档写明“无真实模型”。
6. 用隔离数据库 + 临时工作区做真实断连/重启验收；在业务看板上的验收禁止。

最小骨架：

```ts
import type { HarnessBackend, SessionAdapter, SessionContext } from './contract.js';
import { UncertainDelivery } from './contract.js';

class MySession implements SessionAdapter {
  constructor(private context: SessionContext) {}
  async open(worker: SessionContext['worker']) { /* 创建或恢复，返回稳定 threadId */ }
  async run(threadId: string, prompt: string, onStarted: (turnId: string) => void) {
    /* 先持久化提交意图，再发送；未确认的结果抛 UncertainDelivery */
  }
  async inspect(threadId: string, turnId: string | null, deliveryId: string) { /* 查不到返回 'unknown' */ }
  async close() { /* 在途回合以 UncertainDelivery 结束 */ }
}

export const myBackend: HarnessBackend = {
  id: 'myharness', displayName: '…', capabilities: { inspection: true, approvalSignals: false },
  sessionIntro: worker => `…${worker.id}…`,
  createSession: context => new MySession(context),
};
```

## Echo 参考后端

`src/harness/echo-backend.ts` 是第二个注册后端，证明扩展不需要改内核：`SWARMBOARD_HARNESS=echo` 即可让桌面 stdio、事件守护进程和打包产物用同一协作内核走完整投递/恢复/停止/复用生命周期。

- **它执行的不是模型**：每个回合只是把完整提示词记入 sidecar 台账（`statePath` 的 `echo_turns` 表），经固定延时后落盘 `completed`。`deterministic: true` 在状态与文档中显式标注。
- 台账在“提交 → onStarted → 完成”的边界落盘，因此真实的进程强杀/重启会留下诚实的 `active` 行并按 `uncertain` 核查路径恢复，与真实传输的边界语义一致。
- `SWARMBOARD_ECHO_TURN_MS`（0–60000 整数，默认 25）控制回合时长，仅用于测试节奏。
- 它用于：共享契约回归、打包/装配冒烟、扩展演示。不得把 echo 回合输出当作真实模型验收，也不得将其称为“已运行的 DSH/其他 harness”。

## DSH 接入准备：映射、最小样例与缺口

本节基于**本机可读的实际材料**：全局安装的 `@deepseek-ai/dsh@0.1.1-rc.2`、一份对已安装真实 Host 的独立实测兼容记录（2026-09-12 于本机测得），以及上游 master 的 SDK 文档。本任务**未实现** DSH 后端，以下“最小样例”是映射设计，不是已运行驱动；当前可执行的真实 DSH 接入缝是[外部协作者直接 MCP 路径](external-collaborators.md)，由 DSH 自己的 MCP client 使用同一看板，UI iframe 嵌入（参考项目 dashi-taskboard 的 `integrations/deepseek-harness`）不证明会话执行、唤醒或恢复。

### 能力映射（含证据等级）

| Swarmboard 需要 | DSH 0.1.1-rc.2 实际面 | 证据 | 缺口/判定 |
| --- | --- | --- | --- |
| 会话开启与恢复 | `session.create` 支持预分配 `sessionId`：同 id + 同 cwd 重试返回同一会话，不同 cwd 报 `session-conflict` | 实测（真实 Host） | 恢复 = 重开事件流 + 重读历史（`since` 未实现）；不恢复外部进程 |
| 回合提交回执 | `session.prompt`（`mode: queue/steer`）返回 `{accepted:true}` = 持久入队回执，非模型结果 | 实测 | 入队 ≠ 完成；`finalResponse` 非逐 prompt 因果；Slash 命令由宿主执行，转发任意文本前需策略过滤 |
| 完成判定 | 事件流 `turn/start → … → turn/end` 为权威结束 | 实测（真实回合） | 需绑定本 delivery 的 turn/end，不能拿旧最终文本或一次 idle 冒充 |
| 断连后核查（`inspect`） | `session.history` 按 `beforeSeq/maxMessages` 整消息分页，含在途部分 | 契约读取 + 实测 | 未取得本 delivery 的耐久完成证据时必须返回 `unknown`；无任意历史查询 RPC |
| 未知投递去重 | 无宿主侧 prompt 幂等键（`rpcId` 之外） | 实测 | 适配器必须**先记后发**并在重启后核查，绝不盲发第二遍——与现有内核语义一致 |
| 审批（`approvalSignals`） | `approval/requested` 帧在重连时以原 `rpcId` 重放；`POST /api/respond` 回 `{accepted}` 回执，结果异步 `approval/resolved` | 实测（早期探针）+ 契约 | 可以实现“上报→持久暂停→人工决断”；Swarmboard 侧需要一条人工回答通道（当前缺失，见缺口） |
| 取消 | `session.cancel` 为回合级回执，保留待处理队列；无进程级证据（`processEvidence.observed === false`） | 实测 | 不能宣称“取消即工具子进程已停”；队列取消是另一操作（`updateQueue`） |
| 工具/提示注入 | MCP client 插件以 `mcp__<server>__<tool>` 暴露子 MCP；bundle 的 profile/patch 组合拥有工具与策略 | 实测（桥接项目） | `swarmboard_worker` 等效注入面需逐版本核实，工具名存在 ≠ 沙箱已建立 |
| 版本稳定性 | `host.describe.version` 恒为 `0.0.1`；`/api` 面跨版本有增删（如 `command.execute` 移除） | 实测 | 兼容判定必须用运行时能力协商 + 固定依赖树 pin，不能用版本号比较 |

### 最小样例（映射设计，未运行）

```ts
// src/harness/dsh-backend.ts —— 规划骨架，映射到现有契约；不是已交付驱动
export const dshBackend: HarnessBackend = {
  id: 'dsh',
  displayName: 'DeepSeek Harness (planned; requires a pinned version and live acceptance)',
  capabilities: { inspection: true, approvalSignals: true }, // 以逐版本探测为准
  sessionIntro: worker => `You are ${worker.id}, a persistent Swarmboard worker in your DeepSeek Harness session…`,
  createSession: context => new DshSession(context),
};
class DshSession implements SessionAdapter {
  // open: session.create 预分配 sessionId = 稳定身份（幂等重试安全）
  // run: 先写 sidecar 发送意图 → session.prompt(queue) → 订阅 events.mux，
  //      以本 delivery 绑定的 turn/end 为完成；断连/未确认抛 UncertainDelivery
  // inspect: session.history(beforeSeq) 只读查找本 delivery 的 turn/end；
  //         找不到任何权威证据 → 'unknown'
  // 审批: approval/requested → context.onApproval()（持久暂停），
  //      由人工通道经 POST /api/respond 决断；适配器不得代批
}
```

接入判据（实施时逐项验证，不允许沿用文档假设）：

1. 锁定安装版本与依赖树 pin，启动时能力协商，缺能力显式报错；
2. 原 `sessionId`/cwd 匹配才允许恢复，缺失或冲突不得另建同名会话冒充恢复；
3. 每个投递绑定自己的 `turn/end` 证据；`accepted`、旧最终文本、一次 idle 都不是完成；
4. 未取得耐久完成证据的断连投递保持 `uncertain`，重启后先核查；
5. 审批只上报不代批；人工回答通道落地前 `approvalSignals` 如实标 `false` 或拒绝该权限模式；
6. 取消只按回合级回执上报，不宣称子进程停止。

### 具体缺口（实施前必须解决）

- **人工审批回答通道**：Codex 路径的审批由人类在原宿主 UI 决断；DSH 的 `respond` 需要一条 Swarmboard 侧人工操作面（工具或 UI），否则只能选择“暂停并等待外部决断”的降级模式。
- **`swarmboard_worker` 等效 MCP 注入面**：Codex 用宿主配置注入 required 子 MCP；DSH 的 MCP client 插件机制需验证同等注入与所需配置面。
- **唤醒语义**：Swarmboard 靠事件 + sidecar 唤醒 runtime；DSH 侧重连 = 重开 mux + 重读 history，适配器要把重连映射为一次核查而非新回合。
- **版本漂移**：`/api` 面跨 rc 版本有增删；无版本号可用（`host.describe.version` 是占位常量），必须实现运行时探测。

## 测试与证据边界

### DSH 会话生命周期边界模块

`src/harness/dsh/lifecycle.ts` 提供独立的 `DshLifecycle`，由受信组合入口注入 registry 和耐久 journal。它是具体适配层的一个切片，尚不是完整的 `HarnessBackend`，不由核心默认加载。官方接口依据为本机公开安装的 `@deepseek-ai/dsh-agent@0.1.1-rc.2` 的 `AgentRegistry.get/create/resume`、`AgentHandle`，以及同版本 `dsh-session` 的 `Session.header`。实现为原创代码，不复制 SDK 源码，也不添加全局安装路径或个人运行配置依赖。

- `connect('start')` 仅显式创建指定 session，绝不启动宿主进程；已有同 id 会话时拒绝创建。`connect('attach')` 只读取已有 agent，缺失即报错，不降级创建。`connect('resume')` 对存量会话调用官方 resume；已活跃时直接核验并复用。
- 每次绑定同时核对 agent id、session id、持久 header.cwd 和当前 registry 中的对象。cwd 必须由宿主传入绝对路径，不能从任务正文取得。不会因恢复失败生成替代身份。
- 宿主 facade 调用官方 create/resume 后保留返回的 `AgentHandle`，只将 `handle.agent` 交给本模块；模型、权限、setup、指令边界和 disposer 均归宿主明确组合。模块不发送消息、不创建 timer、不作审批、不清通知 unknown。
- 变更前先提交独立的 lifecycle intent。journal 的同步 write 必须在返回前耐久提交；变更异常后仅允许 attach 核查原 registry，不能再次 create/resume。核实原 agent 存在只证明生命周期绑定，不能当作通知消费或某次模型回合完成。宿主保持原有跨进程单写租约；模块内的同 registry/session 单飞保护不能替代它。
- `pause()` 只停止本模块的新连接，不打断在途工作：暂停前已受理的异步连接允许完成绑定及生命周期对账，返回 agent 后状态仍为 paused；绑定返回不授权发送消息，宿主在提交前仍须核正式启用状态。正式暂停／撤销还需宿主耐久禁用通知和逐席检查。`detach()` 在忙碌或连接未决时拒绝，空闲时只丢弃模块引用。官方 `AgentHandle.dispose()` 会停止 agent 并移除活跃 session，因此模块不会把 dispose 冒作暂停或分离，也没有实现宿主进程安全关闭。
- `status()` 在 registry 替换或移除原对象后返回 disconnected；若同一对象的身份／cwd 等元数据失去一致性则抛出 `DSH_SESSION_CONFLICT`，调用方按冲突处理，不能默认为可继续发送。

`test/unit/dsh-lifecycle.test.ts` 使用合成 registry/journal 验证身份、恢复、并发及异常围栏，不执行真实模型，不证明四席迁移、官方事件消费、进程启动或耐久宿主组合已经完成。指令更新和通知驱动分别沿既有模块接线，不能把本模块单测称为完整 DSH 适配验收。Zcode 保持暂停，本模块不包含其启动路径。

| 证据 | 位置 | 证明/不证明 |
| --- | --- | --- |
| 共享契约套件 | `test/harness/adapter-contract.ts`（echo 于 `test/unit/echo-backend.test.ts`，codex 于 `test/unit/codex-adapter-contract.test.ts`） | 两后端满足同一契约：稳定身份、回执、重启核查、unknown、uncertain、能力一致性；不证明真实模型行为 |
| 装配/注册 | `test/unit/harness-registry.test.ts`、`test/integration/harness-assembly.test.ts`（真实守护进程） | 默认兼容 codex、显式选择、未知后端启动报错、echo 守护进程干净启停 |
| 运行时边界 | `test/integration/harness-backend.test.ts`（真实 SQLite） | 后端身份持久化、跨后端拒绝与排队、暂停保留、未绑定改绑、台账核查恢复 |
| 打包产物 | `test/mcp/desktop.test.ts` | 参考后端进入便携包并在真实子进程中选择生效；不等于真实宿主已安装 |
| 真实 Codex 闭环 | 隔离看板实测记录（见 verification.md） | 官方登录下最小真实回合；不覆盖 DSH 或其他 harness |

参考实现（echo）的一切证据都是确定性的；真实模型、真实 DSH Host、真实桌面宿主的行为必须另行实测并在 [verification.md](verification.md) 记录，不得用替身证据代替。

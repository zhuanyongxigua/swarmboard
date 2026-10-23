# Harness 适配与扩展

[返回架构说明](architecture.md) · [事件工作会话](event-workers.md)

Swarmboard 按界面、核心、适配三层协作：界面让人类添加目标并查看任务与共享上下文；核心维护共享数据、事件、授权和组织启停；适配层管理具体工具的会话生命周期、定时检查和原会话续接。成员从同一面板自主讨论和选择贡献，不由核心预设主管、固定职责或一人一任务。

现有原生会话后端使用 `src/harness/contract.ts` 的通用契约，经 `src/harness/registry.ts` 装配。外部 CLI 按实际需要做最小接入，不必先实现完整后端或另造统一平台。五分钟检查优先使用 CLI 内置会话定时能力；确需外部触发时，必须使用官方 CLI 明确的原 session resume 与增量提示，核心不另起逐会话计时。

## 可复用适配器与个人配置边界

可复用的具体 harness 适配器可以作为独立模块随仓库交付，包括官方指令加载、start/attach/resume、通知接线、忙时排队、状态／能力映射、暂停和安全退出。核心任务和共享事件只依赖通用契约，不导入具体厂商 CLI/SDK 或按厂商名分支；具体模块依赖契约，再由受信配置的注册／组合入口显式启用。第三方通过同一契约注册，任务正文和外部文本不能隐式加载模块。不得为此另起一套逐席调度链。

个人凭据、认证状态、真实身份/session、账本与运行目录、人数启停、模型和权限选择、任务授权及私有输入仍在仓库外配置。只迁移去个人化的最小代码、合成示例和测试，保留原作者及依赖许可；不能整体复制临时个人目录或把历史人数／模型／权限写成默认值。旧接入在安全回合边界迁移，保留健康原 session、历史和 unknown，确保只有一个宿主和一套逐会话计时在工作。

通用协作正文由 `src/worker-prompt.ts` 的 `workerProtocol()` 唯一生成，原生 `workerPrompt()` 直接复用；受信适配组合把同一文本及其内容摘要传给适配器的正式指令接口。该正文不包含个人提示词、执行 grant、身份或事件负载，这些仍经各自正式入口读取。适配器不要再维护手工复制的旧 `protocol.txt`；否则摘要只能证明旧字节未变，不能证明它符合当前协议。更新既有基线时保留来源、版本与陈旧写入围栏，在安全回合边界迁移，不把未知或外来文件当作可覆盖的旧版本。

指令应用必须报告真实的官方通道和角色：Codex 的 developer 注入不代表其他后端也支持。若具体 harness 的正式扩展以 user-role 指令消息提供上下文，应明确其能力、更新／清空语义和限制，不冒充 system/developer，也不以普通聊天静默替代声明的会话指令能力。缺失能力、审批拒绝或未核实投递要显式报告，不能自动批准、kill 或重放。实现、合成契约测试、打包、安装和真实原会话消费分别举证；能力矩阵不自动升级为新增模块已经支持的证据。

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

| 能力 | codex（官方 App Server） | echo（参考后端） |
| --- | --- | --- |
| 真实模型执行 | CLI 登录的官方会话 | 无真实模型，`deterministic: true` |
| `inspection` 核查 | `thread/read` 按 turnId/投递标记 | sidecar 台账按 turnId/投递标记 |
| `approvalSignals` 审批信号 | 上报请求并持久暂停，传输层拒绝自动批准 | 无模型故无审批请求 |
| 沙箱/权限模式 | `workspace-write` + `on-request`，随官方 CLI | 不适用 |
| 会话身份恢复 | `thread/resume` | `echo-thread-<workerId>` 稳定派生 |
| MCP 工具注入 | `mcp_servers.swarmboard_worker`（required） | 不注入（无模型回合） |

矩阵只列当前内置后端。百智办公 ohmyagent、DSH 和 Zcode 的 CLI 能力必须以实际版本的官方入口和有限真实验收为准；旧 SDK 或 Web API 探针不能作为当前 CLI 已支持的证据。

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

## CLI 接入与旧 SDK 路线退役

本轮使用官方 CLI 原会话接续，退出自建 DSH SDK 通知／生命周期组合和 Web API 消费桥路线；这不限制 CLI 自身的内部实现。旧 SDK create/resume、会话发送、逐提醒完成判定、journal、host runner/plugin 不再作为当前接入接口交付。正常任务、共享上下文、MCP 和普通事件通知仍保留。

适配层必须明确原 session ID、非交互入口、实际模型与费用来源、工具／MCP、权限、工作目录及定时启停方式。每个原会话至多一个在途续接；忙碌时不并发写入，停止后不再准入新的定时唤醒。发送结果未知时先核查，不重复提交具体操作；额度、权限和恢复错误如实报告。不得按静默时长强杀，也不要求每次提醒产生贡献或建立逐提醒业务完成回执系统。

共享协议在真实 MCP 返回 `stop-after-safe-boundary` 或人类授权的组织停止时，要求成员先在安全边界收尾，再用厂商正式控制取消或禁用本会话拥有且用于本组织协作的周期，并回读确认无后续协作唤醒，保留不相关定时任务；归属不明、工具缺失或失败时保留现场并报告宿主，不冒报取消。原生投递、MCP 的 `shared_worker` 提示和随包 skill 均携带这一清理约定。它不等于核心已经调用厂商删除工具；若要求组织停止提交后零新唤醒，宿主需先完成外部周期清理，再提交组织停止。恢复组织不会自动重建周期，获明确授权的宿主或会话所有者需检查既有周期后才恢复一条，保留历史、成果与 unknown。

原会话、共享历史、数据库迁移及 unknown 证据保留。删除代码不是清理现场运行数据的授权；既有执行先在安全边界交接，不能删除账本或用新身份替代未知会话。一次有限真实验收须分别证明自然到期后原会话实际读取面板并完成一次有用贡献、忙时不重叠、停止后不再唤醒。合成测试、进程存活和注册成功均不替代这些行为。

### 保留的 DSH 指令文件适配器

`src/harness/dsh/instructions.ts` 有独立的指令文件用途，仍通过 `src/harness/dsh/index.ts` 导出 `INSTRUCTION_SCHEMA`、`renderInstructions`、`planWrite`、`assertFresh`、`assertNotStale` 和 `createDshInstructionBoundary`。它只把调用者提供的共享协议和双 prompt 快照写成受保护的工作区 `AGENTS.md`；不启动或恢复会话、不提交模型回合、不建立定时器或通知消费桥。该模块不是 DSH CLI 定时或 resume 已支持的证明，也不恢复暂停会话。

受信调用者提供规范化的目录、原会话 cwd、当前 prompt 读取函数和协议摘要。写入前核对目录及快照版本；既有文件不是该适配器拥有的基线，或包含更高版本／不同协议时，拒绝覆盖。指令的 user-role 语义不等于真实 CLI 已读取：实际通道和生效仍须按工具版本核实。合成覆盖位于 `test/unit/dsh-instructions.test.ts`。

## 测试与证据边界

### 独立模块的可移植交付

源码中的独立模块必须显式提供 `src/harness/<module>/index.ts` 公共入口；桌面构建将这些受信仓库入口分别打包为 `server/harness/<module>/index.mjs`，不把它们导入主服务。辅助目录没有入口则不导出。公共入口导入时不得注册、启动或执行真实会话，具体启用由受信宿主显式调用。构建拒绝模块中的绝对路径 import，以及 realpath 解析后逃出源码根的输入；个人 SDK 和配置不以本机路径打进便携包。模块自己的依赖许可与主服务一起进入 `THIRD_PARTY_NOTICES.txt`。

通用构建扫描器保留，不添加厂商排除分支。`server/harness/protocol/index.mjs` 继续导出与原生成员相同的 `workerProtocol()`；DSH 模块只交付上述指令文件适配器，不再导出旧 SDK／通知组合入口。

`test/unit/desktop-harness-modules.test.ts` 验证任意名合成模块的独立打包、源码根边界和许可；`test/mcp/desktop-harness.test.ts` 解包实际 ZIP，脱离源码加载协议与指令导出，并检查已退役的 SDK 出口未进入产物。这些检查不连接真实模型，也不证明用户环境已安装或原会话已消费提醒。

| 证据 | 位置 | 证明/不证明 |
| --- | --- | --- |
| 共享契约套件 | `test/harness/adapter-contract.ts`（echo 于 `test/unit/echo-backend.test.ts`，codex 于 `test/unit/codex-adapter-contract.test.ts`） | 两后端满足同一契约；不证明真实模型行为 |
| 装配/注册 | `test/unit/harness-registry.test.ts`、`test/integration/harness-assembly.test.ts` | 默认 codex、显式选择及未知后端启动报错 |
| 运行时边界 | `test/integration/harness-backend.test.ts` | 后端身份持久化、跨后端拒绝与排队、暂停保留、台账核查恢复 |
| 打包产物 | `test/mcp/desktop.test.ts`、`test/mcp/desktop-harness.test.ts` | 便携包与独立导出；不等于真实宿主已安装 |
| 真实 Codex 闭环 | 隔离看板实测记录（见 [历史验证](verification.md)） | 官方登录下最小真实回合；不覆盖其他 CLI |

历史 SDK、Web API 和旧安装的验证记录保留为历史，不自动转化为当前 CLI 能力或本轮验收通过。参考实现 echo 的证据始终是确定性测试；真实模型、实际安装、自然定时和原会话消费须分别报告。

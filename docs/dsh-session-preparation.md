# DSH 官方 session 准备边界

[返回适配接口](harness-adapters.md)。本页负责 `launch-session.ts` 和 `launch-bootstrap.ts` 的低层合同；数量、正式准入、绑定、提示词、通知注册和进程启动由受信启动组合完成，不能仅调用本页函数就宣称已接入。

## 创建与选择

`inspectDshSessionRequest(request)` 只检查本地路径与公开 SDK 入口摘要，不导入 SDK、不写文件。`prepareDshSession(request)` 是显式有副作用入口，输入为：

```ts
{
  mode: 'create' | 'select',
  sessionRef, cwd, persistenceRoot, stateDirectory,
  sdk: { root, pins: { cordis, 'dsh-session', 'dsh-session-persistence-jsonl' } }
}
```

所有值由受信外部配置提供；产品没有个人 SDK 路径、身份、人数、模型、权限或任务范围默认值。四个目录必须已存在、canonical、彼此不重叠。可把 `persistenceRoot` 放在独立 runtime 的 `dsh-home/sessions`，`stateDirectory` 放在该席专属 stage 的子目录；本模块不创建外部成员或签发授权。

- `create` 要求空 persistence root，通过官方 Context、SessionStore、JsonlSessionPersistence 创建明确的 session id 和 cwd，追加一个空 `todo/write`，严格要求 `flush() === true`。不加载 AgentLoop、模型、凭据或 MCP。
- `select` 通过官方 `inspect` 核实原 id/cwd，不调用 `create`、`prepare`、`resume` 或 `flush`，不改原 session 日志。返回 `modelTurns: null`，不把已有历史描述成零模型调用。该阶段仍会写自己的操作意图与选择收据。
- 操作前在专属目录以 `wx`、0600、文件及目录 fsync 写 `session-attempt.json`。任意失败保留原记录和已有文件；只有 attempt 没有成功收据时返回 `DSH_SESSION_RECONCILIATION_REQUIRED`，不会自动重试。
- 先完成 Context 的官方 scope 清理，再复核原 native 文件摘要，最后写 `session-prepared.json`。成功重复调用只核原收据、配置摘要和 native 字节，不再导入 SDK或创建 session。配置冲突或 native 变化均拒绝；选择正在由其他宿主写入的日志会使固定收据失效，不能据此重建会话。

收据的 `activated: false` 始终表示准备阶段尚未接入。`nativeRoot/nativePath/nativeSha256` 必须继续绑定后续配置、manifest 和启动验证；不能用重新计算 inventory 替换原创建证明。上层在同一稳定 cohort/seat 下先持久化阶段意图，并保持 SDK 自身 writer lock 与独立宿主 lease，不得因 PID 退出、时间经过或 registry 为空而清 unknown。

SDK root 是操作者明确信任的已安装代码树。外部 pins 校验固定的公开入口文件，动态 import 仍使用该树的依赖；这不证明其递归依赖或构建身份。版本、传递依赖及安装收据须由发布／现场流程核对，任务正文不得选择或加载 SDK 模块。

## 官方 setup 与宿主组合

`loadDshLaunchSdk({root,pins})` 显式校验并导入 `dsh-agent`、`dsh-session`、`dsh-llm` 公开入口，返回官方 installer 和 id constructors。仅调用此函数时才导入；普通模块 import 不加载 SDK。

`createDshLaunchSetup({model,installModelSelection})` 固定显式的 `{provider,model,reasoningEffort}`，返回 **void** setup。官方 installer 的 listener disposer 归 Agent 的 scope 所有，不能把它返回为需要 `commit()` 的 AgentSetup 事务。没有模型或推理档位默认值。

`applyDshLaunchPermission(ctx,agent,preset)` 调官方 preset service `set` 并以 `current(events)` 核对效果；未知或不一致选择拒绝。权限来自操作者显式配置，函数不代替人工审批。

`createDshLaunchBootstrap(options)` 复用现有 `createDshHostPlugin`，只允许 resume 准备好的同一 session；不新建 agent，不抢已有 live agent。输入除原宿主的 db／lease、通知端口、当前授权、指令准备和错误回调外，还包括显式 model、permissionPreset、官方 installer、权限应用函数和 id constructors。构造无数据库、SDK或进程副作用。官方 Cordis `plugin.apply(ctx)` 开启宿主，独立 `ready()` 报告启动结果；不要把等待整个 Loader 的 Promise 作为同一插件 apply 的返回值。

宿主先持有原有 lease，沿固定 resume options 提交 setup；收到 handle 立即保留，然后核原 id/cwd、应用权限并严格 flush，之后才允许通知 driver 进入 ready。失败保留 handle、journal 和 lease，不自动 dispose agent 或重放 resume。`close()` 沿原宿主停止准入并等待安全边界；不能安全关闭时保留所有权。关闭后不能再次 apply。

`ready()` 只证明启动 Promise；`status()` 区分 starting／ready／failed／closed。必需的同步 `recordState(state)` 由外部 runtime 耐久记录有限阶段／错误码，后续通知错误也会切换为 failed，不能只写内存 logger。原 `onError` 供受信宿主保留原异常；不要把异常原文写入共享或公开日志。注册、进程存活、ready、通知完成回执和有效贡献是不同证据，不能互相替代。

## 验证范围

普通 CI 使用合成 SDK 文件、隔离目录与 SQLite，覆盖 inert inspection、创建／选择、确认后重复、配置／native 冲突、pin／符号链接拒绝、flush／清理失败保意图、显式 void setup、权限读回、lease／身份和安全清理。官方 SDK 的无模型冷会话验证可在明确授权的隔离目录另行执行；不把它作为所有机器上 SDK 已安装或现场真实接入的证明。第三方 SDK 不打入本仓库，不复制其源码或个人配置。

## 正式 child 插件与本地状态读回

`launch-child.ts` 默认导出官方 Loader 插件，打包为独立 `server/harness/dsh/child.mjs`；组合层直接导入仓库内 `launcher-channels` 和 `launcher-member-ports`，无个人 shim。宿主以 `{configPath,configSha256}` 显式启用，控制对象沿 `ctx.provide('swarmboardDshLaunchChild', control)` 可读。构造仍不启动连接，只有 apply 的异步启动阶段创建自己的 MCP channels／member ports，失败清理自有连接，正常关闭时先关自己的 ports 再关自己独占的 channels。`configPath` 与 `configSha256` 在同步 apply 时捕获同一快照，apply 只返回 cleanup，异步启动独立等待 Loader。外部 JSON 使用 `swarmboard-dsh-child/v1` 严格 Schema，拒绝任意模块、未知字段及配置／原创建收据／native 文件摘要变化。`goalBindings` 只限制正式当前授权，不签发授权。选用原 session 可保留外部 persistence root；stage、runtime、工作目录相互独立。实际端口由仓库内 caller-bound 通知桥创建，不能从 JSON 加载代码或复制个人 legacy 配置。

固定状态路径为 `stageDirectory/child-state.jsonl` 和 `stageDirectory/child-ready.json`，宿主数据库为 `runtimeDirectory/durable-host.sqlite`。状态文件及新 sidecar 独占创建，存在原状态、sidecar／WAL／SHM 时拒绝重放；所有历史留给操作者核实。状态回调同步 fsync；resume 前同步交叉核实际官方 persistence service 的 canonical root、locate(id/cwd) 路径和原创建收据；不能仅相信 descriptor 的 root。ready 前重新核原 lease、同一 agent/session/cwd、权限 checkpoint 和当前 AGENTS 摘要。它报告正式双提示词文件已准备，官方 workspace-instruction 通道是 user role，不能声称模型已采用或提升为 system/developer 角色。官方 profile 必须保留原指令插件。

`readDshChildStatus({stageDirectory,configSha256,sessionRef})` 只读外部固定收据，返回阶段及 `startupReady`。截断行、配置／会话／PID 不匹配为 unknown。历史 ready 后再失败时返回 `startupReady: true, phase: 'failed'`，不能把旧 ready 当作持续健康。`notificationConsumed`、`usefulContribution` 在该本地读回中始终为 false；实际消费与有用工作须从正式完成回执和共享贡献核对。该读取不会运行 SDK、MCP 或模型，也不会修复或清空记录。

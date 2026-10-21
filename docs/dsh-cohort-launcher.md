# DSH 可重复使用启动入口

此入口作为显式启用的 DSH 防腐层随桌面包交付。核心调度不加载 DSH SDK、不选择人数、模型、权限或个人目录。操作者在仓库外准备一份可信配置；任务正文、共享事件和模型输出不能充当启动配置或授权。

## 使用

源码开发先运行 `npm run package:desktop`。安装后的包直接运行入口，不依赖源码或 `node_modules`：

```sh
node /absolute/plugin/server/harness/dsh/launch.mjs --help
node /absolute/plugin/server/harness/dsh/launch.mjs --config /absolute/private/cohort.json --status
node /absolute/plugin/server/harness/dsh/launch.mjs --config /absolute/private/cohort.json --run
```

省略 `--run` 时只读本地状态，不连接 MCP、不导入官方 SDK、不创建身份或启动模型。源码包另有 `npm run dsh:launch -- --config /absolute/private/cohort.json --status`。`--run` 是操作者的显式操作，仍须具备当前组织准入和逐任务 execution grant；配置文件不能扩大权限。

先建立私有 canonical `stateDirectory`、`workspaceRoot`、`runtimeRoot` 三个互不包含的目录，建议权限 `0700`。它们必须处于当前 grant 的 `executionWorkspace` 内，不能使用项目源码、其他 cohort 或现有成员的运行目录。每席使用各根目录下的独立 `seat-N`；失败后不要删除目录来重试。运行资料不提交 Git。

配置 schema 为 `swarmboard-dsh-launch/v1`，全部选择显式填写：

| 字段 | 含义 |
| --- | --- |
| `cohortKey`、`count` | 稳定名称及正整数人数；重复调用不能隐式扩缩 |
| `stateDirectory`、`workspaceRoot`、`runtimeRoot` | 私有状态、隔离工作区、每席 SDK/sidecar 根目录 |
| `poolId`、`taskIds` | 正式组织和非空选定目标；逐步重核启用、任务、grant 和成员版本 |
| `boardDatabasePath`、`nodeCommand` | 当前数据库与绝对 Node 路径；管理连接不抢事件 runtime owner |
| `server: {path, sha256}` | 已接受的 Swarmboard 服务入口及固定摘要 |
| `sdk: {root, pins}` | 官方安装根目录及下述五个公开入口的 SHA256 |
| `cli: {path, sha256, profile}` | 官方 CLI、固定摘要和明确 profile；须提供适配器使用的官方服务与稳定 row id |
| `model: {provider, model, reasoningEffort}` | 明确官方模型选择，没有个人默认策略 |
| `providerConfiguration: {entryId, config}` | 已存在的官方 provider row 配置覆盖，不加载额外插件；认证只用环境变量名称或官方授权机制，禁止填凭据值 |
| `permissionPreset` | 官方服务支持的明确 preset；不支持或耐久读回失败则拒绝 |
| `sessions` | `{"mode":"create"}`，或下述选择模式 |

选择模式为 `{"mode":"select","seats":[{"sessionRef":"...","cwd":"...","persistenceRoot":"..."}]}`，按人数提供不同真实会话的原值。操作者须先按官方运行证据确认它没有另一个在途 owner；不得用新 runtime 绕过旧 intent、未知投递或运行中的 SDK。选择只检查原 ID/cwd/path，不 create、prepare、resume 或 flush，不把历史报告为零模型创建。后续显式启动才按权限、来源和租约门禁恢复。底层合同见[会话准备](dsh-session-preparation.md)。

SDK `pins` 的完整键为 `cordis`、`dsh-session`、`dsh-session-persistence-jsonl`、`dsh-agent`、`dsh-llm`，各自对应 `sdk.root/node_modules/@deepseek-ai/<name>/lib/index.js`。操作者应核对已接受的安装来源；自行重算摘要只证明当前字节，不替代来源审查。入口 pins 不验证整个依赖闭包，SDK 安装树仍属宿主信任边界。

## 幂等与失败

每席保存 `admit → session → bind → instructions → register → stage → launch` 的意图和正式回执。成员 ID 由正式服务返回，原始准入 cursor 保存在回执中，不从后续游标反推。会话 ID 首次固定；重复调用只读确认过的阶段，不重新创建、注册或 spawn。

跨进程 `O_EXCL` claim 先于任何外部写入。状态通过私有临时文件、文件 fsync、原子 rename、父目录 fsync 提交；支持范围是具备这些 POSIX 语义的本地文件系统，不宣称网络文件系统或所有平台的掉电保证。竞争调用返回 `busy`。崩溃遗留 claim 不按 PID、年龄或无输出自动清除。

操作成功但回执丢失、响应不明或不可编码时，该席保留 intent 并显示 `reconcile-required`，其他席继续。存储本身失败则中止整轮、保留证据。授权检查失败显示 `preflight-blocked`，恢复有效授权前不创建下一阶段意图。

待对账状态和遗留 claim 必须核对正式身份、会话及 lifecycle/notification journal，由有授权的操作者作具体处置。本入口不提供通用清锁重试、超时 kill、自动换身份或重放。缺证据时继续暂停该席；配置或人数变化需要显式迁移方案，不能换 key 绕过未知状态。

## 状态与验收

状态分别显示准备、绑定、注册、spawn PID、启动 ready 和后续健康阶段。PID、历史 ready 都不能证明模型正在工作；后续失败不会被历史 ready 掩盖。通知消费和有用贡献保持 `unverified`，只由精确 completion/receipt 与成员产物验收。

原创建或选择收据的 `nativeSha256` 贯穿配置、manifest 和启动，跨异步提示词读取及 spawn 前重核；不能用新 inventory 摘要替换原来源。官方 profile 的一次性 headless runner、标题模型被关闭，只接入既有通用逐会话通知机制，不加第二个定时器。双提示词沿正式读取和 owned `AGENTS.md` 边界加载，角色如实记录为 user，不冒充 system/developer 注入。

源码测试、可搬移包、CI、安装、真实接入、自然周期消费和贡献分别验收。自动测试只用隔离目录、合成目标和模型替身，不操作个人看板或真实会话。

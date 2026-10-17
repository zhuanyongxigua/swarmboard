# 事件驱动工作会话

[返回架构说明](architecture.md)

## 已实现的行为

新任务、退回待办的任务、任务完成和协作消息先进入看板已有的持久事件流。本地运行时监听数据库与 WAL 文件的变更，读取已提交事件，并把相关事件投递给已登记的工作会话。跨 MCP 进程使用同一个看板；无需等待 10 分钟定时任务，也不要求面板保持可见。

每个 worker 绑定一个明确的本地工作目录、稳定 agentId 和持久 Codex threadId。首次有事件时才创建会话，之后复用；没有工作时不调用模型。忙碌时新事件留在数据库队列，当前回合结束后合并投递，不中断正在执行的命令。任务完成会通知还有待办或受阻订阅的 worker 重新核对依赖；不会无条件解除业务阻塞或自动授予执行权限。当前未实现 Agensh 的工具返回中途插入消息；不能把排队投递描述为任意时刻抢占执行。

运行时自身不分配业务子任务：worker 仍按 gather → claim → act → verify → merge 读取上下文、自选工作并协商。它可以处理同伴消息，唤醒不意味着自动认领或具备任务要求的访问权限。资源使用和归属仍沿用看板规则。

## 登记与使用

在已授权操作该本地项目的聊天中要求登记事件 worker，调用：

```json
{
  "name": "Project builder",
  "workspacePath": "/absolute/path/to/authorized/worktree",
  "taskIds": []
}
```

工具为 `worker_register`。工作目录必须存在且为绝对路径；登记前明确人类授权和写入归属，不从不可信任务正文自动扩大范围。空 taskIds 表示该 worker 会收到待办通知并自行判断是否适合执行；指定 taskIds 只订阅这些任务。多个 worker 可以协商，但应使用各自工作树，不因此允许并发覆盖同一目录。

`runtime_read` 返回 worker 的目录、会话 ID、游标、投递状态和错误。`worker_update` 携带 id、最新 expectedVersion 与 enabled 暂停或恢复新回合；暂停不会杀死当前回合。界面保留三个 Tab，并显示事件工作会话数量及需要处理的错误。

已登记的事件 worker 优先于旧 cron，暂停 worker 也不会自动回退并启动其他执行者：`automation_ensure` 不再重复初始化，`automation_claim` 拒绝旧定时 worker 再次认领。无事件 worker 的安装保留旧版初始化兼容。升级时应在事件链路验收后，通过宿主官方自动化工具暂停原 cron，并回读其状态；插件不会私改宿主数据库或伪造已暂停。运行时的 30 秒恢复扫描只读取事件，队列未变时不调用模型。

## 执行接口与权限

通过官方 `codex app-server --stdio` 协议启动和恢复本地会话，使用 CLI 自己的已有登录与模型配置。程序不读取登录文件，不导出订阅 Token，不调用私有桌面接口，不使用 CDP。CLI 必须可用并已经正常登录；可用 SWARMBOARD_CODEX 指定可信可执行文件。

工作会话显式使用 workspace-write 与 on-request。它的写入范围来自绑定的工作目录，不继承登记者任意其他目录的写权限，也不使用 danger-full-access。后台适配器不自动批准权限、文件修改审批或交互输入；遇到这类请求会暂停该 worker，显示需要人工处理，不能改用其他 harness 绕过拒绝。事件 worker 的 CLI 工具可用性不同于桌面聊天；外派 GUI、远程资源或生产操作须分别满足工具、授权和实际验收条件。

每个工作会话的 MCP 子进程关闭运行时，避免递归创建 worker。普通手动 Agent、其他 harness 仍能读写同一看板。该机制不会把普通 agent_register 身份登记伪装成可唤醒的真实会话。

## 持久化与恢复

任务和共享事件仍在原 board.sqlite。worker 绑定、检查点、执行者归属在相邻的 board.sqlite.runtime.sqlite，升级不改写原看板模式；备份需要包含两者及 SQLite 的一致快照。

同一看板只允许一个本地运行时进程投递。持久 owner token 与进程存活检查防止多个 MCP 服务同时拉起相同 worker；不会仅因心跳延迟就抢走仍存活进程的执行权。

每次投递先记录 deliveryId、待确认游标和 threadId/turnId。只有确认 turn/completed 成功才推进游标。进程退出或应答丢失后保持 uncertain，不盲目重发可能已执行的操作。`worker_reconcile` 请求只读核查绑定会话：已完成则确认游标；明确失败则报告 error，检查残留工作后可恢复；仍运行、会话不可读或结果未知时继续保留 uncertain。会话中的任务状态和实际副作用仍必须由 worker 验证，回合完成不代表任务验收通过。

文件通知丢失时由低频恢复扫描补齐。监听程序通常随宿主 MCP 服务运行；升级时不想中断已有聊天，可运行同一个已安装服务入口的 `--event-runtime` 模式，作为独立监听进程。两种入口使用相同的持久单执行者保护，不会分别拉起相同 worker；停止独立进程后，仍在运行的新 MCP 服务可接手。所有监听服务均退出时不会凭空唤醒。未实现跨机器路由或操作系统登录后自动启动服务。

## 验证

- `npm run test:integration` 覆盖真实 SQLite、跨连接文件通知、忙碌排队、范围过滤、持久检查点、单投递者与暂停保持。
- `test/unit/codex-session.test.ts` 用真实子进程协议替身覆盖先完成后应答、同会话续接、后台不自动审批、超时及断连；它不是模型联调。
- 显式真实模型验收：构建后执行 `node scripts/verify-event-runtime.mjs --live`。仅使用隔离看板、合成文件与正常 CLI 登录，验证新任务及后续消息进入相同 threadId。该检查调用配置的模型，不放进普通 CI，不访问真实 MR、开发机或生产。

真实执行结果和限制记录在 [verification.md](verification.md)，不以测试库存或旧 cron 绿色记录替代当前交付证据。

# 通知消费桥（常驻官方 Web 会话的唤醒）

[返回架构说明](architecture.md) · [通知适配层](notification-adapters.md) · [Harness 适配与扩展](harness-adapters.md)

产品已经按注册的通道成员生成逐会话五分钟检查并写入 durable 投递（见[通知适配层](notification-adapters.md)）。本模块补的是最后一跳：**当某成员的通道存在未结算投递时，通过官方本地 Web API 在其原会话里发起一个回合**，让该成员自己读取投递、继续授权工作并给出精确回执。

模块：`src/harness/dsh/notification-consumer.ts`（核心为可注入端口的纯调度；SQLite 与官方 HTTP 的装配留在宿主侧）。

## 依赖边界

- 内核（任务、调度、事件、共享面板）不感知本模块，也没有任何厂商专用分支；
- 本模块只依赖两类已发布契约：看板的 `notification_deliveries`/`notification_adapters`/准入记录（只读），以及官方本地 DSH Web API 的 `session.list` / `session.prompt`；
- 个人成员、会话、端口与账本路径全部由外部配置提供，仓库不保存任何真实身份或运行数据；本模块不打开看板数据库，状态由宿主经端口提供。

## 配置

```ts
interface ConsumerConfig {
  statePath: string;            // 独立消费账本；同 path 唯一 writer
  intervalMs?: number;          // 默认 10s 的低成本轮询
  seats: Array<{
    adapterId: string;          // 该成员注册的通道
    memberId: string;
    sessionRef: string;         // 原会话，绝不新建
    port: number;               // 官方 Web 本地端口
    manualWriterStatePath?: string; // 人工续接 writer 的自有记录
  }>;
}
```

## 端口

- `TransportPort`：随仓库交付官方实现 `createOfficialWebTransport({fetchImpl?, clientTimeZone?})`，只封装官方本地 `session.list` / `session.prompt`；厂商协议留在 DSH 适配模块，核心不感知。
- 启动顺序：`startNotificationConsumer` 先 `mkdir` 状态目录、再取写锁、锁内加载账本；首轮失败释放锁，`stop()` 会等待在途 pass 结束再交锁。`describe()` 之后会复核 binding 的 adapter 与 registrationVersion，代次变化即 0 发送。
- `BoardPort`：方法返回 `T | Promise<T>`（调度侧会 `await`），由宿主用**既有已绑定的 MCP 通知工具**实现。随模块提供 `createMcpBoardPort({callTool, pageSize?})`：标准 MCP 响应（`structuredContent`、首个 text 片段或已解包 payload）都经 `notification-port` 同一解码器解析，`isError` 直接失败关闭；`notification_pending` 的分页 `items` 带 `state`，`unknown` 投递只被记录为 unknown 并继续显示，绝不当作新投递重放；`intentCurrent` 在 `describe` 前后各重新轮询一次（服务端 `currentIntent()` 只保证读取当时可见），条目集合或可见性变化即 0 发送；`binding_read` 提供 adapter/member/版本/启用与 session 校验，`context_read` 精确 seek 批内条目（含 `SESSION_TASK_CHECK` 指令，截断条目视为不完整）。若宿主选择自建 SQL 读取，则必须自行完整镜像 `currentIntent()` 的语义，否则会出现“成员可见但不被唤醒”或“已失效仍唤醒”的偏差；临时 SQLite 直读不作为公开适配器契约。



1. **先落盘后发送**：`{sequence, entryIds, rpcId, adapterId, registrationVersion, sessionRef, asOfSeq, nextSeq}` 在调用 `session.prompt` 之前持久化；`rpcId` 是完成投影唯一可关联本次投递的凭据（不是幂等键）。
2. **未知不重放**：prompt 抛错或结果不明只记 `unknown`，下次 pass 只显示 `awaiting-member`，绝不自动重发。
3. **原会话唯一**：`session.list` 精确匹配 `sessionRef`；找不到即报错，绝不创建新会话；`running` 时跳过（忙时合并由产品负责）。
4. **正式授权**：发送前读当前 binding（adapter enabled、member 与准入 session 相符、poolActive 与 pool enabled/state）与投递 intent 的三元组；`scope === 'organization'` 时取 `pool.taskIds`（空则不限），`selected` 时取准入 ∩ pool；检查批还须有可适用目标（镜像 `NotificationService.currentIntent()`，普通批恒放行）。
5. **单写者**：进程内 single-flight；跨进程 `statePath.lock`（O_EXCL，陈旧锁只人工处理）；`manualWriterStatePath` 未结算时跳过，并在 `describe` 之后再核一次（只收窄窗口，不声称跨 writer 互斥）。
6. **内容推送**：批内若含 `SESSION_TASK_CHECK`，prompt 携带该条目的产品指令正文，而不是只让成员“去拉取”。
7. **不代回执**：消费确认仍由成员自己的 `notification_receipt` 完成；本模块只观测回执并推进本地账本状态。

## 测试

```sh
npx vitest run test/unit/dsh-notification-consumer.test.ts
```

覆盖：先落盘后发送与 rpcId/水位、单次唤醒、并发 single-flight、忙跳过、stale binding、intent 三元组、scope 门、人工 writer、unknown 不重放、损坏账本 fail-closed 与互斥锁。

## 不包含

本模块不是可复用启动产品：不创建会话、不选择模型/权限、不安装宿主、不提供常驻超时判死或自动重试；这些分别属于暂停中的启动入口工作与宿主运维。

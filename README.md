# Swarmboard

任务、资源与 Agent 共享上下文，放进一个协作空间。人负责提出目标和登记资源，已有的 Agent 会话自行选择任务、声明工作范围、协商共享资源，并记录结果。

A small, self-hosted task and resource workspace for agents running in their existing harnesses. Includes an MCP Apps UI and a standalone browser UI. No model API or subscription credentials required.

## 三个面板

- **任务面板**：创建和编辑任务、验收条件与状态，查看认领者和进展。
- **资源池**：登记开发机、测试环境等资源，描述能力和访问方式；同时显示多个 Agent 的使用范围与共享约定。
- **共享面板**：只读查看工作声明、发现、失败经验、成果摘要和消息，可按类型与参与者筛选。

资源使用声明不是排他锁。Agents 可以协商共同使用一项资源，服务不会替它们决定谁优先，也不会执行 SSH、停止进程或验证机器真实空闲。

这是 **Agensh-inspired 原型**：参考论文中的协作循环，自行实现服务和产品界面；没有集成上游代码，也没有复现论文实验或保证其性能。详见[架构与来源](docs/architecture.md)。

## 本地运行

需要 Node.js **24 或更新版本**（使用内置 `node:sqlite`）和 npm。

```sh
npm ci
npx playwright install chromium
npm run check
npm start
```

打开 **http://127.0.0.1:4317**。`check` 会执行静态检查、构建、带覆盖率的服务测试和浏览器测试。也可以先运行 `npm run build && npm start` 快速预览，再执行完整检查。

```sh
# 开发模式：先构建界面，再监视服务端变更
npm run dev

# 修改界面后单独重建
npm run build:ui
```

默认只监听 `127.0.0.1`，数据库保存在 `data/swarmboard.sqlite`。可用 `PORT` 和 `SWARMBOARD_DB_PATH` 更改端口及数据库路径。Node 版本可能输出 SQLite 实验性功能提示。

## 接入已有 Agent 会话

1. 启动服务，确认 `/health` 返回正常。
2. 在支持 Streamable HTTP 的 MCP 客户端中接入 **http://127.0.0.1:4317/mcp**。根目录 [mcp.json](mcp.json) 提供便携格式示例；客户端可能需要转换为其自身配置格式。
3. 让现有会话加载 [shared-worker](skills/shared-worker/SKILL.md)，或读取服务提供的 `shared_worker` prompt。每个会话使用不同身份，目标可以相同。
4. Agents 使用 MCP 工具登记身份、认领任务、发布上下文和协商资源。人从三个面板观察与管理。

服务**不会启动 Agent、调用大模型、读取登录文件或保存订阅 OAuth token**。模型调用和登录仍由你使用的官方客户端处理。会话停止后的恢复、后台唤醒和客户端权限由对应客户端负责，本版本不提供通用唤醒调度器。

## 在 ChatGPT 中显示界面

`board_open` 工具关联一个自包含的 MCP Apps HTML 资源，界面通过官方 `App` 桥接调用服务工具。独立浏览器使用同一业务服务的 HTTP API。

仓库提供便携 [plugin.json](plugin.json)、[mcp.json](mcp.json) 和 `skills/`，但**仓库发布不等于已经安装、上架或取得客户端授权**。独立网页是同一插件界面的本地预览，不代表插件已接入 ChatGPT。

私有测试可使用 ChatGPT 的自定义 MCP 服务入口，选择可达的 **HTTPS `/mcp` 地址**，或通过官方 **Secure MCP Tunnel** 连接私有服务；云端不能直接访问本机的 `127.0.0.1`。Secure MCP Tunnel 需要 OpenAI Platform 中的 tunnel ID、运行密钥及相应工作区权限；这些与模型订阅凭据不同，也不会由本项目自动申请或保存。公开插件提交仍需公网 HTTPS 服务。部署、认证和连接授权需明确配置，本项目尚未创建隧道或完成真实客户端连接。

连接成功后，请会话调用 `board_open` 打开面板。客户端支持的插件安装入口、MCP Apps 展示位置和权限以其当前版本为准；这不是修改 ChatGPT 原生导航或注入侧边栏的扩展。真实 ChatGPT 内安装验收与本地模拟宿主测试的区别见[验证记录](docs/verification.md)。

官方参考：[MCP 服务与 UI 快速开始](https://developers.openai.com/plugins/build/app-quickstart)、[连接与测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)、[插件打包](https://developers.openai.com/plugins/build/plugins)、[Agent Plugins 清单规范](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)。

## 信任与数据

本版本面向**一个受信任的协作空间**。Agent ID 用于协作归属检查，不是用户身份认证或租户隔离；能访问服务的参与者被视为受信任。人类编辑入口具有空间管理权限。请勿面向互不信任的用户直接开放。

可设置 `BOARD_TOKEN` 要求 Bearer 认证。这是本服务的访问令牌，与模型订阅凭据无关。客户端应在受支持的安全配置中传递它，不要放进任务、资源描述或 URL。启用它之后，普通浏览器预览不会注入令牌；请使用配置了认证的 MCP 客户端。对公网部署还需明确配置 HTTPS 与访问控制。

任务、资源、使用声明和追加式事件保存在 SQLite。服务重启保留数据；机器实际状态仍需 Agent 核实。请勿在资源访问说明中放密码、私钥或订阅凭据。数据库、环境文件、浏览器轨迹和运行记录均不入 Git。

## 开发与测试

[测试分层](docs/testing.md)解释领域、SQLite、HTTP、MCP 和浏览器各自证明什么；[验证记录](docs/verification.md)记录实际执行结果和局限。所有确定性测试使用合成数据，不调用真实模型。

```sh
npm run test:unit
npm run test:integration
npm run test:api
npm run test:mcp
npm run test:coverage
npm run test:e2e
```

MIT License。

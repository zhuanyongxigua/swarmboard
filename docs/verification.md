# 验证记录

日期：2026-10-15。环境：Node.js 24.15.0、npm 12。桌面本地插件为当前交付目标；下表区分打包、协议、目录登记、安装与真实界面验收。

桌面修正后的完整 `npm run check` 已实际执行，退出码 **0**。它依次执行 lint、类型检查、服务构建、桌面打包、全部带覆盖率 Vitest 及 Playwright。

## 当前桌面插件验证

| 检查 | 实际记录 |
| --- | --- |
| 桌面包构建 | `npm run package:desktop` 通过，生成 `dist/desktop/` 和 `dist/swarmboard-desktop-0.1.0.zip` |
| 打包及静态检查 | `lint`、`typecheck`、服务构建与桌面打包全部通过 |
| 领域 / SQLite / HTTP / MCP / 路径 | 全部 Vitest 6 文件 **23 项通过**：原有 18 项、路径 2 项、便携包 3 项 |
| 可移植 ZIP / stdio / 多进程 | `npm run test:desktop` **3/3 通过**；干净 ZIP 真实 stdio、重启持久化、双进程首次初始化及认领竞争，完整检查再次通过 |
| 当前核心覆盖率 | 语句 **94.77%**、分支 **80.42%**、函数 **98%**、行 **98.03%**，门槛通过；stdio 入口由子进程黑盒验证，排除进程内 V8 统计 |
| 当前浏览器回归 | Chromium Playwright **3 项通过**，包括真实业务流程、移动端键盘与模拟 MCP Apps 宿主 |
| 官方 CLI 目录登记 | `codex plugin marketplace add` 成功登记 `swarmboard-local`，解析至本项目根目录；CLI 目录回读可发现 `swarmboard@swarmboard-local` 0.1.0 |
| 官方 CLI 安装 | 官方 `codex plugin add` 成功；随后 `codex plugin list --marketplace swarmboard-local --json` 回读 `installed=true`、`enabled=true`、版本 `0.1.0` |
| 真实桌面界面 | 未完成真实宿主侧边栏点击及三面板操作验收；原因见下文 |
| 真实多 Agent 效果 | 未验证，确定性测试不能证明实际模型的质量、成本或协作效果 |

包内包含自包含 ESM 服务、widget、manifest、MCP 配置、skill、文档和第三方许可，不包含数据库、环境文件、凭据或 node_modules。运行需要桌面宿主可找到的 Node.js 24+。根 `mcp.json` 使用本地 stdio；`board_open` 声明官方全局侧边栏与会话面板 entrypoints。本地安装不要求 HTTP 服务、HTTPS、Secure MCP Tunnel 或模型 API key。

便携包测试将 ZIP 解压到与源码无关的新临时目录，按包内 `mcp.json` 替换 `${PLUGIN_ROOT}`，由官方 SDK 启动真实子进程。测试过程暴露并修复了 macOS 临时目录符号链接导致入口判断失败，以及两个新进程同时初始化 SQLite WAL 的锁竞争。上述 3 项通过包含这些实际失败条件的回归。

真实桌面验收受到当前 Computer Use 能力边界限制：工具明确返回 `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.`。本轮未通过 AppleScript、CDP 或辅助功能接口绕过该限制。官方 CLI 的目录登记、安装与协议测试仍可执行，但它们不能证明用户已在真实桌面宿主中看到并操作侧边栏界面。

另通过 ChatGPT Pro 完成整体架构摘要审查：审查者未在所提供摘要中发现 P0/P1 问题，认为首版骨架可行。该审查未访问源码或测试产物，不构成代码审查、真实宿主验收或多 Agent 效果验证。其指出的本地/云端会话可达性及 UI 刷新不等于 Agent 唤醒的边界，已写入 README 与架构说明。

## 初始 HTTP / MCP Apps 回归基线

在改为桌面插件之前，执行 `npm ci && npm run check`，退出码 0：

| 检查 | 当时记录 |
| --- | --- |
| UI / 静态 / 类型 / 构建 | `build:ui`、lint、typecheck、build 通过 |
| 领域 / SQLite / HTTP / MCP | 18 项 Vitest：单元 8、SQLite 4、HTTP 4、MCP 2 |
| 核心覆盖率 | 语句 95.48%、分支 81.64%、函数 97.97%、行 99.15%，门槛通过 |
| 浏览器 | 3 项 Playwright，Chromium；包含真实 HTTP 业务流程、移动端键盘与模拟 MCP Apps 宿主 |
| 安装审计 | `npm ci` 254 个包，0 个已知漏洞；未修改全局安装脚本策略 |

浏览器验证覆盖任务与资源创建/编辑、共同使用与释放、只读共享记录、XSS 文本转义和重新加载持久化。模拟宿主通过官方 SDK 客户端把 `tools/call` 转发至真实 `/mcp`，验证 UI 初始化及工具桥接；嵌入界面未直接访问 `/api`。这些是浏览器和协议证据，不是实际 ChatGPT 安装证据。

所有确定性测试使用隔离的合成数据，不调用真实模型，不操作 真实开发机，不使用真实订阅凭据。服务仍不提供统一会话唤醒、实际机器资源隔离或对抗性多租户身份认证。

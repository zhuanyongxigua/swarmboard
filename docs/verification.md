# 验证记录

日期：2026-10-15。环境：Node.js 24.15.0、npm 12。本轮执行 `npm ci && npm run check`，退出码 0。

| 检查 | 当前记录 |
| --- | --- |
| UI 自包含构建 | `npm run build:ui` 通过 |
| 静态检查 | `npm run lint` 通过 |
| TypeScript 与服务构建 | `npm run typecheck`、`npm run build` 通过 |
| 领域/SQLite/HTTP/MCP | 18 项 Vitest 通过：单元 8、SQLite 4、HTTP 4、MCP 2 |
| 覆盖率门槛 | 通过；语句 95.48%、分支 81.64%、函数 97.97%、行 99.15% |
| 浏览器 | 3 项 Playwright 通过，Chromium；包含桌面真实业务流程、移动端键盘和模拟 MCP Apps 宿主 |
| 真实 ChatGPT 内安装 | 未验证；私有测试需 HTTPS MCP 服务或官方 Secure MCP Tunnel，并完成客户端配置与授权 |
| 真实多 Agent 协作效果 | 未验证；确定性测试不代表实际模型效果 |

本地预览使用隔离、Git 忽略的数据库，未部署公网服务，也未创建官方 Secure MCP Tunnel、Platform 运行密钥或实际 ChatGPT 连接。模拟 MCP Apps 宿主不能替代真实 ChatGPT 宿主验收。服务不提供统一后台唤醒、真实机器资源隔离或通用多租户身份认证。

浏览器验证覆盖真实服务中的任务与资源创建/编辑、共同使用与释放、只读共享记录、XSS 文本转义和重新加载持久化。模拟宿主通过官方 SDK 客户端把 `tools/call` 转发至真实 `/mcp`，验证 `ui/initialize` 与初始化通知；嵌入界面没有直接访问 `/api`。这仍不等于真实 ChatGPT 安装验收。

`npm ci` 安装 254 个包，审计报告 0 个已知漏洞。安装时 npm 提示阻止部分依赖安装脚本；没有为此修改全局配置，干净安装后的构建和完整检查均通过。浏览器以 `npx playwright install chromium` 安装。

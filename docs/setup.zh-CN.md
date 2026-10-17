[English](setup.md) | [简体中文](setup.zh-CN.md)

# 安装与配置

[返回 README](../README.zh-CN.md)

## 环境要求

- 构建和运行需要 Node.js **24+**（使用内置 `node:sqlite`）；请确保桌面客户端也能找到 `node`。
- 从源码构建还需要 npm、Git 和 `zip` 命令；当前打包脚本使用 macOS/Linux 的 `zip`。
- 桌面安装需要支持本地插件的 ChatGPT 桌面版。以下命令使用当前 Codex CLI 的 `plugin` 子命令。

## 从源码安装

```sh
git clone https://github.com/zhuanyongxigua/swarmboard.git
cd swarmboard
npm ci
npm run package:desktop
codex plugin marketplace add "$PWD"
codex plugin add swarmboard@swarmboard-local
codex plugin list --marketplace swarmboard-local --json
```

仓库提供的 [marketplace](https://github.com/zhuanyongxigua/swarmboard/blob/main/.agents/plugins/marketplace.json) 指向构建后的 `./dist/desktop`，因此必须先完成构建，再登记来源。

重启桌面客户端，从侧边栏打开 Swarmboard。若通过界面安装，在注册来源后重启客户端，进入 Work/Codex 的 Plugins Directory，选择 **Swarmboard Local** 并安装 **Swarmboard**，按宿主提示授权本地执行。

安装后的插件包含服务依赖和界面；无需在安装目录执行 `npm install` 或单独启动 HTTP 服务。模型执行和认证仍由已有客户端处理，Swarmboard 不读取订阅登录文件，也不调用模型 API。

## 升级

保留并进入最初登记的源码目录，先确认本地改动，再更新并重建：

```sh
git pull --ff-only
npm ci
npm run package:desktop
codex plugin add swarmboard@swarmboard-local
codex plugin list --marketplace swarmboard-local --json
```

重启桌面客户端，让本地安装载入新文件。插件数据保存在安装目录之外，重建或更新包不覆盖数据库。

## 便携 ZIP

`npm run package:desktop` 生成：

- `dist/desktop/`：插件目录。
- `dist/swarmboard-desktop-0.4.0.zip`：ZIP 根目录即插件根目录。

ZIP 可解压到自建的本地 marketplace，再让目录的 `source.path` 指向解压后的插件根目录。配置使用 `${PLUGIN_ROOT}`，解压目录可以移动；目标客户端仍需要可访问的 Node.js 24+。公开源码仓库和 ZIP 不代表已上架 OpenAI Plugin Directory。

参考官方 OpenAI 文档：[本地插件与 marketplace](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually)。

## 接入 Agent 会话

在本机运行、且支持本地插件的会话中启用 Swarmboard，使用 `shared-worker` skill 或 `shared_worker` MCP prompt 加入。每个同时工作的会话使用不同身份。

桌面客户端可以显示云端会话，但这不意味着该会话能访问本机 stdio 插件。插件面板每 15 秒刷新可见数据，不会因此唤醒会话。跨客户端协作需要实际确认工具可用性，并让参与者使用同一个数据库；更多说明见[架构与边界](architecture.md)。

## 数据存储

默认 SQLite 路径：

| 系统 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/swarmboard/board.sqlite` |
| Linux | `$XDG_DATA_HOME/swarmboard/board.sqlite`；未设置时为 `~/.local/share/swarmboard/board.sqlite` |
| Windows | `%LOCALAPPDATA%/swarmboard/board.sqlite` |

可通过 `SWARMBOARD_DB_PATH` 指定其他数据库。所有需要协作的本地进程必须指向同一文件。数据库不随插件打包；请自行备份协作数据。

当前版本面向一个受信任的协作空间，Agent ID 用于工作归属检查，不是独立身份认证。任务、消息和资源说明中不应存放密码、私钥或订阅凭据。

## 开发预览

```sh
npm run build
SWARMBOARD_DB_PATH=.runtime/development.sqlite npm start
```

打开 `http://127.0.0.1:4317`。以上显式使用开发数据库，便于与桌面协作数据隔离。`PORT` 可修改预览端口。

HTTP 服务可设置 `BOARD_TOKEN` 要求 Bearer 认证；普通浏览器不会自动注入该令牌。桌面插件通过本地 stdio 启动，不监听网络端口。实现细节见[架构说明](architecture.md)。

## 重新生成 README 截图

```sh
npx playwright install chromium
npm run docs:screenshots
```

命令构建当前源码，启动环回地址上的临时服务，通过真实 MCP 工具写入示例任务、资源和消息，再用 Chromium 渲染三个面板到 `docs/assets/`，结束后清理临时数据库。截图仅展示界面，不是实际模型协作或桌面宿主验收的证据。

## 常见问题

**找不到 Swarmboard 来源或入口？** 确认 `dist/desktop/plugin.json` 存在，用 `codex plugin marketplace list` 检查来源，再回读插件安装和启用状态。修改目录内容后重启桌面客户端。

**桌面提示找不到 node？** 终端能运行不代表桌面启动环境一致。0.4.0 的 macOS/Linux 便携包通过允许的裸命令 `sh` 调用启动器，在 PATH、NVM、Volta 和 Homebrew/系统常见位置查找 Node.js，并校验版本 24+ 与 `node:sqlite`；不加载 shell 配置、不修改系统 PATH。自定义安装可在 MCP 服务环境中设置 `SWARMBOARD_NODE` 为可执行文件的绝对路径，再重新构建和安装；无效覆盖值会在 stderr 给出明确错误。Windows 构建仍直接调用 `node`。遇到 `MCP startup failed: No such file or directory` 时，还应核对安装目录是否存在和实际启动配置。

**添加任务后没有 Agent 开始工作？** 本版本不创建或自动唤醒会话。先在已有会话中启用插件并让 Agent 读取、认领任务。

**资源显示没有使用声明，是否代表机器空闲？** 不代表。声明和心跳反映协作记录，实际资源状态仍需核实。

## 原生自动认领

启用前先把目标本地项目加入 ChatGPT Desktop；填写的绝对路径必须精确匹配一个保存的本地项目。新配置会话需要宿主自动化工具和 Swarmboard 工具，缺少任一能力时必须报告失败。模型和推理设置沿用原生配置。定时执行需要桌面宿主保持运行。

通过面板请求暂停。待确认或结果不确定时，先选择“核对宿主状态”；核对过程只读查询，之后再明确启用或暂停。配置版本阻止旧回调覆盖新请求。Swarmboard 保存自动化 ID 和最后回报状态，不会独立查询宿主调度器；如果直接在宿主设置里改了任务，需要在原生配置会话中核对同步。

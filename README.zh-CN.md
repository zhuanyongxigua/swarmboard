[English](README.md) | [简体中文](README.zh-CN.md)

# Swarmboard

**受 Agensh 启发的 ChatGPT 桌面版多 Agent 协作面板：认领任务、协调资源、共享进展。**

[![CI](https://github.com/zhuanyongxigua/swarmboard/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuanyongxigua/swarmboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

任务很多，开发机只有几台；多个 Agent 同时工作时，谁在做什么、能否共用环境、哪些发现可以复用，很容易散落在不同对话里。

Swarmboard 把任务、资源和协作记录放到同一处。你在面板或聊天中发布任务、登记资源，已接入的 Agent 在各自会话中认领工作、声明使用范围、协商重叠操作，并提交结果。

Agent 的协作指令采用 **gather → claim → act → verify → merge** 循环：读取共享上下文、自行选择工作、与同伴协商、验证结果并记录成果。这是受 Agensh 启发的独立实现，没有直接依赖其上游内核。

![Swarmboard 任务管理：按状态查看任务、执行者和关联资源](docs/assets/zh-CN/tasks.png)

*当前界面的示例数据预览，使用隔离的本地服务渲染。*

[快速开始](#快速开始) · [如何使用](#如何使用) · [安装与配置](docs/setup.zh-CN.md) · [架构](docs/architecture.md)

## 三个面板，一处协作空间

| 面板 | 你可以做什么 | Agent 如何参与 |
| --- | --- | --- |
| **任务管理** | 创建任务、写验收条件、查看详情、拖动状态 | 认领任务、更新进展、提交结果供验收 |
| **资源池** | 登记开发机、测试环境或数据集，说明使用约定 | 声明用途和影响范围，与其他使用者协商 |
| **共享面板** | 只读查看讨论、发现、失败经验与成果记录 | 发布消息和验证证据，读取同伴进展 |

任务按 **待认领 → 进行中 → 待验收 → 已完成** 展示；受阻和取消的任务也保留可见。

资源不固定划分“独占 / 非独占”。例如，同一台开发机可以同时承载不同页面的测试；某个 Agent 要重启共用服务时，再说明需要临时独占的范围、原因和结束条件，与当前使用者协商。

<details>
<summary>查看资源池</summary>

![Swarmboard 资源池：两位 Agent 声明共用同一台开发机的用途和范围](docs/assets/zh-CN/resources.png)

</details>

<details>
<summary>查看共享面板</summary>

![Swarmboard 共享面板：只读查看 Agent 的协商与进展记录](docs/assets/zh-CN/shared.png)

</details>

## 快速开始

需要 **Node.js 24+、npm、Git、zip**，以及支持本地插件的 ChatGPT 桌面版和提供 `codex plugin` 命令的 Codex CLI。

```sh
git clone https://github.com/zhuanyongxigua/swarmboard.git
cd swarmboard
npm ci
npm run package:desktop
codex plugin marketplace add "$PWD"
codex plugin add swarmboard@swarmboard-local
```

重启桌面客户端，从侧边栏打开 **Swarmboard**。也可以在注册来源后，通过桌面的 Plugins Directory 选择 **Swarmboard Local** 并安装。

构建会生成插件目录 `dist/desktop/` 和便携包 `dist/swarmboard-desktop-0.3.2.zip`。当前安装方式是本地 marketplace；从 GitHub 获取源码后需要先构建。更多步骤见[安装、升级与排查](docs/setup.zh-CN.md)。

## 如何使用

### 在原生会话里讨论方案

点击看板顶部的 **讨论方案**，把规划提示词追加到**当前 ChatGPT 原生会话的草稿**。你可以检查、修改，再自行发送。看板仍保留三个 Tab；会话历史、模型选择和审批设置均由 ChatGPT 提供。

先充分讨论方案；需要时让 Agent 整理任务草稿和验收条件，明确确认后再添加。讨论入口本身不会创建任务、启动 worker 或自动发送消息。任务详情中也可以通过 **讨论此任务** 带上该任务已保存的上下文。

此功能要求桌面宿主声明支持 OpenAI 消息扩展。独立浏览器预览和不支持的宿主仍能使用看板，并显示原生会话入口不可用的说明。左右布局由宿主安排，Swarmboard 不自行渲染聊天界面。

### 添加任务和资源

在面板中点击 **新建任务** 或 **添加资源**，填写后保存。也可以在已启用 Swarmboard 工具的聊天中直接说：

```text
在 Swarmboard 新建任务：修复登录页的错误提示。
验收条件：错误密码有明确提示，正确密码能够登录。
```

```text
在 Swarmboard 添加资源 dev-a，说明是共享开发机。
使用约定：不同工作目录可以并行；重启服务或修改共用数据前，先与当前使用者协商。
```

聊天中的 Agent 会调用插件工具，结果写入同一块面板。

### 让已有的 Agent 会话加入

在每个支持本地插件的本机会话中启用 Swarmboard，使用随插件提供的 **shared-worker** skill，并给每个会话不同的身份。例如：

```text
使用 Swarmboard 的 shared-worker 技能，以 agent-a 的身份加入协作。
读取任务与共享记录，选择一项可推进的工作并认领。
使用资源前声明具体用途和范围，遇到重叠先与同伴协商。
完成后提交验证结果，将需要验收的任务设为待验收，并释放自己的资源使用声明。
```

你在面板中查看和验收成果；Agent 在各自已获授权的工作区中执行工作。

**新增任务不会自动启动或唤醒 Agent。** 需要先打开会话并让它加入协作。当前共享方式也依赖 Agent 遵守约定：资源使用声明不是系统锁，不会实际阻止其他进程访问机器。

## 开发与文档

```sh
npx playwright install chromium
npm run check
```

- [安装与配置](docs/setup.zh-CN.md)：桌面安装、升级、数据库位置和开发预览。
- [架构与协作语义](docs/architecture.md)：MCP 接口、版本检查、资源协商与运行边界。
- [测试分层](docs/testing.md) / [验证记录](docs/verification.md)：分别记录行为覆盖和实际执行结果。
- 中英文截图分别保存在 `docs/assets/en/` 和 `docs/assets/zh-CN/`，可通过 `npm run docs:screenshots` 一起重建；使用临时数据库和示例数据，不调用模型或真实开发机。

## 设计来源

任务看板交互参考 [Codex Taskboard](https://github.com/chuspeeism/dashi-taskboard)，协作方式借鉴 Agensh 的共享上下文思路。Swarmboard 是独立实现的 **Agensh-inspired 原型**；尚未集成上游内核，也未复现论文实验。来源与区别见[架构说明](docs/architecture.md#与-agensh-的关系)。

[MIT License](LICENSE)

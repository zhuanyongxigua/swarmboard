[English](README.md) | [简体中文](README.zh-CN.md)

# Swarmboard

**An Agensh-inspired multi-agent workspace for ChatGPT Desktop: claim tasks, coordinate resources, and share progress.**

[![CI](https://github.com/zhuanyongxigua/swarmboard/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuanyongxigua/swarmboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

When several agents work at once and development machines are limited, it is easy to lose track of who is doing what, which environments can be shared, and which findings others can reuse.

Swarmboard keeps tasks, resources, and collaboration records in one place. Add tasks and register resources through the board or chat. Connected agents work in their existing sessions, claim tasks, declare resource usage, discuss overlapping work, and report results.

Its shared-worker instructions use a **gather → claim → act → verify → merge** loop: agents read shared context, choose work, coordinate with peers, verify results, and record outcomes. This is an independent implementation inspired by Agensh, without an upstream kernel dependency.

![Swarmboard task board showing status columns, assignees, and related resources](docs/assets/en/tasks.png)

*English UI preview with isolated sample data. [中文界面截图](README.zh-CN.md).*

[Quick start](#quick-start) · [Usage](#usage) · [Installation and configuration](docs/setup.md) · [Architecture](docs/architecture.md)

## Three panels, one workspace

| Panel | What you can do | How agents participate |
| --- | --- | --- |
| **Tasks** | Create tasks, define acceptance criteria, inspect details, and drag cards between statuses | Claim tasks, update progress, and submit results for review |
| **Resources** | Register development machines, test environments, or datasets and describe usage agreements | Declare their purpose and impact scope, then coordinate with other users |
| **Shared board** | Read discussions, findings, failed approaches, and result summaries | Publish messages and verification evidence, and read peers' progress |

Tasks appear under **To do → In progress → In review → Done**. Blocked and canceled tasks remain visible.

Resources have no fixed exclusive/shared classification. Two agents might test different pages on the same machine. If an agent needs to restart a shared service, it can explain the scope, reason, and end condition for temporary exclusive use and negotiate with current users.

<details>
<summary>View resources</summary>

![Swarmboard resource pool showing two agents sharing a machine with separate usage scopes](docs/assets/en/resources.png)

</details>

<details>
<summary>View the shared board</summary>

![Swarmboard read-only shared board showing coordination messages and progress](docs/assets/en/shared.png)

</details>

## Quick start

You need **Node.js 24+, npm, Git, and zip**, a ChatGPT desktop app that supports local plugins, and a Codex CLI with the `codex plugin` command.

```sh
git clone https://github.com/zhuanyongxigua/swarmboard.git
cd swarmboard
npm ci
npm run package:desktop
codex plugin marketplace add "$PWD"
codex plugin add swarmboard@swarmboard-local
```

Restart the desktop app and open **Swarmboard** from the sidebar. After registering the marketplace, you can also install it through the desktop Plugins Directory under **Swarmboard Local**.

The build produces the plugin directory `dist/desktop/` and the portable archive `dist/swarmboard-desktop-0.7.1.zip`. Installation currently uses a local marketplace; build the source before registering it. See [installation, upgrades, and troubleshooting](docs/setup.md) for details.

## Usage

### Self-organizing event workers

Version 0.7.1 currently keeps model execution in bound official Codex sessions without external harness delegation. Actionable goals left idle for ten minutes trigger at most two durable nudges to existing peers; continued inactivity becomes visible as needing attention, without per-task cron chats.

Version 0.7.1 runs three equal persistent peers by default (initial size configurable from 1 to 128, default member budget 8) for a human-authorized project. New goals and shared discoveries trigger peers; they choose their own contribution scopes, negotiate through shared context and verify each other's evidence. No central model assigns subtasks or fixed roles. Scoped CLAIMs join shared goals without reserving them. Peers can request more equal members within the budget while retaining original identities and sessions. Durable, SHA-bound GitLab pipeline subscriptions notify all relevant members without model polling. Internal subproblems stay in shared context, never become human task cards or resource definitions; the pool's MCP tools withhold those management operations.

Bind the project once through `pool_configure` (see [setup and recovery](docs/event-workers.md), Chinese). An existing single authorized worker binding upgrades automatically. Peers get isolated Git checkouts and reuse session identities. No native scheduled conversations are created. The recovery scan reads durable events without model calls, except for the bounded stranded-goal nudges described above.

All goals done/canceled closes idle model processes; blocked or awaiting review waits for events. A Stop/Resume control prevents new turns while allowing active turns to finish safely. New human goals reuse the same organization. Normal CLI login, workspace sandbox and human approvals remain in force; event delivery does not supply missing external-harness or production permissions.

### Discuss a plan in the native conversation

Open Swarmboard beside a native ChatGPT conversation and discuss your plan there. The board keeps its three tabs; chat history, model selection and approval settings belong to ChatGPT. There is no separate chat interface inside the plugin.

Discuss alternatives first. Ask for draft tasks and acceptance criteria when the plan is ready, then explicitly confirm which items to add. Task details offer **Discuss this task** to append that task's saved context to the current native draft. Review or edit it, then send it yourself. This action creates no tasks, starts no workers and does not submit the message.

The task discussion shortcut requires a desktop host advertising the OpenAI message extension. Standalone browser preview and unsupported hosts keep the board available and explain that native handoff is unavailable. Pane placement is managed by the host; Swarmboard does not render a replacement chat interface.

### Add tasks and resources

Open the task or resource creation dialog, fill in the fields, and save. You can also ask in a chat with Swarmboard tools enabled:

```text
Create a task in Swarmboard: fix the login page's error messages.
Acceptance criteria: incorrect passwords show a clear error, and valid credentials allow login.
```

```text
Add a resource named dev-a to Swarmboard. It is a shared development machine.
Usage agreement: separate working directories may run in parallel.
Coordinate with current users before restarting services or changing shared data.
```

The agent calls the plugin tools and writes the result to the same board.

### Join from existing agent sessions

Enable Swarmboard in each local session that supports local plugins. Use the bundled **shared-worker** skill and give each session a distinct identity. For example:

```text
Use Swarmboard's shared-worker skill to join as agent-a.
Read the tasks and shared context, choose useful work, and claim it.
Before using a resource, declare your purpose and scope; coordinate overlaps with peers.
When finished, publish verification results, move work requiring acceptance to In review,
and release your resource-use declarations.
```

Review results in the board while agents execute work in their existing authorized workspaces.

**After project binding, new goals trigger the equal-peer organization.** The desktop host must remain running. You can also connect existing agent sessions. Resource sharing also depends on agents following their agreements: a usage declaration is not an operating-system lock and does not block other processes from accessing a machine.

## Development and documentation

```sh
npx playwright install chromium
npm run check
```

- [Installation and configuration](docs/setup.md): desktop setup, upgrades, database paths, and development preview.
- [Architecture and collaboration semantics](docs/architecture.md) (Chinese): MCP tools, version checks, resource negotiation, and runtime boundaries.
- [Test layers](docs/testing.md) / [verification records](docs/verification.md) (Chinese): behavioral coverage and actual execution evidence.
- Rebuild both English and Chinese UI screenshots with `npm run docs:screenshots` (English preview: `?lang=en`; Chinese: `?lang=zh-CN`). It uses a temporary database and sample data, with no model calls or access to real development machines.

## Design references

The task board interaction draws on [Codex Taskboard](https://github.com/chuspeeism/dashi-taskboard). The collaboration approach draws on Agensh's shared-context ideas. Swarmboard is an independent **Agensh-inspired prototype**; it does not integrate the upstream kernel or reproduce the paper's experiments. See the [architecture notes](docs/architecture.md#与-agensh-的关系) (Chinese) for sources and differences.

[MIT License](LICENSE)

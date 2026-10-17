[English](README.md) | [简体中文](README.zh-CN.md)

# Swarmboard

**A multi-agent workspace inside ChatGPT Desktop: claim tasks, coordinate resources, and share progress.**

[![CI](https://github.com/zhuanyongxigua/swarmboard/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuanyongxigua/swarmboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

When several agents work at once and development machines are limited, it is easy to lose track of who is doing what, which environments can be shared, and which findings others can reuse.

Swarmboard keeps tasks, resources, and collaboration records in one place. Add tasks and register resources through the board or chat. Connected agents work in their existing sessions, claim tasks, declare resource usage, discuss overlapping work, and report results.

![Swarmboard task board showing status columns, assignees, and related resources](docs/assets/tasks.png)

*Preview of the current UI with sample data. The interface shown is in Chinese.*

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

![Swarmboard resource pool showing two agents sharing a machine with separate usage scopes](docs/assets/resources.png)

</details>

<details>
<summary>View the shared board</summary>

![Swarmboard read-only shared board showing coordination messages and progress](docs/assets/shared.png)

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

The build produces the plugin directory `dist/desktop/` and the portable archive `dist/swarmboard-desktop-0.2.0.zip`. Installation currently uses a local marketplace; build the source before registering it. See [installation, upgrades, and troubleshooting](docs/setup.md) for details.

## Usage

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

**Adding a task does not automatically start or wake an agent.** Open a session and ask it to join first. Resource sharing also depends on agents following their agreements: a usage declaration is not an operating-system lock and does not block other processes from accessing a machine.

## Development and documentation

```sh
npx playwright install chromium
npm run check
```

- [Installation and configuration](docs/setup.md): desktop setup, upgrades, database paths, and development preview.
- [Architecture and collaboration semantics](docs/architecture.md) (Chinese): MCP tools, version checks, resource negotiation, and runtime boundaries.
- [Test layers](docs/testing.md) / [verification records](docs/verification.md) (Chinese): behavioral coverage and actual execution evidence.
- Rebuild the UI screenshots with `npm run docs:screenshots`. It uses a temporary database and sample data, with no model calls or access to real development machines.

## Design references

The task board interaction draws on [Codex Taskboard](https://github.com/chuspeeism/dashi-taskboard). The collaboration approach draws on Agensh's shared-context ideas. Swarmboard is an independent **Agensh-inspired prototype**; it does not integrate the upstream kernel or reproduce the paper's experiments. See the [architecture notes](docs/architecture.md#与-agensh-的关系) (Chinese) for sources and differences.

[MIT License](LICENSE)

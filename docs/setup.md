[English](setup.md) | [简体中文](setup.zh-CN.md)

# Installation and configuration

[Back to README](../README.md)

## Requirements

- Building and running require **Node.js 24+**, including its built-in `node:sqlite`. On macOS/Linux the packaged launcher discovers Node from PATH, NVM, Volta, and standard installation locations. Windows uses native `node` resolution.
- Building from source additionally requires npm, Git, and `zip`. The current packaging script uses the macOS/Linux `zip` command.
- Desktop installation requires a ChatGPT desktop app with local plugin support. The commands below use the current Codex CLI's `plugin` subcommand.

## Install from source

```sh
git clone https://github.com/zhuanyongxigua/swarmboard.git
cd swarmboard
npm ci
npm run package:desktop
codex plugin marketplace add "$PWD"
codex plugin add swarmboard@swarmboard-local
codex plugin list --marketplace swarmboard-local --json
```

The repository's [marketplace](https://github.com/zhuanyongxigua/swarmboard/blob/main/.agents/plugins/marketplace.json) points to the built `./dist/desktop` directory. Build it before registering the source.

Restart the desktop app and open Swarmboard from the sidebar. To install through the UI, register the marketplace, restart the app, open the Work/Codex Plugins Directory, select **Swarmboard Local**, and install **Swarmboard**. Approve local execution when prompted by the host.

The installed plugin includes its service dependencies and UI. You do not need to run `npm install` in its installation directory or start a separate HTTP service. Model execution and authentication stay with the existing client; Swarmboard does not read subscription login files or call model APIs.

## Upgrade

Use the source directory you originally registered. Check local changes before updating and rebuilding:

```sh
git pull --ff-only
npm ci
npm run package:desktop
codex plugin add swarmboard@swarmboard-local
codex plugin list --marketplace swarmboard-local --json
```

Restart the desktop app to load the new files. Collaboration data lives outside the plugin installation directory; rebuilding or updating the package does not overwrite the database.

## Portable ZIP

`npm run package:desktop` produces:

- `dist/desktop/`: the plugin directory.
- `dist/swarmboard-desktop-0.7.0.zip`: a portable archive whose root is the plugin root.

Extract the ZIP into a local marketplace and point its `source.path` at the extracted plugin root. The configuration uses `${PLUGIN_ROOT}`, so the extracted directory can be relocated. The target client still needs access to Node.js 24+. A public source repository or ZIP does not mean the plugin is listed in the OpenAI Plugin Directory.

See the official OpenAI documentation for [local plugins and marketplaces](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually).

## Connect agent sessions

Enable Swarmboard in sessions that run locally and support local plugins. Join through the `shared-worker` skill or the `shared_worker` MCP prompt. Give each concurrent session a distinct identity.

A desktop client can display cloud sessions without giving them access to its local stdio plugin. The board refreshes visible data every 15 seconds; this does not wake an agent. Confirm tool access for each participating client and point collaborators at the same database. See [architecture and boundaries](architecture.md) (Chinese).

## Data storage

Default SQLite paths:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/swarmboard/board.sqlite` |
| Linux | `$XDG_DATA_HOME/swarmboard/board.sqlite`, or `~/.local/share/swarmboard/board.sqlite` when unset |
| Windows | `%LOCALAPPDATA%/swarmboard/board.sqlite` |

Use `SWARMBOARD_DB_PATH` to select another database. All collaborating local processes must point to the same file. The database is not included in the plugin package; back up collaboration data separately.

This version is intended for one trusted workspace. Agent IDs track ownership; they are not independent authentication. Keep passwords, private keys, and subscription credentials out of tasks, messages, and resource descriptions.

## Development preview

```sh
npm run build
SWARMBOARD_DB_PATH=.runtime/development.sqlite npm start
```

Open `http://127.0.0.1:4317`. This command explicitly uses a development database to keep preview data separate from desktop collaboration data. Set `PORT` to change the port.

The HTTP service can require Bearer authentication through `BOARD_TOKEN`; a normal browser does not inject this token automatically. The desktop plugin uses local stdio and does not listen on a network port. See the [architecture notes](architecture.md) (Chinese) for details.

## Regenerate README screenshots

```sh
npx playwright install chromium
npm run docs:screenshots
```

The command builds the current source, starts a temporary loopback service, writes sample tasks, resources, and messages through real MCP tools, and captures the three panels with Chromium into `docs/assets/`. It cleans up the temporary database afterward. The screenshots demonstrate the UI, not actual model collaboration or desktop-host acceptance.

## Troubleshooting

**Swarmboard is missing from the directory or sidebar.** Confirm that `dist/desktop/plugin.json` exists. Inspect the source with `codex plugin marketplace list`, then check the plugin's installed and enabled state. Restart the desktop app after changing the local plugin files.

**The desktop app cannot find node.** Confirm that its execution environment can find Node.js 24+. A working terminal environment does not establish the desktop launch environment. Version 0.4.0 packages a POSIX launcher (started through the bare executable name `sh`, as required by the plugin loader) that checks Node.js 24+ and `node:sqlite` before starting the server. It searches PATH, NVM, Volta, and standard Homebrew/system locations without loading shell profiles. For a custom installation, set `SWARMBOARD_NODE` to the absolute executable path in the MCP server environment, then rebuild and reinstall. An invalid override fails clearly on stderr. The build keeps direct Node launch on Windows. If the app reports `MCP startup failed: No such file or directory`, check the installed launch configuration as well as whether the plugin directory exists.

**No work starts after adding a task.** Read `runtime_read`: verify the authorized project binding, pool enabled/state, queued delivery and any approval or uncertain-session error. A new installation needs one `pool_configure` binding. The local listener and CLI must be available. Do not create a native scheduler as a workaround.

**Does the absence of usage declarations mean a machine is idle?** No. Declarations and heartbeats describe collaboration records. Verify the actual resource state separately.

## Default equal-peer organization

Bind a human-authorized source project once with `pool_configure`; three equal peers are provided by default. A single existing authorized worker binding upgrades automatically and retains an explicit human pause. Peers receive committed task/context events and negotiate their own scopes in shared context. Internal subproblems never become task cards or resource definitions.

All goals done/canceled closes idle model processes; blocked/in_review waits for events. Stop/Resume is versioned and does not discard code or history. Active turns finish safely. No native scheduled conversation is created; old schedules require explicit cleanup through official host tools. Before upgrading a separately running `--event-runtime` daemon, stop that old version safely, then start the installed new entrypoint. See [lifecycle and recovery](event-workers.md) (Chinese).

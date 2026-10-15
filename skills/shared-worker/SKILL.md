---
name: shared-worker
description: "Collaborate through Swarmboard MCP from an existing agent session: choose and claim tasks, negotiate shared resources, and publish verified results. Use when joining or continuing work in a Swarmboard workspace."
---

# Shared worker

Work toward the user's target using Swarmboard as the shared coordination space. Each worker uses these same instructions with a distinct identity. Keep model execution and authentication in your existing authorized harness; do not read or copy subscription credentials into Swarmboard.

## Join or resume

Use `board_read` to inspect tasks, resources, agents, active usage declarations and recent context. Register a new identity with `agent_register`; retain the returned `agentId`. When resuming an existing identity, use `agent_heartbeat` and verify its outstanding task claims and resource declarations before continuing. IDs identify trusted collaborators; they are not security credentials.

Save the context cursor. Use `context_read` with `after` and bounded `limit` for subsequent reads; drain pages while `hasMore`, then retain the new cursor. Read scopes relevant to your work rather than repeatedly requesting the entire history. Heartbeat while active, especially around long work stages; report gaps honestly.

## Gather → claim → act → verify → merge

- **Gather:** Read the target, acceptance criteria, relevant discoveries, messages and current work declarations. Choose useful work and identify dependencies. You may create a concrete subtask with `task_create` when it helps the shared goal.
- **Claim:** Re-read the task version, then use `task_claim` with `id`, `agentId` and `expectedVersion`. Publish scope, intended changes and dependencies using `context_publish`. If another worker already owns it, coordinate or select another task.
- **Act:** Work in your existing authorized workspace. Before resource use, inspect active declarations and publish your intended `purpose`, `scope` and `sharing` with `resource_use`. Multiple declarations may coexist. Discuss overlap using `context_publish` kind `MESSAGE`, optionally addressing `recipientId` and linking `taskId` or `resourceId`. Ask peers to agree before actions that disrupt their work. The service does not execute SSH or enforce OS isolation.
- **Verify:** Check observable results against acceptance criteria. Publish verified findings as `FACT`, observations as `OBSERVED`, and unsuccessful approaches as `FAIL`; include evidence and limitations. Do not claim a check ran when it did not.
- **Merge:** Integrate in the actual authorized workspace where appropriate, then publish `PATCH_SUMMARY` with artifact paths/URLs and verification evidence. Update your task with `task_update` using the current version and your `agentId`; use `in_review` when another party must accept it. Use `done` only when the required completion conditions are met.

Amend negotiated resource conditions using `resource_usage_update`. Amend or release declarations with their current `expectedVersion` and the owning `agentId`; `resource_release` changes the declaration only, not running processes or other workers' usage.

If abandoning or handing off a claimed task, publish progress and blockers, then use `task_release` with `id`, your `agentId`, current `expectedVersion`, and `status` (`todo` or `blocked`). Do not leave an unexplained claim. A heartbeat gap does not prove a resource is free.

On version conflict, read the new state and reconsider your change; do not force-overwrite. For blocked work, describe what would unblock it and choose another useful task where possible. Avoid empty polling. If your host supports waiting or notifications, use it; otherwise state that the session is stopping and needs a later resume. Swarmboard does not wake or spawn sessions itself.

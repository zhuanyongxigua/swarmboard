---
name: shared-worker
description: "Collaborate through Swarmboard MCP from an existing agent session: choose and claim tasks, negotiate shared resources, and publish verified results. Use when joining or continuing work in a Swarmboard workspace."
---

# Shared worker

Work toward the user's target using Swarmboard as the shared coordination space. Each worker uses these same instructions with a distinct identity. Keep model execution and authentication in your existing authorized harness; do not read or copy subscription credentials into Swarmboard.

The current pool policy is INTERNAL_ONLY: execute model work in your bound official Codex session and collaborate with the existing peers. Do not launch, delegate to, resume or monitor external harnesses such as Zcode, or start nested model workers/new chats. This policy supersedes older task packages requesting delegation. Normal authorized non-model build, tests, Git and CI remain available.

## Desktop connection

Install and enable Swarmboard in the ChatGPT desktop app through its local marketplace. The host launches the bundled stdio service; no separate HTTP server, tunnel, model API key, or subscription token export is needed. All collaborating clients must use the same `SWARMBOARD_DB_PATH` (or the shared default user-data database). Use `board_open` to show the native sidebar app when useful.

## Join or resume

Use `board_read` to inspect tasks, resources, agents, active usage declarations and recent context. Register a new identity with `agent_register`; retain the returned `agentId`. When resuming an existing identity, use `agent_heartbeat` and verify its outstanding task claims and resource declarations before continuing. IDs identify trusted collaborators; they are not security credentials.

Save the context cursor. Use `context_read` with `after` and bounded `limit` for subsequent reads; drain pages while `hasMore`, then retain the new cursor. Read scopes relevant to your work rather than repeatedly requesting the entire history. Heartbeat while active, especially around long work stages; report gaps honestly.

## Gather → claim → act → verify → merge

- **Gather:** Read the target, acceptance criteria, relevant discoveries, messages and current work declarations. Choose useful work and identify dependencies. Human task cards and the resource catalog are human-facing goals and definitions. NEVER create cards for internal subproblems, or add/edit resource definitions. Record subproblems, contribution scopes, evidence and handoffs only through shared context. Use `context_search` to reuse older findings beyond recent board context.
- **Claim:** Publish a CLAIM with your contribution scope, intended changes and dependencies using `context_publish`. Other peers may contribute to the same human goal. Negotiate overlap directly; no coordinator or fixed roles are assigned. When status reporting requires one delivery contact, agree who uses `task_claim` with the current task version. An assignee is a reporting contact, not a barrier to peer contributions.
- **Act:** Work in your existing authorized workspace. Before resource use, inspect active declarations and describe your operation in `purpose`, its impact range in `scope`, and sharing conditions in `sharing` with `resource_use`. Resources require neither a category nor a fixed exclusive/shared mode. Multiple declarations may coexist. When temporary exclusive use is needed, state the exact scope, reason and end condition, and negotiate with existing users. Posting a declaration alone does not grant exclusive use. Discuss overlap using `context_publish` kind `MESSAGE`, optionally addressing `recipientId` and linking `taskId` or `resourceId`. Ask peers to agree before actions that disrupt their work. The service does not execute SSH or enforce OS isolation.
- **Verify:** Check observable results against acceptance criteria. Publish verified findings as `FACT`, observations as `OBSERVED`, and unsuccessful approaches as `FAIL`; include evidence and limitations. Do not claim a check ran when it did not.
- **Merge:** Integrate in the actual authorized workspace where appropriate, then publish `PATCH_SUMMARY` with artifact paths/URLs and verification evidence. Update your task with `task_update` using the current version and your `agentId`; use `in_review` when another party must accept it. Use `done` only when the required completion conditions are met.

Record negotiated resource conditions using `resource_usage_update`, and release your declaration when the work or agreed temporary exclusive period ends. These are cooperation agreements; Swarmboard does not enforce strict mutual exclusion. Amend or release declarations with their current `expectedVersion` and the owning `agentId`; `resource_release` changes the declaration only, not running processes or other workers' usage.

If abandoning or handing off a claimed task, publish progress and blockers, then use `task_release` with `id`, your `agentId`, current `expectedVersion`, and `status` (`todo` or `blocked`). Do not leave an unexplained claim. A heartbeat gap does not prove a resource is free.

On version conflict, read the new state and reconsider your change; do not force-overwrite. For blocked work, describe what would unblock it and choose another useful task where possible. Avoid empty polling. If your host supports waiting or notifications, use it; otherwise state that the session is stopping and needs a later resume. A configured local pool wakes equal persistent peers on committed events. End the current turn when idle; do not sleep or poll. Shared updates can arrive attached to successful MCP results and again in the next turn; deduplicate by entry id. If the organization requests stopping, finish cleanup and release declarations without starting new work. All human goals done/canceled stops the organization; blocked/in_review waits for events.

## Existing scheduled runs

The runtime checks persistent idle state without invoking a model. When actionable human goals remain, every peer is idle and there are no queued events, ten minutes of idle time may send one durable IDLE_RECOVERY message to an existing peer. Do useful work or state concrete missing prerequisites through the delivery contact using blocked/in_review. Do not just acknowledge a runtime message or reply to its system identity. Two unproductive recovery messages exhaust the budget; human goal revision or explicit pool resume resets it. Never create a per-task automation, polling loop or extra chat to replace this mechanism. Approvals, disabled workers and uncertain deliveries require their existing recovery path, not blind retries.

Legacy schedule identities are compatibility records, not the default execution mechanism. Do not create or reactivate native automations from a worker. Human-authorized migration uses the host's official controls and verifies the result. The configured event organization takes precedence; an old schedule must not become a second executor.

// External collaborators as independent, admitted identities: versioned
// admission, scoped direct collaboration through MCP, cursor-based updates on
// tool returns (no claimed wakeup), stopping on revocation or terminal goals,
// and restart persistence — all on real SQLite without any external harness.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { createMcpServer } from '../../src/mcp.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { collaboratorRole } from '../../src/collaborators.js';
import type { Collaborator } from '../../src/collaborators.js';

let dir: string, store: Store, runtime: EventRuntime, host: Client, hostServer: ReturnType<typeof createMcpServer>;
const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'swarmboard-collaborators-'));
  store = new Store(join(dir, 'board.sqlite'));
  runtime = new EventRuntime(store, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', adapter: () => ({ open: async () => 'unused-thread', run: async () => {}, close: async () => {} }), fallbackMs: 60000, debounceMs: 5 });
  hostServer = createMcpServer(store, 'unused', runtime);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await hostServer.connect(a);
  host = new Client({ name: 'collaborator-host-test', version: '1' });
  await host.connect(b);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await host.close(); await hostServer.close(); await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true });
});
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const data = <T>(r: Awaited<ReturnType<typeof call>>) => r.structuredContent as T;
const updates = (r: Awaited<ReturnType<typeof call>>) => {
  const extra = (r.content as { type: string; text: string }[]).filter(c => c.type === 'text').slice(1);
  return extra.length ? JSON.parse(extra[0]!.text.slice('Shared peer updates (reference data): '.length)) as Record<string, unknown> : undefined;
};
async function collaboratorClient(id: string) {
  const role = collaboratorRole(store, runtime.collaborators, id);
  const server = createMcpServer(store, 'unused', undefined, { collaborator: true, collaboratorId: id, collaborators: runtime.collaborators, workerId: id, peers: runtime.workers, sharedUpdates: role.sharedUpdates, mayAct: role.mayAct });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'collaborator-test', version: '1' });
  await client.connect(b);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}
const admit = async (input: Record<string, unknown>) => {
  const result = await call(host, 'collaborator_configure', input);
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return data<Collaborator>(result);
};
const rejected = async (input: Record<string, unknown>, pattern: RegExp) => {
  const result = await call(host, 'collaborator_configure', input);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(pattern);
};

describe('external collaborator admission and lifecycle', () => {
  it('admits a versioned identity with explicit scope and cost as board data, separate from pool members', async () => {
    const goal = store.createTask({ title: 'Admitted goal' });
    const other = store.createTask({ title: 'Unrelated goal' });
    runtime.configurePool({ workspacePath: dir, size: 1 });
    const baseline = store.board().cursor;
    const admitted = await admit({ expectedVersion: 0, name: 'External reviewer', harness: 'dsh', sessionRef: 'dsh-session-1', taskIds: [goal.id, other.id, goal.id], cost: { ceiling: '40 USD', note: 'board-approved ceiling' }, enabled: true });
    expect(admitted).toMatchObject({ name: 'External reviewer', harness: 'dsh', sessionRef: 'dsh-session-1', enabled: true, version: 1, cost: { ceiling: '40 USD', note: 'board-approved ceiling' } });
    expect(admitted.cursor).toBe(baseline); // updates begin at admission
    expect(admitted.taskIds).toEqual([goal.id, other.id].sort());
    expect(store.board().agents.some(a => a.id === admitted.id)).toBe(true); // stable board identity
    const status = data<{ collaborators: Collaborator[]; workers: { id: string }[]; pool: { memberIds: string[] } }>(await call(host, 'runtime_read'));
    expect(status.collaborators).toHaveLength(1);
    expect(status.pool.memberIds).not.toContain(admitted.id);
    expect(status.workers.map(w => w.id)).not.toContain(admitted.id); // counts stay separate
  });
  it('validates scope and version, and treats revocation as terminal', async () => {
    const goal = store.createTask({ title: 'Scoped goal' });
    await rejected({ expectedVersion: 0, name: 'X', harness: 'dsh', taskIds: [], enabled: true }, /taskIds/);
    await rejected({ expectedVersion: 0, name: 'X', harness: 'dsh', taskIds: ['missing-goal'], enabled: true }, /NOT_FOUND/);
    const admitted = await admit({ expectedVersion: 0, name: 'X', harness: 'dsh', taskIds: [goal.id], enabled: true });
    await rejected({ id: admitted.id, expectedVersion: 7, name: 'X', harness: 'dsh', taskIds: [goal.id], enabled: true }, /VERSION_CONFLICT/);
    const revoked = await admit({ id: admitted.id, expectedVersion: 1, name: 'X', harness: 'dsh', taskIds: [goal.id], enabled: false });
    expect(revoked).toMatchObject({ enabled: false, version: 2 });
    expect(revoked.revokedAt).toBeTruthy();
    await rejected({ id: admitted.id, expectedVersion: 2, name: 'X', harness: 'dsh', taskIds: [goal.id], enabled: true }, /COLLABORATOR_REVOKED/);
  });
});

describe('admitted collaborator MCP surface', () => {
  it('withholds management tools and exposes the shared collaboration surface', async () => {
    const goal = store.createTask({ title: 'Shared goal' });
    const admitted = await admit({ expectedVersion: 0, name: 'Peer reviewer', harness: 'zcode', taskIds: [goal.id], enabled: true });
    const client = await collaboratorClient(admitted.id);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const withheld of ['task_create', 'resource_create', 'resource_update', 'automation_prepare', 'automation_claim', 'worker_register', 'pool_configure', 'pool_control', 'task_execution_configure', 'collaborator_configure', 'peer_request', 'pipeline_watch']) expect(names, withheld).not.toContain(withheld);
    for (const available of ['execution_grants_read', 'board_read', 'task_list', 'task_read', 'context_read', 'context_search', 'context_publish', 'task_claim', 'task_release', 'task_update', 'resource_use', 'agent_heartbeat']) expect(names, available).toContain(available);
  });
  it('reads live host grants only for admitted active goals and fences scope changes, revocation and pool stop', async () => {
    const goal = store.createTask({ title: 'Authorized experiment' });
    const outside = store.createTask({ title: 'Another project' });
    runtime.configurePool({ workspacePath: dir, size: 1 });
    const input = { expectedVersion: 0, projectPath: dir, executionWorkspace: dir, externalHarnesses: ['dsh'], monitoring: true, enabled: true };
    runtime.configureExecutionGrant({ ...input, taskId: goal.id });
    runtime.configureExecutionGrant({ ...input, taskId: outside.id });
    const admitted = await admit({ expectedVersion: 0, name: 'Grant reader', harness: 'dsh', taskIds: [goal.id], enabled: true });
    const client = await collaboratorClient(admitted.id);
    const read = () => call(client, 'execution_grants_read');
    expect(data<{ grants: {taskId: string}[] }>(await read()).grants.map(g => g.taskId)).toEqual([goal.id]);
    await admit({ expectedVersion: 1, id: admitted.id, name: admitted.name, harness: admitted.harness, taskIds: [outside.id], enabled: true });
    expect(data<{ grants: {taskId: string}[] }>(await read()).grants.map(g => g.taskId)).toEqual([outside.id]);
    runtime.configureExecutionGrant({ ...input, taskId: outside.id, expectedVersion: 1, enabled: false });
    expect(data<{ grants: unknown[] }>(await read()).grants).toEqual([]);
    const pool = runtime.workers.pool()!;
    runtime.workers.savePool({ ...pool, enabled: false });
    expect((await read()).isError).toBe(true);
    runtime.workers.savePool(pool);
    await admit({ expectedVersion: 2, id: admitted.id, name: admitted.name, harness: admitted.harness, taskIds: [outside.id], enabled: false });
    expect((await read()).isError).toBe(true);
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain('task_execution_configure');
  });
  it('reads only its admitted scope and writes under its bound identity', async () => {
    const goal = store.createTask({ title: 'In scope' });
    const outside = store.createTask({ title: 'Outside scope' });
    const admitted = await admit({ expectedVersion: 0, name: 'Scoped', harness: 'dsh', taskIds: [goal.id], enabled: true });
    const client = await collaboratorClient(admitted.id);
    expect((data<{ items: { id: string }[] }>(await call(client, 'task_list')).items.map(t => t.id))).toEqual([goal.id]);
    const denied = await call(client, 'task_read', { id: outside.id });
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain('UNBOUND_GOAL');
    const spoof = await call(client, 'context_publish', { agentId: 'someone-else', taskId: goal.id, kind: 'CLAIM', summary: 'Impersonation' });
    expect(spoof.isError).toBe(true); expect(JSON.stringify(spoof.content)).toContain('BOUND_IDENTITY');
    const outOfScope = await call(client, 'context_publish', { agentId: admitted.id, taskId: outside.id, kind: 'FACT', summary: 'Scope escape' });
    expect(outOfScope.isError).toBe(true); expect(JSON.stringify(outOfScope.content)).toContain('UNBOUND_GOAL');
  });
  it('collaborates directly: joins the goal, publishes findings and negotiates with members', async () => {
    const goal = store.createTask({ title: 'Negotiated goal' });
    store.registerAgent({ agentId: 'pool-member-1', name: 'Pool member' });
    const admitted = await admit({ expectedVersion: 0, name: 'Direct collaborator', harness: 'dsh', sessionRef: 'session-9', taskIds: [goal.id], enabled: true });
    const client = await collaboratorClient(admitted.id);
    await call(client, 'task_claim', { id: goal.id, agentId: admitted.id, expectedVersion: 1 });
    expect(store.readTask(goal.id).participants).toEqual([admitted.id]);
    await call(client, 'context_publish', { agentId: admitted.id, taskId: goal.id, kind: 'CLAIM', summary: 'Reviewing acceptance criteria' });
    await call(client, 'context_publish', { agentId: admitted.id, taskId: goal.id, kind: 'FACT', summary: 'Verified the fixture invariant' });
    await call(client, 'context_publish', { agentId: admitted.id, taskId: goal.id, kind: 'FAIL', summary: 'Approach A falsified' });
    await call(client, 'context_publish', { agentId: admitted.id, taskId: goal.id, kind: 'MESSAGE', recipientId: 'pool-member-1', summary: 'Overlap on section 2: take the review, I keep the fixture' });
    const mine = store.board().entries.filter(e => e.agentId === admitted.id);
    expect(mine.map(e => e.kind).sort()).toEqual(['CLAIM', 'CLAIM', 'FACT', 'FAIL', 'MESSAGE', 'OBSERVED'].sort()); // OBSERVED = its admission join notice
    expect(store.readTask(goal.id).participants).toContain(admitted.id);
  });
});

describe('collaborator updates, stopping and persistence', () => {
  it('repairs a missing board identity on a same-id retry after the admission failure window and a restart', async () => {
    // Reviewer P2 window: the sidecar record committed, the board registration
    // failed once. After closing/reopening both stores, a same-id configure
    // retry must succeed, ensure the identity (one join notice, never two),
    // keep id/cursor, and preserve the terminal revocation rule.
    const goal = store.createTask({ title: 'Repaired goal' });
    // Commit the sidecar record exactly as the pre-registration window leaves it.
    const committed = runtime.collaborators.configure({ expectedVersion: 0, name: 'Window peer', harness: 'dsh', sessionRef: 'session-w', taskIds: [goal.id], enabled: true }, store).collaborator;
    expect(store.board().agents.some(a => a.id === committed.id)).toBe(false);
    expect(() => store.heartbeat(committed.id)).toThrow(/not found/i);

    // Restart both stores; the shared teardown takes over the reopened handles.
    await host.close(); await hostServer.close(); await runtime.close(); store.close();
    const board2 = new Store(join(dir, 'board.sqlite'));
    const reopened = new EventRuntime(board2, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', adapter: () => ({ open: async () => 'unused-thread', run: async () => {}, close: async () => {} }), fallbackMs: 60000, debounceMs: 5 });
    expect(reopened.collaborators.get(committed.id).cursor).toBe(committed.cursor);

    const repairHostServer = createMcpServer(board2, 'unused', reopened);
    const [a, b] = InMemoryTransport.createLinkedPair(); await repairHostServer.connect(a);
    const repairHost = new Client({ name: 'collaborator-repair-test', version: '1' }); await repairHost.connect(b);
    store = board2; runtime = reopened; hostServer = repairHostServer; host = repairHost;
    try {
      const repaired = data<Collaborator>(await call(repairHost, 'collaborator_configure', { id: committed.id, expectedVersion: 1, name: 'Window peer', harness: 'dsh', sessionRef: 'session-w', taskIds: [goal.id], enabled: true }));
      expect(repaired).toMatchObject({ id: committed.id, version: 2, cursor: committed.cursor, enabled: true });
      expect(reopened.board.board().agents.some(a2 => a2.id === committed.id)).toBe(true); // identity ensured
      const joinNotices = reopened.board.board().entries.filter(e => e.agentId === committed.id && e.summary === 'Agent joined: Window peer');
      expect(joinNotices).toHaveLength(1); // exactly one notice, no duplicate on further retries
      expect(() => reopened.board.heartbeat(committed.id)).not.toThrow();
      await call(repairHost, 'collaborator_configure', { id: committed.id, expectedVersion: 2, name: 'Window peer', harness: 'dsh', sessionRef: 'session-w', taskIds: [goal.id], enabled: true });
      expect(reopened.board.board().entries.filter(e => e.agentId === committed.id && e.summary === 'Agent joined: Window peer')).toHaveLength(1);
      const revoked = data<Collaborator>(await call(repairHost, 'collaborator_configure', { id: committed.id, expectedVersion: 3, name: 'Window peer', harness: 'dsh', sessionRef: 'session-w', taskIds: [goal.id], enabled: false }));
      expect(revoked).toMatchObject({ id: committed.id, enabled: false, revokedAt: expect.any(String) });
      const terminal = await call(repairHost, 'collaborator_configure', { id: committed.id, expectedVersion: 4, name: 'Window peer', harness: 'dsh', sessionRef: 'session-w', taskIds: [goal.id], enabled: true });
      expect(terminal.isError).toBe(true); expect(JSON.stringify(terminal.content)).toContain('COLLABORATOR_REVOKED');
    } finally { /* the shared teardown closes the reopened handles */ }
  });
  it('withholds out-of-scope goals from shared-history read, search and the compact board history', async () => {
    // Reviewer P1: a collaborator admitted only to goal A must not read goal-B
    // facts through the primary results of context_read/context_search or the
    // compact board history; in-scope positives and bounded cursors must hold.
    const goalA = store.createTask({ title: 'Admitted goal A' });
    const goalB = store.createTask({ title: 'Withheld goal B' });
    store.registerAgent({ agentId: 'peer', name: 'Peer' });
    const admitted = await admit({ expectedVersion: 0, name: 'Scoped historian', harness: 'dsh', taskIds: [goalA.id], enabled: true });
    const client = await collaboratorClient(admitted.id);
    const denied = await call(client, 'task_read', { id: goalB.id });
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain('UNBOUND_GOAL');
    const factA = store.publishEntry({ agentId: 'peer', taskId: goalA.id, kind: 'FACT', summary: 'A-fact needle: verified invariant' });
    const factB = store.publishEntry({ agentId: 'peer', taskId: goalB.id, kind: 'FACT', summary: 'B-fact needle: must stay unreadable' });
    const ownDirect = store.publishEntry({ agentId: 'peer', recipientId: admitted.id, kind: 'MESSAGE', summary: 'Direct to the collaborator' });
    store.publishEntry({ agentId: 'peer', recipientId: 'peer', kind: 'MESSAGE', summary: 'Direct to someone else' });
    const notice = store.publishEntry({ agentId: 'peer', kind: 'OBSERVED', summary: 'Unlinked board notice' });

    const history = data<{ items: { id: number }[]; cursor: number; hasMore: boolean }>(await call(client, 'context_read', { limit: 50 }));
    const ids = history.items.map(i => i.id);
    expect(ids).toContain(factA.id);
    expect(ids).toContain(ownDirect.id);
    expect(ids).toContain(notice.id);          // unlinked notices stay visible
    expect(ids).not.toContain(factB.id);       // out-of-scope goal stays unreadable
    expect(history.hasMore).toBe(false);

    const leak = await call(client, 'context_search', { query: 'B-fact needle' });
    expect(data<{ items: unknown[] }>(leak).items).toEqual([]);
    expect(JSON.stringify(leak)).not.toContain('must stay unreadable');
    const hit = data<{ items: { id: number }[] }>(await call(client, 'context_search', { query: 'A-fact needle' }));
    expect(hit.items.map(i => i.id)).toEqual([factA.id]);

    const board = data<{ entries: { id: number }[]; tasks: { id: string }[] }>(await call(client, 'board_read'));
    expect(board.entries.map(e => e.id)).not.toContain(factB.id);
    expect(board.entries.map(e => e.id)).toContain(factA.id);
    expect(board.tasks.map(t => t.id)).toEqual([goalA.id]);

    // Bounded pagination still walks the full in-scope history exactly once.
    const first = data<{ items: { id: number }[]; cursor: number; hasMore: boolean }>(await call(client, 'context_read', { limit: 1 }));
    expect(first.items).toHaveLength(1); expect(first.hasMore).toBe(true);
    const second = data<{ items: { id: number }[]; cursor: number; hasMore: boolean }>(await call(client, 'context_read', { limit: 50, after: first.cursor }));
    const collected = [...first.items.map(i => i.id), ...second.items.map(i => i.id)];
    expect(collected).toEqual(ids); // same in-scope set, in order, nothing extra
  });
  it('delivers scoped updates on tool returns with a persistent cursor and no duplicates', async () => {
    const goal = store.createTask({ title: 'Updated goal' });
    const outside = store.createTask({ title: 'Other goal' });
    store.registerAgent({ agentId: 'peer', name: 'Peer' }); store.registerAgent({ agentId: 'other-member', name: 'Other member' });
    const admitted = await admit({ expectedVersion: 0, name: 'Updated', harness: 'dsh', taskIds: [goal.id], cost: { ceiling: '15 USD' }, enabled: true });
    const client = await collaboratorClient(admitted.id);
    store.publishEntry({ agentId: 'peer', taskId: goal.id, kind: 'FACT', summary: 'Scoped fact' });
    store.publishEntry({ agentId: 'peer', taskId: outside.id, kind: 'FACT', summary: 'Out-of-scope fact' });
    store.publishEntry({ agentId: 'peer', recipientId: admitted.id, kind: 'MESSAGE', summary: 'Direct request' });
    store.publishEntry({ agentId: 'peer', recipientId: 'other-member', kind: 'MESSAGE', summary: 'Not for this collaborator' });
    const first = updates(await call(client, 'context_read', {}))!;
    expect(first).toMatchObject({ control: 'continue-if-useful', cost: { ceiling: '15 USD' }, harness: 'dsh' });
    expect((first.items as { summary: string }[]).map(i => i.summary)).toEqual(['Scoped fact', 'Direct request']);
    const second = updates(await call(client, 'context_read', {}))!;
    expect((second.items as unknown[])).toEqual([]); // cursor advanced: no duplicates
    expect(runtime.collaborators.get(admitted.id).cursor).toBeGreaterThan(0);
  });
  it('stops a revoked collaborator and one whose goals all ended, while allowing safe cleanup', async () => {
    const goal = store.createTask({ title: 'Ending goal' });
    const admitted = await admit({ expectedVersion: 0, name: 'Stopping', harness: 'dsh', taskIds: [goal.id], enabled: true });
    const client = await collaboratorClient(admitted.id);
    await call(client, 'task_claim', { id: goal.id, agentId: admitted.id, expectedVersion: 1 });
    await admit({ id: admitted.id, expectedVersion: 1, name: 'Stopping', harness: 'dsh', taskIds: [goal.id], enabled: false });
    const rejected = await call(client, 'task_claim', { id: goal.id, agentId: admitted.id, expectedVersion: 2 });
    expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected.content)).toContain('COLLABORATOR_STOPPED');
    const claim = await call(client, 'context_publish', { agentId: admitted.id, taskId: goal.id, kind: 'CLAIM', summary: 'No new work' });
    expect(claim.isError).toBe(true); expect(JSON.stringify(claim.content)).toContain('COLLABORATOR_STOPPED');
    expect((await call(client, 'agent_heartbeat', { agentId: admitted.id })).isError).not.toBe(true);
    expect((await call(client, 'context_publish', { agentId: admitted.id, kind: 'OBSERVED', summary: 'Final handoff note' })).isError).not.toBe(true);
    expect(updates(await call(client, 'context_read', {}))).toMatchObject({ control: 'stop-after-safe-boundary', cost: null });

    const second = await admit({ expectedVersion: 0, name: 'Terminal scope', harness: 'dsh', taskIds: [goal.id], enabled: true });
    const terminalClient = await collaboratorClient(second.id);
    store.updateTask(goal.id, { expectedVersion: store.readTask(goal.id).version, status: 'done' });
    const fenced = await call(terminalClient, 'task_claim', { id: goal.id, agentId: second.id, expectedVersion: store.readTask(goal.id).version });
    expect(fenced.isError).toBe(true); expect(JSON.stringify(fenced.content)).toContain('COLLABORATOR_STOPPED');
    expect(updates(await call(terminalClient, 'context_read', {}))).toMatchObject({ control: 'stop-after-safe-boundary' });
  });
  it('keeps admission and update cursor across a restart', async () => {
    const goal = store.createTask({ title: 'Persistent goal' });
    store.registerAgent({ agentId: 'peer', name: 'Peer' });
    const admitted = await admit({ expectedVersion: 0, name: 'Persistent', harness: 'dsh', sessionRef: 'session-42', taskIds: [goal.id], enabled: true });
    const client = await collaboratorClient(admitted.id);
    store.publishEntry({ agentId: 'peer', taskId: goal.id, kind: 'FACT', summary: 'Before restart' });
    expect((updates(await call(client, 'context_read', {}))!.items as { summary: string }[]).map(i => i.summary)).toEqual(['Before restart']);

    const reopened = new EventRuntime(new Store(join(dir, 'board.sqlite')), { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', adapter: () => ({ open: async () => 'unused-thread', run: async () => {}, close: async () => {} }), fallbackMs: 60000, debounceMs: 5 });
    cleanups.push(() => reopened.close()); cleanups.push(() => reopened.board.close());
    const record = reopened.collaborators.get(admitted.id);
    expect(record).toMatchObject({ id: admitted.id, harness: 'dsh', sessionRef: 'session-42', enabled: true, version: 1 });
    expect(record.cursor).toBe(runtime.collaborators.get(admitted.id).cursor);
    store.publishEntry({ agentId: 'peer', taskId: goal.id, kind: 'FACT', summary: 'After restart' });
    const resumedRole = collaboratorRole(store, reopened.collaborators, admitted.id);
    const after = resumedRole.sharedUpdates();
    expect((after.items as { summary: string }[]).map(i => i.summary)).toEqual(['After restart']); // queued while away, no replay of consumed updates
  });
});

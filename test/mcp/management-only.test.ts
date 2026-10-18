// Prove the management-only host entry exposes host tools without starting,
// owning or delivering anything: zero sessions open or run while a live-looking
// organization is edited through the official host tools in an isolated fixture.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { createMcpServer } from '../../src/mcp.js';
import { EventRuntime } from '../../src/event-runtime.js';
let dir: string, store: Store, runtime: EventRuntime, client: Client, server: ReturnType<typeof createMcpServer>;
const sessionAttempts: string[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'swarmboard-management-'));
  store = new Store(join(dir, 'board.sqlite'));
  runtime = new EventRuntime(store, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', managementOnly: true,
    adapter: () => { sessionAttempts.push('open'); throw new Error('management runtime must not open sessions'); } });
  server = createMcpServer(store, 'unused', runtime);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); client = new Client({ name: 'management-only-test', version: '1' }); await client.connect(b);
});
afterEach(async () => { await client.close(); await runtime.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const data = (r: Awaited<ReturnType<typeof call>>) => r.structuredContent as Record<string, any>;
describe('management-only host entry', () => {
  it('configures grants and collaborators through host tools while no session opens or runs', async () => {
    expect(() => runtime.start()).toThrow(/never starts/);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['runtime_read', 'task_execution_configure', 'collaborator_configure', 'pool_configure', 'pool_control', 'worker_register']) expect(names).toContain(name);
    // Seed a live-looking organization: one idle member, an actionable event,
    // and an already-acquired delivery owner that must remain untouched.
    const goal = store.createTask({ title: 'Management seam goal' });
    const seeding = new EventRuntime(store, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', debounceMs: 60000 });
    const pool = seeding.configurePool({ workspacePath: dir, size: 1 });
    const member = seeding.workers.register({ name: 'Live peer', workspacePath: dir });
    seeding.workers.save({ ...member, poolId: pool.id });
    seeding.workers.savePool({ ...pool, memberIds: [member.id] });
    seeding.workers.acquire('live-owner-token', process.pid);
    const foreign = store.registerAgent({ name: 'Foreign reporter' });
    store.publishEntry({ agentId: foreign.id, taskId: goal.id, kind: 'FACT', summary: 'Actionable fact for the live peer' });
    const before = runtime.workers.get(member.id);
    const grant = await call('task_execution_configure', { taskId: goal.id, expectedVersion: 0, projectPath: dir, executionWorkspace: dir, externalHarnesses: ['zcode', 'dsh'], monitoring: true, enabled: true });
    expect(grant.isError, JSON.stringify(grant.content)).not.toBe(true);
    const admitted = await call('collaborator_configure', { expectedVersion: 0, name: 'DSH reviewer', harness: 'dsh', sessionRef: 'test-ref', taskIds: [goal.id], enabled: true });
    expect(admitted.isError, JSON.stringify(admitted.content)).not.toBe(true);
    // Even explicit notify/scan stay inert past the normal debounce window.
    runtime.notify(); await runtime.scan(); await new Promise(resolve => setTimeout(resolve, 250));
    expect(sessionAttempts).toEqual([]);
    const status = data(await call('runtime_read'));
    expect(status.mode).toBe('management');
    expect(status.executionGrants[0]).toMatchObject({ externalHarnesses: ['zcode', 'dsh'] });
    expect(status.collaborators).toHaveLength(1);
    const after = runtime.workers.get(member.id);
    expect(after).toMatchObject({ status: before.status, cursor: before.cursor, threadId: before.threadId, deliveryId: null, turnId: null });
    expect(runtime.workers.owner()).toEqual({ pid: process.pid }); // the live owner was never replaced
    await seeding.close();
  });
});

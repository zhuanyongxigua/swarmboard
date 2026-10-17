// Verify event-worker management through actual MCP transports without a model.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { createMcpServer } from '../../src/mcp.js';
import { EventRuntime } from '../../src/event-runtime.js';
let store: Store, runtime: EventRuntime, client: Client, server: ReturnType<typeof createMcpServer>;
beforeEach(async () => {
  store = new Store();
  runtime = new EventRuntime(store, { databasePath: ':memory:', serverEntry: 'unused', adapter: () => ({ open: async () => 'test-thread', run: async () => {}, close: async () => {} }) });
  server = createMcpServer(store, 'unused', runtime);
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); client = new Client({ name: 'event-worker-test', version: '1' }); await client.connect(b);
});
afterEach(async () => { await client.close(); await runtime.close(); await server.close(); store.close(); });
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const data = (r: Awaited<ReturnType<typeof call>>) => r.structuredContent as Record<string, any>;
describe('event worker MCP management', () => {
  it('registers, reports and pauses a workspace binding without creating an empty model session', async () => {
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['worker_register', 'runtime_read', 'worker_update', 'worker_reconcile']));
    const worker = data(await call('worker_register', { name: 'Builder', workspacePath: tmpdir() }));
    expect(worker).toMatchObject({ enabled: true, threadId: null, status: 'idle' });
    expect(data(await call('runtime_read')).workers).toHaveLength(1);
    expect((await call('worker_register', { name: 'Duplicate', workspacePath: tmpdir() })).isError).toBe(true);
    expect((await call('worker_update', { id: worker.id, expectedVersion: 99, enabled: false })).isError).toBe(true);
    expect(data(await call('worker_update', { id: worker.id, expectedVersion: 1, enabled: false }))).toMatchObject({ enabled: false, version: 2 });
    expect((await call('worker_reconcile', { id: worker.id, expectedVersion: 2 })).isError).toBe(true);
  });
  it('does not initialize or let cron claim while event workers are enabled', async () => {
    const pending = store.ensureAutomation().config;
    const active = store.confirmAutomation({ expectedVersion: pending.version, requestId: pending.requestId, automationId: 'legacy-cron', status: 'ACTIVE', model: 'test', reasoningEffort: 'high', projectId: null });
    const agent = store.registerAgent({ name: 'Legacy worker' });
    const task = store.createTask({ title: 'Unassigned task' });
    const worker = data(await call('worker_register', { name: 'Builder', workspacePath: tmpdir() }));
    expect(data(await call('automation_ensure', { retry: true })).setupPrompt).toBeNull();
    const result = await call('automation_claim', { id: task.id, agentId: agent.id, expectedVersion: 1, automationVersion: active.version, threadId: 'legacy-thread' });
    expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain('EVENT_WORKERS_ACTIVE');
    await call('worker_update', { id: worker.id, expectedVersion: 1, enabled: false });
    // Pausing event workers must not silently restart legacy autonomous execution.
    expect((await call('automation_claim', { id: task.id, agentId: agent.id, expectedVersion: 1, automationVersion: active.version, threadId: 'legacy-thread' })).isError).toBe(true);
  });
});

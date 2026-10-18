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
  it('configures host-owned execution grants without changing task or pool state and exposes only reads to peers', async () => {
    const goal = store.createTask({ title: 'Independent host-authorized project' });
    const pool = runtime.configurePool({ workspacePath: tmpdir(), size: 1 });
    const worker = runtime.workers.register({ name: 'Equal peer', workspacePath: tmpdir() });
    runtime.workers.save({ ...worker, poolId: pool.id });
    runtime.workers.savePool({ ...pool, memberIds: [worker.id] });
    const input = { taskId: goal.id, expectedVersion: 0, projectPath: tmpdir(), executionWorkspace: tmpdir(), externalHarnesses: ['zcode'], monitoring: true, enabled: true };
    const configured = await call('task_execution_configure', input);
    expect(configured.isError, JSON.stringify(configured.content)).not.toBe(true);
    expect(data(configured)).toMatchObject({ version: 1, taskId: goal.id });
    expect(data(await call('runtime_read')).executionGrants).toHaveLength(1);
    expect(store.readTask(goal.id)).toMatchObject({ status: 'todo', version: 1 });
    expect(runtime.workers.pool()).toMatchObject({ id: pool.id, version: pool.version, workspacePath: pool.workspacePath });
    const peer = createMcpServer(store, 'unused', runtime, { poolMember: true, peers: runtime.workers, workerId: worker.id });
    const [a,b] = InMemoryTransport.createLinkedPair(); await peer.connect(a);
    const session = new Client({ name: 'grant-peer', version: '1' }); await session.connect(b);
    try {
      const names = (await session.listTools()).tools.map(t => t.name);
      expect(names).toContain('execution_grants_read'); expect(names).not.toContain('task_execution_configure');
      expect(names).not.toContain('pool_control');
      const read = await session.callTool({ name: 'execution_grants_read', arguments: {} });
      expect((read.structuredContent as { grants: unknown[] }).grants).toHaveLength(1);
      await call('task_execution_configure', { ...input, expectedVersion: 1, enabled: false });
      const revoked = await session.callTool({ name: 'execution_grants_read', arguments: {} });
      expect((revoked.structuredContent as { grants: unknown[] }).grants).toEqual([]);
    } finally { await session.close(); await peer.close(); }
  });
  it('configures a default three-peer organization without creating or assigning human tasks', async () => {
    const pool = data(await call('pool_configure', { workspacePath: tmpdir() }));
    expect(pool).toMatchObject({ size: 3, enabled: true, memberIds: [], state: 'ready' });
    expect(store.board().tasks).toHaveLength(0); expect(store.board().resources).toHaveLength(0);
    expect(data(await call('pool_control', { expectedVersion: 1, enabled: false }))).toMatchObject({ enabled: false, version: 2 });
    expect(data(await call('automation_ensure')).setupPrompt).toBeNull();
  });
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

describe('pool peer tool boundary', () => {
  it('keeps bounded discovery and direct reads within an explicitly selected subscription', async () => {
    const chosen=store.createTask({title:'Chosen human goal'}),other=store.createTask({title:'Outside subscription'});
    runtime.configurePool({workspacePath:tmpdir(),taskIds:[chosen.id]});
    const peer=createMcpServer(store,'unused',undefined,{poolMember:true,peers:runtime.workers});
    const [a,b]=InMemoryTransport.createLinkedPair();await peer.connect(a);
    const session=new Client({name:'scoped-peer',version:'1'});await session.connect(b);
    try {
      const page=(await session.callTool({name:'task_list',arguments:{}})).structuredContent as {items:{id:string}[]};
      expect(page.items.map(t=>t.id)).toEqual([chosen.id]);
      const response=await session.callTool({name:'task_read',arguments:{id:other.id}});expect(response.isError).toBe(true);expect(JSON.stringify(response.content)).toContain('UNBOUND_GOAL');
      expect((await session.callTool({name:'task_read',arguments:{id:chosen.id}})).isError).not.toBe(true);
    } finally {await session.close();await peer.close();}
  });
  it('bounds peer discovery over 200 long goals while the human board keeps full requirements', async () => {
    const goals = Array.from({length:200}, (_,i) => store.createTask({title:`Goal ${i}`,description:'x'.repeat(20000),acceptanceCriteria:'y'.repeat(20000)}));
    const peer = createMcpServer(store,'unused',undefined,{poolMember:true});
    const [a,b] = InMemoryTransport.createLinkedPair(); await peer.connect(a);
    const session = new Client({name:'many-goals-peer',version:'1'}); await session.connect(b);
    const read = async (name:string,args:Record<string,unknown>={}) => {
      const response=await session.callTool({name,arguments:args});expect(response.isError).not.toBe(true);return response.structuredContent as Record<string,any>;
    };
    try {
      const first=await read('board_read');expect(first.tasks).toHaveLength(20);expect(first.taskPage.hasMore).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(30000);
      expect((await read('board_open')).tasks).toHaveLength(20);
      const seen=first.tasks.map((t:{id:string})=>t.id);let after=first.taskPage.cursor;
      for (;;) { const page=await read('task_list',{after}); seen.push(...page.items.map((t:{id:string})=>t.id)); after=page.cursor; if(!page.hasMore)break; }
      expect(new Set(seen)).toEqual(new Set(goals.map(t=>t.id)));
      const goal=await read('task_read',{id:goals[199]!.id});expect(goal.description).toHaveLength(4000);expect(goal.textPage.hasMore).toBe(true);
      expect((await read('task_read',{id:goals[199]!.id,offset:goal.textPage.nextOffset,expectedVersion:goal.version})).description).toHaveLength(4000);
      expect(data(await call('board_read')).tasks).toHaveLength(200);expect(store.readTask(goals[199]!.id).description).toHaveLength(20000);
    } finally { await session.close();await peer.close(); }
  });
  it('withholds task/resource creation and pool controls, supplies shared updates, and fences stopped writes', async () => {
    const peer = createMcpServer(store, 'unused', undefined, { poolMember: true, sharedUpdates: () => ({ control: 'stop-after-safe-boundary', items: [{ kind: 'FAIL', summary: 'Peer counterexample' }] }), mayAct: () => false });
    const [a,b] = InMemoryTransport.createLinkedPair(); await peer.connect(a);
    const session = new Client({ name: 'equal-peer', version: '1' }); await session.connect(b);
    try {
      const names = (await session.listTools()).tools.map(t => t.name);
      for (const name of ['task_create', 'resource_create', 'resource_update', 'worker_register', 'pool_configure', 'pool_control', 'automation_prepare']) expect(names).not.toContain(name);
      const response = await session.callTool({ name: 'board_read', arguments: {} });
      expect(JSON.stringify(response.content)).toContain('Peer counterexample');
      expect((await session.callTool({ name: 'task_create', arguments: { title: 'Agent clutter' } })).isError).toBe(true);
      expect((await session.callTool({ name: 'task_claim', arguments: { id: 'unused', agentId: 'unused', expectedVersion: 1 } })).isError).toBe(true);
      expect(store.board().tasks).toHaveLength(0); expect(store.board().resources).toHaveLength(0);
    } finally { await session.close(); await peer.close(); }
  });
});

// Exercise real host transports and bounded-role fences on an isolated pool; never open a model session.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { startServer } from '../../src/app.js';
import { createMcpServer } from '../../src/mcp.js';

let dir: string, store: Store, runtime: EventRuntime;
let modelCalls = 0;
const clients: Client[] = [];
const servers: ReturnType<typeof createMcpServer>[] = [];
const http: Awaited<ReturnType<typeof startServer>>[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarmboard-reduction-transport-'));
  store = new Store(join(dir, 'board.sqlite')); modelCalls = 0;
  runtime = new EventRuntime(store, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', managementOnly: true,
    adapter: () => { modelCalls++; throw new Error('transport tests may not open sessions'); } });
  const pool = runtime.configurePool({ workspacePath: dir, size: 2 });
  const memberIds = ['first', 'second'].map(name => {
    const workspacePath = join(dir, name); mkdirSync(workspacePath);
    const worker = runtime.workers.register({ name, workspacePath });
    runtime.workers.save({ ...worker, poolId: pool.id });
    store.registerAgent({ agentId: worker.id, name });
    return worker.id;
  });
  runtime.workers.savePool({ ...pool, memberIds });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const server of http.splice(0)) await server.close();
  await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  expect(modelCalls).toBe(0);
});
async function mcp(options: Parameters<typeof createMcpServer>[3] = {}) {
  const server = createMcpServer(store, 'unused', runtime, options); servers.push(server);
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const client = new Client({ name: 'reduction-transport-test', version: '1' }); clients.push(client); await client.connect(b);
  return client;
}
async function api(includeRuntime = true, operation = 'reduce') {
  const server = await startServer({ port: 0, store, ...(includeRuntime ? { runtime } : {}) }); http.push(server);
  return (body: unknown) => fetch(server.url + '/api/pool/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

it('HTTP capacity saves both bounds atomically and validates range, version and the new reduction minimum', async () => {
  const post = await api(true, 'capacity'), version = runtime.workers.pool()!.version;
  for (const [minSize, maxSize] of [[0, 2], [2.1, 3], [3, 2], [1, 129]]) {
    expect((await post({ minSize, maxSize, expectedVersion: version })).status).toBe(400);
    expect(runtime.workers.pool()!.version).toBe(version);
  }
  const saved = await post({ minSize: 2, maxSize: 3, expectedVersion: version }); expect(saved.status).toBe(200);
  const pool = await saved.json(); expect(pool).toMatchObject({ minSize: 2, maxSize: 3, size: 2 });
  expect((await post({ minSize: 1, maxSize: 1, expectedVersion: version })).status).toBe(409);
  const reduce = await api(); expect((await reduce({ expectedVersion: pool.version, requestId: 'below-new-min' })).status).toBe(409);
});

it('HTTP reduces once, replays the same request safely, and rejects a stale distinct request', async () => {
  const post = await api(); const version = runtime.workers.pool()!.version;
  const body = { expectedVersion: version, requestId: 'http-reduce-once' };
  const first = await post(body); expect(first.status).toBe(200);
  const accepted = await first.json(); expect(accepted.pool.size).toBe(1); expect(accepted.requestId).toBe(body.requestId);
  const replay = await post(body); expect(replay.status).toBe(200);
  const repeated = await replay.json(); expect(repeated.member.id).toBe(accepted.member.id); expect(repeated.pool.size).toBe(1);
  const stale = await post({ ...body, requestId: 'another-request' }); expect(stale.status).toBe(409);
  expect(runtime.workers.list()).toHaveLength(2); // Retirement must preserve historical identities.
  expect(store.board().tasks).toHaveLength(0); expect(store.board().resources).toHaveLength(0);
});

it('HTTP rejects malformed mutations and reports an unavailable preview without changing capacity', async () => {
  const post = await api();
  expect((await post({ expectedVersion: runtime.workers.pool()!.version })).status).toBe(400);
  expect((await post({ expectedVersion: runtime.workers.pool()!.version, requestId: 'x', memberId: 'chosen-by-client' })).status).toBe(400);
  expect(runtime.workers.pool()!.size).toBe(2);
  const preview = await api(false); expect((await preview({ expectedVersion: 1, requestId: 'x' })).status).toBe(503);
});

it('host MCP exposes versioned reduction while worker and collaborator transports cannot invoke it', async () => {
  const root = await mcp();
  expect((await root.listTools()).tools.map(tool => tool.name)).toContain('pool_reduce');
  expect((await root.listTools()).tools.map(tool => tool.name)).toContain('pool_capacity');
  const pool = runtime.workers.pool()!;
  for (const role of [{ poolMember: true, peers: runtime.workers, workerId: pool.memberIds[0] }, { collaborator: true }]) {
    const bounded = await mcp(role);
    expect((await bounded.listTools()).tools.map(tool => tool.name)).not.toContain('pool_reduce');
    expect((await bounded.listTools()).tools.map(tool => tool.name)).not.toContain('pool_capacity');
    expect((await bounded.callTool({ name: 'pool_capacity', arguments: { minSize: 1, maxSize: 1, expectedVersion: pool.version } })).isError).toBe(true);
    const refused = await bounded.callTool({ name: 'pool_reduce', arguments: { expectedVersion: pool.version, requestId: 'not-authorized' } });
    expect(refused.isError).toBe(true); expect(runtime.workers.pool()!.size).toBe(2);
  }
  const response = await root.callTool({ name: 'pool_reduce', arguments: { expectedVersion: pool.version, requestId: 'host-request' } });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  expect(response.structuredContent).toMatchObject({ requestId: 'host-request', pool: { size: 1 } });
  const capacity = await root.callTool({ name: 'pool_capacity', arguments: { minSize: 1, maxSize: 1, expectedVersion: runtime.workers.pool()!.version } });
  expect(capacity.isError).not.toBe(true); expect(capacity.structuredContent).toMatchObject({ minSize: 1, maxSize: 1, size: 1 });
});

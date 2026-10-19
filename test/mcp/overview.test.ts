// Exercise real MCP identity/stop fences and HTTP authentication for overviews.
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { createMcpServer } from '../../src/mcp.js';
import { startServer } from '../../src/app.js';
import type { EventRuntime } from '../../src/event-runtime.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const source = { workers: [], collaborators: [], owner: { pid: process.pid } };
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

for (const role of ['pool', 'collaborator'] as const) it(`binds ${role} author and rejects stopped reads/writes and identity spoofing`, async () => {
  const store = new Store(); cleanups.push(() => store.close());
  let active = true;
  const server = createMcpServer(store, 'unused', undefined, { [role === 'pool' ? 'poolMember' : 'collaborator']: true,
    workerId: 'bound', mayAct: () => active, overviewSource: () => source });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const client = new Client({ name: 'overview-test', version: '1' }); await client.connect(b);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const initial = (await call(client, 'overview_read')).structuredContent as { facts: { revision: string } };
  const draft = { expectedVersion: 0, factsRevision: initial.facts.revision, preferencesVersion: 0,
    parts: [{ kind: 'text', text: 'Native registrations: ' }, { kind: 'fact', factId: 'native.members' }] };
  expect(await call(client, 'overview_write', { ...draft, agentId: 'spoof' })).toMatchObject({ isError: true });
  expect((await call(client, 'overview_write', draft)).structuredContent).toMatchObject({ status: 'current', record: { authorId: 'bound', version: 1 } });
  active = false;
  expect(await call(client, 'overview_read')).toMatchObject({ isError: true });
  expect(await call(client, 'overview_write', { ...draft, expectedVersion: 1 })).toMatchObject({ isError: true });
  expect(store.readOverviewRecord()?.version).toBe(1);
});

it('fails closed for bounded connections lacking a positive active check', async () => {
  const store = new Store(); cleanups.push(() => store.close());
  const server = createMcpServer(store, 'unused', undefined, { poolMember: true, workerId: 'bound', overviewSource: () => source });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const client = new Client({ name: 'overview-fence', version: '1' }); await client.connect(b);
  cleanups.push(async () => { await client.close(); await server.close(); });
  expect(await call(client, 'overview_read')).toMatchObject({ isError: true });
});

it('retains HTTP auth/origin protections, actor binding and no-notify behavior', async () => {
  const store = new Store(); cleanups.push(() => store.close());
  const runtime = { status: () => source, notify: vi.fn() } as unknown as EventRuntime;
  const http = await startServer({ port: 0, store, runtime, boardToken: 'synthetic-token' }); cleanups.push(() => http.close());
  const read = await fetch(http.url + '/api/overview', { headers: { Authorization: 'Bearer synthetic-token' } });
  const initial = await read.json();
  const draft = { expectedVersion: 0, factsRevision: initial.facts.revision, preferencesVersion: 0,
    agentId: 'spoof', parts: [{ kind: 'fact', factId: 'native.members' }] };
  const request = (extra: Record<string,string> = {}) => fetch(http.url + '/api/overview', { method: 'POST',
    headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(draft) });
  expect((await request({ Authorization: '' })).status).toBe(401);
  expect((await request({ Origin: 'https://untrusted.invalid' })).status).toBe(403);
  const written = await request(); expect(written.status).toBe(200);
  expect(await written.json()).toMatchObject({ record: { authorId: 'human-host', version: 1 } });
  expect((await request()).status).toBe(409); expect(runtime.notify).not.toHaveBeenCalled();
});

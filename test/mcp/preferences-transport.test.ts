// Exercise preferences over real HTTP and MCP boundaries, without models or live board data.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startServer } from '../../src/app.js';
import { createMcpServer } from '../../src/mcp.js';
import { Store } from '../../src/store.js';
import { CollaboratorStore, collaboratorRole } from '../../src/collaborators.js';
import { EventRuntime } from '../../src/event-runtime.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const snapshot = { text: 'Synthetic user preference', source: 'human-input', expectedVersion: 0 };
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const data = (result: Awaited<ReturnType<typeof call>>) => result.structuredContent as Record<string, unknown>;
async function connect(store: Store, options: Parameters<typeof createMcpServer>[3] = {}, runtime?: EventRuntime) {
  const server = createMcpServer(store, 'unused', runtime, options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'preferences-test', version: '1' }); await client.connect(b);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe('preferences transport boundary', () => {
  it('persists host HTTP edits and clear across restart, rejects stale writes and preserves origin/auth gates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'preferences-http-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'board.sqlite');
    let server = await startServer({ port: 0, dbPath: path, boardToken: 'synthetic-board-token' });
    cleanups.push(() => server.close());
    const http = async (method: string, body?: unknown, extra: Record<string, string> = {}) => {
      const response = await fetch(server.url + '/api/preferences', { method,
        headers: { Authorization: 'Bearer synthetic-board-token', 'Content-Type': 'application/json', ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    expect(await http('GET')).toMatchObject({ status: 200, value: { text: '', version: 0, source: null } });
    expect((await http('PATCH', snapshot, { Authorization: '' })).status).toBe(401);
    expect((await http('PATCH', snapshot, { Origin: 'https://untrusted.invalid' })).status).toBe(403);
    expect((await http('PATCH', { ...snapshot, agentId: 'human' })).status).toBe(400);
    expect((await http('PATCH', { ...snapshot, source: 'agent' })).status).toBe(400);
    const first = await http('PATCH', snapshot);
    expect(first).toMatchObject({ status: 200, value: { text: snapshot.text, version: 1, source: 'human-input' } });
    expect((await http('PATCH', snapshot)).status).toBe(409);
    await server.close();
    server = await startServer({ port: 0, dbPath: path, boardToken: 'synthetic-board-token' });
    expect((await http('GET')).value).toEqual(first.value);
    expect(await http('PATCH', { text: '', source: 'main-chat-relay', expectedVersion: 1 })).toMatchObject({ status: 200, value: { text: '', version: 2, source: 'main-chat-relay' } });
    await server.close();
    server = await startServer({ port: 0, dbPath: path, boardToken: 'synthetic-board-token' });
    expect((await http('GET')).value).toMatchObject({ text: '', version: 2 });
    expect((await http('PATCH', { ...snapshot, expectedVersion: 1 })).status).toBe(409);
  });

  for (const role of ['pool', 'collaborator'] as const) it(`gives active ${role} current reads but no human write tool, and removes current data when stopped`, async () => {
    const store = new Store(':memory:'); cleanups.push(() => store.close());
    const host = await connect(store);
    let active = true;
    const options: Parameters<typeof createMcpServer>[3] = role === 'pool' ? { poolMember: true, mayAct: () => active } : { collaborator: true };
    let revoke = () => { active = false; };
    if (role === 'collaborator') {
      const state = new CollaboratorStore(':memory:'); cleanups.push(() => state.close());
      const goal = store.createTask({ title: 'Synthetic admitted goal' });
      const input = { expectedVersion: 0, name: 'Synthetic external', harness: 'dsh', taskIds: [goal.id], enabled: true };
      const admitted = state.configure(input, store).collaborator;
      const boundRole = collaboratorRole(store, state, admitted.id);
      Object.assign(options, { collaboratorId: admitted.id, collaborators: state, workerId: admitted.id, ...boundRole });
      revoke = () => { state.configure({ ...input, id: admitted.id, expectedVersion: 1, enabled: false }, store); };
    }
    const peer = await connect(store, options);
    const tools = (await peer.listTools()).tools.map(tool => tool.name);
    expect(tools).toContain('preferences_read'); expect(tools).not.toContain('preferences_write');
    expect((await call(peer, 'preferences_write', snapshot)).isError).toBe(true);
    expect((await call(host, 'preferences_write', snapshot)).isError).not.toBe(true);
    // Current preference reads are independent of the compact history window.
    const agent = store.registerAgent({ name: 'Synthetic observer' });
    for (let i = 0; i < 105; i++) store.publishEntry({ agentId: agent.id, kind: 'FACT', summary: `Synthetic history ${i}` });
    const first = data(await call(peer, 'preferences_read'));
    expect(first).toMatchObject({ text: snapshot.text, version: 1, source: 'human-input' });
    for (const tool of ['board_read', 'board_open']) expect(data(await call(peer, tool)).preferences).toEqual(first);
    await call(host, 'preferences_write', { text: '', source: 'main-chat-relay', expectedVersion: 1 });
    expect(data(await call(peer, 'preferences_read'))).toMatchObject({ text: '', version: 2 });
    revoke();
    expect((await call(peer, 'preferences_read')).isError).toBe(true);
    for (const tool of ['board_read', 'board_open']) {
      const result = await call(peer, tool);
      expect(result.isError).not.toBe(true); expect(data(result)).not.toHaveProperty('preferences');
      expect(JSON.stringify(result.content)).not.toContain(snapshot.text);
    }
    expect(store.readPreferences()).toMatchObject({ text: '', version: 2 });
  });

  it('fails closed for a bounded connection without an authorization callback while retaining cleanup board reads', async () => {
    const store = new Store(':memory:'); cleanups.push(() => store.close()); store.writePreferences(snapshot);
    const peer = await connect(store, { poolMember: true });
    expect((await call(peer, 'preferences_read')).isError).toBe(true);
    for (const tool of ['board_read', 'board_open']) expect(data(await call(peer, tool))).not.toHaveProperty('preferences');
  });

  it('notifies only after a successful host MCP write and returns the committed current snapshot', async () => {
    const store = new Store(':memory:'); cleanups.push(() => store.close());
    const runtime = new EventRuntime(store, { databasePath: ':memory:', serverEntry: 'unused', managementOnly: true });
    cleanups.push(() => runtime.close()); const notify = vi.spyOn(runtime, 'notify');
    const host = await connect(store, {}, runtime);
    expect(data(await call(host, 'preferences_write', snapshot))).toEqual(store.readPreferences());
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await call(host, 'preferences_write', snapshot)).isError).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

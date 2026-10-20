// Verify independent prompt persistence and trusted transport boundaries using
// synthetic SQLite/MCP data; no model or live board is involved.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { createMcpServer } from '../../src/mcp.js';
import { startServer } from '../../src/app.js';
import { EventRuntime } from '../../src/event-runtime.js';

const close: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
const open = (file = ':memory:') => { const store = new Store(file); close.push(() => store.close()); return store; };
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'user-prompt-')); close.push(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'board.sqlite'); };
const edit = { text: 'Synthetic user instructions', source: 'human-input', expectedVersion: 0 };
async function connect(store: Store, options: Parameters<typeof createMcpServer>[3] = {}, runtime?: EventRuntime) {
  const server = createMcpServer(store, 'unused', runtime, options), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); const client = new Client({ name: 'user-prompt-test', version: '1' }); await client.connect(b);
  close.push(async () => { await client.close(); await server.close(); }); return client;
}
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

it('adds an empty independent prompt when upgrading v10 and preserves system preferences, resources and history', () => {
  const path = file(), old = new Store(path);
  const system = old.writePreferences({ ...edit, text: 'Existing system preferences' });
  const resource = old.createResource({ name: 'Legacy machine', kind: 'machine', accessNotes: 'Original resource notes' });
  const before = old.board();
  old.db.exec('DROP TABLE board_user_prompt; PRAGMA user_version=10;'); old.close();
  const store = open(path);
  expect(store.readPromptSettings()).toEqual({ systemPrompt: system, userPrompt: { boardId: system.boardId, text: '', source: null, version: 0, updatedAt: null } });
  expect(store.board().resources).toEqual([resource]); expect(store.board().entries).toEqual(before.entries);
  expect(store.board().userPrompt).toEqual(store.readUserPrompt()); expect(store.peerBoard().userPrompt).toEqual(store.readUserPrompt());
  expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
});

it('persists independent CAS versions and explicit clears without reviving either old prompt', () => {
  const path = file(), a = open(path), b = open(path), system = a.writePreferences({ ...edit, text: 'Keep system' });
  const first = a.writeUserPrompt(edit); expect(b.readUserPrompt()).toEqual(first);
  expect(() => b.writeUserPrompt({ ...edit, text: 'Stale draft' })).toThrow(/State changed/);
  const cleared = b.writeUserPrompt({ text: '', source: 'main-chat-relay', expectedVersion: 1 });
  expect(cleared).toMatchObject({ text: '', source: 'main-chat-relay', version: 2 });
  expect(a.readPreferences()).toEqual(system);
  a.writePreferences({ text: '', source: 'human-input', expectedVersion: 1 });
  expect(a.readUserPrompt()).toEqual(cleared);
  expect(open(path).readPromptSettings()).toMatchObject({ systemPrompt: { text: '', version: 2 }, userPrompt: cleared });
  expect(() => a.writeUserPrompt({ ...edit, expectedVersion: 1 })).toThrow(/State changed/);
});

it('refuses incompatible schema labels and rolls a conflicting v10 upgrade back without changing prior data', () => {
  const path = file(), store = open(path);
  const system = store.writePreferences({ ...edit, text: 'Retain before upgrade' });
  store.db.exec('PRAGMA user_version=12;');
  expect(() => new Store(path)).toThrow(/newer than/);
  store.db.exec('PRAGMA user_version=10;');
  expect(() => new Store(path)).toThrow(/incompatible prompt schema/);
  store.db.exec('DROP TABLE board_user_prompt; CREATE VIEW board_user_prompt AS SELECT id FROM tasks;');
  expect(() => new Store(path)).toThrow(/already exists/);
  expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 });
  expect(store.readPreferences()).toEqual(system);
});

it('validates human writes and commits only revision metadata with atomic event rollback', () => {
  const store = open(), before = store.board();
  for (const invalid of [{ ...edit, source: 'agent' }, { ...edit, agentId: 'human' }, { ...edit, expectedVersion: -1 }, { ...edit, text: 'x'.repeat(20001) }]) expect(() => store.writeUserPrompt(invalid)).toThrow(/input|source|agentId|expectedVersion|text/);
  expect(store.board()).toEqual(before);
  const first = store.writeUserPrompt(edit), event = store.board().entries.at(-1)!;
  expect(event.agentId).toBe('host-user-prompt'); expect(JSON.parse(event.detail)).toEqual({ signalId: 'BOARD_USER_PROMPT_UPDATED', version: 1, source: 'human-input', cleared: false });
  expect(JSON.stringify(event)).not.toContain(edit.text);
  store.db.exec("CREATE TEMP TRIGGER reject_user_prompt_event BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'event rejected'); END");
  expect(() => store.writeUserPrompt({ ...edit, text: 'Must roll back', expectedVersion: 1 })).toThrow(/event rejected/);
  expect(store.readUserPrompt()).toEqual(first);
});

it('exposes host-only writes and revocable reads on every bounded board path', async () => {
  const store = open(), host = await connect(store); let active = true;
  const runtime = new EventRuntime(store, { databasePath: ':memory:', serverEntry: 'unused', managementOnly: true }); close.push(() => runtime.close());
  const notify = vi.spyOn(runtime, 'notify'), writer = await connect(store, {}, runtime);
  expect((await call(writer, 'user_prompt_write', edit)).isError).not.toBe(true); expect(notify).toHaveBeenCalledTimes(1);
  expect((await call(writer, 'user_prompt_write', edit)).isError).toBe(true); expect(notify).toHaveBeenCalledTimes(1);
  store.writePreferences({ ...edit, text: 'Synthetic system instructions' });
  for (const options of [{ poolMember: true, mayAct: () => active }, { collaborator: true, mayAct: () => active }, { poolMember: true }]) {
    const peer = await connect(store, options), names = (await peer.listTools()).tools.map(t => t.name);
    expect(names).toContain('user_prompt_read'); expect(names).not.toContain('user_prompt_write');
    expect((await call(peer, 'user_prompt_write', { ...edit, expectedVersion: 1 })).isError).toBe(true);
    if (options.mayAct) expect((await call(peer, 'user_prompt_read')).structuredContent).toEqual(store.readUserPrompt());
    active = false;
    expect((await call(peer, 'user_prompt_read')).isError).toBe(true);
    for (const name of ['board_read', 'board_open']) {
      const data = (await call(peer, name)).structuredContent;
      expect(data).not.toHaveProperty('preferences'); expect(data).not.toHaveProperty('userPrompt');
      expect(JSON.stringify(data)).not.toContain(edit.text); expect(JSON.stringify(data)).not.toContain('Synthetic system instructions');
    }
    active = true;
  }
  expect((await call(host, 'preferences_read')).structuredContent).toEqual(store.readPreferences());
});

it('persists and clears through the real HTTP boundary with origin, authentication and CAS gates', async () => {
  const path = file(); let server = await startServer({ port: 0, dbPath: path, boardToken: 'synthetic-token' }); close.push(() => server.close());
  const request = async (method: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(server.url + '/api/user-prompt', { method, headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  expect((await request('GET')).value).toMatchObject({ text: '', version: 0 });
  expect((await request('PATCH', edit, { Authorization: '' })).status).toBe(401);
  expect((await request('PATCH', edit, { Origin: 'https://untrusted.invalid' })).status).toBe(403);
  expect((await request('PATCH', edit)).value).toMatchObject({ text: edit.text, version: 1 });
  expect((await request('PATCH', edit)).status).toBe(409);
  await server.close(); server = await startServer({ port: 0, dbPath: path, boardToken: 'synthetic-token' });
  expect((await request('GET')).value).toMatchObject({ text: edit.text, version: 1 });
  expect((await request('PATCH', { ...edit, text: '', expectedVersion: 1 })).value).toMatchObject({ text: '', version: 2 });
  await server.close(); server = await startServer({ port: 0, dbPath: path, boardToken: 'synthetic-token' });
  expect((await request('GET')).value).toMatchObject({ text: '', version: 2 });
});

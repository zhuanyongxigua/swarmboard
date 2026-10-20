// Reproduce stale overview writes through real bound MCP transports and durable
// SQLite connections when either independently versioned prompt changes.
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { createMcpServer } from '../../src/mcp.js';
import { overviewFacts, readOverview, writeOverview } from '../../src/overview.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const source = { owner: { pid: process.pid }, workers: [], collaborators: [] };
const open = (path = ':memory:') => { const store = new Store(path); cleanup.push(() => store.close()); return store; };
const draft = (expectedVersion = 0) => ({ expectedVersion, factsRevision: overviewFacts(source).revision,
  preferencesVersion: 0, parts: [{ kind: 'text', text: 'Current collaboration' }] });

for (const role of ['pool', 'collaborator'] as const) it(`fences ${role} writes and clears against the user prompt revision without waking decoration events`, async () => {
  const store = open();
  const server = createMcpServer(store, 'unused', undefined, { [role === 'pool' ? 'poolMember' : 'collaborator']: true,
    workerId: 'bound', mayAct: () => true, overviewSource: () => source });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const client = new Client({ name: 'overview-prompts', version: '1' }); await client.connect(b);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const initial = (await call('overview_read')).structuredContent as { facts: { revision: string } };
  const input = (version = 0) => ({ ...draft(version), factsRevision: initial.facts.revision });
  expect((await call('overview_write', input())).isError).not.toBe(true);
  const original = store.readOverviewRecord();
  store.writeUserPrompt({ text: 'Different display instructions', source: 'human-input', expectedVersion: 0 });
  expect((await call('overview_read')).structuredContent).toMatchObject({ status: 'stale', reason: 'USER_PROMPT_CHANGED', record: original });
  for (const stale of [input(1), { ...input(1), userPromptVersion: 0 }, { ...input(1), userPromptVersion: 1, preferencesVersion: 1 }]) {
    expect((await call('overview_write', stale)).isError).toBe(true);
    expect(store.readOverviewRecord()).toEqual(original);
  }
  const cursor = store.board().cursor;
  expect((await call('overview_write', { ...input(1), userPromptVersion: 1 })).structuredContent)
    .toMatchObject({ status: 'current', record: { version: 2, preferencesVersion: 0, userPromptVersion: 1, authorId: 'bound' } });
  expect(store.board().cursor).toBe(cursor);
  store.writeUserPrompt({ text: '', source: 'human-input', expectedVersion: 1 });
  expect((await call('overview_write', { ...input(2), userPromptVersion: 1, parts: [] })).isError).toBe(true);
  expect((await call('overview_read')).structuredContent).toMatchObject({ status: 'stale', reason: 'USER_PROMPT_CHANGED' });
  expect((await call('overview_write', { ...input(2), userPromptVersion: 2, parts: [] })).structuredContent)
    .toMatchObject({ status: 'missing', record: { version: 3, userPromptVersion: 2 } });
});

it('retains legacy records without a fabricated revision and rejects a write prepared before another connection changes the prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overview-prompts-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'board.sqlite'), store = open(path), other = open(path);
  writeOverview(store, draft(), 'bound', source);
  const original = store.readOverviewRecord()!;
  const legacy = { ...original }; delete (legacy as { userPromptVersion?: number }).userPromptVersion;
  store.db.prepare('UPDATE board_overview SET data=? WHERE id=1').run(JSON.stringify(legacy));
  expect(readOverview(other, source)).toMatchObject({ status: 'current', record: legacy });
  const prepared = { ...draft(1), userPromptVersion: 0 };
  other.writeUserPrompt({ text: 'New user instructions', source: 'human-input', expectedVersion: 0 });
  expect(() => writeOverview(store, prepared, 'bound', source)).toThrow(/User prompt changed/);
  expect(() => store.saveOverviewRecord({ ...legacy, userPromptVersion: 0 }, 1)).toThrow(/User prompt changed/);
  expect(store.readOverviewRecord()).toEqual(legacy);
  expect(readOverview(open(path), source)).toMatchObject({ status: 'stale', reason: 'USER_PROMPT_CHANGED', record: legacy });
  expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
});

// Check the real transports retain legacy evidence while user text owns current resources.
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../../src/store.js';
import { startServer } from '../../src/app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish(); });
async function fixture() {
  const store = new Store(':memory:');
  store.registerAgent({ agentId: 'synthetic', name: 'Synthetic member' });
  const resource = store.createResource({ name: 'Historical machine', accessNotes: 'Historical scope only' });
  const usage = store.declareUsage({ agentId: 'synthetic', resourceId: resource.id, purpose: 'Old declared operation' });
  const service = await startServer({ port: 0, store });
  cleanup.push(async () => { await service.close(); store.close(); });
  const client = new Client({ name: 'resource-source-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url + '/mcp')));
  cleanup.push(() => client.close());
  return { store, service, client, resource, usage };
}
it('marks preserved fields as history and never refills an edited or cleared user prompt', async () => {
  const { store, service, client, resource, usage } = await fixture();
  store.writeUserPrompt({ text: 'Human-owned definitions', source: 'human-input', expectedVersion: 0 });
  const first = await client.callTool({ name: 'board_read', arguments: {} });
  expect(first.structuredContent).toMatchObject({ resourceDefinitions: { source: 'userPrompt', legacyFields: ['resources', 'usages'], coordination: 'context_publish' }, userPrompt: { text: 'Human-owned definitions', version: 1 }, resources: [resource], usages: [usage] });
  expect(store.peerBoard().resourceDefinitions).toEqual(store.board().resourceDefinitions);
  store.writeUserPrompt({ text: '', source: 'human-input', expectedVersion: 1 });
  expect(() => store.writeUserPrompt({ text: 'Stale import', source: 'main-chat-relay', expectedVersion: 1 })).toThrow(/version/i);
  for (let i = 0; i < 2; i++) {
    const board = await (await fetch(service.url + '/api/board')).json();
    expect(board.userPrompt).toMatchObject({ text: '', version: 2 });
    expect(board.resources).toEqual([resource]); expect(board.usages).toEqual([usage]);
    expect(board.resourceDefinitions.source).toBe('userPrompt');
  }
});
it('rejects all retired HTTP and MCP writers without changing historical evidence', async () => {
  const { store, service, client, resource, usage } = await fixture();
  const before = store.board();
  const writes = [
    ['resource_create', '/api/resources', 'POST', { name: 'Second source' }],
    ['resource_update', `/api/resources/${resource.id}`, 'PATCH', { id: resource.id, expectedVersion: 1, name: 'Changed history' }],
    ['resource_use', '/api/usages', 'POST', { agentId: 'synthetic', resourceId: resource.id, purpose: 'New legacy operation' }],
    ['resource_usage_update', `/api/usages/${usage.id}`, 'PATCH', { id: usage.id, agentId: 'synthetic', expectedVersion: 1, sharing: 'Changed history' }],
  ] as const;
  for (const [name, path, method, body] of writes) {
    const http = await fetch(service.url + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(http.status).toBe(410);
    expect(await http.json()).toMatchObject({ error: { code: 'LEGACY_RESOURCE_READ_ONLY' } });
    const mcp = await client.callTool({ name, arguments: body });
    expect(mcp.isError).toBe(true); expect(JSON.stringify(mcp.content)).toContain('LEGACY_RESOURCE_READ_ONLY');
  }
  expect(store.board()).toEqual(before);
});
it('keeps ownership and version protection for legacy cleanup and permits new context-based coordination', async () => {
  const { store, client, resource, usage } = await fixture();
  store.registerAgent({ agentId: 'other', name: 'Other member' });
  const wrong = await client.callTool({ name: 'resource_release', arguments: { id: usage.id, agentId: 'other', expectedVersion: 1 } });
  expect(wrong.isError).toBe(true); expect(JSON.stringify(wrong.content)).toContain('NOT_OWNER');
  const released = await client.callTool({ name: 'resource_release', arguments: { id: usage.id, agentId: 'synthetic', expectedVersion: 1 } });
  expect(released.structuredContent).toMatchObject({ active: false, version: 2 });
  const claim = await client.callTool({ name: 'context_publish', arguments: { agentId: 'synthetic', kind: 'CLAIM', summary: 'Synthetic resource scope', detail: 'Read-only logs; coordinate here; no catalog binding required' } });
  expect(claim.isError).not.toBe(true);
  expect(store.board().resources).toEqual([resource]);
  expect(store.board().usages).toHaveLength(1);
});
it('preserves nonempty text and an explicit clear across database reopen despite retained legacy rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'resource-source-reopen-')), path = join(directory, 'board.sqlite');
  let store = new Store(path);
  try {
    const resource = store.createResource({ name: 'Historical definition' });
    store.writeUserPrompt({ text: 'Existing human text', source: 'human-input', expectedVersion: 0 });
    store.close(); store = new Store(path);
    expect(store.readUserPrompt()).toMatchObject({ text: 'Existing human text', version: 1 });
    store.writeUserPrompt({ text: '', source: 'human-input', expectedVersion: 1 });
    const before = store.board();
    store.close(); store = new Store(path);
    expect(store.board()).toEqual(before);
    expect(store.readUserPrompt()).toMatchObject({ text: '', version: 2 });
    expect(store.board().resources).toEqual([resource]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

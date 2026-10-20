// P0-C regression: the MCP surface must be able to complete the member loop
// (register -> pending -> receipt with the entry echo). In-process tests that
// call NotificationService directly cannot catch schema drift.
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { createMcpServer } from '../../src/mcp.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
// These tools answer with a JSON string in the text content (no output schema).
const json = (result: unknown): unknown => {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return JSON.parse(content.find(part => part.type === 'text')?.text ?? 'null');
};

async function harness() {
  const store = new Store();
  const collaborators = new CollaboratorStore(':memory:');
  cleanups.push(() => store.close(), () => collaborators.close());
  const goal = store.createTask({ title: 'Notification goal' });
  const me = collaborators.configure({ expectedVersion: 0, name: 'external', harness: 'anything', sessionRef: 'sess-1', taskIds: [goal.id], enabled: true }, store).collaborator;
  const server = createMcpServer(store, 'unused', undefined, { collaborator: true, collaborators, collaboratorId: me.id });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const client = new Client({ name: 'notify-test', version: '1' }); await client.connect(b);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return { store, me, goal, client };
}

it('completes register -> pending -> receipt through the MCP tools', async () => {
  const { store, me, goal, client } = await harness();
  const registered = await call(client, 'notification_register', {
    id: 'synthetic', version: 1, displayName: 'Synthetic', harness: 'synthetic', enabled: true,
    capabilities: ['durableDelivery', 'receipt'],
    members: [{ memberId: me.id, sessionRef: 'sess-1', taskIds: [goal.id] }],
  });
  expect(registered.isError).toBeFalsy();

  const channels = new NotificationAdapterStore(store.db);
  channels.recordIntent({ adapterId: 'synthetic', memberId: me.id, sequence: 1, entryIds: [10], createdAt: new Date(0).toISOString() });

  const pending = json(await call(client, 'notification_pending', {})) as { items: { sequence: number; entryIds: number[] }[] };
  expect(pending.items).toHaveLength(1);

  // A confirming receipt must carry the echo; the schema accepts it and the
  // service validates it, so the member loop can actually reach `delivered`.
  const stale = await call(client, 'notification_receipt', { sequence: 1, consumed: true });
  expect(stale.isError).toBe(true);
  const confirmed = await call(client, 'notification_receipt', { sequence: 1, consumed: true, entryIds: pending.items[0]!.entryIds });
  expect(confirmed.isError).toBeFalsy();
  expect(json(confirmed)).toMatchObject({ sequence: 1, consumed: true });
  expect(channels.unsettled()).toHaveLength(0);
});

it('refuses a receipt echo that does not match the current batch', async () => {
  const { store, me, goal, client } = await harness();
  await call(client, 'notification_register', {
    id: 'synthetic', version: 1, displayName: 'Synthetic', harness: 'synthetic', enabled: true,
    capabilities: ['durableDelivery', 'receipt'],
    members: [{ memberId: me.id, sessionRef: 'sess-1', taskIds: [goal.id] }],
  });
  const channels = new NotificationAdapterStore(store.db);
  channels.recordIntent({ adapterId: 'synthetic', memberId: me.id, sequence: 1, entryIds: [10], createdAt: new Date(0).toISOString() });
  channels.appendEntries('synthetic', me.id, 1, [11]);
  const mismatch = await call(client, 'notification_receipt', { sequence: 1, consumed: true, entryIds: [10] });
  expect(mismatch.isError).toBe(true);
  // The machine-readable error code stays visible to programmatic consumers.
  expect(String((mismatch.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? '')).toContain('STALE_DELIVERY_VIEW');
  const confirmed = await call(client, 'notification_receipt', { sequence: 1, consumed: true, entryIds: [10, 11] });
  expect(confirmed.isError).toBeFalsy();
});

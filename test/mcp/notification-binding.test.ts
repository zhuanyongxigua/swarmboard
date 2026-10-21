// Exercise current registration reads through the caller-bound MCP schema so
// a host cannot mistake startup configuration for fresh admission authority.
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import { createMcpServer } from '../../src/mcp.js';
import { WorkerStore } from '../../src/worker-store.js';
import { WorkerPool } from '../../src/worker-pool.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const json = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as { text: string }[])[0]!.text);
async function harness(organization = false) {
  const board = new Store(), collaborators = new CollaboratorStore(':memory:'), workers = new WorkerStore(':memory:');
  cleanups.push(() => board.close(), () => collaborators.close(), () => workers.close());
  const goals = [board.createTask({ title: 'One' }), board.createTask({ title: 'Two' })];
  const pool = organization ? new WorkerPool(workers, board, ':memory:').configure({ workspacePath: process.cwd() }) : undefined;
  const me = collaborators.configure({ expectedVersion: 0, name: 'Synthetic', harness: 'arbitrary', sessionRef: 'original',
    taskIds: organization ? [] : goals.map(g => g.id), ...(pool ? { scope: 'organization', poolId: pool.id } : {}), enabled: true }, board, workers).collaborator;
  const adapters = new NotificationAdapterStore(board.db);
  const declaration = { id: 'channel', version: 1, displayName: 'Channel', harness: 'arbitrary', enabled: true,
    capabilities: ['durableDelivery', 'timedReminder', 'receipt'] as const,
    members: [{ memberId: me.id, sessionRef: me.sessionRef, taskIds: goals.map(g => g.id), boardWide: true }] };
  adapters.save(declaration);
  const server = createMcpServer(board, 'unused', undefined, { collaborator: true, collaborators, collaboratorId: me.id, peers: workers });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const client = new Client({ name: 'binding-test', version: '1' }); await client.connect(b);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const read = (args: Record<string, unknown> = { adapterId: 'channel' }) => client.callTool({ name: 'notification_binding_read', arguments: args });
  return { board, collaborators, workers, goals, me, adapters, declaration, client, read, pool };
}

it('returns only the caller binding and reads without changing registrations, history, delivery or admission', async () => {
  const { board, collaborators, adapters, me, read, client } = await harness();
  adapters.recordIntent({ adapterId: 'channel', memberId: me.id, sequence: 1, entryIds: [99], createdAt: new Date(0).toISOString() });
  const before = [board.db.prepare('SELECT total_changes() AS n').get(), collaborators.db.prepare('SELECT total_changes() AS n').get()];
  const first = json(await read());
  expect({ ...first, binding: { ...first.binding, taskIds: [...first.binding.taskIds].sort() } }).toEqual({ binding: {
    adapterId: 'channel', memberId: me.id, sessionRef: 'original', registrationVersion: 1,
    admissionVersion: 1, enabled: true, taskIds: [...me.taskIds].sort(), boardWide: true, capabilities: ['durableDelivery', 'timedReminder', 'receipt'] } });
  expect(json(await read())).toEqual(first);
  expect([board.db.prepare('SELECT total_changes() AS n').get(), collaborators.db.prepare('SELECT total_changes() AS n').get()]).toEqual(before);
  expect((await client.listTools()).tools.find(t => t.name === 'notification_binding_read')?.annotations?.readOnlyHint).toBe(true);
});

it('re-reads registration generation, capabilities, disabled state and admission scope on every call', async () => {
  const { board, collaborators, adapters, declaration, me, goals, read } = await harness();
  expect(json(await read()).binding.registrationVersion).toBe(1);
  collaborators.configure({ id: me.id, expectedVersion: 1, name: me.name, harness: me.harness, sessionRef: me.sessionRef, taskIds: [goals[1]!.id], enabled: true }, board);
  expect(json(await read()).binding).toMatchObject({ registrationVersion: 1, admissionVersion: 2, taskIds: [goals[1]!.id] });
  adapters.save({ ...declaration, version: 2, capabilities: ['receipt'], enabled: false });
  expect(json(await read()).binding).toMatchObject({ registrationVersion: 2, admissionVersion: 2, capabilities: ['receipt'], enabled: false });
});

it('does not reveal foreign registrations and refuses caller-supplied identity fields', async () => {
  const { adapters, declaration, read } = await harness();
  adapters.save({ ...declaration, id: 'foreign', members: [{ memberId: 'someone-else', sessionRef: 'private-session', taskIds: [] }] });
  expect(json(await read({ adapterId: 'foreign' }))).toEqual({ binding: null });
  expect(json(await read({ adapterId: 'missing' }))).toEqual({ binding: null });
  expect((await read({ adapterId: 'channel', memberId: 'someone-else' })).isError).toBe(true);
});

it.each(['session', 'revocation'] as const)('fails closed after current admission %s changes', async change => {
  const { board, collaborators, me, read } = await harness();
  collaborators.configure({ id: me.id, expectedVersion: 1, name: me.name, harness: me.harness,
    sessionRef: change === 'session' ? 'replacement' : me.sessionRef, taskIds: me.taskIds, enabled: change !== 'revocation' }, board);
  expect(json(await read()).binding).toMatchObject({ sessionRef: 'original', admissionVersion: 2, enabled: false });
});

it('uses the current organization scope and stops when its pool stops', async () => {
  const { workers, pool, goals, read } = await harness(true);
  workers.savePool({ ...pool!, taskIds: [goals[0]!.id] });
  expect(json(await read()).binding).toMatchObject({ enabled: true, taskIds: [goals[0]!.id] });
  workers.savePool({ ...pool!, enabled: false });
  expect(json(await read()).binding.enabled).toBe(false);
});

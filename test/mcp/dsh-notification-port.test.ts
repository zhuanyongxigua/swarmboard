// Exercise the host port through the actual bound MCP schema and service,
// so a local transport stub cannot hide receipt or context visibility drift.
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { createMcpServer } from '../../src/mcp.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import { createDshNotificationPort, type DshNotificationBinding, type DshNotificationToolCall } from '../../src/harness/dsh/notification-port.js';
import { driveOnce, type Intent } from '../../src/harness/dsh/notification-driver.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const board = new Store(':memory:');
  const collaborators = new CollaboratorStore(':memory:');
  cleanup.push(() => board.close(), () => collaborators.close());
  const goal = board.createTask({ title: 'Synthetic pending port work' });
  const me = collaborators.configure({ expectedVersion: 0, name: 'Synthetic member', harness: 'synthetic',
    sessionRef: 'original-session', taskIds: [goal.id], enabled: true }, board).collaborator;
  board.registerAgent({ agentId: me.id, name: me.name });
  board.registerAgent({ agentId: 'runtime-port-test', name: 'Synthetic runtime' });
  const server = createMcpServer(board, 'unused', undefined, { collaborator: true, collaborators, collaboratorId: me.id, workerId: me.id,
    sharedUpdates: () => ({ items: [{ summary: 'Reference attachment is not an RPC result' }] }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'synthetic-host-port', version: '1' });
  await client.connect(b);
  cleanup.push(async () => { await client.close(); await server.close(); });
  await client.callTool({ name: 'notification_register', arguments: { id: 'synthetic-channel', version: 1, displayName: 'Synthetic',
    harness: 'synthetic', enabled: true, capabilities: ['durableDelivery', 'receipt', 'timedReminder'],
    members: [{ memberId: me.id, sessionRef: me.sessionRef, taskIds: [goal.id] }] } });
  let binding: DshNotificationBinding = { adapterId: 'synthetic-channel', memberId: me.id, sessionRef: me.sessionRef,
    registrationVersion: 1, taskIds: [goal.id], enabled: true };
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const callTool: DshNotificationToolCall = async request => { calls.push(request); return client.callTool(request); };
  const channels = new NotificationAdapterStore(board.db);
  const entry = (detail = 'Complete event body') => board.publishEntry({ agentId: 'runtime-port-test', kind: 'MESSAGE',
    recipientId: me.id, taskId: goal.id, summary: 'Synthetic work', detail });
  const record = (sequence: number, ids: number[]) => channels.recordIntent({ adapterId: binding.adapterId, memberId: me.id,
    sequence, entryIds: ids, createdAt: new Date(0).toISOString() });
  const port = createDshNotificationPort({ callTool, getCurrentBinding: () => binding, pageSize: 1 });
  return { board, collaborators, me, goal, channels, port, calls, entry, record, callTool,
    get binding() { return binding; }, set binding(value: DshNotificationBinding) { binding = value; } };
}

it('loads full bodies, ignores peer attachments, and confirms exact batches', async () => {
  const f = await fixture();
  const first = f.entry('Full body '.repeat(600));
  f.record(1, [first.id]);
  const batches = await f.port.list();
  expect(batches.map(b => b.delivery.sequence)).toEqual([1]);
  expect(batches[0]!.entries[0]!.detail).toBe(first.detail);
  expect(f.calls.filter(c => c.name === 'notification_pending').map(c => c.arguments.after)).toEqual([0]);
  expect(await f.port.isCurrent(batches[0]!)).toBe(true);
  await f.port.confirm(batches[0]!);
  await f.port.confirm(batches[0]!); // Lost-response retry remains service-idempotent.
  expect(f.channels.unsettled()).toHaveLength(0);
  expect(f.calls.filter(c => c.name === 'notification_receipt').map(c => c.arguments))
    .toEqual(Array.from({ length: 2 }, () => ({ sequence: 1, consumed: true, entryIds: [first.id] })));
});

it('follows bounded pending cursors without dropping a later page', async () => {
  const f = await fixture(); const entries = [f.entry(), f.entry()];
  const afters: unknown[] = [];
  // The current service serializes one unsettled sequence per channel. This
  // synthetic page shape exercises the transport cursor contract independently.
  const port = createDshNotificationPort({ pageSize: 1, getCurrentBinding: () => f.binding, callTool: async request => {
    if (request.name !== 'notification_pending') return f.callTool(request);
    afters.push(request.arguments.after);
    const index = Number(request.arguments.after);
    return { structuredContent: { items: [{ adapterId: f.binding.adapterId, memberId: f.me.id,
      sequence: index + 1, entryIds: [entries[index]!.id], state: 'pending' }], cursor: index + 1, hasMore: index === 0 } };
  } });
  expect((await port.list()).map(batch => batch.entries[0]!.id)).toEqual(entries.map(entry => entry.id));
  expect(afters).toEqual([0, 1]);
});

it('preserves a late merge on stale receipt, reloads it, and never consumes on release', async () => {
  const f = await fixture();
  const first = f.entry(); f.record(1, [first.id]);
  const [batch] = await f.port.list();
  const late = f.entry('Late body');
  f.channels.appendEntries(f.binding.adapterId, f.me.id, 1, [late.id]);
  await expect(f.port.confirm(batch!)).rejects.toThrow(/STALE_DELIVERY_VIEW/);
  for (const reason of ['rejected', 'stale-session', 'stale-delivery-view'] as const) await f.port.release(batch!, reason);
  expect(f.channels.unsettled()[0]).toMatchObject({ state: { state: 'pending' }, intent: { entryIds: [first.id, late.id] } });
  const [current] = await f.port.list();
  expect(current!.entries.map(e => e.id)).toEqual([first.id, late.id]);
  // Driver delta attempts carry a subset of the current batch, not a false new delivery.
  expect(await f.port.isCurrent({ ...current!, delivery: { sequence: 1, entryIds: [late.id] }, entries: [current!.entries[1]!] })).toBe(true);
  expect(f.calls.filter(c => c.name === 'notification_receipt')).toHaveLength(1);
});

it('freezes service unknown before a missing host journal can turn it into a fresh submission', async () => {
  const f = await fixture(); const e = f.entry(); f.record(1, [e.id]);
  f.channels.recordReceipt(f.binding.adapterId, f.me.id, { sequence: 1, consumed: false });
  const before = f.channels.unsettled();
  await expect(f.port.list()).rejects.toThrow(/UNKNOWN_DELIVERY/);
  expect(f.channels.unsettled()).toEqual(before);
  expect(f.calls.some(c => c.name === 'notification_receipt')).toBe(false);
});

it('rejects missing or hidden context instead of settling an incomplete snapshot', async () => {
  const f = await fixture(); const visible = f.entry();
  const outside = f.board.createTask({ title: 'Not admitted' });
  const hidden = f.board.publishEntry({ agentId: 'runtime-port-test', kind: 'MESSAGE', summary: 'Hidden', taskId: outside.id });
  f.record(1, [visible.id, hidden.id]);
  await expect(f.port.list()).rejects.toThrow(/INCOMPLETE_CONTEXT/);
  expect(f.channels.unsettled()).toHaveLength(1);
});

it('fences changed registration, session, disabled binding and scope before submission or receipt', async () => {
  const f = await fixture(); const e = f.entry(); f.record(1, [e.id]);
  const [batch] = await f.port.list(); const original = f.binding;
  for (const patch of [{ registrationVersion: 2 }, { sessionRef: 'other-session' }, { enabled: false }, { taskIds: [] }]) {
    f.binding = { ...original, ...patch };
    expect(await f.port.isCurrent(batch!)).toBe(false);
    await expect(f.port.confirm(batch!)).rejects.toThrow(/STALE_NOTIFICATION_BINDING/);
  }
  expect(f.calls.some(c => c.name === 'notification_receipt')).toBe(false);
});

it('validates every periodic envelope rather than treating a stale check as an ordinary message', async () => {
  const f = await fixture();
  const check = f.board.publishEntry({ agentId: 'runtime-port-test', kind: 'MESSAGE', recipientId: f.me.id,
    summary: 'SESSION_TASK_CHECK: synthetic', detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK', memberId: f.me.id,
      sessionRef: f.me.sessionRef, adapterId: f.binding.adapterId, registrationVersion: 99, dueAt: 300000, goalIds: [f.goal.id] }) });
  f.record(1, [check.id]);
  await expect(f.port.list()).rejects.toThrow(/STALE_NOTIFICATION_BINDING/);
  expect(f.channels.unsettled()).toHaveLength(1);
});

it('drives a complete MCP delivery only after authoritative completion, with serialized binding provenance', async () => {
  const f = await fixture(); const e = f.entry(); f.record(1, [e.id]);
  const records = new Map<string, Intent>();
  const journal = { get: async (key: string) => records.get(key), put: async (intent: Intent) => {
    records.set(intent.key, JSON.parse(JSON.stringify(intent)) as Intent);
  }, del: async (key: string) => { records.delete(key); } };
  let complete = false; let sends = 0;
  const ports = { pending: f.port, journal, session: { isCurrent: f.port.isCurrent, isBusy: async () => false,
    submit: async () => { sends++; return { status: 'enqueued' as const, messageId: 'synthetic-evidence' }; },
    settlement: async () => ({ settled: complete } as { settled: true } | { settled: false }) } };
  await driveOnce(ports);
  expect(f.channels.unsettled()).toHaveLength(1);
  expect(f.calls.some(c => c.name === 'notification_receipt')).toBe(false);
  complete = true;
  await driveOnce(ports);
  expect(sends).toBe(1);
  expect(records.size).toBe(0);
  expect(f.channels.unsettled()).toHaveLength(0);
});

it('rejects a binding change during context awaits and a returned foreign channel', async () => {
  const f = await fixture(); const e = f.entry(); f.record(1, [e.id]);
  const port = createDshNotificationPort({ getCurrentBinding: () => f.binding, callTool: async request => {
    const result = await f.callTool(request);
    if (request.name === 'context_read') f.binding = { ...f.binding, registrationVersion: 2 };
    return result;
  } });
  await expect(port.list()).rejects.toThrow(/STALE_NOTIFICATION_BINDING/);
  const foreign = createDshNotificationPort({ getCurrentBinding: () => f.binding, callTool: async () => ({ structuredContent: {
    items: [{ adapterId: 'other-channel', memberId: f.me.id, sequence: 1, entryIds: [e.id], state: 'pending' }], cursor: 1, hasMore: false,
  } }) });
  await expect(foreign.list()).rejects.toThrow(/AMBIGUOUS_NOTIFICATION_BINDING/);
  expect(f.calls.some(c => c.name === 'notification_receipt')).toBe(false);
});

it('rejects malformed pagination and compact or error responses without acknowledging', async () => {
  const f = await fixture(); const e = f.entry(); f.record(1, [e.id]);
  for (const replacement of [
    { items: [], cursor: 0, hasMore: true },
    { items: [{ adapterId: f.binding.adapterId, memberId: f.me.id, sequence: 1, entryIds: [e.id, e.id], state: 'pending' }], cursor: 1, hasMore: false },
  ]) {
    const port = createDshNotificationPort({ getCurrentBinding: () => f.binding, callTool: async () => ({ structuredContent: replacement }) });
    await expect(port.list()).rejects.toThrow(/INVALID_NOTIFICATION_RESPONSE/);
  }
  const port = createDshNotificationPort({ getCurrentBinding: () => f.binding, callTool: async request => request.name === 'context_read'
    ? { structuredContent: { items: [{ ...e, detailTruncated: true }], cursor: e.id, hasMore: false } }
    : f.callTool(request) });
  await expect(port.list()).rejects.toThrow(/INCOMPLETE_CONTEXT/);
  const denied = createDshNotificationPort({ getCurrentBinding: () => f.binding,
    callTool: async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'COLLABORATOR_STOPPED', message: 'Stopped' } }) }] }) });
  await expect(denied.list()).rejects.toThrow(/COLLABORATOR_STOPPED/);
  expect(f.channels.unsettled()).toHaveLength(1);
});

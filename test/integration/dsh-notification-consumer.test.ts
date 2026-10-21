// Verify the public driver against real durable notification receipts: queue
// acceptance is not completion, and a receipt retry cannot consume a late merge.
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { NotificationService } from '../../src/notification-service.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import { createNotificationDispatcher } from '../../src/notification-dispatch.js';
import { driveOnce, type DeliveryBatch, type Intent, type SubmitOutcome } from '../../src/harness/dsh/notification-driver.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
type Batch = DeliveryBatch & { adapterId: string };
function fixture() {
  const board = new Store(':memory:');
  const collaborators = new CollaboratorStore(':memory:');
  cleanup.push(() => board.close(), () => collaborators.close());
  const goal = board.createTask({ title: 'Synthetic driver work' });
  const member = collaborators.configure({ expectedVersion: 0, name: 'Synthetic driver', harness: 'synthetic',
    sessionRef: 'original-session', taskIds: [goal.id], enabled: true }, board).collaborator;
  board.registerAgent({ agentId: member.id, name: member.name });
  board.registerAgent({ agentId: 'runtime-driver-test', name: 'Synthetic runtime' });
  const service = new NotificationService(board, collaborators);
  service.register(member.id, { id: 'driver-channel', version: 1, displayName: 'Synthetic channel', harness: 'synthetic',
    enabled: true, capabilities: ['durableDelivery', 'receipt'],
    members: [{ memberId: member.id, sessionRef: member.sessionRef, taskIds: [goal.id] }] });
  const dispatcher = createNotificationDispatcher(board, collaborators);
  const entry = board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: member.id,
    summary: 'SESSION_TASK_CHECK: synthetic work', detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK', memberId: member.id,
      sessionRef: member.sessionRef, adapterId: 'driver-channel', registrationVersion: 1, dueAt: 300000, goalIds: [goal.id] }) });
  dispatcher.dispatch(entry);
  const records = new Map<string, Intent>();
  const journal = { get: async (key: string) => records.get(key), put: async (intent: Intent) => { records.set(intent.key, structuredClone(intent)); },
    del: async (key: string) => { records.delete(key); } };
  const pending = {
    list: async (): Promise<Batch[]> => service.pending(member.id).items.map(item => ({ memberId: member.id,
      sessionRef: member.sessionRef, adapterId: item.adapterId,
      check: { memberId: member.id, sessionRef: member.sessionRef, adapterId: item.adapterId, registrationVersion: 1, dueAt: 300000, goalIds: [goal.id] },
      entries: item.entryIds.map(id => board.readEntries({ after: id - 1, limit: 1 }).items[0]!),
      delivery: { sequence: item.sequence, entryIds: [...item.entryIds] } })),
    confirm: async (batch: DeliveryBatch) => { service.receipt(batch.memberId, batch.delivery.sequence, true, batch.delivery.entryIds); },
    release: async (): Promise<void> => { throw new Error('Unexpected release'); },
  };
  let submits = 0;
  const ports = (submit: (batch: DeliveryBatch, text: string) => Promise<SubmitOutcome>) => ({ pending, journal, session: {
    isCurrent: async () => true, isBusy: async () => false, settlement: async () => ({ settled: false as const }),
    submit: async (batch: DeliveryBatch, text: string) => { submits++; return submit(batch, text); },
  } });
  return { board, member, collaborators, service, dispatcher, records, ports, get submits() { return submits; },
    unsettled: () => new NotificationAdapterStore(board.db).unsettled() };
}

describe('DSH driver and durable notification consumption', () => {
  it('does not confirm a delivery from an official queue-acceptance response alone', async () => {
    const f = fixture();
    await driveOnce(f.ports(async () => ({ status: 'enqueued' })));
    expect(f.submits).toBe(1);
    expect(f.unsettled()).toHaveLength(1);
    expect(f.records.size).toBe(1);
  });

  it('never widens a completed delivery snapshot when retrying a receipt after a busy merge', async () => {
    const f = fixture();
    const original = f.service.pending(f.member.id).items[0]!;
    const ports = f.ports(async () => {
      const late = f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: f.member.id,
        summary: 'A later ordinary update', detail: 'This entry was never processed by the original turn.' });
      f.dispatcher.dispatch(late);
      return { status: 'completed', turnId: 'original-turn' };
    });
    const first = await driveOnce(ports);
    expect(first.receiptPending).toHaveLength(1);
    expect(f.unsettled()).toHaveLength(1);
    expect(f.service.pending(f.member.id).items[0]!.entryIds.length).toBeGreaterThan(original.entryIds.length);
    await driveOnce(ports);
    expect(f.submits).toBe(1);
    // The first turn covered only the original snapshot. A fresh pending read
    // cannot authorize the receipt-only retry to settle the appended entry.
    expect(f.unsettled()).toHaveLength(1);
    expect(f.records.size).toBe(1);
  });

  it('processes two checks as one complete delivery and leaves a rejected batch unsettled', async () => {
    const f = fixture();
    let submitted: DeliveryBatch | undefined;
    const ports = f.ports(async batch => { submitted = structuredClone(batch); return { status: 'rejected' }; });
    const first = (await ports.pending.list())[0]!;
    const second = f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: f.member.id,
      summary: 'SESSION_TASK_CHECK: second check in the same batch', detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK',
        memberId: f.member.id, sessionRef: f.member.sessionRef, adapterId: 'driver-channel', registrationVersion: 1,
        dueAt: 600000, goalIds: first.check!.goalIds }) });
    f.dispatcher.dispatch(second);
    const original = f.service.pending(f.member.id).items[0]!;
    expect(original.entryIds).toHaveLength(2);
    ports.pending.release = async () => {};
    await driveOnce(ports);
    expect(f.submits).toBe(1);
    expect(submitted?.entries.map(entry => entry.id)).toEqual(original.entryIds);
    expect(submitted?.delivery.entryIds).toEqual(original.entryIds);
    expect(f.unsettled()).toHaveLength(1);
  });

  it('includes every ordinary entry in the actual prompt before confirming the batch', async () => {
    const f = fixture();
    const late = f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: f.member.id,
      summary: 'Do not lose this peer update', detail: 'Unique ordinary payload in the consumed delivery.' });
    f.dispatcher.dispatch(late);
    let prompt = '';
    const ports = f.ports(async (_batch, text) => { prompt = text; return { status: 'completed', turnId: 'whole-batch-turn' }; });
    await driveOnce(ports);
    expect(prompt).toContain(late.summary);
    expect(prompt).toContain(late.detail);
    expect(f.submits).toBe(1);
    expect(f.unsettled()).toHaveLength(0);
  });

  it('keeps equal local sequence numbers independent across admitted sessions', async () => {
    const f = fixture();
    const otherGoal = f.board.createTask({ title: 'Second consumer scope' });
    const other = f.collaborators.configure({ expectedVersion: 0, name: 'Second consumer', harness: 'synthetic',
      sessionRef: 'second-session', taskIds: [otherGoal.id], enabled: true }, f.board).collaborator;
    f.board.registerAgent({ agentId: other.id, name: other.name });
    f.service.register(other.id, { id: 'other-channel', version: 1, displayName: 'Second channel', harness: 'synthetic',
      enabled: true, capabilities: ['durableDelivery', 'receipt'],
      members: [{ memberId: other.id, sessionRef: other.sessionRef, taskIds: [otherGoal.id] }] });
    const otherEntry = f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: other.id,
      summary: 'Work for the second consumer', detail: 'Independent second delivery.' });
    f.dispatcher.dispatch(otherEntry);
    const item = f.service.pending(other.id).items[0]!;
    const ports = f.ports(async batch => batch.memberId === f.member.id
      ? { status: 'unknown' } : { status: 'completed', turnId: 'second-session-turn' });
    const firstList = await ports.pending.list();
    expect(firstList[0]!.delivery.sequence).toBe(item.sequence);
    ports.pending.list = async () => [...firstList, { adapterId: item.adapterId, memberId: other.id,
      sessionRef: other.sessionRef, delivery: { sequence: item.sequence, entryIds: [...item.entryIds] }, entries: [otherEntry] }];
    await driveOnce(ports);
    expect(f.submits).toBe(2);
    expect(f.service.pending(other.id).items).toHaveLength(0);
    expect(f.service.pending(f.member.id).items).toHaveLength(1);
  });
});

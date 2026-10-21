// Verify the public driver against real durable notification receipts: queue
// acceptance is not completion, and a receipt retry cannot consume a late merge.
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { NotificationService } from '../../src/notification-service.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import { createNotificationDispatcher } from '../../src/notification-dispatch.js';
import { driveOnce, type PendingCheck, type Intent, type SubmitOutcome } from '../../src/harness/dsh/notification-driver.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
type Batch = PendingCheck & { delivery: { sequence: number; entryIds: readonly number[] } };
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
      sessionRef: member.sessionRef, adapterId: item.adapterId, registrationVersion: 1, dueAt: 300000, goalIds: [goal.id],
      delivery: { sequence: item.sequence, entryIds: [...item.entryIds] } })),
    confirm: async (delivery: { sequence: number; entryIds: readonly number[] }) => { service.receipt(member.id, delivery.sequence, true, delivery.entryIds); },
    release: async (): Promise<void> => { throw new Error('Unexpected release'); },
  };
  let submits = 0;
  const ports = (submit: (check: PendingCheck) => Promise<SubmitOutcome>) => ({ pending, journal, session: {
    isCurrent: async () => true, isBusy: async () => false, settlement: async () => ({ settled: false as const }),
    submit: async (check: PendingCheck) => { submits++; return submit(check); },
  } });
  return { board, member, service, dispatcher, records, ports, get submits() { return submits; },
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

  it('does not settle a full delivery after only one of its checks completed', async () => {
    const f = fixture();
    const ports = f.ports(async check => check.dueAt === 300000
      ? { status: 'completed', turnId: 'first-check-turn' } : { status: 'rejected' });
    const first = (await ports.pending.list())[0]!;
    const second = f.board.publishEntry({ agentId: 'runtime-driver-test', kind: 'MESSAGE', recipientId: f.member.id,
      summary: 'SESSION_TASK_CHECK: second check in the same batch', detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK',
        memberId: f.member.id, sessionRef: f.member.sessionRef, adapterId: 'driver-channel', registrationVersion: 1,
        dueAt: 600000, goalIds: first.goalIds }) });
    f.dispatcher.dispatch(second);
    const batch = f.service.pending(f.member.id).items[0]!;
    expect(batch.entryIds).toHaveLength(2);
    // The advertised per-check input can contain two checks sharing one receipt.
    // Completing one must never authorize the other entry's consumption.
    ports.pending.list = async () => [
      { ...first, delivery: { sequence: batch.sequence, entryIds: [...batch.entryIds] } },
      { ...first, dueAt: 600000, delivery: { sequence: batch.sequence, entryIds: [...batch.entryIds] } },
    ];
    ports.pending.release = async () => {};
    await driveOnce(ports);
    expect(f.unsettled()).toHaveLength(1);
  });

});

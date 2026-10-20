// Two dispatch-discipline regressions: a new channel must not receive board
// history, and a failed intent record must not wedge an entry as claimed.
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { createNotificationDispatcher } from '../../src/notification-dispatch.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';

function fixture() {
  const board = new Store(':memory:');
  const collaborators = new CollaboratorStore(':memory:');
  board.registerAgent({ agentId: 'peer', name: 'Peer' });
  const goal = board.createTask({ title: 'Notification goal' });
  const me = collaborators.configure({ expectedVersion: 0, name: 'external', harness: 'anything', sessionRef: 'sess-1', taskIds: [goal.id], enabled: true }, board).collaborator;
  board.registerAgent({ agentId: me.id, name: 'External collaborator' });
  const channels = new NotificationAdapterStore(board.db);
  const dispatcher = createNotificationDispatcher(board, collaborators);
  const register = () => channels.save({ id: 'synthetic', version: 1, displayName: 'Synthetic', harness: 'synthetic', enabled: true, capabilities: ['durableDelivery', 'receipt'], members: [{ memberId: me.id, sessionRef: 'sess-1', taskIds: [goal.id] }] });
  // Directed at this member, otherwise it is a public board event that needs boardWide.
  const message = (text: string) => board.publishEntry({ kind: 'MESSAGE', agentId: 'peer', summary: text, detail: '', recipientId: me.id });
  return { board, me, goal, channels, dispatcher, register, message };
}

describe('per-channel dispatch floor', () => {
  it('does not replay board history to a newly registered channel', () => {
    const f = fixture();
    // History that predates the registration.
    for (let i = 0; i < 3; i++) f.message('old ' + i);
    f.register();
    f.dispatcher.dispatchPending();
    expect(f.channels.unsettled()).toHaveLength(0);
    // Only a new event after the floor is delivered.
    const fresh = f.message('new');
    f.dispatcher.dispatchPending();
    const unsettled = f.channels.unsettled();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]!.intent.entryIds).toEqual([fresh.id]);
  });

  it('releases the claim when the intent cannot be recorded, then delivers after reconciliation', () => {
    const f = fixture();
    f.register();
    // A previous delivery is recorded and then reported as unknown.
    const first = f.message('first');
    f.dispatcher.dispatchPending();
    const seq = f.channels.unsettled()[0]!.intent.sequence;
    expect(f.channels.unsettled()[0]!.intent.entryIds).toEqual([first.id]);
    f.channels.recordReceipt('synthetic', f.me.id, { sequence: seq, consumed: false });
    // A new event cannot be recorded at the frozen sequence: the dispatch fails
    // but must not leave the entry claimed forever.
    const second = f.message('second');
    const resolution = f.dispatcher.dispatch(second);
    expect(resolution.skipped.some(item => item.reason === 'dispatch-failed')).toBe(true);
    // After the operator reconciles the unknown, the same entry is delivered once.
    f.channels.recordAbandoned('synthetic', f.me.id, seq, 'reconciled by operator');
    f.dispatcher.dispatchPending();
    const unsettled = f.channels.unsettled();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]!.intent.entryIds).toEqual([second.id]);
    expect(unsettled[0]!.intent.sequence).toBe(seq + 1);
  });
});

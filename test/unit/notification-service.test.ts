// The member-facing notification API must enforce identity and scope itself:
// a caller can only describe itself, only inside its admitted tasks, and can
// only read or acknowledge its own deliveries.
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { NotificationService } from '../../src/notification-service.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';

function fixture() {
  const board = new Store(':memory:');
  const collaborators = new CollaboratorStore(':memory:');
  const taskA = board.createTask({ title: 'Task A' }).id;
  const taskB = board.createTask({ title: 'Task B' }).id;
  const admit = (name: string, taskIds: string[]) => collaborators.configure(
    { expectedVersion: 0, name, harness: 'anything', sessionRef: 'sess-' + name, taskIds, enabled: true }, board).collaborator;
  const me = admit('me', [taskA]);
  const other = admit('other', [taskA, taskB]);
  return { board, collaborators, service: new NotificationService(board, collaborators), taskA, taskB, me, other };
}

describe('notification service identity and scope', () => {
  it('lets a collaborator register only itself inside its admitted tasks', () => {
    const f = fixture();
    const declaration = (members: { memberId: string; sessionRef: string; taskIds: string[] }[], patch: Record<string, unknown> = {}) => ({
      id: 'chan-' + f.me.id, version: 1, displayName: 'Mine', harness: 'anything', enabled: true,
      capabilities: ['durableDelivery', 'receipt'], members, ...patch,
    });
    const saved = f.service.register(f.me.id, declaration([{ memberId: f.me.id, sessionRef: f.me.sessionRef, taskIds: [f.taskA] }]) as never);
    expect(saved.members[0]?.memberId).toBe(f.me.id);
    // Describing another member, another session, or a task outside admission is refused.
    expect(() => f.service.register(f.me.id, declaration([{ memberId: f.other.id, sessionRef: f.other.sessionRef, taskIds: [f.taskA] }]) as never)).toThrow(/only describe the calling collaborator/);
    expect(() => f.service.register(f.me.id, declaration([{ memberId: f.me.id, sessionRef: 'wrong', taskIds: [f.taskA] }]) as never)).toThrow(/must match the admitted session/);
    expect(() => f.service.register(f.me.id, declaration([{ memberId: f.me.id, sessionRef: f.me.sessionRef, taskIds: [f.taskB] }]) as never)).toThrow(/exceeds admitted tasks/);
  });

  it('refuses unknown or disabled collaborators', () => {
    const f = fixture();
    expect(() => f.service.pending('nobody')).toThrow();
    f.collaborators.configure({ id: f.me.id, expectedVersion: f.me.version, name: 'me', harness: 'anything', sessionRef: f.me.sessionRef, taskIds: [f.taskA], enabled: false }, f.board);
    expect(() => f.service.pending(f.me.id)).toThrow(/admitted collaborator identity/);
  });

  it('reads only the caller own deliveries, incrementally', () => {
    const f = fixture();
    const channels = new NotificationAdapterStore(f.board.db);
    const chan = (id: string, memberId: string, sessionRef: string) => channels.save({ id, version: 1, displayName: id, harness: 'anything', enabled: true, capabilities: ['durableDelivery', 'receipt'], members: [{ memberId, sessionRef, taskIds: [f.taskA] }] });
    chan('chan-me', f.me.id, f.me.sessionRef);
    chan('chan-other', f.other.id, f.other.sessionRef);
    channels.recordIntent({ adapterId: 'chan-me', memberId: f.me.id, sequence: 1, entryIds: [10], createdAt: new Date(0).toISOString() });
    channels.recordIntent({ adapterId: 'chan-other', memberId: f.other.id, sequence: 1, entryIds: [12], createdAt: new Date(0).toISOString() });

    // The sequence fence allows at most one unsettled delivery per member, so
    // pagination here means "resume after the last inspected sequence".
    const first = f.service.pending(f.me.id, 0, 1);
    expect(first.items.map(item => item.sequence)).toEqual([1]);
    expect(first.hasMore).toBe(false);
    expect(f.service.pending(f.me.id, first.cursor).items).toHaveLength(0);
    expect(f.service.pending(f.me.id).items.every(item => item.memberId === f.me.id)).toBe(true);
    // Once the first delivery is confirmed (echoing what it saw), the next one
    // becomes visible.
    f.service.receipt(f.me.id, 1, true, [10]);
    channels.recordIntent({ adapterId: 'chan-me', memberId: f.me.id, sequence: 2, entryIds: [11], createdAt: new Date(0).toISOString() });
    expect(f.service.pending(f.me.id, 1).items.map(item => item.sequence)).toEqual([2]);
  });

  it('accepts a receipt only for the caller own sequence and keeps unknown explicit', () => {
    const f = fixture();
    const channels = new NotificationAdapterStore(f.board.db);
    channels.save({ id: 'chan-me', version: 1, displayName: 'Mine', harness: 'anything', enabled: true, capabilities: ['durableDelivery', 'receipt'], members: [{ memberId: f.me.id, sessionRef: f.me.sessionRef, taskIds: [f.taskA] }] });
    channels.recordIntent({ adapterId: 'chan-me', memberId: f.me.id, sequence: 1, entryIds: [10], createdAt: new Date(0).toISOString() });
    expect(() => f.service.receipt(f.me.id, 2, true)).toThrow(/No unsettled delivery/);
    expect(f.service.receipt(f.me.id, 1, false)).toMatchObject({ sequence: 1, consumed: false });
    expect(f.service.pending(f.me.id).items[0]).toMatchObject({ sequence: 1, state: 'unknown', reason: 'unconfirmed' });
    expect(() => f.service.receipt(f.me.id, 1, true)).toThrow(/must echo the consumed entry ids/);
    expect(() => f.service.receipt(f.me.id, 1, true, [999])).toThrow(/contents changed/);
    expect(f.service.receipt(f.me.id, 1, true, [10])).toMatchObject({ sequence: 1, consumed: true });
    expect(f.service.pending(f.me.id).items).toHaveLength(0);
  });

  it('rejects a confirming receipt whose echo is stale after a busy merge (P1-B)', () => {
    const f = fixture();
    const channels = new NotificationAdapterStore(f.board.db);
    channels.save({ id: 'chan-me', version: 1, displayName: 'Mine', harness: 'anything', enabled: true, capabilities: ['durableDelivery', 'receipt'], members: [{ memberId: f.me.id, sessionRef: f.me.sessionRef, taskIds: [f.taskA] }] });
    channels.recordIntent({ adapterId: 'chan-me', memberId: f.me.id, sequence: 1, entryIds: [10], createdAt: new Date(0).toISOString() });
    // The caller polls [10]...
    const polled = f.service.pending(f.me.id).items[0]!;
    expect(polled.entryIds).toEqual([10]);
    // ...then a busy merge appends entry 11 to the same sequence.
    channels.appendEntries('chan-me', f.me.id, 1, [11]);
    // Confirming only what it saw is refused instead of silently settling 11.
    expect(() => f.service.receipt(f.me.id, 1, true, [10])).toThrow(/contents changed/);
    // Re-polling shows the merged batch, and confirming that closes it.
    expect(f.service.pending(f.me.id).items[0]!.entryIds).toEqual([10, 11]);
    expect(f.service.receipt(f.me.id, 1, true, [10, 11])).toMatchObject({ consumed: true, entryIds: [10, 11] });
  });

  it('rejects malformed paging input', () => {
    const f = fixture();
    expect(() => f.service.pending(f.me.id, -1)).toThrow(/Invalid cursor/);
    expect(() => f.service.pending(f.me.id, 0, 0)).toThrow(/Invalid limit/);
    expect(() => f.service.receipt(f.me.id, 0, true)).toThrow(/Invalid delivery sequence/);
  });

  it('repeats an exact consumed receipt after response loss without rewriting evidence', () => {
    const f = fixture();
    const channels = new NotificationAdapterStore(f.board.db);
    channels.recordIntent({ adapterId: 'channel', memberId: f.me.id, sequence: 1, entryIds: [10], createdAt: new Date(0).toISOString() });
    channels.appendEntries('channel', f.me.id, 1, [11]);
    const first = f.service.receipt(f.me.id, 1, true, [10, 11]);
    const before = f.board.db.prepare('SELECT intent, receipt FROM notification_deliveries').all();
    // A new service instance models a client reconnect after a committed response was lost.
    const reconnected = new NotificationService(f.board, f.collaborators);
    expect(reconnected.receipt(f.me.id, 1, true, [11, 10])).toEqual(first);
    expect(f.board.db.prepare('SELECT intent, receipt FROM notification_deliveries').all()).toEqual(before);
    expect(() => reconnected.receipt(f.me.id, 1, true, [10])).toThrow(/contents changed/);
    expect(() => reconnected.receipt(f.me.id, 1, true)).toThrow(/must echo/);
    expect(() => reconnected.receipt(f.me.id, 1, false)).toThrow(/already confirmed consumed/);
    expect(f.board.db.prepare('SELECT intent, receipt FROM notification_deliveries').all()).toEqual(before);
    expect(channels.nextSequence('channel', f.me.id)).toBe(2);
  });

  it('never treats missing, foreign, abandoned or revoked deliveries as consumed retries', () => {
    const f = fixture();
    const channels = new NotificationAdapterStore(f.board.db);
    const intent = { adapterId: 'channel', memberId: f.me.id, sequence: 1, entryIds: [10], createdAt: new Date(0).toISOString() };
    channels.recordIntent(intent);
    expect(() => f.service.receipt(f.other.id, 1, true, [10])).toThrow(/No unsettled delivery/);
    expect(() => f.service.receipt(f.me.id, 2, true, [10])).toThrow(/No unsettled delivery/);
    channels.recordAbandoned('channel', f.me.id, 1, 'operator reconciliation');
    expect(() => f.service.receipt(f.me.id, 1, true, [10])).toThrow(/No unsettled delivery/);
    channels.recordIntent({ ...intent, sequence: 2 });
    f.service.receipt(f.me.id, 2, true, [10]);
    f.collaborators.configure({ id: f.me.id, expectedVersion: f.me.version, name: 'me', harness: 'anything', sessionRef: f.me.sessionRef, taskIds: [f.taskA], enabled: false }, f.board);
    expect(() => f.service.receipt(f.me.id, 2, true, [10])).toThrow(/admitted collaborator identity/);
  });

  it('refuses an ambiguous sequence shared by two adapters even when their echoes match', () => {
    const f = fixture();
    const channels = new NotificationAdapterStore(f.board.db);
    const intent = { adapterId: 'first', memberId: f.me.id, sequence: 1, entryIds: [10], createdAt: new Date(0).toISOString() };
    channels.recordIntent(intent);
    f.service.receipt(f.me.id, 1, true, [10]);
    channels.recordIntent({ ...intent, adapterId: 'second' });
    const before = f.board.db.prepare('SELECT intent, receipt FROM notification_deliveries ORDER BY adapterId').all();
    expect(() => f.service.receipt(f.me.id, 1, true, [10])).toThrow(/ambiguous across adapters/);
    expect(f.board.db.prepare('SELECT intent, receipt FROM notification_deliveries ORDER BY adapterId').all()).toEqual(before);
  });
});

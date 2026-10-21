// Exercise periodic-check addressing through real durable notification stores;
// a member id alone must never retarget an old check to another session.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, type Entry } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import { NotificationService } from '../../src/notification-service.js';
import { createNotificationDispatcher } from '../../src/notification-dispatch.js';
import { resolveSessionTaskCheckTargets, type NotificationAdapterRegistration } from '../../src/notification-adapters.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(path = ':memory:') {
  const board = new Store(path);
  const collaborators = new CollaboratorStore(':memory:');
  cleanup.push(() => board.close(), () => collaborators.close());
  board.registerAgent({ agentId: 'runtime-synthetic', name: 'Synthetic runtime' });
  const goal = board.createTask({ title: 'Reviewable work' });
  board.updateTask(goal.id, { expectedVersion: goal.version, status: 'in_review' });
  const member = collaborators.configure({ expectedVersion: 0, name: 'External', harness: 'arbitrary', sessionRef: 'session-a', taskIds: [goal.id], enabled: true }, board).collaborator;
  board.registerAgent({ agentId: member.id, name: 'External' });
  const store = new NotificationAdapterStore(board.db);
  const registration: NotificationAdapterRegistration = { id: 'channel-a', version: 1, displayName: 'Arbitrary channel', harness: 'arbitrary', enabled: true, capabilities: ['durableDelivery', 'receipt'], members: [{ memberId: member.id, sessionRef: member.sessionRef, taskIds: [goal.id] }] };
  store.save(registration);
  const dispatcher = createNotificationDispatcher(board, collaborators);
  const check = (patch: Record<string, unknown> = {}, entryPatch: Partial<Entry> = {}) => board.publishEntry({ agentId: 'runtime-synthetic', kind: 'MESSAGE', recipientId: member.id, summary: 'SESSION_TASK_CHECK: inspect current goals', detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK', memberId: member.id, sessionRef: member.sessionRef, adapterId: registration.id, registrationVersion: 1, dueAt: 300000, goalIds: [goal.id], ...patch }), ...entryPatch });
  return { board, collaborators, goal, member, store, registration, dispatcher, check };
}

describe('session task-check notification routing', () => {
  it('isolates malformed declarations before selecting a valid check channel', () => {
    const f = fixture();
    const declarations = [null, f.registration] as unknown as NotificationAdapterRegistration[];
    expect(resolveSessionTaskCheckTargets(f.check(), declarations).targets).toEqual([
      { adapterId: 'channel-a', memberId: f.member.id, sessionRef: 'session-a' },
    ]);
  });

  it('addresses one adapter generation and session, without broadcasting to a second channel', () => {
    const f = fixture();
    f.store.save({ ...f.registration, id: 'channel-b' });
    const e = f.check();
    const result = f.dispatcher.dispatch(e);
    expect(result.targets).toEqual([{ adapterId: 'channel-a', memberId: f.member.id, sessionRef: 'session-a' }]);
    expect(f.store.unsettled().map(x => x.intent.adapterId)).toEqual(['channel-a']);
  });

  it.each([
    ['session replacement', { sessionRef: 'session-b' }],
    ['registration replacement', { registrationVersion: 2 }],
    ['different adapter', { adapterId: 'missing-channel' }],
    ['different member', { memberId: 'another-member' }],
    ['scope mismatch', { goalIds: ['not-admitted'] }],
    ['native-only check', { adapterId: undefined, registrationVersion: undefined }],
    ['missing due identity', { dueAt: undefined }],
  ])('does not fall back to ordinary direct-message routing after %s', (_reason, patch) => {
    const f = fixture(); f.dispatcher.dispatch(f.check(patch));
    expect(f.store.unsettled()).toHaveLength(0);
  });

  it('does not let a legacy summary turn a structured session check into a broadcast', () => {
    const f = fixture();
    f.store.save({ ...f.registration, id: 'channel-b' });
    f.dispatcher.dispatch(f.check({}, { summary: 'IDLE_RECOVERY: historical wording' }));
    expect(f.store.unsettled().map(x => x.intent.adapterId)).toEqual(['channel-a']);
  });

  it('fails closed for a malformed reserved marker rather than broadcasting', () => {
    const f = fixture();
    f.dispatcher.dispatch(f.check({}, { detail: '{', summary: 'SESSION_TASK_CHECK: invalid envelope' }));
    expect(f.store.unsettled()).toHaveLength(0);
  });

  it('rechecks admission session and scope after the entry was published', () => {
    const f = fixture(); const e = f.check();
    f.collaborators.configure({ id: f.member.id, expectedVersion: f.member.version, name: f.member.name, harness: f.member.harness, sessionRef: 'session-b', taskIds: [f.goal.id], enabled: true }, f.board);
    f.dispatcher.dispatch(e);
    expect(f.store.unsettled()).toHaveLength(0);
  });

  it('does not let boardWide bypass a narrowed admission', () => {
    const f = fixture(); const other = f.board.createTask({ title: 'Different authorized scope' });
    f.store.save({ ...f.registration, version: 2, members: [{ ...f.registration.members[0]!, boardWide: true }] });
    const e = f.check({ registrationVersion: 2 });
    f.collaborators.configure({ id: f.member.id, expectedVersion: f.member.version, name: f.member.name, harness: f.member.harness, sessionRef: f.member.sessionRef, taskIds: [other.id], enabled: true }, f.board);
    f.dispatcher.dispatch(e);
    expect(f.store.unsettled()).toHaveLength(0);
  });

  it.each(['blocked', 'done', 'canceled'] as const)('does not record a queued check when its last goal becomes %s', status => {
    const f = fixture(); const e = f.check();
    f.board.updateTask(f.goal.id, { expectedVersion: f.board.readTask(f.goal.id).version, status });
    f.dispatcher.dispatch(e);
    expect(f.store.unsettled()).toHaveLength(0);
  });

  it('deduplicates the same due period even when it is re-published with another entry id', () => {
    const f = fixture(); const first = f.check(); const duplicate = f.check();
    f.dispatcher.dispatch(first);
    f.dispatcher.dispatch(duplicate);
    expect(f.store.unsettled()[0]!.intent.entryIds).toEqual([first.id]);
    f.store.recordReceipt('channel-a', f.member.id, { sequence: 1, consumed: true });
    createNotificationDispatcher(f.board, f.collaborators).dispatch(f.check());
    expect(f.store.unsettled()).toHaveLength(0);
  });

  it('rolls back the period claim on record failure so reconciliation can retry it', () => {
    const f = fixture(); const first = f.check();
    f.dispatcher.dispatch(first);
    f.store.recordReceipt('channel-a', f.member.id, { sequence: 1, consumed: false });
    const next = f.check({ dueAt: 600000 });
    expect(f.dispatcher.dispatch(next).skipped.some(x => x.reason === 'dispatch-failed')).toBe(true);
    f.store.recordAbandoned('channel-a', f.member.id, 1, 'Synthetic operator reconciliation');
    f.dispatcher.dispatch(next);
    expect(f.store.unsettled()[0]!.intent.entryIds).toEqual([next.id]);
  });

  it('never hands an already queued check to a replacement admission session', () => {
    const f = fixture(); f.dispatcher.dispatch(f.check());
    const service = new NotificationService(f.board, f.collaborators);
    expect(service.pending(f.member.id).items).toHaveLength(1);
    f.collaborators.configure({ id: f.member.id, expectedVersion: f.member.version, name: f.member.name, harness: f.member.harness, sessionRef: 'session-b', taskIds: [f.goal.id], enabled: true }, f.board);
    expect(service.pending(f.member.id).items).toHaveLength(0);
    expect(f.store.unsettled()).toHaveLength(1);
  });

  it('keeps old queued evidence after registration replacement without exposing it to the new generation', () => {
    const f = fixture(); f.dispatcher.dispatch(f.check());
    f.store.save({ ...f.registration, version: 2 });
    expect(new NotificationService(f.board, f.collaborators).pending(f.member.id).items).toHaveLength(0);
    expect(f.store.unsettled()).toHaveLength(1);
  });

  it.each(['blocked', 'done', 'canceled'] as const)('rechecks queued check work before pending is read after the goal becomes %s', status => {
    const f = fixture(); f.dispatcher.dispatch(f.check());
    f.board.updateTask(f.goal.id, { expectedVersion: f.board.readTask(f.goal.id).version, status });
    expect(new NotificationService(f.board, f.collaborators).pending(f.member.id).items).toHaveLength(0);
    expect(f.store.unsettled()).toHaveLength(1);
  });

  it('persists due-period deduplication across independent board connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-check-routing-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'board.sqlite'); const f = fixture(path);
    f.dispatcher.dispatch(f.check());
    f.store.recordReceipt('channel-a', f.member.id, { sequence: 1, consumed: true });
    const reopened = new Store(path); cleanup.push(() => reopened.close());
    createNotificationDispatcher(reopened, f.collaborators).dispatch(f.check());
    expect(f.store.unsettled()).toHaveLength(0);
  });

  it('isolates a failed channel and leaves its period retryable', () => {
    const f = fixture();
    f.board.db.exec("CREATE TRIGGER reject_intent BEFORE INSERT ON notification_deliveries WHEN NEW.adapterId='channel-a' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const e = f.check();
    expect(f.dispatcher.dispatch(e).skipped.some(x => x.reason === 'dispatch-failed')).toBe(true);
    expect(f.board.db.prepare('SELECT count(*) AS n FROM notification_session_checks').get()).toEqual({ n: 0 });
    const b = f.collaborators.configure({ expectedVersion: 0, name: 'Other member', harness: 'another-arbitrary', sessionRef: 'session-b', taskIds: [f.goal.id], enabled: true }, f.board).collaborator;
    f.board.registerAgent({ agentId: b.id, name: 'Other member' });
    f.store.save({ ...f.registration, id: 'channel-b', members: [{ memberId: b.id, sessionRef: b.sessionRef, taskIds: [f.goal.id] }] });
    const other = f.check({ adapterId: 'channel-b', memberId: b.id, sessionRef: b.sessionRef }, { recipientId: b.id });
    f.dispatcher.dispatch(other);
    expect(f.store.unsettled()[0]!.intent.entryIds).toEqual([other.id]);
    f.board.db.exec('DROP TRIGGER reject_intent');
    f.dispatcher.dispatch(e);
    expect(f.store.unsettled().find(x => x.intent.adapterId === 'channel-a')!.intent.entryIds).toEqual([e.id]);
  });

  it('rechecks scope for an already queued check without deleting evidence', () => {
    const f = fixture(); f.dispatcher.dispatch(f.check());
    const other = f.board.createTask({ title: 'New admission scope' });
    f.collaborators.configure({ id: f.member.id, expectedVersion: f.member.version, name: f.member.name, harness: f.member.harness, sessionRef: f.member.sessionRef, taskIds: [other.id], enabled: true }, f.board);
    expect(new NotificationService(f.board, f.collaborators).pending(f.member.id).items).toHaveLength(0);
    expect(f.store.unsettled()).toHaveLength(1);
  });

  it('keeps repeated scans idempotent and preserves an unknown delivery unchanged', () => {
    const f = fixture(); const e = f.check();
    f.dispatcher.dispatch(e); f.dispatcher.dispatchPending(); f.dispatcher.dispatch(e);
    expect(f.store.unsettled()).toHaveLength(1);
    expect(f.store.unsettled()[0]!.intent.entryIds).toEqual([e.id]);
    f.store.recordReceipt('channel-a', f.member.id, { sequence: 1, consumed: false });
    const before = f.store.unsettled();
    f.dispatcher.dispatch(f.check({ dueAt: 600000 }));
    expect(f.store.unsettled()).toEqual(before);
  });

  it.each(['session', 'registration', 'disabled', 'scope', 'blocked', 'done', 'canceled'] as const)(
    'rejects a direct receipt after the periodic delivery loses its current %s binding', reason => {
      const f = fixture(); f.dispatcher.dispatch(f.check());
      const service = new NotificationService(f.board, f.collaborators);
      const item = service.pending(f.member.id).items[0]!;
      if (reason === 'registration' || reason === 'disabled') {
        f.store.save({ ...f.registration, version: 2, enabled: reason !== 'disabled' });
      } else if (reason === 'session' || reason === 'scope') {
        const ids = reason === 'scope' ? [f.board.createTask({ title: 'Different scope' }).id] : [f.goal.id];
        f.collaborators.configure({ id: f.member.id, expectedVersion: f.member.version, name: f.member.name,
          harness: f.member.harness, sessionRef: reason === 'session' ? 'replacement-session' : f.member.sessionRef,
          taskIds: ids, enabled: true }, f.board);
      } else {
        f.board.updateTask(f.goal.id, { expectedVersion: f.board.readTask(f.goal.id).version, status: reason });
      }
      expect(service.pending(f.member.id).items).toHaveLength(0);
      const before = f.board.db.prepare('SELECT intent,receipt FROM notification_deliveries').all();
      expect(() => service.receipt(f.member.id, item.sequence, true, item.entryIds)).toThrow();
      expect(f.board.db.prepare('SELECT intent,receipt FROM notification_deliveries').all()).toEqual(before);
    });

  it('preserves an unknown check when a stale session attempts a negative receipt', () => {
    const f = fixture(); f.dispatcher.dispatch(f.check());
    const service = new NotificationService(f.board, f.collaborators);
    const item = service.pending(f.member.id).items[0]!;
    service.receipt(f.member.id, item.sequence, false);
    f.collaborators.configure({ id: f.member.id, expectedVersion: f.member.version, name: f.member.name,
      harness: f.member.harness, sessionRef: 'replacement-session', taskIds: [f.goal.id], enabled: true }, f.board);
    const before = f.board.db.prepare('SELECT intent,receipt FROM notification_deliveries').all();
    expect(() => service.receipt(f.member.id, item.sequence, false)).toThrow();
    expect(f.board.db.prepare('SELECT intent,receipt FROM notification_deliveries').all()).toEqual(before);
  });

  it('retains exact delivered receipt retry semantics after a session replacement', () => {
    const f = fixture(); f.dispatcher.dispatch(f.check());
    const service = new NotificationService(f.board, f.collaborators);
    const item = service.pending(f.member.id).items[0]!;
    const receipt = service.receipt(f.member.id, item.sequence, true, item.entryIds);
    f.collaborators.configure({ id: f.member.id, expectedVersion: f.member.version, name: f.member.name,
      harness: f.member.harness, sessionRef: 'replacement-session', taskIds: [f.goal.id], enabled: true }, f.board);
    const before = f.board.db.prepare('SELECT intent,receipt FROM notification_deliveries').all();
    expect(service.receipt(f.member.id, item.sequence, true, item.entryIds)).toEqual(receipt);
    expect(f.board.db.prepare('SELECT intent,receipt FROM notification_deliveries').all()).toEqual(before);
    expect(() => service.receipt(f.member.id, item.sequence, false)).toThrow(/already confirmed consumed/);
  });
});

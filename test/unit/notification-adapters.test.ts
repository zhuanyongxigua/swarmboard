// Check the notification registration seam without a running core, a harness,
// or a model: pure declarations in, delivery decisions out.
import { describe, expect, it } from 'vitest';
import {
  createNotificationRegistry,
  dedupeEntries,
  reconcileDelivery,
  resolveNotificationTargets,
  type DeliveryIntent,
  type NotificationAdapterRegistration,
} from '../../src/notification-adapters.js';
import type { Entry } from '../../src/store.js';

const entry = (patch: Partial<Entry> = {}): Entry => ({
  id: 1, kind: 'FACT', agentId: 'peer-a', summary: 'Evidence', detail: '', createdAt: new Date(0).toISOString(), ...patch,
});

const synthetic = (patch: Partial<NotificationAdapterRegistration> = {}): NotificationAdapterRegistration => ({
  id: 'synthetic-alpha',
  version: 1,
  displayName: 'Synthetic Alpha',
  harness: 'anything-goes',
  enabled: true,
  capabilities: ['durableDelivery', 'receipt', 'sameSessionContinuation'],
  members: [{ memberId: 'member-1', sessionRef: 'session-1', taskIds: ['goal'] }],
  ...patch,
});

describe('notification adapter registration', () => {
  it('accepts an arbitrary-named adapter without any vendor branch', () => {
    const registry = createNotificationRegistry();
    const registered = registry.register(synthetic());
    expect(registered.id).toBe('synthetic-alpha');
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('synthetic-alpha')?.members[0]?.sessionRef).toBe('session-1');
  });

  it('freezes the declaration so callers cannot widen scope after registration', () => {
    const registry = createNotificationRegistry();
    const registered = registry.register(synthetic());
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.members[0])).toBe(true);
    expect(Object.isFrozen(registered.members[0]?.taskIds)).toBe(true);
  });

  it('rejects duplicate ids, unknown capabilities and memberless declarations', () => {
    const registry = createNotificationRegistry([synthetic()]);
    expect(() => registry.register(synthetic())).toThrow(/Duplicate notification adapter/);
    expect(() => registry.register(synthetic({ id: 'second', capabilities: ['teleport' as never] }))).toThrow(/Unknown notification capability/);
    // Identity alone is not a channel.
    expect(() => registry.register(synthetic({ id: 'third', members: [] }))).toThrow(/at least one member/);
    expect(() => registry.register(synthetic({ id: 'noversion', version: 0 }))).toThrow(/version must be a positive integer/);
    expect(() => registry.register(synthetic({ id: 'fourth', members: [{ memberId: 'm', sessionRef: '', taskIds: [] }] }))).toThrow(/memberId and sessionRef/);
    expect(() => registry.register(synthetic({ id: 'fifth', members: [
      { memberId: 'm', sessionRef: 's', taskIds: [] },
      { memberId: 'm', sessionRef: 's2', taskIds: [] },
    ] }))).toThrow(/Duplicate notification member/);
  });
});

describe('versioned replacement and board-level scope', () => {
  it('replaces a channel only with a strictly newer declaration', () => {
    const registry = createNotificationRegistry([synthetic()]);
    const replaced = registry.replace(synthetic({ version: 2, members: [{ memberId: 'member-1', sessionRef: 'session-1', taskIds: ['goal', 'new-goal'] }] }));
    expect(replaced.version).toBe(2);
    expect(registry.get('synthetic-alpha')?.members[0]?.taskIds).toEqual(['goal', 'new-goal']);
    expect(() => registry.replace(synthetic({ version: 2 }))).toThrow(/must increase version/);
    expect(() => registry.replace(synthetic({ version: 1 }))).toThrow(/must increase version/);
    expect(() => registry.replace(synthetic({ id: 'missing', version: 9 }))).toThrow(/Unknown notification adapter/);
  });

  it('reaches a newly admitted goal only after the scope is re-declared', () => {
    const before = resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'new-goal' }), [synthetic()]);
    expect(before.targets).toHaveLength(0);
    expect(before.skipped[0]?.reason).toBe('out-of-scope');
    const registry = createNotificationRegistry([synthetic()]);
    registry.replace(synthetic({ version: 2, members: [{ memberId: 'member-1', sessionRef: 'session-1', taskIds: ['goal', 'new-goal'] }] }));
    const after = resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'new-goal' }), registry.list());
    expect(after.targets).toHaveLength(1);
  });

  it('delivers board-level actionable events only to boardWide members', () => {
    const announcement = entry({ kind: 'OBSERVED', agentId: 'human', taskId: undefined, detail: '{"status":"in_progress"}' });
    expect(resolveNotificationTargets(announcement, [synthetic()]).targets).toHaveLength(0);
    const wide = synthetic({ members: [{ memberId: 'member-1', sessionRef: 'session-1', taskIds: [], boardWide: true }] });
    const resolution = resolveNotificationTargets(announcement, [wide]);
    expect(resolution.targets).toEqual([{ adapterId: 'synthetic-alpha', memberId: 'member-1', sessionRef: 'session-1' }]);
    // A directed message still reaches a member that is not board-wide.
    expect(resolveNotificationTargets(entry({ kind: 'MESSAGE', recipientId: 'member-1' }), [synthetic()]).targets).toHaveLength(1);
  });

  it('requires durable delivery for ordinary deliveries unless a caller opts out', () => {
    const ephemeral = synthetic({ capabilities: ['receipt'] });
    expect(resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'goal' }), [ephemeral]).skipped[0]?.reason).toBe('no-capability');
    expect(resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'goal' }), [ephemeral], { capability: null }).targets).toHaveLength(1);
    expect(resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'goal' }), [ephemeral], { capability: 'receipt' }).targets).toHaveLength(1);
    // The timed-reminder path is exercised explicitly.
    expect(resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'goal' }), [synthetic()], { capability: 'timedReminder' }).skipped[0]?.reason)
      .toBe('no-capability');
    expect(resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'goal' }), [synthetic({ capabilities: ['durableDelivery', 'timedReminder'] })], { capability: 'timedReminder' }).targets)
      .toHaveLength(1);
  });
});

describe('notification targeting reuses the wake policy', () => {
  it('keeps peer evidence as reference context instead of starting a turn', () => {
    const resolution = resolveNotificationTargets(entry(), [synthetic()]);
    expect(resolution.targets).toHaveLength(0);
    expect(resolution.skipped).toEqual([{ adapterId: 'synthetic-alpha', memberId: null, reason: 'reference-only' }]);
  });

  it('delivers explicit messages and handoffs for subscribed work', () => {
    const message = resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'goal' }), [synthetic()]);
    expect(message.targets).toEqual([{ adapterId: 'synthetic-alpha', memberId: 'member-1', sessionRef: 'session-1' }]);
    const handoff = resolveNotificationTargets(entry({ kind: 'FAIL', taskId: 'goal' }), [synthetic()]);
    expect(handoff.targets).toHaveLength(1);
  });

  it('honours member scope, disabled channels, required capabilities and self-authorship', () => {
    const adapters = [
      synthetic(),
      synthetic({ id: 'disabled-one', enabled: false }),
      synthetic({ id: 'no-receipts', capabilities: ['durableDelivery'] }),
    ];
    const outOfScope = resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'other-goal' }), adapters);
    expect(outOfScope.targets).toHaveLength(0);
    expect(outOfScope.skipped.map(skip => `${skip.adapterId}:${skip.reason}`)).toEqual([
      'synthetic-alpha:out-of-scope',
      'disabled-one:disabled',
      'no-receipts:out-of-scope',
    ]);
    const needsReceipt = resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'goal' }), adapters, { capability: 'receipt' });
    expect(needsReceipt.targets.map(target => target.adapterId)).toEqual(['synthetic-alpha']);
    expect(needsReceipt.skipped).toContainEqual({ adapterId: 'no-receipts', memberId: null, reason: 'no-capability' });
    const selfAuthored = resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'goal', agentId: 'member-1' }), [synthetic()]);
    expect(selfAuthored.targets).toHaveLength(0);
    expect(selfAuthored.skipped[0]?.reason).toBe('self-authored');
  });

  it('does not treat an untargeted board entry as a directed wake', () => {
    const resolution = resolveNotificationTargets(entry({ kind: 'MESSAGE' }), [synthetic()]);
    expect(resolution.targets).toHaveLength(0);
    expect(resolution.skipped[0]?.reason).toBe('out-of-scope');
  });

  it('isolates one malformed channel so healthy channels still get the event', () => {
    const broken = synthetic({ id: 'broken' });
    // Bypass the registry the way a persisted/corrupted record could.
    const corrupted = { ...broken, capabilities: ['nonsense' as never] } as NotificationAdapterRegistration;
    const resolution = resolveNotificationTargets(entry({ kind: 'MESSAGE', taskId: 'goal' }), [corrupted, synthetic()]);
    expect(resolution.skipped).toContainEqual({ adapterId: 'broken', memberId: null, reason: 'invalid-registration' });
    expect(resolution.targets.map(target => target.adapterId)).toEqual(['synthetic-alpha']);
  });
});

describe('durable delivery and unknown handling', () => {
  const intent: DeliveryIntent = { adapterId: 'synthetic-alpha', memberId: 'member-1', sequence: 7, entryIds: [1, 2], createdAt: new Date(0).toISOString() };

  it('only advances on an explicit consumed receipt for that exact sequence', () => {
    expect(reconcileDelivery(intent, null)).toEqual({ state: 'pending', sequence: 7 });
    expect(reconcileDelivery(intent, { sequence: 7, consumed: true })).toEqual({ state: 'delivered', sequence: 7 });
  });

  it('marks unconsumed, stale and ahead-of-intent receipts as unknown instead of replaying', () => {
    expect(reconcileDelivery(intent, { sequence: 7, consumed: false })).toEqual({ state: 'unknown', sequence: 7, reason: 'unconfirmed' });
    expect(reconcileDelivery(intent, { sequence: 6, consumed: true })).toEqual({ state: 'unknown', sequence: 7, reason: 'stale-receipt' });
    expect(reconcileDelivery(intent, { sequence: 8, consumed: true })).toEqual({ state: 'unknown', sequence: 7, reason: 'unconfirmed' });
    // No branch ever reports delivery for an unconfirmed receipt.
    for (const receipt of [{ sequence: 7, consumed: false }, { sequence: 6, consumed: true }, null]) {
      expect(reconcileDelivery(intent, receipt).state).not.toBe('delivered');
    }
  });

  it('dedupes a re-delivered page without dropping order or distinct entries', () => {
    const page = [entry({ id: 3 }), entry({ id: 1 }), entry({ id: 3 }), entry({ id: 2 })];
    expect(dedupeEntries(page).map(item => item.id)).toEqual([3, 1, 2]);
    // A malformed id fails loudly instead of silently dropping evidence.
    expect(() => dedupeEntries([entry({ id: -1 })])).toThrow(/non-negative safe integer/);
  });
});

// Durable registration, intent and receipt behaviour, including a real reopen.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import type { DeliveryIntent, NotificationAdapterRegistration } from '../../src/notification-adapters.js';

const adapter = (patch: Partial<NotificationAdapterRegistration> = {}): NotificationAdapterRegistration => ({
  id: 'synthetic-alpha',
  displayName: 'Synthetic Alpha',
  harness: 'anything-goes',
  enabled: true,
  capabilities: ['durableDelivery', 'receipt', 'timedReminder'],
  members: [{ memberId: 'member-1', sessionRef: 'session-1', taskIds: ['goal'] }],
  ...patch,
});

const intent = (sequence: number, entryIds: number[] = [sequence]): DeliveryIntent => ({
  adapterId: 'synthetic-alpha', memberId: 'member-1', sequence, entryIds, createdAt: new Date(0).toISOString(),
});

describe('durable notification channel state', () => {
  it('persists registrations across a real reopen and rejects invalid declarations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-store-'));
    const path = join(dir, 'board.sqlite');
    try {
      const first = new DatabaseSync(path);
      const store = new NotificationAdapterStore(first);
      store.save(adapter());
      expect(() => store.save(adapter({ id: 'broken', members: [] }))).toThrow(/at least one member/);
      first.close();

      const second = new DatabaseSync(path);
      const reopened = new NotificationAdapterStore(second);
      expect(reopened.list().map(item => item.id)).toEqual(['synthetic-alpha']);
      expect(reopened.list()[0]?.members[0]?.sessionRef).toBe('session-1');
      second.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('records an intent before delivery and is idempotent for the same sequence', () => {
    const store = new NotificationAdapterStore(new DatabaseSync(':memory:'));
    expect(store.recordIntent(intent(1))).toEqual(intent(1));
    expect(store.recordIntent(intent(1))).toEqual(intent(1));
    // A different payload under the same sequence is a lost-track error, not an overwrite.
    expect(() => store.recordIntent(intent(1, [9]))).toThrow(/different entries/);
    expect(store.reconcile('synthetic-alpha', 'member-1').state).toEqual({ state: 'pending', sequence: 1 });
  });

  it('keeps an unconsumed or absent receipt as unknown and never lets it count as delivered', () => {
    const store = new NotificationAdapterStore(new DatabaseSync(':memory:'));
    store.recordIntent(intent(2));
    expect(store.unsettled()).toHaveLength(1);
    store.recordReceipt('synthetic-alpha', 'member-1', { sequence: 2, consumed: false });
    const pending = store.reconcile('synthetic-alpha', 'member-1');
    expect(pending.state).toEqual({ state: 'unknown', sequence: 2, reason: 'unconfirmed' });
    // Still surfaced after restart-equivalent state, and still not delivered.
    expect(store.unsettled()).toHaveLength(1);
    store.recordReceipt('synthetic-alpha', 'member-1', { sequence: 2, consumed: true });
    expect(store.reconcile('synthetic-alpha', 'member-1').state).toEqual({ state: 'delivered', sequence: 2 });
    expect(store.unsettled()).toHaveLength(0);
  });

  it('refuses a receipt that has no recorded intent', () => {
    const store = new NotificationAdapterStore(new DatabaseSync(':memory:'));
    expect(() => store.recordReceipt('synthetic-alpha', 'member-1', { sequence: 5, consumed: true })).toThrow(/without a recorded intent/);
  });

  it('surfaces unsettled deliveries after reopen so an unknown cannot be silently dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-store-'));
    const path = join(dir, 'board.sqlite');
    try {
      const first = new DatabaseSync(path);
      const store = new NotificationAdapterStore(first);
      store.save(adapter());
      store.recordIntent(intent(3));
      store.recordReceipt('synthetic-alpha', 'member-1', { sequence: 3, consumed: false });
      first.close();

      const second = new DatabaseSync(path);
      const reopened = new NotificationAdapterStore(second);
      const unsettled = reopened.unsettled('synthetic-alpha');
      expect(unsettled.map(item => [item.intent.sequence, item.state.state])).toEqual([[3, 'unknown']]);
      second.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SeatCheckStore } from '../../src/seat-check-store.js';
import { CHECK_INTERVAL_MS, type SeatRecord } from '../../src/seat-checks.js';

const record = (memberId: string, over: Partial<SeatRecord> = {}): SeatRecord => ({
  memberId, sessionRef: 'session-' + memberId, nextDueAt: 5_000, lastCheckAt: null,
  pendingMerged: false, checks: 0, state: 'waiting', ...over,
});

describe('seat check store', () => {
  it('round-trips one row per seat and replaces on save', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SeatCheckStore(db);
    store.save([record('a'), record('b', { pendingMerged: true })]);
    expect([...store.list().keys()].sort()).toEqual(['a|session-a', 'b|session-b']);
    store.save([record('a', { checks: 2, nextDueAt: 9_000 })]);
    expect(store.list().get('a|session-a')?.checks).toBe(2);
    expect(store.list().get('b|session-b')?.pendingMerged).toBe(true);
    db.close();
  });

  it('survives reopen (restart) and keeps the merged flag', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SeatCheckStore(db);
    store.save([record('a', { pendingMerged: true, nextDueAt: CHECK_INTERVAL_MS })]);
    const again = new SeatCheckStore(db);
    const restored = again.list().get('a|session-a')!;
    expect(restored.pendingMerged).toBe(true);
    expect(restored.nextDueAt).toBe(CHECK_INTERVAL_MS);
    db.close();
  });

  it('clears a pending entry only after a matching confirmation', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SeatCheckStore(db);
    store.save([record('a', { pending: { dueAt: 5_000, goalIds: ['g1'] } })]);
    store.confirmPending({ memberId: 'a', sessionRef: 'session-a', dueAt: 4_000 });   // stale due
    expect(store.list().get('a|session-a')?.pending).toBeDefined();
    store.confirmPending({ memberId: 'a', sessionRef: 'session-a', dueAt: 5_000 });
    expect(store.list().get('a|session-a')?.pending).toBeUndefined();
    db.close();
  });

  it('removes a retired seat so it cannot resume silently', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SeatCheckStore(db);
    store.save([record('a'), record('b')]);
    store.remove({ memberId: 'a', sessionRef: 'session-a' });
    expect([...store.list().keys()]).toEqual(['b|session-b']);
    db.close();
  });
});

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SeatCheckStore } from '../../src/seat-check-store.js';
import { pendingWakes } from '../../src/seat-checks.js';
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

  it('survives a damaged row instead of failing every read', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SeatCheckStore(db);
    store.save([record('a')]);
    // Something else (or a damaged file) wrote a row this reader cannot use.
    db.prepare('INSERT INTO seat_checks(seatKey,data) VALUES(?,?)').run('bad|session-b', '{not json');
    db.prepare('INSERT INTO seat_checks(seatKey,data) VALUES(?,?)').run('bad2|session-c2', JSON.stringify({ hello: 'world' }));
    const listed = store.list();                       // must not throw
    expect([...listed.keys()]).toEqual(['a|session-a']);
    expect([...store.corruptKeys()].sort()).toEqual(['bad2|session-c2', 'bad|session-b']);
    // The damaged rows are kept for diagnosis and still do not poison later reads.
    expect(store.list().size).toBe(1);
    db.close();
  });

  it('rejects a row whose pending outbox entry is not usable (p8 7261)', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SeatCheckStore(db);
    store.save([record('a')]);
    const good = { memberId: 'b', sessionRef: 'session-b', nextDueAt: 4_000, lastCheckAt: 1_000,
      pendingMerged: false, checks: 1, state: 'waiting' };
    const bad = [
      ['noop|s', { ...good, memberId: 'noop', sessionRef: 's', pending: { dueAt: 4_000, goalIds: null } }],
      ['empty|s', { ...good, memberId: 'empty', sessionRef: 's', pending: { dueAt: 4_000, goalIds: [] } }],
      ['badgoal|s', { ...good, memberId: 'badgoal', sessionRef: 's', pending: { dueAt: 4_000, goalIds: [1] } }],
      ['badDue|s', { ...good, memberId: 'badDue', sessionRef: 's', pending: { dueAt: -1, goalIds: ['g'] } }],
      ['badShape|s', { ...good, memberId: 'badShape', sessionRef: 's', pending: 'nope' }],
      ['badVer|s', { ...good, memberId: 'badVer', sessionRef: 's', pending: { dueAt: 1, goalIds: ['g'], registrationVersion: 0 } }],
      ['mismatch|other', { ...good, memberId: 'mismatch', sessionRef: 's' }],   // key does not match identity
    ] as const;
    for (const [key, value] of bad) db.prepare('INSERT INTO seat_checks(seatKey,data) VALUES(?,?)').run(key, JSON.stringify(value));
    const listed = store.list();                        // must not throw and must not leak them
    expect([...listed.keys()]).toEqual(['a|session-a']);
    expect(store.corruptKeys()).toHaveLength(bad.length);
    // pendingWakes is what actually throws downstream in the runtime; it must stay safe here.
    expect(() => pendingWakes(listed)).not.toThrow();
    db.close();
  });

  it('refuses to write inside an open transaction, where the schedule would not be durable', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SeatCheckStore(db);
    db.exec('BEGIN');
    expect(() => store.save([record('a')])).toThrow(/idle connection/);
    db.exec('ROLLBACK');
    // After the rollback the store is usable again.
    store.save([record('a')]);
    expect(store.list().size).toBe(1);
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

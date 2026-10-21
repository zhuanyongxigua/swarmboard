// Verify that the durable outbox reader cannot pass damaged payloads into the shared scan.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { SeatCheckStore } from '../../src/seat-check-store.js';
import { pendingWakes, type SeatRecord } from '../../src/seat-checks.js';

it('isolates a damaged pending goal list before the runtime filters wakes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SeatCheckStore(db);
    const good: SeatRecord = { memberId: 'good', sessionRef: 'session-good', nextDueAt: 5000,
      lastCheckAt: null, checks: 0, state: 'waiting', pendingMerged: false,
      pending: { dueAt: 4000, goalIds: ['goal-1'] } };
    store.save([good]);
    const bad = JSON.stringify({ ...good, memberId: 'bad', sessionRef: 'session-bad',
      pending: { dueAt: 4000, goalIds: null } });
    db.prepare('INSERT INTO seat_checks(seatKey,data) VALUES(?,?)').run('bad|session-bad', bad);
    const records = store.list();
    // This is the same goal-list operation performed by EventRuntime.runSeatChecks.
    expect(() => pendingWakes(records).map(wake => wake.goalIds.filter(id => id === 'goal-1'))).not.toThrow();
    expect([...records.keys()]).toEqual(['good|session-good']);
    expect(store.corruptKeys()).toEqual(['bad|session-bad']);
    expect(db.prepare('SELECT data FROM seat_checks WHERE seatKey=?').get('bad|session-bad')?.data).toBe(bad);
  } finally { db.close(); }
});

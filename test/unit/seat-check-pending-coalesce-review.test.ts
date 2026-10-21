import { expect, it } from 'vitest';
import { CHECK_INTERVAL_MS, pendingWakes, seatKey, tick, type SeatRecord } from '../../src/seat-checks.js';

it('replays one old due without suppressing another seat or replacing its pending snapshot', () => {
  const interval = CHECK_INTERVAL_MS;
  const seats = ['a', 'b'].map(memberId => ({ memberId, sessionRef: `session-${memberId}`, active: true, busy: false }));
  const goals = [{ id: 'goal', status: 'in_review' }];
  const map = (records: SeatRecord[]) => new Map(records.map(record => [seatKey(record), record]));
  const anchored = tick({ now: 0, organizationActive: true, seats, goals, records: new Map() });
  const first = tick({ now: interval, organizationActive: true, seats, goals, records: map(anchored.records) });
  const records = map(first.records);
  const owed = records.get(seatKey(seats[0]!))!;
  records.set(seatKey(seats[1]!), { ...records.get(seatKey(seats[1]!))!, pending: undefined });
  const snapshot = structuredClone(owed);
  const retry = tick({ now: 4 * interval, organizationActive: true, seats, goals, records });
  // This is the runtime's order: recover owed checks, then append newly due checks.
  const wakes = [...pendingWakes(records), ...retry.wake];
  expect(wakes.filter(wake => wake.memberId === 'a')).toEqual([{
    memberId: 'a', sessionRef: 'session-a', dueAt: interval, goalIds: ['goal'],
  }]);
  expect(retry.wake.map(wake => wake.memberId)).toEqual(['b']);
  expect(retry.records.some(record => record.memberId === 'a')).toBe(false);
  expect(owed).toEqual(snapshot);
  records.set(seatKey(seats[0]!), { ...owed, pending: undefined });
  const resumed = tick({ now: 5 * interval, organizationActive: true, seats: [seats[0]!], goals, records });
  expect(resumed.wake).toHaveLength(1);
});

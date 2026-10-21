// Controlled-clock tests for the per-session five-minute check state machine.
// No real timers, no processes, no model.
import { describe, expect, it } from 'vitest';
import { tick, pendingWakes, CHECK_INTERVAL_MS, applicableGoals, type SeatRecord, type SeatSnapshot } from '../../src/seat-checks.js';

const seat = (memberId: string, over: Partial<SeatSnapshot> = {}): SeatSnapshot =>
  ({ memberId, sessionRef: 'session-' + memberId, active: true, busy: false, ...over });
const goal = (id: string, status: string) => ({ id, status });
const merge = (records: SeatRecord[]) => new Map(records.map(r => [`${r.memberId}|${r.sessionRef}`, r]));

describe('per-session five-minute checks', () => {
  it('wakes each active seat independently of the others being busy', () => {
    const t0 = 1_000_000;
    const first = tick({ now: t0, organizationActive: true, goals: [goal('g1', 'todo')], records: new Map(),
      seats: [seat('a'), seat('b', { busy: true })] });
    expect(first.wake.map(w => w.memberId)).toEqual([]);  // nothing due yet
    const later = t0 + CHECK_INTERVAL_MS;
    const second = tick({ now: later, organizationActive: true, goals: [goal('g1', 'todo')],
      records: merge(first.records), seats: [seat('a'), seat('b', { busy: true })] });
    // a is awake; b is busy so it merges instead — one seat never blocks another.
    expect(second.wake.map(w => w.memberId)).toEqual(['a']);
    expect(second.records.find(r => r.memberId === 'b')?.pendingMerged).toBe(true);
  });

  it('merges repeated due checks for a busy seat into exactly one wakeup', () => {
    const t0 = 1_000_000;
    const busy = [seat('b', { busy: true })];
    let records = new Map<string, SeatRecord>();
    for (const offset of [0, CHECK_INTERVAL_MS, 2 * CHECK_INTERVAL_MS, 3 * CHECK_INTERVAL_MS]) {
      const r = tick({ now: t0 + offset, organizationActive: true, goals: [goal('g1', 'in_progress')], records, seats: busy });
      records = merge([...records.values(), ...r.records]);
      expect(r.wake).toEqual([]);
    }
    const state = [...records.values()][0]!;
    expect(state.pendingMerged).toBe(true);
    expect(state.checks).toBe(0);   // no wakeup was spent while busy
    const idle = tick({ now: t0 + 3 * CHECK_INTERVAL_MS + 1, organizationActive: true, goals: [goal('g1', 'in_progress')], records, seats: [seat('b')] });
    expect(idle.wake).toHaveLength(1);           // exactly one merged wakeup
    expect(idle.records[0]!.pendingMerged).toBe(false);
  });

  it('keeps repeating past two checks (no attempt budget)', () => {
    const t0 = 1_000_000;
    let records = new Map<string, SeatRecord>();
    let wakes = 0;
    for (let i = 1; i <= 5; i++) {
      const r = tick({ now: t0 + i * CHECK_INTERVAL_MS, organizationActive: true,
        goals: [goal('g1', 'in_review')], records, seats: [seat('a')] });
      records = merge([...records.values(), ...r.records]);
      wakes += r.wake.length;
      if (i >= 2) expect(r.wake).toHaveLength(1);
    }
    expect(wakes).toBe(4);   // checks 2..5 fired; no cap at 2
  });

  it('treats in_review as applicable and blocked/done/canceled as not', () => {
    expect(applicableGoals([goal('a', 'todo'), goal('b', 'in_progress'), goal('c', 'in_review'),
      goal('d', 'blocked'), goal('e', 'done'), goal('f', 'canceled')]).map(g => g.id)).toEqual(['a', 'b', 'c']);
  });

  it('spends no wakeup when only blocked or terminal goals remain', () => {
    const t0 = 1_000_000;
    const r = tick({ now: t0 + 10 * CHECK_INTERVAL_MS, organizationActive: true,
      goals: [goal('x', 'blocked'), goal('y', 'done')], records: new Map(), seats: [seat('a')] });
    expect(r.wake).toEqual([]);
    expect(r.idle).toBe(true);
  });

  it('stops a paused seat and does not accumulate its due time', () => {
    const t0 = 1_000_000;
    const r = tick({ now: t0 + 10 * CHECK_INTERVAL_MS, organizationActive: true,
      goals: [goal('g1', 'todo')], records: new Map(), seats: [seat('a', { active: false })] });
    expect(r.wake).toEqual([]);
    expect(r.records[0]!.state).toBe('stopped');
  });

  it('does not wake anyone while the organization is inactive', () => {
    const t0 = 1_000_000;
    const r = tick({ now: t0 + 10 * CHECK_INTERVAL_MS, organizationActive: false,
      goals: [goal('g1', 'todo')], records: new Map(), seats: [seat('a')] });
    expect(r.wake).toEqual([]);
    expect(r.idle).toBe(false);
  });

  it('carries an idempotency key and the registration generation in the wakeup', () => {
    const t0 = 1_000_000;
    const first = tick({ now: t0, organizationActive: true, goals: [goal('g1', 'todo')], records: new Map(),
      seats: [seat('a', { adapterId: 'adapter-x', registrationVersion: 7 })] });
    const later = tick({ now: t0 + CHECK_INTERVAL_MS, organizationActive: true, goals: [goal('g1', 'todo')],
      records: merge(first.records), seats: [seat('a', { adapterId: 'adapter-x', registrationVersion: 7 })] });
    expect(later.wake).toHaveLength(1);
    expect(later.wake[0]).toMatchObject({ memberId: 'a', sessionRef: 'session-a', dueAt: t0 + CHECK_INTERVAL_MS,
      adapterId: 'adapter-x', registrationVersion: 7 });
  });

  it('ticking twice at the same instant emits one wakeup once records persist', () => {
    const t0 = 1_000_000;
    const first = tick({ now: t0, organizationActive: true, goals: [goal('g1', 'todo')], records: new Map(), seats: [seat('a')] });
    const persisted = merge(first.records);
    const dueTick = tick({ now: t0 + CHECK_INTERVAL_MS, organizationActive: true, goals: [goal('g1', 'todo')], records: persisted, seats: [seat('a')] });
    expect(dueTick.wake).toHaveLength(1);
    const again = tick({ now: t0 + CHECK_INTERVAL_MS, organizationActive: true, goals: [goal('g1', 'todo')],
      records: merge([...persisted.values(), ...dueTick.records]), seats: [seat('a')] });
    expect(again.wake).toHaveLength(0);   // same dueAt is not emitted twice
  });

  it('re-anchors while nothing applies, so a reappearing goal waits at most one interval', () => {
    const t0 = 1_000_000;
    const quiet = tick({ now: t0, organizationActive: true, goals: [goal('x', 'blocked')], records: new Map(), seats: [seat('a')] });
    let records = merge(quiet.records);
    for (let i = 1; i <= 3; i++) {
      const r = tick({ now: t0 + i * CHECK_INTERVAL_MS, organizationActive: true, goals: [goal('x', 'blocked')], records, seats: [seat('a')] });
      records = merge([...records.values(), ...r.records]);
      expect(r.wake).toEqual([]);
    }
    const back = tick({ now: t0 + 3 * CHECK_INTERVAL_MS + 1000, organizationActive: true, goals: [goal('g1', 'todo')], records, seats: [seat('a')] });
    expect(back.wake).toEqual([]);                                  // not immediately
    const nextInterval = tick({ now: t0 + 4 * CHECK_INTERVAL_MS, organizationActive: true, goals: [goal('g1', 'todo')],
      records: merge([...records.values(), ...back.records]), seats: [seat('a')] });
    expect(nextInterval.wake).toHaveLength(1);                      // at most one interval later
  });

  it('returns one record per seat even when the baseline and a later write coincide', () => {
    const t0 = 1_000_000;
    const r = tick({ now: t0 + CHECK_INTERVAL_MS, organizationActive: true, goals: [goal('g1', 'todo')],
      records: new Map(), seats: [seat('a')] });
    expect(r.records).toHaveLength(1);
    expect(new Set(r.records.map(x => `${x.memberId}|${x.sessionRef}`)).size).toBe(r.records.length);
  });

  it('keeps a durable pending entry so a crash before publish is not lost', () => {
    const t0 = 1_000_000;
    const first = tick({ now: t0, organizationActive: true, goals: [goal('g1', 'todo')], records: new Map(), seats: [seat('a')] });
    const dueTick = tick({ now: t0 + CHECK_INTERVAL_MS, organizationActive: true, goals: [goal('g1', 'todo')],
      records: merge(first.records), seats: [seat('a')] });
    // The fired check leaves a pending outbox entry in the persisted record.
    const fired = dueTick.records[0]!;
    expect(fired.pending).toMatchObject({ dueAt: t0 + CHECK_INTERVAL_MS, goalIds: ['g1'] });
    // Simulate a crash before publishing: restart sees the same due as owed.
    const afterCrash = merge(dueTick.records);
    expect(pendingWakes(afterCrash)).toHaveLength(1);
    expect(pendingWakes(afterCrash)[0]!.dueAt).toBe(t0 + CHECK_INTERVAL_MS);
    // A second tick at the same instant does not invent a new check; the owed one is re-published.
    const rescan = tick({ now: t0 + CHECK_INTERVAL_MS + 1, organizationActive: true, goals: [goal('g1', 'todo')],
      records: afterCrash, seats: [seat('a')] });
    expect(rescan.wake).toEqual([]);
  });

  it('never hands a seat goal ids outside its authorized task scope', () => {
    const t0 = 1_000_000;
    const goals = [goal('mine', 'todo'), goal('foreign', 'todo')];
    const first = tick({ now: t0, organizationActive: true, goals, records: new Map(),
      seats: [{ ...seat('a'), taskIds: ['mine'] }] });
    const due = tick({ now: t0 + CHECK_INTERVAL_MS, organizationActive: true, goals,
      records: merge(first.records), seats: [{ ...seat('a'), taskIds: ['mine'] }] });
    expect(due.wake).toHaveLength(1);
    expect(due.wake[0]!.goalIds).toEqual(['mine']);      // no foreign id leaks in
    // A seat whose scope has nothing applicable is not woken at all.
    const idleSeat = tick({ now: t0 + CHECK_INTERVAL_MS, organizationActive: true, goals,
      records: new Map(), seats: [{ ...seat('b'), taskIds: ['other'] }] });
    expect(idleSeat.wake).toEqual([]);
  });

  it('never wakes an inactive seat even when its session label is a placeholder', () => {
    // 608 7092: a native seat without a thread is inactive, so no wake (and therefore
    // no published check) can carry the `worker:<id>` placeholder session label.
    const t0 = 1_000_000;
    const r = tick({ now: t0 + 10 * CHECK_INTERVAL_MS, organizationActive: true, goals: [goal('g1', 'todo')],
      records: new Map(), seats: [{ ...seat('a'), sessionRef: 'worker:a', active: false }] });
    expect(r.wake).toEqual([]);
    expect(r.records[0]!.state).toBe('stopped');
  });

  it('restart replays at most one overdue check per seat', () => {
    const t0 = 1_000_000;
    // persisted record from long ago, now far overdue
    const stale: SeatRecord[] = [{ memberId: 'a', sessionRef: 'session-a', nextDueAt: t0, lastCheckAt: null,
      pendingMerged: false, checks: 3, state: 'waiting' }];
    const r = tick({ now: t0 + 20 * CHECK_INTERVAL_MS, organizationActive: true,
      goals: [goal('g1', 'todo')], records: merge(stale), seats: [seat('a')] });
    expect(r.wake).toHaveLength(1);
    expect(r.records[0]!.checks).toBe(4);
    expect(r.records[0]!.nextDueAt).toBe(t0 + 20 * CHECK_INTERVAL_MS + CHECK_INTERVAL_MS);
  });
});

// Per-session five-minute task checks (human plan 2026-10-21).
//
// Every enabled, actually-connected session gets its own independent due time.
// A seat never waits for other seats to be idle, and never gets two overlapping
// wakeups: while it is busy a due check is merged into exactly one pending check.
// This module is pure: the caller supplies the clock, the seat snapshot and the
// goal list, and receives decisions. Persistence and publishing stay outside.
export type SeatState = 'waiting' | 'due' | 'merged' | 'paused' | 'stopped';

export interface SeatRecord {
  memberId: string;
  sessionRef: string;
  nextDueAt: number;
  lastCheckAt: number | null;
  /** True when a check came due while the seat was busy and has not fired yet. */
  pendingMerged: boolean;
  /** Observability only. Never used as a cap or as a stop condition. */
  checks: number;
  state: SeatState;
}

export interface SeatSnapshot {
  memberId: string;
  sessionRef: string;
  /** Enabled, connected, and not paused/revoked/error. */
  active: boolean;
  /** A turn is running or a delivery is in flight. */
  busy: boolean;
}

export interface GoalView { id: string; status: string; taskIds?: readonly string[] }

export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Blocked, done and canceled are not periodic work. Everything else is. */
export const APPLICABLE_STATUSES = ['todo', 'in_progress', 'in_review'] as const;

export const seatKey = (seat: Pick<SeatRecord, 'memberId' | 'sessionRef'>) => `${seat.memberId}|${seat.sessionRef}`;

export const applicableGoals = (goals: readonly GoalView[]) =>
  goals.filter(g => (APPLICABLE_STATUSES as readonly string[]).includes(g.status));

export interface TickInput {
  now: number;
  /** Organization enabled and active; when false no wakeups happen at all. */
  organizationActive: boolean;
  seats: readonly SeatSnapshot[];
  goals: readonly GoalView[];
  /** Existing persisted records, keyed by seatKey. */
  records: ReadonlyMap<string, SeatRecord>;
  intervalMs?: number;
}

export interface TickResult {
  /** Records to persist (only the ones that changed). */
  records: SeatRecord[];
  /** Seats that must receive exactly one check now. */
  wake: { memberId: string; sessionRef: string; goalIds: string[] }[];
  /** True when there was nothing to do, so no model wakeup may be spent. */
  idle: boolean;
}

const fresh = (seat: SeatSnapshot, now: number, intervalMs: number): SeatRecord => ({
  memberId: seat.memberId, sessionRef: seat.sessionRef, nextDueAt: now + intervalMs,
  lastCheckAt: null, pendingMerged: false, checks: 0, state: 'waiting',
});

/**
 * One scheduler tick. Guarantees:
 *  - at most one wakeup per seat per tick (busy seats merge instead of queueing more);
 *  - no wakeup at all when the organization is inactive or no applicable goal exists;
 *  - paused/stopped seats get no wakeup and no due time advancement;
 *  - no attempt cap: `checks` counts, it never terminates reminders.
 */
export function tick(input: TickInput): TickResult {
  const intervalMs = input.intervalMs ?? CHECK_INTERVAL_MS;
  const changed: SeatRecord[] = [];
  const wake: TickResult['wake'] = [];
  const goals = applicableGoals(input.goals);
  const activeSeats = input.seats.filter(s => s.active);

  for (const seat of input.seats) {
    const key = seatKey(seat);
    const existing = input.records.get(key);
    // A brand-new seat must persist its baseline, otherwise every tick restarts
    // the interval and the seat never becomes due.
    const prior = existing ?? fresh(seat, input.now, intervalMs);
    let next: SeatRecord = { ...prior };

    if (!seat.active) {
      // Paused/revoked/stopped seats keep their record but never accumulate due time.
      if (!existing || next.state !== 'stopped' || next.pendingMerged) {
        next = { ...next, state: 'stopped', pendingMerged: false };
        changed.push(next);
      }
      continue;
    }

    // Persist the baseline of a brand-new active seat so the interval is anchored.
    if (!existing) { changed.push({ ...next }); }

    if (!input.organizationActive || goals.length === 0) {
      // Cheap scope query only: nothing applicable, so no model wakeup is spent.
      if (next.state !== 'waiting' || next.nextDueAt < input.now) {
        next = { ...next, state: 'waiting', nextDueAt: input.now + intervalMs };
        changed.push(next);
      }
      continue;
    }

    const due = seat.busy ? next.pendingMerged || input.now >= next.nextDueAt : next.pendingMerged || input.now >= next.nextDueAt;
    if (!due) {
      if (next.state !== 'waiting') { next = { ...next, state: 'waiting' }; changed.push(next); }
      continue;
    }

    if (seat.busy) {
      // Merge: remember exactly one pending check, never a queue of them.
      if (!next.pendingMerged) {
        next = { ...next, pendingMerged: true, state: 'merged' };
        changed.push(next);
      }
      continue;
    }

    next = {
      ...next, pendingMerged: false, lastCheckAt: input.now,
      nextDueAt: input.now + intervalMs, checks: next.checks + 1, state: 'waiting',
    };
    changed.push(next);
    wake.push({ memberId: seat.memberId, sessionRef: seat.sessionRef, goalIds: goals.slice(0, 20).map(g => g.id) });
  }

  return { records: changed, wake, idle: input.organizationActive && goals.length === 0 && activeSeats.length > 0 };
}

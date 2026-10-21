// Durable side of the per-session five-minute checks (human v30).
//
// One row per stable seat key (`memberId|sessionRef`). The record holds when the
// seat is next due and whether a due check was merged while the seat was busy.
// Nothing here starts a turn: it only remembers scheduling state so a restart
// neither loses a due check nor replays old ones.
import type { DatabaseSync } from 'node:sqlite';
import { seatKey, type SeatRecord } from './seat-checks.js';

/**
 * A row is only usable when the whole record — including the pending outbox entry — has the
 * shape the scheduler and the publisher rely on. Checking identity alone is not enough: a
 * `pending.goalIds` that is not a string array passes a shallow check and then throws in
 * `pendingWakes()`/`runSeatChecks()` while other seats are being scheduled (p8 7261).
 */
function isSeatRecord(value: unknown): value is SeatRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as SeatRecord;
  if (typeof r.memberId !== 'string' || !r.memberId) return false;
  if (typeof r.sessionRef !== 'string' || !r.sessionRef) return false;
  if (!Number.isSafeInteger(r.nextDueAt) || r.nextDueAt < 0) return false;
  if (!Number.isSafeInteger(r.checks) || r.checks < 0) return false;
  if (typeof r.state !== 'string' || !r.state) return false;
  if (typeof r.pendingMerged !== 'boolean') return false;
  if (r.lastCheckAt !== undefined && r.lastCheckAt !== null && !Number.isSafeInteger(r.lastCheckAt)) return false;
  if (r.pending === undefined) return true;
  const pending = r.pending as { dueAt?: unknown; goalIds?: unknown; adapterId?: unknown; registrationVersion?: unknown } | null;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return false;
  if (!Number.isSafeInteger(pending.dueAt) || (pending.dueAt as number) < 0) return false;
  if (!Array.isArray(pending.goalIds) || pending.goalIds.length === 0) return false;
  if (pending.goalIds.some(id => typeof id !== 'string' || !id)) return false;
  if (pending.adapterId !== undefined && (typeof pending.adapterId !== 'string' || !pending.adapterId)) return false;
  if (pending.registrationVersion !== undefined
    && (!Number.isSafeInteger(pending.registrationVersion) || (pending.registrationVersion as number) < 1)) return false;
  return true;
}

export class SeatCheckStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS seat_checks(seatKey TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }

  private corrupt: string[] = [];

  /**
   * Read the schedule. A row written by something else (or damaged on disk) must never take
   * the whole scan down: an unreadable row makes its seat re-anchor, which costs at most one
   * interval, while a throwing read would stop every seat until a human repaired the file.
   */
  list(): Map<string, SeatRecord> {
    const rows = this.db.prepare('SELECT seatKey, data FROM seat_checks ORDER BY seatKey').all() as unknown as { seatKey: string; data: unknown }[];
    const records = new Map<string, SeatRecord>();
    const corrupt: string[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(String(row.data)); } catch { corrupt.push(row.seatKey); continue; }
      const record = parsed as SeatRecord | null;
      if (!isSeatRecord(record) || seatKey(record) !== row.seatKey) { corrupt.push(row.seatKey); continue; }
      records.set(row.seatKey, record);
    }
    this.corrupt = corrupt;
    return records;
  }

  /** Seat keys whose stored row could not be used on the last read (kept for diagnosis). */
  corruptKeys(): readonly string[] { return this.corrupt; }

  /** Persist the scheduler's decisions. Callers must save before dispatching. */
  save(records: readonly SeatRecord[]): SeatRecord[] {
    // Durability contract: the caller publishes a wakeup only after this write. Inside someone
    // else's open transaction the write is not durable yet (a rollback would erase the schedule
    // while the wakeup had already gone out), so refuse instead of silently relying on it.
    if ((this.db as unknown as { isTransaction?: boolean }).isTransaction) {
      throw new Error('SeatCheckStore.save requires an idle connection: an open transaction would make the schedule non-durable');
    }
    const statement = this.db.prepare(
      'INSERT INTO seat_checks(seatKey, data) VALUES(?,?) ON CONFLICT(seatKey) DO UPDATE SET data=excluded.data');
    for (const record of records) statement.run(seatKey(record), JSON.stringify(record));
    return [...records];
  }

  /**
   * Clear the pending outbox entry only after the corresponding wakeup published.
   * A seat whose pending entry no longer matches `dueAt` is left alone.
   */
  confirmPending(wake: { memberId: string; sessionRef: string; dueAt: number }) {
    const key = seatKey(wake);
    const current = this.list().get(key);
    if (!current?.pending || current.pending.dueAt !== wake.dueAt) return;
    this.save([{ ...current, pending: undefined }]);
  }

  /** Drop one seat, e.g. after a session is retired so it never resumes silently. */
  remove(seat: Pick<SeatRecord, 'memberId' | 'sessionRef'>) {
    this.db.prepare('DELETE FROM seat_checks WHERE seatKey=?').run(seatKey(seat));
  }
}

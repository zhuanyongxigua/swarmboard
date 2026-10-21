// Durable side of the per-session five-minute checks (human v30).
//
// One row per stable seat key (`memberId|sessionRef`). The record holds when the
// seat is next due and whether a due check was merged while the seat was busy.
// Nothing here starts a turn: it only remembers scheduling state so a restart
// neither loses a due check nor replays old ones.
import type { DatabaseSync } from 'node:sqlite';
import { seatKey, type SeatRecord } from './seat-checks.js';

export class SeatCheckStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS seat_checks(seatKey TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }

  list(): Map<string, SeatRecord> {
    const rows = this.db.prepare('SELECT seatKey, data FROM seat_checks ORDER BY seatKey').all() as unknown as { seatKey: string; data: string }[];
    return new Map(rows.map(row => [row.seatKey, JSON.parse(row.data) as SeatRecord]));
  }

  /** Persist the scheduler's decisions. Callers must save before dispatching. */
  save(records: readonly SeatRecord[]): SeatRecord[] {
    const statement = this.db.prepare(
      'INSERT INTO seat_checks(seatKey, data) VALUES(?,?) ON CONFLICT(seatKey) DO UPDATE SET data=excluded.data');
    for (const record of records) statement.run(seatKey(record), JSON.stringify(record));
    return [...records];
  }

  /** Drop one seat, e.g. after a session is retired so it never resumes silently. */
  remove(seat: Pick<SeatRecord, 'memberId' | 'sessionRef'>) {
    this.db.prepare('DELETE FROM seat_checks WHERE seatKey=?').run(seatKey(seat));
  }
}

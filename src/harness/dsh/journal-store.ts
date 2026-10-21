// Host-owned durable journal for the DSH anti-corruption layer.
//
// Two independent slots share one SQLite sidecar owned by the host:
//  - lifecycle: one intent per session, so a crash between create/resume and
//    binding can be reconciled instead of replaying a mutation;
//  - notification: the driver's delivery intents keyed by
//    (adapterId, memberId, sessionRef, sequence), including unknown and
//    receipt-only retry state.
//
// This module starts no process, timer, guard or notification. It is an
// adapter over the host's existing SQLite sidecar; the host keeps its lease,
// writer identity and database lifecycle.
import type { DshLifecycleIntent, DshLifecycleJournal } from './lifecycle.js';

export type DshNotificationState = 'submitting' | 'unknown' | 'enqueued' | 'completedUnacked' | 'acceptedUnacked';

export interface DshNotificationIntent<TBatch = unknown> {
  key: string;
  state: DshNotificationState;
  batch: TBatch;
  detail?: string;
}

/** Structural subset of node:sqlite used here; the host supplies its own DB. */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export interface DshNotificationJournal<TBatch = unknown> {
  get(key: string): Promise<DshNotificationIntent<TBatch> | undefined>;
  put(intent: DshNotificationIntent<TBatch>): Promise<void>;
  del(key: string): Promise<void>;
}

export interface DshJournals<TBatch = unknown> {
  lifecycle: DshLifecycleJournal;
  notification: DshNotificationJournal<TBatch>;
}

const STATES = new Set<string>(['submitting', 'unknown', 'enqueued', 'completedUnacked', 'acceptedUnacked']);
const TABLE = 'dsh_host_journal';
const lifecycleSlot = (sessionId: string) => `lifecycle:${sessionId}`;
const notificationSlot = (key: string) => `notification:${key}`;

function parsedRecord(row: unknown, label: string): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || typeof (row as { data?: unknown }).data !== 'string') return null;
  try {
    const value: unknown = JSON.parse((row as { data: string }).data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`DSH_JOURNAL_CORRUPT: ${label} is not valid JSON`);
  }
}

function notificationIntent<TBatch>(key: string, value: Record<string, unknown>): DshNotificationIntent<TBatch> {
  if (value.key !== key) throw new Error('DSH_JOURNAL_CORRUPT: notification key mismatch');
  if (typeof value.state !== 'string' || !STATES.has(value.state)) throw new Error('DSH_JOURNAL_CORRUPT: notification state');
  if (!Object.prototype.hasOwnProperty.call(value, 'batch')) throw new Error('DSH_JOURNAL_CORRUPT: notification batch missing');
  if (value.detail !== undefined && typeof value.detail !== 'string') throw new Error('DSH_JOURNAL_CORRUPT: notification detail');
  return value as unknown as DshNotificationIntent<TBatch>;
}

/**
 * Build durable lifecycle and notification journal adapters on one host DB.
 * The caller must keep using the same database file across host restarts; both
 * slots are namespaced so one session cannot read another's intent.
 */
export function createDshJournals<TBatch = unknown>(input: { db: SqliteDatabase; sessionId: string }): DshJournals<TBatch> {
  const { db, sessionId } = input;
  if (!sessionId?.trim()) throw new Error('DSH_INVALID_CONFIG: sessionId required');
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(slot TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  const get = (slot: string) => db.prepare(`SELECT data FROM ${TABLE} WHERE slot=?`).get(slot);
  const putRow = (slot: string, data: string) => db.prepare(
    `INSERT INTO ${TABLE}(slot,data) VALUES(?,?) ON CONFLICT(slot) DO UPDATE SET data=excluded.data`,
  ).run(slot, data);
  const delRow = (slot: string) => db.prepare(`DELETE FROM ${TABLE} WHERE slot=?`).run(slot);

  const lifecycle: DshLifecycleJournal = {
    read(): DshLifecycleIntent | null {
      const row = get(lifecycleSlot(sessionId));
      if (!row) return null;
      const value = parsedRecord(row, 'lifecycle intent');
      if (!value) return null;
      if (typeof value.operation !== 'string' || !['start', 'resume'].includes(value.operation)
        || typeof value.sessionId !== 'string' || typeof value.cwd !== 'string'
        || value.sessionId !== sessionId) {
        throw new Error('DSH_JOURNAL_CORRUPT: lifecycle intent');
      }
      return { operation: value.operation as DshLifecycleIntent['operation'], sessionId: value.sessionId, cwd: value.cwd };
    },
    write(intent: DshLifecycleIntent | null): void {
      if (intent === null) { delRow(lifecycleSlot(sessionId)); return; }
      if (!intent || typeof intent !== 'object' || !['start', 'resume'].includes(intent.operation)
        || intent.sessionId !== sessionId || typeof intent.cwd !== 'string' || !intent.cwd) {
        throw new Error('DSH_JOURNAL_INVALID: lifecycle intent');
      }
      putRow(lifecycleSlot(sessionId), JSON.stringify({ operation: intent.operation, sessionId: intent.sessionId, cwd: intent.cwd }));
    },
  };

  const notification: DshNotificationJournal<TBatch> = {
    async get(key: string): Promise<DshNotificationIntent<TBatch> | undefined> {
      if (typeof key !== 'string' || !key.trim()) throw new Error('DSH_JOURNAL_INVALID: key');
      const row = get(notificationSlot(key));
      if (!row) return undefined;
      return notificationIntent<TBatch>(key, parsedRecord(row, 'notification intent')!);
    },
    async put(intent: DshNotificationIntent<TBatch>): Promise<void> {
      if (!intent || typeof intent !== 'object' || typeof intent.key !== 'string' || !intent.key.trim()
        || !STATES.has(intent.state) || !Object.prototype.hasOwnProperty.call(intent, 'batch')
        || (intent.detail !== undefined && typeof intent.detail !== 'string')) {
        throw new Error('DSH_JOURNAL_INVALID: notification intent');
      }
      putRow(notificationSlot(intent.key), JSON.stringify({ key: intent.key, state: intent.state, batch: intent.batch, ...(intent.detail !== undefined ? { detail: intent.detail } : {}) }));
    },
    async del(key: string): Promise<void> {
      if (typeof key !== 'string' || !key.trim()) throw new Error('DSH_JOURNAL_INVALID: key');
      delRow(notificationSlot(key));
    },
  };

  return Object.freeze({ lifecycle, notification });
}

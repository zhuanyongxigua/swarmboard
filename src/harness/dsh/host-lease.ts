// Fence independent host writers with a durable, non-expiring ownership token.
// A crashed owner is reconciled by the operator; elapsed time never authorizes takeover.
import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './journal-store.js';

export interface DshHostLease {
  acquire(): boolean;
  owns(): boolean;
  release(): void;
}

/** Use the same host-owned SQLite sidecar on every process for this binding.
 * This does not replace the official SDK's own session writer lock. */
export function createDshHostLease(options: {
  db: SqliteDatabase; adapterId?: string; memberId: string; sessionRef: string;
}): DshHostLease {
  const { db } = options;
  if (!options.memberId?.trim() || !options.sessionRef?.trim()
    || options.adapterId !== undefined && !options.adapterId.trim()) throw new Error('DSH_INVALID_HOST_BINDING');
  // Different adapter/member aliases cannot create two writers for one SDK session.
  const key = JSON.stringify([options.sessionRef]);
  const token = randomUUID();
  const idle = () => { if (db.isTransaction !== false) throw new Error('DSH_HOST_OUTER_TRANSACTION'); };
  idle();
  db.exec('CREATE TABLE IF NOT EXISTS dsh_host_owner (binding TEXT PRIMARY KEY, token TEXT NOT NULL)');
  const owns = () => db.prepare('SELECT token FROM dsh_host_owner WHERE binding=?').get(key) as { token?: unknown } | undefined;
  return Object.freeze({
    acquire() {
      idle();
      // One autocommitted SQLite statement elects an owner across connections.
      // Existing rows, including corrupt or orphaned rows, are never replaced.
      db.prepare('INSERT OR IGNORE INTO dsh_host_owner(binding,token) VALUES(?,?)').run(key, token);
      return owns()?.token === token;
    },
    owns: () => owns()?.token === token,
    release() {
      idle();
      db.prepare('DELETE FROM dsh_host_owner WHERE binding=? AND token=?').run(key, token);
    },
  });
}

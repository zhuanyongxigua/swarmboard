// Host-admitted external collaborators: stable board identities with scoped
// goal access, lifecycle and cost records. Swarmboard records and fences them
// but never starts, wakes or pays for their harness; updates reach a
// collaborator on its own MCP calls, not through runtime wakeups.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, parse, type Store } from './store.js';

export interface CollaboratorCost { ceiling?: string; note?: string }
export interface Collaborator {
  id: string; name: string; harness: string; sessionRef: string;
  taskIds: string[]; cost: CollaboratorCost | null;
  enabled: boolean; version: number; cursor: number;
  createdAt: string; updatedAt: string; revokedAt: string | null;
}
// Cost is host/board data recorded verbatim: no vendor default is supplied and
// an absent value means "none recorded", never an unlimited budget.
export const collaboratorCostSchema = z.object({ ceiling: z.string().trim().max(200).optional(), note: z.string().trim().max(2000).optional() }).strict();
export const collaboratorSchemas = {
  configure: z.object({
    id: z.string().min(1).max(128).optional(),
    expectedVersion: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(200),
    harness: z.string().trim().min(1).max(64),
    sessionRef: z.string().trim().max(512).default(''),
    // Admission always names its explicit goal scope; an empty list is never
    // interpreted as "the whole board" the way a pool subscription may be.
    taskIds: z.array(z.string().min(1).max(128)).min(1).max(200),
    cost: collaboratorCostSchema.optional(),
    enabled: z.boolean(),
  }).strict(),
};
/** Read-only admission snapshot for the native pool overview path. It never
 * creates the table or writes; a sidecar without collaborators is an empty
 * snapshot, not an error. */
export function readCollaboratorSnapshot(path: string): Collaborator[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_collaborators'").get()) return [];
    return db.prepare('SELECT data FROM external_collaborators ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Collaborator);
  } finally { db.close(); }
}
export class CollaboratorStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS external_collaborators(id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  }
  close() { this.db.close(); }
  private write(collaborator: Collaborator) {
    this.db.prepare('INSERT INTO external_collaborators VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(collaborator.id, JSON.stringify(collaborator));
    return collaborator;
  }
  list(): Collaborator[] { return this.db.prepare('SELECT data FROM external_collaborators ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Collaborator); }
  get(id: string) {
    const row = this.db.prepare('SELECT data FROM external_collaborators WHERE id=?').get(id);
    if (!row) throw new AppError('NOT_FOUND', 'Collaborator not found', 404);
    return JSON.parse(String(row.data)) as Collaborator;
  }
  // Advance only the update cursor; admission fields never change implicitly.
  saveCursor(id: string, cursor: number) {
    const current = this.get(id);
    if (current.cursor >= cursor) return current;
    return this.write({ ...current, cursor, updatedAt: new Date().toISOString() });
  }
  configure(input: unknown, board: Store): { collaborator: Collaborator; created: boolean } {
    const data = parse(collaboratorSchemas.configure, input);
    const taskIds = [...new Set(data.taskIds)].sort();
    for (const taskId of taskIds) board.readTask(taskId);
    const now = new Date().toISOString();
    return this.transaction(() => {
      if (!data.id) {
        // Baseline updates at the current board position: a fresh admission
        // receives what happens from now on; earlier history stays available
        // through board_read/context_read instead of a stale first-call dump.
        const cursor = Number((board.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as { cursor: number }).cursor);
        const collaborator: Collaborator = { id: randomUUID(), name: data.name, harness: data.harness, sessionRef: data.sessionRef,
          taskIds, cost: data.cost ?? null, enabled: data.enabled, version: 1, cursor,
          createdAt: now, updatedAt: now, revokedAt: data.enabled ? null : now };
        return { collaborator: this.write(collaborator), created: true };
      }
      const before = this.get(data.id);
      if (before.version !== data.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Collaborator changed; read runtime_read', 409);
      // Revocation is terminal: a revoked identity is never silently re-enabled
      // or rescoped; admit a new collaborator instead.
      if (!before.enabled) throw new AppError('COLLABORATOR_REVOKED', 'A revoked collaborator is terminal; admit a new identity instead', 409);
      return { collaborator: this.write({ ...before, name: data.name, harness: data.harness, sessionRef: data.sessionRef, taskIds,
        cost: data.cost ?? null, enabled: data.enabled, version: before.version + 1, updatedAt: now,
        revokedAt: data.enabled ? null : now }), created: false };
    });
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

/** The collaborator half-role shared by the stdio child and tests: scoped,
 *  cursor-based updates on every tool return and an act gate that stops a
 *  revoked collaborator or one whose admitted goals are all terminal. */
export function collaboratorRole(board: Store, state: CollaboratorStore, id: string) {
  const mayAct = () => {
    const admitted = state.get(id);
    if (!admitted.enabled) return false;
    return board.taskStates().some(t => admitted.taskIds.includes(t.id) && !['done', 'canceled'].includes(t.status));
  };
  const sharedUpdates = () => {
    const admitted = state.get(id);
    const events = board.readEntries({ after: admitted.cursor, limit: 100 });
    state.saveCursor(id, events.cursor);
    const items = events.items.filter(e => e.agentId !== id && (!e.taskId || admitted.taskIds.includes(e.taskId)) && (!e.recipientId || e.recipientId === id))
      .map(e => ({ ...e, detail: e.detail.slice(0, 1000), detailTruncated: e.detail.length > 1000 }));
    return { control: mayAct() ? 'continue-if-useful' as const : 'stop-after-safe-boundary' as const,
      // Cost is host/board data passed through verbatim; absent means none
      // recorded, never an unlimited budget.
      cost: admitted.cost, harness: admitted.harness, sessionRef: admitted.sessionRef,
      items, hasMore: events.hasMore };
  };
  return { mayAct, sharedUpdates };
}

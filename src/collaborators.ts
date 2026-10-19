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
import type { WorkerStore } from './worker-store.js';
import { ExecutionGrants } from './execution-grants.js';

export interface CollaboratorCost { ceiling?: string; note?: string }
export interface Collaborator {
  id: string; name: string; harness: string; sessionRef: string;
  taskIds: string[]; scope?: 'selected' | 'organization'; poolId?: string; cost: CollaboratorCost | null;
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
    // Whole-organization subscription requires a separate explicit host choice.
    taskIds: z.array(z.string().min(1).max(128)).max(200),
    scope: z.enum(['selected', 'organization']).optional(),
    poolId: z.string().min(1).max(128).optional(),
    cost: collaboratorCostSchema.optional(),
    enabled: z.boolean(),
  }).strict(),
};
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
  configure(input: unknown, board: Store, workers?: WorkerStore): { collaborator: Collaborator; created: boolean } {
    const data = parse(collaboratorSchemas.configure, input);
    const taskIds = [...new Set(data.taskIds)].sort();
    for (const taskId of taskIds) board.readTask(taskId);
    const now = new Date().toISOString();
    return this.transaction(() => {
      const prior = data.id ? this.get(data.id) : undefined;
      const scope = data.scope ?? prior?.scope ?? 'selected';
      const poolId = data.poolId ?? prior?.poolId;
      if (scope === 'selected' && !taskIds.length) throw new AppError('INVALID_SCOPE', 'Selected scope requires nonempty taskIds');
      if (scope === 'organization' && (!poolId || taskIds.length)) throw new AppError('INVALID_SCOPE', 'Organization scope requires poolId and empty taskIds');
      if (poolId && workers?.pool()?.id !== poolId) throw new AppError('UNBOUND_ORGANIZATION', 'Admission must name the current organization', 403);

      if (!data.id) {
        // Baseline updates at the current board position: a fresh admission
        // receives what happens from now on; earlier history stays available
        // through board_read/context_read instead of a stale first-call dump.
        const cursor = Number((board.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as { cursor: number }).cursor);
        const collaborator: Collaborator = { id: randomUUID(), name: data.name, harness: data.harness, sessionRef: data.sessionRef,
          taskIds, scope, ...(poolId ? { poolId } : {}), cost: data.cost ?? null, enabled: data.enabled, version: 1, cursor,
          createdAt: now, updatedAt: now, revokedAt: data.enabled ? null : now };
        return { collaborator: this.write(collaborator), created: true };
      }
      const before = this.get(data.id);
      if (before.version !== data.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Collaborator changed; read runtime_read', 409);
      // Revocation is terminal: a revoked identity is never silently re-enabled
      // or rescoped; admit a new collaborator instead.
      if (!before.enabled) throw new AppError('COLLABORATOR_REVOKED', 'A revoked collaborator is terminal; admit a new identity instead', 409);
      return { collaborator: this.write({ ...before, name: data.name, harness: data.harness, sessionRef: data.sessionRef, taskIds, scope, ...(poolId ? { poolId } : {}),
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
// Undefined is all subscribed goals; an explicit empty result is no goals.
export function collaboratorTaskIds(admitted: Collaborator, workers?: WorkerStore): string[] | undefined {
  const pool = workers?.pool();
  if (admitted.poolId && pool?.id !== admitted.poolId) return [];
  if (admitted.scope === 'organization') {
    if (!admitted.poolId || !pool) return [];
    return pool.taskIds.length ? pool.taskIds : undefined;
  }
  return pool?.taskIds.length ? admitted.taskIds.filter(id => pool.taskIds.includes(id)) : admitted.taskIds;
}
export function collaboratorRole(board: Store, state: CollaboratorStore, id: string, workers?: WorkerStore) {
  const mayAct = () => {
    const admitted = state.get(id);
    const pool = workers?.pool();
    if (!admitted.enabled || pool && (!pool.enabled || ['stopped', 'stopping', 'completed'].includes(pool.state))) return false;
    const ids = collaboratorTaskIds(admitted, workers);
    return board.taskStates().some(t => (!ids || ids.includes(t.id)) && !['done', 'canceled'].includes(t.status));
  };
  const sharedUpdates = () => {
    const admitted = state.get(id);
    const ids = collaboratorTaskIds(admitted, workers);
    const events = board.readEntries({ after: admitted.cursor, limit: 100 }, { taskIds: ids, recipientId: id });
    state.saveCursor(id, events.cursor);
    const items = events.items.filter(e => e.agentId !== id)
      .map(e => ({ ...e, detail: e.detail.slice(0, 1000), detailTruncated: e.detail.length > 1000 }));
    return { control: mayAct() ? 'continue-if-useful' as const : 'stop-after-safe-boundary' as const,
      // Cost is host/board data passed through verbatim; absent means none
      // recorded, never an unlimited budget.
      executionGrants: workers && mayAct() ? new ExecutionGrants(board, workers).active().filter(g => !ids || ids.includes(g.taskId)) : [],
      ...(workers?.pool() ? { organization: { id: workers.pool()!.id, memberIds: workers.pool()!.memberIds, size: workers.pool()!.size, maxSize: workers.pool()!.maxSize } } : {}),
      cost: admitted.cost, harness: admitted.harness, sessionRef: admitted.sessionRef,
      items, hasMore: events.hasMore };
  };
  return { mayAct, sharedUpdates };
}

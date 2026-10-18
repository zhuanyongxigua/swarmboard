// Keep explicit human execution exceptions outside editable goal text. These
// records guide cooperation; they never approve tools or bypass the OS sandbox.
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AppError, parse, type Store } from './store.js';
import type { WorkerStore } from './worker-store.js';

export const executionGrantSchema = z.object({
  taskId: z.string().min(1).max(128), expectedVersion: z.number().int().nonnegative(),
  projectPath: z.string().min(1).max(4096), executionWorkspace: z.string().min(1).max(4096),
  // Explicitly supported external harness ids only, each at most once. No
  // default routing: an absent harness is simply not authorized, and an
  // unknown id is a validation error rather than a silent fallback.
  externalHarnesses: z.array(z.enum(['zcode', 'dsh'])).max(2).refine(values => new Set(values).size === values.length, 'Each external harness may be listed at most once'),
  monitoring: z.boolean(), enabled: z.boolean(),
}).strict();
export type ExecutionGrant = Omit<z.infer<typeof executionGrantSchema>, 'expectedVersion'> & { poolId: string; version: number };
function directory(path: string) {
  try { if (isAbsolute(path) && statSync(path).isDirectory()) return realpathSync(path); } catch { /* Reject unavailable roots. */ }
  throw new AppError('INVALID_WORKSPACE', 'Execution grant requires existing absolute directories');
}
export class ExecutionGrants {
  constructor(private board: Store, private workers: WorkerStore) {
    workers.db.exec('CREATE TABLE IF NOT EXISTS task_execution_grants(taskId TEXT PRIMARY KEY,data TEXT NOT NULL)');
  }
  list(): ExecutionGrant[] {
    return this.workers.db.prepare('SELECT data FROM task_execution_grants ORDER BY taskId').all().map(r => JSON.parse(String(r.data)) as ExecutionGrant);
  }
  active() {
    const pool = this.workers.pool(); if (!pool?.enabled) return [];
    const goals = new Set(this.board.taskStates().filter(t => !['done', 'canceled'].includes(t.status)).map(t => t.id));
    return this.list().filter(g => g.enabled && g.poolId === pool.id && goals.has(g.taskId) && (!pool.taskIds.length || pool.taskIds.includes(g.taskId)));
  }
  configure(input: unknown) {
    const data = parse(executionGrantSchema, input);
    this.board.readTask(data.taskId);
    const projectPath = directory(data.projectPath), executionWorkspace = directory(data.executionWorkspace);
    return this.workers.transaction(() => {
      const pool = this.workers.pool();
      if (!pool || pool.taskIds.length && !pool.taskIds.includes(data.taskId)) throw new AppError('UNBOUND_GOAL', 'Goal is outside the organization subscription', 403);
      const before = this.list().find(g => g.taskId === data.taskId);
      if ((before?.version ?? 0) !== data.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Execution grant changed; read runtime_read', 409);
      const { expectedVersion, ...fields } = data;
      const grant: ExecutionGrant = { ...fields, projectPath, executionWorkspace, poolId: pool.id, version: expectedVersion + 1 };
      this.workers.db.prepare('INSERT INTO task_execution_grants VALUES(?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data').run(grant.taskId, JSON.stringify(grant));
      return grant;
    });
  }
}

// Persist session bindings and delivery checkpoints separately from board data so
// existing plugin processes can keep using the board during a runtime upgrade.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AppError, parse } from './store.js';

export const approvalPauseMessage = 'Human approval or input required; this worker is paused';

export const workerSchemas = {
  register: z.object({ name: z.string().trim().min(1).max(200), workspacePath: z.string().max(4096), taskIds: z.array(z.string().min(1).max(128)).max(200).default([]) }).strict(),
  reconcile: z.object({ id: z.string().min(1), expectedVersion: z.number().int().positive() }).strict(),
  update: z.object({ id: z.string().min(1), expectedVersion: z.number().int().positive(), enabled: z.boolean() }).strict(),
};
export interface Worker {
  poolId?: string;
  id: string; name: string; workspacePath: string; taskIds: string[]; threadId: string | null;
  enabled: boolean; version: number; cursor: number;
  status: 'idle' | 'running' | 'error' | 'uncertain'; error: string;
  reconcileRequested?: boolean;
  deliveryId: string | null; deliveryCursor: number | null; turnId: string | null;
}
export function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export class WorkerStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_owner(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_pool(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(): Worker[] { return this.db.prepare('SELECT data FROM workers ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Worker); }
  get(id: string) {
    const row = this.db.prepare('SELECT data FROM workers WHERE id=?').get(id);
    if (!row) throw new AppError('NOT_FOUND', 'Worker not found', 404);
    return JSON.parse(String(row.data)) as Worker;
  }
  register(input: unknown) {
    const data = parse(workerSchemas.register, input);
    let workspacePath: string;
    try {
      if (!isAbsolute(data.workspacePath) || !statSync(data.workspacePath).isDirectory()) throw new Error('Invalid workspace');
      workspacePath = realpathSync(data.workspacePath);
    } catch { throw new AppError('INVALID_WORKSPACE', 'Select an existing absolute workspace directory'); }
    data.taskIds = [...new Set(data.taskIds)].sort();
    return this.transaction(() => {
      if (this.list().some(w => w.workspacePath === workspacePath && JSON.stringify(w.taskIds) === JSON.stringify(data.taskIds))) throw new AppError('WORKER_EXISTS', 'This workspace and task subscription already have a worker', 409);
      const worker: Worker = { ...data, workspacePath, id: randomUUID(), threadId: null, enabled: true, version: 1, cursor: 0, status: 'idle', error: '', deliveryId: null, deliveryCursor: null, turnId: null };
      this.db.prepare('INSERT INTO workers VALUES(?,?)').run(worker.id, JSON.stringify(worker)); return worker;
    });
  }
  update(input: unknown) {
    const data = parse(workerSchemas.update, input);
    return this.transaction(() => {
      const worker = this.get(data.id);
      if (worker.version !== data.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Worker changed; read its current version', 409);
      // An ambiguous delivery must be inspected, never blindly replayed by toggling enable.
      if (data.enabled && ['running', 'uncertain'].includes(worker.status)) throw new AppError('DELIVERY_UNRESOLVED', 'Inspect the bound session before resuming this worker', 409);
      return this.write({ ...worker, enabled: data.enabled, version: worker.version + 1, status: data.enabled ? 'idle' : worker.status, error: data.enabled ? '' : worker.error });
    });
  }
  requestReconcile(input: unknown) {
    const data = parse(workerSchemas.reconcile, input);
    return this.transaction(() => {
      const worker = this.get(data.id);
      if (worker.version !== data.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Worker changed; read its current version', 409);
      if (worker.status !== 'uncertain') throw new AppError('NOT_UNCERTAIN', 'Only an uncertain delivery needs reconciliation', 409);
      return this.write({ ...worker, reconcileRequested: true, version: worker.version + 1 });
    });
  }
  private write(worker: Worker) { this.db.prepare('UPDATE workers SET data=? WHERE id=?').run(JSON.stringify(worker), worker.id); return worker; }
  save(worker: Worker) {
    // Runtime checkpoints cannot overwrite a pause or reconciliation request
    // committed by another MCP process after the delivery snapshot was read.
    return this.transaction(() => {
      const current = this.get(worker.id);
      return this.write({ ...worker, enabled: current.enabled, version: current.version,
        error: current.version !== worker.version && !current.enabled ? current.error || worker.error : worker.error,
        name: current.name, workspacePath: current.workspacePath, taskIds: current.taskIds,
        reconcileRequested: current.version !== worker.version ? current.reconcileRequested : worker.reconcileRequested });
    });
  }
  pauseForApproval(id: string) {
    return this.transaction(() => {
      const current = this.get(id);
      return this.write({ ...current, enabled: false, version: current.version + 1, error: approvalPauseMessage });
    });
  }
  acquire(token: string, pid: number, alive = processAlive) {
    return this.transaction(() => {
      const owner = this.db.prepare('SELECT token,pid FROM runtime_owner WHERE id=1').get() as {token: string; pid: number} | undefined;
      // Do not steal a live process's execution merely because a heartbeat was late.
      if (owner && owner.token !== token && alive(owner.pid)) return false;
      this.db.prepare('INSERT INTO runtime_owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(token, pid); return true;
    });
  }
  owns(token: string) { return this.db.prepare('SELECT token FROM runtime_owner WHERE id=1').get()?.token === token; }
  release(token: string) { this.db.prepare('DELETE FROM runtime_owner WHERE token=?').run(token); }
  owner() { return this.db.prepare('SELECT pid FROM runtime_owner WHERE id=1').get() ?? null; }
  pool(): Pool | null {
    const row = this.db.prepare('SELECT data FROM worker_pool WHERE id=1').get();
    return row ? JSON.parse(String(row.data)) as Pool : null;
  }
  savePool(pool: Pool) {
    this.db.prepare('INSERT INTO worker_pool VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(pool)); return pool;
  }
  checkpointPool(pool: Pool) {
    return this.transaction(() => {
      const current = this.pool();
      if (!current || current.id !== pool.id || current.workspacePath !== pool.workspacePath) throw new AppError('VERSION_CONFLICT', 'Pool configuration changed', 409);
      return this.savePool({ ...pool, enabled: current.enabled, version: current.version,
        state: current.version === pool.version ? pool.state : current.state });
    });
  }
}

export interface Pool {
  id: string; version: number; workspacePath: string; size: number; taskIds: string[];
  enabled: boolean; memberIds: string[]; state: 'ready' | 'active' | 'waiting' | 'completed' | 'stopping' | 'stopped' | 'error'; error: string;
}
export const poolSchemas = {
  configure: z.object({ workspacePath: z.string().max(4096), size: z.number().int().min(2).max(8).default(3), taskIds: z.array(z.string().min(1).max(128)).max(200).default([]), expectedVersion: z.number().int().nonnegative().default(0) }).strict(),
  control: z.object({ expectedVersion: z.number().int().positive(), enabled: z.boolean() }).strict(),
};

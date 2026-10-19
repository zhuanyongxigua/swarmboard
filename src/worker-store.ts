// Persist session bindings and delivery checkpoints separately from board data so
// existing plugin processes can keep using the board during a runtime upgrade.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AppError, parse } from './store.js';
import type { Liveness } from './pool-liveness.js';

export const approvalPauseMessage = 'Human approval or input required; this worker is paused';

export const workerSchemas = {
  register: z.object({ name: z.string().trim().min(1).max(200), workspacePath: z.string().max(4096), taskIds: z.array(z.string().min(1).max(128)).max(200).default([]) }).strict(),
  reconcile: z.object({ id: z.string().min(1), expectedVersion: z.number().int().positive() }).strict(),
  update: z.object({ id: z.string().min(1), expectedVersion: z.number().int().positive(), enabled: z.boolean() }).strict(),
};
export interface Worker {
  poolId?: string;
  /** Backend that owns this worker's session identifiers. Readers normalize
   *  missing values to 'codex': pre-backend-identity sessions can only be
   *  Codex, and a different configured backend must refuse to resume them. */
  backendId?: string;
  id: string; name: string; workspacePath: string; taskIds: string[]; threadId: string | null;
  enabled: boolean; version: number; cursor: number;
  status: 'idle' | 'running' | 'error' | 'uncertain'; error: string;
  reconcileRequested?: boolean;
  deliveryId: string | null; deliveryCursor: number | null; turnId: string | null;
  deliveryPhase?: 'opening' | 'submitting' | 'running';
  retirement?: { state: 'draining' | 'retired'; previousEnabled: boolean; requestedAt: string; requestId: string;
    resolution?: { deliveryId: string | null; outcome: 'failed' | 'not-submitted'; observedAt: string } };
}
export function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
// Sessions persisted before backend identity existed can only belong to the
// official Codex backend; normalizing on read keeps old databases usable and
// blocks a differently configured backend from resuming their identifiers.
function normalizeWorker(worker: Worker): Worker {
  return worker.backendId ? worker : { ...worker, backendId: 'codex' };
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
      CREATE TABLE IF NOT EXISTS pool_liveness(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peer_requests(poolId TEXT,workerId TEXT,requestId TEXT,reason TEXT,PRIMARY KEY(poolId,workerId,requestId));
      CREATE TABLE IF NOT EXISTS member_retirement_requests(poolId TEXT,requestId TEXT,memberId TEXT NOT NULL,expectedVersion INTEGER NOT NULL,PRIMARY KEY(poolId,requestId));
    `);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(): Worker[] { return this.db.prepare('SELECT data FROM workers ORDER BY id').all().map(row => normalizeWorker(JSON.parse(String(row.data)) as Worker)); }
  get(id: string) {
    const row = this.db.prepare('SELECT data FROM workers WHERE id=?').get(id);
    if (!row) throw new AppError('NOT_FOUND', 'Worker not found', 404);
    return normalizeWorker(JSON.parse(String(row.data)) as Worker);
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
      if (data.enabled && worker.retirement) throw new AppError('MEMBER_RETIRING', 'Restore membership through an explicit capacity increase before enabling this worker', 409);
      // An ambiguous delivery must be inspected, never blindly replayed by toggling enable.
      if (data.enabled && ['running', 'uncertain'].includes(worker.status)) throw new AppError('DELIVERY_UNRESOLVED', 'Inspect the bound session before resuming this worker', 409);
      return this.write({ ...worker, enabled: data.enabled, version: worker.version + 1, status: data.enabled ? 'idle' : worker.status, error: data.enabled ? '' : worker.error,
        retirement: worker.retirement && !data.enabled ? { ...worker.retirement, previousEnabled: false } : worker.retirement,
        ...(data.enabled ? { deliveryId: null, deliveryCursor: null, turnId: null, deliveryPhase: undefined, reconcileRequested: false } : {}) });
    });
  }
  requestReconcile(input: unknown) {
    const data = parse(workerSchemas.reconcile, input);
    return this.transaction(() => {
      const worker = this.get(data.id);
      if (worker.version !== data.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Worker changed; read its current version', 409);
      if (worker.status !== 'uncertain' && !(worker.retirement?.state === 'draining' && worker.status === 'error')) throw new AppError('NOT_UNCERTAIN', 'Only an uncertain delivery needs reconciliation', 409);
      return this.write({ ...worker, status: 'uncertain', reconcileRequested: true, version: worker.version + 1 });
    });
  }
  private write(worker: Worker) { this.db.prepare('UPDATE workers SET data=? WHERE id=?').run(JSON.stringify(worker), worker.id); return worker; }
  save(worker: Worker) {
    // Runtime checkpoints cannot overwrite a pause or reconciliation request
    // committed by another MCP process after the delivery snapshot was read.
    return this.transaction(() => {
      const current = this.get(worker.id);
      // No delivery remains after retirement. Late native checkpoints must not
      // recreate an unresolved turn or change its preserved history.
      if (current.retirement?.state === 'retired') return current;
      return this.write({ ...worker, enabled: current.enabled, version: current.version,
        retirement: current.retirement,
        error: current.version !== worker.version && !current.enabled ? current.error || worker.error : worker.error,
        name: current.name, workspacePath: current.workspacePath, taskIds: current.taskIds,
        reconcileRequested: current.version !== worker.version ? current.reconcileRequested : worker.reconcileRequested });
    });
  }
  pauseForApproval(id: string) {
    return this.transaction(() => {
      const current = this.get(id);
      return this.write({ ...current, enabled: false, version: current.version + 1, error: approvalPauseMessage,
        retirement: current.retirement ? { ...current.retirement, previousEnabled: false } : undefined });
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
  // A public digest invalidates derived overview claims across ownership
  // changes, including PID reuse, without exposing the owner's fence token.
  ownerEpoch() {
    const row = this.db.prepare('SELECT token,pid FROM runtime_owner WHERE id=1').get();
    return row ? createHash('sha256').update(JSON.stringify(row)).digest('hex') : null;
  }
  pool(): Pool | null {
    const row = this.db.prepare('SELECT data FROM worker_pool WHERE id=1').get();
    if (!row) return null;
    const pool = JSON.parse(String(row.data)) as Pool;
    return { ...pool, maxSize: pool.maxSize ?? Math.max(pool.size, 8) };
  }
  /** Capacity state only. The host selects a member and verifies resource
   *  handoff before completion; this primitive is not an agent-facing tool. */
  requestMemberRetirement(input: unknown) {
    const data = parse(memberRetirementSchema, input);
    return this.transaction(() => {
      const pool = this.pool();
      if (!pool) throw new AppError('NOT_FOUND', 'Organization not found', 404);
      const prior = this.db.prepare('SELECT memberId,expectedVersion FROM member_retirement_requests WHERE poolId=? AND requestId=?').get(pool.id, data.requestId);
      if (prior) {
        if (prior.memberId !== data.memberId || prior.expectedVersion !== data.expectedVersion) throw new AppError('REQUEST_CONFLICT', 'Retirement request identity changed', 409);
        return { pool, member: this.get(data.memberId), requestId: data.requestId };
      }
      if (pool.version !== data.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Pool changed; read runtime_read', 409);
      if (!pool.enabled || ['stopping', 'stopped', 'completed'].includes(pool.state)) throw new AppError('POOL_STOPPED', 'The organization is stopped', 409);
      if (pool.size <= 1) throw new AppError('MEMBER_MINIMUM', 'Keep at least one member in the organization', 409);
      const member = this.get(data.memberId);
      if (!pool.memberIds.includes(member.id) || member.poolId !== pool.id || member.retirement) throw new AppError('NOT_MEMBER', 'Select a current member without a pending retirement', 409);
      const next = this.write({ ...member, enabled: false, version: member.version + 1,
        retirement: { state: 'draining', previousEnabled: member.enabled, requestedAt: new Date().toISOString(), requestId: data.requestId } });
      this.db.prepare('INSERT INTO member_retirement_requests VALUES(?,?,?,?)').run(pool.id, data.requestId, member.id, data.expectedVersion);
      return { pool: this.savePool({ ...pool, size: pool.size - 1, version: pool.version + 1 }), member: next, requestId: data.requestId };
    });
  }
  memberRetirementRequest(requestId: string) {
    const pool = this.pool();
    return pool ? this.db.prepare('SELECT memberId,expectedVersion FROM member_retirement_requests WHERE poolId=? AND requestId=?').get(pool.id, requestId) as { memberId: string; expectedVersion: number } | undefined : undefined;
  }
  resolveRetirementDelivery(id: string, deliveryId: string | null, outcome: 'failed' | 'not-submitted') {
    return this.transaction(() => {
      const member = this.get(id);
      if (member.retirement?.state !== 'draining') return member;
      if (member.status !== 'error' || member.deliveryId !== deliveryId) throw new AppError('DELIVERY_CHANGED', 'Native delivery changed during retirement inspection', 409);
      return this.write({ ...member, retirement: { ...member.retirement, resolution: { deliveryId, outcome, observedAt: new Date().toISOString() } } });
    });
  }
  /** Called only after the host has verified resource/claim handoff. Unknown
   *  native deliveries retain their checkpoints and cannot complete here. */
  completeMemberRetirement(id: string) {
    return this.transaction(() => {
      const pool = this.pool(), member = this.get(id);
      if (!pool || member.poolId !== pool.id || !member.retirement) throw new AppError('NOT_RETIRING', 'Member has no retirement request', 409);
      if (member.retirement.state === 'retired') return pool;
      const resolvedFailure = member.status === 'error' && member.retirement.resolution?.deliveryId === member.deliveryId;
      if (['running', 'uncertain'].includes(member.status) || !resolvedFailure && (member.deliveryId || member.turnId || member.deliveryPhase || member.deliveryCursor !== null)) throw new AppError('DELIVERY_UNRESOLVED', 'Inspect and finish the native delivery before retirement', 409);
      this.write({ ...member, enabled: false, version: member.version + 1, retirement: { ...member.retirement, state: 'retired' } });
      return this.savePool({ ...pool, memberIds: pool.memberIds.filter(memberId => memberId !== id), version: pool.version + 1 });
    });
  }
  restoreRetiredMember(id: string) {
    return this.transaction(() => {
      const pool = this.pool(), member = this.get(id);
      if (!pool || !pool.enabled || pool.memberIds.length >= pool.size) throw new AppError('MEMBER_CAPACITY', 'An explicit capacity increase is required', 409);
      if (member.poolId !== pool.id || member.retirement?.state !== 'retired' || pool.memberIds.includes(id)) throw new AppError('NOT_RETIRED', 'Member has not completed retirement', 409);
      const { retirement, ...original } = member;
      const restored = this.write({ ...original, enabled: retirement.previousEnabled && member.status === 'idle', version: member.version + 1 });
      this.savePool({ ...pool, memberIds: [...pool.memberIds, id], version: pool.version + 1 });
      return restored;
    });
  }
  requestPeer(input: unknown, authorize?: () => void) {
    const data = parse(peerRequestSchema, input);
    return this.transaction(() => {
      const pool = this.pool();
      if (!pool?.enabled || ['completed','stopped','stopping'].includes(pool.state)) throw new AppError('POOL_STOPPED', 'The organization is stopped', 409);
      if (authorize) authorize();
      else {
        const worker = this.get(data.workerId);
        if (!worker.enabled || !pool.memberIds.includes(worker.id)) throw new AppError('NOT_MEMBER', 'Only an enabled organization member may request a peer', 403);
      }
      if (this.db.prepare('SELECT 1 FROM peer_requests WHERE poolId=? AND workerId=? AND requestId=?').get(pool.id, data.workerId, data.requestId)) return pool;
      if (pool.size >= pool.maxSize) throw new AppError('PEER_BUDGET', 'The human-configured member budget is exhausted', 409);
      this.db.prepare('INSERT INTO peer_requests VALUES(?,?,?,?)').run(pool.id, data.workerId, data.requestId, data.reason);
      return this.savePool({ ...pool, size: pool.size + 1, version: pool.version + 1 });
    });
  }
  liveness(): Liveness | null {
    const row = this.db.prepare('SELECT data FROM pool_liveness WHERE id=1').get();
    return row ? JSON.parse(String(row.data)) as Liveness : null;
  }
  saveLiveness(value: Liveness) {
    const data = JSON.stringify(value);
    if (JSON.stringify(this.liveness()) !== data) this.db.prepare('INSERT INTO pool_liveness VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(data);
    return value;
  }
  savePool(pool: Pool) {
    this.db.prepare('INSERT INTO worker_pool VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(pool)); return pool;
  }
  replaceMemberSubscriptions(poolId: string, taskIds: string[]) {
    // Called within the configuration transaction; checkpoint saves preserve it.
    for (const worker of this.list().filter(w => w.poolId === poolId)) {
      this.write({ ...worker, taskIds, version: worker.version + 1 });
    }
  }
  clearScopeRefresh(id: string) {
    return this.transaction(() => {
      const current = this.pool();
      if (current?.scopeRefresh?.id === id) {
        const { scopeRefresh: _completed, ...rest } = current;
        this.savePool(rest);
      }
    });
  }
  checkpointPool(pool: Pool) {
    return this.transaction(() => {
      const current = this.pool();
      if (!current || current.id !== pool.id || current.workspacePath !== pool.workspacePath) throw new AppError('VERSION_CONFLICT', 'Pool configuration changed', 409);
      return this.savePool({ ...pool, enabled: current.enabled, version: current.version,
        memberIds: current.version === pool.version ? pool.memberIds : current.memberIds,
        size: current.size, maxSize: current.maxSize, taskIds: current.taskIds, scopeRefresh: current.scopeRefresh,
        state: current.version === pool.version ? pool.state : current.state });
    });
  }
}

export interface Pool {
  id: string; version: number; workspacePath: string; size: number; maxSize: number; taskIds: string[];
  scopeRefresh?: { id: string; previousTaskIds: string[] };
  enabled: boolean; memberIds: string[]; state: 'ready' | 'active' | 'waiting' | 'completed' | 'stopping' | 'stopped' | 'error'; error: string;
}
export const poolSchemas = {
  configure: z.object({ workspacePath: z.string().max(4096), size: z.number().int().min(1).max(128).default(3), maxSize: z.number().int().min(1).max(128).optional(), taskIds: z.array(z.string().min(1).max(128)).max(200).optional(), expectedVersion: z.number().int().nonnegative().default(0) }).strict(),
  control: z.object({ expectedVersion: z.number().int().positive(), enabled: z.boolean() }).strict(),
  reduce: z.object({ expectedVersion: z.number().int().positive(), requestId: z.string().trim().min(1).max(128) }).strict(),
};
export const peerRequestSchema = z.object({ workerId: z.string().min(1), requestId: z.string().min(1).max(128), reason: z.string().trim().min(1).max(2000) }).strict();
export const memberRetirementSchema = z.object({ memberId: z.string().min(1), expectedVersion: z.number().int().positive(), requestId: z.string().trim().min(1).max(128) }).strict();

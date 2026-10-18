// Supply equal persistent peers and isolated execution directories. The pool
// manages capacity and lifecycle only; workers decide their own contributions.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { AppError, parse, type Store } from './store.js';
import { poolSchemas, type Pool, type WorkerStore } from './worker-store.js';

export class WorkerPool {
  constructor(private workers: WorkerStore, private board: Store, private databasePath: string) {}
  configure(input: unknown) {
    const data = parse(poolSchemas.configure, input);
    let workspacePath: string;
    try {
      if (!isAbsolute(data.workspacePath) || !statSync(data.workspacePath).isDirectory()) throw new Error();
      workspacePath = realpathSync(data.workspacePath);
    } catch { throw new AppError('INVALID_WORKSPACE', 'Select an existing authorized absolute project directory'); }
    for (const id of data.taskIds ?? []) if (!this.board.db.prepare('SELECT id FROM tasks WHERE id=?').get(id)) throw new AppError('NOT_FOUND', 'Subscribed human task not found', 404);
    return this.workers.transaction(() => {
      if (this.workers.list().some(w => !w.poolId && ['running', 'uncertain'].includes(w.status))) throw new AppError('LEGACY_WORK_ACTIVE', 'Finish or reconcile the existing individual delivery before starting a peer pool', 409);
      const before = this.workers.pool();
      if ((before?.version ?? 0) !== data.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Pool changed; read runtime_read', 409);
      const taskIds = [...new Set(data.taskIds ?? before?.taskIds ?? [])].sort();
      if (before && (before.memberIds.length || ['active', 'stopping'].includes(before.state))) {
        const widening = before.taskIds.length > 0 && data.taskIds?.length === 0;
        if (workspacePath !== before.workspacePath || JSON.stringify(taskIds) !== JSON.stringify(before.taskIds) && !widening) throw new AppError('POOL_BOUND', 'Do not replace a bound organization project or narrow its subscriptions', 409);
        const maxSize = data.maxSize ?? Math.max(before.maxSize, data.size);
        if (data.size < before.size || maxSize < data.size) throw new AppError('PEER_BUDGET', 'Keep existing members and a budget covering the requested size', 409);
        const scopeRefresh = widening ? { id: randomUUID(), previousTaskIds: before.taskIds } : before.scopeRefresh;
        if (widening) this.workers.replaceMemberSubscriptions(before.id, taskIds);
        return this.workers.savePool({ ...before, size: data.size, maxSize, taskIds, scopeRefresh, version: before.version + 1 });
      }
      const maxSize = data.maxSize ?? Math.max(data.size, 8);
      if (maxSize < data.size) throw new AppError('PEER_BUDGET', 'Member budget must cover initial members');
      const pool: Pool = { id: before?.id ?? randomUUID(), version: (before?.version ?? 0) + 1,
        workspacePath, size: data.size, maxSize, taskIds, enabled: true,
        memberIds: [], state: 'ready', error: '' };
      return this.workers.savePool(pool);
    });
  }
  control(input: unknown) {
    const data = parse(poolSchemas.control, input);
    return this.workers.transaction(() => {
      const pool = this.workers.pool();
      if (!pool || pool.version !== data.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Pool changed; read runtime_read', 409);
      return this.workers.savePool({ ...pool, enabled: data.enabled, version: pool.version + 1,
        state: data.enabled ? 'ready' : 'stopping' });
    });
  }
  reduce(input: unknown) {
    const data = parse(poolSchemas.reduce, input);
    const pool = this.workers.pool();
    if (!pool) throw new AppError('NOT_FOUND', 'Organization not found', 404);
    const prior = this.workers.memberRetirementRequest(data.requestId);
    // A response-lost retry reuses its original target, never a second member.
    const candidates = pool.memberIds.slice().reverse().map(id => this.workers.get(id)).filter(w => !w.retirement);
    const rank = (w: (typeof candidates)[number]) => (w.status === 'idle' || w.status === 'error' && !w.deliveryId ? 0 : w.status === 'running' ? 2 : 4) + (this.hasUsage(w.id) ? 1 : 0);
    candidates.sort((a, b) => rank(a) - rank(b));
    const memberId = prior?.memberId ?? candidates[0]?.id;
    if (!memberId) throw new AppError('NO_RETIRABLE_MEMBER', 'All available members are already leaving', 409);
    const result = this.workers.requestMemberRetirement({ ...data, memberId });
    this.settleRetirements();
    return { ...result, pool: this.workers.pool()!, member: this.workers.get(memberId) };
  }
  private hasUsage(id: string) { return !!this.board.db.prepare('SELECT 1 FROM usages WHERE agentId=? AND active=1 LIMIT 1').get(id); }
  private reopenResourceAdmissions() {
    const pool = this.workers.pool();
    if (!pool) return;
    const fenced = this.board.db.prepare('SELECT agentId FROM resource_admission_fences').all();
    for (const row of fenced) {
      const id = String(row.agentId);
      if (!pool.memberIds.includes(id)) continue;
      this.board.reopenResourceAdmission(id, () => {
        const current = this.workers.pool(), worker = this.workers.get(id);
        return !!current?.memberIds.includes(id) && !worker.retirement;
      });
    }
  }
  private settleRetirements() {
    const pool = this.workers.pool();
    if (!pool) return;
    for (const id of pool.memberIds) {
      const worker = this.workers.get(id);
      if (worker.retirement?.state !== 'draining' || this.hasUsage(id)) continue;
      const resolvedFailure = worker.status === 'error' && worker.retirement.resolution?.deliveryId === worker.deliveryId;
      if (['running', 'uncertain'].includes(worker.status) || !resolvedFailure && (worker.deliveryId || worker.turnId || worker.deliveryPhase || worker.deliveryCursor !== null)) continue;
      if (!this.board.closeResourceAdmission(id)) continue;
      this.workers.completeMemberRetirement(id);
    }
  }
  private directory(pool: Pool, index: number) {
    const root = this.databasePath === ':memory:' ? join(tmpdir(), 'swarmboard-pools', pool.id)
      : join(dirname(this.databasePath), 'workspaces', pool.id);
    mkdirSync(root, { recursive: true });
    const target = join(root, `peer-${index + 1}`);
    const ready = join(root, `peer-${index + 1}.ready`);
    // Each checkout owns its Git metadata, so a workspace-write session needs
    // no write access to a sibling checkout or the source repository's .git.
    if (!existsSync(ready)) {
      if (existsSync(target)) throw new AppError('WORKSPACE_INCOMPLETE', 'An interrupted workspace preparation needs inspection before reuse', 409);
      let repository = false;
      try { repository = execFileSync('git', ['-C', pool.workspacePath, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'; } catch { /* A non-Git workspace gets an empty isolated directory. */ }
      if (repository) {
        execFileSync('git', ['clone', '--local', '--no-hardlinks', '--', pool.workspacePath, target], { stdio: 'ignore', timeout: 30000 });
        execFileSync('git', ['-C', target, 'switch', '-c', `full/swarmboard-${pool.id.slice(0,8)}-peer-${index + 1}`], { stdio: 'ignore' });
        execFileSync('git', ['-C', target, 'config', 'push.default', 'nothing'], { stdio: 'ignore' });
        let origin = '';
        try { origin = execFileSync('git', ['-C', pool.workspacePath, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Local-only repositories have no publishing target. */ }
        if (/^https?:\/\//i.test(origin)) { const url = new URL(origin); url.username = ''; url.password = ''; origin = url.toString(); }
        if (origin) execFileSync('git', ['-C', target, 'remote', 'set-url', 'origin', origin], { stdio: 'ignore' });
        else execFileSync('git', ['-C', target, 'remote', 'remove', 'origin'], { stdio: 'ignore' });
      } else mkdirSync(target);
      writeFileSync(ready, 'Prepared by Swarmboard; do not remove workspaces automatically.\n', { mode: 0o600 });
    }
    return realpathSync(target);
  }
  ensureMembers(pool: Pool) {
    while (pool.memberIds.length < pool.size) {
      const fresh = this.workers.pool();
      if (!fresh?.enabled) return fresh ?? pool;
      pool = fresh;
      if (pool.memberIds.length >= pool.size) return pool;
      const members = this.workers.list().filter(w => w.poolId === pool.id);
      const orphan = members.find(w => !w.retirement && !pool.memberIds.includes(w.id));
      if (orphan) { pool = this.workers.checkpointPool({ ...pool, memberIds: [...pool.memberIds, orphan.id] }); continue; }
      const retired = members.find(w => w.retirement?.state === 'retired');
      if (retired) { this.workers.restoreRetiredMember(retired.id); this.reopenResourceAdmissions(); pool = this.workers.pool()!; continue; }
      const index = members.length;
      const workspacePath = this.directory(pool, index);
      // register is idempotently recoverable if the process exits before the
      // pool's member list was checkpointed.
      const member = this.workers.list().find(w => w.workspacePath === workspacePath)
        ?? this.workers.register({ name: `Swarmboard peer ${index + 1}`, workspacePath, taskIds: pool.taskIds });
      this.workers.save({ ...member, poolId: pool.id });
      if (!this.board.db.prepare('SELECT id FROM agents WHERE id=?').get(member.id)) this.board.registerAgent({ agentId: member.id, name: member.name });
      pool = this.workers.checkpointPool({ ...pool, memberIds: [...pool.memberIds, member.id] });
    }
    return pool;
  }
  sync(busy: boolean) {
    this.reopenResourceAdmissions();
    this.settleRetirements();
    let pool = this.workers.pool(); if (!pool) return null;
    if (pool.enabled && pool.scopeRefresh) {
      const refresh = pool.scopeRefresh;
      const agentId = `pool-events:${pool.id}`;
      if (!this.board.db.prepare('SELECT id FROM agents WHERE id=?').get(agentId)) this.board.registerAgent({ agentId, name: 'Swarmboard organization events' });
      // Read after the scope commit: an older scan may have advanced its cursor
      // past a new goal while configuration was still in flight.
      const goals = this.board.taskStates().filter(t => !refresh.previousTaskIds.includes(t.id) && !['done', 'canceled'].includes(t.status));
      for (const { id: taskId } of goals) this.board.publishSystemEntryOnce({ kind: 'OBSERVED', agentId, taskId,
        summary: 'BOARD_SCOPE_EXPANDED', detail: JSON.stringify({ signalId: `${refresh.id}:${taskId}`,
          message: 'The organization follows all human goals. Read current shared work and choose useful contributions within the authorized project. Peers negotiate their own scopes and priorities.' }) });
      // The sidecar outbox is acknowledged only after idempotent board writes.
      this.workers.clearScopeRefresh(refresh.id);
      pool = this.workers.pool()!;
    }
    const tasks = this.board.taskStates().filter(t => !pool!.taskIds.length || pool!.taskIds.includes(t.id));
    let state: Pool['state'];
    if (!pool.enabled) state = busy ? 'stopping' : 'stopped';
    else if (tasks.length && tasks.every(t => ['done', 'canceled'].includes(t.status))) state = busy ? 'stopping' : 'completed';
    else if (tasks.some(t => ['todo', 'in_progress'].includes(t.status))) state = 'active';
    else state = tasks.length ? 'waiting' : 'ready';
    if ((state === 'active' || state === 'waiting' && pool.memberIds.length > 0) && pool.memberIds.length < pool.size) {
      pool = this.workers.checkpointPool({ ...pool, state });
      try { pool = this.ensureMembers(pool); } catch { state = 'error'; pool = { ...pool, error: 'Unable to prepare isolated peer workspaces; no task was executed' }; }
    }
    if (pool.state !== state) pool = this.workers.checkpointPool({ ...pool, state, error: state === 'error' ? pool.error : '' });
    return pool;
  }
}

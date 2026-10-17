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
    for (let index = 0; index < pool.size; index++) {
      const fresh = this.workers.pool();
      if (!fresh?.enabled) return fresh ?? pool;
      pool = fresh;
      if (pool.memberIds[index]) continue;
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

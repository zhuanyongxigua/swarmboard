// Wake persistent sessions from committed board events. Filesystem notifications
// cover independent MCP processes; the timer only catches missed notifications.
import { watch, existsSync, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Entry } from './store.js';
import { WorkerStore, approvalPauseMessage, type Worker } from './worker-store.js';
import { CodexSession, UncertainDelivery, type SessionAdapter } from './codex-session.js';
import { workerPrompt } from './worker-prompt.js';
import { WorkerPool } from './worker-pool.js';
import { PoolLiveness } from './pool-liveness.js';
import { PipelineEvents, type PipelineReader } from './pipeline-events.js';

export interface RuntimeOptions {
  databasePath: string; serverEntry: string;
  adapter?: (worker: Worker) => SessionAdapter;
  fallbackMs?: number; debounceMs?: number; keepAlive?: boolean; autoPool?: boolean;
  now?: () => number; idleMs?: number;
  pipelineReader?: PipelineReader;
}
export class EventRuntime {
  readonly workers: WorkerStore;
  readonly pool: WorkerPool;
  readonly ci: PipelineEvents;
  private liveness: PoolLiveness;
  private scanning?: Promise<void>;
  private token = randomUUID();
  private watcher?: FSWatcher;
  private fileWatchers = new Map<string, FSWatcher>();
  private fallback?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private running = new Map<string, Promise<void>>();
  private adapters = new Map<string, SessionAdapter>();
  private closed = false;
  private lastError = '';
  constructor(readonly board: Store, readonly options: RuntimeOptions) {
    this.workers = new WorkerStore(options.databasePath === ':memory:' ? ':memory:' : options.databasePath + '.runtime.sqlite');
    this.pool = new WorkerPool(this.workers, board, options.databasePath);
    this.liveness = new PoolLiveness(board, this.workers, options.idleMs ?? 10 * 60 * 1000);
    this.ci = new PipelineEvents(board, this.workers, options.pipelineReader, options.now, () => !this.closed && this.workers.owns(this.token));
  }
  start() {
    // Previously registered workspace bindings are already human-authorized.
    // Upgrade one legacy binding to a default peer pool, never guess a project
    // from task text or use the installed plugin directory as a working target.
    if (this.options.autoPool && !this.workers.pool()) {
      const legacy = this.workers.list().filter(w => !w.poolId);
      const source = process.env.SWARMBOARD_PROJECT_PATH || (legacy.length === 1 ? legacy[0]!.workspacePath : '');
      if (source) {
        try {
          const configured = this.pool.configure({ workspacePath: source });
          if (!process.env.SWARMBOARD_PROJECT_PATH && !legacy[0]!.enabled) this.pool.control({ expectedVersion: configured.version, enabled: false });
        } catch { if (!this.workers.pool()) this.lastError = 'Unable to initialize the default organization from the authorized project'; }
      }
    }
    if (this.options.databasePath !== ':memory:') {
      const boardName = basename(this.options.databasePath);
      const names = [boardName, boardName + '-wal', boardName + '.runtime.sqlite', boardName + '.runtime.sqlite-wal'];
      const attachFiles = () => {
        for (const name of names) {
          const path = dirname(this.options.databasePath) + '/' + name;
          if (this.fileWatchers.has(path) || !existsSync(path)) continue;
          try {
            const watcher = watch(path, kind => {
              if (kind === 'rename') { watcher.close(); this.fileWatchers.delete(path); attachFiles(); }
              this.notify();
            });
            watcher.on('error', () => { watcher.close(); this.fileWatchers.delete(path); });
            watcher.unref(); this.fileWatchers.set(path, watcher);
          } catch { /* A WAL may be removed between existence check and watch; recover on the next notification. */ }
        }
      };
      attachFiles();
      this.watcher = watch(dirname(this.options.databasePath), (_kind, filename) => {
        const name = filename?.toString();
        if (!name || names.includes(name)) { attachFiles(); this.notify(); }
      });
      this.watcher.on('error', () => { this.lastError = 'Filesystem notifications unavailable; recovery scan remains active'; });
      this.watcher.unref();
    }
    this.fallback = setInterval(() => this.notify(), this.options.fallbackMs ?? 30000);
    if (!this.options.keepAlive) this.fallback.unref(); this.notify();
  }
  notify() {
    if (this.closed || this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = undefined; void this.scan().catch(() => { this.lastError = 'Unable to read runtime state; next recovery scan will retry'; }); }, this.options.debounceMs ?? 50);
    this.debounce.unref();
  }
  status() {
    const activity = this.liveness.activity(this.workers.pool());
    if (activity.state === 'idle' && this.ci.hasPending()) activity.state = 'waiting';
    return { mode: 'events' as const, owner: this.workers.owner(), workers: this.workers.list(), pool: this.workers.pool(), activity, ciWatches: this.ci.list(), error: this.lastError };
  }
  hasWorkers() { return this.workers.list().length > 0 || this.workers.pool() !== null; }
  configurePool(input: unknown) { const pool = this.pool.configure(input); this.notify(); return pool; }
  controlPool(input: unknown) { const pool = this.pool.control(input); this.notify(); return pool; }
  register(input: unknown) {
    if (this.workers.pool()) throw new Error('Add members through the existing organization instead of registering an unattached worker');
    const worker = this.workers.register(input);
    this.board.registerAgent({ agentId: worker.id, name: worker.name });
    this.notify(); return worker;
  }
  requestReconcile(input: unknown) { const worker = this.workers.requestReconcile(input); this.notify(); return worker; }
  update(input: unknown) { const worker = this.workers.update(input); this.notify(); return worker; }
  private relevant(worker: Worker, entry: Entry) {
    if (worker.poolId) {
      if (entry.agentId === worker.id) return false;
      const pool = this.workers.pool();
      if (!pool || pool.id !== worker.poolId) return false;
      if (entry.recipientId) return entry.kind === 'MESSAGE' && entry.recipientId === worker.id;
      if (entry.taskId && pool.taskIds.length && !pool.taskIds.includes(entry.taskId)) return false;
      // A human goal is shared by the whole organization. Peers' claims,
      // counterexamples and patches are not limited to the card's assignee.
      if (entry.kind === 'MESSAGE' || ['FACT', 'FAIL', 'CLAIM', 'PATCH_SUMMARY'].includes(entry.kind)) return true;
      return entry.kind === 'OBSERVED' && !!entry.taskId;
    }
    if (entry.taskId && entry.kind === 'OBSERVED') {
      let completed = false;
      try { completed = JSON.parse(entry.detail).status === 'done'; } catch { /* Other observations are not task transitions. */ }
      if (completed && this.board.db.prepare('SELECT status FROM tasks WHERE id=?').get(entry.taskId)?.status === 'done') {
        // Completion can satisfy a dependency, including for the same worker.
        // Wake only workers with pending subscribed work; they recheck the actual prerequisites.
        return this.board.taskStates().some(task => !task.assignee && ['todo', 'blocked'].includes(task.status) && (!worker.taskIds.length || worker.taskIds.includes(task.id)));
      }
    }
    if (entry.agentId === worker.id) return false;
    if (entry.kind === 'MESSAGE') {
      if (entry.recipientId) return entry.recipientId === worker.id;
      return !entry.taskId || worker.taskIds.length === 0 || worker.taskIds.includes(entry.taskId);
    }
    if (!entry.taskId || worker.taskIds.length && !worker.taskIds.includes(entry.taskId)) return false;
    const task = this.board.db.prepare('SELECT status,assignee FROM tasks WHERE id=?').get(entry.taskId);
    // Facts about an owned task can unblock it; unrelated chatter never wakes every model.
    if (this.board.db.prepare('SELECT 1 FROM task_participants WHERE taskId=? AND agentId=? AND active=1').get(entry.taskId, worker.id)) return ['FACT', 'FAIL', 'PATCH_SUMMARY', 'OBSERVED'].includes(entry.kind);
    return task?.status === 'todo' && !task.assignee && entry.kind === 'OBSERVED';
  }
  private batch(worker: Worker) {
    const result: Entry[] = [];
    let cursor = worker.cursor;
    let hasMore = false;
    // Read bounded pages, retaining a cursor even when an event is irrelevant.
    for (let page = 0; page < 20; page++) {
      const entries = this.board.readEntries({ after: cursor, limit: 200 });
      hasMore = entries.hasMore;
      for (const entry of entries.items) {
        cursor = entry.id;
        if (this.relevant(worker, entry)) result.push(entry);
        if (result.length >= 50) return { events: result, cursor, hasMore: true };
      }
      cursor = entries.cursor;
      if (!entries.hasMore || result.length >= 50) break;
    }
    return { events: result, cursor, hasMore };
  }
  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this.scanOnce();
    try { await this.scanning; } finally { this.scanning = undefined; }
  }
  private async scanOnce() {
    if (this.closed || !this.hasWorkers() || !this.workers.acquire(this.token, process.pid)) return;
    await this.ci.poll(this.options.now?.() ?? Date.now());
    if (this.closed || !this.workers.owns(this.token)) return;
    const before = this.workers.pool();
    const busy = !!before && before.memberIds.some(id => this.running.has(id) || ['running', 'uncertain'].includes(this.workers.get(id).status));
    const pool = this.pool.sync(busy);
    const pending = busy || !!pool?.memberIds.some(id => { const batch = this.batch(this.workers.get(id)); return batch.events.length > 0 || batch.hasMore; });
    this.liveness.sync(pool, this.options.now?.() ?? Date.now(), pending, this.ci.list().filter(w => w.state === 'watching').map(w => w.taskId));
    for (const worker of this.workers.list()) {
      // A configured organization replaces legacy individual execution. Keep
      // its history, but do not run a fourth, unbounded worker alongside peers.
      if (pool && !worker.poolId) {
        if (this.running.has(worker.id)) continue;
        const adapter = this.adapters.get(worker.id);
        if (adapter) { await adapter.close(); this.adapters.delete(worker.id); }
        continue;
      }
      if (worker.status === 'error' || this.running.has(worker.id)) continue;
      if (worker.status === 'running' || worker.status === 'uncertain') {
        if (worker.status === 'running' || worker.reconcileRequested) {
          const saved = this.workers.save({ ...worker, status: 'uncertain', reconcileRequested: false,
            error: this.recoveryError(worker, 'Checking the prior delivery before any replay') });
          const promise = this.reconcile(saved).finally(() => { this.running.delete(worker.id); this.notify(); });
          this.running.set(worker.id, promise);
        }
        continue;
      }
      if (worker.poolId && (!pool || !pool.enabled || !['active', 'waiting'].includes(pool.state))) {
        const adapter = this.adapters.get(worker.id);
        if (adapter) { await adapter.close(); this.adapters.delete(worker.id); }
        continue;
      }
      if (!worker.enabled) continue;
      const batch = this.batch(worker);
      if (!batch.events.length) {
        if (batch.cursor !== worker.cursor) this.workers.save({ ...worker, cursor: batch.cursor });
        if (worker.poolId) { const adapter = this.adapters.get(worker.id); if (adapter) { await adapter.close(); this.adapters.delete(worker.id); } }
        continue;
      }
      const delivering = this.workers.save({ ...worker, status: 'running', deliveryId: randomUUID(), deliveryCursor: batch.cursor, error: '' });
      const promise = this.deliver(delivering, batch.events).finally(() => { this.running.delete(worker.id); this.notify(); });
      this.running.set(worker.id, promise);
    }
  }
  private session(worker: Worker) {
    const adapter = this.adapters.get(worker.id) ?? this.options.adapter?.(worker) ?? new CodexSession({
      databasePath: this.options.databasePath, serverEntry: this.options.serverEntry,
      workerId: worker.id, poolMember: !!worker.poolId,
      onApproval: () => { this.workers.pauseForApproval(worker.id); },
    });
    this.adapters.set(worker.id, adapter); return adapter;
  }
  private recoveryError(worker: Worker, diagnostic: string) {
    // Preserve the actionable approval cause while replacing transient
    // inspection diagnostics, so resolved uncertainty does not linger.
    const pause = !worker.enabled && worker.error.includes(approvalPauseMessage) ? approvalPauseMessage : '';
    return [pause, diagnostic].filter(Boolean).join('; ');
  }
  private async reconcile(worker: Worker) {
    try {
      const outcome = worker.threadId && worker.deliveryId ? await this.session(worker).inspect?.(worker.threadId, worker.turnId, worker.deliveryId) : 'unknown';
      if (!this.workers.owns(this.token)) return;
      const current = this.workers.get(worker.id);
      if (outcome === 'completed') this.workers.save({ ...current, status: 'idle', cursor: worker.deliveryCursor ?? worker.cursor, deliveryId: null, deliveryCursor: null, turnId: null,
        error: this.recoveryError(current, '') });
      else if (outcome === 'failed') this.workers.save({ ...current, status: 'error', error: this.recoveryError(current, 'Prior turn ended unsuccessfully; inspect its work before enabling a continuation') });
      else this.workers.save({ ...current, status: 'uncertain', error: this.recoveryError(current, 'Prior delivery may still be active or its result is unknown; inspect the saved thread/turn before retrying reconciliation') });
    } catch {
      if (this.workers.owns(this.token)) { const current = this.workers.get(worker.id); this.workers.save({ ...current, status: 'uncertain', error: this.recoveryError(current, 'Could not inspect the bound session; no duplicate turn was started') }); }
    }
  }
  private async deliver(worker: Worker, events: Entry[]) {
    const adapter = this.session(worker);
    let submitted = false;
    try {
      const threadId = await adapter.open(worker);
      if (this.closed || !this.workers.owns(this.token)) throw new Error('Runtime owner changed before delivery');
      let current = this.workers.get(worker.id);
      const pool = worker.poolId ? this.workers.pool() : null;
      // Opening/resuming a session is asynchronous. Recheck human stop and goal
      // completion after it returns, before submitting a new model turn.
      const poolStopped = !!worker.poolId && (!pool?.enabled || !this.board.taskStates().some(t =>
        (!pool.taskIds.length || pool.taskIds.includes(t.id)) && !['done', 'canceled'].includes(t.status)));
      if (!current.enabled || poolStopped) { this.workers.save({ ...current, threadId, status: 'idle', deliveryId: null, deliveryCursor: null }); return; }
      this.workers.save({ ...current, threadId });
      submitted = true;
      await adapter.run(threadId, workerPrompt(worker, worker.deliveryId!, events, worker.poolId ? this.workers.pool() : null), turnId => {
        const latest = this.workers.get(worker.id); this.workers.save({ ...latest, turnId });
      });
      if (!this.workers.owns(this.token)) return;
      current = this.workers.get(worker.id);
      this.workers.save({ ...current, status: 'idle', cursor: worker.deliveryCursor!, deliveryId: null, deliveryCursor: null, turnId: null });
    } catch (error) {
      if (!this.workers.owns(this.token)) return;
      const current = this.workers.get(worker.id);
      this.workers.save({ ...current, status: submitted || error instanceof UncertainDelivery ? 'uncertain' : 'error', error: error instanceof Error ? error.message.slice(0, 500) : 'Session delivery failed' });
      await adapter.close(); this.adapters.delete(worker.id);
    }
  }
  async close() {
    this.closed = true; this.watcher?.close(); for (const watcher of this.fileWatchers.values()) watcher.close(); clearInterval(this.fallback); clearTimeout(this.debounce);
    await Promise.all([...this.adapters.values()].map(adapter => adapter.close()));
    await this.scanning;
    await Promise.all(this.running.values());
    this.workers.release(this.token); this.workers.close();
  }
}

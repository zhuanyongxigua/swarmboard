// Wake persistent sessions from committed board events. Filesystem notifications
// cover independent MCP processes; the timer only catches missed notifications.
import { watch, existsSync, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, Store, type Entry } from './store.js';
import { WorkerStore, approvalPauseMessage, type Worker } from './worker-store.js';
import { UncertainDelivery, type HarnessBackend, type SessionAdapter } from './harness/contract.js';
import { resolveHarness } from './harness/registry.js';
import { workerPrompt } from './worker-prompt.js';
import { boardInstructions } from './board-instructions.js';
import { WorkerPool } from './worker-pool.js';
import { PoolLiveness } from './pool-liveness.js';
import { SeatCheckStore } from './seat-check-store.js';
import { tick as tickSeatChecks, pendingWakes, type SeatRecord, type SeatSnapshot, type SeatCheckWake } from './seat-checks.js';
import { createNotificationDispatcher } from './notification-dispatch.js';
import { PipelineEvents, type PipelineReader } from './pipeline-events.js';
import { ExecutionGrants } from './execution-grants.js';
import { CollaboratorStore } from './collaborators.js';
import { notificationDelay, notificationSettings, type NotificationOptions } from './notification-batch.js';
import { actionableWake, boardPreferencesChanged, wakePolicySettings, type WakePolicyOptions } from './wake-policy.js';

export interface RuntimeOptions extends NotificationOptions, WakePolicyOptions {
  databasePath: string; serverEntry: string;
  adapter?: (worker: Worker) => SessionAdapter;
  backend?: HarnessBackend;
  fallbackMs?: number; debounceMs?: number; keepAlive?: boolean; autoPool?: boolean;
  now?: () => number; idleMs?: number;
  /**
   * Per-session five-minute task checks (human plan 2026-10-21). Defaults to five
   * minutes; `0` disables them and restores the legacy global idle reminder.
   * When enabled, the global reminder is not constructed at all.
   */
  sessionCheckMs?: number;
  pipelineReader?: PipelineReader;
  /** Host-control surface only: never watch, claim ownership, scan or deliver,
   *  so a management process can expose host tools beside a live owner. */
  managementOnly?: boolean;
}
export class EventRuntime {
  readonly workers: WorkerStore;
  readonly pool: WorkerPool;
  readonly ci: PipelineEvents;
  readonly grants: ExecutionGrants;
  readonly collaborators: CollaboratorStore;
  private liveness?: PoolLiveness;
  private seatChecks?: { store: SeatCheckStore; intervalMs: number };
  private notificationDispatcher: ReturnType<typeof createNotificationDispatcher>;
  private scanning?: Promise<void>;
  private token = randomUUID();
  private watcher?: FSWatcher;
  private fileWatchers = new Map<string, FSWatcher>();
  private fallback?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private batchWake?: ReturnType<typeof setTimeout>;
  private notificationPolicy;
  private readonly wakePolicy: ReturnType<typeof wakePolicySettings>;
  private nextBatchWakeAt: number | null = null;
  private running = new Map<string, Promise<void>>();
  private adapters = new Map<string, SessionAdapter>();
  private closed = false;
  private lastError = '';
  private readonly backend: HarnessBackend;
  private readonly statePath: string;
  constructor(readonly board: Store, readonly options: RuntimeOptions) {
    this.notificationPolicy = notificationSettings(options);
    // Parsed in the constructor so an invalid policy refuses startup, matching
    // the notification configuration contract.
    this.wakePolicy = wakePolicySettings(options);
    this.statePath = options.databasePath === ':memory:' ? ':memory:' : options.databasePath + '.runtime.sqlite';
    this.backend = options.backend ?? resolveHarness();
    this.workers = new WorkerStore(this.statePath);
    this.pool = new WorkerPool(this.workers, board, options.databasePath);
    this.grants = new ExecutionGrants(board, this.workers);
    this.collaborators = new CollaboratorStore(this.statePath);
    // Reminders are also offered to registered notification channels as durable
    // intents; the core never delivers or starts anything itself.
    this.notificationDispatcher = createNotificationDispatcher(board, this.collaborators);
    const sessionCheckMs = options.sessionCheckMs ?? 5 * 60 * 1000;
    if (sessionCheckMs > 0) {
      // Per-session checks replace the global reminder; constructing the legacy
      // watchdog as well would be a second periodic wakeup for the same seat.
      this.seatChecks = { store: new SeatCheckStore(this.workers.db), intervalMs: sessionCheckMs };
    } else {
      this.liveness = new PoolLiveness(board, this.workers, options.idleMs ?? 5 * 60 * 1000,
        entry => { this.notificationDispatcher.dispatch(entry); });
    }
    this.ci = new PipelineEvents(board, this.workers, options.pipelineReader, options.now, () => !this.closed && this.workers.owns(this.token));
  }
  start() {
    // A management-only process exists to expose host tools; starting event
    // delivery beside the live owner would compete for sessions and ownership.
    if (this.options.managementOnly) throw new Error('A management-only runtime never starts watchers, ownership or deliveries');
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
    // Host edits from a management process reach the live owner through its own
    // file watchers; this process must never schedule a scan of its own.
    if (this.options.managementOnly || this.closed || this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = undefined; void this.scan().catch(() => { this.lastError = 'Unable to read runtime state; next recovery scan will retry'; }); }, this.options.debounceMs ?? 50);
    this.debounce.unref();
  }
  /**
   * One per-session check pass (human plan 2026-10-21). Seats come from the active
   * pool plus every enabled registered channel that declares durableDelivery.
   * Records are persisted before any entry is produced, so a crash re-emits rather
   * than loses a check, and a repeated scan cannot emit the same dueAt twice.
   */
  private runSeatChecks(pool: ReturnType<WorkerStore['pool']>, now: number) {
    const seatChecks = this.seatChecks;
    if (!seatChecks) return;
    const seats: SeatSnapshot[] = [];
    for (const memberId of pool?.memberIds ?? []) {
      const worker = this.workers.get(memberId);
      if (!worker?.enabled) continue;
      // Native seats are identified by their worker id and the backend thread it
      // currently owns; a rebind changes threadId, which must not resume silently.
      seats.push({ memberId, sessionRef: worker.threadId ?? `worker:${worker.id}`, active: worker.status !== 'error',
        busy: ['running', 'uncertain'].includes(worker.status) });
    }
    for (const adapter of this.notificationDispatcher.adapters()) {
      if (!adapter.enabled || !adapter.capabilities.includes('durableDelivery')) continue;
      for (const member of adapter.members) {
        seats.push({ memberId: member.memberId, sessionRef: member.sessionRef, active: true, busy: false,
          adapterId: adapter.id, registrationVersion: adapter.version });
      }
    }
    // Outstanding checks from an earlier scan (or an earlier process) are retried
    // first: the pending entry is durable, so a crash between save and publish
    // re-publishes the same due instead of silently dropping the check.
    const records = seatChecks.store.list();
    const owed = pendingWakes(records);
    const result = tickSeatChecks({
      now, organizationActive: !!pool?.enabled && pool.state === 'active',
      seats, goals: this.board.taskStates(), records, intervalMs: seatChecks.intervalMs,
    });
    // Persist first, including the pending outbox entry, before anything is published.
    seatChecks.store.save(result.records);
    for (const wake of [...owed, ...result.wake]) {
      if (!this.publishSeatCheck(wake, pool)) continue;
      seatChecks.store.confirmPending(wake);
    }
  }

  /** Produce one directed SESSION_TASK_CHECK entry; the dispatcher decides delivery. */
  private publishSeatCheck(wake: SeatCheckWake, pool: ReturnType<WorkerStore['pool']>): boolean {
    const agentId = 'runtime-' + (pool?.id ?? 'session-checks');
    if (!this.board.db.prepare('SELECT id FROM agents WHERE id=?').get(agentId)) {
      this.board.registerAgent({ agentId, name: 'Swarmboard runtime' });
    }
    const entry = this.board.publishSystemEntryOnce({
      agentId,
      kind: 'MESSAGE',
      summary: 'SESSION_TASK_CHECK: review your authorized goals and continue useful work',
      detail: JSON.stringify({
        kind: 'SESSION_TASK_CHECK',
        memberId: wake.memberId, sessionRef: wake.sessionRef, dueAt: wake.dueAt, goalIds: wake.goalIds,
        ...(wake.adapterId ? { adapterId: wake.adapterId } : {}),
        ...(wake.registrationVersion !== undefined ? { registrationVersion: wake.registrationVersion } : {}),
        discovery: 'Use task_list to discover the current goals in your scope; this list is a bounded sample.',
        instruction: 'INTERNAL_ONLY. Review the authorized task list. If any goal is unclaimed, in progress or awaiting review, continue useful work with peers; after finishing a contribution, look again. Blocked, done and canceled goals need no action. If you are truly blocked on a human decision or permission, state the precise blocker. Do not merely acknowledge this message, poll, invent success, launch external harnesses or create tasks. Do not reply to the runtime identity.',
      }),
      ...(wake.memberId ? { recipientId: wake.memberId } : {}),
    });
    this.notificationDispatcher.dispatch(entry);
    return true;
  }

  status() {
    const activity = this.liveness
      ? this.liveness.activity(this.workers.pool())
      : (() => {
          // Per-session checks own the "wakeup" decision now; the legacy watchdog
          // is only reported as inactive so status consumers keep the same shape.
          const peers = this.workers.pool()?.memberIds.map(id => this.workers.get(id)) ?? this.workers.list();
          return {
            members: peers.length,
            draining: peers.filter(w => w.retirement?.state === 'draining').length,
            running: peers.filter(w => w.status === 'running').length,
            idle: peers.filter(w => w.enabled && w.status === 'idle').length,
            state: 'idle' as const,
            executionMode: 'internal-only' as const,
            watchdog: { state: 'inactive' as const, attempts: 0, nextWakeAt: null },
          };
        })();
    if (activity.state === 'idle' && this.ci.hasPending()) activity.state = 'waiting';
    return { mode: this.options.managementOnly ? 'management' as const : 'events' as const,
      backend: { id: this.backend.id, displayName: this.backend.displayName, deterministic: this.backend.deterministic === true, capabilities: this.backend.capabilities },
      owner: this.workers.owner(), workers: this.workers.list(), pool: this.workers.pool(), collaborators: this.collaborators.list(), activity, executionGrants: this.grants.list(), ciWatches: this.ci.list(), notifications: { ...this.notificationPolicy, nextWakeAt: this.nextBatchWakeAt }, wakePolicy: this.wakePolicy, error: this.lastError };
  }
  configureExecutionGrant(input: unknown) {
    const grant = this.grants.configure(input);
    const agentId = `host-grants:${grant.poolId}`;
    if (!this.board.db.prepare('SELECT id FROM agents WHERE id=?').get(agentId)) this.board.registerAgent({ agentId, name: 'Host execution policy' });
    this.board.publishSystemEntryOnce({ agentId, taskId: grant.taskId, kind: 'OBSERVED', summary: 'Host execution grant updated', detail: JSON.stringify({ version: grant.version, enabled: grant.enabled }) });
    this.notify(); return grant;
  }
  hasWorkers() { return this.workers.list().length > 0 || this.workers.pool() !== null; }
  // Host-only admission/lifecycle for external collaborators. The runtime never
  // delivers turns to them; it registers their stable board identity and keeps
  // their scoped record for the collaborator MCP role.
  configureCollaborator(input: unknown) {
    const { collaborator } = this.collaborators.configure(input, this.board, this.workers);
    // Revocation/disable cancels queued notifications instead of leaving them to
    // be delivered (or confirmed) after the identity lost its admission.
    if (!collaborator.enabled || collaborator.revokedAt) {
      this.notificationDispatcher.cancelMember(collaborator.id, collaborator.revokedAt ? 'collaborator-revoked' : 'collaborator-disabled');
    }
    // The sidecar commit and the board registration are separate stores. If an
    // earlier attempt committed the record but failed before registering, any
    // later successful configure — including a same-id retry after a restart —
    // idempotently repairs the missing identity with exactly one join notice,
    // instead of leaving heartbeat NOT_FOUND for an admitted collaborator.
    if (!this.board.db.prepare('SELECT id FROM agents WHERE id=?').get(collaborator.id)) {
      try { this.board.registerAgent({ agentId: collaborator.id, name: collaborator.name }); }
      catch (error) { if (!(error instanceof AppError && error.code === 'AGENT_EXISTS')) throw error; }
    }
    this.notify(); return collaborator;
  }
  configurePool(input: unknown) { const pool = this.pool.configure(input); this.notify(); return pool; }
  configureCapacity(input: unknown) { const pool = this.pool.capacity(input); this.notify(); return pool; }
  controlPool(input: unknown) { const pool = this.pool.control(input); this.notify(); return pool; }
  reducePool(input: unknown) { const result = this.pool.reduce(input); this.notify(); return result; }
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
      if (boardPreferencesChanged(entry)) return true;
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
    if (boardPreferencesChanged(entry)) return true;
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
        // Reference-quiet keeps ordinary peer evidence as durable context the
        // member reads through context_read/search instead of a model turn;
        // it never filters explicit messages, failures or control changes.
        if (this.relevant(worker, entry) && (this.wakePolicy === 'all' || actionableWake(entry))) result.push(entry);
        if (result.length >= 50) return { events: result, cursor, hasMore: true };
      }
      cursor = entries.cursor;
      if (!entries.hasMore || result.length >= 50) break;
    }
    return { events: result, cursor, hasMore };
  }
  async scan() {
    // Ownership acquisition and delivery belong to the live owner only; even a
    // direct scan call must not turn a management process into a competitor.
    if (this.options.managementOnly) return;
    if (this.scanning) return this.scanning;
    this.scanning = this.scanOnce();
    try { await this.scanning; } finally { this.scanning = undefined; }
  }
  private async scanOnce() {
    // Ownership belongs to the live owner even on a board with no native
    // workers: registered external channels still need their events dispatched.
    if (this.closed || !this.workers.acquire(this.token, process.pid)) return;
    if (!this.hasWorkers()) {
      try {
        this.notificationDispatcher.dispatchPending();
      } catch {
        this.lastError = 'Unable to dispatch notifications; next scan will retry';
      }
      return;
    }
    clearTimeout(this.batchWake); this.nextBatchWakeAt = null;
    await this.ci.poll(this.options.now?.() ?? Date.now());
    if (this.closed || !this.workers.owns(this.token)) return;
    const before = this.workers.pool();
    const busy = !!before && before.memberIds.some(id => this.running.has(id) || ['running', 'uncertain'].includes(this.workers.get(id).status));
    const pool = this.pool.sync(busy);
    // Only dispatchable members' unread events gate recovery: a protected
    // member's stale cursor (human/approval pause, error, unresolved delivery)
    // must not permanently block the healthy subset. Busy covers running and
    // uncertain members regardless of enabled, so unknown deliveries still
    // suppress recovery.
    const dispatchable = new Set(pool?.memberIds.filter(id => { const member = this.workers.get(id); return member.enabled && member.status === 'idle'; }) ?? []);
    const pending = busy || !!pool?.memberIds.some(id => { if (!dispatchable.has(id)) return false; const batch = this.batch(this.workers.get(id)); return batch.events.length > 0 || batch.hasMore; });
    const now = this.options.now?.() ?? Date.now();
    this.liveness?.sync(pool, now, pending, this.ci.list().filter(w => w.state === 'watching').map(w => w.taskId));
    if (this.seatChecks) this.runSeatChecks(pool, now);
    // Ordinary task/shared events reach registered channels through the same
    // dispatcher as reminders. No channels registered means no extra work.
    this.notificationDispatcher.dispatchPending();
    for (const worker of this.workers.list()) {
      // Retired history and unlisted preparations are not delivery targets.
      if (worker.poolId && (!pool || !pool.memberIds.includes(worker.id))) {
        if (this.running.has(worker.id)) continue;
        const adapter = this.adapters.get(worker.id);
        if (adapter) { await adapter.close(); this.adapters.delete(worker.id); }
        continue;
      }
      // A configured organization replaces legacy individual execution. Keep
      // its history, but do not run a fourth, unbounded worker alongside peers.
      if (pool && !worker.poolId) {
        if (this.running.has(worker.id)) continue;
        const adapter = this.adapters.get(worker.id);
        if (adapter) { await adapter.close(); this.adapters.delete(worker.id); }
        continue;
      }
      // Session/turn identifiers from another backend must never be silently
      // consumed here; only an unbound worker (no identifiers yet) may rebind.
      if (worker.backendId !== this.backend.id && (worker.threadId || worker.turnId || worker.deliveryId)) {
        const adapter = this.adapters.get(worker.id);
        if (adapter) { await adapter.close(); this.adapters.delete(worker.id); }
        const diagnostic = `Bound session belongs to harness backend '${worker.backendId}', not the configured '${this.backend.id}'`;
        if (worker.status === 'running' || worker.status === 'uncertain') {
          // An unresolved delivery must never become a restartable error:
          // keep the uncertain state, delivery phase and identifiers so the
          // original backend can inspect and reconcile them before any
          // resubmission; worker_update keeps refusing to enable it.
          if (worker.status !== 'uncertain' || !worker.error.includes(diagnostic)) this.workers.save({ ...worker, status: 'uncertain',
            error: this.recoveryError(worker, `${diagnostic}; the unresolved delivery keeps its checkpoints and is inspected after that backend is restored, never replayed here`) });
        } else if (worker.status !== 'error') this.workers.save({ ...worker, status: 'error',
          error: this.recoveryError(worker, `${diagnostic}; restore that backend configuration before reusing this worker's session identifiers`) });
        continue;
      }
      if (worker.status === 'error' || this.running.has(worker.id)) continue;
      if (worker.status === 'running' || worker.status === 'uncertain') {
        if (worker.status === 'running' || worker.reconcileRequested) {
          const saved = this.workers.save({ ...worker, status: 'uncertain', reconcileRequested: false,
            // Recognize only the exact diagnostic generated by the old resume
            // timeout path, before replacing it with inspection progress text.
            deliveryPhase: worker.deliveryPhase ?? (worker.threadId && !worker.turnId && worker.error === 'thread/resume timed out; delivery outcome is unknown' ? 'opening' : undefined),
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
      const now = this.options.now?.() ?? Date.now();
      const delay = notificationDelay(batch.events, this.notificationPolicy, now, batch.hasMore);
      if (delay > 0) {
        // Leave the delivery cursor unchanged. Recompute from committed event
        // timestamps after restart; notifications never acknowledge execution.
        const deadline = now + delay;
        if (this.nextBatchWakeAt === null || deadline < this.nextBatchWakeAt) this.nextBatchWakeAt = deadline;
        continue;
      }
      const delivering = this.workers.save({ ...worker, status: 'running', deliveryId: randomUUID(), deliveryCursor: batch.cursor, turnId: null, deliveryPhase: 'opening', error: '', backendId: this.backend.id });
      const promise = this.deliver(delivering, batch.events).finally(() => { this.running.delete(worker.id); this.notify(); });
      this.running.set(worker.id, promise);
    }
    if (this.nextBatchWakeAt !== null) {
      this.batchWake = setTimeout(() => { this.nextBatchWakeAt = null; this.notify(); }, Math.max(1, this.nextBatchWakeAt - (this.options.now?.() ?? Date.now())));
      if (!this.options.keepAlive) this.batchWake.unref();
    }
  }
  private session(worker: Worker) {
    const adapter = this.adapters.get(worker.id) ?? this.options.adapter?.(worker) ?? this.backend.createSession({
      databasePath: this.options.databasePath, statePath: this.statePath, serverEntry: this.options.serverEntry,
      worker,
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
      // Opening phase with no submitted turn is deterministically unreached:
      // threadId is persisted before run is ever called, so opening without a
      // turnId means no model turn exists whether the session never opened
      // (threadId null) or its resume timed out pre-submission. Both clear
      // without any RPC; identifiers stay for inspection.
      if (worker.deliveryPhase === 'opening' && !worker.turnId) {
        this.workers.save({ ...this.workers.get(worker.id), status: 'error',
          error: this.recoveryError(worker, 'Session recovery ended before turn/start; no model turn was submitted. Resolve the connection error, then enable this worker to retry queued events') });
        this.workers.resolveRetirementDelivery(worker.id, worker.deliveryId, 'not-submitted');
        return;
      }
      const outcome = worker.threadId && worker.deliveryId ? await this.session(worker).inspect?.(worker.threadId, worker.turnId, worker.deliveryId) : 'unknown';
      if (!this.workers.owns(this.token)) return;
      const current = this.workers.get(worker.id);
      if (outcome === 'completed') this.workers.save({ ...current, status: 'idle', cursor: worker.deliveryCursor ?? worker.cursor, deliveryId: null, deliveryCursor: null, turnId: null, deliveryPhase: undefined,
        error: this.recoveryError(current, '') });
      else if (outcome === 'failed') {
        this.workers.save({ ...current, status: 'error', error: this.recoveryError(current, 'Prior turn ended unsuccessfully; inspect its work before enabling a continuation') });
        this.workers.resolveRetirementDelivery(current.id, current.deliveryId, 'failed');
      }
      else this.workers.save({ ...current, status: 'uncertain', error: this.recoveryError(current, 'Prior delivery may still be active or its result is unknown; inspect the saved thread/turn before retrying reconciliation') });
    } catch {
      if (this.workers.owns(this.token)) { const current = this.workers.get(worker.id); this.workers.save({ ...current, status: 'uncertain', error: this.recoveryError(current, 'Could not inspect the bound session; no duplicate turn was started') }); }
    }
  }
  private async deliver(worker: Worker, events: Entry[]) {
    const adapter = this.session(worker);
    let submitted = false;
    try {
      if (!this.options.adapter && !this.backend.deterministic && this.backend.capabilities.sessionInstructions !== true)
        throw new Error(`Harness backend '${this.backend.id}' does not support current session instructions; no model turn was submitted`);
      let current = this.workers.get(worker.id);
      let threadId = current.threadId, ready = false;
      // Session preparation is asynchronous. Persist the binding, then verify
      // both human control and the exact preference revision after every await.
      // Continuous edits fail before submission rather than spinning forever.
      for (let attempt = 0; attempt < 3; attempt++) {
        const prompts = this.board.readPromptSettings();
        const instructions = boardInstructions(prompts.systemPrompt, prompts.userPrompt);
        const { revision } = instructions;
        threadId = await adapter.open(current, instructions, openedThread => {
          if (this.closed || !this.workers.owns(this.token)) throw new Error('Runtime owner changed before session preparation');
          // Preserve an acknowledged identity even if later instruction
          // preparation fails. Retrying must resume this same session.
          current = this.workers.save({ ...this.workers.get(worker.id), threadId: openedThread });
        });
        if (this.closed || !this.workers.owns(this.token)) throw new Error('Runtime owner changed before delivery');
        current = this.workers.get(worker.id);
        const pool = worker.poolId ? this.workers.pool() : null;
        const poolStopped = !!worker.poolId && (!pool?.enabled || !this.board.taskStates().some(t =>
          (!pool.taskIds.length || pool.taskIds.includes(t.id)) && !['done', 'canceled'].includes(t.status)));
        if (!current.enabled || poolStopped) { this.workers.save({ ...current, threadId, status: 'idle', deliveryId: null, deliveryCursor: null, turnId: null, deliveryPhase: undefined }); return; }
        current = this.workers.save({ ...current, threadId });
        const latest = this.board.readPromptSettings();
        if (boardInstructions(latest.systemPrompt, latest.userPrompt).revision === revision) { ready = true; break; }
      }
      if (!ready || !threadId) throw new Error('Preferences kept changing during session preparation; no model turn was submitted. Enable this worker to retry queued events');
      // No asynchronous gap separates the final snapshot/control checks from
      // the submission checkpoint and adapter.run. Later edits queue next turn.
      const prompt = workerPrompt(worker.deliveryId!, events, this.backend.sessionIntro(worker), worker.poolId ? this.workers.pool() : null, worker.poolId ? this.grants.active() : []);
      this.workers.save({ ...current, threadId, deliveryPhase: 'submitting' });
      submitted = true;
      await adapter.run(threadId, prompt, turnId => {
        const latest = this.workers.get(worker.id); this.workers.save({ ...latest, turnId, deliveryPhase: 'running' });
      });
      if (!this.workers.owns(this.token)) return;
      current = this.workers.get(worker.id);
      this.workers.save({ ...current, status: 'idle', cursor: worker.deliveryCursor!, deliveryId: null, deliveryCursor: null, turnId: null, deliveryPhase: undefined });
    } catch (error) {
      if (!this.workers.owns(this.token)) return;
      const current = this.workers.get(worker.id);
      this.workers.save({ ...current, status: submitted || error instanceof UncertainDelivery ? 'uncertain' : 'error', error: error instanceof Error ? error.message.slice(0, 500) : 'Session delivery failed' });
      await adapter.close(); this.adapters.delete(worker.id);
    }
  }
  async close() {
    this.closed = true; this.watcher?.close(); for (const watcher of this.fileWatchers.values()) watcher.close(); clearInterval(this.fallback); clearTimeout(this.debounce); clearTimeout(this.batchWake);
    await Promise.all([...this.adapters.values()].map(adapter => adapter.close()));
    await this.scanning;
    await Promise.all(this.running.values());
    this.workers.release(this.token); this.workers.close();
  }
}

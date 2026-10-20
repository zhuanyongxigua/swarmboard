// Recover idle organizations with durable messages to existing peers.
// Reminders repeat while unfinished goals remain and the organization is active:
// they are a heartbeat for a stranded board, not a planner, a per-task model
// timer, or a failure verdict. Nothing here inspects how long a single turn has
// been running; only organization idleness between turns is observed.
import { randomUUID } from 'node:crypto';
import type { Entry, Store } from './store.js';
import type { Pool, WorkerStore } from './worker-store.js';

export interface Liveness {
  fingerprint: string;
  attempts: number;
  idleSince: number | null;
  // 'attention' is only ever read from records written by older builds; the
  // current watchdog never writes it, so a legacy value cannot silence recovery.
  state: 'inactive' | 'watching' | 'nudged' | 'attention';
  pending: Omit<Entry, 'id' | 'createdAt'> | null;
}
export class PoolLiveness {
  constructor(private board: Store, private workers: WorkerStore, private idleMs: number,
    /** Called with each published recovery reminder so registered notification
     *  channels can enqueue a durable intent. Never used to start work. */
    private onSystemEntry?: (entry: Entry) => void) {}
  private tasks(pool: Pool) { return this.board.taskStates().filter(t => !pool.taskIds.length || pool.taskIds.includes(t.id)); }
  sync(pool: Pool | null, now: number, queuedOrBusy: boolean, awaitingGoalIds: string[] = []) {
    if (!pool) return;
    const tasks = this.tasks(pool).filter(t => !awaitingGoalIds.includes(t.id));
    // Only a goal revision or an explicit human pool control resets the retry
    // budget. Heartbeats, acknowledgements and self-reported facts do not prove
    // forward progress and cannot keep a stranded goal alive indefinitely.
    const fingerprint = JSON.stringify([pool.id, pool.version, tasks.map(t => [t.id, t.version]).sort()]);
    let value: Liveness = this.workers.liveness() ?? { fingerprint, attempts: 0, idleSince: null, state: 'inactive', pending: null };
    if (value.fingerprint !== fingerprint) value = { fingerprint, attempts: 0, idleSince: null, state: 'inactive', pending: null };
    const peers = pool.memberIds.map(id => this.workers.get(id));
    // A protected member (human pause, approval wait, error, unresolved
    // delivery) never receives recovery and never blocks the healthy subset;
    // genuine activity still suppresses recovery through queuedOrBusy.
    const healthy = peers.filter(w => w.enabled && w.status === 'idle');
    const eligible = tasks.some(t => ['todo','in_progress'].includes(t.status)) && pool.enabled && pool.state === 'active' && healthy.length > 0;
    if (!eligible || queuedOrBusy) {
      this.workers.saveLiveness({ ...value, idleSince: null, state: 'inactive' }); return;
    }
    if (!value.pending) {
      if (value.idleSince === null) value = { ...value, idleSince: now, state: 'watching' };
      else if (now - value.idleSince >= this.idleMs) {
        // Rotate recovery over dispatchable members only; a protected peer
        // must not consume a nudge it can never act on. There is no attempt
        // budget: the counter only rotates recipients and reports activity.
        const recipientId = healthy[value.attempts % healthy.length]!.id;
        value = { ...value, attempts: value.attempts + 1, idleSince: null, state: 'nudged', pending: {
          agentId: 'runtime-' + pool.id, kind: 'MESSAGE',
          summary: 'IDLE_RECOVERY: inspect stranded human goals and continue useful work',
          detail: JSON.stringify({ signalId: randomUUID(), unfinishedGoalCount: tasks.filter(t => ['todo', 'in_progress'].includes(t.status)).length,
            goalIds: tasks.filter(t => ['todo', 'in_progress'].includes(t.status)).slice(0, 20).map(t => t.id),
            goalIdsHasMore: tasks.filter(t => ['todo', 'in_progress'].includes(t.status)).length > 20,
            discovery: 'Use task_list pages to discover current goals; these IDs are only a bounded sample. This reminder assigns no goal or order.',
            instruction: 'INTERNAL_ONLY. Read current goals and shared evidence. Choose useful authorized work with existing peers. If truly waiting on a missing prerequisite or acceptance, publish the concrete blocker and use blocked/in_review as an active participant. Do not merely acknowledge this message, poll, invent success, launch external harnesses or create tasks. Do not reply to the runtime identity. While unfinished goals remain and the organization stays active this reminder repeats after each idle interval; it is not a stop signal and assigns no goal or order. Task states remain unchanged.' }),
          ...(recipientId ? { recipientId } : {}),
        } };
        // Persist first, publish once, then confirm: either crash window is
        // recoverable without losing or duplicating a wakeup event.
        this.workers.saveLiveness(value);
      }
    }
    if (value.pending) {
      if (!this.board.db.prepare('SELECT id FROM agents WHERE id=?').get(value.pending.agentId)) this.board.registerAgent({ agentId: value.pending.agentId, name: 'Swarmboard runtime' });
      const published = this.board.publishSystemEntryOnce(value.pending);
      this.onSystemEntry?.(published);
      value = { ...value, pending: null };
    }
    this.workers.saveLiveness(value);
  }
  activity(pool: Pool | null) {
    const peers = pool ? pool.memberIds.map(id => this.workers.get(id)) : this.workers.list();
    const running = peers.filter(w => w.status === 'running').length;
    const idle = peers.filter(w => w.enabled && w.status === 'idle').length;
    const attention = peers.some(w => !w.enabled || w.status === 'error' || w.status === 'uncertain');
    const watchdog = this.workers.liveness();
    const state = !pool ? (running ? 'running' : attention ? 'attention' : 'idle')
      : ['stopped', 'stopping', 'completed', 'error'].includes(pool.state) ? pool.state
      : running ? 'running' : attention ? 'attention'
      : ['waiting','ready'].includes(pool.state) ? pool.state : 'idle';
    return { members: peers.length, draining: peers.filter(w => w.retirement?.state === 'draining').length, running, idle, state, executionMode: 'internal-only' as const,
      watchdog: { state: watchdog?.state ?? 'inactive', attempts: watchdog?.attempts ?? 0,
        nextWakeAt: pool?.enabled && watchdog?.idleSince !== null && watchdog?.idleSince !== undefined ? new Date(watchdog.idleSince + this.idleMs).toISOString() : null },
    };
  }
}

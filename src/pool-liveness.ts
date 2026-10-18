// Recover idle organizations with bounded durable messages to existing peers.
// This is an execution safeguard, not a planner or a per-task model timer.
import { randomUUID } from 'node:crypto';
import type { Entry, Store } from './store.js';
import type { Pool, WorkerStore } from './worker-store.js';

export interface Liveness {
  fingerprint: string;
  attempts: number;
  idleSince: number | null;
  state: 'inactive' | 'watching' | 'nudged' | 'attention';
  pending: Omit<Entry, 'id' | 'createdAt'> | null;
}
export class PoolLiveness {
  constructor(private board: Store, private workers: WorkerStore, private idleMs: number) {}
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
      this.workers.saveLiveness({ ...value, idleSince: null, state: value.state === 'attention' ? 'attention' : 'inactive' }); return;
    }
    if (!value.pending && value.state !== 'attention') {
      if (value.idleSince === null) value = { ...value, idleSince: now, state: 'watching' };
      else if (now - value.idleSince >= this.idleMs) {
        const attention = value.attempts >= 2;
        // Rotate recovery over dispatchable members only; a protected peer
        // must not consume a nudge it can never act on.
        const recipientId = attention ? undefined : healthy[value.attempts % healthy.length]!.id;
        value = { ...value, attempts: value.attempts + (attention ? 0 : 1), idleSince: null, state: attention ? 'attention' : 'nudged', pending: {
          agentId: 'runtime-' + pool.id, kind: attention ? 'OBSERVED' : 'MESSAGE',
          summary: attention ? 'IDLE_ATTENTION: goals remain idle after two recovery attempts' : 'IDLE_RECOVERY: inspect stranded human goals and continue useful work',
          detail: JSON.stringify({ signalId: randomUUID(), unfinishedGoalCount: tasks.filter(t => ['todo', 'in_progress'].includes(t.status)).length,
            goalIds: tasks.filter(t => ['todo', 'in_progress'].includes(t.status)).slice(0, 20).map(t => t.id),
            goalIdsHasMore: tasks.filter(t => ['todo', 'in_progress'].includes(t.status)).length > 20,
            discovery: 'Use task_list pages to discover current goals; these IDs are only a bounded sample. This reminder assigns no goal or order.',
            instruction: attention ? 'Human attention needed. No further automatic idle nudges until a goal revision or explicit pool resume. Task states remain unchanged.'
              : 'INTERNAL_ONLY. Read current goals and shared evidence. Choose useful authorized work with existing peers. If truly waiting on a missing prerequisite or acceptance, publish the concrete blocker and use blocked/in_review as an active participant. Do not merely acknowledge this message, poll, invent success, launch external harnesses or create tasks. Do not reply to the runtime identity.' }),
          ...(recipientId ? { recipientId } : {}),
        } };
        // Persist first, publish once, then confirm: either crash window is
        // recoverable without losing or duplicating a wakeup event.
        this.workers.saveLiveness(value);
      }
    }
    if (value.pending) {
      if (!this.board.db.prepare('SELECT id FROM agents WHERE id=?').get(value.pending.agentId)) this.board.registerAgent({ agentId: value.pending.agentId, name: 'Swarmboard runtime' });
      this.board.publishSystemEntryOnce(value.pending);
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
      : running ? 'running' : attention || watchdog?.state === 'attention' ? 'attention'
      : ['waiting','ready'].includes(pool.state) ? pool.state : 'idle';
    return { members: peers.length, draining: peers.filter(w => w.retirement?.state === 'draining').length, running, idle, state, executionMode: 'internal-only' as const,
      watchdog: { state: watchdog?.state ?? 'inactive', attempts: watchdog?.attempts ?? 0,
        nextWakeAt: pool?.enabled && watchdog?.idleSince !== null && watchdog?.idleSince !== undefined && watchdog.state !== 'attention' ? new Date(watchdog.idleSince + this.idleMs).toISOString() : null },
    };
  }
}

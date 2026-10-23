// Preserve the legacy checkpoint shape for existing databases, but never
// schedule or replay its old idle reminders. Activity is read-only status.
import type { Entry } from './store.js';
import type { Pool, WorkerStore } from './worker-store.js';

export interface Liveness {
  fingerprint: string;
  attempts: number;
  idleSince: number | null;
  // All states remain readable as historical checkpoints; none schedules work.
  state: 'inactive' | 'watching' | 'nudged' | 'attention';
  pending: Omit<Entry, 'id' | 'createdAt'> | null;
}
export function poolActivity(workers: WorkerStore, pool: Pool | null) {
  const peers = pool ? pool.memberIds.map(id => workers.get(id)) : workers.list();
  const running = peers.filter(w => w.status === 'running').length;
  const idle = peers.filter(w => w.enabled && w.status === 'idle').length;
  const attention = peers.some(w => !w.enabled || w.status === 'error' || w.status === 'uncertain');
  const state = !pool ? (running ? 'running' : attention ? 'attention' : 'idle')
    : ['stopped', 'stopping', 'completed', 'error'].includes(pool.state) ? pool.state
    : running ? 'running' : attention ? 'attention'
    : ['waiting', 'ready'].includes(pool.state) ? pool.state : 'idle';
  return { members: peers.length, draining: peers.filter(w => w.retirement?.state === 'draining').length, running, idle, state, executionMode: 'internal-only' as const,
    watchdog: { state: 'inactive' as const, attempts: 0, nextWakeAt: null },
  };
}

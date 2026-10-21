// Incident 2186 regression: a protected (approval-paused/error) member with a
// stale unread cursor must not permanently block idle recovery of the healthy
// subset, and the recovery nudge must rotate over dispatchable members only,
// while genuine running/uncertain activity still suppresses recovery.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';

function harness(dir: string) {
  const store = new Store(join(dir, 'board.sqlite'));
  const runs: { worker: string; prompt: string }[] = [];
  const runtime = new EventRuntime(store, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused',
    // This incident suite covers the explicitly retained legacy idle watchdog.
    notificationBatchMs: 0, debounceMs: 5, idleMs: 80, sessionCheckMs: 0,
    adapter: worker => ({ open: async () => 'test-thread', run: async (_threadId: string, prompt: string) => { runs.push({ worker: worker.id, prompt }); }, close: async () => {} }) });
  const goal = store.createTask({ title: 'Liveness recovery goal' });
  const pool = runtime.configurePool({ workspacePath: dir, size: 3 });
  const members = [1, 2, 3].map(index => {
    const workspace = join(dir, `m${index}`);
    mkdirSync(workspace, { recursive: true });
    return runtime.workers.register({ name: `Peer ${index}`, workspacePath: workspace });
  });
  const caughtUp = Number((store.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as { cursor: number }).cursor);
  for (const member of members) {
    runtime.workers.save({ ...member, poolId: pool.id, cursor: caughtUp });
    store.registerAgent({ agentId: member.id, name: member.name });
  }
  runtime.workers.savePool({ ...pool, memberIds: members.map(m => m.id) });
  return { store, runtime, runs, goal, members };
}
async function settle(runtime: EventRuntime, memberId: string) {
  await runtime.scan();
  for (let i = 0; i < 30 && runtime.workers.get(memberId).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
}
describe('healthy-subset idle recovery (incident 2186)', () => {
  it('recovers the healthy subset while an approval-paused member with an old unread cursor never blocks or receives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-approval-'));
    const board = harness(dir);
    try {
      const [healthy1, healthy2, protectedPeer] = board.members;
      board.runtime.workers.pauseForApproval(protectedPeer.id); // the 17:28 peer4 shape: enabled=false, approval message
      const foreign = board.store.registerAgent({ name: 'Reporter' });
      board.store.publishEntry({ agentId: foreign.id, taskId: board.goal.id, kind: 'FAIL', summary: 'Unread backlog for the paused member' });
      await settle(board.runtime, healthy1.id); // healthy peers deliver and advance
      expect(board.runtime.workers.get(protectedPeer.id).cursor).toBeLessThan(board.runtime.workers.get(healthy1.id).cursor); // old unread cursor persists
      for (let i = 0; i < 10 && !board.runs.some(r => r.prompt.includes('IDLE_RECOVERY')); i++) { await board.runtime.scan(); await new Promise(resolve => setTimeout(resolve, 40)); }
      const nudges = board.runs.filter(r => r.prompt.includes('IDLE_RECOVERY'));
      expect(nudges.length).toBeGreaterThanOrEqual(1);
      for (const nudge of nudges) expect([healthy1.id, healthy2.id]).toContain(nudge.worker); // never the protected member
      const paused = board.runtime.workers.get(protectedPeer.id);
      expect(paused).toMatchObject({ enabled: false, status: 'idle' }); // untouched by recovery
      expect(paused.error).toContain('approval');
      expect((board.runtime.workers.liveness()?.attempts ?? 0)).toBeGreaterThanOrEqual(1); // a real nudge was budgeted
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('treats an error-status member with a stale cursor the same way: no block, no nudge to it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-error-'));
    const board = harness(dir);
    try {
      const [healthy1, healthy2, errored] = board.members;
      board.runtime.workers.save({ ...errored, status: 'error', error: 'protected failure' });
      const foreign = board.store.registerAgent({ name: 'Reporter' });
      board.store.publishEntry({ agentId: foreign.id, taskId: board.goal.id, kind: 'FACT', summary: 'Reference backlog behind an errored member' });
      await settle(board.runtime, healthy1.id);
      expect(board.runtime.workers.get(errored.id).cursor).toBeLessThan(board.runtime.workers.get(healthy1.id).cursor);
      for (let i = 0; i < 10 && !board.runs.some(r => r.prompt.includes('IDLE_RECOVERY')); i++) { await board.runtime.scan(); await new Promise(resolve => setTimeout(resolve, 40)); }
      const nudges = board.runs.filter(r => r.prompt.includes('IDLE_RECOVERY'));
      expect(nudges.length).toBeGreaterThanOrEqual(1);
      for (const nudge of nudges) expect([healthy1.id, healthy2.id]).toContain(nudge.worker);
      expect(board.runtime.workers.get(errored.id).status).toBe('error'); // fence untouched
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('emits no recovery at all when every member is undispatchable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-all-protected-'));
    const board = harness(dir);
    try {
      const [first, second, third] = board.members;
      board.runtime.workers.pauseForApproval(first.id);
      board.runtime.workers.save({ ...second, status: 'error', error: 'protected failure' });
      board.runtime.workers.save({ ...third, status: 'uncertain', error: 'unknown delivery' });
      for (let i = 0; i < 8; i++) { await board.runtime.scan(); await new Promise(resolve => setTimeout(resolve, 40)); }
      expect(board.runs).toHaveLength(0); // nobody dispatchable: no turn at all
      expect(board.store.readEntries({ after: 0, limit: 200 }).items.filter(e => (e.summary ?? '').includes('IDLE_RECOVERY'))).toHaveLength(0);
      expect(board.runtime.workers.liveness()?.attempts ?? 0).toBe(0); // both bounded retries unspent
      expect(board.runtime.workers.get(first.id)).toMatchObject({ enabled: false, status: 'idle' });
      expect(board.runtime.workers.get(second.id).status).toBe('error');
      expect(board.runtime.workers.get(third.id).status).toBe('uncertain'); // unknown-delivery fence untouched
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not poll the model while a healthy member is running or a delivery is uncertain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-busy-'));
    const board = harness(dir);
    try {
      const [running, , uncertain] = board.members;
      board.runtime.workers.save({ ...running, status: 'running' });
      board.runtime.workers.save({ ...uncertain, status: 'uncertain', error: 'unknown delivery' });
      for (let i = 0; i < 8; i++) { await board.runtime.scan(); await new Promise(resolve => setTimeout(resolve, 40)); }
      expect(board.runs.filter(r => r.prompt.includes('IDLE_RECOVERY'))).toHaveLength(0); // no false polling
      expect(board.runtime.workers.get(uncertain.id).status).toBe('uncertain'); // unknown-delivery fence preserved
      expect(board.runtime.workers.get(running.id).status).toBe('running');
      expect(board.runtime.workers.liveness()?.state).toBe('inactive');
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

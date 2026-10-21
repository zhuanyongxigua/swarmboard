// Verify bounded recovery of stranded human goals without model polling or
// new chat identities, including durable checkpoints across runtime restarts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-idle-')), path = join(dir, 'board.sqlite');
  const board = new Store(path), turns: { id: string; prompt: string; thread: string }[] = [];
  let now = 1000, held = false;
  const releases: (() => void)[] = [];
  // The legacy global watchdog is now opt-in (sessionCheckMs: 0). Per-session
  // checks replace it by default; these cases still pin the old contract.
  const make = () => new EventRuntime(board, { notificationBatchMs: 0, databasePath: path, serverEntry: 'unused', now: () => now, idleMs: 100, sessionCheckMs: 0,
    adapter: worker => ({ open: async w => w.threadId ?? 'thread-' + w.id,
      run: async (thread, prompt) => { turns.push({ id: worker.id, prompt, thread }); if (held) await new Promise<void>(r => releases.push(r)); },
      close: async () => {},
    }) });
  let runtime = make();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), async () => { held = false; releases.forEach(r => r()); await runtime.close(); });
  runtime.configurePool({ workspacePath: dir });
  const task = board.createTask({ title: 'Human goal' });
  const settle = async () => { await runtime.scan(); await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true)); await runtime.scan(); };
  return { board, task, turns, settle, get runtime() { return runtime; }, tick: (ms = 100) => { now += ms; },
    hold: () => { held = true; }, release: () => { held = false; releases.splice(0).forEach(r => r()); },
    restart: async () => { await runtime.close(); runtime = make(); },
  };
}
describe('internal peer idle recovery', () => {
  it('keeps recovery signals bounded when hundreds of human goals remain unfinished', async () => {
    const f = fixture(); await f.settle();
    for (let i = 0; i < 600; i++) f.board.createTask({ title: `Additional human goal ${i}` });
    // Set up an already-delivered backlog; multi-batch transport is tested separately.
    const cursor = f.board.board().cursor;
    for (const worker of f.runtime.workers.list()) f.runtime.workers.save({ ...worker, cursor });
    await f.settle(); f.tick(); await f.settle();
    const recovery = f.board.readEntries({ query: 'IDLE_RECOVERY' }).items;
    expect(recovery).toHaveLength(1);
    expect(recovery[0]!.detail.length).toBeLessThan(2000);
    expect(recovery[0]!.detail).toContain('task_list');
    expect(JSON.parse(recovery[0]!.detail)).toMatchObject({ unfinishedGoalCount: 601, goalIdsHasMore: true });
    expect(JSON.parse(recovery[0]!.detail).goalIds).toHaveLength(20);
    expect(f.runtime.status().error).toBe('');
  });
  it('nudges one existing peer per interval, survives restart and keeps reminding while goals stay unfinished', async () => {
    const f = fixture(); await f.settle(); const ids = f.runtime.workers.list().map(w => [w.id, w.threadId]);
    expect(f.turns).toHaveLength(3); expect(f.turns[0]!.prompt).toContain('INTERNAL_ONLY');
    expect(f.runtime.status().activity).toMatchObject({ members: 3, running: 0, idle: 3, state: 'idle' });
    f.tick(99); await f.settle(); expect(f.turns).toHaveLength(3);
    f.tick(1); await f.settle(); expect(f.turns).toHaveLength(4);
    expect(f.turns[3]!.prompt).toContain('IDLE_RECOVERY');
    expect(f.runtime.status().activity.watchdog).toMatchObject({ attempts: 1 });
    await f.restart(); await f.settle(); expect(f.turns).toHaveLength(4);
    f.tick(); await f.settle(); expect(f.turns).toHaveLength(5);
    expect(f.turns[3]!.id).not.toBe(f.turns[4]!.id);
    // No attempt budget: a third idle interval still reminds instead of going
    // permanently silent, and no 'attention' verdict is derived from the count.
    f.tick(); await f.settle(); expect(f.turns).toHaveLength(6);
    expect(f.runtime.status().activity.watchdog.attempts).toBe(3);
    expect(f.runtime.status().activity.state).not.toBe('attention');
    f.tick(10000); await f.settle();
    expect(f.turns.length).toBeGreaterThanOrEqual(6);
    expect(f.runtime.workers.list().map(w => [w.id, w.threadId])).toEqual(ids);
    expect(f.board.board().tasks).toHaveLength(1); expect(f.board.board().resources).toHaveLength(0);
    expect(f.board.board().tasks[0]!.status).toBe('todo');
    f.board.updateTask(f.task.id, { expectedVersion: 1, description: 'Human clarification' });
    await f.settle(); expect(f.runtime.status().activity.watchdog.attempts).toBe(0);
    expect(f.runtime.status().activity.state).toBe('idle');
  });
  it.each(['blocked', 'in_review', 'done', 'canceled'] as const)('never nudges %s goals', async status => {
    const f = fixture(); await f.settle(); f.board.updateTask(f.task.id, { expectedVersion: 1, status }); await f.settle();
    const before = f.turns.length; f.tick(10000); await f.settle(); expect(f.turns).toHaveLength(before);
    expect(f.runtime.status().activity.watchdog.state).toBe('inactive');
  });
  it('does not wake busy, stopped, paused, error or uncertain organizations', async () => {
    const f = fixture(); f.hold(); await f.runtime.scan(); await vi.waitFor(() => expect(f.turns).toHaveLength(3));
    f.tick(10000); await f.runtime.scan(); expect(f.turns).toHaveLength(3);
    f.release(); await f.settle();
    const pool = f.runtime.workers.pool()!;
    f.runtime.controlPool({ expectedVersion: pool.version, enabled: false }); f.tick(10000); await f.settle();
    expect(f.turns).toHaveLength(3); expect(f.runtime.status().activity.state).toBe('stopped');
    f.runtime.controlPool({ expectedVersion: pool.version + 1, enabled: true }); await f.settle();
    // F2: a protected member no longer suppresses recovery for a healthy
    // subset (covered by test/mcp/liveness-recovery.test.ts); this fence now
    // applies when every member is protected.
    const peers = f.runtime.workers.list();
    for (const peer of peers) f.runtime.workers.pauseForApproval(peer.id);
    f.tick(10000); await f.settle(); expect(f.turns).toHaveLength(3);
    expect(f.runtime.status().activity.state).toBe('attention');
    for (const peer of peers) f.runtime.update({ id: peer.id, expectedVersion: f.runtime.workers.get(peer.id).version, enabled: true });
    for (const status of ['error', 'uncertain'] as const) {
      for (const peer of peers) f.runtime.workers.save({ ...f.runtime.workers.get(peer.id), status });
      f.tick(10000); await f.runtime.scan(); expect(f.turns).toHaveLength(3);
    }
  });
  it('does not reset the retry budget on peer chatter or duplicate an outbox signal after a crash', async () => {
    const f = fixture(); await f.settle(); f.tick(); await f.settle();
    const peer = f.runtime.workers.list()[0]!;
    f.board.publishEntry({ agentId: peer.id, kind: 'MESSAGE', summary: 'Acknowledgement only' }); await f.settle();
    expect(f.runtime.status().activity.watchdog.attempts).toBe(1);
    const signal = f.board.board().entries.find(e => e.summary.includes('IDLE_RECOVERY'))!;
    const checkpoint = f.runtime.workers.liveness()!;
    const pending = { agentId: signal.agentId, kind: signal.kind, summary: signal.summary, detail: signal.detail, recipientId: signal.recipientId };
    f.runtime.workers.saveLiveness({ ...checkpoint, pending });
    const cursor = f.board.board().cursor; await f.restart(); await f.settle();
    expect(f.board.board().cursor).toBe(cursor); expect(f.runtime.workers.liveness()!.pending).toBeNull();
    expect(f.runtime.status().activity.watchdog.attempts).toBe(1);
  });
  it('drains a paginated unrelated backlog before declaring the organization idle', async () => {
    const f = fixture(); await f.settle();
    f.board.registerAgent({ agentId: 'outside-recipient', name: 'Outside this organization' });
    for (let n = 0; n < 4001; n++) f.board.publishEntry({ agentId: 'outside-recipient', recipientId: 'outside-recipient', kind: 'MESSAGE', summary: 'Unrelated history ' + n });
    f.tick(); await f.settle();
    expect(f.turns).toHaveLength(3);
    expect(f.runtime.status().activity.watchdog.attempts).toBe(0);
    f.tick(99); await f.settle(); expect(f.turns).toHaveLength(3);
    f.tick(1); await f.settle(); expect(f.turns).toHaveLength(4);
  });
});

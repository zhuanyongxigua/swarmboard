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
  const make = () => new EventRuntime(board, { databasePath: path, serverEntry: 'unused', now: () => now, idleMs: 100,
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
  it('waits for the interval, nudges one existing peer, survives restart and stops after two unproductive nudges', async () => {
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
    f.tick(); await f.settle();
    expect(f.runtime.status().activity.state).toBe('attention');
    f.tick(10000); await f.settle(); expect(f.turns).toHaveLength(5);
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
    const peer = f.runtime.workers.list()[0]!;
    f.runtime.workers.pauseForApproval(peer.id); f.tick(10000); await f.settle(); expect(f.turns).toHaveLength(3);
    expect(f.runtime.status().activity.state).toBe('attention');
    f.runtime.update({ id: peer.id, expectedVersion: 2, enabled: true });
    for (const status of ['error', 'uncertain'] as const) {
      f.runtime.workers.save({ ...f.runtime.workers.get(peer.id), status }); f.tick(10000); await f.runtime.scan(); expect(f.turns).toHaveLength(3);
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
});

// Replay the same shared evidence with real SQLite and controllable adapters.
// Measure model-turn opportunities, not billed tokens or model output quality.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Entry } from '../../src/store.js';
import { EventRuntime, type RuntimeOptions } from '../../src/event-runtime.js';
import { UncertainDelivery } from '../../src/codex-session.js';
import { readReferenceEvents } from '../fixtures/reference-events.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
const unpack = readReferenceEvents;
async function fixture(quietMs = 15000, clock = true) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-batching-')), path = join(dir, 'board.sqlite');
  const board = new Store(path), turns: { worker: string; prompt: string }[] = [];
  let now = Date.now(), fail = false, hold: string | undefined, release: (() => void) | undefined;
  if (clock) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); }
  const make = () => new EventRuntime(board, { databasePath: path, serverEntry: 'unused', fallbackMs: 60000, debounceMs: 2,
    notificationBatchMs: quietMs, notificationMaxWaitMs: Math.max(quietMs, quietMs === 15000 ? 60000 : quietMs * 4),
    ...(clock ? { now: () => now } : {}), adapter: w => ({
      open: async worker => worker.threadId ?? 'thread-' + worker.id,
      run: async (_thread, prompt, started) => {
        turns.push({ worker: w.id, prompt }); started('turn-' + turns.length);
        if (hold === w.id) await new Promise<void>(resolve => { release = resolve; });
        if (fail) throw new UncertainDelivery('unknown delivery');
      }, close: async () => {},
    }),
  } satisfies RuntimeOptions);
  let runtime = make();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close(), () => { release?.(); });
  runtime.configurePool({ workspacePath: dir, size: 3 });
  const goal = board.createTask({ title: 'Human goal' });
  board.registerAgent({ agentId: 'evidence-source', name: 'External peer evidence' });
  await runtime.scan(); await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
  turns.length = 0;
  const publish = (patch: Partial<Entry> = {}) => {
    if (clock) vi.setSystemTime(now);
    const entry = board.publishEntry({ agentId: 'evidence-source', kind: 'FACT', summary: 'Same text, distinct event', taskId: goal.id, ...patch });
    return entry;
  };
  return { board, goal, turns, publish, get runtime() { return runtime; },
    advance: (ms: number) => { now += ms; if (clock) vi.setSystemTime(now); }, fail: () => { fail = true; },
    hold: (id: string) => { hold = id; }, release: () => { hold = undefined; release?.(); },
    restart: async () => { await runtime.close(); runtime = make(); },
    drain: async () => { await runtime.scan(); await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true)); },
  };
}
describe('notification batching without context loss', () => {
  it('reduces 30 turn opportunities to 3 while every original peer receives all ten distinct events', async () => {
    for (const quiet of [0, 15000]) {
      const f = await fixture(quiet), ids: number[] = [];
      const original = f.runtime.workers.list().map(w => [w.id, w.threadId]);
      for (let i = 0; i < 10; i++) { ids.push(f.publish().id); await f.drain(); f.advance(1000); }
      if (quiet) { expect(f.turns).toHaveLength(0); f.advance(15000); await f.drain(); }
      expect(f.turns).toHaveLength(quiet ? 3 : 30);
      for (const [id] of original) expect(f.turns.filter(t => t.worker === id).flatMap(t => unpack(t.prompt).map(e => e.id))).toEqual(ids);
      expect(f.runtime.workers.list().map(w => [w.id, w.threadId])).toEqual(original);
      expect(f.board.taskStates()).toHaveLength(1);
      expect(f.board.board().resources).toHaveLength(0);
    }
  });
  it('keeps the pending cursor and full long evidence across restart; truncated notifications are explicitly recoverable', async () => {
    const f = await fixture(), before = f.runtime.workers.list();
    const detail = 'Full evidence '.repeat(300), entry = f.publish({ detail });
    await f.drain(); expect(f.turns).toHaveLength(0);
    expect(f.runtime.workers.list().map(w => w.cursor)).toEqual(before.map(w => w.cursor));
    f.advance(10000); await f.restart(); await f.drain(); expect(f.turns).toHaveLength(0);
    f.advance(5000); await f.drain(); expect(f.turns).toHaveLength(3);
    for (const turn of f.turns) expect(unpack(turn.prompt)[0]).toMatchObject({ id: entry.id, detail: detail.slice(0, 1000), detailTruncated: true });
    expect(f.board.readEntries({ after: entry.id - 1, limit: 1 }).items[0]!.detail).toBe(detail);
    expect(f.runtime.workers.list().map(w => [w.id, w.threadId])).toEqual(before.map(w => [w.id, w.threadId]));
    await f.drain(); expect(f.turns).toHaveLength(3);
  });
  it('sends a new human goal to all idle members immediately and queues it for an already busy member', async () => {
    const f = await fixture(), busy = f.runtime.workers.list()[0]!.id;
    f.hold(busy); f.publish({ kind: 'MESSAGE', recipientId: busy }); await f.runtime.scan();
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    f.publish(); await f.runtime.scan(); expect(f.turns).toHaveLength(1);
    const goal = f.board.createTask({ title: 'New human goal during work' });
    await f.runtime.scan(); await vi.waitFor(() => expect(f.turns).toHaveLength(3));
    f.release(); await vi.waitFor(() => expect(f.runtime.workers.get(busy).status).toBe('idle'));
    await f.drain(); expect(f.turns).toHaveLength(4);
    for (const w of f.runtime.workers.list()) expect(f.turns.filter(t => t.worker === w.id).flatMap(t => unpack(t.prompt)).filter(e => e.taskId === goal.id)).toHaveLength(1);
  });
  it('delivers directed messages only to their recipient without waiting; FAIL immediately wakes all other peers', async () => {
    const f = await fixture(), receiver = f.runtime.workers.list()[0]!.id;
    const broadcast = f.publish(), direct = f.publish({ kind: 'MESSAGE', recipientId: receiver });
    await f.drain(); expect(f.turns).toHaveLength(1);
    expect(unpack(f.turns[0]!.prompt).map(e => e.id)).toEqual([broadcast.id, direct.id]);
    f.publish({ kind: 'FAIL', summary: 'Critical regression' }); await f.drain();
    expect(f.turns).toHaveLength(4);
    expect(f.turns.filter(t => t.worker !== receiver).flatMap(t => unpack(t.prompt)).some(e => e.id === direct.id)).toBe(false);
  });
  it('bounds a continuous broadcast stream and bypasses full-page backlog delay', async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) { f.publish(); await f.drain(); f.advance(10000); }
    expect(f.turns).toHaveLength(0);
    f.publish(); await f.drain(); expect(f.turns).toHaveLength(3);
    f.turns.length = 0;
    const ids = Array.from({ length: 51 }, () => f.publish().id);
    f.board.createTask({ title: 'Urgent goal behind a full page' });
    await f.drain(); await f.drain();
    for (const w of f.runtime.workers.list()) expect(f.turns.filter(t => t.worker === w.id).flatMap(t => unpack(t.prompt).map(e => e.id)).filter(id => ids.includes(id))).toEqual(ids);
  });
  it('does not acknowledge deferred evidence on human pause or ambiguous execution', async () => {
    const f = await fixture(), before = f.runtime.workers.list().map(w => w.cursor);
    f.publish(); await f.drain();
    const pool = f.runtime.workers.pool()!;
    f.runtime.controlPool({ expectedVersion: pool.version, enabled: false }); f.advance(60000); await f.drain();
    expect(f.turns).toHaveLength(0); expect(f.runtime.workers.list().map(w => w.cursor)).toEqual(before);
    f.runtime.controlPool({ expectedVersion: f.runtime.workers.pool()!.version, enabled: true }); f.fail(); await f.runtime.scan();
    await vi.waitFor(() => expect(f.runtime.workers.list().every(w => w.status === 'uncertain')).toBe(true));
    expect(f.runtime.workers.list().map(w => w.cursor)).toEqual(before);
    await f.runtime.scan(); expect(f.turns).toHaveLength(3);
  });
  it('wakes on the quiet-window deadline with real filesystem events, independently of the 60s fallback scan', async () => {
    const f = await fixture(100, false); f.runtime.start();
    const entry = f.publish();
    await vi.waitFor(() => expect(f.runtime.status().notifications.nextWakeAt).not.toBeNull());
    expect(f.turns).toHaveLength(0);
    await vi.waitFor(() => expect(f.turns).toHaveLength(3), { timeout: 2000 });
    for (const turn of f.turns) expect(unpack(turn.prompt).map(e => e.id)).toEqual([entry.id]);
    await f.drain(); expect(f.turns).toHaveLength(3);
  });
});

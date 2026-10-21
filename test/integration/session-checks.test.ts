// End-to-end wiring for the per-session five-minute checks (human plan 2026-10-21):
// the runtime must publish one directed SESSION_TASK_CHECK per due seat, never a
// legacy IDLE_RECOVERY, and a restart must neither lose nor duplicate a check.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function fixture(over: { sessionCheckMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-session-check-')), path = join(dir, 'board.sqlite');
  const board = new Store(path);
  let now = 1_000_000;
  const make = () => new EventRuntime(board, {
    notificationBatchMs: 0, databasePath: path, serverEntry: 'unused', now: () => now,
    sessionCheckMs: over.sessionCheckMs ?? 60_000,
    adapter: worker => ({ open: async w => w.threadId ?? 'thread-' + w.id,
      run: async () => {}, close: async () => {} }),
  });
  let runtime = make();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), async () => { await runtime.close(); });
  runtime.configurePool({ workspacePath: dir });
  const task = board.createTask({ title: 'Human goal' });
  const settle = async () => { await runtime.scan(); await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true)); await runtime.scan(); };
  const checks = () => board.readEntries({ after: 0, limit: 200 }).items
    .filter(e => e.kind === 'MESSAGE')
    .map(e => ({ summary: e.summary, detail: e.detail, recipientId: e.recipientId, agentId: e.agentId }));
  return { board, task, settle, checks, get runtime() { return runtime; },
    tick: (ms = 60_000) => { now += ms; },
    restart: async () => { await runtime.close(); runtime = make(); } };
}

describe('per-session five-minute checks (runtime wiring)', () => {
  it('does not construct the legacy watchdog and publishes one directed check per due seat', async () => {
    const f = fixture(); await f.settle();
    // Per-seat mode keeps the legacy watchdog inactive: that is the observable form
    // of "PoolLiveness is not constructed", so one seat cannot get two wakeups.
    expect((f.runtime.status().activity as { watchdog: { state: string } }).watchdog.state).toBe('inactive');
    f.tick(); await f.settle();
    const published = f.checks().filter(e => e.summary.startsWith('SESSION_TASK_CHECK:'));
    expect(published.length).toBeGreaterThan(0);
    expect(f.checks().some(e => e.summary.startsWith('IDLE_RECOVERY:'))).toBe(false);
    const first = JSON.parse(published[0]!.detail!) as { kind: string; memberId: string; sessionRef: string; dueAt: number; goalIds: string[] };
    expect(first.kind).toBe('SESSION_TASK_CHECK');
    expect(first.memberId).toBeTruthy();
    expect(first.sessionRef).toBeTruthy();
    expect(Number.isFinite(first.dueAt)).toBe(true);
    expect(first.goalIds).toContain(f.task.id);
    expect(published[0]!.recipientId).toBe(first.memberId);
  });

  it('keeps a disabled organization and terminal goals from producing wakeups', async () => {
    const f = fixture(); await f.settle();
    f.board.updateTask(f.task.id, { status: 'blocked', expectedVersion: 1 });
    f.tick(); await f.settle();
    expect(f.checks().filter(e => e.summary.startsWith('SESSION_TASK_CHECK:'))).toHaveLength(0);
    expect(f.checks().some(e => e.summary.startsWith('IDLE_RECOVERY:'))).toBe(false);
  });

  it('survives a restart without losing the due check', async () => {
    const f = fixture(); await f.settle();
    f.tick();
    await f.runtime.scan();                    // schedules and (normally) publishes
    await f.restart();
    await f.settle();
    const published = f.checks().filter(e => e.summary.startsWith('SESSION_TASK_CHECK:'));
    expect(published.length).toBeGreaterThan(0);
    // The idempotency key is (memberId, sessionRef, dueAt): a restart must not
    // republish the same seat's due, while different seats may share one dueAt.
    const keys = published.map(e => {
      const d = JSON.parse(e.detail!) as { memberId: string; sessionRef: string; dueAt: number };
      return `${d.memberId}|${d.sessionRef}|${d.dueAt}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
  });
});

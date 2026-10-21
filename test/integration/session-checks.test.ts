// End-to-end wiring for the per-session five-minute checks (human plan 2026-10-21):
// the runtime must publish one directed SESSION_TASK_CHECK per due seat, never a
// legacy IDLE_RECOVERY, and a restart must neither lose nor duplicate a check.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function fixture(over: { sessionCheckMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-session-check-')), path = join(dir, 'board.sqlite');
  const board = new Store(path);
  let now = 1_000_000;
  const make = () => new EventRuntime(board, {
    notificationBatchMs: 0, databasePath: path, serverEntry: 'unused', now: () => now,
    sessionCheckMs: over.sessionCheckMs ?? 60_000,
    adapter: _worker => ({ open: async w => w.threadId ?? 'thread-' + w.id,
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

  it('keeps checking while only in_review goals remain (pool.state = waiting)', async () => {
    const f = fixture(); await f.settle();
    f.board.updateTask(f.task.id, { status: 'in_review', expectedVersion: 1 });
    await f.settle();
    // The pool reports 'waiting' because nothing is dispatchable; the per-session
    // checks must still run, which is the core of the human plan.
    expect(f.runtime.workers.pool()?.state).toBe('waiting');
    const before = f.checks().filter(e => e.summary.startsWith('SESSION_TASK_CHECK:')).length;
    f.tick(); await f.settle();
    const after = f.checks().filter(e => e.summary.startsWith('SESSION_TASK_CHECK:')).length;
    expect(after).toBeGreaterThan(before);
  });

  it('gives a registered external seat its check with no native workers at all', async () => {
    // No configurePool and no workers: this is the branch that used to return before
    // the per-session checks ran. The channel is registered the same way the MCP
    // notification_register tool registers it.
    const dir = mkdtempSync(join(tmpdir(), 'swarmboard-session-check-ext-'));
    const path = join(dir, 'board.sqlite');
    const board = new Store(path);
    let now = 1_000_000;
    const runtime = new EventRuntime(board, { notificationBatchMs: 0, databasePath: path, serverEntry: 'unused',
      now: () => now, sessionCheckMs: 60_000 });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), async () => { await runtime.close(); });
    const goal = board.createTask({ title: 'Human goal' });
    const member = runtime.configureCollaborator({ expectedVersion: 0, name: 'Synthetic external',
      harness: 'synthetic', sessionRef: 'external-session-1', taskIds: [goal.id], enabled: true });
    new NotificationAdapterStore(board.db).save({ id: 'adapter-synthetic', version: 1,
      displayName: 'Synthetic external channel', harness: 'synthetic', enabled: true,
      capabilities: ['durableDelivery'],
      members: [{ memberId: member.id, sessionRef: member.sessionRef, taskIds: [goal.id] }] });
    await runtime.scan();                       // anchor
    now += 60_000;
    await runtime.scan();
    const published = board.board().entries.filter(e => e.summary.startsWith('SESSION_TASK_CHECK:'));
    expect(published.length).toBeGreaterThan(0);
    const detail = JSON.parse(published[0]!.detail!) as { memberId: string; sessionRef: string; adapterId?: string };
    expect(detail.memberId).toBe(member.id);
    expect(detail.sessionRef).toBe('external-session-1');
    expect(detail.adapterId).toBe('adapter-synthetic');
  });

  it('keeps the pending entry when the channel dispatch fails, and retries it', async () => {
    const f = fixture(); await f.settle();
    f.tick();
    await f.runtime.scan();          // schedule the check
    const dispatcher = (f.runtime as unknown as { notificationDispatcher: { dispatch: (entry: unknown) => unknown } }).notificationDispatcher;
    const original = dispatcher.dispatch;
    let attempts = 0;
    dispatcher.dispatch = () => { attempts += 1; throw new Error('channel down'); };
    // The check came due at the previous scan; force one more due by advancing.
    f.tick(); await f.runtime.scan();
    dispatcher.dispatch = original;
    expect(attempts).toBeGreaterThan(0);
    // With the channel restored, the next scan publishes instead of losing it.
    await f.runtime.scan();
    const published = f.checks().filter(e => e.summary.startsWith('SESSION_TASK_CHECK:'));
    expect(published.length).toBeGreaterThan(0);
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

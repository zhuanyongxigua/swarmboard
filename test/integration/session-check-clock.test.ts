// Independent black-box clock matrix for v30 per-session checks.
// Uses only the public runtime/MCP-facing surfaces; no internal scheduler copies.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import type { Collaborator } from '../../src/collaborators.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-seat-clock-'));
  const path = join(dir, 'board.sqlite');
  const board = new Store(path);
  const turns: { worker: string; prompt: string }[] = [];
  let now = 1000;
  const make = () => new EventRuntime(board, {
    notificationBatchMs: 0, databasePath: path, serverEntry: 'unused', now: () => now, sessionCheckMs: 100,
    adapter: worker => ({
      open: async w => w.threadId ?? 'thread-' + w.id,
      run: async (_thread, prompt, onStarted) => { turns.push({ worker: worker.id, prompt }); onStarted?.('turn-' + turns.length); },
      close: async () => {},
    }),
  });
  let runtime = make();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), async () => { await runtime.close(); });
  runtime.configurePool({ workspacePath: dir });
  const settle = async () => {
    await runtime.scan();
    await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true), { timeout: 4000 });
    await runtime.scan();
  };
  const checks = () => board.readEntries({ query: 'SESSION_TASK_CHECK' }).items;
  const count = (id: string) => checks().filter(e => e.recipientId === id).length;
  return { dir, board, turns, settle, checks, count, get runtime() { return runtime; }, tick: (ms = 100) => { now += ms; },
    restart: async () => { await runtime.close(); runtime = make(); return runtime; } };
}

describe('per-session five-minute checks (controlled clock, black-box)', () => {
  it('drives two independent native seats across more than two intervals; no old global reminder', async () => {
    const f = fixture();
    const goal = f.board.createTask({ title: 'Human goal needing work' });
    await f.settle();
    const workers = f.runtime.workers.list();
    const [a, b] = workers;
    for (const extra of workers.slice(2)) f.runtime.update({ id: extra.id, expectedVersion: extra.version, enabled: false });
    for (let i = 0; i < 4; i++) { f.tick(); await f.settle(); }
    expect(f.count(a.id)).toBeGreaterThanOrEqual(3);
    expect(f.count(b.id)).toBeGreaterThanOrEqual(3);
    expect(f.checks().every(e => e.summary.startsWith('SESSION_TASK_CHECK'))).toBe(true);
    expect(f.board.readEntries({ query: 'IDLE_RECOVERY' }).items).toHaveLength(0);

    // A repeated scan at the same instant must not duplicate a due wake.
    const before = f.checks().length;
    await f.runtime.scan(); await f.runtime.scan();
    expect(f.checks().length).toBe(before);

    // in_review is periodic work; blocked-only is not.
    const beforeReview = f.count(a.id);
    f.board.updateTask(goal.id, { expectedVersion: goal.version, status: 'in_review' });
    f.tick(); f.tick(); await f.settle();
    const afterReview = f.count(a.id);
    expect(afterReview).toBeGreaterThanOrEqual(beforeReview + 1);
    f.board.updateTask(goal.id, { expectedVersion: goal.version + 1, status: 'blocked' });
    f.tick(); await f.settle();
    expect(f.count(a.id)).toBe(afterReview);
  });

  it('persists due state across restart and stopping one seat only', async () => {
    const f = fixture();
    const goal = f.board.createTask({ title: 'Persistent goal' });
    await f.settle();
    const [a, b] = f.runtime.workers.list();
    for (const extra of f.runtime.workers.list().slice(2)) f.runtime.update({ id: extra.id, expectedVersion: extra.version, enabled: false });
    f.tick(); await f.settle();
    const aBefore = f.count(a.id), bBefore = f.count(b.id);
    expect(aBefore).toBeGreaterThanOrEqual(1);
    expect(bBefore).toBeGreaterThanOrEqual(1);

    // Restart: persisted nextDueAt must not replay at t+0, but must fire at t+interval.
    const restarted = await f.restart(); await f.settle();
    expect(f.count(a.id)).toBe(aBefore);
    f.tick(); await f.settle();
    expect(f.count(a.id)).toBe(aBefore + 1);
    expect(f.count(b.id)).toBe(bBefore + 1);

    // Pausing one seat stops only that seat; the other keeps checking.
    const workerA = restarted.workers.get(a.id);
    restarted.update({ id: a.id, expectedVersion: workerA.version, enabled: false });
    const bNow = f.count(b.id);
    f.tick(); f.tick(); await f.settle();
    expect(f.count(a.id)).toBe(aBefore + 1);
    expect(f.count(b.id)).toBeGreaterThan(bNow);
    expect(goal.id).toBeTruthy();
  });
});

describe('pool waiting state must not suppress per-session checks', () => {
  it('keeps checking an in_review-only board instead of treating pool.waiting as inactive', async () => {
    const f = fixture();
    const goal = f.board.createTask({ title: 'Awaiting review' });
    await f.settle();
    const [a, b] = f.runtime.workers.list();
    for (const extra of f.runtime.workers.list().slice(2)) f.runtime.update({ id: extra.id, expectedVersion: extra.version, enabled: false });
    f.board.updateTask(goal.id, { expectedVersion: goal.version, status: 'in_review' });
    const before = f.count(a.id);
    f.tick(); await f.settle();
    expect(f.runtime.workers.pool()?.state).toBe('waiting');
    expect(f.count(a.id)).toBeGreaterThan(before);
    expect(f.count(b.id)).toBeGreaterThan(before);
  });
});


function externalFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-seat-ext-'));
  const path = join(dir, 'board.sqlite');
  const board = new Store(path);
  let now = 1000;
  const runtime = new EventRuntime(board, {
    notificationBatchMs: 0, databasePath: path, serverEntry: 'unused', now: () => now, sessionCheckMs: 100,
    adapter: () => ({ open: async () => 'unused', run: async () => {}, close: async () => {} }),
  });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close());
  const goal = board.createTask({ title: 'External-only goal' });
  const channels = new NotificationAdapterStore(board.db);
  const members: Collaborator[] = [];
  for (const [name, sessionRef] of [['A', 'ext-session-a'], ['B', 'ext-session-b']]) {
    const c = runtime.collaborators.configure({ expectedVersion: 0, name, harness: 'synthetic', sessionRef, taskIds: [goal.id], enabled: true }, board).collaborator;
    board.registerAgent({ agentId: c.id, name });
    channels.save({ id: 'adapter-' + name, version: 1, displayName: 'Synthetic ' + name, harness: 'synthetic', enabled: true,
      capabilities: ['durableDelivery', 'receipt', 'timedReminder'], members: [{ memberId: c.id, sessionRef, taskIds: [goal.id] }] });
    members.push(c);
  }
  const checks = () => board.readEntries({ query: 'SESSION_TASK_CHECK' }).items;
  const count = (id: string) => checks().filter(e => e.recipientId === id).length;
  const consume = (index: number) => {
    const member = members[index]!, adapterId = 'adapter-' + member.name;
    const pending = channels.pendingIntent(adapterId, member.id);
    expect(pending).not.toBeNull();
    channels.recordReceipt(adapterId, member.id, { sequence: pending!.sequence, consumed: true });
  };
  return { board, runtime, goal, members, checks, count, consume, tick: (ms = 100) => { now += ms; } };
}

describe('pure external organization still gets per-session checks', () => {
  it('runs the external seats without any native workers and keeps them independent', async () => {
    const f = externalFixture();
    await f.runtime.scan();
    f.tick(); await f.runtime.scan();
    expect(f.count(f.members[0]!.id)).toBeGreaterThanOrEqual(1);
    expect(f.count(f.members[1]!.id)).toBeGreaterThanOrEqual(1);
    // Synthetic consumption completes A's turn. B keeps its pending delivery,
    // so repeated due scans must coalesce instead of opening another turn.
    f.consume(0);
    f.tick(); await f.runtime.scan();
    expect(f.count(f.members[0]!.id)).toBeGreaterThanOrEqual(2);
    expect(f.count(f.members[1]!.id)).toBe(1);
    f.consume(1); await f.runtime.scan();
    expect(f.count(f.members[1]!.id)).toBeGreaterThanOrEqual(2);
    f.consume(0); f.consume(1);
    f.tick(); await f.runtime.scan();
    expect(f.count(f.members[0]!.id)).toBeGreaterThanOrEqual(3);
    expect(f.count(f.members[1]!.id)).toBeGreaterThanOrEqual(3);
    const entries = f.checks();
    expect(entries.every(e => e.detail.includes('"kind":"SESSION_TASK_CHECK"'))).toBe(true);
    expect(f.runtime.workers.list()).toHaveLength(0);
  });
});

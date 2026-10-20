// Verify persisted human limits and safe multi-member shrink without real models.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { WorkerStore } from '../../src/worker-store.js';
import { EventRuntime } from '../../src/event-runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(hold = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pool-capacity-'));
  const board = new Store(join(dir, 'board.sqlite'));
  const turns: string[] = [], closed: string[] = [], finishes = new Map<string, () => void>();
  const runtime = new EventRuntime(board, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', notificationBatchMs: 0,
    adapter: worker => ({ open: async w => w.threadId ?? 'original-' + w.id,
      run: async (_thread, _prompt, started) => { turns.push(worker.id); started('turn-' + turns.length); if (hold) await new Promise<void>(resolve => finishes.set(worker.id, resolve)); },
      close: async () => { closed.push(worker.id); } }) });
  cleanups.push(async () => { for (const finish of finishes.values()) finish(); await runtime.close(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  runtime.configurePool({ workspacePath: dir, size: 3 }); board.createTask({ title: 'Synthetic capacity goal' });
  await runtime.scan(); await vi.waitFor(() => expect(turns).toHaveLength(3));
  if (!hold) await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
  return { dir, board, runtime, turns, closed, finishes };
}

it('persists independent bounds and protects them from stale checkpoints and invalid/stale saves', async () => {
  const f = await fixture(), before = f.runtime.workers.pool()!;
  expect(before.minSize).toBe(1);
  const updated = f.runtime.configureCapacity({ minSize: 2, maxSize: 5, expectedVersion: before.version });
  expect(updated).toMatchObject({ minSize: 2, maxSize: 5, size: 3 });
  f.runtime.workers.checkpointPool(before);
  expect(f.runtime.workers.pool()).toMatchObject({ minSize: 2, maxSize: 5, size: 3 });
  const mirror = new WorkerStore(join(f.dir, 'board.sqlite.runtime.sqlite'));
  try { expect(mirror.pool()).toMatchObject({ minSize: 2, maxSize: 5, size: 3 }); } finally { mirror.close(); }
  for (const [minSize, maxSize] of [[0, 5], [2.5, 5], [2, 129], [5, 2], [2, NaN]]) {
    expect(() => f.runtime.configureCapacity({ minSize, maxSize, expectedVersion: updated.version })).toThrow();
    expect(f.runtime.workers.pool()).toEqual(updated);
  }
  expect(() => f.runtime.configureCapacity({ minSize: 1, maxSize: 1, expectedVersion: before.version })).toThrow(/Pool changed/);
});

it('applies the same bounds to reduce, configure and peer requests, and clamps target when bounds change', async () => {
  const f = await fixture();
  let pool = f.runtime.configureCapacity({ minSize: 3, maxSize: 3, expectedVersion: f.runtime.workers.pool()!.version });
  expect(() => f.runtime.reducePool({ expectedVersion: pool.version, requestId: 'below-min' })).toThrow(/minimum/i);
  expect(() => f.runtime.configurePool({ workspacePath: f.dir, size: 4, expectedVersion: pool.version })).toThrow(/budget/i);
  expect(() => f.runtime.workers.requestPeer({ workerId: pool.memberIds[0], requestId: 'over-max', reason: 'Bounded fixture' })).toThrow(/budget/i);
  pool = f.runtime.configureCapacity({ minSize: 2, maxSize: 2, expectedVersion: pool.version });
  expect(pool).toMatchObject({ minSize: 2, maxSize: 2, size: 2 });
  const original = f.runtime.workers.list().map(w => [w.id, w.threadId]);
  pool = f.runtime.configureCapacity({ minSize: 3, maxSize: 4, expectedVersion: pool.version });
  expect(pool.size).toBe(3); await f.runtime.scan();
  expect(f.runtime.workers.pool()!.memberIds).toHaveLength(3);
  expect(f.runtime.workers.list().map(w => [w.id, w.threadId])).toEqual(original);
});

it('shrinks multiple busy members at their own completion boundary without closing or replaying their turns', async () => {
  const f = await fixture(true), original = f.runtime.workers.list();
  const pool = f.runtime.configureCapacity({ minSize: 1, maxSize: 1, expectedVersion: f.runtime.workers.pool()!.version });
  expect(pool).toMatchObject({ size: 1, minSize: 1, maxSize: 1 }); expect(pool.memberIds).toHaveLength(3);
  const leaving = f.runtime.workers.list().filter(w => w.retirement?.state === 'draining'); expect(leaving).toHaveLength(2);
  await f.runtime.scan(); expect(f.closed).toEqual([]); expect(f.turns).toHaveLength(3);
  for (const member of leaving) {
    const before = original.find(w => w.id === member.id)!;
    expect(member).toMatchObject({ threadId: before.threadId, deliveryId: before.deliveryId, turnId: before.turnId });
    f.finishes.get(member.id)!();
    await vi.waitFor(() => expect(f.runtime.workers.get(member.id).status).toBe('idle')); await f.runtime.scan();
    expect(f.runtime.workers.get(member.id).retirement?.state).toBe('retired');
  }
  expect(f.runtime.workers.pool()!.memberIds).toHaveLength(1); expect(f.turns).toHaveLength(3);
  expect(f.runtime.workers.list()).toHaveLength(3); // Durable histories remain.
});

it('preserves unknown deliveries and a human pause when changing bounds', async () => {
  const f = await fixture();
  for (const worker of f.runtime.workers.list()) f.runtime.workers.save({ ...worker, status: 'uncertain', deliveryId: 'unknown-' + worker.id, turnId: 'unknown-turn', deliveryCursor: 19 });
  const paused = f.runtime.controlPool({ expectedVersion: f.runtime.workers.pool()!.version, enabled: false });
  const pool = f.runtime.configureCapacity({ minSize: 1, maxSize: 1, expectedVersion: paused.version });
  expect(pool.enabled).toBe(false); await f.runtime.scan();
  expect(f.runtime.workers.pool()!.memberIds).toHaveLength(3);
  for (const worker of f.runtime.workers.list()) expect(worker).toMatchObject({ status: 'uncertain', deliveryId: 'unknown-' + worker.id, turnId: 'unknown-turn' });
  expect(f.turns).toHaveLength(3);
});

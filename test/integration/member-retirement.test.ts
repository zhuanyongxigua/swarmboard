// Check retirement against real SQLite and bounded fake native sessions, never live members.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(hold = false) {
  const dir = mkdtempSync(join(tmpdir(), 'member-retirement-runtime-'));
  const board = new Store(join(dir, 'board.sqlite'));
  const turns: string[] = [], finishes = new Map<string, () => void>();
  let inspection: 'unknown' | 'failed' | 'completed' = 'unknown';
  const runtime = new EventRuntime(board, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', notificationBatchMs: 0, wakePolicy: 'all',
    adapter: worker => ({ open: async w => w.threadId ?? 'thread-' + w.id,
      run: async (_thread, _prompt, started) => { turns.push(worker.id); started('turn-' + turns.length); if (hold) await new Promise<void>(resolve => { finishes.set(worker.id, resolve); }); },
      inspect: async () => inspection, close: async () => {} }) });
  cleanups.push(async () => { for (const done of finishes.values()) done(); await runtime.close(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  runtime.configurePool({ workspacePath: dir, size: 2 });
  board.createTask({ title: 'Synthetic human goal' });
  await runtime.scan();
  await vi.waitFor(() => expect(turns).toHaveLength(2));
  if (!hold) await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
  return { dir, board, runtime, turns, finishes, inspectAs(value: typeof inspection) { inspection = value; } };
}

describe('member retirement runtime', () => {
  it('rechecks a retirement committed while a native session is opening before submitting a turn', async () => {
    const f = await fixture();
    const openings: (() => void)[] = [];
    cleanups.push(async () => { for (const done of openings) done(); });
    // Close completed adapters before installing the opening-boundary fixture.
    await f.runtime.scan();
    for (const worker of f.runtime.workers.list()) f.runtime.workers.update({ id: worker.id, expectedVersion: worker.version, enabled: false });
    await f.runtime.scan();
    f.runtime.options.adapter = worker => ({
      open: async () => { await new Promise<void>(resolve => openings.push(resolve)); return 'original-' + worker.id; },
      run: async (_thread, _prompt, started) => { f.turns.push(worker.id); started('new-turn'); }, close: async () => {} });
    for (const worker of f.runtime.workers.list()) f.runtime.workers.update({ id: worker.id, expectedVersion: worker.version, enabled: true });
    f.board.createTask({ title: 'Opening boundary' });
    await f.runtime.scan();
    await vi.waitFor(() => expect(openings).toHaveLength(2));
    const before = f.turns.length;
    const result = f.runtime.reducePool({ expectedVersion: f.runtime.status().pool!.version, requestId: 'opening' });
    for (const done of openings) done();
    await vi.waitFor(() => expect(f.runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
    await f.runtime.scan();
    expect(f.turns.slice(before)).not.toContain(result.member.id);
    expect(f.runtime.workers.get(result.member.id).retirement?.state).toBe('retired');
  });

  it('removes an idle member from delivery and restores its original identity after add', async () => {
    const f = await fixture();
    const result = f.runtime.reducePool({ expectedVersion: f.runtime.status().pool!.version, requestId: 'reduce' });
    const id = result.member.id, originalThread = result.member.threadId;
    expect(result.member.retirement?.state).toBe('retired');
    expect(f.runtime.status().activity).toMatchObject({ members: 1, draining: 0, running: 0 });
    f.board.registerAgent({ agentId: 'fixture-host', name: 'Fixture human' });
    f.board.publishEntry({ agentId: 'fixture-host', kind: 'MESSAGE', summary: 'Next bounded work' });
    await f.runtime.scan();
    await vi.waitFor(() => expect(f.turns).toHaveLength(3));
    expect(f.turns.filter(worker => worker === id)).toHaveLength(1);
    await vi.waitFor(() => expect(f.runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
    const pool = f.runtime.status().pool!;
    f.runtime.configurePool({ workspacePath: f.dir, size: 2, expectedVersion: pool.version });
    await f.runtime.scan();
    expect(f.runtime.status().pool!.memberIds).toContain(id);
    expect(f.runtime.workers.get(id).threadId).toBe(originalThread);
    expect(f.runtime.workers.list()).toHaveLength(2);
  });

  it('keeps a busy member draining until its native turn completes without closing it', async () => {
    const f = await fixture(true);
    const result = f.runtime.reducePool({ expectedVersion: f.runtime.status().pool!.version, requestId: 'busy' });
    expect(result.member.retirement?.state).toBe('draining');
    expect(f.runtime.status().activity).toMatchObject({ members: 2, draining: 1, running: 2 });
    await f.runtime.scan();
    expect(f.runtime.workers.get(result.member.id).status).toBe('running');
    expect(f.turns).toHaveLength(2);
    f.finishes.get(result.member.id)!();
    await vi.waitFor(() => expect(f.runtime.workers.get(result.member.id).status).toBe('idle'));
    await f.runtime.scan();
    expect(f.runtime.status().pool!.memberIds).not.toContain(result.member.id);
    expect(f.runtime.workers.get(result.member.id).retirement?.state).toBe('retired');
  });

  it('waits for resource handoff and never silently clears an unknown delivery', async () => {
    const f = await fixture();
    const resource = f.board.createResource({ name: 'Fixture only' });
    const usages = f.runtime.workers.list().map(w => f.board.declareUsage({ agentId: w.id, resourceId: resource.id, purpose: 'Held until handoff' }));
    const result = f.runtime.reducePool({ expectedVersion: f.runtime.status().pool!.version, requestId: 'handoff' });
    expect(result.member.retirement?.state).toBe('draining');
    const usage = usages.find(u => u.agentId === result.member.id)!;
    f.board.releaseUsage(usage.id, { agentId: usage.agentId, expectedVersion: usage.version });
    const w = f.runtime.workers.get(result.member.id);
    f.runtime.workers.save({ ...w, status: 'uncertain', deliveryId: 'unknown', turnId: 'native', deliveryPhase: 'submitting' });
    await f.runtime.scan();
    expect(f.runtime.status().pool!.memberIds).toContain(w.id);
    expect(f.runtime.workers.get(w.id)).toMatchObject({ enabled: false, status: 'uncertain', deliveryId: 'unknown', retirement: { state: 'draining' } });
    expect(f.turns.filter(id => id === w.id)).toHaveLength(1);
  });

  it('retires an inspected failed native delivery without clearing its history or replaying it', async () => {
    const f = await fixture();
    for (const worker of f.runtime.workers.list()) f.runtime.workers.save({ ...worker, status: 'uncertain', deliveryId: 'pending-' + worker.id, turnId: 'native', deliveryPhase: 'running' });
    const result = f.runtime.reducePool({ expectedVersion: f.runtime.status().pool!.version, requestId: 'unknown' });
    let worker = f.runtime.workers.get(result.member.id);
    f.runtime.requestReconcile({ id: worker.id, expectedVersion: worker.version });
    await f.runtime.scan();
    await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).error).toContain('result is unknown'));
    expect(f.runtime.workers.get(worker.id).retirement?.state).toBe('draining');
    f.inspectAs('failed'); worker = f.runtime.workers.get(worker.id);
    f.runtime.requestReconcile({ id: worker.id, expectedVersion: worker.version });
    await f.runtime.scan();
    await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).status).toBe('error'));
    await f.runtime.scan();
    expect(f.runtime.workers.get(worker.id)).toMatchObject({ status: 'error', enabled: false, deliveryId: worker.deliveryId, turnId: 'native', retirement: { state: 'retired', resolution: { outcome: 'failed' } } });
    expect(f.runtime.status().pool!.memberIds).not.toContain(worker.id);
    expect(f.turns).toHaveLength(2);
  });
});

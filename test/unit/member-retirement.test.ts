// Verify durable retirement requests without touching real workers or model sessions.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerStore, type Worker } from '../../src/worker-store.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'retirement-state-'));
  const path = join(dir, 'workers.sqlite');
  let store = new WorkerStore(path);
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const workers = [0, 1, 2].map(index => store.register({ name: 'Peer ' + index, workspacePath: dir, taskIds: ['goal-' + index] }));
  for (const worker of workers) store.save({ ...worker, poolId: 'pool', threadId: 'thread-' + worker.id, cursor: 17 });
  store.savePool({ id: 'pool', version: 1, workspacePath: dir, size: 3, maxSize: 8, taskIds: [], enabled: true, memberIds: workers.map(w => w.id), state: 'active', error: '' });
  return { get store() { return store; }, path, workers, reopen() { store.close(); store = new WorkerStore(path); } };
}

describe('durable member retirement state', () => {
  it.each(['manual', 'approval'])('preserves a newer %s pause when restoring a retired member', kind => {
    const f = fixture(), id = f.workers[0]!.id;
    f.store.requestMemberRetirement({ memberId: id, expectedVersion: 1, requestId: 'pause-race' });
    if (kind === 'approval') f.store.pauseForApproval(id);
    else f.store.update({ id, expectedVersion: f.store.get(id).version, enabled: false });
    f.store.completeMemberRetirement(id);
    const pool = f.store.pool()!;
    f.store.savePool({ ...pool, size: 3, version: pool.version + 1 });
    expect(f.store.restoreRetiredMember(id).enabled).toBe(false);
  });

  it('preserves identity/history and reuses an idempotent request after a restart', () => {
    const f = fixture(), id = f.workers[2]!.id;
    const request = { memberId: id, expectedVersion: 1, requestId: 'reduce-1' };
    expect(f.store.requestMemberRetirement(request)).toMatchObject({ pool: { size: 2, version: 2 }, member: { id, enabled: false, retirement: { state: 'draining' } } });
    f.reopen();
    expect(f.store.requestMemberRetirement(request).pool.version).toBe(2);
    expect(() => f.store.requestMemberRetirement({ ...request, memberId: f.workers[0]!.id })).toThrow(/request/i);
    expect(f.store.get(id)).toMatchObject({ threadId: 'thread-' + id, cursor: 17, retirement: { state: 'draining' } });
    expect(f.store.completeMemberRetirement(id)).toMatchObject({ size: 2, memberIds: f.workers.slice(0, 2).map(w => w.id) });
    expect(f.store.get(id).retirement?.state).toBe('retired');
    expect(f.store.list()).toHaveLength(3);
    f.reopen();
    expect(f.store.get(id).enabled).toBe(false);
    expect(f.store.requestMemberRetirement(request).pool.memberIds).not.toContain(id);
  });

  it('does not complete a running or uncertain delivery and preserves retirement against stale checkpoints', () => {
    const f = fixture(), old = f.store.get(f.workers[0]!.id);
    const active: Worker = { ...old, status: 'running', deliveryId: 'delivery', turnId: 'turn', deliveryCursor: 25, deliveryPhase: 'running' };
    f.store.save(active);
    f.store.requestMemberRetirement({ memberId: old.id, expectedVersion: 1, requestId: 'reduce-busy' });
    expect(() => f.store.completeMemberRetirement(old.id)).toThrow(/delivery/i);
    expect(f.store.save({ ...active, status: 'uncertain' })).toMatchObject({ enabled: false, retirement: { state: 'draining' }, deliveryId: 'delivery' });
    expect(() => f.store.completeMemberRetirement(old.id)).toThrow(/delivery/i);
    expect(() => f.store.update({ id: old.id, expectedVersion: f.store.get(old.id).version, enabled: true })).toThrow(/explicit capacity/i);
    f.store.save({ ...f.store.get(old.id), status: 'idle', deliveryId: null, deliveryCursor: null, turnId: null, deliveryPhase: undefined });
    expect(f.store.completeMemberRetirement(old.id).memberIds).not.toContain(old.id);
  });

  it('requires a fresh pool version and never reduces the target below one', () => {
    const f = fixture();
    f.store.requestMemberRetirement({ memberId: f.workers[0]!.id, expectedVersion: 1, requestId: 'a' });
    expect(() => f.store.requestMemberRetirement({ memberId: f.workers[1]!.id, expectedVersion: 1, requestId: 'b' })).toThrow(/changed/i);
    f.store.requestMemberRetirement({ memberId: f.workers[1]!.id, expectedVersion: 2, requestId: 'b' });
    expect(() => f.store.requestMemberRetirement({ memberId: f.workers[2]!.id, expectedVersion: 3, requestId: 'c' })).toThrow(/one/i);
    expect(f.store.pool()?.size).toBe(1);
  });

  it('restores the same retired identity only after an explicit capacity increase', () => {
    const f = fixture(), id = f.workers[1]!.id;
    const before = f.store.get(id);
    f.store.update({ id, expectedVersion: before.version, enabled: false });
    f.store.requestMemberRetirement({ memberId: id, expectedVersion: 1, requestId: 'reduce' });
    f.store.completeMemberRetirement(id);
    expect(() => f.store.restoreRetiredMember(id)).toThrow(/capacity/i);
    const pool = f.store.pool()!;
    f.store.savePool({ ...pool, size: 3, version: pool.version + 1 });
    const restored = f.store.restoreRetiredMember(id);
    expect(restored).toMatchObject({ id, enabled: false, threadId: before.threadId, cursor: before.cursor });
    expect(restored.retirement).toBeUndefined();
    expect(new Set(f.store.pool()!.memberIds).size).toBe(3);
    expect(f.store.list()).toHaveLength(3);
  });

  it('does not let stale pool checkpoints resurrect removed membership', () => {
    const f = fixture(), stale = f.store.pool()!, id = f.workers[2]!.id;
    f.store.requestMemberRetirement({ memberId: id, expectedVersion: 1, requestId: 'reduce' });
    f.store.completeMemberRetirement(id);
    expect(f.store.checkpointPool(stale).memberIds).not.toContain(id);
  });

  it('serializes independent SQLite connections and refuses a late native checkpoint after retirement', () => {
    const f = fixture(), second = new WorkerStore(f.path), id = f.workers[0]!.id;
    try {
      const original = f.store.get(id);
      f.store.requestMemberRetirement({ memberId: id, expectedVersion: 1, requestId: 'first' });
      expect(() => second.requestMemberRetirement({ memberId: f.workers[1]!.id, expectedVersion: 1, requestId: 'second' })).toThrow(/changed/i);
      second.completeMemberRetirement(id);
      const late = f.store.save({ ...original, enabled: true, status: 'uncertain', deliveryId: 'late' });
      expect(late).toMatchObject({ enabled: false, status: 'idle', deliveryId: null, retirement: { state: 'retired' } });
      expect(() => f.store.requestPeer({ workerId: id, requestId: 'grow', reason: 'stale worker' })).toThrow(/enabled organization member/i);
      expect(f.store.pool()?.memberIds).not.toContain(id);
      expect(f.store.pool()?.size).toBe(2);
    } finally { second.close(); }
  });
});

// Exercise resource commits at the retirement boundary using independent SQLite connections.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { WorkerStore } from '../../src/worker-store.js';
import { WorkerPool } from '../../src/worker-pool.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'retirement-fence-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'board.sqlite'), workersPath = join(dir, 'workers.sqlite');
  const board = new Store(path), writer = new Store(path), workers = new WorkerStore(workersPath);
  cleanup.push(() => { workers.close(); writer.close(); board.close(); });
  const members = [0, 1].map(i => workers.register({ name: 'Synthetic ' + i, workspacePath: dir, taskIds: ['goal-' + i] }));
  for (const member of members) { workers.save({ ...member, poolId: 'pool' }); board.registerAgent({ agentId: member.id, name: member.name }); }
  workers.savePool({ id: 'pool', version: 1, workspacePath: dir, size: 2, maxSize: 8, taskIds: [], enabled: true, memberIds: members.map(w => w.id), state: 'active', error: '' });
  const pool = new WorkerPool(workers, board, path), resource = board.createResource({ name: 'Synthetic handoff' });
  const declare = (id: string) => writer.declareUsage({ agentId: id, resourceId: resource.id, purpose: 'Previously admitted request' });
  return { dir, path, workersPath, board, writer, workers, pool, resource, declare };
}

it('keeps the member draining when a previously admitted declaration commits after the last empty read', () => {
  const f = fixture(), original = (f.pool as unknown as { hasUsage(id: string): boolean }).hasUsage.bind(f.pool);
  let injected = false;
  vi.spyOn(f.pool as unknown as { hasUsage(id: string): boolean }, 'hasUsage').mockImplementation(id => {
    const observed = original(id);
    if (!injected && !observed && f.workers.get(id).retirement?.state === 'draining') { injected = true; f.declare(id); }
    return observed;
  });
  const result = f.pool.reduce({ expectedVersion: 1, requestId: 'late-before-fence' });
  expect(injected).toBe(true);
  expect(result.member.retirement?.state).toBe('draining');
  expect(result.pool.memberIds).toContain(result.member.id);
  expect(f.board.board().usages.filter(u => u.active && u.agentId === result.member.id)).toHaveLength(1);
});

it('rejects a late write after the persistent fence commits, including an old-client SQL insert', () => {
  const f = fixture(), original = f.workers.completeMemberRetirement.bind(f.workers);
  vi.spyOn(f.workers, 'completeMemberRetirement').mockImplementation(id => {
    expect(() => f.declare(id)).toThrow(/resource admission|retir/i);
    expect(() => f.writer.db.prepare('INSERT INTO usages(id,resourceId,agentId,purpose,scope,sharing,active,version,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('old-client', f.resource.id, id, 'Delayed legacy request', '', '', 1, 1, 'now', 'now')).toThrow(/resource admission/i);
    return original(id);
  });
  const result = f.pool.reduce({ expectedVersion: 1, requestId: 'late-after-fence' });
  expect(result.member.retirement?.state).toBe('retired');
  expect(f.board.board().usages).toHaveLength(0);
});

it('recovers a closed fence after a crash between explicit membership restore and admission reopen', () => {
  const f = fixture(), result = f.pool.reduce({ expectedVersion: 1, requestId: 'restore-crash' }), id = result.member.id;
  expect(() => f.declare(id)).toThrow(/resource admission|retir/i);
  const current = f.workers.pool()!;
  f.workers.savePool({ ...current, size: 2, version: current.version + 1 });
  f.workers.restoreRetiredMember(id);
  // Reopen fresh connections as a restarted host, before any model turn runs.
  const board = new Store(f.path), workers = new WorkerStore(f.workersPath);
  try {
    expect(() => f.declare(id)).toThrow(/resource admission|retir/i);
    new WorkerPool(workers, board, f.path).sync(false);
    expect(f.declare(id).active).toBe(true);
    expect(workers.pool()!.memberIds).toContain(id);
  } finally { workers.close(); board.close(); }
});

it('keeps admission closed across a crash before finalizing retirement and completes it on restart', () => {
  const f = fixture();
  vi.spyOn(f.workers, 'completeMemberRetirement').mockImplementationOnce(() => { throw new Error('Synthetic host crash'); });
  expect(() => f.pool.reduce({ expectedVersion: 1, requestId: 'finalize-crash' })).toThrow(/host crash/);
  const id = f.workers.list().find(w => w.retirement)!.id;
  expect(() => f.declare(id)).toThrow(/resource admission|retir/i);
  const board = new Store(f.path), workers = new WorkerStore(f.workersPath);
  try {
    new WorkerPool(workers, board, f.path).sync(false);
    expect(workers.get(id).retirement?.state).toBe('retired');
    expect(workers.pool()!.memberIds).not.toContain(id);
    expect(() => f.declare(id)).toThrow(/resource admission|retir/i);
  } finally { workers.close(); board.close(); }
});

it('upgrades v5 without changing declaration history and retains release access', () => {
  const f = fixture(), member = f.workers.list()[0]!, usage = f.declare(member.id), snapshot = f.board.board();
  f.board.db.exec('DROP TRIGGER usage_admission_insert; DROP TRIGGER usage_admission_update; DROP TABLE resource_admission_fences; DROP TABLE task_progress; DROP TABLE board_overview; DROP TABLE overview_status_facts; DROP TABLE board_user_prompt; DROP TABLE board_preferences; PRAGMA user_version=5;');
  const upgraded = new Store(f.path);
  try {
    expect(upgraded.board()).toEqual(snapshot);
    expect(upgraded.closeResourceAdmission(member.id)).toBe(false);
    upgraded.releaseUsage(usage.id, { agentId: member.id, expectedVersion: usage.version });
    expect(upgraded.closeResourceAdmission(member.id)).toBe(true);
    expect(() => f.writer.db.prepare('UPDATE usages SET active=1 WHERE id=?').run(usage.id)).toThrow(/resource admission/i);
    expect(upgraded.board().usages[0]).toMatchObject({ id: usage.id, active: false });
  } finally { upgraded.close(); }
});

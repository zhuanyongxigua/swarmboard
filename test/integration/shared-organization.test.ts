// Reproduce exclusive goals and frozen membership on isolated boards before
// accepting shared participation and bounded, idempotent peer growth.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { WorkerStore } from '../../src/worker-store.js';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-organization-')), board = new Store(join(dir, 'board.sqlite'));
  const turns: { id: string; thread: string; prompt: string }[] = [];
  const runtime = new EventRuntime(board, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', adapter: w => ({
    open: async worker => worker.threadId ?? 'thread-' + worker.id,
    run: async (thread, prompt) => { turns.push({ id: w.id, thread, prompt }); }, close: async () => {},
  }) });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close());
  const settle = async () => { await runtime.scan(); await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true)); };
  return { dir, board, runtime, turns, settle };
}
describe('shared human goals', () => {
  it('lets multiple participants join, update and release without reserving the whole goal', () => {
    const f = fixture(); for (const id of ['a', 'b', 'outsider']) f.board.registerAgent({ agentId: id, name: id });
    let task = f.board.createTask({ title: 'Shared goal' });
    task = f.board.claimTask(task.id, { agentId: 'a', expectedVersion: task.version });
    expect(task.assignee).toBeNull(); expect(task.participants).toEqual(['a']);
    task = f.board.claimTask(task.id, { agentId: 'b', expectedVersion: task.version });
    expect(task.participants).toEqual(['a', 'b']);
    expect(() => f.board.updateTask(task.id, { agentId: 'outsider', expectedVersion: task.version, status: 'done' })).toThrow(/participant/);
    task = f.board.updateTask(task.id, { agentId: 'b', expectedVersion: task.version, description: 'Verified peer contribution' });
    task = f.board.releaseTask(task.id, { agentId: 'a', expectedVersion: task.version });
    expect(task).toMatchObject({ status: 'in_progress', participants: ['b'], assignee: null });
    task = f.board.updateTask(task.id, { agentId: 'b', expectedVersion: task.version, status: 'done' });
    expect(() => f.board.claimTask(task.id, { agentId: 'a', expectedVersion: task.version })).toThrow(/Completed/);
  });
  it('joins through a scoped context CLAIM with no extra human cards or exclusive owner', () => {
    const f = fixture(); for (const id of ['a', 'b']) f.board.registerAgent({ agentId: id, name: id });
    const task = f.board.createTask({ title: 'Shared goal' });
    for (const id of ['a', 'b']) f.board.publishEntry({ agentId: id, kind: 'CLAIM', taskId: task.id, summary: 'A local contribution ' + id });
    const snapshot = f.board.board(); expect(snapshot.tasks).toHaveLength(1); expect(snapshot.resources).toHaveLength(0);
    expect(snapshot.tasks[0]).toMatchObject({ participants: ['a', 'b'], assignee: null, status: 'in_progress' });
  });
});
describe('live organization membership', () => {
  it('grows from three to five without replacing identities, and all five receive the shared goal', async () => {
    const f = fixture(); let pool = f.runtime.configurePool({ workspacePath: f.dir, size: 3, maxSize: 6 });
    const goal = f.board.createTask({ title: 'Shared goal' }); await f.settle();
    const original = f.runtime.workers.list().map(w => [w.id, w.threadId]);
    pool = f.runtime.configurePool({ workspacePath: f.dir, size: 5, maxSize: 6, expectedVersion: pool.version }); await f.settle();
    expect(pool.size).toBe(5); expect(f.runtime.workers.pool()!.memberIds).toHaveLength(5);
    expect(f.runtime.workers.list().filter(w => original.some(([id]) => id === w.id)).map(w => [w.id, w.threadId])).toEqual(original);
    f.turns.length = 0; f.board.updateTask(goal.id, { expectedVersion: 1, description: 'Clarified goal' }); await f.settle();
    expect(new Set(f.turns.map(t => t.id)).size).toBe(5);
    expect(() => f.runtime.register({ name: 'Unattached worker', workspacePath: f.dir })).toThrow(/organization/);
  });
  it('deduplicates peer requests across connections and enforces the budget before launching anyone', async () => {
    const f = fixture(); f.runtime.configurePool({ workspacePath: f.dir, maxSize: 4 }); f.board.createTask({ title: 'Goal' }); await f.settle();
    const requester = f.runtime.workers.pool()!.memberIds[0]!;
    const input = { workerId: requester, requestId: 'same-request', reason: 'An independent useful scope remains' };
    const another = new WorkerStore(join(f.dir,'board.sqlite.runtime.sqlite'));
    try {
      const before = another.pool()!;
      f.runtime.workers.requestPeer(input); another.requestPeer(input);
      another.checkpointPool({ ...before, state: 'active' });
      expect(another.pool()).toMatchObject({ size: 4, version: before.version + 1 });
    } finally { another.close(); }
    await f.settle();
    expect(f.runtime.workers.pool()!.memberIds).toHaveLength(4);
    expect(() => f.runtime.workers.requestPeer({ ...input, requestId: 'over-budget' })).toThrow(/budget/);
    const current = f.runtime.workers.pool()!;
    f.runtime.controlPool({ expectedVersion: current.version, enabled: false });
    expect(() => f.runtime.workers.requestPeer({ ...input, requestId: 'while-stopped' })).toThrow(/stopped/);
    expect(f.runtime.workers.list()).toHaveLength(4);
  });
  it('adds an explicitly requested peer to an existing waiting organization without discarding its goal history',async()=>{
    const f=fixture();f.runtime.configurePool({workspacePath:f.dir,maxSize:4});const goal=f.board.createTask({title:'Goal needing a final independent check'});await f.settle();
    f.board.updateTask(goal.id,{expectedVersion:1,status:'in_review'});await f.settle();
    const original=f.runtime.workers.pool()!.memberIds;
    f.runtime.workers.requestPeer({workerId:original[0]!,requestId:'independent-check',reason:'An additional independent check is useful'});await f.settle();
    const pool=f.runtime.workers.pool()!;expect(pool.memberIds).toHaveLength(4);expect(pool.memberIds.slice(0,3)).toEqual(original);
    expect(f.turns.some(t=>!original.includes(t.id)&&t.prompt.includes(goal.title))).toBe(true);
    expect(f.board.board().tasks).toHaveLength(1);expect(f.board.board().tasks[0]!.status).toBe('in_review');
  });
});

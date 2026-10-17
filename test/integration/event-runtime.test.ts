// Exercise real SQLite and filesystem wakeups with deterministic session adapters;
// these tests verify delivery behavior, not a live model or GUI integration.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import type { SessionAdapter } from '../../src/codex-session.js';
import { WorkerStore } from '../../src/worker-store.js';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(adapter?: SessionAdapter) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-events-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'board.sqlite'), store = new Store(path);
  cleanups.push(() => store.close());
  const runtime = new EventRuntime(store, { databasePath: path, serverEntry: 'unused', adapter: adapter ? () => adapter : undefined, fallbackMs: 60000, debounceMs: 5 });
  cleanups.push(() => runtime.close());
  return { dir, path, store, runtime };
}
function session() {
  const prompts: string[] = [];
  const adapter: SessionAdapter = { open: vi.fn(async w => w.threadId ?? 'persistent-thread'), run: vi.fn(async (_id, prompt, started) => { prompts.push(prompt); started('turn-' + prompts.length); }), close: vi.fn(async () => {}) };
  return { adapter, prompts };
}
describe('event-driven persistent workers', () => {
  it('wakes across independent database connections without waiting for the recovery timer and reuses its session', async () => {
    const { adapter, prompts } = session(); const f = fixture(adapter);
    const worker = f.runtime.register({ name: 'Builder', workspacePath: f.dir }); f.runtime.start();
    const peer = new Store(f.path); cleanups.push(() => peer.close());
    peer.createTask({ title: 'New task' });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    peer.registerAgent({ agentId: 'peer', name: 'Reviewer' });
    peer.publishEntry({ agentId: 'peer', recipientId: worker.id, kind: 'MESSAGE', summary: 'Review the implementation' });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toContain('Review the implementation');
    expect(f.runtime.workers.get(worker.id).threadId).toBe('persistent-thread');
    expect(vi.mocked(adapter.open).mock.calls[1]![0].threadId).toBe('persistent-thread');
  });
  it('queues messages while busy, batches them, and does not wake on its own entries', async () => {
    const { adapter, prompts } = session(); let finish!: () => void;
    vi.mocked(adapter.run).mockImplementationOnce(async (_id, prompt, started) => { prompts.push(prompt); started('busy-turn'); await new Promise<void>(resolve => { finish = resolve; }); });
    const f = fixture(adapter), worker = f.runtime.register({ name: 'Builder', workspacePath: f.dir });
    f.store.createTask({ title: 'Build' }); await f.runtime.scan();
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    f.store.registerAgent({ agentId: 'peer', name: 'Reviewer' });
    for (const summary of ['A', 'B']) f.store.publishEntry({ agentId: 'peer', kind: 'MESSAGE', recipientId: worker.id, summary });
    await f.runtime.scan(); expect(prompts).toHaveLength(1);
    finish(); await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).status).toBe('idle'));
    await f.runtime.scan(); await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toContain('"summary":"A"'); expect(prompts[1]).toContain('"summary":"B"');
    f.store.publishEntry({ agentId: worker.id, kind: 'MESSAGE', recipientId: worker.id, summary: 'Own entry' });
    await f.runtime.scan(); expect(prompts).toHaveLength(2);
  });
  it('does not wake on unrelated scoped tasks, facts, or empty scans', async () => {
    const { adapter, prompts } = session(); const f = fixture(adapter);
    const chosen = f.store.createTask({ title: 'Scoped task' });
    const worker = f.runtime.register({ name: 'Scoped', workspacePath: f.dir, taskIds: [chosen.id] });
    await f.runtime.scan(); await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).status).toBe('idle'));
    const count = prompts.length; f.store.registerAgent({ agentId: 'peer', name: 'Peer' });
    f.store.publishEntry({ agentId: 'peer', kind: 'FACT', summary: 'Unrelated finding' });
    f.store.createTask({ title: 'Different scope' });
    await f.runtime.scan(); await f.runtime.scan(); expect(prompts).toHaveLength(count);
  });
  it('retains ambiguous deliveries after restart and refuses a blind replay', async () => {
    const { adapter, prompts } = session(); const f = fixture(adapter);
    const worker = f.runtime.register({ name: 'Builder', workspacePath: f.dir });
    f.runtime.workers.save({ ...worker, threadId: 'old-thread', status: 'running', deliveryId: 'unfinished', deliveryCursor: 3, turnId: 'old-turn' });
    await f.runtime.scan();
    const saved = f.runtime.workers.get(worker.id);
    expect(saved).toMatchObject({ status: 'uncertain', deliveryId: 'unfinished', threadId: 'old-thread', turnId: 'old-turn' });
    expect(() => f.runtime.update({ id: worker.id, expectedVersion: saved.version, enabled: true })).toThrow(/Inspect/);
    expect(prompts).toHaveLength(0);
  });
  it('reconciles a completed delivery without starting a second turn', async () => {
    const { adapter, prompts } = session(); adapter.inspect = vi.fn(async () => 'completed');
    const f = fixture(adapter), worker = f.runtime.register({ name: 'Builder', workspacePath: f.dir });
    f.runtime.workers.save({ ...worker, threadId: 'saved-thread', status: 'uncertain', deliveryId: 'delivered', deliveryCursor: 1, turnId: 'saved-turn' });
    f.runtime.requestReconcile({ id: worker.id, expectedVersion: 1 }); await f.runtime.scan();
    await vi.waitFor(() => expect(f.runtime.workers.get(worker.id)).toMatchObject({ status: 'idle', cursor: 1, deliveryId: null }));
    expect(prompts).toHaveLength(0);
  });
  it('never steals a live owner and only takes over after the process has stopped', () => {
    const f = fixture(); const other = new WorkerStore(f.path + '.runtime.sqlite'); cleanups.push(() => other.close());
    expect(f.runtime.workers.acquire('first', 42, () => false)).toBe(true);
    expect(other.acquire('second', 43, () => true)).toBe(false);
    expect(other.acquire('second', 43, () => false)).toBe(true);
    expect(f.runtime.workers.owns('first')).toBe(false);
    f.runtime.workers.release('first'); expect(other.owns('second')).toBe(true);
  });
  it('notifies a worker when its completion may unblock subscribed follow-up work', async () => {
    const { adapter, prompts } = session(); const f = fixture(adapter);
    const first = f.store.createTask({ title: 'Prerequisite' }), next = f.store.createTask({ title: 'Follow-up' });
    f.store.updateTask(next.id, { expectedVersion: 1, status: 'blocked' });
    const worker = f.runtime.register({ name: 'Builder', workspacePath: f.dir, taskIds: [first.id, next.id] });
    const owned = f.store.claimTask(first.id, { agentId: worker.id, expectedVersion: 1 });
    f.runtime.workers.save({ ...worker, cursor: f.store.board().cursor });
    await f.runtime.scan(); expect(prompts).toHaveLength(0);
    f.store.updateTask(first.id, { agentId: worker.id, expectedVersion: owned.version, status: 'done' });
    await f.runtime.scan(); await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain('Prerequisite');
    expect(f.store.board().tasks.find(t => t.id === next.id)?.status).toBe('blocked');
  });
  it('delivers a human update to an already owned task', async () => {
    const { adapter, prompts } = session(); const f = fixture(adapter);
    const task = f.store.createTask({ title: 'Owned task' });
    const worker = f.runtime.register({ name: 'Builder', workspacePath: f.dir });
    const owned = f.store.claimTask(task.id, { agentId: worker.id, expectedVersion: 1 });
    f.runtime.workers.save({ ...worker, cursor: f.store.board().cursor });
    f.store.updateTask(task.id, { expectedVersion: owned.version, description: 'Human scope correction' });
    await f.runtime.scan(); await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain('Human scope correction');
  });
  it('keeps events beyond the batch limit for the next turn', async () => {
    const { adapter, prompts } = session(); const f = fixture(adapter);
    const worker = f.runtime.register({ name: 'Builder', workspacePath: f.dir });
    f.store.registerAgent({ agentId: 'peer', name: 'Peer' });
    for (let i = 0; i < 60; i++) f.store.publishEntry({ agentId: 'peer', recipientId: worker.id, kind: 'MESSAGE', summary: 'batch-message-' + i });
    await f.runtime.scan(); await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).status).toBe('idle'));
    await f.runtime.scan(); await vi.waitFor(() => expect(prompts).toHaveLength(2));
    for (let i = 0; i < 60; i++) expect(prompts.join('')).toContain('"summary":"batch-message-' + i + '"');
  });
  it('preserves a pause made while a turn is running', async () => {
    const { adapter, prompts } = session(); let finish!: () => void;
    vi.mocked(adapter.run).mockImplementationOnce(async (_id, prompt, started) => { prompts.push(prompt); started('turn'); await new Promise<void>(r => { finish = r; }); });
    const f = fixture(adapter), worker = f.runtime.register({ name: 'Builder', workspacePath: f.dir });
    f.store.createTask({ title: 'Build' }); await f.runtime.scan(); await vi.waitFor(() => expect(prompts).toHaveLength(1));
    f.runtime.update({ id: worker.id, expectedVersion: 1, enabled: false }); finish();
    await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).status).toBe('idle'));
    expect(f.runtime.workers.get(worker.id).enabled).toBe(false);
    f.store.createTask({ title: 'Later work' }); await f.runtime.scan(); expect(prompts).toHaveLength(1);
  });
});

// Backend identity and selection at the runtime boundary: deliveries bind the
// configured backend, restarts reuse durable sessions, and identifiers from a
// different backend are refused — never silently reinterpreted.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { echoBackend } from '../../src/harness/echo-backend.js';
import { codexBackend } from '../../src/codex-session.js';
import type { HarnessBackend, SessionAdapter } from '../../src/harness/contract.js';
import { approvalPauseMessage } from '../../src/worker-store.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

interface Options { backend?: HarnessBackend; adapter?: SessionAdapter }
function fixture(options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-harness-'));
  const path = join(dir, 'board.sqlite');
  const store = new Store(path);
  const runtimeOptions = { databasePath: path, serverEntry: 'unused', fallbackMs: 60000, debounceMs: 5,
    ...(options.backend ? { backend: options.backend } : {}), ...(options.adapter ? { adapter: () => options.adapter! } : {}) };
  let runtime = new EventRuntime(store, runtimeOptions);
  const closers: (() => Promise<void>)[] = [];
  const reopen = async (next: Options = {}) => {
    for (const closer of closers.splice(0)) await closer();
    const board = new Store(path);
    const nextOptions = { databasePath: path, serverEntry: 'unused', fallbackMs: 60000, debounceMs: 5,
      ...(next.backend ? { backend: next.backend } : {}), ...(next.adapter ? { adapter: () => next.adapter! } : {}) };
    runtime = new EventRuntime(board, nextOptions);
    closers.push(() => runtime.close(), () => Promise.resolve(board.close()));
    return runtime;
  };
  closers.push(() => runtime.close());
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), async () => { for (const closer of closers.splice(0)) await closer(); });
  return { dir, path, store, get runtime() { return runtime; }, reopen };
}
function echoTurns(path: string) {
  const db = new DatabaseSync(path + '.runtime.sqlite', { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='echo_turns'").get()) return [];
    return db.prepare('SELECT threadId,turnId,prompt,status FROM echo_turns ORDER BY id').all() as { threadId: string; turnId: string; prompt: string; status: string }[];
  } finally { db.close(); }
}
const idle = (runtime: EventRuntime, id: string) => vi.waitFor(() => expect(runtime.workers.get(id).status).toBe('idle'), { timeout: 4000 });

describe('harness backend identity at the runtime boundary', () => {
  it('reports the selected backend and capabilities in runtime status', () => {
    expect(fixture().runtime.status().backend).toEqual({ id: 'codex', displayName: codexBackend.displayName, deterministic: false, capabilities: { inspection: true, approvalSignals: true } });
    expect(fixture({ backend: echoBackend }).runtime.status().backend).toMatchObject({ id: 'echo', deterministic: true, capabilities: { inspection: true, approvalSignals: false } });
  });
  it('delivers through the echo backend, persists its identity, and reuses the session after a restart', async () => {
    const f = fixture({ backend: echoBackend });
    const worker = f.runtime.register({ name: 'Echo peer', workspacePath: f.dir });
    f.store.createTask({ title: 'Echo goal' });
    await f.runtime.scan(); await idle(f.runtime, worker.id);
    const delivered = f.runtime.workers.get(worker.id);
    expect(delivered).toMatchObject({ status: 'idle', backendId: 'echo' });
    expect(delivered.threadId).toMatch(/^echo-thread-/);
    expect(delivered.cursor).toBeGreaterThan(0);
    const first = echoTurns(f.path);
    expect(first).toHaveLength(1);
    expect(first[0]!.prompt).toContain('Echo goal');
    expect(first[0]!.prompt).toContain('deterministic echo reference backend');
    expect(first[0]!.prompt).not.toContain('official Codex session');
    expect(first[0]!.status).toBe('completed');

    const second = await f.reopen({ backend: echoBackend });
    f.store.registerAgent({ agentId: 'peer', name: 'Peer' });
    f.store.publishEntry({ agentId: 'peer', recipientId: worker.id, kind: 'MESSAGE', summary: 'Follow-up after restart' });
    await second.scan(); await idle(second, worker.id);
    expect(second.workers.get(worker.id).threadId).toBe(delivered.threadId);
    const after = echoTurns(f.path);
    expect(after).toHaveLength(2);
    expect(new Set(after.map(turn => turn.threadId))).toEqual(new Set([delivered.threadId]));
    expect(after[1]!.prompt).toContain('Follow-up after restart');
  });
  it('refuses to consume another backend\'s session identifiers and keeps events queued', async () => {
    const codexAdapter: SessionAdapter = { open: async w => w.threadId ?? 'codex-thread', run: vi.fn(async () => {}), close: async () => {} };
    const f = fixture({ adapter: codexAdapter });
    const worker = f.runtime.register({ name: 'Codex peer', workspacePath: f.dir });
    f.store.createTask({ title: 'Original goal' });
    await f.runtime.scan(); await idle(f.runtime, worker.id);
    expect(f.runtime.workers.get(worker.id)).toMatchObject({ backendId: 'codex', threadId: 'codex-thread' });

    const switched = await f.reopen({ backend: echoBackend });
    f.store.registerAgent({ agentId: 'peer', name: 'Peer' });
    const queued = f.store.publishEntry({ agentId: 'peer', recipientId: worker.id, kind: 'MESSAGE', summary: 'Must stay queued' });
    await switched.scan();
    const refused = switched.workers.get(worker.id);
    expect(refused.status).toBe('error');
    expect(refused.error).toContain(`harness backend 'codex'`);
    expect(refused.error).toContain(`not the configured 'echo'`);
    expect(refused.threadId).toBe('codex-thread');
    expect(refused.cursor).toBeLessThan(queued.id);
    expect(echoTurns(f.path)).toHaveLength(0);

    // Switching the configuration back resumes the original session and drains the queue.
    const restored = await f.reopen({ adapter: codexAdapter });
    restored.workers.update({ id: worker.id, expectedVersion: refused.version, enabled: true });
    await restored.scan(); await idle(restored, worker.id);
    expect(restored.workers.get(worker.id)).toMatchObject({ status: 'idle', threadId: 'codex-thread', backendId: 'codex' });
    expect(restored.workers.get(worker.id).cursor).toBeGreaterThanOrEqual(queued.id);
  });
  it('preserves an approval pause when the configured backend changes', async () => {
    const codexAdapter: SessionAdapter = { open: async w => w.threadId ?? 'codex-thread', run: vi.fn(async () => {}), close: async () => {} };
    const f = fixture({ adapter: codexAdapter });
    const worker = f.runtime.register({ name: 'Paused peer', workspacePath: f.dir });
    f.store.createTask({ title: 'Goal awaiting a human' });
    await f.runtime.scan(); await idle(f.runtime, worker.id);
    f.runtime.workers.pauseForApproval(worker.id);

    const switched = await f.reopen({ backend: echoBackend });
    await switched.scan();
    const paused = switched.workers.get(worker.id);
    expect(paused.enabled).toBe(false);
    expect(paused.error).toContain(approvalPauseMessage);
    expect(paused.error).toContain(`harness backend 'codex'`);
    expect(echoTurns(f.path)).toHaveLength(0);
  });
  it('rebinds a worker that never bound any session identifiers', async () => {
    const f = fixture(); // registered under the default codex backend, never delivered
    const worker = f.runtime.register({ name: 'Fresh peer', workspacePath: f.dir });
    const switched = await f.reopen({ backend: echoBackend });
    f.store.createTask({ title: 'First goal for a fresh worker' });
    await switched.scan(); await idle(switched, worker.id);
    const delivered = switched.workers.get(worker.id);
    expect(delivered).toMatchObject({ status: 'idle', backendId: 'echo' });
    expect(delivered.threadId).toMatch(/^echo-thread-/);
  });
  it('reconciles an uncertain echo delivery from its durable ledger without a replay', async () => {
    const f = fixture({ backend: echoBackend });
    const worker = f.runtime.register({ name: 'Echo peer', workspacePath: f.dir });
    f.store.createTask({ title: 'Uncertain goal' });
    await f.runtime.scan(); await idle(f.runtime, worker.id);
    const settled = f.runtime.workers.get(worker.id);
    const [turn] = echoTurns(f.path);
    expect(turn).toMatchObject({ status: 'completed' });

    const runtime = await f.reopen({ backend: echoBackend });
    runtime.workers.save({ ...runtime.workers.get(worker.id), status: 'uncertain', deliveryId: 'reconcile-delivery', deliveryCursor: settled.cursor - 1, turnId: turn.turnId });
    runtime.workers.requestReconcile({ id: worker.id, expectedVersion: runtime.workers.get(worker.id).version });
    await runtime.scan(); await idle(runtime, worker.id);
    expect(runtime.workers.get(worker.id)).toMatchObject({ status: 'idle', cursor: settled.cursor - 1, deliveryId: null, turnId: null });
    expect(echoTurns(f.path)).toHaveLength(1); // reconciled from the ledger, never re-executed
  });
});

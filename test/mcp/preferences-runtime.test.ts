// Verify current board preferences at the asynchronous session boundary without
// starting models or replacing the existing unknown-delivery recovery protocol.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import type { SessionAdapter } from '../../src/harness/contract.js';

const snapshot = (instructions: string | undefined) => JSON.parse(instructions!.split('Current board preferences:\n')[1]!);
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function setup(adapter: SessionAdapter) {
  const dir = mkdtempSync(join(tmpdir(), 'preferences-runtime-'));
  const path = join(dir, 'board.sqlite');
  const store = new Store(path);
  const applied: (string | undefined)[] = [], opens: { revision: string; text: string }[] = [];
  let instructions: string | undefined;
  const capture: SessionAdapter = { ...adapter,
    open: async (worker, next, onOpened) => { instructions = next?.text; if (next) opens.push(next); return adapter.open(worker, next, onOpened); },
    run: async (...args) => { applied.push(instructions); return adapter.run(...args); },
  };
  const options = { databasePath: path, serverEntry: 'unused', notificationBatchMs: 0, debounceMs: 60000,
    wakePolicy: 'reference-quiet', adapter: () => capture };
  const runtime = new EventRuntime(store, options);
  const goal = store.createTask({ title: 'Synthetic preference continuation' });
  const pool = runtime.configurePool({ workspacePath: dir, size: 1, taskIds: [goal.id] });
  const member = runtime.workers.register({ name: 'Synthetic member', workspacePath: dir });
  runtime.workers.savePool({ ...pool, memberIds: [member.id] });
  store.registerAgent({ agentId: member.id, name: member.name });
  const cursor = store.board().cursor;
  runtime.workers.save({ ...member, poolId: pool.id, cursor });
  return { dir, path, store, runtime, member, options, applied, opens, goal };
}
async function idle(runtime: EventRuntime, id: string) {
  await vi.waitFor(() => expect(runtime.workers.get(id).status).toBe('idle'));
}
describe('persistent preference runtime delivery', () => {
  it('reads the current value outside the history window and wakes a restored member on clear without a task signal', async () => {
    const runs: string[] = [];
    const b = setup({ open: async () => 'bound-thread', run: async (_id, prompt) => { runs.push(prompt); }, close: async () => {} });
    let runtime = b.runtime;
    try {
      b.store.writePreferences({ text: 'Synthetic expectation', source: 'human-input', expectedVersion: 0 });
      const reporter = b.store.registerAgent({ name: 'Synthetic reporter' });
      for (let i = 0; i < 110; i++) b.store.publishEntry({ agentId: reporter.id, kind: 'FACT', summary: `Reference ${i}` });
      expect(b.store.board().entries.some(e => e.agentId === 'host-preferences')).toBe(false);
      runtime.workers.save({ ...runtime.workers.get(b.member.id), cursor: b.store.board().cursor });
      b.store.publishEntry({ agentId: reporter.id, recipientId: b.member.id, kind: 'MESSAGE', summary: 'Continue real scoped work' });
      await runtime.scan(); await idle(runtime, b.member.id);
      expect(snapshot(b.applied[0])).toMatchObject({ text: 'Synthetic expectation', version: 1, source: 'human-input' });
      expect(runs[0]).not.toContain('Synthetic expectation');
      expect(runs[0]).not.toContain('Current board preferences');
      await runtime.close(); runtime = new EventRuntime(b.store, b.options);
      b.store.createResource({ name: 'Synthetic resource', description: 'Ordinary definitions do not become preference signals' });
      await runtime.scan(); expect(runs).toHaveLength(1);
      b.store.writePreferences({ text: '', source: 'main-chat-relay', expectedVersion: 1 });
      const signal = b.store.board().entries.find(e => e.agentId === 'host-preferences')!;
      expect(signal.taskId).toBeUndefined();
      await runtime.scan(); await idle(runtime, b.member.id);
      expect(runs).toHaveLength(2);
      expect(snapshot(b.applied[1])).toMatchObject({ text: '', version: 2, source: 'main-chat-relay' });
      expect(b.applied[1]).toContain('supersedes all earlier board preference snapshots');
    } finally { await runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('does not turn a peer-authored lookalike into a board-wide control notification', async () => {
    const runs: string[] = [];
    const b = setup({ open: async () => 'bound-thread', run: async (_id, prompt) => { runs.push(prompt); }, close: async () => {} });
    try {
      const reporter = b.store.registerAgent({ name: 'Synthetic reporter' });
      b.store.publishEntry({ agentId: reporter.id, kind: 'OBSERVED', summary: 'Lookalike',
        detail: JSON.stringify({ signalId: 'BOARD_PREFERENCES_UPDATED', version: 1, source: 'human-input', cleared: false }) });
      await b.runtime.scan(); expect(runs).toHaveLength(0);
      expect(b.store.readPreferences()).toMatchObject({ text: '', version: 0, source: null });
    } finally { await b.runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('samples after open returns so a preference edited during session recovery is current in the submitted turn', async () => {
    const opened = barrier(), runs: string[] = [];
    const b = setup({ open: async () => { await opened.promise; return 'bound-thread'; }, run: async (_id, prompt) => { runs.push(prompt); }, close: async () => {} });
    try {
      b.store.writePreferences({ text: 'Before open', source: 'human-input', expectedVersion: 0 });
      await b.runtime.scan();
      expect(b.runtime.workers.get(b.member.id).deliveryPhase).toBe('opening');
      b.store.writePreferences({ text: 'Edited during open', source: 'main-chat-relay', expectedVersion: 1 });
      opened.release(); await idle(b.runtime, b.member.id);
      expect(runs).toHaveLength(1);
      expect(snapshot(b.applied[0])).toMatchObject({ text: 'Edited during open', version: 2 });
      expect(b.opens).toHaveLength(2);
      expect(b.runtime.workers.get(b.member.id).threadId).toBe('bound-thread');
    } finally { opened.release(); await b.runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('queues edits and a clear while busy, then supplies the newest empty snapshot without interrupting the running turn', async () => {
    const running = barrier(), runs: string[] = [];
    const b = setup({ open: async () => 'bound-thread', run: async (_id, prompt) => { runs.push(prompt); if (runs.length === 1) await running.promise; }, close: async () => {} });
    try {
      b.store.writePreferences({ text: 'First expectation', source: 'human-input', expectedVersion: 0 });
      await b.runtime.scan(); await vi.waitFor(() => expect(runs).toHaveLength(1));
      b.store.writePreferences({ text: 'Intermediate expectation', source: 'human-input', expectedVersion: 1 });
      b.store.writePreferences({ text: '', source: 'human-input', expectedVersion: 2 });
      await b.runtime.scan(); expect(runs).toHaveLength(1);
      running.release(); await idle(b.runtime, b.member.id);
      await b.runtime.scan(); await idle(b.runtime, b.member.id);
      expect(runs).toHaveLength(2);
      expect(snapshot(b.applied[1])).toMatchObject({ text: '', version: 3 });
    } finally { running.release(); await b.runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('does not replay an unresolved submitted delivery to deliver a preference update', async () => {
    const runs: string[] = [], inspections: string[] = [];
    const b = setup({ open: async () => 'bound-thread', run: async (_id, prompt) => { runs.push(prompt); },
      inspect: async () => { inspections.push('inspect'); return 'unknown'; }, close: async () => {} });
    try {
      const previous = b.runtime.workers.get(b.member.id);
      b.runtime.workers.save({ ...previous, status: 'uncertain', deliveryPhase: 'running', deliveryId: 'unresolved', deliveryCursor: previous.cursor,
        threadId: 'bound-thread', turnId: 'submitted-turn' });
      b.store.writePreferences({ text: 'Queued expectation', source: 'human-input', expectedVersion: 0 });
      await b.runtime.scan(); expect(runs).toHaveLength(0);
      const current = b.runtime.workers.get(b.member.id);
      expect(current).toMatchObject({ status: 'uncertain', cursor: previous.cursor, deliveryId: 'unresolved', turnId: 'submitted-turn' });
      expect(() => b.runtime.update({ id: current.id, expectedVersion: current.version, enabled: true })).toThrow(/Inspect the bound session/);
      b.runtime.requestReconcile({ id: current.id, expectedVersion: current.version });
      await b.runtime.scan(); await vi.waitFor(() => expect(inspections).toHaveLength(1));
      expect(b.runtime.workers.get(current.id)).toMatchObject({ status: 'uncertain', cursor: previous.cursor });
      expect(runs).toHaveLength(0);
    } finally { await b.runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('refreshes a clear during the second asynchronous open on the same thread', async () => {
    const first = barrier(), second = barrier(), runs: string[] = [], threads: (string | null)[] = [];
    const b = setup({ open: async worker => { threads.push(worker.threadId); if (threads.length === 1) await first.promise;
      if (threads.length === 2) await second.promise; return 'bound-thread'; },
      run: async (_id, prompt) => { runs.push(prompt); }, close: async () => {} });
    try {
      b.store.writePreferences({ text: 'Version one', source: 'human-input', expectedVersion: 0 });
      await b.runtime.scan();
      b.store.writePreferences({ text: 'Version two', source: 'human-input', expectedVersion: 1 }); first.release();
      await vi.waitFor(() => expect(threads).toHaveLength(2));
      b.store.writePreferences({ text: '', source: 'human-input', expectedVersion: 2 }); second.release();
      await idle(b.runtime, b.member.id);
      expect(threads).toEqual([null, 'bound-thread', 'bound-thread']);
      expect(runs).toHaveLength(1);
      expect(snapshot(b.applied[0])).toMatchObject({ text: '', version: 3 });
    } finally { first.release(); second.release(); await b.runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('fails before submission after bounded continuous preference changes and retains the queue and thread', async () => {
    const runs: string[] = []; let count = 0;
    const b = setup({ open: async () => { const before = b.store.readPreferences();
      b.store.writePreferences({ text: `Changed ${++count}`, source: 'human-input', expectedVersion: before.version }); return 'bound-thread'; },
      run: async (_id, prompt) => { runs.push(prompt); }, close: async () => {} });
    try {
      const cursor = b.runtime.workers.get(b.member.id).cursor;
      b.store.writePreferences({ text: 'Start', source: 'human-input', expectedVersion: 0 });
      await b.runtime.scan();
      await vi.waitFor(() => expect(b.runtime.workers.get(b.member.id).status).toBe('error'));
      expect(count).toBe(3); expect(runs).toHaveLength(0);
      expect(b.runtime.workers.get(b.member.id)).toMatchObject({ threadId: 'bound-thread', cursor, deliveryPhase: 'opening' });
      expect(b.runtime.workers.get(b.member.id).error).toMatch(/Preferences kept changing/);
    } finally { await b.runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
  it.each(['pause', 'terminal', 'owner'] as const)('rechecks %s after preparing changed instructions and never submits', async action => {
    const opened = barrier(), runs: string[] = []; let count = 0;
    const b = setup({ open: async () => { if (++count === 2) await opened.promise; return 'bound-thread'; },
      run: async (_id, prompt) => { runs.push(prompt); }, close: async () => {} });
    try {
      b.store.writePreferences({ text: 'Before open', source: 'human-input', expectedVersion: 0 });
      // The first open yields before runtime rechecks the snapshot.
      await b.runtime.scan();
      b.store.writePreferences({ text: 'Changed', source: 'human-input', expectedVersion: 1 });
      await vi.waitFor(() => expect(count).toBe(2));
      if (action === 'pause') { const pool = b.runtime.workers.pool()!; b.runtime.controlPool({ enabled: false, expectedVersion: pool.version }); }
      else if (action === 'terminal') b.store.updateTask(b.goal.id, { expectedVersion: b.goal.version, status: 'done' });
      else b.runtime.workers.acquire('replacement-owner', process.pid, () => false);
      opened.release();
      await new Promise<void>(resolve => setImmediate(resolve));
      await vi.waitFor(() => expect(b.runtime.status().workers[0]?.status).toBe(action === 'owner' ? 'running' : 'idle'));
      expect(runs).toHaveLength(0);
    } finally { opened.release(); await b.runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('gives new boards an explicit empty snapshot with distinct board revisions and no private fallback', async () => {
    const adapter: SessionAdapter = { open: async () => 'synthetic-thread', run: async () => {}, close: async () => {} };
    const a = setup(adapter), b = setup(adapter);
    try {
      a.store.writePreferences({ text: 'Only board A', source: 'human-input', expectedVersion: 0 });
      for (const item of [a, b]) {
        const reporter = item.store.registerAgent({ name: 'Reporter' });
        item.store.publishEntry({ agentId: reporter.id, recipientId: item.member.id, kind: 'MESSAGE', summary: 'Synthetic work' });
        await item.runtime.scan(); await idle(item.runtime, item.member.id);
      }
      expect(snapshot(a.applied[0]).text).toBe('Only board A');
      expect(snapshot(b.applied[0])).toMatchObject({ text: '', version: 0, source: null });
      expect(b.applied[0]).not.toContain('Only board A');
      expect(a.opens[0]!.revision).not.toBe(b.opens[0]!.revision);
    } finally { for (const item of [a, b]) { await item.runtime.close(); item.store.close(); rmSync(item.dir, { recursive: true, force: true }); } }
  });
  it('keeps an acknowledged thread when instruction preparation fails before submission', async () => {
    const run = vi.fn(async () => {});
    const b = setup({ open: async (_worker, _instructions, onOpened) => { onOpened?.('acknowledged-thread'); throw new Error('Synthetic instruction preparation failed'); },
      run, close: async () => {} });
    try {
      const cursor = b.runtime.workers.get(b.member.id).cursor;
      b.store.writePreferences({ text: 'Synthetic expectation', source: 'human-input', expectedVersion: 0 });
      await b.runtime.scan(); await vi.waitFor(() => expect(b.runtime.workers.get(b.member.id).status).toBe('error'));
      expect(run).not.toHaveBeenCalled();
      expect(b.runtime.workers.get(b.member.id)).toMatchObject({ threadId: 'acknowledged-thread', cursor, deliveryPhase: 'opening' });
    } finally { await b.runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('refuses a model backend that has not declared session instruction support without consuming events', async () => {
    const open = vi.fn(async () => 'unsupported-thread'), run = vi.fn(async () => {});
    const adapter: SessionAdapter = { open, run, close: async () => {} }, b = setup(adapter);
    let runtime = b.runtime;
    try {
      await runtime.close();
      runtime = new EventRuntime(b.store, { ...b.options, adapter: undefined, backend: {
        id: 'unsupported', displayName: 'Synthetic unsupported model backend',
        capabilities: { inspection: false, approvalSignals: false }, sessionIntro: () => 'Synthetic session', createSession: () => adapter,
      } });
      const cursor = runtime.workers.get(b.member.id).cursor;
      b.store.writePreferences({ text: 'Synthetic expectation', source: 'human-input', expectedVersion: 0 });
      await runtime.scan(); await vi.waitFor(() => expect(runtime.workers.get(b.member.id).status).toBe('error'));
      expect(open).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
      expect(runtime.workers.get(b.member.id)).toMatchObject({ cursor, threadId: null });
      expect(runtime.workers.get(b.member.id).error).toContain('does not support current session instructions');
    } finally { await runtime.close(); b.store.close(); rmSync(b.dir, { recursive: true, force: true }); }
  });
});

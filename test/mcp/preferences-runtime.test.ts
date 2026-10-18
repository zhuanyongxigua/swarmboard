// Verify current board preferences at the asynchronous session boundary without
// starting models or replacing the existing unknown-delivery recovery protocol.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import type { SessionAdapter } from '../../src/harness/contract.js';

const snapshot = (prompt: string) => JSON.parse(prompt.split('Current board preferences (reference data):\n\n')[1]!);
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function setup(adapter: SessionAdapter) {
  const dir = mkdtempSync(join(tmpdir(), 'preferences-runtime-'));
  const path = join(dir, 'board.sqlite');
  const store = new Store(path);
  const options = { databasePath: path, serverEntry: 'unused', notificationBatchMs: 0, debounceMs: 60000,
    wakePolicy: 'reference-quiet', adapter: () => adapter };
  const runtime = new EventRuntime(store, options);
  const goal = store.createTask({ title: 'Synthetic preference continuation' });
  const pool = runtime.configurePool({ workspacePath: dir, size: 1, taskIds: [goal.id] });
  const member = runtime.workers.register({ name: 'Synthetic member', workspacePath: dir });
  runtime.workers.savePool({ ...pool, memberIds: [member.id] });
  store.registerAgent({ agentId: member.id, name: member.name });
  const cursor = store.board().cursor;
  runtime.workers.save({ ...member, poolId: pool.id, cursor });
  return { dir, path, store, runtime, member, options };
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
      expect(snapshot(runs[0]!)).toMatchObject({ text: 'Synthetic expectation', version: 1, source: 'human-input' });
      await runtime.close(); runtime = new EventRuntime(b.store, b.options);
      b.store.createResource({ name: 'Synthetic resource', description: 'Ordinary definitions do not become preference signals' });
      await runtime.scan(); expect(runs).toHaveLength(1);
      b.store.writePreferences({ text: '', source: 'main-chat-relay', expectedVersion: 1 });
      const signal = b.store.board().entries.find(e => e.agentId === 'host-preferences')!;
      expect(signal.taskId).toBeUndefined();
      await runtime.scan(); await idle(runtime, b.member.id);
      expect(runs).toHaveLength(2);
      expect(snapshot(runs[1]!)).toMatchObject({ text: '', version: 2, source: 'main-chat-relay' });
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
      expect(snapshot(runs[0]!)).toMatchObject({ text: 'Edited during open', version: 2 });
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
      expect(snapshot(runs[1]!)).toMatchObject({ text: '', version: 3 });
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
});

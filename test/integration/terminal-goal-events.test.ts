// Terminal goal history remains readable without consuming model turns;
// SQLite and session adapters exercise filtering before and after preparation.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import type { SessionAdapter } from '../../src/codex-session.js';
import { readReferenceEvents } from '../fixtures/reference-events.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-terminal-events-'));
  const path = join(dir, 'board.sqlite'), board = new Store(path);
  const prompts: string[] = [];
  const adapter: SessionAdapter = {
    open: vi.fn(async worker => worker.threadId ?? 'original-session'),
    run: vi.fn(async (_thread, prompt, started) => { prompts.push(prompt); started('turn-' + prompts.length); }),
    close: vi.fn(async () => {}),
  };
  const runtime = new EventRuntime(board, { databasePath: path, serverEntry: 'unused', notificationBatchMs: 0, adapter: () => adapter });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close());
  board.registerAgent({ agentId: 'peer', name: 'Peer' });
  return { dir, board, runtime, prompts, adapter };
}
async function start(f: ReturnType<typeof fixture>) {
  f.runtime.configurePool({ workspacePath: f.dir, size: 1 });
  await f.runtime.scan();
  const worker = f.runtime.workers.list()[0]!;
  await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).status).toBe('idle'));
  f.prompts.length = 0;
  vi.mocked(f.adapter.open).mockClear();
  vi.mocked(f.adapter.run).mockClear();
  return f.runtime.workers.get(worker.id);
}

it.each(['done', 'canceled'] as const)('skips a %s goal backlog while delivering current work in the original session', async status => {
  const f = fixture(), old = f.board.createTask({ title: 'Retired goal' });
  const worker = await start(f);
  const stale = Array.from({ length: 120 }, (_, index) => f.board.publishEntry({
    agentId: 'peer', taskId: old.id, kind: index % 3 === 0 ? 'MESSAGE' : index % 3 === 1 ? 'FACT' : 'FAIL',
    ...(index % 3 === 0 ? { recipientId: worker.id } : {}), summary: 'Old payload ' + index,
  }));
  const terminal = f.board.updateTask(old.id, { expectedVersion: old.version, status });
  stale.push(f.board.readEntries({ after: stale.at(-1)!.id, limit: 1 }).items[0]!);
  f.board.updateTask(old.id, { expectedVersion: terminal.version, description: 'Final human handoff' });
  const transition = f.board.readEntries({ after: stale.at(-1)!.id, limit: 1 }).items[0]!;
  const current = f.board.createTask({ title: 'Current work' });
  const fresh = f.board.publishEntry({ agentId: 'peer', taskId: current.id, recipientId: worker.id, kind: 'MESSAGE', summary: 'Useful current handoff' });
  const unlinked = f.board.publishEntry({ agentId: 'peer', recipientId: worker.id, kind: 'MESSAGE', summary: 'Operator follow-up' });
  const history = f.board.readEntries({ after: 0, limit: 200 }).items;
  await f.runtime.scan();
  await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).status).toBe('idle'));
  await f.runtime.scan();
  expect(f.prompts).toHaveLength(1);
  const delivered = readReferenceEvents(f.prompts[0]!).map(entry => entry.id);
  expect(delivered).toEqual(expect.arrayContaining([transition.id, fresh.id, unlinked.id]));
  expect(delivered.some(id => stale.some(entry => entry.id === id))).toBe(false);
  expect(f.runtime.workers.get(worker.id)).toMatchObject({ threadId: 'original-session', cursor: unlinked.id });
  expect(f.board.readEntries({ after: 0, limit: 200 }).items).toEqual(history);
});

it('rechecks cancellation after asynchronous session preparation before submitting an old batch', async () => {
  const f = fixture(), old = f.board.createTask({ title: 'Cancel during open' });
  f.board.createTask({ title: 'Other active work' });
  const worker = await start(f);
  f.runtime.workers.save({ ...worker, threadId: 'original-session', cursor: f.board.board().cursor });
  f.board.publishEntry({ agentId: 'peer', taskId: old.id, recipientId: worker.id, kind: 'MESSAGE', summary: 'Queued old work' });
  let release!: () => void;
  vi.mocked(f.adapter.open).mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return 'original-session'; });
  await f.runtime.scan();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.board.updateTask(old.id, { expectedVersion: old.version, status: 'canceled' });
  release();
  await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).status).toBe('idle'));
  expect(f.prompts.join('')).not.toContain('Queued old work');
  expect(f.prompts.flatMap(readReferenceEvents).every(entry => entry.summary.includes('(canceled)'))).toBe(true);
  expect(f.runtime.workers.get(worker.id).threadId).toBe('original-session');
});

it('does not settle or replay an unknown delivery when its goal becomes terminal', async () => {
  const f = fixture(), old = f.board.createTask({ title: 'Unknown old delivery' });
  f.board.createTask({ title: 'Current work' });
  const worker = await start(f);
  f.runtime.workers.save({ ...worker, threadId: 'original-session', status: 'uncertain', deliveryId: 'unknown-delivery',
    deliveryCursor: f.board.board().cursor, turnId: 'unknown-turn', deliveryPhase: 'running' });
  f.board.updateTask(old.id, { expectedVersion: old.version, status: 'canceled' });
  const before = f.runtime.workers.get(worker.id);
  await f.runtime.scan();
  expect(f.runtime.workers.get(worker.id)).toEqual(before);
  expect(f.adapter.open).not.toHaveBeenCalled();
  expect(f.adapter.run).not.toHaveBeenCalled();
});

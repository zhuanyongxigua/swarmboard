// End-to-end contract for an external notification consumer: register through
// the member API, receive a durable intent produced by the real runtime
// reminder path, confirm consumption, and survive a restart without replaying.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { NotificationService } from '../../src/notification-service.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'notify-contract-'));
  const boardPath = join(dir, 'board.sqlite');
  const open = (collaborators: CollaboratorStore) => {
    const board = new Store(boardPath);
    return { board, collaborators, service: new NotificationService(board, collaborators) };
  };
  let now = 1000;
  const turns: string[] = [];
  const boardProbe = new Store(boardPath);
  const runtime = new EventRuntime(boardProbe, { notificationBatchMs: 0, databasePath: boardPath, serverEntry: 'unused', now: () => now, idleMs: 100,
    adapter: worker => ({ open: async w => w.threadId ?? 'thread-' + w.id, run: async () => { turns.push(worker.id); }, close: async () => {} }) });
  const goal = boardProbe.createTask({ title: 'Contract goal' });
  // Admit through the runtime's own collaborator store: that is the store the
  // dispatcher re-checks at delivery time.
  const admitted = runtime.collaborators.configure({ expectedVersion: 0, name: 'external', harness: 'anything', sessionRef: 'sess-external', taskIds: [goal.id], enabled: true }, boardProbe).collaborator;
  let state = open(runtime.collaborators);
  runtime.configurePool({ workspacePath: dir });
  const settle = async () => { await runtime.scan(); await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true)); await runtime.scan(); };
  // Reverse order runs these: close the runtime before the databases it reads,
  // then remove the directory. A restart may already have closed them.
  const quiet = (fn: () => void) => () => { try { fn(); } catch { /* already closed */ } };
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    quiet(() => state.board.close()),
    async () => { try { await runtime.close(); } catch { /* already closed */ } },
    quiet(() => boardProbe.close()),
  );
  return {
    get board() { return state.board; },
    get service() { return state.service; },
    admitted,
    goal,
    settle,
    tick: (ms = 100) => { now += ms; },
    /** Simulate a process restart: reopen both databases and rebuild the APIs. */
    async restart() {
      // Reopen the board database and rebuild the member API exactly as a new
      // process would; admission lives in the runtime sidecar and stays open.
      state.board.close();
      state = open(runtime.collaborators);
      return state.service;
    },
  };
}

describe('external notification consumer contract', () => {
  it('receives a runtime reminder, confirms it, and never replays it after restart', async () => {
    const f = fixture();
    // Idle reminders are public board signals: a registered member receives one
    // without boardWide and without subscribing to the (internal) rotation target.
    f.service.register(f.admitted.id, {
      id: 'synthetic-consumer', version: 1, displayName: 'Synthetic consumer', harness: 'synthetic',
      enabled: true, capabilities: ['durableDelivery', 'receipt', 'sameSessionContinuation'],
      members: [{ memberId: f.admitted.id, sessionRef: f.admitted.sessionRef, taskIds: [] }],
    } as never);
    await f.settle();
    f.tick(); await f.settle();

    const first = f.service.pending(f.admitted.id);
    // One unconfirmed delivery per member; a busy channel batches several
    // actionable entries into it instead of opening a second sequence.
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ memberId: f.admitted.id, state: 'pending' });
    expect(first.items[0]!.entryIds.length).toBeGreaterThanOrEqual(1);
    // A re-scan with no new entries must not duplicate or renumber the batch.
    const before = [...first.items[0]!.entryIds];
    await f.settle();
    expect(f.service.pending(f.admitted.id).items[0]!.entryIds).toEqual(before);

    // Unconfirmed consumption stays unknown, and a restart must keep it visible.
    f.service.receipt(f.admitted.id, first.items[0]!.sequence, false);
    expect(f.service.pending(f.admitted.id).items[0]!.state).toBe('unknown');

    const restarted = await f.restart();
    const afterRestart = restarted.pending(f.admitted.id);
    expect(afterRestart.items).toHaveLength(1);
    expect(afterRestart.items[0]).toMatchObject({ sequence: first.items[0]!.sequence, state: 'unknown' });
    // No automatic replay: the unsettled count did not grow on its own.
    const channels = new NotificationAdapterStore(f.board.db);
    expect(channels.unsettled()).toHaveLength(1);

    // Confirming consumption clears it and opens the next sequence.
    restarted.receipt(f.admitted.id, first.items[0]!.sequence, true, afterRestart.items[0]!.entryIds);
    expect(restarted.pending(f.admitted.id).items).toHaveLength(0);
  });

  it('refuses to let a consumer register a scope it was never admitted to', async () => {
    const f = fixture();
    const other = f.board.createTask({ title: 'Not admitted' });
    expect(() => f.service.register(f.admitted.id, {
      id: 'synthetic-consumer', version: 1, displayName: 'Synthetic consumer', harness: 'synthetic',
      enabled: true, capabilities: ['durableDelivery'],
      members: [{ memberId: f.admitted.id, sessionRef: f.admitted.sessionRef, taskIds: [other.id] }],
    } as never)).toThrow(/exceeds admitted tasks/);
  });
});

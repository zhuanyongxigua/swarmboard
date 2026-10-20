// The idle reminder must also enqueue durable intents for registered channels,
// without the core delivering, spawning or starting anything itself.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import { createNotificationDispatcher } from '../../src/notification-dispatch.js';
import type { NotificationAdapterRegistration } from '../../src/notification-adapters.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-notify-'));
  const path = join(dir, 'board.sqlite');
  const board = new Store(path);
  const turns: string[] = [];
  let now = 1000;
  const runtime = new EventRuntime(board, { notificationBatchMs: 0, databasePath: path, serverEntry: 'unused', now: () => now, idleMs: 100,
    adapter: worker => ({ open: async w => w.threadId ?? 'thread-' + w.id,
      run: async () => { turns.push(worker.id); }, close: async () => {} }),
  });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close());
  runtime.configurePool({ workspacePath: dir });
  board.createTask({ title: 'Human goal' });
  const settle = async () => { await runtime.scan(); await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true)); await runtime.scan(); };
  return { board, runtime, settle, tick: (ms = 100) => { now += ms; } };
}

const registration = (memberId: string, patch: Partial<NotificationAdapterRegistration> = {}): NotificationAdapterRegistration => ({
  id: 'synthetic-' + memberId,
  version: 1,
  displayName: 'Synthetic ' + memberId,
  harness: 'anything-goes',
  enabled: true,
  capabilities: ['durableDelivery', 'receipt'],
  members: [{ memberId, sessionRef: 'thread-' + memberId, taskIds: [] }],
  ...patch,
});

describe('external-only board (no native workers)', () => {
  it('still dispatches registered channels during scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmboard-notify-only-'));
    const path = join(dir, 'board.sqlite');
    const board = new Store(path);
    const runtime = new EventRuntime(board, { notificationBatchMs: 0, databasePath: path, serverEntry: 'unused', now: () => 1000,
      adapter: () => ({ open: async w => w.threadId ?? 'thread-' + w.id, run: async () => {}, close: async () => {} }) });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), async () => { await runtime.close(); });
    // No pool and no native workers: the board is external-collaboration only.
    const goal = board.createTask({ title: 'External goal' });
    board.registerAgent({ agentId: 'peer-x', name: 'Peer X' });
    const me = runtime.collaborators.configure({ expectedVersion: 0, name: 'external', harness: 'anything', sessionRef: 'sess-1', taskIds: [goal.id], enabled: true }, board).collaborator;
    board.registerAgent({ agentId: me.id, name: 'External' });
    const channels = new NotificationAdapterStore(board.db);
    channels.save({ id: 'synthetic', version: 1, displayName: 'Synthetic', harness: 'anything', enabled: true, capabilities: ['durableDelivery', 'receipt'], members: [{ memberId: me.id, sessionRef: 'sess-1', taskIds: [goal.id] }] });
    const directed = board.publishEntry({ kind: 'MESSAGE', agentId: 'peer-x', summary: 'hello', detail: '', recipientId: me.id, taskId: goal.id });
    expect(runtime.hasWorkers()).toBe(false);
    await runtime.scan();
    const unsettled = channels.unsettled();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]!.intent.entryIds).toEqual([directed.id]);
  });
});

describe('reminder dispatch to registered notification channels', () => {
  it('records one durable intent for the addressed member and skips disabled channels', async () => {
    const f = fixture(); await f.settle();
    // Channels belong to admitted collaborators, not to internal pool workers.
    const goal = f.board.taskStates()[0]!;
    const admitted = f.runtime.collaborators.configure({ expectedVersion: 0, name: 'external', harness: 'anything', sessionRef: 'sess-external', taskIds: [goal.id], enabled: true }, f.board).collaborator;
    const channels = new NotificationAdapterStore(f.board.db);
    channels.save({ id: 'synthetic-alpha', version: 1, displayName: 'Synthetic', harness: 'anything', enabled: true,
      capabilities: ['durableDelivery', 'receipt'], members: [{ memberId: admitted.id, sessionRef: admitted.sessionRef, taskIds: [], boardWide: true }] });
    channels.save({ id: 'disabled-channel', version: 1, displayName: 'Disabled', harness: 'anything', enabled: false,
      capabilities: ['durableDelivery', 'receipt'], members: [{ memberId: admitted.id, sessionRef: admitted.sessionRef, taskIds: [], boardWide: true }] });

    f.tick(); await f.settle();

    // The reminder is directed to exactly one healthy member, so exactly one
    // adapter/member intent exists for it; the disabled channel is excluded.
    const intents = channels.unsettled();
    expect(intents).toHaveLength(1);
    expect(intents[0]!.intent.memberId).toBe(admitted.id);
    expect(intents[0]!.intent.entryIds.length).toBeGreaterThanOrEqual(1);
    expect(intents[0]!.state).toEqual({ state: 'pending', sequence: 1 });

    // A later idle interval reminds again. While the first delivery is still
    // unconfirmed the new entries are merged into it (busy batching) instead of
    // opening a second sequence, which the cross-sequence fence would refuse.
    const beforeCount = intents[0]!.intent.entryIds.length;
    f.tick(); await f.settle();
    const all = channels.unsettled();
    expect(all).toHaveLength(1);
    expect(all[0]!.intent.entryIds.length).toBeGreaterThan(beforeCount);
    expect(all[0]!.intent.sequence).toBe(1);
    expect(f.runtime.status().error).toBe('');
  });

  it('never enqueues ordinary peer evidence, and needs opt-in for board-level events', async () => {
    const f = fixture(); await f.settle();
    const ids = f.runtime.workers.list().map(w => w.id);
    const channels = new NotificationAdapterStore(f.board.db);
    const registrationWith = (patch: Partial<NotificationAdapterRegistration> = {}) => registration(ids[0]!, {
      members: [{ memberId: ids[0]!, sessionRef: 'thread-' + ids[0]!, taskIds: [], boardWide: true }], ...patch,
    });
    channels.save(registrationWith());
    const dispatcher = createNotificationDispatcher(f.board);

    f.board.registerAgent({ agentId: 'peer-x', name: 'Peer X' });
    f.board.registerAgent({ agentId: 'runtime-probe', name: 'Runtime probe' });
    const peerEvidence = f.board.publishEntry({ kind: 'FACT', agentId: 'peer-x', summary: 'Evidence', detail: '' });
    const peerResolution = dispatcher.dispatch(peerEvidence);
    expect(peerResolution.targets).toHaveLength(0);
    expect(peerResolution.skipped[0]?.reason).toBe('reference-only');

    const announcement = f.board.publishEntry({ kind: 'OBSERVED', agentId: 'runtime-probe', summary: 'Board update', detail: '{"status":"in_progress"}' });
    const announcementResolution = dispatcher.dispatch(announcement);
    expect(announcementResolution.targets.map(target => target.memberId)).toEqual([ids[0]]);
    expect(channels.unsettled().map(item => item.intent.entryIds[0])).toEqual([announcement.id]);
  });
});

// Guard the CLI-owned timer boundary without starting models or touching user data.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-cli-events-'));
  const path = join(dir, 'board.sqlite'), board = new Store(path);
  const turns: { memberId: string; threadId: string; prompt: string }[] = [];
  let now = 1000;
  const runtime = new EventRuntime(board, {
    databasePath: path, serverEntry: 'never-start-a-model', notificationBatchMs: 0, now: () => now,
    adapter: member => ({
      open: async worker => worker.threadId ?? `thread-${worker.id}`,
      run: async (threadId, prompt) => { turns.push({ memberId: member.id, threadId, prompt }); },
      inspect: async () => 'unknown' as const,
      close: async () => {},
    }),
  });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close());
  runtime.configurePool({ workspacePath: dir });
  board.createTask({ title: 'Shared human goal' });
  const settle = async () => {
    await runtime.scan();
    await vi.waitFor(() => expect(runtime.workers.list().every(worker => worker.status === 'idle')).toBe(true));
    await runtime.scan();
  };
  return { board, runtime, turns, settle, advance: () => { now += 24 * 60 * 60 * 1000; } };
}

it('keeps ordinary events on the original sessions but never synthesizes periodic wakes', async () => {
  const f = fixture(); await f.settle();
  const identities = f.runtime.workers.list().map(worker => [worker.id, worker.threadId]);
  const initial = f.turns.length;
  for (let n = 0; n < 3; n++) { f.advance(); await f.settle(); }
  expect(f.turns).toHaveLength(initial);
  expect(f.board.readEntries({ query: 'SESSION_TASK_CHECK' }).items).toHaveLength(0);
  expect(f.board.readEntries({ query: 'IDLE_RECOVERY' }).items).toHaveLength(0);
  const member = f.runtime.workers.list()[0]!;
  f.board.registerAgent({ agentId: 'reviewer', name: 'Synthetic reviewer' });
  f.board.publishEntry({ agentId: 'reviewer', kind: 'MESSAGE', recipientId: member.id, summary: 'Review the shared goal' });
  await f.settle();
  expect(f.turns).toHaveLength(initial + 1);
  expect(f.turns.at(-1)).toMatchObject({ memberId: member.id, threadId: member.threadId });
  expect(f.runtime.workers.list().map(worker => [worker.id, worker.threadId])).toEqual(identities);
});

it('retains legacy timer records and an unknown submission without generating a replacement wake', async () => {
  const f = fixture(); await f.settle();
  f.runtime.workers.db.exec('CREATE TABLE IF NOT EXISTS seat_checks (seatKey TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const historical = JSON.stringify({ memberId: 'old-member', sessionRef: 'old-thread', nextDueAt: 1, pendingMerged: true });
  f.runtime.workers.db.prepare('INSERT INTO seat_checks VALUES (?,?)').run('legacy-timer', historical);
  const idleHistory = { fingerprint: 'old-goals', attempts: 2, idleSince: 0, state: 'nudged' as const,
    pending: { agentId: 'old-runtime', kind: 'MESSAGE' as const, summary: 'Old idle reminder', detail: '' } };
  f.runtime.workers.saveLiveness(idleHistory);
  const member = f.runtime.workers.list()[0]!;
  f.runtime.workers.save({ ...member, status: 'uncertain', deliveryPhase: 'submitting',
    deliveryId: 'unacknowledged-original', deliveryCursor: member.cursor, turnId: null });
  const count = f.turns.length;
  f.advance(); await f.runtime.scan();
  expect(f.runtime.workers.get(member.id)).toMatchObject({ status: 'uncertain', threadId: member.threadId,
    deliveryId: 'unacknowledged-original', deliveryPhase: 'submitting', turnId: null });
  expect(f.runtime.workers.db.prepare('SELECT data FROM seat_checks WHERE seatKey=?').get('legacy-timer')?.data).toBe(historical);
  expect(f.runtime.workers.liveness()).toEqual(idleHistory);
  expect(f.runtime.status().activity.watchdog).toEqual({ state: 'inactive', attempts: 0, nextWakeAt: null });
  expect(f.turns).toHaveLength(count);
});

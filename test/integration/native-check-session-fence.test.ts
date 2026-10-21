// Native checks need the same consumption-time session/scope fence as external
// intents: a queued old-session reminder must not wake its replacement session.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'native-check-fence-'));
  const board = new Store(join(dir, 'board.sqlite'));
  const turns: { thread: string; prompt: string }[] = [];
  const runtime = new EventRuntime(board, {
    databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused',
    notificationBatchMs: 0, sessionCheckMs: 300000, now: () => 1000000,
    adapter: () => ({ open: async worker => worker.threadId ?? 'original-session',
      run: async (thread, prompt) => { turns.push({ thread, prompt }); }, close: async () => {} }),
  });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close());
  runtime.configurePool({ workspacePath: dir, size: 1, maxSize: 1 });
  const goal = board.createTask({ title: 'Authorized review' });
  const settle = async () => {
    await runtime.scan();
    await vi.waitFor(() => expect(runtime.workers.list().every(worker => worker.status === 'idle')).toBe(true));
  };
  await settle(); await settle(); turns.length = 0;
  const worker = runtime.workers.list()[0]!;
  const agentId = 'runtime-fence-probe';
  board.registerAgent({ agentId, name: 'Synthetic runtime' });
  const publish = () => board.publishEntry({ agentId, kind: 'MESSAGE', recipientId: worker.id,
    summary: 'SESSION_TASK_CHECK: queued-period-probe',
    detail: JSON.stringify({ kind: 'SESSION_TASK_CHECK', memberId: worker.id,
      sessionRef: worker.threadId, dueAt: 900000, goalIds: [goal.id] }) });
  return { runtime, board, turns, worker, goal, publish, settle };
}

it('continues a current-session check on the original native session', async () => {
  const f = await fixture(); f.publish(); await f.settle();
  expect(f.turns).toHaveLength(1);
  expect(f.turns[0]!.thread).toBe(f.worker.threadId);
  expect(f.turns[0]!.prompt).toContain('queued-period-probe');
});

it('does not retarget a queued native check after its session binding changes', async () => {
  const f = await fixture(); f.publish();
  // Model the persisted binding after an explicit host/backend session change.
  f.runtime.workers.save({ ...f.runtime.workers.get(f.worker.id), threadId: 'replacement-session' });
  await f.settle();
  expect(f.turns.some(turn => turn.prompt.includes('queued-period-probe'))).toBe(false);
});

it('does not consume a queued native check after its last goal becomes blocked', async () => {
  const f = await fixture(); f.publish();
  f.board.updateTask(f.goal.id, { expectedVersion: f.board.readTask(f.goal.id).version, status: 'blocked' });
  await f.settle();
  expect(f.turns.some(turn => turn.prompt.includes('queued-period-probe'))).toBe(false);
});

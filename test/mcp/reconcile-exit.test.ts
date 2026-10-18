// F1 regression (peer6 finding, independently confirmed 2224): an uncertain
// delivery in the opening phase without a submitted turn must reach a
// deterministic no-RPC error exit; post-submission unknown deliveries keep the
// inspect fence and stay unresolvable by a blind enable.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';

function harness(dir: string) {
  const store = new Store(join(dir, 'board.sqlite'));
  const factoryCalls: string[] = [];
  const inspects: string[] = [];
  const runtime = new EventRuntime(store, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused',
    notificationBatchMs: 0, debounceMs: 5,
    adapter: worker => { factoryCalls.push(worker.id); return {
      open: async () => 'test-thread',
      run: async () => {},
      inspect: async () => { inspects.push(worker.id); return 'unknown'; },
      close: async () => {} }; } });
  const goal = store.createTask({ title: 'Reconcile exit goal' });
  void goal; // keeps the board actionable; the reconcile paths under test are goal-independent
  const pool = runtime.configurePool({ workspacePath: dir, size: 1 });
  const workspace = join(dir, 'member'); mkdirSync(workspace, { recursive: true });
  const member = runtime.workers.register({ name: 'Equal peer', workspacePath: workspace });
  const caughtUp = Number((store.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as { cursor: number }).cursor);
  runtime.workers.save({ ...member, poolId: pool.id, cursor: caughtUp });
  runtime.workers.savePool({ ...pool, memberIds: [member.id] });
  store.registerAgent({ agentId: member.id, name: member.name });
  return { store, runtime, member, factoryCalls, inspects, cursorAtRisk: caughtUp };
}
describe('F1: opening-without-turn uncertain exit', () => {
  it('clears a threadless opening uncertain to error with zero RPC and an enableable retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-nothread-'));
    const board = harness(dir);
    try {
      board.runtime.workers.save({ ...board.runtime.workers.get(board.member.id), status: 'uncertain', threadId: null, turnId: null,
        deliveryId: 'delivery-f1', deliveryCursor: board.cursorAtRisk, deliveryPhase: 'opening', error: 'prior attempt' });
      board.runtime.workers.requestReconcile({ id: board.member.id, expectedVersion: board.runtime.workers.get(board.member.id).version });
      await board.runtime.scan();
      const cleared = board.runtime.workers.get(board.member.id);
      expect(cleared.status).toBe('error');
      expect(cleared.error).toContain('no model turn was submitted');
      expect(cleared.cursor).toBe(board.cursorAtRisk); // original cursor preserved: nothing replays silently
      expect(board.factoryCalls).toHaveLength(0); // no session opened
      expect(board.inspects).toHaveLength(0); // deterministic, no RPC
      // The exit is real: a human-inspected error worker can be re-enabled.
      const enabled = board.runtime.workers.update({ id: board.member.id, expectedVersion: cleared.version, enabled: true });
      expect(enabled).toMatchObject({ enabled: true, status: 'idle' });
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('clears a resume-timeout opening (threadId present, no turn) through the same deterministic branch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-resume-'));
    const board = harness(dir);
    try {
      board.runtime.workers.save({ ...board.runtime.workers.get(board.member.id), status: 'uncertain', threadId: 'resume-thread', turnId: null,
        deliveryId: 'delivery-f1b', deliveryCursor: board.cursorAtRisk, deliveryPhase: 'opening', error: 'thread/resume timed out; delivery outcome is unknown' });
      board.runtime.workers.requestReconcile({ id: board.member.id, expectedVersion: board.runtime.workers.get(board.member.id).version });
      await board.runtime.scan();
      const cleared = board.runtime.workers.get(board.member.id);
      expect(cleared.status).toBe('error');
      expect(cleared.error).toContain('no model turn was submitted');
      expect(board.factoryCalls).toHaveLength(0);
      expect(board.inspects).toHaveLength(0);
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps the post-submission unknown fence: inspect runs and a blind enable is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-fence-'));
    const board = harness(dir);
    try {
      board.runtime.workers.save({ ...board.runtime.workers.get(board.member.id), status: 'uncertain', threadId: 'live-thread', turnId: 'turn-1',
        deliveryId: 'delivery-f1c', deliveryCursor: board.cursorAtRisk, deliveryPhase: 'running', error: 'unknown after submission' });
      board.runtime.workers.requestReconcile({ id: board.member.id, expectedVersion: board.runtime.workers.get(board.member.id).version });
      await board.runtime.scan();
      expect(board.inspects).toHaveLength(1); // the unknown delivery is inspected, never guessed
      const still = board.runtime.workers.get(board.member.id);
      expect(still.status).toBe('uncertain');
      expect(still.cursor).toBe(board.cursorAtRisk); // cursor not advanced past an unresolved delivery
      expect(() => board.runtime.workers.update({ id: board.member.id, expectedVersion: still.version, enabled: true })).toThrow(/Inspect the bound session/);
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

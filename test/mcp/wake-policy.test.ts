// Focused behavioral regression for the opt-in reference-quiet wake policy:
// identical bounded event streams produce fewer inert adapter run calls while
// actionable wakes, durable history and cursor fences stay reliable.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { wakePolicySettings } from '../../src/wake-policy.js';

function harness(policy: 'all' | 'reference-quiet', dir: string) {
  const store = new Store(join(dir, 'board.sqlite'));
  const runs: string[] = [];
  const runtime = new EventRuntime(store, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused',
    notificationBatchMs: 0, wakePolicy: policy,
    adapter: () => ({ open: async () => 'test-thread', run: async (_threadId: string, prompt: string) => { runs.push(prompt); }, close: async () => {} }) });
  const goal = store.createTask({ title: 'Wake policy goal' });
  const pool = runtime.configurePool({ workspacePath: dir, size: 1 });
  const member = runtime.workers.register({ name: 'Equal peer', workspacePath: dir });
  // The member joins already caught up to the board position (goal creation
  // included); only entries published after organization count for wake counts.
  const caughtUp = Number((store.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as { cursor: number }).cursor);
  runtime.workers.save({ ...member, poolId: pool.id, cursor: caughtUp });
  runtime.workers.savePool({ ...pool, memberIds: [member.id] });
  store.registerAgent({ agentId: member.id, name: member.name });
  return { store, runtime, runs, goal, member };
}
async function settle(runtime: EventRuntime, memberId: string) {
  await runtime.scan();
  for (let i = 0; i < 30 && runtime.workers.get(memberId).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 10));
}
describe('reference-quiet wake policy', () => {
  it('turns identical ordinary evidence into reference context instead of model turns while direct messages still wake', async () => {
    const allDir = mkdtempSync(join(tmpdir(), 'wake-all-')), quietDir = mkdtempSync(join(tmpdir(), 'wake-quiet-'));
    const all = harness('all', allDir), quiet = harness('reference-quiet', quietDir);
    try {
      expect(all.runtime.status().wakePolicy).toBe('all');
      expect(quiet.runtime.status().wakePolicy).toBe('reference-quiet');
      const publish = (store: Store, goal: { id: string }, agentId: string, round: number) => {
        for (const kind of ['FACT', 'CLAIM', 'PATCH_SUMMARY'] as const) store.publishEntry({ agentId, taskId: goal.id, kind, summary: `${kind} reference ${round}` });
      };
      const foreignAll = all.store.registerAgent({ name: 'Reporter' }), foreignQuiet = quiet.store.registerAgent({ name: 'Reporter' });
      for (let round = 1; round <= 2; round++) {
        publish(all.store, all.goal, foreignAll.id, round); publish(quiet.store, quiet.goal, foreignQuiet.id, round);
        await settle(all.runtime, all.member.id); await settle(quiet.runtime, quiet.member.id);
      }
      // Before/after for the identical stream: default wakes twice, opt-in never wakes.
      expect(all.runs).toHaveLength(2);
      expect(quiet.runs).toHaveLength(0);
      // The quiet member's cursor still advanced over all six references and
      // they remain durable history for context_read/context_search.
      const history = quiet.store.readEntries({ after: 0, limit: 100 }).items;
      expect(history.filter(e => ['FACT', 'CLAIM', 'PATCH_SUMMARY'].includes(e.kind))).toHaveLength(6);
      expect(quiet.store.readEntries({ after: quiet.runtime.workers.get(quiet.member.id).cursor, limit: 10 }).items).toEqual([]);
      quiet.store.publishEntry({ agentId: foreignQuiet.id, recipientId: quiet.member.id, kind: 'MESSAGE', summary: 'Direct handoff needs you' });
      await settle(quiet.runtime, quiet.member.id);
      expect(quiet.runs).toHaveLength(1);
      expect(quiet.runs[0]).toContain('Direct handoff needs you');
      expect(quiet.runtime.workers.get(quiet.member.id)).toMatchObject({ status: 'idle', deliveryId: null, turnId: null });
    } finally {
      await all.runtime.close(); all.store.close(); rmSync(allDir, { recursive: true, force: true });
      await quiet.runtime.close(); quiet.store.close(); rmSync(quietDir, { recursive: true, force: true });
    }
  });
  it('keeps a later actionable failure visible behind more than fifty reference entries in one scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-backlog-'));
    const board = harness('reference-quiet', dir);
    try {
      const foreign = board.store.registerAgent({ name: 'Bulk reporter' });
      for (let i = 0; i < 60; i++) board.store.publishEntry({ agentId: foreign.id, taskId: board.goal.id, kind: 'FACT', summary: `Bulk reference ${i}` });
      board.store.publishEntry({ agentId: foreign.id, taskId: board.goal.id, kind: 'FAIL', summary: 'Actionable failure after backlog' });
      await settle(board.runtime, board.member.id);
      expect(board.runs).toHaveLength(1);
      expect(board.runs[0]).toContain('Actionable failure after backlog');
      expect(board.runs[0]).not.toContain('Bulk reference');
      expect(board.store.readEntries({ after: board.runtime.workers.get(board.member.id).cursor, limit: 10 }).items).toEqual([]);
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not replay consumed references after restart and still wakes on a human goal revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-restart-'));
    const first = harness('reference-quiet', dir);
    try {
      const foreign = first.store.registerAgent({ name: 'Reporter' });
      for (const kind of ['FACT', 'CLAIM', 'PATCH_SUMMARY'] as const) first.store.publishEntry({ agentId: foreign.id, taskId: first.goal.id, kind, summary: `${kind} reference` });
      await settle(first.runtime, first.member.id);
      expect(first.runs).toHaveLength(0);
      expect(first.runtime.workers.get(first.member.id).cursor).toBeGreaterThan(0);
      await first.runtime.close();
      const runs: string[] = [];
      const reopened = new EventRuntime(first.store, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused',
        notificationBatchMs: 0, wakePolicy: 'reference-quiet',
        adapter: () => ({ open: async () => 'test-thread', run: async (_threadId: string, prompt: string) => { runs.push(prompt); }, close: async () => {} }) });
      await settle(reopened, first.member.id);
      expect(runs).toHaveLength(0); // restart replays nothing already consumed
      const revised = first.store.readTask(first.goal.id);
      first.store.updateTask(first.goal.id, { expectedVersion: revised.version, status: 'in_review' });
      await settle(reopened, first.member.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toContain('in_review');
      await reopened.close();
    } finally { first.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('still wakes members on the board scope-expansion control signal under reference-quiet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-scope-'));
    const store = new Store(join(dir, 'board.sqlite'));
    const runs: string[] = [];
    const runtime = new EventRuntime(store, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused',
      notificationBatchMs: 0, wakePolicy: 'reference-quiet',
      adapter: () => ({ open: async () => 'test-thread', run: async (_threadId: string, prompt: string) => { runs.push(prompt); }, close: async () => {} }) });
    try {
      const chosen = store.createTask({ title: 'Initially selected goal' });
      store.createTask({ title: 'Goal outside the initial selection' });
      const pool = runtime.configurePool({ workspacePath: dir, size: 1, taskIds: [chosen.id] });
      const member = runtime.workers.register({ name: 'Equal peer', workspacePath: dir });
      const caughtUp = Number((store.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as { cursor: number }).cursor);
      runtime.workers.save({ ...member, poolId: pool.id, cursor: caughtUp });
      runtime.workers.savePool({ ...pool, memberIds: [member.id] });
      store.registerAgent({ agentId: member.id, name: member.name });
      runtime.configurePool({ workspacePath: dir, size: 1, expectedVersion: pool.version, taskIds: [] }); // widen to the whole board, same single member
      await settle(runtime, member.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toContain('BOARD_SCOPE_EXPANDED');
      expect(store.readEntries({ after: runtime.workers.get(member.id).cursor, limit: 10 }).items).toEqual([]);
    } finally { await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('wakes on a goal created by a legitimately named host agent even without host-grant side effects (entry-2301 shape)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-named-host-'));
    const board = harness('reference-quiet', dir);
    try {
      const namedHost = board.store.registerAgent({ agentId: 'root-token-trial', name: 'Named host trial' });
      const created = board.store.createTask({ title: 'Goal from a named host', agentId: namedHost.id });
      void created;
      await settle(board.runtime, board.member.id);
      expect(board.runs).toHaveLength(1);
      expect(board.runs[0]).toContain('Task created: Goal from a named host');
      const entry = board.store.readEntries({ after: 0, limit: 10 }).items.find(e => e.summary.startsWith('Task created: Goal from a named host'));
      expect(JSON.parse(entry!.detail)).toMatchObject({ version: 1, status: 'todo' });
      expect(board.store.readEntries({ after: board.runtime.workers.get(board.member.id).cursor, limit: 10 }).items).toEqual([]);
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('wakes on a participant description-only revision whose patch carries no status or version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-desc-revision-'));
    const board = harness('reference-quiet', dir);
    try {
      const participant = board.store.registerAgent({ name: 'Participant editor' });
      board.store.claimTask(board.goal.id, { agentId: participant.id, expectedVersion: board.store.readTask(board.goal.id).version });
      const before = board.store.readTask(board.goal.id);
      board.store.updateTask(board.goal.id, { agentId: participant.id, expectedVersion: before.version, description: 'Revised description without any status change' });
      await settle(board.runtime, board.member.id);
      expect(board.runs).toHaveLength(1);
      const entry = board.store.readEntries({ after: 0, limit: 10 }).items.find(e => e.summary.startsWith('Task updated:'));
      expect(JSON.parse(entry!.detail)).toMatchObject({ version: before.version + 1, status: before.status, description: 'Revised description without any status change' });
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('projects resource-definition control metadata without waking pool members (no taskId fence unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-resource-meta-'));
    const board = harness('reference-quiet', dir);
    try {
      const namedHost = board.store.registerAgent({ agentId: 'root-token-trial', name: 'Named host trial' });
      const resource = board.store.createResource({ name: 'Shared build machine', description: 'host resource', agentId: namedHost.id });
      board.store.updateResource(resource.id, { expectedVersion: resource.version, description: 'tightened access notes' });
      await settle(board.runtime, board.member.id);
      expect(board.runs).toHaveLength(0); // resource definitions stay non-waking for pool members
      const added = board.store.readEntries({ after: 0, limit: 10 }).items.find(e => e.summary.startsWith('Resource added:'));
      const updated = board.store.readEntries({ after: 0, limit: 10 }).items.find(e => e.summary.startsWith('Resource updated:'));
      expect(JSON.parse(added!.detail)).toMatchObject({ version: 1 });
      expect(JSON.parse(updated!.detail)).toMatchObject({ version: 2, description: 'tightened access notes' });
    } finally { await board.runtime.close(); board.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('parses the host policy configuration strictly without a prose surface', () => {
    expect(wakePolicySettings({}, {})).toBe('all');
    expect(wakePolicySettings({}, { SWARMBOARD_WAKE_POLICY: 'reference-quiet' })).toBe('reference-quiet');
    expect(wakePolicySettings({ wakePolicy: 'all' }, { SWARMBOARD_WAKE_POLICY: 'reference-quiet' })).toBe('all');
    expect(() => wakePolicySettings({}, { SWARMBOARD_WAKE_POLICY: 'quiet' })).toThrow(/Invalid wake policy/);
  });
});

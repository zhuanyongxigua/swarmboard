// Exercise the public runtime with real SQLite and synthetic transports so
// periodic discovery proves scoped, useful continuation rather than just a tick.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Entry } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import type { SessionAdapter } from '../../src/harness/contract.js';
import { NotificationAdapterStore } from '../../src/notification-adapter-store.js';
import { SeatCheckStore } from '../../src/seat-check-store.js';

const INTERVAL = 300_000;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function fixture(adapter?: SessionAdapter) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-session-continuation-'));
  const path = join(dir, 'board.sqlite');
  const board = new Store(path);
  let now = 1000;
  // Keep scans explicit: these tests advance a logical five-minute clock,
  // never run a real model, watcher or five-minute wall-clock wait.
  const periodic = { sessionCheckMs: INTERVAL };
  const runtime = new EventRuntime(board, { ...periodic, databasePath: path, serverEntry: 'unused',
    now: () => now, notificationBatchMs: 0, debounceMs: 60_000,
    adapter: adapter ? () => adapter : undefined });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close());
  const entries = () => board.readEntries({ after: 0, limit: 200 }).items;
  const checks = () => entries().filter(e => e.summary.startsWith('SESSION_TASK_CHECK'));
  return { dir, path, board, runtime, entries, checks, advance: () => { now += INTERVAL; } };
}

const payload = (entry: Entry) => JSON.parse(entry.detail) as { goalIds: string[]; sessionRef: string; dueAt: number };

describe('session task checks through the public runtime', () => {
  it('does not enroll an admitted durable channel without timed reminder consent', async () => {
    const f = fixture(), goal = f.board.createTask({ title: 'Optional timed checks' });
    const member = f.runtime.configureCollaborator({ expectedVersion: 0, name: 'Ordinary updates only',
      harness: 'synthetic-orchid', sessionRef: 'original-no-timer', taskIds: [goal.id], enabled: true });
    new NotificationAdapterStore(f.board.db).save({ id: 'ordinary-only', version: 1, displayName: 'Ordinary only',
      harness: 'synthetic-orchid', enabled: true, capabilities: ['durableDelivery', 'receipt'],
      members: [{ memberId: member.id, sessionRef: member.sessionRef, taskIds: [goal.id] }] });
    await f.runtime.scan();
    for (let cycle = 0; cycle < 3; cycle++) { f.advance(); await f.runtime.scan(); }
    expect(f.checks()).toEqual([]);
  });

  it('does not turn a bare channel registration into a session admission', async () => {
    const f = fixture(), goal = f.board.createTask({ title: 'Needs formal admission' });
    new NotificationAdapterStore(f.board.db).save({ id: 'unadmitted', version: 1, displayName: 'Unadmitted',
      harness: 'synthetic-orchid', enabled: true, capabilities: ['durableDelivery'],
      members: [{ memberId: 'not-admitted', sessionRef: 'not-authorized', taskIds: [goal.id] }] });
    await f.runtime.scan();
    for (let cycle = 0; cycle < 3; cycle++) { f.advance(); await f.runtime.scan(); }
    expect(f.checks()).toEqual([]);
    expect(f.board.db.prepare('SELECT id FROM agents WHERE id=?').get('not-admitted')).toBeUndefined();
  });

  it('does not republish a persisted due period when its current goal sample shrinks', async () => {
    const f = fixture({ open: async worker => worker.threadId!, run: async () => {}, close: async () => {} });
    const goals = ['Review A', 'Review B'].map(title => f.board.createTask({ title }));
    for (const goal of goals) f.board.updateTask(goal.id, { expectedVersion: 1, status: 'in_review' });
    // An existing original session is bound before its first periodic scan.
    f.runtime.configurePool({ workspacePath: f.dir, taskIds: goals.map(g => g.id), size: 1, maxSize: 1 });
    const pool = f.runtime.workers.pool()!;
    f.runtime.workers.checkpointPool({ ...pool, state: 'active' });
    f.runtime.pool.ensureMembers(f.runtime.workers.pool()!);
    const worker = f.runtime.workers.list()[0]!;
    f.runtime.workers.save({ ...worker, threadId: 'original-session', cursor: f.board.board().cursor });
    await f.runtime.scan(); f.advance(); await f.runtime.scan();
    await vi.waitFor(() => expect(f.runtime.workers.get(worker.id).status).toBe('idle'));
    const first = f.checks()[0]!;
    expect(first).toBeDefined();
    const checks = new SeatCheckStore(f.runtime.workers.db);
    const record = [...checks.list().values()].find(row => row.memberId === worker.id)!;
    // Restore the durable checkpoint from a crash after board publication but
    // before outbox acknowledgement. The goal list changes before recovery.
    checks.save([{ ...record, pending: { dueAt: payload(first).dueAt, goalIds: payload(first).goalIds } }]);
    f.board.updateTask(goals[0]!.id, { expectedVersion: f.board.readTask(goals[0]!.id).version, status: 'blocked' });
    await f.runtime.scan();
    expect(f.checks().filter(entry => payload(entry).dueAt === payload(first).dueAt)).toHaveLength(1);
  });

  it('rediscovers a review goal after finishing another contribution in the original native session', async () => {
    const contributions: string[] = [], sessions: string[] = [];
    const adapter: SessionAdapter = {
      open: vi.fn(async worker => worker.threadId ?? 'unexpected-new-session'),
      run: vi.fn(async (sessionRef, prompt, started) => {
        sessions.push(sessionRef); started(`turn-${sessions.length}`);
        expect(prompt).toContain('SESSION_TASK_CHECK');
        // A synthetic participant re-reads the actual goal list each turn.
        // No fixed task assignment or list cached from its first contribution.
        const task = scope.map(id => f.board.readTask(id)).find(t => ['todo', 'in_progress', 'in_review'].includes(t.status));
        if (!task) throw new Error('A periodic turn ran without scoped work');
        const joined = f.board.claimTask(task.id, { agentId: workerId, expectedVersion: task.version });
        f.board.publishEntry({ agentId: workerId, taskId: task.id, kind: 'PATCH_SUMMARY', summary: `Verified contribution ${task.id}` });
        f.board.updateTask(task.id, { agentId: workerId, expectedVersion: joined.version, status: 'done' });
        contributions.push(task.id);
      }),
      close: vi.fn(async () => {}),
    };
    const f = fixture(adapter);
    const first = f.board.createTask({ title: 'Implementation contribution' });
    const review = f.board.createTask({ title: 'Independent review contribution' });
    f.board.updateTask(review.id, { expectedVersion: 1, status: 'in_review' });
    const blocked = f.board.createTask({ title: 'Requires human budget' });
    f.board.updateTask(blocked.id, { expectedVersion: 1, status: 'blocked' });
    const outside = f.board.createTask({ title: 'Outside organization scope' });
    const scope = [first.id, review.id, blocked.id];
    f.runtime.configurePool({ workspacePath: f.dir, taskIds: scope, size: 1, maxSize: 1 });
    f.runtime.pool.sync(false);
    const worker = f.runtime.workers.list()[0]!;
    const workerId = worker.id;
    f.runtime.workers.save({ ...worker, threadId: 'original-native-session', cursor: f.board.board().cursor });
    await f.runtime.scan();
    expect(contributions).toEqual([]);

    for (const expectedGoal of [first.id, review.id]) {
      f.advance(); await f.runtime.scan();
      await vi.waitFor(() => expect(contributions.at(-1)).toBe(expectedGoal));
      await vi.waitFor(() => expect(f.runtime.workers.get(workerId).status).toBe('idle'));
      await f.runtime.scan();
    }
    expect(contributions).toEqual([first.id, review.id]);
    expect(sessions).toEqual(['original-native-session', 'original-native-session']);
    expect(f.runtime.workers.get(workerId).threadId).toBe('original-native-session');
    expect(f.checks()).toHaveLength(2);
    expect(payload(f.checks()[1]!).goalIds).toEqual([review.id]);
    expect(f.entries().filter(e => e.summary.startsWith('IDLE_RECOVERY'))).toEqual([]);
    expect(f.board.taskStates().find(t => t.id === outside.id)?.status).toBe('todo');
    expect(f.board.taskStates().find(t => t.id === blocked.id)?.status).toBe('blocked');
    f.advance(); await f.runtime.scan();
    expect(contributions).toHaveLength(2);
  });

  it('routes an external review check only to its scoped original session and fences an unknown receipt', async () => {
    const f = fixture();
    const review = f.board.createTask({ title: 'External review' });
    f.board.updateTask(review.id, { expectedVersion: 1, status: 'in_review' });
    const outside = f.board.createTask({ title: 'Another member scope' });
    const channels = new NotificationAdapterStore(f.board.db);
    const add = (name: string, taskIds: string[]) => {
      const member = f.runtime.configureCollaborator({ expectedVersion: 0, name, harness: 'synthetic-orchid',
        sessionRef: `original-${name}`, taskIds, enabled: true });
      channels.save({ id: `channel-${name}`, version: 1, displayName: name, harness: 'synthetic-orchid', enabled: true,
        capabilities: ['durableDelivery', 'receipt', 'sameSessionContinuation', 'timedReminder'],
        members: [{ memberId: member.id, sessionRef: member.sessionRef, taskIds }] });
      return member;
    };
    const reviewer = add('reviewer', [review.id]);
    const other = add('other', [outside.id]);
    await f.runtime.scan();
    f.advance(); await f.runtime.scan();
    const directed = f.checks().filter(e => e.recipientId === reviewer.id);
    expect(directed).toHaveLength(1);
    expect(payload(directed[0]!)).toMatchObject({ goalIds: [review.id], sessionRef: reviewer.sessionRef });
    const intent = channels.pendingIntent('channel-reviewer', reviewer.id)!;
    expect(intent).not.toBeNull();
    expect(intent.entryIds).toEqual([directed[0]!.id]);
    expect(channels.pendingIntent('channel-other', other.id)?.entryIds).not.toContain(directed[0]!.id);
    channels.recordReceipt('channel-reviewer', reviewer.id, { sequence: intent.sequence, consumed: false });
    const before = channels.reconcile('channel-reviewer', reviewer.id);
    expect(before.state?.state).toBe('unknown');
    for (let scan = 0; scan < 3; scan++) { f.advance(); await f.runtime.scan(); }
    expect(channels.reconcile('channel-reviewer', reviewer.id)).toEqual(before);
    expect(f.checks().filter(e => e.recipientId === reviewer.id)).toHaveLength(1);
    expect(f.entries().filter(e => e.summary.startsWith('IDLE_RECOVERY'))).toEqual([]);
    expect(f.runtime.workers.list()).toEqual([]);
  });
});

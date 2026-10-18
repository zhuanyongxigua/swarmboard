import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';

const stores: Store[] = [], dirs: string[] = [];
const open = (path = ':memory:') => { const store = new Store(path); stores.push(store); return store; };
const close = (store: Store) => { stores.splice(stores.indexOf(store), 1); store.close(); };
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const report = { percent: 70, state: 'active' as const, phase: 'Integration', verified: 'Synthetic unit checks passed', remaining: 'Independent acceptance' };
const fixture = (store: Store) => { const actor = store.registerAgent({ name: 'Synthetic reporter' }); const goal = store.createTask({ title: 'Synthetic work' }); return { actor, goal: store.claimTask(goal.id, { agentId: actor.id, expectedVersion: goal.version }) }; };

describe('reported task progress', () => {
  it('defaults old/new tasks to unknown without creating a fabricated estimate', () => {
    const store = open(), task = store.createTask({ title: 'Unestimated' });
    expect(task.progress).toBeNull();
    expect(store.readTask(task.id).progress).toBeNull();
    expect(store.readTasks().items[0]!.progress).toBeNull();
  });
  it('persists progress with server provenance, exposes compact discovery and permits reasoned revision without completing work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-progress-')); dirs.push(dir); const path = join(dir, 'board.sqlite');
    const store = open(path), { actor, goal } = fixture(store);
    let current = store.writeTaskProgress(goal.id, { expectedVersion: goal.version, agentId: actor.id, progress: report });
    expect(current).toMatchObject({ status: 'in_progress', version: goal.version + 1, progress: { ...report, reportedBy: actor.id } });
    expect(current.progress!.updatedAt).toBe(current.updatedAt);
    const summary = store.readTasks().items[0]!;
    expect(summary.progress).toMatchObject({ percent: 70, phase: report.phase });
    expect(summary.progress).not.toHaveProperty('verified');
    expect(summary.progress).not.toHaveProperty('remaining');
    expect(store.readTaskPage({ id: goal.id }).progress).toEqual(current.progress);
    const observer = open(path), observed = observer.readTask(goal.id);
    current = store.writeTaskProgress(goal.id, { expectedVersion: current.version, progress: { ...report, percent: 35, state: 'waiting', verified: 'New synthetic gap found' } });
    expect(current.progress).toMatchObject({ percent: 35, state: 'waiting', reportedBy: 'human' });
    expect(() => observer.writeTaskProgress(goal.id, { expectedVersion: observed.version, progress: report })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    current = store.writeTaskProgress(goal.id, { expectedVersion: current.version, progress: { ...report, percent: 100 } });
    expect(current.status).toBe('in_progress');
    close(store); expect(open(path).readTask(goal.id)).toEqual(current);
  });
  it('enforces participant permissions, optimistic concurrency, strict provenance and valid state/estimate combinations', () => {
    const store = open(), { actor, goal } = fixture(store); const outsider = store.registerAgent({ name: 'Outsider' });
    const initial = store.board();
    expect(() => store.writeTaskProgress(goal.id, { expectedVersion: goal.version, agentId: outsider.id, progress: report })).toThrowError(expect.objectContaining({ code: 'NOT_PARTICIPANT', status: 403 }));
    expect(() => store.writeTaskProgress(goal.id, { expectedVersion: goal.version - 1, agentId: actor.id, progress: report })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }));
    const invalid = [
      ...[-1, 101, Number.NaN, Number.POSITIVE_INFINITY].map(percent => ({ expectedVersion: goal.version, progress: { ...report, percent } })),
      { expectedVersion: goal.version, progress: { ...report, percent: null } },
      { expectedVersion: goal.version, progress: { ...report, state: 'unknown' } },
      { expectedVersion: goal.version, progress: { ...report, verified: '' } },
      { expectedVersion: goal.version, progress: { ...report, reportedBy: 'human' } },
      { expectedVersion: goal.version, progress: { ...report, updatedAt: 'forged' } },
    ];
    for (const input of invalid) expect(() => store.writeTaskProgress(goal.id, input)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(store.board()).toEqual(initial);
  });
  it('clears with task-version advancement and rolls task/progress back if the event fails', () => {
    const store = open(), { goal } = fixture(store);
    let current = store.writeTaskProgress(goal.id, { expectedVersion: goal.version, progress: report });
    current = store.writeTaskProgress(goal.id, { expectedVersion: current.version, progress: null });
    expect(current).toMatchObject({ progress: null, status: 'in_progress', version: goal.version + 2 });
    expect(() => store.writeTaskProgress(goal.id, { expectedVersion: goal.version, progress: report })).toThrow(/State changed/);
    const before = store.board();
    store.db.exec("CREATE TEMP TRIGGER reject_progress BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'progress-event-failure'); END");
    expect(() => store.writeTaskProgress(goal.id, { expectedVersion: current.version, progress: report })).toThrow(/progress-event-failure/);
    expect(store.board()).toEqual(before);
  });
  it('reports explicit uncertainty with no percentage and leaves task lifecycle untouched', () => {
    const store = open(), { goal } = fixture(store);
    const progress = { percent: null, state: 'unknown', phase: 'Checking evidence', verified: '', remaining: 'Estimate is not reliable yet' };
    expect(store.writeTaskProgress(goal.id, { expectedVersion: goal.version, progress })).toMatchObject({ progress, status: 'in_progress' });
  });
  it('upgrades existing v5 task/resource/history data with unknown progress without rewriting the originals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-progress-upgrade-')); dirs.push(dir); const path = join(dir, 'board.sqlite');
    const store = open(path), { goal } = fixture(store);
    store.createResource({ name: 'Synthetic retained resource', kind: 'legacy', capabilities: ['read'] });
    const before = store.board(); const boardId = store.readAutomation().boardId;
    store.db.exec('DROP TRIGGER usage_admission_insert; DROP TRIGGER usage_admission_update; DROP TABLE resource_admission_fences; DROP TABLE task_progress; DROP TABLE board_preferences; PRAGMA user_version=5;'); close(store);
    const upgraded = open(path);
    expect(upgraded.board()).toEqual(before);
    expect(upgraded.readTask(goal.id).progress).toBeNull();
    expect(upgraded.readAutomation().boardId).toBe(boardId);
    expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
  });
});

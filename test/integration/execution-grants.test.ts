// Verify host-owned task grants survive restart without becoming agent-editable
// task text, pool rebinding, or permission to bypass sandbox approvals.
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { WorkerStore } from '../../src/worker-store.js';
import { ExecutionGrants } from '../../src/execution-grants.js';
import { workerPrompt } from '../../src/worker-prompt.js';
import { codexBackend } from '../../src/codex-session.js';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });
it('persists a versioned grant for one goal, retains pool bindings and excludes terminal goals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-grants-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const board = new Store(join(dir, 'board.sqlite')); cleanups.push(() => board.close());
  let workers = new WorkerStore(join(dir, 'runtime.sqlite')); cleanups.push(() => workers.close());
  const goal = board.createTask({ title: 'Host authorized goal' });
  workers.savePool({ id: 'pool', version: 7, workspacePath: dir, size: 1, maxSize: 1, taskIds: [], enabled: true, state: 'active', error: '', memberIds: [] });
  let grants = new ExecutionGrants(board, workers);
  const input = { taskId: goal.id, expectedVersion: 0, projectPath: dir, executionWorkspace: dir, externalHarnesses: ['zcode'], monitoring: true, enabled: true };
  expect(grants.configure(input)).toMatchObject({ taskId: goal.id, version: 1, poolId: 'pool', enabled: true });
  expect(() => grants.configure(input)).toThrow(/changed/i);
  expect(workers.pool()).toMatchObject({ id: 'pool', version: 7, taskIds: [] });
  workers.close(); workers = new WorkerStore(join(dir, 'runtime.sqlite')); grants = new ExecutionGrants(board, workers);
  expect(grants.active()).toHaveLength(1);
  const member = workers.register({ name: 'Equal peer', workspacePath: dir });
  const prompt = workerPrompt('delivery', [], codexBackend.sessionIntro(member), workers.pool(), grants.active());
  expect(prompt).toContain('TRUSTED_HOST_EXECUTION_GRANTS');
  expect(prompt).toContain(goal.id); expect(prompt).toContain('zcode');
  expect(prompt).toContain('do not bypass');
  grants.configure({ ...input, expectedVersion: 1, enabled: false }); expect(grants.active()).toEqual([]);
  grants.configure({ ...input, expectedVersion: 2 }); expect(grants.active()).toHaveLength(1);
  board.updateTask(goal.id, { expectedVersion: goal.version, status: 'done' }); expect(grants.active()).toEqual([]);
  expect(grants.list()).toHaveLength(1);
});
it('authorizes dsh alongside zcode with strict ids and no duplicates, surfaced to workers through the grant prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-grants-dsh-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const board = new Store(join(dir, 'board.sqlite')); cleanups.push(() => board.close());
  const workers = new WorkerStore(join(dir, 'runtime.sqlite')); cleanups.push(() => workers.close());
  const goal = board.createTask({ title: 'Dual harness goal' });
  workers.savePool({ id: 'pool', version: 1, workspacePath: dir, size: 1, maxSize: 1, taskIds: [], enabled: true, state: 'active', error: '', memberIds: [] });
  const grants = new ExecutionGrants(board, workers);
  const base = { taskId: goal.id, expectedVersion: 0, projectPath: dir, executionWorkspace: dir, monitoring: true, enabled: true };
  const both = grants.configure({ ...base, externalHarnesses: ['dsh', 'zcode'] });
  expect(both).toMatchObject({ externalHarnesses: ['dsh', 'zcode'], version: 1, enabled: true });
  expect(() => grants.configure({ ...base, externalHarnesses: ['dsh', 'dsh'] })).toThrow(/at most once/);
  expect(() => grants.configure({ ...base, externalHarnesses: ['zcode', 'zcode'] })).toThrow(/at most once/);
  expect(() => grants.configure({ ...base, externalHarnesses: ['dsh', 'unknown-harness'] })).toThrow();
  const member = workers.register({ name: 'Equal peer', workspacePath: dir });
  const prompt = workerPrompt('delivery', [], codexBackend.sessionIntro(member), workers.pool(), grants.active());
  expect(prompt).toContain('TRUSTED_HOST_EXECUTION_GRANTS');
  expect(prompt).toContain('dsh'); expect(prompt).toContain('zcode');
  // No default routing: an explicit empty list stays empty and revokes none of
  // the other boundaries; it is a deliberate host edit at the current version.
  expect(grants.configure({ ...base, expectedVersion: 1, externalHarnesses: [] })).toMatchObject({ externalHarnesses: [], version: 2 });
});
it('rejects missing goals, malformed paths, unsupported harnesses and grants outside the pool subscription', () => {
  const board = new Store(); cleanups.push(() => board.close());
  const workers = new WorkerStore(':memory:'); cleanups.push(() => workers.close());
  const goal = board.createTask({ title: 'Outside selected subscription' });
  workers.savePool({ id: 'pool', version: 1, workspacePath: tmpdir(), size: 1, maxSize: 1, taskIds: ['another-goal'], enabled: true, state: 'active', error: '', memberIds: [] });
  const grants = new ExecutionGrants(board, workers);
  const input = { taskId: goal.id, expectedVersion: 0, projectPath: tmpdir(), executionWorkspace: tmpdir(), externalHarnesses: ['zcode'], monitoring: true, enabled: true };
  expect(() => grants.configure(input)).toThrow(/subscription/i);
  expect(() => grants.configure({ ...input, taskId: 'missing' })).toThrow();
  expect(() => grants.configure({ ...input, projectPath: 'relative' })).toThrow();
  expect(() => grants.configure({ ...input, externalHarnesses: ['arbitrary-harness'] })).toThrow();
  expect(grants.list()).toEqual([]);
});

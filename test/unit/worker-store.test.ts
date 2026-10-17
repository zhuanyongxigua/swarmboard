// Exercise the persisted worker configuration boundaries and optimistic updates.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { WorkerStore, processAlive } from '../../src/worker-store.js';
let store: WorkerStore;
beforeEach(() => { store = new WorkerStore(':memory:'); });
afterEach(() => store.close());
describe('worker configuration', () => {
  it('requires an actual absolute directory and rejects duplicate subscriptions regardless of input ordering', () => {
    for (const workspacePath of ['relative', '/a-directory-that-does-not-exist', '/etc/hosts']) expect(() => store.register({ name: 'Builder', workspacePath })).toThrow(/absolute workspace/);
    const first = store.register({ name: 'Builder', workspacePath: tmpdir(), taskIds: ['b', 'a', 'a'] });
    expect(first.taskIds).toEqual(['a', 'b']);
    expect(() => store.register({ name: 'Duplicate', workspacePath: tmpdir(), taskIds: ['a', 'b'] })).toThrow(/already have/);
    expect(() => store.get('missing')).toThrow(/not found/);
  });
  it('does not let a stale delivery checkpoint undo a newer pause or reconciliation request', () => {
    const original = store.register({ name: 'Builder', workspacePath: tmpdir() });
    store.pauseForApproval(original.id);
    expect(store.save({ ...original, status: 'idle', cursor: 7 })).toMatchObject({ enabled: false, version: 2, cursor: 7 });
    const before = store.get(original.id);
    store.save({ ...before, status: 'uncertain', deliveryId: 'pending' });
    store.requestReconcile({ id: original.id, expectedVersion: 2 });
    expect(store.save({ ...before, status: 'uncertain' })).toMatchObject({ enabled: false, version: 3, reconcileRequested: true });
  });
  it('persists pause/resume with version checks but cannot clear an ambiguous delivery', () => {
    const w = store.register({ name: 'Builder', workspacePath: tmpdir() });
    expect(store.update({ id: w.id, expectedVersion: 1, enabled: false })).toMatchObject({ enabled: false, version: 2 });
    expect(() => store.update({ id: w.id, expectedVersion: 1, enabled: true })).toThrow(/changed/);
    expect(store.update({ id: w.id, expectedVersion: 2, enabled: true })).toMatchObject({ enabled: true, version: 3 });
    store.save({ ...store.get(w.id), status: 'uncertain', deliveryId: 'unknown' });
    expect(() => store.update({ id: w.id, expectedVersion: 3, enabled: true })).toThrow(/Inspect/);
    expect(() => store.requestReconcile({ id: w.id, expectedVersion: 2 })).toThrow(/changed/);
    expect(store.requestReconcile({ id: w.id, expectedVersion: 3 })).toMatchObject({ reconcileRequested: true, version: 4, deliveryId: 'unknown' });
    expect(processAlive(process.pid)).toBe(true);
  });
});

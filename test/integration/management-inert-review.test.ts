// Verify management mode stays inert even when no live owner can mask an accidental scan.
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';

it('does not claim an unowned organization or open sessions through host edits, notify, or direct scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'management-unowned-'));
  const store = new Store(join(dir, 'board.sqlite'));
  let attempts = 0;
  const runtime = new EventRuntime(store, {
    databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', managementOnly: true,
    adapter: () => { attempts++; throw new Error('Unexpected session open'); },
  });
  try {
    const goal = store.createTask({ title: 'Unowned management fixture' });
    const pool = runtime.configurePool({ workspacePath: dir, size: 1 });
    const member = runtime.workers.register({ name: 'Unstarted peer', workspacePath: dir });
    runtime.workers.save({ ...member, poolId: pool.id });
    runtime.workers.savePool({ ...pool, memberIds: [member.id] });
    runtime.configureExecutionGrant({ taskId: goal.id, expectedVersion: 0, projectPath: dir,
      executionWorkspace: dir, externalHarnesses: ['dsh'], monitoring: true, enabled: true });
    runtime.configureCollaborator({ expectedVersion: 0, name: 'Reviewer', harness: 'dsh',
      sessionRef: 'isolated', taskIds: [goal.id], enabled: true });
    runtime.notify();
    await runtime.scan();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(runtime.workers.owner()).toBeNull();
    expect(attempts).toBe(0);
    expect(runtime.workers.get(member.id)).toMatchObject({ cursor: 0, threadId: null, deliveryId: null, turnId: null });
  } finally {
    await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

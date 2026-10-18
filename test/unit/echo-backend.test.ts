// Backend-specific behavior of the deterministic echo reference adapter: it
// executes no model and must still journal, reconcile and refuse honestly.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createEchoBackend, echoBackend } from '../../src/harness/echo-backend.js';
import { UncertainDelivery } from '../../src/harness/contract.js';
import { adapterContract, contractWorker, contractWorkspace } from '../harness/adapter-contract.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(turnMs?: number) {
  const workspace = contractWorkspace('swarmboard-echo-'); cleanups.push(workspace.cleanup);
  const statePath = join(workspace.dir, 'runtime.sqlite');
  const worker = contractWorker({ id: 'echo-worker' });
  const backend = createEchoBackend(turnMs === undefined ? {} : { turnMs });
  const context = { databasePath: ':memory:', statePath, serverEntry: 'unused', worker, onApproval: () => {} };
  return { backend, worker, context, statePath, session: () => backend.createSession(context) };
}
function turns(statePath: string) {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try { return db.prepare('SELECT workerId,threadId,turnId,prompt,status FROM echo_turns ORDER BY id').all() as { workerId: string; threadId: string; turnId: string; prompt: string; status: string }[]; }
  finally { db.close(); }
}

adapterContract('echo reference backend', () => {
  const f = fixture();
  const slow = createEchoBackend({ turnMs: 60000 });
  return {
    backend: f.backend, worker: f.worker, session: f.session,
    interruptedDelivery: async () => {
      const session = slow.createSession(f.context);
      const threadId = await session.open(f.worker);
      const pending = session.run(threadId, 'interrupted delivery', () => {});
      await new Promise(resolve => setImmediate(resolve));
      void session.close();
      return pending;
    },
    cleanup: () => {},
  };
});

describe('echo reference backend', () => {
  it('labels itself deterministic without approval signals and keeps a stable thread identity', async () => {
    expect(echoBackend).toMatchObject({ id: 'echo', deterministic: true, capabilities: { inspection: true, approvalSignals: false } });
    expect(echoBackend.sessionIntro(contractWorker())).toContain('deterministic echo reference backend');
    const f = fixture();
    const firstSession = f.session();
    const first = await firstSession.open(f.worker);
    expect(first).toBe('echo-thread-echo-worker');
    const second = f.session();
    expect(await second.open({ ...f.worker, threadId: first })).toBe(first);
    await firstSession.close(); await second.close();
  });
  it('journals every prompt durably and reconciles a lost acknowledgement by its delivery marker', async () => {
    const f = fixture(0);
    const session = f.session();
    const threadId = await session.open(f.worker);
    await session.run(threadId, 'Swarmboard delivery marker-delivery-1. body', () => {});
    await session.run(threadId, 'Swarmboard delivery marker-delivery-2. body', () => {});
    await session.close();
    const rows = turns(f.statePath);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.threadId === threadId && row.status === 'completed')).toBe(true);
    const restarted = f.session();
    expect(await restarted.inspect!(threadId, null, 'marker-delivery-2')).toBe('completed');
    expect(await restarted.inspect!(threadId, null, 'different-delivery')).toBe('unknown');
    await restarted.close();
  });
  it('keeps an interrupted turn honestly active instead of inventing completion', async () => {
    const f = fixture(60000);
    const session = f.session();
    const threadId = await session.open(f.worker);
    let turnId = '';
    const pending = session.run(threadId, 'Swarmboard delivery interrupt-delivery. body', started => { turnId = started; });
    await new Promise(resolve => setImmediate(resolve));
    await session.close();
    await expect(pending).rejects.toBeInstanceOf(UncertainDelivery);
    const rows = turns(f.statePath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', threadId });
    const restarted = f.session();
    expect(await restarted.inspect!(threadId, turnId, 'interrupt-delivery')).toBe('active');
    await restarted.close();
  });
  it('honors the configured turn duration and falls back to the default for invalid values', async () => {
    const fast = createEchoBackend({}, { SWARMBOARD_ECHO_TURN_MS: '0' });
    const slow = createEchoBackend({}, { SWARMBOARD_ECHO_TURN_MS: 'not-a-number' });
    const workspace = contractWorkspace('swarmboard-echo-env-'); cleanups.push(workspace.cleanup);
    const worker = contractWorker();
    const run = async (backend: ReturnType<typeof createEchoBackend>) => {
      const session = backend.createSession({ databasePath: ':memory:', statePath: join(workspace.dir, 'runtime.sqlite'), serverEntry: 'unused', worker, onApproval: () => {} });
      const threadId = await session.open(worker);
      const started = Date.now();
      await session.run(threadId, 'body', () => {});
      await session.close();
      return Date.now() - started;
    };
    expect(await run(fast)).toBeLessThan(50);
    expect(await run(slow)).toBeGreaterThanOrEqual(20);
  });
});

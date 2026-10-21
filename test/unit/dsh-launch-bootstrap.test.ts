import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { applyDshLaunchPermission, createDshLaunchBootstrap, createDshLaunchSetup } from '../../src/harness/dsh/launch-bootstrap.js';
import type { DshSdkSessionAgent } from '../../src/harness/dsh/sdk-session.js';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(durable = true) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const agent: DshSdkSessionAgent<string> = { id: 'original', status: 'idle',
    session: { id: 'original', header: { cwd: '/synthetic' }, events: [] }, inbox: { hasPending: false }, send: vi.fn() };
  let current: typeof agent | undefined;
  let owns = false;
  const dispose = vi.fn(async () => {}), install = vi.fn(() => () => {});
  const permission = vi.fn(), flush = vi.fn(async () => durable);
  const order: string[] = [];
  const options = { db, adapterId: 'channel', memberId: 'member', sessionRef: 'original', cwd: '/synthetic',
    sdkSessionId: (s: string) => s, messageId: (s: string) => s,
    model: { provider: 'synthetic-provider', model: 'synthetic-model', reasoningEffort: 'off' },
    permissionPreset: 'synthetic-preset', recordState: vi.fn(), installModelSelection: install, applyPermission: permission,
    lease: { acquire: () => { order.push('lease'); owns = true; return true; }, owns: () => owns, release: () => { owns = false; } },
    prepareInstructions: async () => { order.push('instructions'); }, isAuthorized: () => true,
    callTool: vi.fn(async () => ({ structuredContent: { items: [], cursor: 0, hasMore: false } })), getCurrentBinding: async () => ({ adapterId: 'channel', memberId: 'member', sessionRef: 'original', registrationVersion: 1, taskIds: ['task'], enabled: true }),
    subscribeWake: vi.fn((_listener: () => void) => () => {}), onError: vi.fn() };
  const ctx = { agents: { get: vi.fn(() => current), create: vi.fn(async () => { throw new Error('forbidden'); }),
    resume: vi.fn(async (input: { resumeSessionId: string; [key: string]: unknown }) => {
      order.push('resume'); expect(owns).toBe(true);
      expect((input.setup as (ctx: object) => unknown)({})).toBeUndefined();
      current = agent; return { agent, dispose };
    }) }, sessions: { flush }, on: vi.fn(() => () => {}) };
  const bootstrap = createDshLaunchBootstrap(options);
  return { bootstrap, options, ctx, agent, dispose, permission, flush, install, order, setLive: () => { current = agent; } };
}
it('scoped setup is explicitly void and snapshots non-default model selection', () => {
  const model = { provider: 'custom', model: 'name', reasoningEffort: 'custom-effort' };
  const install = vi.fn((_ctx: object, _selection: unknown) => () => {}); const setup = createDshLaunchSetup({ model, installModelSelection: install });
  model.model = 'changed'; expect(setup({})).toBeUndefined();
  expect(install.mock.calls[0][1]).toEqual({ current: { provider: 'custom', model: 'name', reasoningEffort: 'custom-effort' }, assembled: undefined });
});
it('official preset write must read back consistently without a product permission default', () => {
  const set = vi.fn(); const agent = { session: { events: [] } };
  expect(() => applyDshLaunchPermission({ permissionPresets: { set, current: () => 'custom' } }, agent, 'explicit')).toThrow('PERMISSION_CONFLICT');
  applyDshLaunchPermission({ permissionPresets: { set, current: () => 'explicit' } }, agent, 'explicit');
  expect(set).toHaveBeenLastCalledWith(agent.session, 'explicit');
});
it('is inert until apply, resumes only under ownership and flushes permissions before readiness', async () => {
  const f = fixture(); expect(f.order).toEqual([]); expect(f.ctx.agents.get).not.toHaveBeenCalled();
  const close = f.bootstrap.plugin.apply(f.ctx); await f.bootstrap.ready();
  expect(f.order.slice(0, 3)).toEqual(['lease', 'instructions', 'resume']);
  expect(f.permission).toHaveBeenCalledWith(f.ctx, f.agent, 'synthetic-preset'); expect(f.flush).toHaveBeenCalledWith(f.agent.session);
  expect(f.ctx.agents.create).not.toHaveBeenCalled(); expect(f.bootstrap.ownedHandles()).toHaveLength(1);
  expect(f.bootstrap.status()).toEqual({ phase: 'ready' });
  await close(); expect(f.options.lease.owns()).toBe(false); expect(f.dispose).not.toHaveBeenCalled();
  expect(() => f.bootstrap.plugin.apply(f.ctx)).toThrow('DSH_LAUNCH_CLOSED');
});
it('failed durability preserves the handle, intent and ownership without retry or disposal', async () => {
  const f = fixture(false); const close = f.bootstrap.plugin.apply(f.ctx);
  await expect(f.bootstrap.ready()).rejects.toThrow('PERMISSION_NOT_DURABLE');
  expect(f.bootstrap.ownedHandles()).toHaveLength(1);
  await expect(close()).rejects.toThrow('NOT_QUIESCENT'); expect(f.options.lease.owns()).toBe(true);
  expect(f.ctx.agents.resume).toHaveBeenCalledTimes(1); expect(f.dispose).not.toHaveBeenCalled();
});
it('rejects an existing live agent before ownership or a second resume', () => {
  const f = fixture(); f.setLive(); expect(() => f.bootstrap.plugin.apply(f.ctx)).toThrow('AGENT_ALREADY_LIVE');
  expect(f.ctx.agents.resume).not.toHaveBeenCalled(); expect(f.order).toEqual([]);
});
it('closing before apply fences future admission', async () => {
  const f = fixture(); await f.bootstrap.close();
  expect(() => f.bootstrap.plugin.apply(f.ctx)).toThrow('DSH_LAUNCH_CLOSED');
  expect(f.ctx.agents.resume).not.toHaveBeenCalled();
});

it('post-ready host failure replaces ready status with a finite durable failure state', async () => {
  const f = fixture(); let wake = () => {};
  f.options.subscribeWake.mockImplementationOnce(listener => { wake = listener; return () => {}; });
  // Construct with the updated subscription, keeping all actual core host behavior.
  const bootstrap = createDshLaunchBootstrap(f.options); const close = bootstrap.plugin.apply(f.ctx);
  await bootstrap.ready(); expect(bootstrap.status().phase).toBe('ready');
  f.options.callTool.mockRejectedValueOnce(new Error('STALE_NOTIFICATION_BINDING'));
  wake();
  await vi.waitFor(() => expect(bootstrap.status()).toEqual({ phase: 'failed', errorCode: 'STALE_NOTIFICATION_BINDING' }));
  expect(f.options.recordState).toHaveBeenLastCalledWith({ phase: 'failed', errorCode: 'STALE_NOTIFICATION_BINDING' });
  await expect(close()).rejects.toThrow('NOT_QUIESCENT'); expect(f.dispose).not.toHaveBeenCalled();
});

it('rejects an asynchronous state sink before model or ownership effects', () => {
  const f = fixture(); const bootstrap = createDshLaunchBootstrap({ ...f.options, recordState: async () => {} });
  expect(() => bootstrap.plugin.apply(f.ctx)).toThrow('DSH_LAUNCH_ASYNC_STATE_SINK');
  expect(f.order).toEqual([]); expect(f.ctx.agents.resume).not.toHaveBeenCalled();
});
it('rejects an asynchronous permission callback before claiming durable setup', async () => {
  const f = fixture(); const bootstrap = createDshLaunchBootstrap({ ...f.options, applyPermission: async () => {} });
  const close = bootstrap.plugin.apply(f.ctx);
  await expect(bootstrap.ready()).rejects.toThrow('DSH_LAUNCH_ASYNC_PERMISSION');
  expect(f.flush).not.toHaveBeenCalled(); expect(bootstrap.ownedHandles()).toHaveLength(1);
  await expect(close()).rejects.toThrow('NOT_QUIESCENT');
});

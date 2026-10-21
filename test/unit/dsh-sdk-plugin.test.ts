import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDshSdkPlugin, type DshSdkPluginContext, type DshSdkPluginOptions } from '../../src/harness/dsh/sdk-plugin.js';
import { driveOnce, type DeliveryBatch, type DriveResult } from '../../src/harness/dsh/notification-driver.js';
import type { DshSdkSessionAgent } from '../../src/harness/dsh/sdk-session.js';

const batch: DeliveryBatch = { adapterId: 'test-channel', memberId: 'member', sessionRef: 'original',
  delivery: { sequence: 1, entryIds: [10] }, entries: [{ id: 10, kind: 'MESSAGE', summary: 'synthetic work' }] };
const empty: DriveResult = { submitted: [], merged: [], skipped: [], unknown: [], rejected: [],
  receiptsConfirmed: [], receiptPending: [], awaitingCompletion: [] };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(overrides: Partial<DshSdkPluginOptions<string, string, DshSdkSessionAgent<string>>> = {}) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const agent: DshSdkSessionAgent<string> = { id: 'original', status: 'idle',
    session: { id: 'original', header: { cwd: '/synthetic' }, events: [] }, inbox: { hasPending: false }, send: vi.fn() };
  let registered: DshSdkSessionAgent<string> | undefined = agent;
  let owner = false;
  const release = vi.fn(() => { owner = false; });
  const lease = { acquire: vi.fn(() => { owner = true; return true; }), owns: () => owner, release };
  const flush = vi.fn(async () => true);
  const dispose = vi.fn(async () => {});
  const sdk = { get: vi.fn(() => registered),
    create: vi.fn(async () => { registered = agent; return { agent, dispose }; }),
    resume: vi.fn(async () => { registered = agent; return { agent, dispose }; }) };
  const listeners = new Map<string, (...args: never[]) => void>();
  const removals: string[] = [];
  const ctx = { agents: sdk, sessions: { flush }, on(name: string, listener: (...args: never[]) => void) {
    listeners.set(name, listener); return () => { listeners.delete(name); removals.push(name); };
  } } as DshSdkPluginContext<string, string, DshSdkSessionAgent<string>>;
  let signal = () => {};
  const unsubscribe = vi.fn();
  const pass = vi.fn(async () => empty);
  const stop = vi.fn(async () => { lease.release(); });
  const prepareInstructions = vi.fn(async () => {});
  const onError = vi.fn();
  const options: DshSdkPluginOptions<string, string, DshSdkSessionAgent<string>> = {
    adapterId: 'test-channel', memberId: 'member', sessionRef: 'original', cwd: '/synthetic', mode: 'attach', db,
    sdkSessionId: s => s, messageId: s => s, createOptions: {}, resumeOptions: {}, lease,
    pending: { list: async () => [], confirm: async () => {}, release: async () => {}, isCurrent: async () => true },
    isAuthorized: () => true, prepareInstructions,
    subscribeWake: listener => { signal = listener; return unsubscribe; },
    createRunner: vi.fn(() => ({ pass, stop })), onError, ...overrides,
  };
  const boundary = createDshSdkPlugin(options);
  const emit = (name: string, ...args: unknown[]) => listeners.get(name)?.(...args as never[]);
  return { boundary, options, ctx, db, agent, sdk, flush, dispose, lease, pass, stop, prepareInstructions, onError,
    emit, wake: () => signal(), unsubscribe, removals, removeAgent: () => { registered = undefined; } };
}

describe('official SDK plugin entry', () => {
  it('is inert until explicit apply and attaches the original session under the lease', async () => {
    const f = fixture();
    expect(f.lease.acquire).not.toHaveBeenCalled();
    const close = f.boundary.plugin.apply(f.ctx);
    await f.boundary.ready();
    expect(f.sdk.get).toHaveBeenCalledWith('original');
    expect(f.sdk.create).not.toHaveBeenCalled(); expect(f.sdk.resume).not.toHaveBeenCalled();
    expect(f.prepareInstructions).toHaveBeenCalledTimes(2);
    expect(f.pass).toHaveBeenCalledTimes(1);
    expect(f.boundary.ownedHandles()).toEqual([]);
    await close(); expect(f.stop).toHaveBeenCalledTimes(1); expect(f.dispose).not.toHaveBeenCalled();
  });

  it('fails before instructions, registry access or subscriptions when another host owns the lease', async () => {
    const f = fixture({ lease: { acquire: () => false, owns: () => false, release: vi.fn() } });
    const close = f.boundary.plugin.apply(f.ctx);
    await expect(f.boundary.ready()).rejects.toThrow('DSH_HOST_LEASE_REQUIRED');
    expect(f.prepareInstructions).not.toHaveBeenCalled(); expect(f.sdk.get).not.toHaveBeenCalled();
    f.wake(); expect(f.pass).not.toHaveBeenCalled();
    await close();
  });

  it('composes the real SDK port and journal, and fences the final send with current lease ownership', async () => {
    const f = fixture({ createRunner: ({ ports, lease }) => ({ pass: () => driveOnce(ports), stop: async () => { lease.release(); } }) });
    f.options.pending.list = async () => [batch];
    const close = f.boundary.plugin.apply(f.ctx); await f.boundary.ready();
    expect(f.agent.send).toHaveBeenCalledTimes(1); expect(f.flush).toHaveBeenCalledWith(f.agent.session);
    expect(f.db.prepare('SELECT data FROM dsh_host_journal WHERE slot LIKE ?').get('notification:%')).toBeDefined();
    f.lease.release(); f.wake(); await f.boundary.drain();
    expect(f.agent.send).toHaveBeenCalledTimes(1);
    await close();
  });

  it('coalesces wake bursts while pass is in flight and ignores other sessions and running transitions', async () => {
    const f = fixture(); const gate = deferred(); const entered = deferred();
    f.pass.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return empty; });
    const close = f.boundary.plugin.apply(f.ctx);
    await entered.promise;
    for (let i = 0; i < 5; i++) f.wake();
    f.emit('agent/status', { agent: { ...f.agent }, status: 'idle' });
    f.emit('agent/status', { agent: f.agent, status: 'running' });
    gate.resolve(); await f.boundary.ready(); await f.boundary.drain();
    expect(f.pass).toHaveBeenCalledTimes(2);
    f.emit('agent/status', { agent: f.agent, status: 'idle' }); await f.boundary.drain();
    expect(f.pass).toHaveBeenCalledTimes(3);
    f.emit('session/event', { ...f.agent.session }, { type: 'turn/end', seq: 1, data: {} });
    await f.boundary.drain(); expect(f.pass).toHaveBeenCalledTimes(3);
    await close();
  });

  it('closes admission immediately, waits for the current pass, then unsubscribes and stops without disposing the agent', async () => {
    const f = fixture(); const gate = deferred(); const entered = deferred();
    f.pass.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return empty; });
    const close = f.boundary.plugin.apply(f.ctx);
    await entered.promise;
    const closing = close(); f.wake();
    expect(f.stop).not.toHaveBeenCalled();
    gate.resolve(); await closing;
    expect(f.pass).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1); expect(f.removals).toHaveLength(2);
    expect(f.dispose).not.toHaveBeenCalled(); await close(); expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('retains owned resume handles and durable intent after a conflicting binding, with no automatic retry', async () => {
    const f = fixture({ mode: 'resume' }); f.removeAgent();
    f.sdk.resume.mockImplementation(async () => ({ agent: { ...f.agent, id: 'foreign' }, dispose: f.dispose }));
    const close = f.boundary.plugin.apply(f.ctx);
    await expect(f.boundary.ready()).rejects.toThrow('DSH_SESSION_CONFLICT');
    expect(f.boundary.ownedHandles()).toHaveLength(1);
    expect(f.db.prepare('SELECT data FROM dsh_host_journal WHERE slot=?').get('lifecycle:original')).toBeDefined();
    f.wake(); await f.boundary.drain(); expect(f.sdk.resume).toHaveBeenCalledTimes(1);
    expect(f.onError).toHaveBeenCalledTimes(1);
    await expect(close()).rejects.toThrow('DSH_HOST_NOT_QUIESCENT');
    expect(f.lease.owns()).toBe(true); expect(f.dispose).not.toHaveBeenCalled();
  });

  it('passes quiescence to the runner and retains the lease until an explicit idle-boundary close', async () => {
    const f = fixture({ createRunner: ({ lease, canRelease }) => ({ pass: async () => empty,
      stop: async () => { if (!canRelease()) throw new Error('DSH_HOST_NOT_QUIESCENT'); lease.release(); } }) });
    const close = f.boundary.plugin.apply(f.ctx); await f.boundary.ready();
    f.agent.status = 'running'; await expect(close()).rejects.toThrow('DSH_HOST_NOT_QUIESCENT');
    expect(f.lease.owns()).toBe(true); expect(f.dispose).not.toHaveBeenCalled();
    f.agent.status = 'idle'; f.agent.inbox.hasPending = true;
    await expect(close()).rejects.toThrow('DSH_HOST_NOT_QUIESCENT'); expect(f.lease.owns()).toBe(true);
    f.agent.inbox.hasPending = false; await close(); expect(f.lease.owns()).toBe(false);
  });

  it('refuses a missing attach target without invoking create or resume', async () => {
    const f = fixture(); f.removeAgent(); const close = f.boundary.plugin.apply(f.ctx);
    await expect(f.boundary.ready()).rejects.toThrow('DSH_SESSION_MISSING');
    expect(f.sdk.create).not.toHaveBeenCalled(); expect(f.sdk.resume).not.toHaveBeenCalled();
    await expect(close()).rejects.toThrow('DSH_HOST_NOT_QUIESCENT'); expect(f.lease.owns()).toBe(true);
  });

  it('rechecks ownership after asynchronous instructions before touching the original session', async () => {
    const gate = deferred(); const f = fixture({ prepareInstructions: () => gate.promise });
    const close = f.boundary.plugin.apply(f.ctx); f.lease.release(); gate.resolve();
    await expect(f.boundary.ready()).rejects.toThrow('DSH_HOST_LEASE_LOST'); expect(f.sdk.get).not.toHaveBeenCalled();
    await expect(close()).rejects.toThrow('DSH_HOST_NOT_QUIESCENT');
  });

  it('fences an in-flight pass immediately when cleanup begins, before its deferred SDK send', async () => {
    const entered = deferred(); const gate = deferred(); let outcome: unknown;
    const f = fixture({ createRunner: ({ ports, lease }) => ({ pass: async () => {
      entered.resolve(); await gate.promise; outcome = await ports.session.submit(batch, 'synthetic'); return empty;
    }, stop: async () => { lease.release(); } }) });
    const close = f.boundary.plugin.apply(f.ctx); await entered.promise;
    const closing = close(); expect(f.lease.owns()).toBe(true); gate.resolve(); await closing;
    expect(outcome).toEqual({ status: 'rejected' }); expect(f.agent.send).not.toHaveBeenCalled();
  });

  it('preserves explicit resume policy and handle ownership without using create', async () => {
    const setup = () => {};
    const f = fixture({ mode: 'resume', resumeOptions: { setup, agentOptions: { model: 'synthetic' } } });
    f.removeAgent(); const close = f.boundary.plugin.apply(f.ctx); await f.boundary.ready();
    expect(f.sdk.resume).toHaveBeenCalledWith({ resumeSessionId: 'original', setup, agentOptions: { model: 'synthetic' } });
    expect(f.sdk.create).not.toHaveBeenCalled(); expect(f.boundary.ownedHandles()).toHaveLength(1);
    await close(); expect(f.dispose).not.toHaveBeenCalled();
  });

  it('rejects a dynamic JavaScript lease returning a Promise instead of synchronous true', async () => {
    const f = fixture({ lease: { acquire: (() => Promise.resolve(true)) as unknown as () => boolean,
      owns: () => true, release: vi.fn() } });
    const close = f.boundary.plugin.apply(f.ctx);
    await expect(f.boundary.ready()).rejects.toThrow('DSH_HOST_LEASE_REQUIRED');
    expect(f.sdk.get).not.toHaveBeenCalled(); await close();
  });

  it('rechecks the notification service after the durable intent and refuses a revoked scope before SDK send', async () => {
    let checks = 0;
    const f = fixture({ createRunner: ({ ports, lease }) => ({ pass: () => driveOnce(ports), stop: async () => { lease.release(); } }),
      pending: { list: async () => [batch], confirm: async () => {}, release: async () => {},
        isCurrent: async () => ++checks === 1 } });
    const close = f.boundary.plugin.apply(f.ctx); await f.boundary.ready();
    expect(checks).toBe(2); expect(f.agent.send).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled();
    await close();
  });
});

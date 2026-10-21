import { describe, expect, it, vi } from 'vitest';
import { DshLifecycle, type DshAgent, type DshLifecycleIntent } from '../../src/harness/dsh/lifecycle.js';
import { createDshSdkFacade } from '../../src/harness/dsh/sdk-facade.js';

function fixture() {
  const agents = new Map<string, DshAgent>();
  const dispose = vi.fn(async () => {});
  const agent = (id: string): DshAgent => ({ id, session: { id, header: { cwd: '/synthetic/workspace' } }, status: 'idle' });
  const sdk = {
    get(id: string) { return agents.get(id); },
    create: vi.fn(async (options: { sessionId: string; meta: { cwd: string }; agentOptions?: object; setup?: () => void }) => {
      const a = agent(options.sessionId); agents.set(a.id, a); return { agent: a, dispose };
    }),
    resume: vi.fn(async (options: { resumeSessionId: string; agentOptions?: object }) => {
      const a = agent(options.resumeSessionId); agents.set(a.id, a); return { agent: a, dispose };
    }),
  };
  const setup = vi.fn(); const agentOptions = Object.freeze({ model: 'synthetic-model' });
  const facade = createDshSdkFacade({ sdk, sdkSessionId: (id: string) => id, createOptions: { agentOptions, setup }, resumeOptions: { agentOptions } });
  let intent: DshLifecycleIntent | null = null;
  const journal = { read: () => intent, write: (next: DshLifecycleIntent | null) => { intent = next; } };
  const lifecycle = new DshLifecycle({ sessionId: 'synthetic-session', cwd: '/synthetic/workspace', registry: facade.registry, journal });
  return { agents, agent, sdk, facade, lifecycle, journal, setup, agentOptions, dispose };
}

describe('DSH official SDK facade', () => {
  it('does nothing on composition, and attaches a borrowed agent without claiming its disposer', async () => {
    const f = fixture();
    expect(f.sdk.create).not.toHaveBeenCalled(); expect(f.sdk.resume).not.toHaveBeenCalled();
    const a = f.agent('synthetic-session'); f.agents.set(a.id, a);
    expect(await f.lifecycle.connect('attach')).toBe(a);
    expect(f.facade.ownedHandles()).toEqual([]);
    f.lifecycle.detach(); expect(f.dispose).not.toHaveBeenCalled();
  });

  it('forwards explicit creation configuration and retains the exact handle outside lifecycle', async () => {
    const f = fixture(); const a = await f.lifecycle.connect('start');
    expect(f.sdk.create).toHaveBeenCalledWith({ sessionId: a.id, meta: { cwd: '/synthetic/workspace' }, agentOptions: f.agentOptions, setup: f.setup });
    expect(f.sdk.create.mock.calls[0][0].agentOptions).toBe(f.agentOptions);
    expect(f.facade.ownedHandles()[0]).toBe(await f.sdk.create.mock.results[0].value);
    f.lifecycle.pause(); f.lifecycle.detach(); expect(f.dispose).not.toHaveBeenCalled();
    expect(f.facade.ownedHandles()).toHaveLength(1);
    const snapshot = f.facade.ownedHandles(); expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('resumes only the supplied persisted identity without replaying an already live handle', async () => {
    const f = fixture(); const a = await f.lifecycle.connect('resume');
    expect(f.sdk.resume).toHaveBeenCalledWith({ resumeSessionId: a.id, agentOptions: f.agentOptions });
    expect(await f.lifecycle.connect('resume')).toBe(a);
    expect(f.sdk.resume).toHaveBeenCalledTimes(1); expect(f.facade.ownedHandles()).toHaveLength(1);
  });

  it('retains a returned handle even when lifecycle rejects its identity, without disposing or retrying', async () => {
    const f = fixture(); const handle = { agent: f.agent('wrong-session'), dispose: f.dispose };
    f.sdk.resume.mockResolvedValueOnce(handle);
    await expect(f.lifecycle.connect('resume')).rejects.toThrow('DSH_SESSION_CONFLICT');
    expect(f.facade.ownedHandles()).toEqual([handle]); expect(f.journal.read()).not.toBeNull();
    await expect(f.lifecycle.connect('resume')).rejects.toThrow('DSH_RECONCILIATION_REQUIRED');
    expect(f.sdk.resume).toHaveBeenCalledTimes(1); expect(f.dispose).not.toHaveBeenCalled();
  });

  it('keeps uncertain SDK rejection in the durable lifecycle journal', async () => {
    const f = fixture(); f.sdk.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(f.lifecycle.connect('start')).rejects.toThrow('connection lost');
    expect(f.facade.ownedHandles()).toEqual([]); expect(f.lifecycle.status()).toBe('unknown');
    await expect(f.lifecycle.connect('start')).rejects.toThrow('DSH_RECONCILIATION_REQUIRED');
    expect(f.sdk.create).toHaveBeenCalledTimes(1);
  });

  it('rejects identity overrides in configuration before calling the SDK', () => {
    const f = fixture();
    for (const extra of [{ sessionId: 'foreign' }, { resumeSessionId: 'foreign' }, { meta: { cwd: '/foreign' } }]) {
      expect(() => createDshSdkFacade({ sdk: f.sdk, sdkSessionId: (id: string) => id, createOptions: extra, resumeOptions: {} })).toThrow('DSH_CONFIG_IDENTITY_OVERRIDE');
      expect(() => createDshSdkFacade({ sdk: f.sdk, sdkSessionId: (id: string) => id, createOptions: {}, resumeOptions: extra })).toThrow('DSH_CONFIG_IDENTITY_OVERRIDE');
    }
    expect(f.sdk.create).not.toHaveBeenCalled(); expect(f.sdk.resume).not.toHaveBeenCalled();
  });

  it('rejects a SessionId constructor that substitutes another identity', async () => {
    const f = fixture();
    const facade = createDshSdkFacade({ sdk: f.sdk, sdkSessionId: () => 'foreign', createOptions: {}, resumeOptions: {} });
    expect(() => facade.registry.get('synthetic-session')).toThrow('DSH_SDK_ID_CONFLICT');
    await expect(facade.registry.resume({ resumeSessionId: 'synthetic-session' })).rejects.toThrow('DSH_SDK_ID_CONFLICT');
    expect(f.sdk.resume).not.toHaveBeenCalled();
  });
});

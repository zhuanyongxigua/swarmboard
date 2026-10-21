// Keep authority and send fences testable without an SDK, model, or live board.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryBatch } from '../../src/harness/dsh/notification-driver.js';
import type { DshSdkSessionAgent } from '../../src/harness/dsh/sdk-session.js';
import type { DshLauncherChannels } from '../../src/harness/dsh/launcher-channels.js';
import type { Entry } from '../../src/store.js';
import { createDshLauncherMemberPorts, openDshLauncherMemberPorts } from '../../src/harness/dsh/launcher-member-ports.js';

function fixture(mode = 'stable') {
  const identity = { memberId: 'member', sessionRef: 'session-original', adapterId: 'channel', cwd: '/synthetic/work/seat' };
  const goal = { taskId: 'goal', poolId: 'pool', projectPath: '/synthetic/source', executionWorkspace: '/synthetic/work' };
  const runtime = { pool: { id: 'pool', version: 1, enabled: true, taskIds: ['goal'] },
    collaborators: [{ id: 'member', harness: 'dsh', sessionRef: identity.sessionRef, version: 5, enabled: true, revokedAt: null,
      taskIds: ['goal'], scope: 'selected', poolId: 'pool' }],
    executionGrants: [{ ...goal, version: 3, enabled: true, monitoring: true, externalHarnesses: ['dsh'] }] };
  const binding = { adapterId: 'channel', memberId: 'member', sessionRef: identity.sessionRef,
    registrationVersion: 2, admissionVersion: 5, enabled: true, boardWide: false, taskIds: ['goal'],
    capabilities: ['durableDelivery', 'receipt', 'sameSessionContinuation', 'timedReminder'] };
  let wake = () => {}, error = (_error: unknown) => {}, runtimeReads = 0;
  const management = { call: vi.fn(async (name: string) => {
    if (name === 'runtime_read') {
      runtimeReads++;
      if (mode === 'always' || mode === 'once' && runtimeReads === 1) wake();
      return structuredClone(runtime);
    }
    if (name === 'task_read') return { id: 'goal', status: 'in_review' };
    throw Error('Unexpected management tool');
  }), callTool: vi.fn(async () => ({})), close: vi.fn(async () => {}) };
  const member = { call: vi.fn(async () => ({})), callTool: vi.fn(async ({ name }: { name: string }) => {
    if (name === 'notification_binding_read') return { structuredContent: { binding: structuredClone(binding) } };
    if (name === 'preferences_read') return { structuredContent: { version: 24, text: '', source: 'fixture' } };
    throw Error('Unexpected member tool');
  }), close: vi.fn(async () => {}) };
  const unsubscribe = vi.fn(), close = vi.fn(async () => {});
  const options = { identity, goalBindings: [goal], management, member,
    subscribe(onWake: () => void, onError: (cause: unknown) => void) { wake = onWake; error = onError; return unsubscribe; }, close };
  const ports = createDshLauncherMemberPorts(options);
  const agent: DshSdkSessionAgent<string> = { id: identity.sessionRef, status: 'idle', inbox: { hasPending: false },
    session: { id: identity.sessionRef, header: { cwd: identity.cwd }, events: [] }, send() {} };
  const batch = (notificationBinding: unknown) => ({ adapterId: identity.adapterId, memberId: identity.memberId,
    sessionRef: identity.sessionRef, delivery: { sequence: 1, entryIds: [1] }, notificationBinding,
    entries: [{ id: 1, kind: 'MESSAGE', agentId: 'peer', taskId: 'goal', summary: 'Synthetic work', detail: '', createdAt: '' }] as Entry[] }) as DeliveryBatch;
  return { identity, goal, runtime, binding, management, member, options, ports, agent, batch,
    wake: () => wake(), error: () => error(Error('Synthetic watcher failure')),
    runtimeReads: () => runtimeReads, unsubscribe, close };
}

describe('DSH launcher member authority', () => {
  it('uses management authority without external shared-update reads and invalidates before wake', async () => {
    const f = fixture(), current = await f.ports.getCurrentBinding();
    expect(current).toMatchObject({ registrationVersion: 2, admissionVersion: 5, taskIds: ['goal'] });
    expect(f.runtimeReads()).toBe(2);
    expect(f.member.callTool.mock.calls.map(([request]) => request.name)).toEqual(['notification_binding_read', 'notification_binding_read']);
    expect(f.ports.isAuthorized(f.batch(current), f.agent)).toBe(true);
    const listener = vi.fn(() => expect(f.ports.isAuthorized(f.batch(current), f.agent)).toBe(false));
    f.ports.subscribeWake(listener); f.wake(); expect(listener).toHaveBeenCalledOnce();
    expect(f.ports.isAuthorized(f.batch(await f.ports.getCurrentBinding()), f.agent)).toBe(true);
    expect(f.ports.isAuthorized(f.batch(current), { ...f.agent, session: { ...f.agent.session, header: { cwd: '/other' } } })).toBe(false);
    await expect(f.ports.callTool({ name: 'notification_register', arguments: {} })).rejects.toThrow('TOOL_OUTSIDE_MEMBER_PORTS');
    await f.ports.close(); await f.ports.close(); expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
  });

  it('bounds complete read attempts after wake and refuses continued invalidation', async () => {
    for (const mode of ['once', 'always']) {
      const f = fixture(mode), current = await f.ports.getCurrentBinding();
      expect(f.runtimeReads()).toBe(4); expect(f.member.callTool).toHaveBeenCalledTimes(4);
      expect(!!current).toBe(mode === 'once');
      if (!current) expect(f.ports.isAuthorized(f.batch(f.binding), f.agent)).toBe(false);
      await f.ports.close();
    }
  });

  it('rechecks grants, admission, capabilities, scope and watcher health without stale authority', async () => {
    const changes = [
      (f: ReturnType<typeof fixture>) => { f.runtime.executionGrants[0].enabled = false; },
      (f: ReturnType<typeof fixture>) => { f.runtime.executionGrants[0].monitoring = false; },
      (f: ReturnType<typeof fixture>) => { f.runtime.pool.enabled = false; },
      (f: ReturnType<typeof fixture>) => { f.runtime.pool.version = 0; },
      (f: ReturnType<typeof fixture>) => { f.runtime.collaborators[0].harness = 'zcode'; },
      (f: ReturnType<typeof fixture>) => { f.runtime.collaborators[0].version++; },
      (f: ReturnType<typeof fixture>) => { f.runtime.collaborators[0].sessionRef = 'replacement'; },
      (f: ReturnType<typeof fixture>) => { f.runtime.collaborators[0].taskIds = []; },
      (f: ReturnType<typeof fixture>) => { f.binding.capabilities = ['receipt']; },
      (f: ReturnType<typeof fixture>) => { f.binding.registrationVersion = 0; },
      (f: ReturnType<typeof fixture>) => { f.error(); },
    ];
    for (const change of changes) {
      const f = fixture(), current = await f.ports.getCurrentBinding(); change(f);
      expect(await f.ports.getCurrentBinding()).toBeUndefined();
      expect(f.ports.isAuthorized(f.batch(current), f.agent)).toBe(false);
      await f.ports.close();
    }
  });

  it('does not pair pre-change task/grant reads with a later runtime snapshot', async () => {
    const f = fixture();
    f.management.call.mockImplementation(async (name: string) => {
      if (name === 'task_read') { f.runtime.executionGrants[0].version++; return { id: 'goal', status: 'in_review' }; }
      return structuredClone(f.runtime);
    });
    expect(await f.ports.getCurrentBinding()).toBeUndefined();
    expect(f.member.callTool).toHaveBeenCalledTimes(2);
    await f.ports.close();
  });

  it('opens the concrete file watchers and closes only the two connections it opened', async () => {
    const f = fixture(), directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-member-ports-')));
    const databasePath = join(directory, 'board.sqlite');
    writeFileSync(databasePath, 'synthetic board event source'); writeFileSync(databasePath + '.runtime.sqlite', 'synthetic runtime event source');
    const channels = { boardDatabasePath: databasePath, openManagement: vi.fn(async () => f.management),
      openMember: vi.fn(async () => f.member) } as unknown as DshLauncherChannels;
    const ports = await openDshLauncherMemberPorts({ channels, identity: f.identity, goalBindings: [f.goal], boardDatabasePath: databasePath });
    try {
      const current = await ports.getCurrentBinding(); expect(ports.isAuthorized(f.batch(current), f.agent)).toBe(true);
      await new Promise<void>((done, reject) => {
        // Bound the test, not production delivery; OS events are asynchronous.
        const timeout = setTimeout(() => reject(Error('Expected real file event')), 4000);
        ports.subscribeWake(() => { clearTimeout(timeout); done(); });
        writeFileSync(databasePath, 'changed synthetic source');
      });
      expect(ports.isAuthorized(f.batch(current), f.agent)).toBe(false);
    } finally { await ports.close(); await f.ports.close(); rmSync(directory, { recursive: true, force: true }); }
    expect(f.member.close).toHaveBeenCalledOnce(); expect(f.management.close).toHaveBeenCalledOnce();
  });
});

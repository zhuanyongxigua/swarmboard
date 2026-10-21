import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ channels: vi.fn(), memberPorts: vi.fn() }));
vi.mock('../../src/harness/dsh/launcher-channels.js', () => ({ createDshLauncherChannels: mocks.channels }));
vi.mock('../../src/harness/dsh/launcher-member-ports.js', () => ({ openDshLauncherMemberPorts: mocks.memberPorts }));
import plugin, { openDshLaunchChildPorts, type DshChildConfig, type DshChildContext } from '../../src/harness/dsh/launch-child.js';
beforeEach(() => { mocks.channels.mockReset(); mocks.memberPorts.mockReset(); });
const config = { nodeCommand: '/synthetic/node', server: { path: '/synthetic/server.mjs', sha256: 'a'.repeat(64) },
  boardDatabasePath: '/synthetic/board.sqlite', runtimeDirectory: '/synthetic/runtime',
  identity: { memberId: 'member', sessionRef: 'session', adapterId: 'adapter', cwd: '/synthetic/work' },
  goalBindings: [{ taskId: 'task', poolId: 'pool', projectPath: '/synthetic/project', executionWorkspace: '/synthetic/work' }] } as DshChildConfig;
it('default composition supplies the fixed caller tuple and closes both exclusively owned layers', async () => {
  const channels = { close: vi.fn(async () => {}) }, member = { close: vi.fn(async () => {}) };
  mocks.channels.mockReturnValue(channels); mocks.memberPorts.mockResolvedValue(member);
  const ports = await openDshLaunchChildPorts({} as DshChildContext, config);
  expect(mocks.channels).toHaveBeenCalledWith({ nodeCommand: config.nodeCommand, server: config.server,
    boardDatabasePath: config.boardDatabasePath, runtimeDirectory: config.runtimeDirectory });
  expect(mocks.memberPorts).toHaveBeenCalledWith({ channels, identity: config.identity,
    boardDatabasePath: config.boardDatabasePath, goalBindings: config.goalBindings });
  await ports.close(); expect(member.close).toHaveBeenCalledOnce(); expect(channels.close).toHaveBeenCalledOnce();
});
it('default composition cleans up its channel factory when member connection fails', async () => {
  const channels = { close: vi.fn(async () => {}) }; mocks.channels.mockReturnValue(channels);
  mocks.memberPorts.mockRejectedValue(new Error('synthetic member failure'));
  await expect(openDshLaunchChildPorts({} as DshChildContext, config)).rejects.toThrow('synthetic member failure');
  expect(channels.close).toHaveBeenCalledOnce();
});
it('official Loader apply remains synchronous and publishes the original control without opening transports on import', async () => {
  const provide = vi.fn(); const ctx = { provide, get: () => undefined } as unknown as DshChildContext;
  const cleanup = plugin.apply(ctx, { configPath: '/synthetic/missing.json', configSha256: 'a'.repeat(64) });
  expect(typeof cleanup).toBe('function'); expect(provide).toHaveBeenCalledWith('swarmboardDshLaunchChild', expect.any(Object));
  const control = provide.mock.calls[0][1]; await expect(control.ready()).rejects.toThrow();
  expect(mocks.channels).not.toHaveBeenCalled(); expect(mocks.memberPorts).not.toHaveBeenCalled(); await cleanup();
});

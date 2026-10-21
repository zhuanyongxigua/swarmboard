// Exercise the actual official MCP stdio clients against an isolated bundled
// service; management must expose host tools without an event-runtime owner.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { WorkerStore } from '../../src/worker-store.js';
import { WorkerPool } from '../../src/worker-pool.js';
import { ExecutionGrants } from '../../src/execution-grants.js';
import { openDshLauncherMemberPorts, type DshLauncherGoalBinding } from '../../src/harness/dsh/launcher-member-ports.js';
import { createDshLauncherChannels, readDshLauncherToolResult,
  type DshLauncherChannels, type DshLauncherChannelsOptions } from '../../src/harness/dsh/launcher-channels.js';

let root: string, options: DshLauncherChannelsOptions, taskId: string, goalBinding: DshLauncherGoalBinding;
const channels: DshLauncherChannels[] = [];
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-launch-channels-')));
  const serverDirectory = join(root, 'server'); mkdirSync(serverDirectory);
  const file = join(serverDirectory, 'swarmboard.mjs');
  await build({ entryPoints: [resolve('src/stdio.ts')], outfile: file, bundle: true, platform: 'node',
    target: 'node24', format: 'esm', logLevel: 'silent',
    banner: { js: 'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);' } });
  writeFileSync(join(root, 'widget.html'), '<!doctype html><title>Synthetic isolated widget</title>');
  const runtimeDirectory = join(root, 'runtime'); mkdirSync(runtimeDirectory);
  options = { nodeCommand: process.execPath, server: { path: file,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex') },
  runtimeDirectory, boardDatabasePath: join(root, 'board.sqlite') };
  const store = new Store(options.boardDatabasePath);
  try {
    taskId = store.createTask({ title: 'Synthetic authorized goal' }).id;
    const workers = new WorkerStore(options.boardDatabasePath + '.runtime.sqlite');
    try {
      const pool = new WorkerPool(workers, store, options.boardDatabasePath).configure({
        expectedVersion: 0, workspacePath: root, size: 1, maxSize: 1, taskIds: [taskId] });
      const grant = new ExecutionGrants(store, workers).configure({ taskId, expectedVersion: 0,
        projectPath: root, executionWorkspace: root, externalHarnesses: ['dsh'], monitoring: true, enabled: true });
      goalBinding = { taskId, poolId: pool.id, projectPath: grant.projectPath, executionWorkspace: grant.executionWorkspace };
    } finally { workers.close(); }
  }
  finally { store.close(); }
}, 20000);
afterAll(async () => {
  await Promise.all(channels.map(channel => channel.close()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('DSH launcher official channels', () => {
  it('uses a management-only control surface, then opens only the freshly admitted member', async () => {
    const host = createDshLauncherChannels(options); channels.push(host);
    const management = await host.openManagement();
    const initial = await management.call('runtime_read');
    expect(initial.owner).toBeNull();
    const admitted = await management.call('collaborator_configure', { expectedVersion: 0, name: 'Synthetic DSH member',
      harness: 'dsh', sessionRef: 'session-00000000-0000-4000-8000-000000000001', taskIds: [taskId], enabled: true });
    expect(admitted.id).toEqual(expect.any(String)); expect(admitted.version).toBe(1);
    const member = await host.openMember(String(admitted.id));
    const prefs = await member.call('preferences_read'); expect(prefs.version).toEqual(expect.any(Number));
    expect(member.mcpConfig.env).toMatchObject({ SWARMBOARD_COLLABORATOR_ID: admitted.id,
      SWARMBOARD_WORKER_ID: '', SWARMBOARD_POOL_MEMBER: '0', SWARMBOARD_DISABLE_RUNTIME: '1',
      SWARMBOARD_MANAGEMENT_ONLY: '0', SWARMBOARD_HARNESS: '', SWARMBOARD_WIDGET_PATH: '' });
    expect(member.mcpConfig.failOnStartupError).toBe(true); expect(member.mcpConfig.reconnect.enabled).toBe(false);
    const adapterId = 'synthetic-launch-channel';
    await member.call('notification_register', { id: adapterId, version: 1, displayName: 'Synthetic channel', harness: 'dsh',
      enabled: true, capabilities: ['durableDelivery', 'receipt', 'sameSessionContinuation', 'timedReminder'],
      members: [{ memberId: admitted.id, sessionRef: admitted.sessionRef, taskIds: [taskId], boardWide: false }] });
    const snapshot = await member.call('notification_binding_read', { adapterId });
    expect(snapshot.binding).toMatchObject({ memberId: admitted.id, sessionRef: admitted.sessionRef,
      registrationVersion: 1, admissionVersion: 1, enabled: true, taskIds: [taskId] });
    expect(() => member.callTool({ name: 'collaborator_configure', arguments: {} })).toThrow('TOOL_OUTSIDE_CHANNEL');
    expect(() => management.callTool({ name: 'notification_register', arguments: {} })).toThrow('TOOL_OUTSIDE_CHANNEL');
    expect((await management.call('runtime_read')).owner).toBeNull();
    const workers = new WorkerStore(options.boardDatabasePath + '.runtime.sqlite');
    try { expect(workers.owner()).toBeNull(); expect(workers.list()).toHaveLength(0); }
    finally { workers.close(); }
    await host.close(); await host.close();
    expect(() => member.callTool({ name: 'preferences_read', arguments: {} })).toThrow('CHANNELS_CLOSED');
  });

  it('keeps construction cold, snapshots public options and denies changed executable bytes before connecting', async () => {
    const source = structuredClone(options), host = createDshLauncherChannels(source); channels.push(host);
    source.server.path = '/synthetic/changed';
    const config = host.memberMcpConfig('synthetic-member');
    expect(config.args).toEqual([options.server.path]);
    config.env.SWARMBOARD_COLLABORATOR_ID = 'other';
    expect(host.memberMcpConfig('synthetic-member').env.SWARMBOARD_COLLABORATOR_ID).toBe('synthetic-member');
    expect(Object.keys(config.env).some(key => /KEY|TOKEN|PASSWORD|SECRET/i.test(key))).toBe(false);
    const bad = createDshLauncherChannels({ ...options, server: { ...options.server, sha256: '0'.repeat(64) } });
    channels.push(bad);
    await expect(bad.openManagement()).rejects.toThrow('SERVER_PIN_CHANGED');
    expect(() => createDshLauncherChannels({ ...options, nodeCommand: 'node' })).toThrow('INVALID_CHANNEL_CONFIG');
    expect(() => host.memberMcpConfig('')).toThrow('INVALID_MEMBER');
  });

  it('does not replace or release an existing live event owner', async () => {
    const workers = new WorkerStore(options.boardDatabasePath + '.runtime.sqlite');
    const token = 'synthetic-existing-owner';
    const host = createDshLauncherChannels(options); channels.push(host);
    try {
      expect(workers.acquire(token, process.pid)).toBe(true);
      const management = await host.openManagement();
      expect((await management.call('runtime_read')).owner).toEqual({ pid: process.pid });
      expect(workers.owns(token)).toBe(true);
      await host.close();
      expect(workers.owns(token)).toBe(true);
    } finally { workers.release(token); workers.close(); }
  });

  it('opens the complete member authority through actual stdio and fences a real grant revocation', async () => {
    const host = createDshLauncherChannels(options); channels.push(host);
    const management = await host.openManagement();
    const sessionRef = 'session-00000000-0000-4000-8000-000000000002';
    const admitted = await management.call('collaborator_configure', { expectedVersion: 0, name: 'Synthetic composed member',
      harness: 'dsh', sessionRef, taskIds: [taskId], poolId: goalBinding.poolId, enabled: true });
    const memberId = String(admitted.id), setup = await host.openMember(memberId), adapterId = 'synthetic-composed-channel';
    await setup.call('notification_register', { id: adapterId, version: 1, displayName: 'Synthetic complete port', harness: 'dsh', enabled: true,
      capabilities: ['durableDelivery', 'receipt', 'sameSessionContinuation', 'timedReminder'],
      members: [{ memberId, sessionRef, taskIds: [taskId], boardWide: false }] });
    expect((await setup.call('notification_binding_read', { adapterId })).binding).toMatchObject({ enabled: true, admissionVersion: 1 });
    expect(await management.call('task_read', { id: taskId, limit: 1 })).toMatchObject({ id: taskId, status: 'todo' });
    expect((await management.call('runtime_read')).pool).toMatchObject({ id: goalBinding.poolId, enabled: true });
    const ports = await openDshLauncherMemberPorts({ channels: host, identity: { memberId, sessionRef, adapterId, cwd: root },
      boardDatabasePath: options.boardDatabasePath, goalBindings: [goalBinding] });
    try {
      expect(await ports.getCurrentBinding()).toMatchObject({ memberId, sessionRef, admissionVersion: 1, registrationVersion: 1 });
      const store = new Store(options.boardDatabasePath), workers = new WorkerStore(options.boardDatabasePath + '.runtime.sqlite');
      try { new ExecutionGrants(store, workers).configure({ taskId, expectedVersion: 1, projectPath: root,
        executionWorkspace: root, externalHarnesses: ['dsh'], monitoring: true, enabled: false }); }
      finally { workers.close(); store.close(); }
      expect(await ports.getCurrentBinding()).toBeUndefined();
    } finally { await ports.close(); await host.close(); }
  });

  it('never parses shared attachments or arbitrary error text as the tool result', () => {
    expect(readDshLauncherToolResult({ content: [{ type: 'text', text: '{"version":2}' },
      { type: 'text', text: '{"version":999}' }] })).toEqual({ version: 2 });
    expect(() => readDshLauncherToolResult({ content: [{ type: 'text', text: 'synthetic private error' }], isError: true }))
      .toThrow('INVALID_TOOL_RESULT');
    expect(readDshLauncherToolResult({ structuredContent: { owner: null, error: '' } })).toEqual({ owner: null, error: '' });
    expect(() => readDshLauncherToolResult({ structuredContent: { error: { code: 'DENIED', message: 'synthetic secret' } } })).toThrow('TOOL_REJECTED');
  });
});

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDshLaunchChild, readDshChildConfig, readDshChildStatus, type DshChildConfig, type DshChildContext, type DshChildPorts } from '../../src/harness/dsh/launch-child.js';
import type { DshSdkSessionAgent } from '../../src/harness/dsh/sdk-session.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true }); });
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'dsh-child-contract-')); roots.push(root);
  const cwd = join(root, 'work'), runtimeDirectory = join(root, 'runtime'), stageDirectory = join(root, 'stage'), sdkRoot = join(root, 'sdk');
  const persistenceRoot = join(runtimeDirectory, 'sessions');
  for (const path of [cwd, runtimeDirectory, stageDirectory, sdkRoot, persistenceRoot]) fs.mkdirSync(path);
  const serverPath = join(root, 'server.mjs'), nodeCommand = join(root, 'synthetic-node'), boardDatabasePath = join(root, 'board.sqlite');
  for (const path of [serverPath, nodeCommand, boardDatabasePath]) fs.writeFileSync(path, 'synthetic');
  const nativePath = join(persistenceRoot, 'native.jsonl'); fs.writeFileSync(nativePath, 'original-session-bytes');
  const receiptPath = join(root, 'session-receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify({ schema: 'swarmboard-dsh-session/v1', sessionRef: 'original', cwd,
    nativeRoot: persistenceRoot, nativePath, nativeSha256: hash(fs.readFileSync(nativePath)), activated: false }));
  const config: DshChildConfig = { schema: 'swarmboard-dsh-child/v1', identity: { memberId: 'member', sessionRef: 'original', adapterId: 'adapter', cwd },
    runtimeDirectory, stageDirectory, persistenceRoot, sessionReceipt: { path: receiptPath, sha256: hash(fs.readFileSync(receiptPath)) },
    boardDatabasePath, nodeCommand, server: { path: serverPath, sha256: hash(fs.readFileSync(serverPath)) },
    sdk: { root: sdkRoot, pins: { cordis: 'a'.repeat(64), 'dsh-session': 'a'.repeat(64), 'dsh-session-persistence-jsonl': 'a'.repeat(64), 'dsh-agent': 'a'.repeat(64), 'dsh-llm': 'a'.repeat(64) } },
    goalBindings: [{ taskId: 'task', poolId: 'pool', projectPath: '/synthetic/project', executionWorkspace: '/synthetic/work' }],
    model: { provider: 'synthetic', model: 'model', reasoningEffort: 'off' }, permissionPreset: 'explicit' };
  for (const name of ['cordis', 'dsh-session', 'dsh-session-persistence-jsonl'] as const) {
    const directory = join(sdkRoot, 'node_modules/@deepseek-ai', name, 'lib'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(join(directory, 'index.js'), 'synthetic-sdk'); config.sdk.pins[name] = hash('synthetic-sdk');
  }
  const configPath = join(stageDirectory, 'child.json'); fs.writeFileSync(configPath, JSON.stringify(config));
  const options = { configPath, configSha256: hash(fs.readFileSync(configPath)) };
  const agent: DshSdkSessionAgent<string> = { id: 'original', status: 'idle', session: { id: 'original', header: { cwd }, events: [] }, inbox: { hasPending: false }, send: vi.fn() };
  let live: typeof agent | undefined;
  const permission = { set: vi.fn(), current: () => 'explicit' };
  const ctx = { get: vi.fn(() => ({ await: async () => {} })), provide: vi.fn(), permissionPresets: permission,
    agents: { get: () => live, create: vi.fn(async () => { throw Error('forbidden'); }),
      resume: vi.fn(async (options: { resumeSessionId: string; [key: string]: unknown }) => {
        (options.setup as (ctx: unknown) => void)({}); live = agent; return { agent, dispose: async () => {} };
      }) }, sessions: { flush: vi.fn(async () => true) }, on: vi.fn(() => () => {}) } as DshChildContext;
  const ports: DshChildPorts = { callTool: vi.fn(async request => ({ structuredContent: request.name === 'notification_pending'
    ? { items: [], cursor: 0, hasMore: false } : { version: 1, text: '' } })),
    getCurrentBinding: async () => ({ adapterId: 'adapter', memberId: 'member', sessionRef: 'original', enabled: true, taskIds: ['task'], registrationVersion: 1 }),
    isAuthorized: () => true, subscribeWake: () => () => {}, close: vi.fn(async () => {}) };
  const openPorts = vi.fn(async () => ports);
  const loadSdk = vi.fn(async () => ({ SessionId: (s: string) => s, MessageId: (s: string) => s, installModelSelection: vi.fn(() => () => {}) }));
  const child = createDshLaunchChild({ openPorts, loadSdk });
  return { root, config, options, child, ctx, openPorts, loadSdk, ports, nativePath, configPath };
}
it('validates a fixed strict descriptor and original creation provenance before effects', () => {
  const f = fixture(); expect(readDshChildConfig(f.options)).toEqual(f.config);
  expect(f.openPorts).not.toHaveBeenCalled(); expect(f.loadSdk).not.toHaveBeenCalled();
  fs.appendFileSync(f.nativePath, 'changed');
  expect(() => readDshChildConfig(f.options)).toThrow('PIN_MISMATCH');
  expect(fs.readdirSync(f.config.stageDirectory)).toEqual(['child.json']);
});
it('detaches startup from Loader.apply, records durable lifecycle and an exact non-consumption ready receipt', async () => {
  const f = fixture(); const cleanup = f.child.plugin.apply(f.ctx, f.options);
  expect(typeof cleanup).toBe('function'); expect(f.openPorts).not.toHaveBeenCalled(); await f.child.ready();
  const ready = JSON.parse(fs.readFileSync(join(f.config.stageDirectory, 'child-ready.json'), 'utf8'));
  expect(ready).toMatchObject({ configSha256: f.options.configSha256, leaseOwned: true,
    originalSessionMatches: true, permissionDurable: true, notificationConsumed: false, usefulContribution: false,
    preferencesVersion: 1, userPromptVersion: 1, instructionRole: 'user' });
  expect(f.ctx.agents.resume).toHaveBeenCalledTimes(1);
  const states = fs.readFileSync(join(f.config.stageDirectory, 'child-state.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
  expect(states.at(-1).phase).toBe('ready'); expect(states.every(state => !JSON.stringify(state).includes('original'))).toBe(true);
  await cleanup(); expect(f.ports.close).toHaveBeenCalledTimes(1);
  expect(() => readDshChildConfig(f.options)).toThrow('RECONCILE');
});
it('cleanup fences a pending Loader before any SDK/transport/sidecar effect', async () => {
  const f = fixture(); let release!: () => void;
  f.ctx.get = () => ({ await: () => new Promise<void>(resolve => { release = resolve; }) });
  const close = f.child.plugin.apply(f.ctx, f.options); await Promise.resolve();
  const closing = close(); release(); await closing;
  expect(f.loadSdk).not.toHaveBeenCalled(); expect(f.openPorts).not.toHaveBeenCalled();
  expect(fs.readdirSync(f.config.stageDirectory)).toEqual(['child.json']);
});
it('rechecks original native bytes after asynchronous ports/instructions before official resume', async () => {
  const f = fixture(); f.openPorts.mockImplementationOnce(async () => { fs.appendFileSync(f.nativePath, 'changed'); return f.ports; });
  const close = f.child.plugin.apply(f.ctx, f.options); await expect(f.child.ready()).rejects.toThrow('PIN_MISMATCH');
  expect(f.ctx.agents.resume).not.toHaveBeenCalled();
  await expect(close()).rejects.toThrow('NOT_QUIESCENT');
  expect(f.ports.close).not.toHaveBeenCalled(); expect(fs.existsSync(join(f.config.stageDirectory, 'child-ready.json'))).toBe(false);
});

it('status keeps historical startup-ready separate from post-ready failure and malformed state', async () => {
  const f = fixture(); const input = { stageDirectory: f.config.stageDirectory, configSha256: f.options.configSha256, sessionRef: 'original' };
  expect(readDshChildStatus(input).phase).toBe('not-started');
  const close = f.child.plugin.apply(f.ctx, f.options); await f.child.ready();
  expect(readDshChildStatus(input)).toMatchObject({ phase: 'ready', startupReady: true, notificationConsumed: false });
  const file = join(f.config.stageDirectory, 'child-state.jsonl');
  const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)!);
  fs.appendFileSync(file, JSON.stringify({ ...last, phase: 'failed', errorCode: 'STALE_NOTIFICATION_BINDING' }) + '\n');
  expect(readDshChildStatus(input)).toMatchObject({ phase: 'failed', startupReady: true, errorCode: 'STALE_NOTIFICATION_BINDING' });
  fs.appendFileSync(file, '{incomplete'); expect(readDshChildStatus(input).phase).toBe('unknown');
  await close();
});
it('captures Loader options before asynchronous startup and rejects an unknown config field before effects', async () => {
  const f = fixture(); const originalSha = f.options.configSha256;
  const close = f.child.plugin.apply(f.ctx, f.options); f.options.configSha256 = '0'.repeat(64);
  await f.child.ready();
  expect(JSON.parse(fs.readFileSync(join(f.config.stageDirectory, 'child-ready.json'), 'utf8')).configSha256).toBe(originalSha);
  await close();
  const other = fixture(); fs.writeFileSync(other.configPath, JSON.stringify({ ...other.config, arbitraryModule: '/synthetic/module' }));
  other.options.configSha256 = hash(fs.readFileSync(other.configPath));
  other.child.plugin.apply(other.ctx, other.options); await expect(other.child.ready()).rejects.toThrow();
  expect(other.loadSdk).not.toHaveBeenCalled(); expect(other.openPorts).not.toHaveBeenCalled();
});

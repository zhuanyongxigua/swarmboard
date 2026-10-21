// Mount the packaged launcher in an existing official Cordis profile. Configuration
// and durable state stay external; module import never opens a DB, SDK or transport.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { createDshLaunchBootstrap, applyDshLaunchPermission, loadDshLaunchSdk, type DshLaunchBootstrapState, type DshLaunchPermissionContext } from './launch-bootstrap.js';
import { createDshHostLease } from './host-lease.js';
import { createDshInstructionBoundary, type Rendered } from './instructions.js';
import { inspectDshSessionRequest, type DshPreparedSession } from './launch-session.js';
import type { DshSdkPluginContext } from './sdk-plugin.js';
import type { DshSdkSessionAgent, DshSdkBatch } from './sdk-session.js';
import type { DshNotificationPortOptions } from './notification-port.js';
import { workerProtocol } from '../../worker-prompt.js';

const text = z.string().min(1), sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const moduleRef = z.strictObject({ path: text, sha256 });
export const dshChildConfigSchema = z.strictObject({
  schema: z.literal('swarmboard-dsh-child/v1'),
  identity: z.strictObject({ memberId: text, sessionRef: text, adapterId: text, cwd: text }),
  stageDirectory: text, runtimeDirectory: text, persistenceRoot: text, sessionReceipt: moduleRef,
  boardDatabasePath: text, nodeCommand: text, server: moduleRef,
  goalBindings: z.array(z.strictObject({ taskId: text, poolId: text, projectPath: text, executionWorkspace: text })).min(1),
  sdk: z.strictObject({ root: text, pins: z.strictObject({ cordis: sha256, 'dsh-session': sha256,
    'dsh-session-persistence-jsonl': sha256, 'dsh-agent': sha256, 'dsh-llm': sha256 }) }),
  model: z.strictObject({ provider: text, model: text, reasoningEffort: text }), permissionPreset: text,
});
export type DshChildConfig = z.infer<typeof dshChildConfigSchema>;
export interface DshChildPorts extends DshNotificationPortOptions {
  isAuthorized(batch: DshSdkBatch, agent: DshSdkSessionAgent<string>): boolean;
  subscribeWake(listener: () => void): () => unknown;
  close(): Promise<void>;
}
export type DshChildContext = DshSdkPluginContext<string, string, DshSdkSessionAgent<string>> & DshLaunchPermissionContext & {
  get(name: string): { await(): Promise<void> } | undefined;
  provide(name: string, value: unknown): unknown;
  sessionPersistence: { root: string; locate(meta: { id: string; cwd: string }): { path: string } };
};
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const ensure = (value: unknown, code: string): void => { if (!value) throw new Error(code); };
function directory(file: string) {
  ensure(isAbsolute(file) && fs.realpathSync(file) === file && fs.lstatSync(file).isDirectory(), 'DSH_CHILD_CANONICAL_DIRECTORY_REQUIRED');
}
function ordinary(file: string) {
  const stat = fs.lstatSync(file);
  ensure(isAbsolute(file) && stat.isFile() && stat.nlink === 1 && fs.realpathSync(file) === file, 'DSH_CHILD_CANONICAL_FILE_REQUIRED');
}
function exists(file: string) {
  try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function within(root: string, file: string) {
  const delta = relative(root, file); return delta !== '' && delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}
function pinned(ref: { path: string; sha256: string }) {
  ordinary(ref.path); const bytes = fs.readFileSync(ref.path);
  ensure(hash(bytes) === ref.sha256, 'DSH_CHILD_PIN_MISMATCH'); return bytes;
}

/** Read one fixed descriptor snapshot and its original session provenance. */
export function readDshChildConfig(options: { configPath: string; configSha256: string }) {
  const config = dshChildConfigSchema.parse(JSON.parse(pinned({ path: options.configPath, sha256: options.configSha256 }).toString('utf8')));
  for (const dir of [config.stageDirectory, config.runtimeDirectory, config.persistenceRoot, config.identity.cwd, config.sdk.root]) directory(dir);
  ensure(dirname(options.configPath) === config.stageDirectory, 'DSH_CHILD_CONFIG_STAGE_REQUIRED');
  const dirs = [config.stageDirectory, config.runtimeDirectory, config.identity.cwd];
  ensure(dirs.every((a, i) => dirs.every((b, j) => i === j || a !== b && !within(a, b) && !within(b, a))), 'DSH_CHILD_DIRECTORY_CONFLICT');
  ensure(config.persistenceRoot !== config.identity.cwd && !within(config.identity.cwd, config.persistenceRoot)
    && config.persistenceRoot !== config.stageDirectory && !within(config.stageDirectory, config.persistenceRoot), 'DSH_CHILD_PERSISTENCE_ROOT_REQUIRED');
  ordinary(config.boardDatabasePath); pinned(config.server); ordinary(config.nodeCommand);
  inspectDshSessionRequest({ mode: 'select', sessionRef: config.identity.sessionRef, cwd: config.identity.cwd,
    persistenceRoot: config.persistenceRoot, stateDirectory: config.stageDirectory, sdk: { root: config.sdk.root, pins: {
      cordis: config.sdk.pins.cordis, 'dsh-session': config.sdk.pins['dsh-session'],
      'dsh-session-persistence-jsonl': config.sdk.pins['dsh-session-persistence-jsonl'] } } });
  const receipt = JSON.parse(pinned(config.sessionReceipt).toString('utf8')) as DshPreparedSession;
  ensure(receipt.schema === 'swarmboard-dsh-session/v1' && receipt.activated === false
    && receipt.sessionRef === config.identity.sessionRef && receipt.cwd === config.identity.cwd
    && receipt.nativeRoot === config.persistenceRoot && within(config.persistenceRoot, receipt.nativePath), 'DSH_CHILD_SESSION_PROVENANCE_REQUIRED');
  pinned({ path: receipt.nativePath, sha256: receipt.nativeSha256 });
  const sidecar = join(config.runtimeDirectory, 'durable-host.sqlite');
  ensure(sidecar !== config.boardDatabasePath, 'DSH_CHILD_SIDECAR_CONFLICT');
  for (const suffix of ['', '-wal', '-shm']) ensure(!exists(sidecar + suffix), 'DSH_CHILD_EXISTING_SIDECAR_RECONCILE');
  for (const file of ['child-state.jsonl', 'child-ready.json']) ensure(!exists(join(config.stageDirectory, file)), 'DSH_CHILD_EXISTING_STAGE_RECONCILE');
  return config;
}

function snapshot(result: unknown): { version: number; text: string; source?: string | null } {
  const envelope = result as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  ensure(envelope && !envelope.isError, 'DSH_CHILD_INSTRUCTION_SNAPSHOT_REQUIRED');
  let value = envelope.structuredContent;
  if (value === undefined) value = JSON.parse(envelope.content?.find(item => item.type === 'text')?.text ?? 'null');
  return z.object({ version: z.number().int().nonnegative(), text: z.string(), source: z.string().nullable().optional() }).parse(value);
}
function syncDirectory(file: string) {
  const fd = fs.openSync(dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeReady(file: string, data: unknown) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(file);
}

export interface DshChildDependencies {
  openPorts(ctx: DshChildContext, config: DshChildConfig): Promise<DshChildPorts>;
  loadSdk?: typeof loadDshLaunchSdk;
}
/** Tests may replace only the process/SDK composition. Production supplies the
 * packaged caller-bound bridge; no arbitrary module path is accepted in JSON. */
export function createDshLaunchChild(dependencies: DshChildDependencies) {
  const openPorts = dependencies.openPorts, loadSdk = dependencies.loadSdk ?? loadDshLaunchSdk;
  let applied = false, closed = false, failed = false, fd: number | undefined, db: DatabaseSync | undefined;
  let ports: DshChildPorts | undefined;
  let bootstrap: ReturnType<typeof createDshLaunchBootstrap<string, string, DshSdkSessionAgent<string>, unknown>> | undefined;
  let startup: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let recordStateRef: ((state: Readonly<DshLaunchBootstrapState>) => void) | undefined;
  let prepared: Rendered | undefined;
  let activeSessionHash: string | undefined;
  const close = (): Promise<void> => {
    closed = true;
    // Fence the existing host synchronously before waiting for pending startup.
    const drain = bootstrap?.close();
    void drain?.catch(() => {});
    stopping ??= (async () => {
      await startup?.catch(() => {});
      await drain;
      if (bootstrap && !drain) await bootstrap.close();
      if (!bootstrap) recordStateRef?.({ phase: 'closed' });
      await ports?.close(); db?.close(); db = undefined;
      if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
    })().catch(error => { stopping = undefined; throw error; });
    return stopping;
  };
  const plugin = { name: 'swarmboard-dsh-launch-child',
    inject: ['agents', 'sessions', 'agentDefaultModel', 'sessionPersistence', 'tools', 'permissionPresets'],
    apply(ctx: DshChildContext, options: { configPath: string; configSha256: string }) {
      ensure(!closed && !applied, 'DSH_CHILD_ALREADY_APPLIED'); applied = true;
      const launch = Object.freeze({ configPath: options.configPath, configSha256: options.configSha256 });
      startup = Promise.resolve().then(async () => {
        await ctx.get('loader')?.await(); if (closed) return;
        const config = readDshChildConfig(launch);
        activeSessionHash = hash(config.identity.sessionRef);
        const statePath = join(config.stageDirectory, 'child-state.jsonl');
        fd = fs.openSync(statePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        syncDirectory(statePath);
        const recordState = (state: Readonly<DshLaunchBootstrapState>) => {
          ensure(fd !== undefined, 'DSH_CHILD_STATE_SINK_CLOSED');
          fs.writeSync(fd!, JSON.stringify({ schema: 'swarmboard-dsh-child-state/v1', configSha256: launch.configSha256,
            sessionHash: hash(config.identity.sessionRef), pid: process.pid, ...state }) + '\n'); fs.fsyncSync(fd!);
        };
        recordStateRef = recordState;
        recordState({ phase: 'starting' });
        const sdk = await loadSdk(config.sdk); if (closed) return;
        ports = await openPorts(ctx, config); if (closed) return;
        const sidecar = join(config.runtimeDirectory, 'durable-host.sqlite');
        const claim = fs.openSync(sidecar, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.fsyncSync(claim); } finally { fs.closeSync(claim); }
        syncDirectory(sidecar);
        db = new DatabaseSync(sidecar);
        const lease = createDshHostLease({ db, ...config.identity });
        const protocolText = workerProtocol();
        const boundary = createDshInstructionBoundary({ directory: config.runtimeDirectory, workspace: config.identity.cwd,
          sessionCwd: config.identity.cwd, protocolText, protocolDigest: hash(protocolText),
          readPreferences: async () => snapshot(await ports!.callTool({ name: 'preferences_read', arguments: {} })),
          readUserPrompt: async () => snapshot(await ports!.callTool({ name: 'user_prompt_read', arguments: {} })),
          ensureOpen: () => ensure(!closed, 'DSH_CHILD_CLOSED') });
        bootstrap = createDshLaunchBootstrap({ ...config.identity, db, lease, model: config.model,
          permissionPreset: config.permissionPreset, beforeResume: () => {
            const receipt = JSON.parse(pinned(config.sessionReceipt).toString('utf8')) as DshPreparedSession;
            ensure(receipt.sessionRef === config.identity.sessionRef && receipt.cwd === config.identity.cwd
              && receipt.nativeRoot === config.persistenceRoot && within(config.persistenceRoot, receipt.nativePath), 'DSH_CHILD_SESSION_PROVENANCE_REQUIRED');
            directory(ctx.sessionPersistence.root);
            ensure(ctx.sessionPersistence.root === config.persistenceRoot
              && ctx.sessionPersistence.locate({ id: sdk.SessionId(config.identity.sessionRef), cwd: config.identity.cwd }).path === receipt.nativePath,
            'DSH_CHILD_ACTUAL_PERSISTENCE_CONFLICT');
            pinned({ path: receipt.nativePath, sha256: receipt.nativeSha256 });
          }, installModelSelection: sdk.installModelSelection,
          sdkSessionId: sdk.SessionId, messageId: sdk.MessageId,
          callTool: ports.callTool, getCurrentBinding: ports.getCurrentBinding,
          isAuthorized: (batch, agent) => !closed && !failed && ports!.isAuthorized(batch, agent), subscribeWake: ports.subscribeWake,
          prepareInstructions: async () => { prepared = (await boundary.prepare()).rendered; },
          applyPermission: (_ctx, agent, preset) => applyDshLaunchPermission(ctx, agent, preset), recordState,
          onError: () => {} });
        bootstrap.plugin.apply(ctx); if (closed) { await bootstrap.close(); return; }
        await bootstrap.ready(); if (closed) return;
        const agent = ctx.agents.get(config.identity.sessionRef);
        ensure(lease.owns() && agent && agent.id === config.identity.sessionRef && agent.session.id === config.identity.sessionRef
          && agent.session.header.cwd === config.identity.cwd && prepared, 'DSH_CHILD_READY_EVIDENCE_REQUIRED');
        ordinary(join(config.identity.cwd, 'AGENTS.md'));
        ensure(hash(fs.readFileSync(join(config.identity.cwd, 'AGENTS.md'))) === prepared!.digest, 'DSH_CHILD_INSTRUCTIONS_CHANGED');
        writeReady(join(config.stageDirectory, 'child-ready.json'), {
          schema: 'swarmboard-dsh-child-ready/v1', configSha256: launch.configSha256,
          pid: process.pid, sessionHash: hash(config.identity.sessionRef), leaseOwned: true, originalSessionMatches: true,
          permissionDurable: true, instructionsPrepared: true, instructionRole: 'user', instructionDigest: prepared!.digest,
          preferencesVersion: prepared!.preferencesVersion, userPromptVersion: prepared!.userPromptVersion,
          notificationConsumed: false, usefulContribution: false });
      });
      void startup.catch(() => {
        failed = true;
        if (fd !== undefined && bootstrap?.status().phase !== 'failed') {
          try { fs.writeSync(fd, JSON.stringify({ schema: 'swarmboard-dsh-child-state/v1', phase: 'failed',
            errorCode: 'DSH_CHILD_STARTUP_REJECTED', configSha256: launch.configSha256, sessionHash: activeSessionHash, pid: process.pid }) + '\n'); fs.fsyncSync(fd); }
          catch { /* Preserve original rejection and all handles for explicit reconciliation. */ }
        }
      });
      return close;
    } };
  return Object.freeze({ plugin, ready: () => startup ?? Promise.reject(new Error('DSH_CHILD_NOT_APPLIED')), close,
    status: () => failed ? { phase: 'failed', errorCode: 'DSH_CHILD_STARTUP_REJECTED' } : bootstrap?.status(), ownedHandles: () => bootstrap?.ownedHandles() ?? [] });
}

/** Fixed local readback only. Historical startup-ready never masks a later failure. */
export function readDshChildStatus(input: { stageDirectory: string; configSha256: string; sessionRef: string }) {
  directory(input.stageDirectory);
  const base = { startupReady: false, notificationConsumed: false, usefulContribution: false };
  const statePath = join(input.stageDirectory, 'child-state.jsonl');
  if (!exists(statePath)) return { ...base, phase: 'not-started' };
  ordinary(statePath);
  const stateSchema = z.object({ schema: z.literal('swarmboard-dsh-child-state/v1'), configSha256: z.literal(input.configSha256),
    sessionHash: z.literal(hash(input.sessionRef)), pid: z.number().int().positive(),
    phase: z.enum(['starting', 'ready', 'failed', 'closed']), errorCode: z.string().regex(/^[A-Z_]{1,80}$/).optional() });
  let last: z.infer<typeof stateSchema>;
  try {
    const rows = fs.readFileSync(statePath, 'utf8').trim().split('\n').map(line => stateSchema.parse(JSON.parse(line)));
    last = rows.at(-1)!;
    if (!last || rows.some(row => row.pid !== last.pid)) return { ...base, phase: 'unknown' };
  } catch { return { ...base, phase: 'unknown' }; }
  let startupReady = false;
  const readyPath = join(input.stageDirectory, 'child-ready.json');
  if (exists(readyPath)) {
    ordinary(readyPath);
    try {
      const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      startupReady = ready.schema === 'swarmboard-dsh-child-ready/v1' && ready.configSha256 === input.configSha256
        && ready.sessionHash === hash(input.sessionRef) && ready.pid === last.pid
        && ready.leaseOwned === true && ready.originalSessionMatches === true && ready.permissionDurable === true;
    } catch { return { ...base, phase: 'unknown' }; }
  }
  return { ...base, startupReady, phase: last.phase === 'ready' && !startupReady ? 'starting' : last.phase,
    ...(last.errorCode ? { errorCode: last.errorCode } : {}) };
}

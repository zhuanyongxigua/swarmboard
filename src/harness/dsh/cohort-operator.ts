// Compose the durable cohort with official control-plane/session operations.
// All paths and model choices come from trusted operator configuration.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { createDshInstructionBoundary } from './instructions.js';
import { createDshLauncherChannels, type DshLauncherChannels, type DshLauncherToolClient } from './launcher-channels.js';
import { prepareDshSession, type DshPreparedSession } from './launch-session.js';
import { dshChildConfigSchema } from './launch-child.js';
import { dshLaunchProtocol } from './launch-instructions.js';
import { assertDshLaunchAuthority, parseDshLaunchConfig, type DshLaunchConfig } from './cohort-config.js';
import { inspectDshCohort, runDshCohort, type DshCohortRequest, type DshCohortSeat, type DshCohortStage, type DshLaunchRecord } from './cohort.js';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const need = (value: unknown, code: string): void => { if (!value) throw new Error(code); };
interface Pin { path: string; sha256: string }
interface StagedLaunch { pins: Pin[]; overlayPath: string; configPath: string; sessionReceiptPath: string }
export interface DshCohortOperatorOptions {
  config: DshLaunchConfig;
  /** Packaged official Loader plugin entry; never selected by task content. */
  childEntry: string;
  /** Test seams preserve the production operation order, without model calls. */
  channels?: DshLauncherChannels;
  prepareSession?: typeof prepareDshSession;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}
function ordinary(file: string): Buffer {
  const stat = fs.lstatSync(file);
  need(stat.isFile() && stat.nlink === 1 && fs.realpathSync(file) === file, 'DSH_LAUNCH_CANONICAL_FILE_REQUIRED');
  return fs.readFileSync(file);
}
function verifyPin(pin: Pin): Buffer {
  const bytes = ordinary(pin.path);
  need(digest(bytes) === pin.sha256, 'DSH_LAUNCH_PIN_CHANGED');
  return bytes;
}
function directory(file: string, create = false) {
  if (create && !fs.existsSync(file)) fs.mkdirSync(file, { mode: 0o700 });
  need(fs.lstatSync(file).isDirectory() && fs.realpathSync(file) === file, 'DSH_LAUNCH_CANONICAL_DIRECTORY_REQUIRED');
}
function writeOnce(file: string, value: unknown): Pin {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  return { path: file, sha256: digest(bytes) };
}
export function dshCohortRequest(input: DshLaunchConfig): DshCohortRequest {
  const config = parseDshLaunchConfig(input);
  return { cohortKey: config.cohortKey, count: config.count, stateDirectory: config.stateDirectory,
    configuration: JSON.parse(JSON.stringify(config)) as DshLaunchRecord,
    ...(config.sessions.mode === 'select' ? { sessionRefs: config.sessions.seats.map(seat => seat.sessionRef) } : {}) };
}
function locations(config: DshLaunchConfig, seat: DshCohortSeat) {
  const index = Number(seat.key.slice(5)) - 1;
  const stage = path.join(config.stateDirectory, seat.key);
  const runtime = path.join(config.runtimeRoot, seat.key);
  const selected = config.sessions.mode === 'select' ? config.sessions.seats[index] : null;
  return { stage, runtime, cwd: selected?.cwd ?? path.join(config.workspaceRoot, seat.key),
    persistenceRoot: selected?.persistenceRoot ?? path.join(runtime, 'sessions'), sessionStage: path.join(stage, 'session') };
}
function admitted(seat: DshCohortSeat): { id: string; version: number; cursor: number } {
  const value = seat.receipts.admit;
  need(value && typeof value.id === 'string' && Number.isSafeInteger(value.version), 'DSH_LAUNCH_ADMISSION_RECEIPT_REQUIRED');
  return value as unknown as { id: string; version: number; cursor: number };
}
function prepared(seat: DshCohortSeat): DshPreparedSession {
  const value = seat.receipts.session as unknown as DshPreparedSession;
  need(value?.schema === 'swarmboard-dsh-session/v1' && value.sessionRef === seat.sessionRef, 'DSH_LAUNCH_SESSION_RECEIPT_REQUIRED');
  return value;
}
function verifySession(seat: DshCohortSeat, config: DshLaunchConfig) {
  const receipt = prepared(seat), dirs = locations(config, seat);
  need(receipt.cwd === dirs.cwd && receipt.nativeRoot === dirs.persistenceRoot
    && path.relative(receipt.nativeRoot, receipt.nativePath) !== ''
    && !path.relative(receipt.nativeRoot, receipt.nativePath).startsWith('..')
    && !path.isAbsolute(path.relative(receipt.nativeRoot, receipt.nativePath)), 'DSH_LAUNCH_SESSION_ROOT_CONFLICT');
  verifyPin({ path: receipt.nativePath, sha256: receipt.nativeSha256 });
  const stored = JSON.parse(ordinary(path.join(dirs.sessionStage, 'session-prepared.json')).toString()) as DshPreparedSession;
  need(isDeepStrictEqual(stored, receipt), 'DSH_LAUNCH_SESSION_RECEIPT_CHANGED');
}

/** An operator instance owns only its MCP clients. Construction starts nothing. */
export function createDshCohortOperator(input: DshCohortOperatorOptions) {
  const config = parseDshLaunchConfig(input.config), childEntry = input.childEntry;
  const request = dshCohortRequest(config);
  const channels = input.channels ?? createDshLauncherChannels({ nodeCommand: config.nodeCommand,
    server: config.server, boardDatabasePath: config.boardDatabasePath, runtimeDirectory: config.stateDirectory });
  const prepareSession = input.prepareSession ?? prepareDshSession;
  const seatChannels = new Map<string, DshLauncherChannels>();
  const forSeat = (seat: DshCohortSeat) => {
    if (input.channels) return channels;
    if (!seatChannels.has(seat.key)) seatChannels.set(seat.key, createDshLauncherChannels({ nodeCommand: config.nodeCommand,
      server: config.server, boardDatabasePath: config.boardDatabasePath, runtimeDirectory: locations(config, seat).runtime }));
    return seatChannels.get(seat.key)!;
  };
  let management: DshLauncherToolClient | undefined;
  const members = new Map<string, DshLauncherToolClient>();
  const control = async () => management ??= await channels.openManagement();
  const member = async (seat: DshCohortSeat) => {
    const id = admitted(seat).id;
    if (!members.has(id)) members.set(id, await forSeat(seat).openMember(id));
    return members.get(id)!;
  };
  async function preflight(_stage: DshCohortStage, seat: DshCohortSeat) {
    const host = await control();
    const runtime = await host.call('runtime_read');
    assertDshLaunchAuthority(config, runtime);
    for (const taskId of config.taskIds) {
      const task = await host.call('task_read', { id: taskId, limit: 1 });
      need(['todo', 'in_progress', 'in_review'].includes(String(task.status)), 'DSH_LAUNCH_GOAL_INACTIVE');
    }
    if (seat.receipts.admit) {
      const record = (runtime.collaborators as Array<Record<string, unknown>>).find(value => value.id === admitted(seat).id);
      need(record?.enabled === true && !record.revokedAt && record.poolId === config.poolId
        && record.harness === 'dsh' && record.scope === 'selected'
        && record.version === (seat.receipts.bind?.version ?? admitted(seat).version)
        && JSON.stringify(record.taskIds) === JSON.stringify([...config.taskIds].sort())
        && record.sessionRef === (seat.receipts.bind ? seat.sessionRef : ''), 'DSH_LAUNCH_MEMBER_CHANGED');
    }
  }
  async function execute(stage: DshCohortStage, seat: DshCohortSeat): Promise<DshLaunchRecord> {
    const dirs = locations(config, seat);
    if (stage === 'admit') {
      for (const root of [config.stateDirectory, config.runtimeRoot, config.workspaceRoot]) directory(root);
      // These are new per-seat directories, never another cohort's runtime.
      for (const file of [dirs.stage, dirs.runtime]) { need(!fs.existsSync(file), 'DSH_LAUNCH_FRESH_SEAT_REQUIRED'); directory(file, true); }
      directory(dirs.sessionStage, true);
      if (config.sessions.mode === 'create') { need(!fs.existsSync(dirs.cwd), 'DSH_LAUNCH_FRESH_WORKSPACE_REQUIRED'); directory(dirs.cwd, true); directory(dirs.persistenceRoot, true); }
      else { directory(dirs.cwd); directory(dirs.persistenceRoot); }
      const value = await (await control()).call('collaborator_configure', { expectedVersion: 0,
        name: `${config.cohortKey} ${seat.key}`, harness: 'dsh', sessionRef: '',
        taskIds: config.taskIds, scope: 'selected', poolId: config.poolId, enabled: true });
      need(typeof value.id === 'string' && value.id.length > 0 && value.version === 1 && value.enabled === true
        && value.sessionRef === '' && value.poolId === config.poolId && value.scope === 'selected'
        && JSON.stringify(value.taskIds) === JSON.stringify([...config.taskIds].sort()), 'DSH_LAUNCH_ADMISSION_CONFLICT');
      return value as DshLaunchRecord;
    }
    if (stage === 'session') {
      const pins = config.sdk.pins;
      return await prepareSession({ mode: config.sessions.mode, sessionRef: seat.sessionRef, cwd: dirs.cwd,
        persistenceRoot: dirs.persistenceRoot, stateDirectory: dirs.sessionStage,
        sdk: { root: config.sdk.root, pins: { cordis: pins.cordis, 'dsh-session': pins['dsh-session'],
          'dsh-session-persistence-jsonl': pins['dsh-session-persistence-jsonl'] } } }) as unknown as DshLaunchRecord;
    }
    if (stage === 'bind') {
      verifySession(seat, config);
      const before = admitted(seat);
      const value = await (await control()).call('collaborator_configure', { id: before.id, expectedVersion: before.version,
        name: `${config.cohortKey} ${seat.key}`, harness: 'dsh', sessionRef: seat.sessionRef, taskIds: config.taskIds,
        scope: 'selected', poolId: config.poolId, enabled: true });
      need(value.id === before.id && value.sessionRef === seat.sessionRef && value.enabled === true, 'DSH_LAUNCH_BINDING_CONFLICT');
      return value as DshLaunchRecord;
    }
    if (stage === 'instructions') {
      const connection = await member(seat), protocol = dshLaunchProtocol({ memberId: admitted(seat).id,
        sessionRef: seat.sessionRef, cwd: dirs.cwd, poolId: config.poolId, taskIds: config.taskIds });
      const boundary = createDshInstructionBoundary({ directory: dirs.runtime, workspace: dirs.cwd, sessionCwd: prepared(seat).cwd,
        protocolText: protocol.text, protocolDigest: protocol.digest, ensureOpen() {},
        readPreferences: async () => await connection.call('preferences_read') as unknown as { version: number; text: string },
        readUserPrompt: async () => await connection.call('user_prompt_read') as unknown as { version: number; text: string } });
      const result = await boundary.prepare();
      verifySession(seat, config);
      return { path: boundary.target, sha256: result.rendered.digest, preferencesVersion: result.snapshot.version,
        userPromptVersion: result.snapshot.userPromptVersion ?? 0 };
    }
    if (stage === 'register') {
      const connection = await member(seat), adapterId = `dsh-${admitted(seat).id}`;
      need((await connection.call('notification_binding_read', { adapterId })).binding === null, 'DSH_LAUNCH_REGISTRATION_ALREADY_EXISTS');
      await connection.call('notification_register', { id: adapterId, version: 1, displayName: `${config.cohortKey} ${seat.key}`,
        harness: 'dsh', enabled: true, capabilities: ['durableDelivery', 'receipt', 'sameSessionContinuation', 'timedReminder'],
        members: [{ memberId: admitted(seat).id, sessionRef: seat.sessionRef, taskIds: config.taskIds, boardWide: false }] });
      const binding = (await connection.call('notification_binding_read', { adapterId })).binding as DshLaunchRecord;
      need(binding?.memberId === admitted(seat).id && binding.sessionRef === seat.sessionRef && binding.enabled === true
        && binding.registrationVersion === 1 && binding.admissionVersion === seat.receipts.bind?.version, 'DSH_LAUNCH_REGISTRATION_CONFLICT');
      return binding;
    }
    if (stage === 'stage') {
      verifySession(seat, config);
      const runtime = await (await control()).call('runtime_read'); assertDshLaunchAuthority(config, runtime);
      const grants = runtime.executionGrants as Array<Record<string, unknown>>;
      const goalBindings = config.taskIds.map(taskId => {
        const grant = grants.find(value => value.taskId === taskId)!;
        return { taskId, poolId: config.poolId, projectPath: grant.projectPath, executionWorkspace: grant.executionWorkspace };
      });
      const sessionReceiptPath = path.join(dirs.sessionStage, 'session-prepared.json');
      const sessionPin = { path: sessionReceiptPath, sha256: digest(ordinary(sessionReceiptPath)) };
      const childPin = { path: childEntry, sha256: digest(ordinary(childEntry)) };
      const child = { schema: 'swarmboard-dsh-child/v1', identity: { memberId: admitted(seat).id, sessionRef: seat.sessionRef,
        adapterId: seat.receipts.register!.adapterId, cwd: dirs.cwd }, stageDirectory: dirs.stage,
        runtimeDirectory: dirs.runtime, persistenceRoot: dirs.persistenceRoot, sessionReceipt: sessionPin,
        boardDatabasePath: config.boardDatabasePath, nodeCommand: config.nodeCommand, server: config.server,
        sdk: config.sdk, model: config.model, permissionPreset: config.permissionPreset, goalBindings };
      const childConfig = writeOnce(path.join(dirs.stage, 'child-config.json'), dshChildConfigSchema.parse(child));
      const overlay = writeOnce(path.join(dirs.stage, 'overlay.json'), [
        { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
        { id: 'session-title-llm', disabled: true },
        { id: config.providerConfiguration.entryId, config: config.providerConfiguration.config },
        { id: 'agent-default-model', config: { provider: config.model.provider, model: config.model.model } },
        { id: 'session-persistence', config: { root: dirs.persistenceRoot } },
        { insert: [
          { id: 'swarmboard-member-mcp', name: '@deepseek-ai/dsh-mcp-client', config: forSeat(seat).memberMcpConfig(admitted(seat).id) },
          { id: 'swarmboard-child', name: childEntry, config: { configPath: childConfig.path, configSha256: childConfig.sha256 } },
        ] },
      ]);
      const pins = [childPin, childConfig, overlay, sessionPin, { path: prepared(seat).nativePath, sha256: prepared(seat).nativeSha256 },
        config.server, config.cli, ...Object.entries(config.sdk.pins).map(([name, sha256]) => ({
          path: path.join(config.sdk.root, 'node_modules/@deepseek-ai', name, 'lib/index.js'), sha256 }))];
      pins.forEach(verifyPin);
      return { pins: pins.map(pin => ({ path: pin.path, sha256: pin.sha256 })), overlayPath: overlay.path, configPath: childConfig.path, sessionReceiptPath };
    }
    const manifest = seat.receipts.stage as unknown as StagedLaunch;
    need(manifest && Array.isArray(manifest.pins), 'DSH_LAUNCH_STAGE_REQUIRED');
    verifySession(seat, config);
    manifest.pins.forEach(verifyPin);
    const log = fs.openSync(path.join(dirs.stage, 'child.log'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const child = (input.spawn ?? spawn)(config.nodeCommand, [config.cli.path, '--profile', config.cli.profile, '--patch', manifest.overlayPath], {
        cwd: dirs.cwd, detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, HOME: dirs.runtime, DSH_HOME: dirs.runtime, DSH_PERMISSION_MODE: config.permissionPreset },
      });
      await new Promise<void>((resolve, reject) => { child.once('error', () => reject(new Error('DSH_LAUNCH_SPAWN_UNCONFIRMED'))); child.once('spawn', resolve); });
      need(Number.isSafeInteger(child.pid) && child.pid! > 0, 'DSH_LAUNCH_PID_UNCONFIRMED');
      child.unref();
      return { pid: child.pid!, spawned: true, ready: false, consumed: false };
    } finally { fs.closeSync(log); }
  }
  return {
    inspect: () => inspectDshCohort(request),
    run: () => runDshCohort(request, { preflight, execute }),
    close: async () => { await Promise.all([channels, ...seatChannels.values()].map(value => value.close())); },
  };
}

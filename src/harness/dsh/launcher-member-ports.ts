// Join explicit launcher channels to current scope and existing file wakeups.
// Authority comes from formal APIs; no SQLite, timer, model, or legacy module loads.
import { statSync, watch } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { NotificationBinding } from '../../notification-service.js';
import type { DeliveryBatch } from './notification-driver.js';
import type { DshSdkSessionAgent } from './sdk-session.js';
import { readDshLauncherToolResult, type DshLauncherChannels, type DshLauncherToolClient } from './launcher-channels.js';

export interface DshLauncherIdentity { memberId: string; sessionRef: string; adapterId: string; cwd: string }
export interface DshLauncherGoalBinding { taskId: string; poolId: string; projectPath: string; executionWorkspace: string }
export interface DshLauncherMemberPortsOptions {
  channels: DshLauncherChannels;
  identity: DshLauncherIdentity;
  boardDatabasePath: string;
  goalBindings: readonly DshLauncherGoalBinding[];
}
export interface DshLauncherMemberPorts {
  readonly adapterId: string;
  readonly closed: boolean;
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  getCurrentBinding(): Promise<NotificationBinding | undefined>;
  isAuthorized(batch: DeliveryBatch, agent: DshSdkSessionAgent<string>): boolean;
  subscribeWake(listener: () => void): () => void;
  readPreferences(): Promise<Record<string, unknown>>;
  readUserPrompt(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes('\0');
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const absolute = (value: unknown): value is string => text(value) && isAbsolute(value) && resolve(value) === value;
const caps = ['durableDelivery', 'receipt', 'sameSessionContinuation', 'timedReminder'];
const tools = new Set(['preferences_read', 'user_prompt_read', 'task_read', 'context_read',
  'notification_binding_read', 'notification_pending', 'notification_receipt']);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const fail = (code: string): never => { throw Error(`DSH_LAUNCH_${code}`); };
function validate(identity: DshLauncherIdentity, goals: readonly DshLauncherGoalBinding[]) {
  if (!identity || ![identity.memberId, identity.sessionRef, identity.adapterId].every(text) || !absolute(identity.cwd)
    || !Array.isArray(goals) || !goals.length
    || goals.some(goal => !record(goal) || Object.keys(goal).sort().join(',') !== 'executionWorkspace,poolId,projectPath,taskId'
      || !text(goal.taskId) || !text(goal.poolId) || !absolute(goal.projectPath) || !absolute(goal.executionWorkspace))
    || new Set(goals.map(goal => goal.taskId)).size !== goals.length
    || !goals.some(goal => { const tail = relative(goal.executionWorkspace, identity.cwd);
      return tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); })) fail('INVALID_MEMBER_PORTS');
}
function valid(binding: unknown, identity: DshLauncherIdentity): binding is NotificationBinding {
  return record(binding) && binding.adapterId === identity.adapterId && binding.memberId === identity.memberId
    && binding.sessionRef === identity.sessionRef && binding.enabled === true && positive(binding.registrationVersion)
    && positive(binding.admissionVersion) && typeof binding.boardWide === 'boolean' && strings(binding.taskIds)
    && strings(binding.capabilities) && caps.every(capability => binding.capabilities.includes(capability));
}
const stamp = (binding: NotificationBinding) => JSON.stringify([binding.adapterId, binding.memberId, binding.sessionRef,
  binding.registrationVersion, binding.admissionVersion, binding.enabled, binding.boardWide,
  [...binding.taskIds].sort(), [...binding.capabilities].sort()]);

/** Existing database/WAL event sources only. Directory events also rebind files
 * after replacement; every failure closes watchers before reporting denial. */
export function watchDshLauncherBoard(file: string, onChange: () => void, onError: (error: unknown) => void) {
  if (!absolute(file)) fail('INVALID_WATCH_PATH');
  const paths = [file, file + '-wal'];
  const files = new Map<string, { id: string; watcher: ReturnType<typeof watch> }>();
  let directory: ReturnType<typeof watch> | undefined, closed = false;
  const close = () => { closed = true; directory?.close(); for (const item of files.values()) item.watcher.close(); files.clear(); };
  const error = (cause: unknown) => { if (!closed) { close(); onError(cause); } };
  const identity = (path: string) => {
    try { const value = statSync(path); return `${value.dev}:${value.ino}`; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause; }
  };
  const refresh = () => {
    for (const path of paths) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = identity(path), old = files.get(path);
        if (old?.id === id) break;
        files.delete(path); old?.watcher.close();
        if (id === null) break;
        let current: ReturnType<typeof watch>;
        try { current = watch(path, () => {
          if (closed || files.get(path)?.watcher !== current) return;
          try { refresh(); onChange(); } catch (cause) { error(cause); }
        }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && attempt < 2) continue; throw cause; }
        current.on('error', cause => { if (!closed && files.get(path)?.watcher === current) error(cause); });
        let next: string | null;
        try { next = identity(path); } catch (cause) { current.close(); throw cause; }
        if (next === id) { files.set(path, { id, watcher: current }); break; }
        current.close(); if (attempt === 2) fail('UNSTABLE_WATCH_FILE');
      }
    }
  };
  try {
    directory = watch(dirname(file), (_event, name) => {
      if (closed || name !== null && !paths.some(path => basename(path) === String(name))) return;
      try { refresh(); onChange(); } catch (cause) { error(cause); }
    });
    directory.on('error', error); refresh(); return { close };
  } catch (cause) { close(); throw cause; }
}

interface BoundPortsOptions {
  identity: DshLauncherIdentity;
  goalBindings: readonly DshLauncherGoalBinding[];
  management: DshLauncherToolClient;
  member: DshLauncherToolClient;
  subscribe(onWake: () => void, onError: (error: unknown) => void): () => void;
  close(): Promise<void>;
}

/** Public composition seam: the default opener below supplies real MCP and file
 * events; isolated tests can supply synthetic authoritative replies and wakes. */
export function createDshLauncherMemberPorts(options: BoundPortsOptions): DshLauncherMemberPorts {
  const identity = structuredClone(options.identity), goals = structuredClone(options.goalBindings);
  const { management, member, subscribe, close } = options;
  validate(identity, goals);
  let closed = false, failed = false, epoch = 0;
  let snapshot: { epoch: number; binding: NotificationBinding } | undefined, closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const invalidate = (error = false) => {
    epoch++; snapshot = undefined; failed ||= error;
    for (const listener of listeners) { try { listener(); } catch { failed = true; snapshot = undefined; } }
  };
  const stop = subscribe(() => invalidate(), () => invalidate(true));
  if (typeof stop !== 'function') fail('WAKE_UNSUBSCRIBE_REQUIRED');
  const callTool = async (request: { name: string; arguments: Record<string, unknown> }) => {
    if (closed || failed) fail('MEMBER_PORTS_CLOSED');
    if (!request || !tools.has(request.name) || !record(request.arguments)) fail('TOOL_OUTSIDE_MEMBER_PORTS');
    try { return await member.callTool(request); } catch (cause) { invalidate(true); throw cause; }
  };
  const read = async () => readDshLauncherToolResult(await callTool({ name: 'notification_binding_read',
    arguments: { adapterId: identity.adapterId } })).binding;
  const authority = (runtime: Record<string, unknown>, binding: NotificationBinding) => {
    const pool = runtime.pool, members = runtime.collaborators, grants = runtime.executionGrants;
    if (!record(pool) || pool.enabled !== true || !text(pool.id) || !positive(pool.version) || !strings(pool.taskIds)
      || ['stopping', 'stopped'].includes(pool.state)
      || !Array.isArray(members) || !Array.isArray(grants)) return undefined;
    const matches = members.filter(item => record(item) && item.id === identity.memberId);
    if (matches.length !== 1) return undefined;
    const admission = matches[0];
    if (!record(admission) || admission.harness !== 'dsh' || admission.enabled !== true || admission.revokedAt !== null
      || admission.sessionRef !== identity.sessionRef || admission.version !== binding.admissionVersion
      || !strings(admission.taskIds) || admission.poolId !== undefined && admission.poolId !== pool.id) return undefined;
    if (admission.scope !== undefined && !['selected', 'organization'].includes(admission.scope)) return undefined;
    if (admission.scope === 'organization' && admission.poolId !== pool.id) return undefined;
    const scope = goals.filter(goal => binding.taskIds.includes(goal.taskId) && goal.poolId === pool.id
      && (!pool.taskIds.length || pool.taskIds.includes(goal.taskId))
      && (admission.scope === 'organization' || admission.taskIds.includes(goal.taskId))).flatMap(goal => {
      const matches = grants.filter(grant => record(grant) && Object.entries(goal).every(([key, value]) => grant[key] === value));
      if (matches.length !== 1) return [];
      const grant = matches[0];
      return record(grant) && grant.enabled === true && grant.monitoring === true && positive(grant.version)
        && Array.isArray(grant.externalHarnesses) && grant.externalHarnesses.includes('dsh') ? [{ ...goal, version: grant.version }] : [];
    });
    return scope.length ? { scope, stamp: JSON.stringify([pool.id, pool.version, pool.enabled, [...pool.taskIds].sort(),
      admission.version, admission.sessionRef, admission.scope ?? 'selected', [...admission.taskIds].sort(),
      scope.map(goal => [goal.taskId, goal.poolId, goal.projectPath, goal.executionWorkspace, goal.version])]) } : undefined;
  };
  const getCurrentBinding = async (): Promise<NotificationBinding | undefined> => {
    snapshot = undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = epoch;
      try {
        const first = await read(); if (!valid(first, identity)) return;
        const initial = authority(await management.call('runtime_read'), first); if (!initial) return;
        const allowed: string[] = [];
        for (const goal of initial.scope) {
          const task = await management.call('task_read', { id: goal.taskId, limit: 1 });
          if (task.id === goal.taskId && ['todo', 'in_progress', 'in_review', 'blocked'].includes(String(task.status))) allowed.push(goal.taskId);
        }
        const final = authority(await management.call('runtime_read'), first);
        const second = await read();
        if (!valid(second, identity) || stamp(first) !== stamp(second) || !final || initial.stamp !== final.stamp
          || closed || failed || !allowed.length) return;
        if (before !== epoch) continue;
        const binding = { ...second, taskIds: second.taskIds.filter(taskId => allowed.includes(taskId)) };
        snapshot = { epoch, binding: structuredClone(binding) }; return structuredClone(binding);
      } catch { snapshot = undefined; return; }
    }
  };
  return {
    adapterId: identity.adapterId,
    get closed() { return closed || failed; }, callTool, getCurrentBinding,
    isAuthorized(batch, agent) {
      try {
        const binding = (batch as DeliveryBatch & { notificationBinding?: NotificationBinding }).notificationBinding;
        if (closed || failed || !snapshot || snapshot.epoch !== epoch || !valid(binding, identity)
          || stamp(binding) !== stamp(snapshot.binding) || batch.adapterId !== identity.adapterId
          || batch.memberId !== identity.memberId || batch.sessionRef !== identity.sessionRef
          || agent.id !== identity.sessionRef || agent.session.id !== identity.sessionRef || agent.session.header.cwd !== identity.cwd) return false;
        return Array.isArray(batch.entries) && batch.entries.every(entry =>
          (entry.recipientId === undefined || entry.recipientId === identity.memberId)
          && (entry.taskId === undefined || snapshot!.binding.taskIds.includes(entry.taskId)))
          && (!batch.check || batch.check.goalIds.some(taskId => snapshot!.binding.taskIds.includes(taskId)));
      } catch { return false; }
    },
    subscribeWake(listener) {
      if (closed || failed || typeof listener !== 'function') fail('MEMBER_PORTS_CLOSED');
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    readPreferences: async () => readDshLauncherToolResult(await callTool({ name: 'preferences_read', arguments: {} })),
    readUserPrompt: async () => readDshLauncherToolResult(await callTool({ name: 'user_prompt_read', arguments: {} })),
    close() { closed = true; epoch++; snapshot = undefined; listeners.clear();
      closing ??= (async () => { stop(); await close(); })(); return closing; },
  };
}

export async function openDshLauncherMemberPorts(options: DshLauncherMemberPortsOptions): Promise<DshLauncherMemberPorts> {
  const identity = structuredClone(options.identity), goals = structuredClone(options.goalBindings);
  const { channels, boardDatabasePath } = options;
  validate(identity, goals);
  if (!absolute(boardDatabasePath) || boardDatabasePath !== channels.boardDatabasePath) fail('CHANNEL_BOARD_MISMATCH');
  let management: DshLauncherToolClient | undefined, member: DshLauncherToolClient | undefined, ports: DshLauncherMemberPorts | undefined;
  try {
    management = await channels.openManagement(); member = await channels.openMember(identity.memberId);
    ports = createDshLauncherMemberPorts({ identity, goalBindings: goals, management, member,
      subscribe(onWake, onError) {
        const watches: { close(): void }[] = [];
        try { for (const file of [boardDatabasePath, boardDatabasePath + '.runtime.sqlite'])
          watches.push(watchDshLauncherBoard(file, onWake, onError)); }
        catch (cause) { for (const watcher of watches) watcher.close(); throw cause; }
        return () => { for (const watcher of watches) watcher.close(); };
      },
      close: async () => { await Promise.all([member!.close(), management!.close()]); },
    });
    if (!await ports.getCurrentBinding()) fail('CURRENT_MEMBER_BINDING_REQUIRED');
    return ports;
  } catch (cause) {
    if (ports) await ports.close().catch(() => {});
    else await Promise.allSettled([member?.close(), management?.close()]);
    throw cause;
  }
}

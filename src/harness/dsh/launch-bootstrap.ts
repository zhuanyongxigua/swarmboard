// Bind explicit official model/permission setup to the existing single-consumer host.
// Construction is inert; only the official Cordis apply starts a resume operation.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDshHostPlugin, type DshHostPluginOptions } from './host-plugin.js';
import type { DshSdkPluginContext } from './sdk-plugin.js';
import type { DshSdkHandle } from './sdk-facade.js';
import type { DshSdkSessionAgent } from './sdk-session.js';

function requireSynchronous(value: unknown, code: string) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => {});
    throw new Error(code);
  }
}

export interface DshLaunchPermissionContext {
  permissionPresets: {
    set(session: unknown, preset: string): void;
    current(events: readonly unknown[]): string;
  };
}
/** The official current() fold checks preset and effective knob consistency. */
export function applyDshLaunchPermission(
  ctx: DshLaunchPermissionContext, agent: { session: { events: readonly unknown[] } }, preset: string,
) {
  if (!preset?.trim()) throw new Error('DSH_LAUNCH_PERMISSION_REQUIRED');
  ctx.permissionPresets.set(agent.session, preset);
  if (ctx.permissionPresets.current(agent.session.events) !== preset) throw new Error('DSH_LAUNCH_PERMISSION_CONFLICT');
}

/** Called explicitly by the trusted official host, never from task or message content. */
export async function loadDshLaunchSdk(input: { root: string; pins: Record<'dsh-agent' | 'dsh-session' | 'dsh-llm', string> }) {
  if (!isAbsolute(input.root) || fs.realpathSync(input.root) !== input.root) throw new Error('DSH_LAUNCH_SDK_ROOT_REQUIRED');
  const loaded = await Promise.all((['dsh-agent', 'dsh-session', 'dsh-llm'] as const).map(async name => {
    const file = join(input.root, 'node_modules/@deepseek-ai', name, 'lib/index.js');
    if (!/^[a-f0-9]{64}$/.test(input.pins[name]) || !fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file
      || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== input.pins[name]) throw new Error('DSH_LAUNCH_SDK_PIN_MISMATCH');
    const url = pathToFileURL(file); url.searchParams.set('sha256', input.pins[name]);
    return [name, await import(url.href)];
  }));
  const modules = Object.fromEntries(loaded);
  const result = { installModelSelection: modules['dsh-agent'].installModelSelection as DshLaunchSetup<unknown>['installModelSelection'],
    SessionId: modules['dsh-session'].SessionId as (value: string) => string,
    MessageId: modules['dsh-llm'].MessageId as (value: string) => string };
  if (!Object.values(result).every(value => typeof value === 'function')) throw new Error('DSH_LAUNCH_SDK_API_REQUIRED');
  return result;
}

export interface DshLaunchModel {
  provider: string;
  model: string;
  reasoningEffort: string;
}
export interface DshLaunchSetup<C> {
  model: DshLaunchModel;
  /** Official installModelSelection returns a scoped listener disposer, not an AgentSetup transaction. */
  installModelSelection(ctx: C, selection: { current: DshLaunchModel; assembled: undefined }): unknown;
}
/** Never return the listener disposer to AgentLoop.setupAndPublish(). */
export function createDshLaunchSetup<C>(input: DshLaunchSetup<C>): (ctx: C) => void {
  const model = Object.freeze({ ...input.model });
  const install = input.installModelSelection;
  if (typeof install !== 'function') throw new Error('DSH_LAUNCH_MODEL_INSTALLER_REQUIRED');
  if (![model.provider, model.model, model.reasoningEffort].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('DSH_LAUNCH_MODEL_REQUIRED');
  }
  return ctx => { requireSynchronous(install(ctx, { current: { ...model }, assembled: undefined }), 'DSH_LAUNCH_ASYNC_MODEL_INSTALLER'); };
}

export interface DshLaunchBootstrapState {
  phase: 'not-applied' | 'starting' | 'ready' | 'failed' | 'closed';
  errorCode?: string;
}
const knownErrors = new Set(['STALE_NOTIFICATION_BINDING', 'UNKNOWN_DELIVERY', 'DSH_HOST_LEASE_LOST',
  'DSH_HOST_LEASE_REQUIRED', 'DSH_HOST_NOT_QUIESCENT', 'DSH_RECONCILIATION_REQUIRED',
  'DSH_SESSION_CONFLICT', 'DSH_SESSION_MISSING', 'DSH_LAUNCH_IDENTITY_CONFLICT', 'DSH_LAUNCH_PERMISSION_NOT_DURABLE']);
function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message.split(':', 1)[0] : '';
  return knownErrors.has(message) ? message : 'DSH_LAUNCH_HOST_FAILED';
}

export type DshLaunchBootstrapOptions<S extends string, M extends string, A extends DshSdkSessionAgent<M>, C> =
  Omit<DshHostPluginOptions<S, M, A>, 'mode' | 'createOptions' | 'resumeOptions'> & DshLaunchSetup<C> & {
    permissionPreset: string;
    /** Synchronous durable sink, supplied by the trusted external runtime; never log raw errors. */
    recordState(state: Readonly<DshLaunchBootstrapState>): void;
    /** Trusted composition must call the official preset APIs and throw on unsupported choices. */
    applyPermission(ctx: DshSdkPluginContext<S, M, A>, agent: A, preset: string): void;
  };

export function createDshLaunchBootstrap<S extends string, M extends string, A extends DshSdkSessionAgent<M>, C>(
  input: DshLaunchBootstrapOptions<S, M, A, C>,
) {
  const options = { ...input, model: { ...input.model } };
  if (!options.permissionPreset?.trim()) throw new Error('DSH_LAUNCH_PERMISSION_REQUIRED');
  const setup = createDshLaunchSetup(options);
  let state: DshLaunchBootstrapState = { phase: 'not-applied' };
  const report = (next: DshLaunchBootstrapState) => {
    state = Object.freeze({ ...next });
    requireSynchronous(options.recordState(state), 'DSH_LAUNCH_ASYNC_STATE_SINK');
  };
  let startup: Promise<void> | undefined;
  let applied = false;
  let closed = false;
  let stop: (() => Promise<void>) | undefined;
  let entry: ReturnType<typeof createDshHostPlugin<S, M, A>> | undefined;
  const retained = new Set<DshSdkHandle<A>>();
  const plugin = {
    name: 'swarmboard-dsh-launch-bootstrap',
    inject: ['agents', 'sessions', 'agentDefaultModel', 'sessionPersistence', 'tools', 'permissionPresets'],
    apply(ctx: DshSdkPluginContext<S, M, A>) {
      if (closed) throw new Error('DSH_LAUNCH_CLOSED');
      if (applied) throw new Error('DSH_LAUNCH_ALREADY_APPLIED');
      applied = true;
      report({ phase: 'starting' });
      if (ctx.agents.get(options.sdkSessionId(options.sessionRef))) throw new Error('DSH_LAUNCH_AGENT_ALREADY_LIVE');
      entry = createDshHostPlugin({ ...options, mode: 'resume', createOptions: {},
        onError: error => {
          try { report({ phase: 'failed', errorCode: errorCode(error) }); } finally { options.onError(error); }
        },
        resumeOptions: { agentOptions: { provider: options.model.provider, model: options.model.model }, setup } });
      const registry = {
        get: (id: S) => ctx.agents.get(id),
        create: async (): Promise<DshSdkHandle<A>> => { throw new Error('DSH_LAUNCH_CREATE_FORBIDDEN'); },
        resume: async (resumeOptions: { resumeSessionId: S; [key: string]: unknown }) => {
          const handle = await ctx.agents.resume(resumeOptions);
          retained.add(handle);
          const agent = handle.agent;
          if (agent.id !== options.sessionRef || agent.session.id !== options.sessionRef
            || agent.session.header.cwd !== options.cwd) throw new Error('DSH_LAUNCH_IDENTITY_CONFLICT');
          requireSynchronous(options.applyPermission(ctx, agent, options.permissionPreset), 'DSH_LAUNCH_ASYNC_PERMISSION');
          if (await ctx.sessions.flush(agent.session) !== true) throw new Error('DSH_LAUNCH_PERMISSION_NOT_DURABLE');
          return handle;
        },
      };
      stop = entry.plugin.apply({ agents: registry, sessions: ctx.sessions, on: ctx.on.bind(ctx) });
      startup = entry.ready().then(() => { if (state.phase === 'starting') report({ phase: 'ready' }); }).catch(error => {
        if (state.phase !== 'failed') {
          try { report({ phase: 'failed', errorCode: errorCode(error) }); } catch { /* Status still records the failed sink. */ }
          try { options.onError(error); } catch { /* Preserve the original startup rejection. */ }
        }
        throw error;
      });
      void startup.catch(() => {});
      return () => close();
    },
  };
  const close = async () => {
    closed = true;
    try { await stop?.(); report({ phase: 'closed' }); }
    catch (error) { report({ phase: 'failed', errorCode: errorCode(error) }); throw error; }
  };
  return Object.freeze({ plugin,
    status: (): Readonly<DshLaunchBootstrapState> => Object.freeze({ ...state }),
    ready: () => startup ?? Promise.reject(new Error('DSH_LAUNCH_NOT_APPLIED')),
    close,
    ownedHandles: () => Object.freeze([...new Set([...retained, ...(entry?.ownedHandles() ?? [])])]),
  });
}

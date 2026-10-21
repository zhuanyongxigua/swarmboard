// Mount the reviewed SDK boundaries in an existing Cordis host. All personal
// configuration, wake sources and the single-writer lease are explicit inputs;
// importing or constructing this entry never starts an SDK or a model.
import { DshLifecycle } from './lifecycle.js';
import { createDshJournals, type SqliteDatabase } from './journal-store.js';
import { createDshSdkFacade, type DshSdkHandle, type DshSdkRegistry } from './sdk-facade.js';
import { createDshSdkSessionPort, type DshSdkBatch, type DshSdkEvent, type DshSdkSessionAgent } from './sdk-session.js';
import type { DeliveryBatch, DriveResult, Journal, PendingPort, SessionPort } from './notification-driver.js';

export interface DshPluginLease { acquire(): boolean; owns(): boolean; release(): void }
export interface DshPluginRunner { pass(): Promise<DriveResult>; stop(): Promise<void> }
export interface DshPluginPendingPort extends PendingPort {
  /** Re-read the caller-bound notification service and its current binding. */
  isCurrent(batch: DeliveryBatch): Promise<boolean>;
}
export interface DshPluginRunnerInput {
  lease: DshPluginLease;
  ports: { pending: PendingPort; session: SessionPort; journal: Journal };
  canRelease(): boolean;
}

/** Public Cordis/DSH service shapes; no runtime dependency on a personal SDK. */
export interface DshSdkPluginContext<S extends string, M extends string, A extends DshSdkSessionAgent<M>> {
  agents: DshSdkRegistry<S, A>;
  sessions: { flush(session: A['session']): Promise<boolean> };
  on(name: 'agent/status', listener: (payload: { agent: A; status: 'idle' | 'running' }) => void): () => unknown;
  on(name: 'session/event', listener: (session: A['session'], event: DshSdkEvent) => void): () => unknown;
}

export interface DshSdkPluginOptions<S extends string, M extends string, A extends DshSdkSessionAgent<M>> {
  adapterId?: string;
  memberId: string;
  sessionRef: string;
  cwd: string;
  /** Required; missing attach never falls back to create or resume. */
  mode: 'attach' | 'resume' | 'start';
  db: SqliteDatabase;
  sdkSessionId(value: string): S;
  messageId(value: string): M;
  createOptions: Readonly<Record<string, unknown>>;
  resumeOptions: Readonly<Record<string, unknown>>;
  lease: DshPluginLease;
  pending: DshPluginPendingPort;
  /** Current admission/scope, evaluated synchronously immediately before send. */
  isAuthorized(batch: DshSdkBatch, agent: A): boolean;
  /** Refresh the existing official instruction channel from formal snapshots.
   * The host retains its original SDK setup/overlay and instruction plugin. */
  prepareInstructions(): Promise<void>;
  /** Subscribe to the existing host notification source; never create a timer. */
  subscribeWake(listener: () => void): () => unknown;
  createRunner(input: DshPluginRunnerInput): DshPluginRunner;
  onError(error: unknown): void;
}

/** Explicit trusted composition entry, usable as ctx.plugin(entry.plugin).
 * Cordis apply returns its cleanup effect; there are no invented ready/dispose
 * events. The caller can await ready() to observe startup failure. Unloading
 * stops admission and drains only local work, never disposes an AgentHandle.
 */
export function createDshSdkPlugin<S extends string, M extends string, A extends DshSdkSessionAgent<M>>(
  input: DshSdkPluginOptions<S, M, A>,
) {
  const options = Object.freeze({ ...input });
  if (!['attach', 'resume', 'start'].includes(options.mode)) throw new Error('DSH_INVALID_MODE');
  let applied = false;
  let closed = false;
  let failed = false;
  let acquired = false;
  let queued = false;
  let startup: Promise<void> | undefined;
  let pumping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let runner: DshPluginRunner | undefined;
  let quiescent = () => false;
  let handles: () => readonly DshSdkHandle<A>[] = () => [];
  const subscriptions: (() => unknown)[] = [];
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    // An observer failure cannot turn a rejected operation into a retry.
    try { options.onError(error); } catch { /* Startup still rejects via ready(). */ }
  };
  const requestPass = (): Promise<void> => {
    if (closed || failed || !runner) return Promise.resolve();
    queued = true;
    if (!pumping) {
      pumping = Promise.resolve().then(async () => {
        while (queued && !closed && !failed) {
          queued = false;
          if (options.lease.owns() !== true) throw new Error('DSH_HOST_LEASE_LOST');
          await options.prepareInstructions();
          if (closed) return;
          if (options.lease.owns() !== true) throw new Error('DSH_HOST_LEASE_LOST');
          await runner!.pass();
        }
      }).finally(() => { pumping = undefined; });
    }
    return pumping;
  };
  const wake = () => { void requestPass().catch(fail); };

  const plugin = {
    name: 'swarmboard-dsh-host',
    inject: ['agents', 'sessions'],
    apply(ctx: DshSdkPluginContext<S, M, A>): () => Promise<void> {
      // Dependency reload must not silently replay a failed start/resume.
      if (applied) throw new Error('DSH_PLUGIN_ALREADY_APPLIED');
      applied = true;
      startup = (async () => {
        if (options.lease.acquire() !== true) throw new Error('DSH_HOST_LEASE_REQUIRED');
        acquired = true;
        const facade = createDshSdkFacade({ sdk: ctx.agents, sdkSessionId: options.sdkSessionId,
          createOptions: options.createOptions, resumeOptions: options.resumeOptions });
        handles = facade.ownedHandles;
        const journals = createDshJournals<DeliveryBatch>({ db: options.db, sessionId: options.sessionRef });
        const lifecycle = new DshLifecycle({ sessionId: options.sessionRef, cwd: options.cwd,
          registry: facade.registry, journal: journals.lifecycle });
        let retained = ctx.agents.get(options.sdkSessionId(options.sessionRef));
        // Cleanup can arrive before connect(), while instruction preparation
        // awaits I/O. Check the original live object and any unresolved intent
        // from the beginning, rather than assuming this phase is quiescent.
        quiescent = () => {
          if (failed || journals.lifecycle.read() !== null) return false;
          const current = ctx.agents.get(options.sdkSessionId(options.sessionRef));
          if (current !== retained) return false;
          return !current || (current.id === options.sessionRef && current.session.id === options.sessionRef
            && current.session.header.cwd === options.cwd && current.status === 'idle' && !current.inbox.hasPending);
        };
        await options.prepareInstructions();
        if (closed) return;
        if (options.lease.owns() !== true) throw new Error('DSH_HOST_LEASE_LOST');
        const bound = await lifecycle.connect(options.mode);
        retained = ctx.agents.get(options.sdkSessionId(options.sessionRef));
        if (retained !== bound) throw new Error('DSH_SESSION_CONFLICT');
        if (closed) return;
        const sdkSession = createDshSdkSessionPort({ adapterId: options.adapterId, memberId: options.memberId,
          sessionRef: options.sessionRef, cwd: options.cwd,
          getAgent: id => ctx.agents.get(options.sdkSessionId(id)), messageId: options.messageId,
          isAuthorized: (batch, agent) => !closed && !failed && options.lease.owns() === true && options.isAuthorized(batch, agent) === true,
          flush: agent => ctx.sessions.flush(agent.session) });
        const session: SessionPort = { ...sdkSession,
          isCurrent: async batch => await options.pending.isCurrent(batch) === true && await sdkSession.isCurrent(batch) === true };
        runner = options.createRunner({ lease: options.lease, ports: { pending: options.pending, session, journal: journals.notification },
          canRelease: () => quiescent() });
        subscriptions.push(ctx.on('agent/status', ({ agent, status }) => {
          if (agent === bound && status === 'idle') wake();
        }));
        subscriptions.push(ctx.on('session/event', (session, event) => {
          if (session === bound.session && event.type === 'turn/end') wake();
        }));
        subscriptions.push(options.subscribeWake(wake));
        await requestPass();
      })();
      void startup.catch(fail);
      return () => {
        closed = true; queued = false;
        closing ??= (async () => {
          // Stop wake admission before waiting; keep the lease through every
          // in-flight SDK call/flush and initialization, including failures.
          for (const unsubscribe of subscriptions.splice(0).reverse()) unsubscribe();
          await startup!.catch(() => {});
          await pumping?.catch(() => {});
          if (runner) await runner.stop();
          else if (acquired) {
            if (quiescent() !== true) throw new Error('DSH_HOST_NOT_QUIESCENT');
            options.lease.release();
          }
        })().catch(error => { closing = undefined; throw error; });
        return closing;
      };
    },
  };
  return Object.freeze({ plugin,
    ready: () => startup ?? Promise.reject(new Error('DSH_PLUGIN_NOT_APPLIED')),
    /** Observe queued local work without starting a new pass. */
    async drain() { await startup?.catch(() => {}); await pumping?.catch(() => {}); },
    ownedHandles: () => handles(),
  });
}

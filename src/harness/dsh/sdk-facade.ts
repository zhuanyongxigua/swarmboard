// Preserve the official SDK's owned handles while exposing only bare agents to
// the lifecycle boundary. Importing this module never loads or starts an SDK.
import type { DshAgent, DshRegistryPort } from './lifecycle.js';

/** Structural public AgentHandle surface; the host remains the disposer owner. */
export interface DshSdkHandle<A extends DshAgent = DshAgent> {
  agent: A;
  dispose(): Promise<void>;
}

/** Matches the official AgentRegistry get/create/resume return shapes.
 * Extra options are opaque trusted SDK configuration, not task-provided data. */
export interface DshSdkRegistry<I extends string, A extends DshAgent> {
  get(sessionId: I): A | undefined;
  create(options: { sessionId: I; meta: { cwd: string }; [key: string]: unknown }): Promise<DshSdkHandle<A>>;
  resume(options: { resumeSessionId: I; [key: string]: unknown }): Promise<DshSdkHandle<A>>;
}

export interface DshSdkFacadeOptions<I extends string, A extends DshAgent> {
  sdk: DshSdkRegistry<I, A>;
  /** The official SessionId constructor, supplied alongside ctx.agents. */
  sdkSessionId(id: string): I;
  /** Explicit model/permission/setup/signal choices; no product policy defaults. */
  createOptions: Readonly<Record<string, unknown>>;
  resumeOptions: Readonly<Record<string, unknown>>;
}

function configuration(value: Readonly<Record<string, unknown>>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH_INVALID_SDK_CONFIG');
  // Identity and creation metadata belong exclusively to DshLifecycle. In
  // particular, a reused policy object cannot override cwd or resume another id.
  if (['sessionId', 'resumeSessionId', 'meta'].some(key => key in value)) {
    throw new Error('DSH_CONFIG_IDENTITY_OVERRIDE');
  }
  return Object.freeze({ ...value });
}

/** Compose with a current official ctx.agents object supplied by a trusted host.
 * A single facade should be shared by its lifecycle boundaries. The host must
 * hold its existing cross-process lease before connect and own the durable
 * journal. No SDK import, implicit start, notification, retry or disposal occurs.
 */
export function createDshSdkFacade<I extends string, A extends DshAgent>(options: DshSdkFacadeOptions<I, A>) {
  const createOptions = configuration(options.createOptions);
  const resumeOptions = configuration(options.resumeOptions);
  const sdk = options.sdk;
  const convert = options.sdkSessionId;
  const id = (value: string): I => {
    const result = convert(value);
    if (typeof result !== 'string' || result !== value) throw new Error('DSH_SDK_ID_CONFLICT');
    return result;
  };
  const handles = new Set<DshSdkHandle<A>>();
  const retain = (handle: DshSdkHandle<A>) => {
    // Retain before lifecycle validation. Even a conflicting returned agent has
    // an owned capability that must remain available for host reconciliation.
    handles.add(handle);
    return handle.agent;
  };
  const registry: DshRegistryPort = Object.freeze({
    get: (sessionId: string) => sdk.get(id(sessionId)),
    create: async ({ sessionId, meta }: { sessionId: string; meta: { cwd: string } }) =>
      retain(await sdk.create({ ...createOptions, sessionId: id(sessionId), meta: { cwd: meta.cwd } })),
    resume: async ({ resumeSessionId }: { resumeSessionId: string }) =>
      retain(await sdk.resume({ ...resumeOptions, resumeSessionId: id(resumeSessionId) })),
  });
  return Object.freeze({
    registry,
    /** Host-only ownership snapshot, including handles rejected by lifecycle.
     * Never dispose these merely because pause/detach or a notification failed. */
    ownedHandles: (): readonly DshSdkHandle<A>[] => Object.freeze([...handles]),
  });
}

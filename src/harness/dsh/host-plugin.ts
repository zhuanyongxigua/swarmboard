// Provide one trusted host entry that wires public MCP, ownership and the official SDK.
// The caller still owns SDK configuration, sidecar path, identity and existing wake sources.
import { createDshHostLease, type DshHostLease } from './host-lease.js';
import { createDshHostRunner } from './host-runner.js';
import { createDshNotificationPort, type DshNotificationPortOptions } from './notification-port.js';
import { createDshSdkPlugin, type DshSdkPluginOptions } from './sdk-plugin.js';
import type { DshSdkSessionAgent } from './sdk-session.js';

export type DshHostPluginOptions<S extends string, M extends string, A extends DshSdkSessionAgent<M>> =
  Omit<DshSdkPluginOptions<S, M, A>, 'lease' | 'pending' | 'createRunner'>
  & DshNotificationPortOptions
  & { /** Supply an existing equivalent host lease, or use the explicit sidecar DB. */ lease?: DshHostLease };

/** Construct an inert Cordis plugin; only the official host's ctx.plugin/apply
 * enables it. There is no CLI subprocess, scheduler, default model or session. */
export function createDshHostPlugin<S extends string, M extends string, A extends DshSdkSessionAgent<M>>(
  options: DshHostPluginOptions<S, M, A>,
) {
  const lease = options.lease ?? createDshHostLease(options);
  const pending = createDshNotificationPort(options);
  return createDshSdkPlugin({ ...options, lease, pending, createRunner: createDshHostRunner });
}

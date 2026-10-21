// Production assembly seam: the single place where harness backends are
// registered and configuration selects one. Both the desktop stdio service and
// the event daemon resolve through this module; an unknown backend fails loudly
// at startup instead of silently falling back to another backend's sessions.
import { AppError } from '../store.js';
import { codexBackend } from '../codex-session.js';
import { echoBackend } from './echo-backend.js';
import type { HarnessBackend } from './contract.js';

// A Map keeps configuration names from reaching Object.prototype members
// (e.g. 'constructor'), which a plain object lookup would silently accept.
const builtinBackends = new Map<string, HarnessBackend>([['codex', codexBackend], ['echo', echoBackend]]);
const backends = new Map<string, HarnessBackend>(builtinBackends);

/** Stable ids currently registered. It is refreshed in place on registration so
 *  startup diagnostics and environment resolution see adapters loaded by the
 *  trusted assembly module; the core never imports a vendor adapter. */
export const knownHarnesses: readonly string[] = [...backends.keys()];

function refreshKnownHarnesses() {
  (knownHarnesses as string[]).splice(0, knownHarnesses.length, ...backends.keys());
}

// Adapter ids are explicit configuration names, not arbitrary text: no leading
// separators/whitespace, bounded length, and prototype names are already
// rejected by the Map lookup. This is deliberately vendor-neutral.
const HARNESS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertBackend(backend: unknown): asserts backend is HarnessBackend {
  if (!backend || typeof backend !== 'object') throw new AppError('INVALID_HARNESS', 'Harness backend must be an object', 400);
  const candidate = backend as Partial<HarnessBackend>;
  if (typeof candidate.id !== 'string' || candidate.id !== candidate.id.trim() || !HARNESS_ID.test(candidate.id)) {
    throw new AppError('INVALID_HARNESS_ID', 'Harness backend id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', 400);
  }
  if (typeof candidate.displayName !== 'string' || !candidate.displayName.trim()) {
    throw new AppError('INVALID_HARNESS', 'Harness backend must declare a non-empty displayName', 400);
  }
  const caps = candidate.capabilities;
  if (!caps || typeof caps !== 'object' || typeof caps.inspection !== 'boolean' || typeof caps.approvalSignals !== 'boolean'
    || (caps.sessionInstructions !== undefined && typeof caps.sessionInstructions !== 'boolean')) {
    throw new AppError('INVALID_HARNESS', 'Harness backend capabilities must declare boolean inspection/approvalSignals (and optional sessionInstructions)', 400);
  }
  if (candidate.deterministic !== undefined && typeof candidate.deterministic !== 'boolean') {
    throw new AppError('INVALID_HARNESS', 'Harness backend deterministic must be boolean when present', 400);
  }
  if (typeof candidate.createSession !== 'function' || typeof candidate.sessionIntro !== 'function') {
    throw new AppError('INVALID_HARNESS', 'Harness backend must implement createSession and sessionIntro', 400);
  }
}

/**
 * Register a reusable harness adapter at the trusted assembly seam. Adapter
 * modules may call this from an explicit host-side composition entry; task text
 * and external content must never load modules. Built-ins remain available.
 */
export function registerHarnessBackend(backend: HarnessBackend, options: { replace?: boolean } = {}): HarnessBackend {
  assertBackend(backend);
  if (backends.has(backend.id) && !options.replace) {
    throw new AppError('HARNESS_ALREADY_REGISTERED', `Harness backend ${JSON.stringify(backend.id)} is already registered`, 409);
  }
  backends.set(backend.id, backend);
  refreshKnownHarnesses();
  return backend;
}

/** Remove a previously registered non-built-in adapter (explicit host config,
 *  tests or adapter unload). Built-ins cannot be removed, so configuration can
 *  always fall back to the official default. */
export function unregisterHarnessBackend(id: string): void {
  if (builtinBackends.has(id)) throw new AppError('HARNESS_BUILTIN', `Harness backend ${JSON.stringify(id)} is built in and cannot be unregistered`, 400);
  if (!backends.delete(id)) throw new AppError('UNKNOWN_HARNESS', `Harness backend ${JSON.stringify(id)} is not registered`, 404);
  refreshKnownHarnesses();
}

/** SWARMBOARD_HARNESS selects the session backend; unset means today's default
 *  (official Codex). A configured-but-unknown id is a startup error, never a
 *  silent fallback that could hand old session identifiers to a new backend. */
export function resolveHarness(env: NodeJS.ProcessEnv = process.env): HarnessBackend {
  const requested = env.SWARMBOARD_HARNESS?.trim() ?? '';
  const backend = backends.get(requested || 'codex');
  if (!backend) throw new AppError('UNKNOWN_HARNESS', `Unknown harness backend ${JSON.stringify(requested)}; available backends: ${knownHarnesses.join(', ')}`, 500);
  return backend;
}

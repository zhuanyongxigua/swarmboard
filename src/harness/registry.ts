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
const backends = new Map<string, HarnessBackend>([['codex', codexBackend], ['echo', echoBackend]]);
export const knownHarnesses: readonly string[] = [...backends.keys()];

/** SWARMBOARD_HARNESS selects the session backend; unset means today's default
 *  (official Codex). A configured-but-unknown id is a startup error, never a
 *  silent fallback that could hand old session identifiers to a new backend. */
export function resolveHarness(env: NodeJS.ProcessEnv = process.env): HarnessBackend {
  const requested = env.SWARMBOARD_HARNESS?.trim() ?? '';
  const backend = backends.get(requested || 'codex');
  if (!backend) throw new AppError('UNKNOWN_HARNESS', `Unknown harness backend ${JSON.stringify(requested)}; available backends: ${knownHarnesses.join(', ')}`, 500);
  return backend;
}

// Pair the shared neutral protocol with the adapter's actual formal identity.
// This describes a binding; it never creates a host grant or replaces current API checks.
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { workerProtocol } from '../../worker-prompt.js';

export function dshLaunchProtocol(input: { memberId: string; sessionRef: string; cwd: string; poolId: string; taskIds: readonly string[] }) {
  if (![input.memberId, input.sessionRef, input.poolId].every(value => typeof value === 'string' && /^[A-Za-z0-9_.:-]+$/.test(value))
    || !isAbsolute(input.cwd) || !Array.isArray(input.taskIds) || !input.taskIds.length
    || input.taskIds.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(value))) throw new Error('DSH_LAUNCH_INSTRUCTION_IDENTITY_REQUIRED');
  const identity = { memberId: input.memberId, sessionRef: input.sessionRef, cwd: input.cwd,
    poolId: input.poolId, taskIds: [...new Set(input.taskIds)].sort() };
  const text = [
    'You are the formally admitted Swarmboard member identified below. Keep this stable memberId for heartbeat and shared context; do not create a replacement identity.',
    JSON.stringify(identity),
    'This adapter identity and selected goal scope describe your current binding, not additional execution permission. Recheck formal task scope and current host grants before resource use. Preserve the original session and unknown results.',
    workerProtocol(),
  ].join('\n\n');
  return Object.freeze({ text, digest: createHash('sha256').update(text).digest('hex') });
}

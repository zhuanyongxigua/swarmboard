// Opt-in reference-quiet wake policy: ordinary peer evidence stays durable
// shared context without starting model turns. Eligibility uses only
// structured event fields (kind, agentId, detail JSON keys) — never prose.
import type { Entry } from './store.js';

export interface WakePolicyOptions { wakePolicy?: string }
export type WakePolicy = 'all' | 'reference-quiet';
export function wakePolicySettings(options: WakePolicyOptions, env: NodeJS.ProcessEnv = process.env): WakePolicy {
  const raw = (options.wakePolicy ?? env.SWARMBOARD_WAKE_POLICY ?? 'all').trim();
  if (raw === 'all' || raw === 'reference-quiet') return raw;
  throw new Error('Invalid wake policy configuration');
}
// Both prompt fields are board-scoped host data, never a synthetic task/resource.
export function boardPreferencesChanged(entry: Entry): boolean {
  const signal = entry.agentId === 'host-preferences' ? 'BOARD_PREFERENCES_UPDATED'
    : entry.agentId === 'host-user-prompt' ? 'BOARD_USER_PROMPT_UPDATED' : null;
  if (entry.kind !== 'OBSERVED' || !signal || entry.taskId || entry.resourceId || entry.recipientId) return false;
  try {
    const detail = JSON.parse(entry.detail);
    return detail?.signalId === signal && Number.isInteger(detail.version) && detail.version > 0
      && ['human-input', 'main-chat-relay'].includes(detail.source) && typeof detail.cleared === 'boolean';
  } catch { return false; }
}
// Human and board-system identities (liveness, CI evidence, host grants,
// organization scope signals) publish control observations, never routine
// peer evidence.
const controllingPrefixes = ['runtime-', 'host-', 'pool-events:'];
/** Whether an entry may start a model turn under reference-quiet. Explicit
 *  MESSAGE (direct or broadcast), FAIL handoffs, and goal/host/control
 *  observations always qualify; FACT/CLAIM/PATCH_SUMMARY evidence and peer
 *  progress/participation observations remain reference context. */
export function actionableWake(entry: Entry): boolean {
  if (entry.kind === 'MESSAGE' || entry.kind === 'FAIL') return true;
  if (entry.kind !== 'OBSERVED') return false;
  if (entry.agentId === 'human' || controllingPrefixes.some(prefix => entry.agentId.startsWith(prefix))) return true;
  try {
    const detail: unknown = JSON.parse(entry.detail);
    return typeof detail === 'object' && detail !== null && ('status' in detail || 'version' in detail);
  } catch { return false; }
}

// Trust the dedicated host identity and complete signal shape, never a peer
// lookalike or a notification scoped to another recipient.
import { expect, it } from 'vitest';
import { boardPreferencesChanged } from '../../src/wake-policy.js';
import type { Entry } from '../../src/store.js';
const entry = { id: 1, kind: 'OBSERVED', agentId: 'host-user-prompt', summary: 'User prompt updated', createdAt: '', detail: JSON.stringify({ signalId: 'BOARD_USER_PROMPT_UPDATED', version: 1, source: 'human-input', cleared: true }) } as Entry;
it('recognizes complete user prompt control signals while keeping identity and routing fences', () => {
  expect(boardPreferencesChanged(entry)).toBe(true);
  for (const patch of [{ agentId: 'ordinary-peer' }, { taskId: 'goal' }, { recipientId: 'other' }, { resourceId: 'resource' }, { kind: 'FACT' as const },
    { detail: JSON.stringify({ signalId: 'BOARD_PREFERENCES_UPDATED', version: 1, source: 'human-input', cleared: false }) },
    { detail: JSON.stringify({ signalId: 'BOARD_USER_PROMPT_UPDATED', version: 1, source: 'human-input' }) }]) expect(boardPreferencesChanged({ ...entry, ...patch })).toBe(false);
});

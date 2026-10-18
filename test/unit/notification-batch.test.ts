// Check notification latency independently of model execution or cooperation choices.
import { describe, expect, it } from 'vitest';
import { notificationDelay, notificationSettings } from '../../src/notification-batch.js';
import type { Entry } from '../../src/store.js';

const settings = { quietMs: 15000, maxWaitMs: 60000 };
const event = (at: number, patch: Partial<Entry> = {}): Entry => ({ id: 1, kind: 'FACT', agentId: 'peer', summary: 'Evidence', detail: '', createdAt: new Date(at).toISOString(), ...patch });
describe('bounded broadcast batching', () => {
  it('uses a quiet window without postponing a continuing conversation indefinitely', () => {
    expect(notificationDelay([event(1000)], settings, 1000)).toBe(15000);
    expect(notificationDelay([event(1000), event(12000)], settings, 15000)).toBe(12000);
    expect(notificationDelay([event(1000), event(60000)], settings, 60999)).toBe(1);
    expect(notificationDelay([event(1000), event(61000)], settings, 61000)).toBe(0);
  });
  it.each([
    { agentId: 'human', kind: 'OBSERVED' as const, taskId: 'goal' },
    { kind: 'FAIL' as const },
    { kind: 'MESSAGE' as const, recipientId: 'peer-2' },
    { kind: 'OBSERVED' as const, taskId: 'goal' },
  ])('immediately delivers critical or control events: %j', patch => {
    expect(notificationDelay([event(1000), event(1000, patch)], settings, 1000)).toBe(0);
  });
  it('bypasses delay for a bounded page backlog, invalid timestamps, clock rollback and disabled batching', () => {
    expect(notificationDelay([event(1000)], settings, 1000, true)).toBe(0);
    expect(notificationDelay([event(1000, { createdAt: 'unknown' })], settings, 1000)).toBe(0);
    expect(notificationDelay([event(1001)], settings, 1000)).toBe(0);
    expect(notificationDelay([event(1000)], { quietMs: 0, maxWaitMs: 60000 }, 1000)).toBe(0);
    expect(notificationDelay([], settings, 1000)).toBe(0);
  });
  it('validates reversible host configuration and defaults to 15s / 60s', () => {
    expect(notificationSettings({}, {})).toEqual(settings);
    expect(notificationSettings({}, { SWARMBOARD_NOTIFICATION_BATCH_MS: '0' })).toEqual({ ...settings, quietMs: 0 });
    expect(notificationSettings({ notificationBatchMs: 50, notificationMaxWaitMs: 100 }, {})).toEqual({ quietMs: 50, maxWaitMs: 100 });
    for (const value of ['-1', 'NaN', 'Infinity', '1.5', '60001', '']) expect(() => notificationSettings({}, { SWARMBOARD_NOTIFICATION_BATCH_MS: value })).toThrow(/notification/i);
    expect(() => notificationSettings({ notificationBatchMs: 100, notificationMaxWaitMs: 50 }, {})).toThrow(/notification/i);
  });
});

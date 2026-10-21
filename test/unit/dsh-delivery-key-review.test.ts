// Distinct legal delivery identities must not share a durable intent or suppress each other.
import { expect, it } from 'vitest';
import { driveOnce, intentKey, type DeliveryBatch, type Intent } from '../../src/harness/dsh/notification-driver.js';

const batch = (adapterId: string | undefined, sessionRef = 'session', id = 11): DeliveryBatch => ({
  ...(adapterId === undefined ? {} : { adapterId }), memberId: 'member', sessionRef,
  delivery: { sequence: 1, entryIds: [id] }, entries: [{ id, kind: 'MESSAGE', summary: 'Synthetic update' }],
});

it('distinguishes an absent adapter from an adapter literally named native', () => {
  expect(intentKey(batch(undefined))).not.toBe(intentKey(batch('native')));
});

it('distinguishes delimiters within legal adapter and session fields', () => {
  expect(intentKey(batch('channel|member', 'session'))).not.toBe(intentKey(batch('channel', 'member|session')));
});

it('does not let one unknown delivery suppress another channel with a colliding legacy spelling', async () => {
  const first = batch(undefined), second = batch('native', 'session', 12);
  const intents = new Map<string, Intent>();
  const submitted: DeliveryBatch[] = [];
  const confirmed: DeliveryBatch[] = [];
  await driveOnce({
    pending: { list: async () => [first, second], confirm: async value => { confirmed.push(value); },
      release: async () => { throw new Error('Unexpected release'); } },
    journal: { get: async key => intents.get(key), put: async value => { intents.set(value.key, structuredClone(value)); },
      del: async key => { intents.delete(key); } },
    session: { isCurrent: async () => true, isBusy: async () => false, settlement: async () => ({ settled: false }),
      submit: async value => { submitted.push(value); return value === first
        ? { status: 'unknown' } : { status: 'completed', turnId: 'synthetic-turn' }; } },
  });
  expect(submitted).toEqual([first, second]);
  expect(confirmed).toEqual([second]);
  expect(intents.get(intentKey(first))?.state).toBe('unknown');
});

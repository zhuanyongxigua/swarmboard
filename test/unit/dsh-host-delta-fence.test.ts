// A service-fence failure before a late delta send must retain prior completion evidence.
import { expect, it } from 'vitest';
import { driveOnce, type DeliveryBatch, type Intent } from '../../src/harness/dsh/notification-driver.js';

it('does not discard completed coverage when a late delta loses its committing fence', async () => {
  let ids = [1]; let current = true; let revoke = false;
  const records = new Map<string, Intent>(); const sent: number[][] = [];
  const batch = (): DeliveryBatch => ({ adapterId: 'channel', memberId: 'member', sessionRef: 'original',
    delivery: { sequence: 1, entryIds: ids }, entries: ids.map(id => ({ id, kind: 'MESSAGE', summary: `Work ${id}` })) });
  const ports = {
    pending: { list: async () => [batch()], confirm: async () => { throw new Error('STALE_DELIVERY_VIEW'); }, release: async () => {} },
    session: { isCurrent: async () => current, isBusy: async () => false, settlement: async () => ({ settled: false as const }),
      submit: async (value: DeliveryBatch) => { sent.push([...value.delivery.entryIds]); return { status: 'completed' as const, turnId: 'turn' }; } },
    journal: { get: async (key: string) => records.get(key), put: async (value: Intent) => {
      records.set(value.key, structuredClone(value)); if (revoke && value.state === 'submitting') current = false;
    }, del: async (key: string) => { records.delete(key); } },
  };
  await driveOnce(ports);
  ids = [1, 2]; revoke = true; await driveOnce(ports);
  revoke = false; current = true; await driveOnce(ports);
  expect(sent).toEqual([[1], [2]]);
});

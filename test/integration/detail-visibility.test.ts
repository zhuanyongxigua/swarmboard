// Independent probe (p2 7193): settling a delivery claims every entry was consumed, so the
// rendered text must carry each entry's payload — or say explicitly that it was truncated and
// where to read it. This test fails while the default text only carries a truncated summary.
import { describe, expect, it } from 'vitest';
import { defaultBatchText, type DeliveryBatch } from '../../src/harness/dsh/notification-driver.js';

const MARKER = 'UNIQUE-PAYLOAD-MARKER-42';
const batch: DeliveryBatch = {
  delivery: { sequence: 3, entryIds: [21] },
  memberId: 'member-1', sessionRef: 'thread-9',
  entries: [{
    id: 21, kind: 'MESSAGE', summary: 'A short summary',
    detail: JSON.stringify({ note: `payload ${MARKER}`, other: 'x'.repeat(600) }),
  }],
};

describe('delivery text carries the payload it settles', () => {
  it('mentions the entry detail (or states it was truncated and where to read it)', () => {
    const text = defaultBatchText(batch);
    const saysTruncated = /truncat|context_read|see the (full )?entry/i.test(text);
    expect(text.includes(MARKER) || saysTruncated).toBe(true);
  });
});

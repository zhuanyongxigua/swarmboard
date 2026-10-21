// Exercise host shutdown boundaries independently of the author's runner fixtures.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createDshHostLease } from '../../src/harness/dsh/host-lease.js';
import { createDshHostRunner } from '../../src/harness/dsh/host-runner.js';
import type { DshHostRunnerOptions } from '../../src/harness/dsh/host-runner.js';
import type { Intent } from '../../src/harness/dsh/notification-driver.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const identity = { memberId: 'review-member', sessionRef: 'review-original' };
  const lease = createDshHostLease({ db, ...identity });
  const other = createDshHostLease({ db, ...identity });
  const records = new Map<string, Intent>();
  const batch = { ...identity, delivery: { sequence: 1, entryIds: [1] },
    entries: [{ id: 1, kind: 'MESSAGE', summary: 'Synthetic review' }] };
  const ports: DshHostRunnerOptions['ports'] = {
    pending: { list: async () => [batch], confirm: async () => {}, release: async () => {} },
    session: { isCurrent: async () => true, isBusy: async () => false,
      submit: async () => ({ status: 'unknown' }), settlement: async () => ({ settled: false }) },
    journal: { get: async key => records.get(key), put: async intent => { records.set(intent.key, structuredClone(intent)); },
      del: async key => { records.delete(key); } },
  };
  return { db, lease, other, records, ports };
}

describe('independent host lease shutdown review', () => {
  it('holds ownership while submit/flush is pending and preserves unknown after shutdown', async () => {
    const f = fixture();
    let started!: () => void; let finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const flushing = new Promise<void>(resolve => { finish = resolve; });
    f.ports.session.submit = async () => { started(); await flushing; return { status: 'unknown' }; };
    const runner = createDshHostRunner({ lease: f.lease, ports: f.ports, canRelease: () => true });
    try {
      const pass = runner.pass(); await entered;
      let stopped = false;
      const stopping = runner.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false); expect(f.other.acquire()).toBe(false);
      finish(); await pass; await stopping;
      expect([...f.records.values()].map(intent => intent.state)).toEqual(['unknown']);
      expect(f.other.acquire()).toBe(true);
      f.lease.release(); expect(f.other.owns()).toBe(true);
    } finally { finish(); f.other.release(); f.db.close(); }
  });

  it('requires an explicit synchronous true before releasing ownership', async () => {
    const f = fixture(); f.lease.acquire();
    // JavaScript composition may accidentally supply an async predicate; a
    // Promise resolving false must never authorize a healthy writer handoff.
    const canRelease = (async () => false) as unknown as DshHostRunnerOptions['canRelease'];
    const runner = createDshHostRunner({ lease: f.lease, ports: f.ports, canRelease });
    try {
      await expect(runner.stop()).rejects.toThrow('DSH_HOST_NOT_QUIESCENT');
      expect(f.lease.owns()).toBe(true); expect(f.other.acquire()).toBe(false);
    } finally { f.lease.release(); f.other.release(); f.db.close(); }
  });
});

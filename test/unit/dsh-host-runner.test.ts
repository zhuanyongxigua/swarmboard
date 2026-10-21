// Verify exclusive host ownership and safe event-driven draining before SDK submission.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshHostLease } from '../../src/harness/dsh/host-lease.js';
import { createDshHostRunner } from '../../src/harness/dsh/host-runner.js';
import type { DeliveryBatch, Intent } from '../../src/harness/dsh/notification-driver.js';

const identity = { adapterId: 'synthetic', memberId: 'member', sessionRef: 'original' };
const batch: DeliveryBatch = { ...identity, delivery: { sequence: 1, entryIds: [1] },
  entries: [{ id: 1, kind: 'MESSAGE', summary: 'Useful work' }] };
function fixture() {
  const db = new DatabaseSync(':memory:');
  const lease = createDshHostLease({ db, ...identity });
  const records = new Map<string, Intent>();
  let submits = 0; let lists = 0; let quiescent = true;
  const ports = {
    pending: { list: async () => { lists++; return [batch]; }, confirm: async () => {}, release: async () => {} },
    session: { isCurrent: async () => true, isBusy: async () => false,
      submit: async () => { submits++; return { status: 'unknown' as const }; }, settlement: async () => ({ settled: false as const }) },
    journal: { get: async (key: string) => records.get(key), put: async (v: Intent) => { records.set(v.key, structuredClone(v)); },
      del: async (key: string) => { records.delete(key); } },
  };
  return { db, lease, ports, records, get submits() { return submits; }, get lists() { return lists; },
    runner: () => createDshHostRunner({ lease, ports, canRelease: () => quiescent }),
    busy: () => { quiescent = false; }, idle: () => { quiescent = true; } };
}

describe('DSH host ownership', () => {
  it('does not steal another owner and keeps distinct identity tuples separate', () => {
    const f = fixture(); const other = createDshHostLease({ db: f.db, ...identity });
    expect(f.lease.acquire()).toBe(true); expect(other.acquire()).toBe(false);
    expect(other.owns()).toBe(false); other.release(); expect(f.lease.owns()).toBe(true);
    const alias = createDshHostLease({ db: f.db, ...identity, adapterId: 'other', memberId: 'another-member' });
    expect(alias.acquire()).toBe(false);
    const separate = createDshHostLease({ db: f.db, ...identity, sessionRef: 'another' });
    expect(separate.acquire()).toBe(true); separate.release();
    f.lease.release(); expect(other.acquire()).toBe(true); other.release(); f.db.close();
  });
  it('retains a crashed process owner across SQLite reopen without timeout takeover', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-host-owner-')); const file = join(dir, 'host.sqlite');
    const source = new URL('../../src/harness/dsh/host-lease.ts', import.meta.url).href;
    const run = () => spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `import {DatabaseSync} from 'node:sqlite'; import {createDshHostLease} from ${JSON.stringify(source)};
      const db=new DatabaseSync(${JSON.stringify(file)});
      const lease=createDshHostLease({db,...${JSON.stringify(identity)}});
      process.stdout.write(JSON.stringify(lease.acquire())); db.close();`], { encoding: 'utf8' });
    try {
      const first = run(); expect(first.status).toBe(0); expect(first.stdout).toBe('true');
      const second = run(); expect(second.status).toBe(0); expect(second.stdout).toBe('false');
      const db = new DatabaseSync(file);
      expect(db.prepare('SELECT COUNT(*) AS n FROM dsh_host_owner').get()!.n).toBe(1); db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses unknown transaction state and preserves the caller transaction', () => {
    const f = fixture(); f.db.exec('BEGIN');
    expect(() => f.lease.acquire()).toThrow('DSH_HOST_OUTER_TRANSACTION');
    expect(f.db.isTransaction).toBe(true); f.db.exec('ROLLBACK');
    expect(f.lease.acquire()).toBe(true); f.lease.release(); f.db.close();
  });
  it('runs no notification read or model submission without exclusive ownership', async () => {
    const f = fixture(); const other = createDshHostLease({ db: f.db, ...identity }); other.acquire();
    await expect(f.runner().pass()).rejects.toThrow('DSH_HOST_OWNED');
    expect(f.lists).toBe(0); expect(f.submits).toBe(0); other.release(); f.db.close();
  });
  it('merges simultaneous event triggers and never replays an unknown intent', async () => {
    const f = fixture(); const runner = f.runner(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const list = f.ports.pending.list; let first = true;
    f.ports.pending.list = async () => { if (first) { first = false; await gate; } return list(); };
    const one = runner.pass(); const two = runner.pass(); release();
    await Promise.all([one, two]);
    expect(f.submits).toBe(1); expect(f.lists).toBe(2); expect(f.records.size).toBe(1);
    await runner.stop(); expect(f.lease.owns()).toBe(false); expect(f.records.size).toBe(1); f.db.close();
  });
  it('rechecks the lease after an asynchronous pending read', async () => {
    const f = fixture(); const runner = f.runner();
    f.ports.pending.list = async () => { f.lease.release(); return [batch]; };
    await expect(runner.pass()).rejects.toThrow('DSH_HOST_LEASE_LOST');
    expect(f.submits).toBe(0); expect(f.records.size).toBe(0); f.db.close();
  });
  it('does not release a host while the official session is still busy', async () => {
    const f = fixture(); const runner = f.runner(); await runner.pass(); f.busy();
    await expect(runner.stop()).rejects.toThrow('DSH_HOST_NOT_QUIESCENT'); expect(f.lease.owns()).toBe(true);
    await expect(runner.pass()).rejects.toThrow('DSH_HOST_STOPPING');
    f.idle(); await runner.stop(); expect(f.lease.owns()).toBe(false); expect(f.records.size).toBe(1); f.db.close();
  });
});

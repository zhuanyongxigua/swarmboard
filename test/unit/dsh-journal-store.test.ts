import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDshJournals } from '../../src/harness/dsh/journal-store.js';
import type { DshNotificationIntent } from '../../src/harness/dsh/journal-store.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-dsh-journal-'));
  const path = join(dir, 'journal.sqlite');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let db = new DatabaseSync(path);
  cleanups.push(() => { try { db.close(); } catch { /* already closed */ } });
  const open = () => createDshJournals<{ marker: string }>({ db, sessionId: 'session-a' });
  return { dir, path, open, get db() { return db; }, reopen: () => { db.close(); db = new DatabaseSync(path); return open(); } };
}

const intent = (key = 'adapter|member-a|session-a|1'): DshNotificationIntent<{ marker: string }> => ({
  key, state: 'unknown', batch: { marker: 'same snapshot' }, detail: 'inconclusive send',
});

describe('durable DSH host journal', () => {
  it('persists lifecycle and notification intents independently across reopen', () => {
    const f = fixture();
    const first = f.open();
    first.lifecycle.write({ operation: 'resume', sessionId: 'session-a', cwd: '/synthetic/workspace' });
    return first.notification.put(intent()).then(async () => {
      const reopened = f.reopen();
      expect(reopened.lifecycle.read()).toEqual({ operation: 'resume', sessionId: 'session-a', cwd: '/synthetic/workspace' });
      expect(await reopened.notification.get(intent().key)).toEqual(intent());
      expect(await reopened.notification.get('adapter|member-b|session-a|1')).toBeUndefined();
      await reopened.notification.del(intent().key);
      expect(await reopened.notification.get(intent().key)).toBeUndefined();
      expect(reopened.lifecycle.read()).not.toBeNull();
      reopened.lifecycle.write(null);
      expect(reopened.lifecycle.read()).toBeNull();
    });
  });

  it('keeps unknown/receipt-only snapshots and validates bad records instead of dropping them', async () => {
    const f = fixture();
    const journals = f.open();
    const unknown = { ...intent('native|member-a|session-a|7'), state: 'unknown' as const, batch: { marker: 'must stay' } };
    await journals.notification.put(unknown);
    await journals.notification.put({ ...unknown, key: 'native|member-a|session-a|8', state: 'completedUnacked' });
    const reopened = f.reopen();
    expect(await reopened.notification.get(unknown.key)).toEqual(unknown);
    expect((await reopened.notification.get('native|member-a|session-a|8'))?.state).toBe('completedUnacked');

    await expect(reopened.notification.put({ ...unknown, key: ' ' })).rejects.toThrow(/DSH_JOURNAL_INVALID/);
    await expect(reopened.notification.put({ ...unknown, state: 'bogus' as never })).rejects.toThrow(/DSH_JOURNAL_INVALID/);
    expect(() => reopened.lifecycle.write({ operation: 'start', sessionId: 'other', cwd: '/synthetic' })).toThrow(/DSH_JOURNAL_INVALID/);
    reopened.lifecycle.write({ operation: 'start', sessionId: 'session-a', cwd: '/synthetic/workspace' });
    f.db.prepare('UPDATE dsh_host_journal SET data=? WHERE slot=?').run('{', 'notification:' + unknown.key);
    await expect(reopened.notification.get(unknown.key)).rejects.toThrow(/DSH_JOURNAL_CORRUPT/);
  });
});


describe('journal durability fences (p3 review)', () => {
  it('rejects writes inside an outer transaction instead of deferring durability', async () => {
    const f = fixture(); const j = f.open();
    f.db.exec('BEGIN');
    expect(() => j.lifecycle.write({ operation: 'start', sessionId: 'session-a', cwd: '/synthetic/workspace' })).toThrow(/OUTER_TRANSACTION/);
    await expect(j.notification.put(intent())).rejects.toThrow(/OUTER_TRANSACTION/);
    await expect(j.notification.del(intent().key)).rejects.toThrow(/OUTER_TRANSACTION/);
    f.db.exec('ROLLBACK');
    expect(j.lifecycle.read()).toBeNull();
    await expect(j.notification.get(intent().key)).resolves.toBeUndefined();
  });

  it('rejects an unknown/omitted transaction view instead of assuming autocommit', () => {
    const f = fixture();
    const wrapper = { exec: (sql: string) => f.db.exec(sql), prepare: (sql: string) => f.db.prepare(sql) } as never;
    const j = createDshJournals({ db: wrapper, sessionId: 'session-a' });
    expect(() => j.lifecycle.write({ operation: 'start', sessionId: 'session-a', cwd: '/synthetic/workspace' })).toThrow(/OUTER_TRANSACTION/);
  });

  it('treats non-text stored data as corruption, never as a missing intent', async () => {
    const f = fixture(); const j = f.open();
    j.lifecycle.write({ operation: 'resume', sessionId: 'session-a', cwd: '/synthetic/workspace' });
    f.db.prepare('UPDATE dsh_host_journal SET data=? WHERE slot=?').run(Buffer.from('not-json'), 'lifecycle:session-a');
    expect(() => j.lifecycle.read()).toThrow(/DSH_JOURNAL_CORRUPT/);
    await j.notification.put(intent());
    f.db.prepare('UPDATE dsh_host_journal SET data=? WHERE slot=?').run(Buffer.from('not-json'), 'notification:' + intent().key);
    await expect(j.notification.get(intent().key)).rejects.toThrow(/DSH_JOURNAL_CORRUPT/);
    const row = f.db.prepare('SELECT data FROM dsh_host_journal WHERE slot=?').get('notification:' + intent().key) as { data: Uint8Array };
    expect(row.data).toBeInstanceOf(Uint8Array);
  });
});

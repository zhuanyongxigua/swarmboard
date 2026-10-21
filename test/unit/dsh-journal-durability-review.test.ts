import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createDshJournals } from '../../src/harness/dsh/journal-store.js';

describe('independent DSH journal durability review', () => {
  it('does not return a durable lifecycle success inside an uncommitted host transaction', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journals = createDshJournals({ db, sessionId: 'synthetic-session' });
      db.exec('BEGIN');
      expect(() => journals.lifecycle.write({ operation: 'resume', sessionId: 'synthetic-session', cwd: '/synthetic/workspace' }))
        .toThrow();
    } finally { db.close(); }
  });

  it('fails closed on an existing SQLite BLOB lifecycle row instead of treating intent as absent', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journals = createDshJournals({ db, sessionId: 'synthetic-session' });
      db.prepare('INSERT INTO dsh_host_journal(slot,data) VALUES(?,?)')
        .run('lifecycle:synthetic-session', new Uint8Array([123]));
      expect(() => journals.lifecycle.read()).toThrow(/DSH_JOURNAL_CORRUPT/);
    } finally { db.close(); }
  });
});

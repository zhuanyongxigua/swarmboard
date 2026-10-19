// Verify durable AI choices against current, source-bound runtime facts.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { WorkerStore } from '../../src/worker-store.js';
import { overviewFacts, readOverview, writeOverview, type OverviewSource } from '../../src/overview.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const source = (): OverviewSource => ({ owner: { pid: process.pid }, workers: [
  { id: 'a', backendId: 'codex', threadId: 'same', enabled: true, status: 'running', deliveryPhase: 'running', turnId: 't' },
  { id: 'duplicate', backendId: 'codex', threadId: 'same', enabled: true, status: 'running', deliveryPhase: 'running', turnId: 't' },
  { id: 'b', enabled: true, status: 'uncertain', threadId: null },
  { id: 'c', enabled: false, status: 'idle', retirement: { state: 'retired' } },
], collaborators: [
  { id: 'x', harness: 'dsh', sessionRef: 's', enabled: true, revokedAt: null },
  { id: 'alias', harness: 'dsh', sessionRef: 's', enabled: true, revokedAt: null },
  { id: 'planned', harness: 'zcode', sessionRef: '', enabled: true, revokedAt: null },
  { id: 'gone', harness: 'dsh', sessionRef: 'old', enabled: false, revokedAt: 'synthetic' },
] });
const open = (path = ':memory:') => { const s = new Store(path); cleanups.push(() => s.close()); return s; };
const draft = (s: Store, state: OverviewSource, expectedVersion = 0) => ({ expectedVersion,
  factsRevision: overviewFacts(state).revision, preferencesVersion: s.readPreferences().version,
  parts: [{ kind: 'text', text: 'Recorded native members: ' }, { kind: 'fact', factId: 'native.members' }] });

it('deduplicates sessions without counting admissions or unknown turns as execution or model evidence', () => {
  const facts = overviewFacts(source());
  const value = (id: string) => facts.items.find(f => f.id === id)?.value;
  expect(value('native.members')).toBe(2); expect(value('native.running')).toBe(1);
  expect(value('native.uncertain')).toBe(1); expect(value('external.admitted')).toBe(2);
  expect(value('external.sessions')).toBe(1); expect(value('external.running')).toBeNull();
  expect(value('organization.total')).toBeNull(); expect(value('native.model')).toBeNull();
  expect(JSON.stringify(facts)).not.toContain('same');
  const dead = source(); dead.owner = null;
  expect(overviewFacts(dead).items.find(f => f.id === 'native.running')?.value).toBeNull();
});

it('persists choices and actor, uses CAS across connections, and clears without waking board events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overview-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'board.sqlite'), s = open(path), state = source();
  const before = s.board().cursor;
  const first = writeOverview(s, draft(s, state), 'bound-worker', state, 1000);
  expect(first.status).toBe('current'); expect(first.record).toMatchObject({ version: 1, authorId: 'bound-worker' });
  const second = open(path);
  expect(readOverview(second, state, 1001).record).toEqual(first.record);
  expect(() => writeOverview(second, draft(s, state), 'other', state, 1002)).toThrow(/State changed/);
  const cleared = writeOverview(second, { ...draft(s, state, 1), parts: [] }, 'other', state, 1003);
  expect(cleared).toMatchObject({ status: 'missing', record: { version: 2, parts: [] } });
  expect(s.board().cursor).toBe(before);
});

it('invalidates facts, preferences, runtime restart and expiry on reads and rejects stale writes', () => {
  const s = open(), state = source();
  writeOverview(s, { ...draft(s, state), ttlSeconds: 1 }, 'bound', state, 1000);
  expect(readOverview(s, state, 2000).status).toBe('stale');
  const changed = source(); changed.workers![0]!.status = 'idle';
  expect(readOverview(s, changed, 1001).status).toBe('stale');
  const restart = source(); restart.owner = { pid: process.pid + 1000000 };
  expect(readOverview(s, restart, 1001).status).toBe('stale');
  const samePidRestart = source(); samePidRestart.ownerEpoch = 'new-owner';
  expect(readOverview(s, samePidRestart, 1001).status).toBe('stale');
  expect(readOverview(s, undefined, 1001).status).toBe('unavailable');
  expect(() => writeOverview(s, draft(s, state, 1), 'bound', changed)).toThrow(/facts/);
  s.writePreferences({ expectedVersion: 0, text: 'Different display choices', source: 'human-input' });
  expect(readOverview(s, state, 1001).status).toBe('stale');
});

it('retains AI choices for a compact reader while refreshing changed facts and keeping unavailable values unknown', () => {
  const s = open(), state = source(), cursor = s.board().cursor;
  const first = writeOverview(s, { ...draft(s, state), ttlSeconds: 1,
    parts: [{ kind: 'text', text: 'Some native work is in progress' }, { kind: 'fact', factId: 'native.running' }] }, 'bound', state, 1000);
  const changed = source();
  for (const worker of changed.workers!.filter(worker => worker.threadId === 'same')) {
    worker.status = 'idle'; worker.turnId = null; worker.deliveryPhase = undefined;
  }
  const currentRead = readOverview(s, changed, 1001);
  expect(currentRead).toMatchObject({ status: 'stale', reason: 'FACTS_CHANGED', record: first.record });
  expect(currentRead.facts.items.find(fact => fact.id === 'native.running')?.value).toBe(0);
  expect(first.facts.items.find(fact => fact.id === 'native.running')?.value).toBe(1);
  expect(currentRead.facts.observedAt).toBe(new Date(1001).toISOString());
  expect(currentRead.facts.revision).not.toBe(first.facts.revision);
  expect(currentRead.record?.factSnapshot).toEqual([first.facts.items.find(fact => fact.id === 'native.running')]);
  expect(currentRead.record?.factSnapshot?.[0]?.value).toBe(1);
  expect(readOverview(s, state, 2000)).toMatchObject({ status: 'stale', reason: 'EXPIRED', record: first.record });
  const unavailable = readOverview(s, undefined, 2001);
  expect(unavailable).toMatchObject({ status: 'unavailable', facts: { available: false }, record: first.record });
  expect(unavailable.facts.items.find(fact => fact.id === 'native.running')?.value).toBeNull();
  expect(s.readOverviewRecord()).toEqual(first.record);
  expect(s.board().cursor).toBe(cursor);
});

it('rejects fabricated fact references, numeric prose and unbounded or invalid expiry input', () => {
  const s = open(), state = source();
  for (const extra of [ { parts: [{ kind: 'fact', factId: 'fake.model' }] }, { parts: [{ kind: 'text', text: '14 active GLM-5.3' }] },
    { ttlSeconds: 901 }, { ttlSeconds: 0 }, { authorId: 'spoof' }, { factSnapshot: [{ id: 'native.running', value: 100 }] } ]) {
    expect(() => writeOverview(s, { ...draft(s, state), ...extra }, 'bound', state)).toThrow();
  }
  const literal = writeOverview(s, { ...draft(s, state), parts: [{ kind: 'text', text: '<script>alert()</script>' }] }, 'bound', state);
  expect(literal.record?.parts).toEqual([{ kind: 'text', text: '<script>alert()</script>' }]);
});

it('captures only selected verified values once, including unknown, and leaves legacy records without invented history', () => {
  const s = open(), state = source();
  const first = writeOverview(s, { ...draft(s, state), parts: [
    { kind: 'fact', factId: 'native.running' }, { kind: 'fact', factId: 'native.running' }, { kind: 'fact', factId: 'external.model' },
  ] }, 'bound', state, 1000);
  expect(first.record?.factSnapshot).toHaveLength(2);
  expect(first.record?.factSnapshot?.find(fact => fact.id === 'native.running')?.value).toBe(1);
  expect(first.record?.factSnapshot?.find(fact => fact.id === 'external.model')?.value).toBeNull();
  expect(first.record?.factSnapshot?.some(fact => fact.id === 'external.admitted')).toBe(false);
  const legacy = { ...first.record!, factSnapshot: undefined };
  s.saveOverviewRecord(legacy, 1);
  const read = readOverview(s, state, 301001);
  expect(read.status).toBe('stale');
  expect(read.record).not.toHaveProperty('factSnapshot');
  expect(read.record?.parts).toEqual(first.record?.parts);
  expect(s.db.prepare('PRAGMA user_version').get()!.user_version).toBe(9);
});

it('appends schema nine to a real schema eight database without changing prior rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overview-upgrade-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'board.sqlite'), s = open(path);
  const task = s.createTask({ title: 'Retained' });
  s.db.exec('DROP TABLE board_overview; PRAGMA user_version=8;');
  const upgraded = open(path);
  expect(upgraded.readTask(task.id)).toEqual(task);
  expect(upgraded.db.prepare('PRAGMA user_version').get()!.user_version).toBe(9);
  expect(readOverview(upgraded, source()).status).toBe('missing');
});

it('invalidates a same-pid ownership change without exposing the owner token', () => {
  const workers = new WorkerStore(':memory:'); cleanups.push(() => workers.close());
  expect(workers.ownerEpoch()).toBeNull();
  workers.acquire('synthetic-first-owner', process.pid);
  const first = workers.ownerEpoch();
  expect(first).not.toContain('synthetic');
  workers.release('synthetic-first-owner'); workers.acquire('synthetic-next-owner', process.pid);
  expect(workers.ownerEpoch()).not.toBe(first);
});

it('rolls back the new migration when its target conflicts without mutating legacy data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overview-rollback-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'board.sqlite'), s = open(path);
  const task = s.createTask({ title: 'Retained rollback goal' });
  s.db.exec('DROP TABLE board_overview; CREATE VIEW board_overview AS SELECT id FROM tasks; PRAGMA user_version=8;');
  expect(() => new Store(path)).toThrow(/already exists/);
  expect(s.db.prepare('PRAGMA user_version').get()!.user_version).toBe(8);
  expect(s.readTask(task.id)).toEqual(task);
});

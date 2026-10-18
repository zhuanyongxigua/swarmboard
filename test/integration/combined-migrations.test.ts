import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../../src/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'combined-upgrade-')); dirs.push(dir); return join(dir, 'board.sqlite'); };
const schema = (db: DatabaseSync) => db.prepare('PRAGMA user_version').get()!.user_version;
const dropFence = 'DROP TRIGGER usage_admission_insert; DROP TRIGGER usage_admission_update; DROP TABLE resource_admission_fences;';
const oldRows = (db: DatabaseSync) => Object.fromEntries(['agents', 'tasks', 'task_participants', 'resources', 'usages', 'entries', 'automation_config', 'automation_bindings'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const report = { percent: 70, state: 'active', phase: 'Synthetic verification', verified: 'Synthetic checks', remaining: 'Independent review' };

it('creates all three features and preserves independent versions and a closed fence after reopen', () => {
  const path = file(), store = new Store(path);
  const actor = store.registerAgent({ name: 'Synthetic member' });
  const task = store.createTask({ title: 'Synthetic goal' });
  const claimed = store.claimTask(task.id, { agentId: actor.id, expectedVersion: task.version });
  const preference = store.writePreferences({ text: 'Synthetic user data', source: 'human-input', expectedVersion: 0 });
  const progress = store.writeTaskProgress(task.id, { expectedVersion: claimed.version, agentId: actor.id, progress: report });
  expect(store.closeResourceAdmission(actor.id)).toBe(true);
  const resource = store.createResource({ name: 'Synthetic resource' });
  expect(schema(store.db)).toBe(8);
  store.close();
  const next = new Store(path);
  try {
    expect(next.readPreferences()).toEqual(preference);
    expect(next.readTask(task.id)).toEqual(progress);
    expect(() => next.declareUsage({ resourceId: resource.id, agentId: actor.id, purpose: 'Late declaration' })).toThrowError(expect.objectContaining({ code: 'MEMBER_RETIRED' }));
    expect(() => next.writePreferences({ text: 'Stale', source: 'human-input', expectedVersion: 0 })).toThrow(/State changed/);
    expect(() => next.writeTaskProgress(task.id, { expectedVersion: claimed.version, progress: report })).toThrow(/State changed/);
  } finally { next.close(); }
});

it('upgrades the actual v5 table layout without changing legacy rows or board identity', () => {
  const path = file(), store = new Store(path);
  const actor = store.registerAgent({ name: 'Retained member' });
  const task = store.createTask({ title: 'Retained goal' });
  store.claimTask(task.id, { agentId: actor.id, expectedVersion: task.version });
  const resource = store.createResource({ name: 'Retained resource', kind: 'legacy', accessNotes: 'Retain' });
  store.declareUsage({ resourceId: resource.id, agentId: actor.id, purpose: 'Retained usage' });
  const rows = oldRows(store.db), boardId = store.readAutomation().boardId;
  store.db.exec(`${dropFence} DROP TABLE board_preferences; DROP TABLE task_progress; PRAGMA user_version=5;`);
  store.close();
  const next = new Store(path);
  try {
    expect(schema(next.db)).toBe(8);
    expect(oldRows(next.db)).toEqual(rows);
    expect(next.readPreferences()).toMatchObject({ boardId, version: 0, text: '' });
    expect(next.readTask(task.id).progress).toBeNull();
    expect(next.closeResourceAdmission(actor.id)).toBe(false);
  } finally { next.close(); }
});

it('supports the declared preference v6 then progress v7 upgrade sequence without replacing data', () => {
  const path = file(), store = new Store(path);
  const task = store.createTask({ title: 'Retained goal' });
  const preference = store.writePreferences({ text: 'Retained preference', source: 'main-chat-relay', expectedVersion: 0 });
  store.db.exec(`${dropFence} DROP TABLE task_progress; PRAGMA user_version=6;`); store.close();
  const fromSix = new Store(path);
  expect(fromSix.readPreferences()).toEqual(preference);
  const progress = fromSix.writeTaskProgress(task.id, { expectedVersion: task.version, progress: report });
  fromSix.db.exec(`${dropFence} PRAGMA user_version=7;`); fromSix.close();
  const fromSeven = new Store(path);
  try {
    expect(schema(fromSeven.db)).toBe(8);
    expect(fromSeven.readPreferences()).toEqual(preference);
    expect(fromSeven.readTask(task.id)).toEqual(progress);
  } finally { fromSeven.close(); }
});

it.each(['progress', 'retirement'])('rejects the unpublished standalone %s v6 rather than guessing its meaning', variant => {
  const path = file(), store = new Store(path);
  store.db.exec('DROP TABLE board_preferences;');
  if (variant === 'progress') store.db.exec(dropFence);
  else store.db.exec('DROP TABLE task_progress;');
  store.db.exec('PRAGMA user_version=6;'); store.close();
  expect(() => new Store(path)).toThrowError(expect.objectContaining({ code: 'SCHEMA_VARIANT_MISMATCH' }));
  const db = new DatabaseSync(path);
  try {
    expect(schema(db)).toBe(6);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='board_preferences'").all()).toEqual([]);
  } finally { db.close(); }
});

it('rolls the complete upgrade back when a later migration fails', () => {
  const path = file(), store = new Store(path);
  store.db.exec(`${dropFence} DROP TABLE board_preferences; DROP TABLE task_progress; CREATE VIEW task_progress AS SELECT id AS taskId FROM tasks; PRAGMA user_version=5;`);
  const rows = oldRows(store.db); store.close();
  expect(() => new Store(path)).toThrow(/already exists/);
  const db = new DatabaseSync(path);
  try {
    expect(schema(db)).toBe(5);
    expect(oldRows(db)).toEqual(rows);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='board_preferences'").all()).toEqual([]);
  } finally { db.close(); }
});

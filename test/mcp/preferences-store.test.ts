import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';

const dirs: string[] = [];
const stores: Store[] = [];
const open = (path = ':memory:') => { const store = new Store(path); stores.push(store); return store; };
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'preferences-store-')); dirs.push(dir); return join(dir, 'board.sqlite'); };
const edit = { text: 'Synthetic preference', source: 'human-input' as const, expectedVersion: 0 };
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('board preferences persistence', () => {
  it('starts empty and returns the same board-local current value in both snapshots', () => {
    const store = open();
    const current = store.readPreferences();
    expect(current).toEqual({ boardId: store.readAutomation().boardId, text: '', version: 0, source: null, updatedAt: null });
    expect(store.board().preferences).toEqual(current);
    expect(store.peerBoard().preferences).toEqual(current);
  });

  it('persists human/relay provenance and a clear tombstone across reopen without reviving stale drafts', () => {
    const path = file(); let store = new Store(path);
    const first = store.writePreferences(edit);
    expect(first).toMatchObject({ text: edit.text, version: 1, source: edit.source });
    const other = open(path);
    expect(other.readPreferences()).toEqual(first);
    expect(() => other.writePreferences({ ...edit, text: 'Stale' })).toThrow(/State changed/);
    const cleared = other.writePreferences({ text: '', source: 'main-chat-relay', expectedVersion: 1 });
    expect(cleared).toMatchObject({ text: '', version: 2, source: 'main-chat-relay' });
    store.close(); store = open(path);
    expect(store.readPreferences()).toEqual(cleared);
    expect(() => store.writePreferences(edit)).toThrow(/State changed/);
    expect(() => store.writePreferences({ ...edit, expectedVersion: 1 })).toThrow(/State changed/);
  });

  it('commits revision metadata without duplicating preference text into shared history', () => {
    const store = open();
    const written = store.writePreferences(edit);
    const event = store.board().entries.at(-1)!;
    expect(event).toMatchObject({ kind: 'OBSERVED', agentId: 'host-preferences' });
    expect(JSON.parse(event.detail)).toEqual({ signalId: 'BOARD_PREFERENCES_UPDATED', version: written.version, source: edit.source, cleared: false });
    expect(event).not.toHaveProperty('taskId');
    expect(JSON.stringify(event)).not.toContain(edit.text);
    const cursor = store.board().cursor;
    store.db.exec("CREATE TEMP TRIGGER reject_preference_event BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'preference-event-failure'); END");
    expect(() => store.writePreferences({ ...edit, text: 'Must roll back', expectedVersion: 1 })).toThrow(/preference-event-failure/);
    expect(store.readPreferences()).toEqual(written);
    expect(store.board().cursor).toBe(cursor);
  });

  it('upgrades a v5 fixture without changing legacy resources, declarations, history or board identity', () => {
    const path = file(); const store = new Store(path);
    const agent = store.registerAgent({ name: 'Synthetic reviewer' });
    const resource = store.createResource({ name: 'Preserved resource', kind: 'legacy', capabilities: ['read'], accessNotes: 'Keep notes' });
    const task = store.createTask({ title: 'Synthetic goal' });
    store.declareUsage({ agentId: agent.id, taskId: task.id, resourceId: resource.id, purpose: 'Compatibility check' });
    const before = store.board(); const boardId = store.readAutomation().boardId;
    store.db.exec('DROP TRIGGER usage_admission_insert; DROP TRIGGER usage_admission_update; DROP TABLE resource_admission_fences; DROP TABLE task_progress; DROP TABLE board_overview; DROP TABLE board_preferences; PRAGMA user_version=5;'); store.close();
    const reopened = open(path);
    expect(reopened.board().resources).toEqual(before.resources);
    expect(reopened.board().usages).toEqual(before.usages);
    expect(reopened.board().entries).toEqual(before.entries);
    expect(reopened.readPreferences()).toMatchObject({ boardId, text: '', version: 0 });
    expect(reopened.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 });
  });

  it('rejects invalid input and untrusted actor fields without state or history changes', () => {
    const store = open(); const before = store.board();
    for (const input of [ { ...edit, source: 'agent' }, { ...edit, agentId: 'human' }, { ...edit, expectedVersion: -1 }, { ...edit, text: 'x'.repeat(20001) } ]) {
      expect(() => store.writePreferences(input)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    }
    expect(store.board()).toEqual(before);
  });
});

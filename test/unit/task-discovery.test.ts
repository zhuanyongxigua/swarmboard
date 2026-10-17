// Exercise bounded goal discovery with long human requirements and concurrent
// changes, rather than assuming a small full-board response scales to many goals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store.js';
let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); vi.restoreAllMocks(); });
describe('bounded human goal discovery', () => {
  it('discovers every goal across pages without copying full requirements', () => {
    const goals = Array.from({ length: 200 }, (_, i) => store.createTask({ title: `Goal ${i}`, description: '甲'.repeat(20000), acceptanceCriteria: '乙'.repeat(20000) }));
    const seen: string[] = []; let after;
    do {
      const page = store.readTasks({ limit: 17, after });
      expect(page.items.length).toBeLessThanOrEqual(17);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(15000);
      for (const item of page.items) { expect(item).not.toHaveProperty('description'); expect(item).not.toHaveProperty('acceptanceCriteria'); }
      seen.push(...page.items.map(t => t.id)); after = page.hasMore ? page.cursor : undefined;
    } while (after);
    expect(new Set(seen).size).toBe(200); expect(seen.sort()).toEqual(goals.map(t => t.id).sort());
    expect(store.board().tasks[0]!.description).toHaveLength(20000);
  });
  it('uses a stable keyset while goals change and new goals arrive, with explicit filters', () => {
    const goals = Array.from({ length: 7 }, (_, i) => store.createTask({ title: `Goal ${i}` }));
    // Equal creation times must still have a deterministic tie breaker.
    store.db.exec("UPDATE tasks SET createdAt='2026-01-01T00:00:00.000Z'");
    const first = store.readTasks({ limit: 3 });
    store.updateTask(first.items[0]!.id, { expectedVersion: 1, title: 'Changed while paging' });
    const clock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2025-01-01T00:00:00.000Z');
    const late = store.createTask({ title: 'New goal while paging' }); clock.mockRestore();
    const rest = store.readTasks({ after: first.cursor, limit: 50 });
    const ids = [...first.items, ...rest.items].map(t => t.id);
    expect(new Set(ids).size).toBe(8); expect(ids).toContain(late.id);
    store.updateTask(goals[0]!.id, { expectedVersion: store.readTask(goals[0]!.id).version, status: 'done' });
    expect(store.readTasks({}).items).toHaveLength(7);
    expect(store.readTasks({ statuses: ['done'] }).items.map(t => t.id)).toEqual([goals[0]!.id]);
    expect(store.readTasks({ query: 'paging', statuses: ['todo', 'done'] }).items).toHaveLength(2);
    expect(store.readTasks({ query: "' OR 1=1 --" }).items).toHaveLength(0);
    expect(store.readTasks({}, [late.id]).items.map(t => t.id)).toEqual([late.id]);
    expect(() => store.readTasks({ limit: 51 })).toThrow();
    expect(() => store.readTasks({ after: -1 })).toThrow();
  });
  it('reads full requirements by bounded text pages and detects revisions between pages', () => {
    const goal = store.createTask({ title: 'Long goal', description: '甲'.repeat(20000), acceptanceCriteria: '乙'.repeat(12001) });
    let description = '', acceptanceCriteria = '', offset = 0;
    for (;;) {
      const page = store.readTaskPage({ id: goal.id, offset, limit: 3000, expectedVersion: 1 });
      description += page.description; acceptanceCriteria += page.acceptanceCriteria;
      expect(page.description.length).toBeLessThanOrEqual(3000); expect(page.acceptanceCriteria.length).toBeLessThanOrEqual(3000);
      if (!page.textPage.hasMore) break;
      offset = page.textPage.nextOffset;
    }
    expect(description).toBe(goal.description); expect(acceptanceCriteria).toBe(goal.acceptanceCriteria);
    store.updateTask(goal.id, { expectedVersion: 1, description: 'Revised' });
    expect(() => store.readTaskPage({ id: goal.id, offset: 3000, expectedVersion: 1 })).toThrow(/State changed/);
    expect(() => store.readTaskPage({ id: goal.id, limit: 8001 })).toThrow();
    expect(() => store.readTask('missing')).toThrow(/not found/);
  });
});

// Keep display grouping separate from persisted task states and require an
// explicit decision before a drop can choose between review and blocked.
import { describe, expect, it } from 'vitest';
import { boardTaskColumns, taskDropDestination } from '../../web/task-board-columns.js';

describe('task board display columns', () => {
  it('keeps three stable empty columns without inventing a stored pending state', () => {
    expect(boardTaskColumns([])).toEqual([
      { id: 'todo', tasks: [] }, { id: 'in_progress', tasks: [] }, { id: 'pending', tasks: [] },
    ]);
  });

  it('groups mixed pending tasks while preserving every original state, order and record', () => {
    const tasks = ['done', 'blocked', 'todo', 'in_review', 'canceled', 'in_progress']
      .map((status, index) => Object.freeze({ id: `task-${index}`, status, version: 7 }));
    Object.freeze(tasks);
    const columns = boardTaskColumns(tasks);
    expect(columns.map(column => [column.id, column.tasks.map(task => task.id)])).toEqual([
      ['todo', ['task-2']], ['in_progress', ['task-5']], ['pending', ['task-1', 'task-3']],
    ]);
    expect(columns[2]!.tasks[0]).toBe(tasks[1]);
    expect(tasks.map(task => task.status)).toEqual(['done', 'blocked', 'todo', 'in_review', 'canceled', 'in_progress']);
    expect(tasks).toHaveLength(6);
  });

  it('never dynamically adds terminal or unknown columns', () => {
    expect(boardTaskColumns([{ status: 'done' }, { status: 'canceled' }, { status: 'future' }])
      .every(column => column.tasks.length === 0)).toBe(true);
  });

  it('requires explicit pending status selection and never switches states within that column', () => {
    expect(taskDropDestination('todo', 'pending')).toBe('choose');
    expect(taskDropDestination('in_progress', 'pending')).toBe('choose');
    expect(taskDropDestination('in_review', 'pending')).toBe(null);
    expect(taskDropDestination('blocked', 'pending')).toBe(null);
  });

  it('retains exact todo and progress moves, rejecting hidden display destinations', () => {
    expect(taskDropDestination('blocked', 'todo')).toBe('todo');
    expect(taskDropDestination('in_review', 'in_progress')).toBe('in_progress');
    expect(taskDropDestination('todo', 'todo')).toBe(null);
    for (const column of ['done', 'canceled', 'in_review', 'blocked', 'future']) {
      expect(taskDropDestination('todo', column)).toBe(null);
    }
  });
});

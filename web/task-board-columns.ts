// Display groups never become persisted statuses. Pending drops need a human
// choice; moving a card inside that group must preserve its exact state.
export type TaskBoardColumn = 'todo' | 'in_progress' | 'pending';
export function boardTaskColumns<T extends { status: string }>(tasks: readonly T[]): { id: TaskBoardColumn; tasks: T[] }[] {
  return [
    { id: 'todo', tasks: tasks.filter(task => task.status === 'todo') },
    { id: 'in_progress', tasks: tasks.filter(task => task.status === 'in_progress') },
    { id: 'pending', tasks: tasks.filter(task => task.status === 'in_review' || task.status === 'blocked') },
  ];
}

export function taskDropDestination(current: string, column: string): 'todo' | 'in_progress' | 'choose' | null {
  if (column === 'pending') return current === 'in_review' || current === 'blocked' ? null : 'choose';
  if ((column === 'todo' || column === 'in_progress') && column !== current) return column;
  return null;
}

// Apply the same live organization, identity and goal fences to every harness.
import { AppError } from './store.js';
import type { WorkerStore } from './worker-store.js';
import { collaboratorTaskIds, type CollaboratorStore } from './collaborators.js';
export function assertOrganizationMember(workers: WorkerStore, id: string, collaborators?: CollaboratorStore, taskId?: string) {
  const pool = workers.pool();
  if (!pool?.enabled || ['stopped', 'stopping'].includes(pool.state)) throw new AppError('POOL_STOPPING', 'The organization is stopped', 409);
  if (collaborators) {
    const member = collaborators.get(id);
    if (!member.enabled || member.poolId !== pool.id) throw new AppError('NOT_MEMBER', 'This identity is not admitted to this organization', 403);
    const ids = collaboratorTaskIds(member, workers);
    if (taskId && ids && !ids.includes(taskId)) throw new AppError('UNBOUND_GOAL', 'This goal is outside your admitted scope', 403);
  } else {
    const member = workers.get(id);
    if (!member.enabled || !pool.memberIds.includes(id)) throw new AppError('NOT_MEMBER', 'Only an enabled organization member may act', 403);
    if (taskId && pool.taskIds.length && !pool.taskIds.includes(taskId)) throw new AppError('UNBOUND_GOAL', 'This goal is outside the organization subscription', 403);
  }
  return pool;
}

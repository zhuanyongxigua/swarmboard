import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startServer } from '../../src/app.js';
import { Store, type Task } from '../../src/store.js';
import { CollaboratorStore, collaboratorRole } from '../../src/collaborators.js';
import { createMcpServer } from '../../src/mcp.js';

const progress = { percent: 35, state: 'waiting', phase: 'Independent review', verified: 'Synthetic checks passed', remaining: 'Review feedback' };
describe('task progress public boundaries', () => {
  it('updates and clears through real HTTP with task versions, permission and validation failures', async () => {
    const server = await startServer({ port: 0, dbPath: ':memory:' });
    const call = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
      const response = await fetch(server.url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, data: await response.json() };
    };
    try {
      const created = await call('/api/tasks', { title: 'Synthetic HTTP goal' }); const task = created.data as Task;
      const path = `/api/tasks/${task.id}/progress`;
      expect(await call(path, { expectedVersion: 1, progress }, 'PATCH')).toMatchObject({ status: 200, data: { version: 2, status: 'todo', progress: { ...progress, reportedBy: 'human' } } });
      expect((await call(path, { expectedVersion: 1, progress }, 'PATCH')).status).toBe(409);
      await call('/api/agents', { agentId: 'outsider', name: 'Outsider' });
      expect((await call(path, { expectedVersion: 2, progress, agentId: 'outsider' }, 'PATCH')).status).toBe(403);
      expect((await call(path, { expectedVersion: 2, progress: { ...progress, percent: 101 } }, 'PATCH')).status).toBe(400);
      expect(await call(path, { expectedVersion: 2, progress: null }, 'PATCH')).toMatchObject({ status: 200, data: { version: 3, status: 'todo', progress: null } });
      expect((await call('/api/board')).data.tasks[0]).toMatchObject({ version: 3, progress: null });
    } finally { await server.close(); }
  });

  it('binds MCP reporter identity and admitted goal scope, reads current data and stops revoked writes', async () => {
    const store = new Store(), admissions = new CollaboratorStore(':memory:');
    const goal = store.createTask({ title: 'Admitted synthetic goal' }), other = store.createTask({ title: 'Unadmitted goal' });
    const admission = admissions.configure({ expectedVersion: 0, name: 'Synthetic collaborator', harness: 'echo', taskIds: [goal.id], enabled: true }, store).collaborator;
    store.registerAgent({ agentId: admission.id, name: admission.name });
    store.claimTask(goal.id, { expectedVersion: goal.version, agentId: admission.id });
    store.claimTask(other.id, { expectedVersion: other.version, agentId: admission.id });
    const role = collaboratorRole(store, admissions, admission.id);
    const server = createMcpServer(store, 'unused', undefined, { collaborator: true, collaboratorId: admission.id, collaborators: admissions, workerId: admission.id, mayAct: role.mayAct });
    const client = new Client({ name: 'progress-boundary-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const call = (args: Record<string, unknown>) => client.callTool({ name: 'task_progress_update', arguments: args });
      expect((await client.listTools()).tools.some(tool => tool.name === 'task_progress_update')).toBe(true);
      const changed = await call({ id: goal.id, expectedVersion: 2, progress });
      expect(changed.isError).not.toBe(true);
      expect(changed.structuredContent).toMatchObject({ version: 3, progress: { ...progress, reportedBy: admission.id } });
      const read = await client.callTool({ name: 'task_read', arguments: { id: goal.id } });
      expect(read.structuredContent).toMatchObject({ progress: { ...progress, reportedBy: admission.id } });
      const spoof = await call({ id: goal.id, expectedVersion: 3, progress, agentId: 'human' });
      expect(spoof.isError).toBe(true); expect(JSON.stringify(spoof.content)).toContain('BOUND_IDENTITY');
      const outside = await call({ id: other.id, expectedVersion: 2, progress });
      expect(outside.isError).toBe(true); expect(JSON.stringify(outside.content)).toContain('UNBOUND_GOAL');
      admissions.configure({ id: admission.id, name: admission.name, harness: admission.harness, sessionRef: admission.sessionRef, taskIds: admission.taskIds, expectedVersion: admission.version, enabled: false }, store);
      const revoked = await call({ id: goal.id, expectedVersion: 3, progress: null });
      expect(revoked.isError).toBe(true); expect(JSON.stringify(revoked.content)).toContain('COLLABORATOR_STOPPED');
      expect(store.readTask(goal.id).version).toBe(3);
    } finally { await client.close(); await server.close(); admissions.close(); store.close(); }
  });
});

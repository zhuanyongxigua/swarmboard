// Regression for the bound-identity wrapper vs strict tool schemas.
//
// `overview_status_facts_write` binds the member identity server-side from
// options.workerId and its strict schema has no `agentId` field. The shared
// operations wrapper must not inject a field a tool did not declare; otherwise
// every bound seat (pool worker or external collaborator) receives
// VALIDATION_ERROR: Unrecognized key "agentId".
//
// The same wrapper must still inject the bound agentId for tools whose schema
// declares it (context_publish), and must still reject a caller-supplied
// foreign agentId and inactive authorization.
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../src/store.js';
import { CollaboratorStore } from '../../src/collaborators.js';
import { WorkerStore } from '../../src/worker-store.js';
import { createMcpServer } from '../../src/mcp.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

interface ToolResult { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown }
const body = (result: unknown): unknown => {
  const value = result as ToolResult;
  if (value.structuredContent !== undefined) return value.structuredContent;
  const text = value.content?.find(part => part.type === 'text')?.text ?? 'null';
  try { return JSON.parse(text); } catch { return text; }
};

function envelope(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    harness: 'dsh', classification: 'fact', activity: 'executing', modelId: 'deepseek-flash',
    reasoningLevel: 'max', executionEvidence: { kind: 'dsh-turn-start', at: now, ref: 'sess-1' },
    asOf: now, ttlSeconds: 300,
  };
}

type Options = NonNullable<Parameters<typeof createMcpServer>[3]>;
async function connect(store: Store, options: Options) {
  const server = createMcpServer(store, 'unused', undefined, options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'bound-status-facts-test', version: '1' });
  await client.connect(b);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

it('lets a bound external collaborator self-register status facts and see the group', async () => {
  const store = new Store(); cleanups.push(() => store.close());
  const goal = store.createTask({ title: 'Status fact goal' });
  const admissions = new CollaboratorStore(':memory:'); cleanups.push(() => admissions.close());
  const me = admissions.configure({ expectedVersion: 0, name: 'external', harness: 'dsh', sessionRef: 'sess-1', taskIds: [goal.id], enabled: true }, store).collaborator;
  store.registerAgent({ agentId: me.id, name: 'external' });
  let active = true;
  const client = await connect(store, {
    collaborator: true, collaboratorId: me.id, collaborators: admissions, workerId: me.id,
    mayAct: () => active, overviewSource: () => ({}),
  });

  const write = await call(client, 'overview_status_facts_write', envelope());
  expect(write.isError).toBeFalsy();
  expect(body(write)).toMatchObject({ saved: true, memberId: me.id, harness: 'dsh' });

  const read = body(await call(client, 'overview_read')) as { facts: { items: { id: string; value: unknown }[] } };
  const item = (id: string) => read.facts.items.find(entry => entry.id === id);
  expect(item('external.harness.dsh.members')?.value).toBe(1);
  expect(item('external.harness.dsh.executing')?.value).toBe(1);

  // The strict schema rejects a caller-supplied agentId before the handler; the
  // bound identity can never be chosen by the caller for this tool.
  const foreign = await call(client, 'overview_status_facts_write', { ...envelope(), agentId: 'someone-else' });
  expect(foreign.isError).toBe(true);
  expect(JSON.stringify(body(foreign))).toContain('Unrecognized key');

  // Strict schemas still reject other undeclared fields.
  const extra = await call(client, 'overview_status_facts_write', { ...envelope(), extra: 1 });
  expect(extra.isError).toBe(true);
  expect(JSON.stringify(body(extra))).toContain('Unrecognized key');

  // For a tool whose schema declares agentId, the wrapper still rejects a
  // foreign identity while accepting the bound one.
  const foreignClaim = await call(client, 'context_publish', { kind: 'OBSERVED', summary: 'foreign probe', agentId: 'someone-else' });
  expect(foreignClaim.isError).toBe(true);
  expect(JSON.stringify(body(foreignClaim))).toContain('BOUND_IDENTITY');

  // A tool whose schema declares agentId still works with the bound identity,
  // and the wrapper still enforces it against a foreign value.
  const published = await call(client, 'context_publish', { kind: 'OBSERVED', summary: 'bound injection probe', taskId: goal.id, agentId: me.id });
  expect(published.isError).toBeFalsy();
  const entries = store.readEntries({ query: 'bound injection probe' }).items;
  expect(entries[0]?.agentId).toBe(me.id);

  // Optional agentId is still filled by the wrapper for declared schemas.
  store.claimTask(goal.id, { agentId: me.id, expectedVersion: 1 });
  const goalVersion = store.board().tasks.find(task => task.id === goal.id)!.version;
  const renamed = await call(client, 'task_update', { id: goal.id, expectedVersion: goalVersion, title: 'renamed by bound seat' });
  expect(renamed.isError).toBeFalsy();
  expect(store.board().tasks.find(task => task.id === goal.id)?.title).toBe('renamed by bound seat');
  // Inactive collaboration is still fenced.
  active = false;
  const stopped = await call(client, 'overview_status_facts_write', envelope());
  expect(stopped.isError).toBe(true);
  expect(JSON.stringify(body(stopped))).toContain('COLLABORATOR_STOPPED');

});

it('lets a bound pool worker self-register status facts and see the group', async () => {
  const store = new Store(); cleanups.push(() => store.close());
  const workers = new WorkerStore(':memory:'); cleanups.push(() => workers.close());
  let active = true;
  const client = await connect(store, {
    poolMember: true, workerId: 'bound-worker', peers: workers,
    mayAct: () => active, overviewSource: () => ({}),
  });

  const write = await call(client, 'overview_status_facts_write', envelope());
  expect(write.isError).toBeFalsy();
  expect(body(write)).toMatchObject({ saved: true, memberId: 'bound-worker', harness: 'dsh' });

  const read = body(await call(client, 'overview_read')) as { facts: { items: { id: string; value: unknown }[] } };
  expect(read.facts.items.find(entry => entry.id === 'external.harness.dsh.members')?.value).toBe(1);

  active = false;
  const stopped = await call(client, 'overview_status_facts_write', envelope());
  expect(stopped.isError).toBe(true);
  expect(JSON.stringify(body(stopped))).toContain('POOL_STOPPING');
});

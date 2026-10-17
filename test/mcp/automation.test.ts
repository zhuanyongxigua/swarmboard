// Exercise schedule preparation and confirmation through the real MCP transport, without host mutations.
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/app.js';
let server: Awaited<ReturnType<typeof startServer>>, client: Client;
beforeEach(async () => { server = await startServer({ port: 0, dbPath: ':memory:' }); client = new Client({ name: 'automation-test', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(server.url + '/mcp'))); });
afterEach(async () => { await client.close(); await server.close(); });
const tool = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const data = (result: Awaited<ReturnType<typeof tool>>) => result.structuredContent as Record<string, any>;
describe('native automation MCP contract', () => {
  it('advertises and completes revision-checked setup without changing board tasks or events', async () => {
    const advertised = await client.listTools();
    expect(advertised.tools.map(item => item.name)).toEqual(expect.arrayContaining(['automation_read', 'automation_prepare', 'automation_claim', 'automation_confirm', 'automation_setup_failed']));
    const before = data(await tool('board_read'));
    const prepared = data(await tool('automation_prepare', { action: 'enable', expectedVersion: 0, workspacePath: tmpdir(), intervalMinutes: 10 }));
    expect(prepared.config.state).toBe('pending'); expect(prepared.setupPrompt).toContain('official native automation_update');
    expect((await tool('automation_confirm', { expectedVersion: prepared.config.version, requestId: 'wrong', automationId: 'native', status: 'ACTIVE', model: 'native-default', reasoningEffort: 'high', projectId: 'exact-local-project' })).isError).toBe(true);
    const active = data(await tool('automation_confirm', { expectedVersion: prepared.config.version, requestId: prepared.config.requestId, automationId: 'native', status: 'ACTIVE', model: 'native-default', reasoningEffort: 'high', projectId: 'exact-local-project' }));
    expect(active).toMatchObject({ state: 'active', actualStatus: 'ACTIVE', automationId: 'native' });
    expect(data(await tool('board_read'))).toEqual(before);
    const pause = data(await tool('automation_prepare', { action: 'pause', expectedVersion: active.version }));
    expect(pause.config).toMatchObject({ state: 'pending', actualStatus: 'ACTIVE' });
    const failed = data(await tool('automation_setup_failed', { expectedVersion: pause.config.version, requestId: pause.config.requestId, error: 'Native tool unavailable' }));
    expect(failed).toMatchObject({ state: 'error', actualStatus: 'ACTIVE', automationId: 'native' });
  });
  it('requires confirmed activation for automated claims and returns a persistent session binding', async () => {
    const agent = data(await tool('agent_register', { name: 'Native worker' })); const task = data(await tool('task_create', { title: 'Claim through protocol' }));
    const prepared = data(await tool('automation_prepare', { action: 'enable', expectedVersion: 0, workspacePath: tmpdir() }));
    const claim = { id: task.id, agentId: agent.id, expectedVersion: task.version, automationVersion: prepared.config.version, threadId: 'worker-thread' };
    expect((await tool('automation_claim', claim)).isError).toBe(true);
    const active = data(await tool('automation_confirm', { expectedVersion: prepared.config.version, requestId: prepared.config.requestId, automationId: 'native', status: 'ACTIVE', model: 'native-default', reasoningEffort: 'high', projectId: 'exact-local-project' }));
    const claimed = data(await tool('automation_claim', { ...claim, automationVersion: active.version }));
    expect(claimed).toMatchObject({ task: { status: 'in_progress', assignee: agent.id }, binding: { threadId: 'worker-thread', taskId: task.id, automationId: 'native' } });
    expect((await tool('automation_claim', { ...claim, automationVersion: active.version })).isError).toBe(true);
  });
});

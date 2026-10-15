// Launch the shipped archive with the official client so repository dependencies cannot hide packaging defects.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Task, Resource, Usage, Entry } from '../../src/store.js';

const archive = resolve('dist/swarmboard-desktop-0.1.0.zip');
let root: string, pluginRoot: string, work: string;
interface Board { tasks: Task[]; resources: Resource[]; usages: Usage[]; entries: Entry[] }
interface Configuration { mcpServers: { swarmboard: { type: string; command: string; args: string[]; cwd: string } } }
const clients = new Set<Client>();
function files(directory: string, base = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory()
    ? files(join(directory, item.name), join(base, item.name)) : [join(base, item.name)]).sort();
}
function fingerprints() {
  return files(pluginRoot).map(name => [name, createHash('sha256').update(readFileSync(join(pluginRoot, name))).digest('hex')]);
}
async function connect(database: string, workingDirectory = work) {
  const config = JSON.parse(readFileSync(join(pluginRoot, 'mcp.json'), 'utf8')) as Configuration;
  const command = config.mcpServers.swarmboard;
  const transport = new StdioClientTransport({ command: command.command,
    args: command.args.map(arg => arg.replaceAll('${PLUGIN_ROOT}', pluginRoot)), cwd: workingDirectory,
    env: { PATH: process.env.PATH ?? '', HOME: root, XDG_DATA_HOME: join(root, 'data'), SWARMBOARD_DB_PATH: database }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'clean-desktop-package-test', version: '1.0.0' });
  clients.add(client);
  try { await client.connect(transport); }
  catch (error) { throw new Error(`Desktop process failed: ${stderr}`, { cause: error }); }
  return client;
}
async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as T;
}
async function close(client: Client) { await client.close(); clients.delete(client); }
beforeAll(() => {
  if (!existsSync(archive)) throw new Error('Build the portable artifact first: npm run package:desktop');
  root = mkdtempSync(join(tmpdir(), 'swarmboard-desktop-'));
  pluginRoot = join(root, 'unpacked plugin'); work = join(root, 'unrelated cwd');
  mkdirSync(pluginRoot); mkdirSync(work);
  execFileSync('unzip', ['-q', archive, '-d', pluginRoot]);
});
afterAll(async () => { await Promise.all([...clients].map(client => client.close())); if (root) rmSync(root, { recursive: true, force: true }); });
describe('portable desktop plugin', () => {
  it('ships a self-contained local stdio plugin without runtime state or private paths', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'swarmboard', license: 'MIT', extensions: { 'com.openai': { requires_local_executor: true } } });
    const config = JSON.parse(readFileSync(join(pluginRoot, 'mcp.json'), 'utf8')) as Configuration;
    expect(config.mcpServers.swarmboard).toEqual({ type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server/swarmboard.mjs'], cwd: '${PLUGIN_ROOT}' });
    const names = files(pluginRoot);
    expect(names).toEqual(expect.arrayContaining(['server/swarmboard.mjs', 'widget.html', 'skills/shared-worker/SKILL.md', 'BUILD.json']));
    expect(names.some(name => /(^|\/)(node_modules|\.env|\.git)(\/|$)|\.(sqlite|db)(-|$)/.test(name))).toBe(false);
    for (const name of names) expect(readFileSync(join(pluginRoot, name), 'utf8')).not.toMatch(/\/Users\/[^/]+\/|\/home\/runner\/work\//);
  });
  it('discovers native entrypoints and UI, collaborates, and persists after a clean process restart', async () => {
    const before = fingerprints(), database = join(root, 'persistence', 'board.sqlite');
    const client = await connect(database);
    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === 'board_open')?._meta).toMatchObject({
      ui: { resourceUri: 'ui://swarmboard/board.html' }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] }
    });
    const widget = await client.readResource({ uri: 'ui://swarmboard/board.html' });
    expect(widget.contents[0]).toMatchObject({ mimeType: expect.stringContaining('html'), _meta: { 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } } });
    const html = 'text' in widget.contents[0]! ? widget.contents[0].text : '';
    expect(html === readFileSync(join(pluginRoot, 'widget.html'), 'utf8')).toBe(true);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    await call(client, 'agent_register', { agentId: 'portable-a', name: 'Portable A' });
    await call(client, 'agent_register', { agentId: 'portable-b', name: 'Portable B' });
    const task = await call<Task>(client, 'task_create', { title: 'Portable acceptance', acceptanceCriteria: 'Survives process restart' });
    await call(client, 'task_claim', { id: task.id, agentId: 'portable-a', expectedVersion: 1 });
    const resource = await call<Resource>(client, 'resource_create', { name: 'Synthetic machine', kind: 'machine' });
    const usage = await call<Usage>(client, 'resource_use', { resourceId: resource.id, agentId: 'portable-a', purpose: 'compile', scope: 'isolated checkout', sharing: 'read-only access welcome' });
    await call(client, 'resource_use', { resourceId: resource.id, agentId: 'portable-b', purpose: 'inspect logs' });
    await call(client, 'context_publish', { agentId: 'portable-a', kind: 'MESSAGE', summary: 'Concurrent read access agreed', recipientId: 'portable-b', resourceId: resource.id });
    await call(client, 'resource_release', { id: usage.id, agentId: 'portable-a', expectedVersion: 1 });
    await call(client, 'task_release', { id: task.id, agentId: 'portable-a', expectedVersion: 2 });
    const snapshot = await call<Board>(client, 'board_read');
    expect(snapshot.tasks[0]).toMatchObject({ id: task.id, assignee: null, status: 'todo', version: 3 });
    expect(snapshot.usages.filter(item => item.active)).toHaveLength(1);
    const context = await call<{ items: Entry[]; cursor: number }>(client, 'context_read', { limit: 200 });
    expect(context.items.some(entry => entry.summary === 'Concurrent read access agreed')).toBe(true);
    await close(client);
    const restarted = await connect(database);
    expect(await call<Board>(restarted, 'board_read')).toEqual(snapshot);
    expect(await call(restarted, 'context_read', { after: context.cursor })).toMatchObject({ items: [] });
    await close(restarted);
    expect(fingerprints()).toEqual(before);
    expect(readdirSync(work)).toEqual([]);
    expect(existsSync(join(root, 'data'))).toBe(false);
  });
  it('cold-starts two processes on one SQLite file and allows exactly one competing claim', async () => {
    const database = join(root, 'concurrent', 'board.sqlite');
    const [a, b] = await Promise.all([connect(database), connect(database)]);
    await Promise.all([call(a, 'agent_register', { agentId: 'racer-a', name: 'Racer A' }), call(b, 'agent_register', { agentId: 'racer-b', name: 'Racer B' })]);
    const task = await call<Task>(a, 'task_create', { title: 'One task, two processes' });
    const responses = await Promise.all([a.callTool({ name: 'task_claim', arguments: { id: task.id, agentId: 'racer-a', expectedVersion: 1 } }), b.callTool({ name: 'task_claim', arguments: { id: task.id, agentId: 'racer-b', expectedVersion: 1 } })]);
    expect(responses.filter(result => !result.isError)).toHaveLength(1);
    expect(responses.filter(result => result.isError)).toHaveLength(1);
    expect(JSON.stringify(responses.find(result => result.isError)?.content)).toContain('VERSION_CONFLICT');
    const board = await call<Board>(b, 'board_read');
    expect(board.tasks[0]).toMatchObject({ id: task.id, version: 2, status: 'in_progress' });
    expect(board.entries.filter(entry => entry.kind === 'CLAIM' && entry.taskId === task.id)).toHaveLength(1);
    await Promise.all([close(a), close(b)]);
  });
});

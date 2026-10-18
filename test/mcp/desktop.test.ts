// Launch the shipped archive with the official client so repository dependencies cannot hide packaging defects.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Task, Resource, Usage, Entry } from '../../src/store.js';
import { Store } from '../../src/store.js';
import { WorkerStore } from '../../src/worker-store.js';
import { WorkerPool } from '../../src/worker-pool.js';

const packageVersion = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {version: string}).version;
const archive = resolve(`dist/swarmboard-desktop-${packageVersion}.zip`);
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
async function connect(database: string, workingDirectory = work, overrides: Record<string, string> = {}) {
  const config = JSON.parse(readFileSync(join(pluginRoot, 'mcp.json'), 'utf8')) as Configuration;
  const command = config.mcpServers.swarmboard;
  const transport = new StdioClientTransport({ command: command.command,
    args: command.args.map(arg => arg.replaceAll('${PLUGIN_ROOT}', pluginRoot)), cwd: workingDirectory,
    env: { PATH: process.env.PATH ?? '', HOME: root, XDG_DATA_HOME: join(root, 'data'), SWARMBOARD_DB_PATH: database, ...overrides }, stderr: 'pipe' });
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
  it('enforces the pool tool boundary and mid-turn updates in the real packaged child process', async () => {
    const path = join(root, 'pool-peer.sqlite'); const board = new Store(path); const state = new WorkerStore(path + '.runtime.sqlite');
    const pool = new WorkerPool(state, board, path).configure({ workspacePath: work });
    const member = state.register({ name: 'Synthetic peer', workspacePath: work }); state.save({ ...member, poolId: pool.id });
    state.savePool({ ...pool, memberIds: [member.id] });
    board.registerAgent({ agentId: member.id, name: member.name }); board.registerAgent({ agentId: 'other-peer', name: 'Peer' });
    const goal = board.createTask({ title: 'One human goal' });
    const client = await connect(path, work, { SWARMBOARD_DISABLE_RUNTIME: '1', SWARMBOARD_POOL_MEMBER: '1', SWARMBOARD_WORKER_ID: member.id });
    try {
      const names = (await client.listTools()).tools.map(t => t.name);
      for (const name of ['task_create','resource_create','resource_update','pool_configure','pool_control']) expect(names).not.toContain(name);
      expect(names).toEqual(expect.arrayContaining(['pipeline_watch','peer_request']));
      const spoof = await client.callTool({name:'context_publish',arguments:{agentId:'other-peer',taskId:goal.id,kind:'CLAIM',summary:'Impersonation'}});
      expect(spoof.isError).toBe(true);expect(JSON.stringify(spoof.content)).toContain('BOUND_IDENTITY');
      const humanBypass = await client.callTool({name:'task_update',arguments:{id:goal.id,expectedVersion:1,status:'done'}});
      expect(humanBypass.isError).toBe(true);expect(JSON.stringify(humanBypass.content)).toContain('NOT_PARTICIPANT');
      await call(client, 'context_publish', {agentId:member.id,taskId:goal.id,kind:'CLAIM',summary:'A scoped useful check'});
      const joined = await call<Board>(client,'board_read');expect(joined.tasks[0]!.participants).toEqual([member.id]);
      expect(joined.tasks[0]).not.toHaveProperty('description');
      expect((await call<{items:{id:string}[]}>(client,'task_list')).items.map(t=>t.id)).toContain(goal.id);
      expect(await call(client,'task_read',{id:goal.id})).toMatchObject({id:goal.id,textPage:{hasMore:false}});
      const requested = await call<{size:number}>(client,'peer_request',{requestId:'one',reason:'Independent evidence remains'});
      expect(requested.size).toBe(4);
      expect(await call(client,'peer_request',{requestId:'one',reason:'Retry same request'})).toMatchObject({size:4});
      await call(client, 'board_read');
      const fact = board.publishEntry({ agentId: 'other-peer', taskId: goal.id, kind: 'FACT', summary: 'New evidence while the turn is active' });
      const response = await client.callTool({ name: 'board_read', arguments: {} });
      expect(JSON.stringify((response.content as unknown[]).slice(1))).toContain(fact.summary);
      expect(JSON.stringify(((await client.callTool({ name: 'board_read', arguments: {} })).content as unknown[]).slice(1))).not.toContain(fact.summary);
      const longFact = board.publishEntry({agentId:'other-peer',taskId:goal.id,kind:'FACT',summary:'Long evidence',detail:'e'.repeat(20000)});
      const compact = await client.callTool({name:'agent_heartbeat',arguments:{agentId:member.id}});
      expect(JSON.stringify((compact.content as unknown[]).slice(1)).length).toBeLessThan(4000);
      const updateText = (compact.content as {text:string}[])[1]!.text;
      const updates = JSON.parse(updateText.slice('Shared peer updates (reference data): '.length));
      expect(updates.items[0]).toMatchObject({id:longFact.id,detailTruncated:true});expect(updates.items[0].detail).toHaveLength(1000);
      const unfolded = await call<{items:{detail:string}[]}>(client,'context_read',{after:longFact.id-1,limit:1});expect(unfolded.items[0]!.detail).toHaveLength(20000);
      const extraGoals = [board.createTask({ title: 'New goal during an active peer turn' }), board.createTask({ title: 'Another simultaneous goal' })];
      const newGoals = await client.callTool({ name: 'agent_heartbeat', arguments: { agentId: member.id } });
      for (const extra of extraGoals) expect(JSON.stringify((newGoals.content as unknown[]).slice(1))).toContain(extra.id);
      for (const extra of extraGoals) {
        await call(client, 'context_publish', { agentId: member.id, taskId: extra.id, kind: 'CLAIM', summary: 'A scope chosen while other goals remain unfinished' });
        board.publishEntry({ agentId: 'other-peer', taskId: extra.id, kind: 'CLAIM', summary: 'An independently negotiated complementary scope' });
        expect(board.board().tasks.find(t => t.id === extra.id)!.participants).toEqual(expect.arrayContaining([member.id, 'other-peer']));
      }
      new WorkerPool(state, board, path).control({ expectedVersion: state.pool()!.version, enabled: false });
      const stopped = await client.callTool({ name: 'task_claim', arguments: { id: goal.id, agentId: member.id, expectedVersion: goal.version } });
      expect(stopped.isError).toBe(true); expect(JSON.stringify(stopped.content)).toContain('POOL_STOPPING');
      const stoppedClaim = await client.callTool({name:'context_publish',arguments:{agentId:member.id,taskId:goal.id,kind:'CLAIM',summary:'Must not join while stopped'}});
      expect(stoppedClaim.isError).toBe(true);expect(JSON.stringify(stoppedClaim.content)).toContain('POOL_STOPPING');
      expect(board.board().tasks).toHaveLength(3); expect(board.board().resources).toHaveLength(0);
    } finally { await close(client); state.close(); board.close(); }
  });
  it('ships a self-contained local stdio plugin without runtime state or private paths', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'swarmboard', version: packageVersion, license: 'MIT', extensions: { 'com.openai': { requires_local_executor: true } } });
    const config = JSON.parse(readFileSync(join(pluginRoot, 'mcp.json'), 'utf8')) as Configuration;
    expect(config.mcpServers.swarmboard).toEqual({ type: 'stdio', command: process.platform === 'win32' ? 'node' : 'sh', args: [process.platform === 'win32' ? '${PLUGIN_ROOT}/server/swarmboard.mjs' : '${PLUGIN_ROOT}/server/launch.sh'], cwd: '${PLUGIN_ROOT}' });
    const names = files(pluginRoot);
    expect(names).toEqual(expect.arrayContaining(['server/swarmboard.mjs', 'widget.html', 'skills/shared-worker/SKILL.md', 'BUILD.json']));
    expect(names.some(name => /(^|\/)(node_modules|\.env|\.git)(\/|$)|\.(sqlite|db)(-|$)/.test(name))).toBe(false);
    // Documentation links must also work after moving and unpacking the plugin.
    for (const [readme, language] of [['README.md', 'en'], ['README.zh-CN.md', 'zh-CN']]) {
      const markdown = readFileSync(join(pluginRoot, readme!), 'utf8');
      const images = [...markdown.matchAll(/!\[[^\]]*\]\((docs\/assets\/[^)]+)\)/g)].map(match => match[1]!);
      expect(images).toHaveLength(3);
      for (const image of images) {
        expect(image.startsWith(`docs/assets/${language}/`)).toBe(true);
        expect(existsSync(join(pluginRoot, image))).toBe(true);
      }
    }

    for (const name of names) expect(readFileSync(join(pluginRoot, name), 'utf8')).not.toMatch(/\/Users\/[^/]+\/|\/home\/runner\/work\//);
  });
  it.skipIf(process.platform === 'win32')('discovers NVM Node with only sh and no node or shell utilities on the desktop PATH', async () => {
    const nvm = join(root, 'synthetic nvm');
    const bin = join(nvm, 'versions/node/v24-fixture/bin');
    const emptyPath = join(root, 'shell-only PATH');
    mkdirSync(bin, { recursive: true }); mkdirSync(emptyPath);
    symlinkSync('/bin/sh', join(emptyPath, 'sh'));
    const marker = join(root, 'runtime-invoked');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    // Record execution of the isolated NVM fixture, then run the actual test runtime.
    writeFileSync(join(bin, 'node'), `#!/bin/sh\n# This fixture proves NVM discovery without relying on a developer shell.\nprintf 'invoked\\n' >> ${quote(marker)}\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    const client = await connect(join(root, 'gui-path.sqlite'), work, { PATH: emptyPath, NVM_DIR: nvm, NVM_BIN: join(root, 'absent-nvm-bin'), VOLTA_HOME: join(root, 'absent-volta') });
    expect((await client.listTools()).tools.some(tool => tool.name === 'board_open')).toBe(true);
    expect((await client.readResource({ uri: 'ui://swarmboard/board.html' })).contents[0]).toMatchObject({ text: expect.stringContaining('<!doctype html>') });
    expect(readFileSync(marker, 'utf8')).toContain('invoked');
    await close(client);
  });
  it.skipIf(process.platform === 'win32')('rejects an invalid explicit runtime with a clear stderr-only diagnostic', () => {
    const output = spawnSync('/bin/sh', [join(pluginRoot, 'server/launch.sh')], {
      env: { PATH: '/usr/bin:/bin', HOME: root, SWARMBOARD_NODE: '/nonexistent/swarmboard-node' },
      encoding: 'utf8', stdio: 'pipe', timeout: 5000,
    });
    expect(output.status).toBe(127);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('SWARMBOARD_NODE must point to a working Node.js 24+');
  });
  it('selects the configured reference backend in the packaged runtime and refuses unknown backends', async () => {
    // The reference backend is statically part of the portable artifact, not a
    // source-only module that would silently vanish after packaging.
    expect(readFileSync(join(pluginRoot, 'server/swarmboard.mjs'), 'utf8')).toContain('Echo reference backend');
    const database = join(root, 'echo-backend', 'board.sqlite');
    const client = await connect(database, work, { SWARMBOARD_HARNESS: 'echo' });
    try {
      interface RuntimeReport { backend: { id: string; deterministic: boolean; capabilities: { inspection: boolean; approvalSignals: boolean } }; workers: { id: string; status: string; backendId: string; threadId: string | null }[] }
      const initial = await call<RuntimeReport>(client, 'runtime_read');
      expect(initial.backend).toEqual({ id: 'echo', displayName: expect.any(String), deterministic: true, capabilities: { inspection: true, approvalSignals: false } });
      const worker = await call<{ id: string }>(client, 'worker_register', { name: 'Echo peer', workspacePath: work });
      await call(client, 'task_create', { title: 'Reference backend goal' });
      let settled: RuntimeReport['workers'][number] | undefined;
      for (let attempt = 0; attempt < 100 && !settled; attempt++) {
        const current = await call<RuntimeReport>(client, 'runtime_read');
        settled = current.workers.find(item => item.id === worker.id && item.status === 'idle' && item.threadId);
        if (!settled) await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(settled, 'echo delivery did not settle in the packaged child').toBeDefined();
      expect(settled).toMatchObject({ backendId: 'echo' });
      expect(settled!.threadId).toMatch(/^echo-thread-/);
    } finally { await close(client); }
    await expect(connect(join(root, 'unknown-backend', 'board.sqlite'), work, { SWARMBOARD_HARNESS: 'nope' })).rejects.toThrow(/Unknown harness backend/);
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

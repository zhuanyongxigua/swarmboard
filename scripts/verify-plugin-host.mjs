// Exercise the actual Codex plugin loader in isolated homes, so raw MCP tests
// cannot hide manifest rejection or missing tools. No models or user data are used.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const binary = process.argv[2] || process.env.CODEX_BINARY || (existsSync(bundled) ? bundled : execFileSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim());
const temporary = mkdtempSync(join(tmpdir(), 'swarmboard-host-loader-'));
const built = resolve('dist/desktop');
const guiPath = '/usr/bin:/bin:/usr/sbin:/sbin';

async function scenario(name, rejected) {
  const base = join(temporary, name), home = join(base, 'codex-home'), marketplace = join(base, 'marketplace');
  const plugin = join(marketplace, 'plugin');
  mkdirSync(home, { recursive: true }); mkdirSync(join(marketplace, '.agents/plugins'), { recursive: true });
  cpSync(built, plugin, { recursive: true });
  const fixtureHome = join(base, 'user-home');
  const nodeBin = join(fixtureHome, '.nvm/versions/node/current/bin');
  mkdirSync(nodeBin, { recursive: true });
  symlinkSync(process.execPath, join(nodeBin, 'node'));
  const config = JSON.parse(readFileSync(join(plugin, 'mcp.json'), 'utf8'));
  if (rejected) config.mcpServers.swarmboard.command = '/bin/sh';
  config.mcpServers.swarmboard.env = { PATH: guiPath, HOME: fixtureHome, SWARMBOARD_DB_PATH: join(base, 'isolated.sqlite') };
  writeFileSync(join(plugin, 'mcp.json'), JSON.stringify(config));
  writeFileSync(join(marketplace, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'swarmboard-test', plugins: [{ name: 'swarmboard', source: { source: 'local', path: './plugin' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }));
  writeFileSync(join(home, 'config.toml'), '[features]\nremote_plugin = false\n');
  const env = { ...process.env, CODEX_HOME: home };
  execFileSync(binary, ['plugin', 'marketplace', 'add', marketplace], { env, cwd: base, stdio: 'pipe', timeout: 20000 });
  execFileSync(binary, ['plugin', 'add', 'swarmboard@swarmboard-test', '--json'], { env, cwd: base, stdio: 'pipe', timeout: 20000 });
  const child = spawn(binary, ['app-server', '--stdio'], { env, cwd: base, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', id = 0;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (item) {
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error(`${method} timed out: ${stderr.slice(-1200)}`)); }, 25000);
    pending.set(current, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: current, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'swarmboard-host-acceptance', title: 'Isolated plugin acceptance', version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    child.stdin.write('{"method":"initialized"}\n');
    const detail = await request('plugin/read', { marketplacePath: join(marketplace, '.agents/plugins/marketplace.json'), pluginName: 'swarmboard' });
    assert.equal(detail.plugin.summary.installed, true);
    assert.equal(detail.plugin.summary.enabled, true);
    const status = await request('mcpServerStatus/list', { serverName: 'swarmboard', detail: 'full' });
    const server = status.data.find(item => item.name === 'swarmboard');
    if (rejected) {
      assert.equal(server, undefined, 'The real plugin loader must reject absolute commands');
      assert.deepEqual(detail.plugin.mcpServers, [], 'Rejected commands must not appear as loadable MCP servers');
      console.log('PASS: absolute command rejected by actual plugin loader');
    } else {
      assert(detail.plugin.mcpServers.includes('swarmboard'), 'Accepted commands must appear in parsed plugin metadata');
      assert(server, `Swarmboard missing from host inventory: ${stderr.slice(-1200)}`);
      assert.equal(server.toolsError, null);
      assert(server.tools.board_open, 'Host must discover board_open');
      assert.deepEqual(server.tools.board_open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
      const widget = await request('mcpServer/resource/read', { server: 'swarmboard', uri: 'ui://swarmboard/board.html' });
      assert(widget.contents.some(item => item.text?.startsWith('<!doctype html>')));
      console.log(`PASS: actual plugin loader discovers ${Object.keys(server.tools).length} tools, native entrypoints and UI with minimal MCP PATH`);
    }
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Host probe closed')); }
    lines.close(); child.stdin.end(); child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  }
}
try {
  console.log(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim());
  await scenario('rejected-absolute-command', true);
  await scenario('accepted-bare-command', false);
} finally { rmSync(temporary, { recursive: true, force: true }); }

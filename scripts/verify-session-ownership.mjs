// Reproduce public App Server writer ownership in an isolated Codex home so
// recovery changes cannot hide a conflict behind mock transport responses.
// A no-op shell turn makes the synthetic history durable; no login, model
// inference, user conversations or business databases are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binary = process.argv[2] || process.env.CODEX_BINARY || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'swarmboard-session-ownership-')));
const home = join(base, 'codex-home'), cwd = join(base, 'workspace');
mkdirSync(home); mkdirSync(cwd);
const peers = [];
function server() {
  const child = spawn(binary, ['app-server', '--stdio'], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let sequence = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.method) return;
    const item = pending.get(message.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(new Error(String(message.error.message))); else item.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const peer = { request, async init() {
    await request('initialize', { clientInfo: { name: 'swarmboard-ownership-acceptance', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    child.stdin.write('{"method":"initialized"}\n');
  }, async close() {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Probe closed')); } pending.clear();
    lines.close(); child.stdin.end(); child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  } };
  peers.push(peer); return peer;
}
try {
  const first = server(); await first.init();
  const opened = await first.request('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  const threadId = opened.thread.id;
  await first.request('thread/shellCommand', { threadId, command: ':', timeoutMs: 1000 });
  await first.request('thread/name/set', { threadId, name: 'Isolated writer ownership acceptance' });
  const second = server(); await second.init();
  const params = { threadId, cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', excludeTurns: true };
  await assert.rejects(second.request('thread/resume', params), /already has an active writer/);
  const metadata = await second.request('thread/read', { threadId, includeTurns: false });
  assert.equal(metadata.thread.id, threadId);
  await first.close();
  const resumed = await second.request('thread/resume', params);
  assert.equal(resumed.thread.id, threadId); assert.equal(resumed.thread.cwd, cwd);
  assert.deepEqual(resumed.thread.turns, []);
  console.log('PASS: another writer blocks resume; releasing that owned process allows the same thread to resume without any model turn');
} finally {
  await Promise.all(peers.map(peer => peer.close())); rmSync(base, { recursive: true, force: true });
}

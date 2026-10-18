// One isolated-board real Codex closed loop through the harness registry: a
// single real model turn must use the swarmboard_worker MCP to write back to
// the synthetic board. Explicit --live only; never the business board.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../dist/server/store.js';
import { EventRuntime } from '../dist/server/event-runtime.js';
import { resolveHarness } from '../dist/server/harness/registry.js';

if (!process.argv.includes('--live')) throw new Error('This runs one real model turn. Run explicitly with --live.');
const serverEntry = resolve('dist/server/stdio.js');
if (!existsSync(serverEntry)) throw new Error('Build first: npm run build');
const backend = resolveHarness();
if (backend.id !== 'codex' || backend.capabilities.approvalSignals !== true) throw new Error(`Expected the default codex backend, got '${backend.id}'`);

const root = mkdtempSync(join(tmpdir(), 'swarmboard-harness-loop-'));
const workspace = join(root, 'workspace');
const binary = process.env.SWARMBOARD_CODEX ?? (existsSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  ? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' : 'codex');
let binaryVersion = 'unknown';
try { binaryVersion = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(); } catch { /* The App Server handshake is the actual compatibility check. */ }
mkdirSync(workspace);
writeFileSync(join(workspace, 'AGENTS.md'), '# Synthetic harness loop\nThis is an isolated acceptance workspace. Use the swarmboard_worker MCP only, publish exactly what the goal asks, touch no other project or credential, and end the turn when done. Never sleep or poll.\n');

const board = new Store(join(root, 'board.sqlite'));
const runtime = new EventRuntime(board, { databasePath: join(root, 'board.sqlite'), serverEntry, fallbackMs: 60000 });
const evidence = { backend: backend.id, binary, binaryVersion, startedAt: new Date().toISOString() };
try {
  runtime.start();
  const worker = runtime.register({ name: 'Harness loop peer', workspacePath: workspace });
  evidence.workerId = worker.id;
  board.createTask({ title: 'Minimal harness loop', description: `You are worker ${worker.id}. 1) Register this exact agent identity with agent_register (agentId=${worker.id}, name='Harness loop peer'); if it already exists, heartbeat it instead. 2) Publish exactly one CLAIM entry into shared context with agentId=${worker.id}, taskId of this goal, summary starting LOOP_CLAIM, describing one concrete verification you performed on fixture content of this workspace. 3) End your turn. Do not create task cards or resources, do not modify files, do not use any external service or credential.` });
  const end = Date.now() + 300000;
  let status;
  while (Date.now() < end) {
    status = runtime.status();
    if (status.workers.some(w => w.status === 'error' || w.status === 'uncertain')) throw new Error('worker left idle: ' + JSON.stringify(status.workers));
    const settled = status.workers.find(w => w.id === worker.id && w.threadId && w.status === 'idle' && w.cursor > 0);
    const claimed = board.board().entries.some(e => e.agentId === worker.id && e.kind === 'CLAIM' && e.summary.startsWith('LOOP_CLAIM'));
    if (settled && claimed) {
      evidence.completedAt = new Date().toISOString();
      evidence.threadId = settled.threadId; evidence.turnId = settled.turnId ?? null; evidence.cursor = settled.cursor;
      evidence.boardEntries = board.board().entries.map(e => ({ id: e.id, kind: e.kind, agentId: e.agentId, summary: e.summary.slice(0, 200) }));
      evidence.limits = 'One real official Codex session and turn on an isolated synthetic board; proves the registry-selected backend executes a real turn and the model wrote back through swarmboard_worker MCP. It does not test DSH, approvals, or business boards.';
      writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ passed: true, root, workerId: worker.id, threadId: settled.threadId, backend: backend.id, binaryVersion }));
      break;
    }
    await delay(1000);
  }
  if (!evidence.completedAt) throw new Error('Timed out waiting for the closed loop; last status: ' + JSON.stringify(runtime.status().workers));
} catch (error) {
  evidence.error = String(error);
  evidence.workers = runtime.status().workers;
  writeFileSync(join(root, 'failure.json'), JSON.stringify(evidence, null, 2));
  console.error(`Harness loop failed: ${error.message}. Evidence: ${root}`);
  process.exitCode = 1;
} finally {
  await runtime.close(); board.close();
  if (process.argv.includes('--keep')) console.error(`Evidence kept at ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

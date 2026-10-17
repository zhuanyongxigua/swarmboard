// Explicit live acceptance uses an isolated board and synthetic files to prove
// event wakeup plus same-session delivery without touching real tasks/resources.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../dist/server/store.js';
import { EventRuntime } from '../dist/server/event-runtime.js';

if (!process.argv.includes('--live')) throw new Error('This check invokes the configured model. Run explicitly with --live after building.');
const directory = mkdtempSync(join(tmpdir(), 'swarmboard-live-events-'));
const workspace = join(directory, 'workspace'); mkdirSync(workspace);
writeFileSync(join(workspace, 'fixture.txt'), 'synthetic-event-fixture-20261017\n');
writeFileSync(join(workspace, 'AGENTS.md'), '# Synthetic acceptance\nOnly read fixture.txt and use the isolated swarmboard_worker MCP tools. Do not access other projects, credentials, resources or environments. Never delegate, deploy, merge or run external services.\n');
const board = new Store(join(directory, 'board.sqlite'));
const runtime = new EventRuntime(board, { databasePath: join(directory, 'board.sqlite'), serverEntry: resolve('dist/server/stdio.js'), fallbackMs: 60000 });
const worker = runtime.register({ name: 'Isolated event acceptance', workspacePath: workspace });
const results = [];
const waitFor = async (description, predicate) => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const state = runtime.workers.get(worker.id);
    if (['error', 'uncertain'].includes(state.status) || state.error) throw new Error(`${description}: ${state.status}: ${state.error}`);
    if (predicate(state)) return state;
    await delay(500);
  }
  throw new Error(`Timed out: ${description}`);
};
try {
  runtime.start();
  const created = board.createTask({ title: 'Synthetic event acceptance', description: 'Only this synthetic task is authorized. Read fixture.txt, claim this task using the stable agentId, publish FACT with summary exactly "live-event:first:synthetic-event-fixture-20261017", then mark this task in_review and end your turn. Do not change files, use other resources or delegate.' });
  const began = Date.now();
  const first = await waitFor('first event', state => state.status === 'idle' && !!state.threadId && board.board().tasks.find(t => t.id === created.id)?.status === 'in_review');
  assert(board.board().entries.some(e => e.kind === 'FACT' && e.summary === 'live-event:first:synthetic-event-fixture-20261017'));
  results.push({ phase: 'task-created', threadId: first.threadId, elapsedMs: Date.now() - began });
  board.registerAgent({ agentId: 'acceptance-peer', name: 'Synthetic acceptance peer' });
  const message = board.publishEntry({ agentId: 'acceptance-peer', kind: 'MESSAGE', recipientId: worker.id, summary: 'Second synthetic event: read fixture.txt again and publish FACT summary exactly "live-event:second:synthetic-event-fixture-20261017". Do not change files. Then end the turn.' });
  const second = await waitFor('second event', state => state.status === 'idle' && state.cursor >= message.id && board.board().entries.some(e => e.kind === 'FACT' && e.summary === 'live-event:second:synthetic-event-fixture-20261017'));
  assert.equal(second.threadId, first.threadId);
  results.push({ phase: 'peer-message', threadId: second.threadId, deliveryCursor: second.cursor });
  const evidence = { passed: true, directory, workerId: worker.id, results, limitations: 'Real local Codex model and MCP; synthetic board/files only. Does not verify external harness GUI, business review, Git merge or production deployment.' };
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
} catch (error) {
  writeFileSync(join(directory, 'failure.json'), JSON.stringify({ error: error.message, worker: runtime.workers.get(worker.id), results }, null, 2));
  console.error(`Live acceptance failed: ${error.message}. Evidence: ${directory}`); process.exitCode = 1;
} finally { await runtime.close(); board.close(); }

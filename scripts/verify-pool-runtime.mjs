// Explicit model acceptance proves peers coordinate through shared context for
// one synthetic human goal, keep human panels clean, and stop automatically.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../dist/server/store.js';
import { EventRuntime } from '../dist/server/event-runtime.js';

if (!process.argv.includes('--live')) throw new Error('This runs three real model peers. Run explicitly with --live.');
const root = mkdtempSync(join(tmpdir(), 'swarmboard-live-pool-'));
const project = join(root, 'project');
execFileSync('git', ['init', project], { stdio: 'ignore' });
writeFileSync(join(project, 'fixture.json'), JSON.stringify({ values: [4, 5, 6], expected: { sum: 15, count: 3 } }));
writeFileSync(join(project, 'AGENTS.md'), '# Synthetic organization acceptance\nOnly inspect fixture.json, coordinate with equal peers using swarmboard_worker MCP and report findings on this synthetic goal. No other projects, credentials, external harnesses, services, file edits or deployments. Never create human task cards or resources. Human acceptance, not a worker, sets the goal done. End when no useful contribution remains; never sleep or poll.\n');
const git = (...args) => execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' });
git('remote','add','origin','https://gitlab.example.invalid/synthetic/project.git');
git('add', 'fixture.json', 'AGENTS.md'); git('-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic pool fixture');
const board = new Store(join(root, 'board.sqlite'));
let pipelineStatus='running',clockOffset=0;
const runtime = new EventRuntime(board, { databasePath: join(root, 'board.sqlite'), serverEntry: resolve('dist/server/stdio.js'), fallbackMs: 60000, keepAlive: true, now:()=>Date.now()+clockOffset, pipelineReader:async watch=>({sha:watch.sha,status:pipelineStatus}) });
let goal;
const snapshots = [];
const waitFor = async (predicate, label, timeout = 240000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const status = runtime.status();
    if (status.error || status.pool?.state === 'error' || status.workers.some(w => w.error || ['error','uncertain'].includes(w.status))) throw new Error(label + ': ' + JSON.stringify(status));
    if (predicate(status)) return status;
    await delay(500);
  }
  throw new Error('Timed out: ' + label);
};
try {
  runtime.configurePool({ workspacePath: project, maxSize:3 }); runtime.start();
  goal = board.createTask({ title: 'Synthetic shared goal', description: 'Work as equal peers, choose complementary useful checks of fixture.json yourselves, and announce scopes with CLAIM in shared context. Never create task/resource cards. Publish concise FACTs with exact verified sum=15/count=3 as relevant. Ask a peer through MESSAGE to cross-check a finding; the recipient should inspect the evidence and publish FACT with summary beginning POOL_PEER_VERIFIED and detail naming the peer agentId and context entry it checked. Do not acknowledge without evidence. At least two different contributors should provide evidence. After useful contributions finish, an active participant may set this single goal in_review; no worker sets done. Before ending, register pipeline_watch for this existing taskId with pipelineId=71 and sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa. The provider is a controlled synthetic fixture, not real GitLab. Do not query any network service. When a later PIPELINE_RESULT event reports pipeline 71 success with that SHA, each peer must publish one OBSERVED with summary CI_PEER_VERIFIED and detail naming that signal entry id, SHA and status; do not re-register the completed subscription or acknowledge peer observations. End turns when no useful work remains; do not sleep or poll.' });
  const status = await waitFor(s => {
    const entries = board.board().entries;
    return s.workers.length === 3 && s.workers.every(w => w.threadId && w.status === 'idle')
      && entries.some(e => e.kind === 'FACT' && e.summary.startsWith('POOL_PEER_VERIFIED'))
      && board.board().tasks[0]?.status === 'in_review' && runtime.ci.list().some(w=>w.pipelineId===71&&w.state==='watching');
  }, 'peer collaboration');
  const first = board.board();
  assert.equal(first.tasks[0].assignee,null);assert(first.tasks[0].participants.length>=2);
  assert.equal(first.tasks.length, 1); assert.equal(first.resources.length, 0);
  assert(new Set(first.entries.filter(e => e.kind === 'CLAIM' && status.workers.some(w => w.id === e.agentId)).map(e => e.agentId)).size >= 2);
  const verified = first.entries.find(e => e.kind === 'FACT' && e.summary.startsWith('POOL_PEER_VERIFIED'));
  assert(status.workers.some(w => w.id !== verified.agentId && verified.detail.includes(w.id)), 'Cross-check must reference another actual peer');
  assert(first.entries.some(e => e.kind === 'MESSAGE' && e.recipientId && status.workers.some(w => w.id === e.recipientId)));
  snapshots.push({ phase: 'cooperated', pool: status.pool, workers: status.workers.map(w => ({ id: w.id, threadId: w.threadId })), entries: first.entries });
  const originalBindings=status.workers.map(w=>[w.id,w.threadId]);
  pipelineStatus='success';clockOffset+=60000;runtime.notify();
  const notified=await waitFor(s=>s.workers.every(w=>w.status==='idle')&&new Set(board.board().entries.filter(e=>e.summary==='CI_PEER_VERIFIED').map(e=>e.agentId)).size===3,'CI broadcast in existing sessions');
  assert.deepEqual(notified.workers.map(w=>[w.id,w.threadId]),originalBindings);
  assert.equal(board.board().entries.filter(e=>e.summary.startsWith('PIPELINE_RESULT')).length,1);
  snapshots.push({phase:'ci-notified',workers:notified.workers.map(w=>({id:w.id,threadId:w.threadId})),entries:board.board().entries});
  board.updateTask(goal.id, { expectedVersion: board.board().tasks[0].version, status: 'done' }); runtime.notify();
  const stopped = await waitFor(s => s.pool?.state === 'completed' && s.workers.every(w => w.status === 'idle'), 'automatic completion stop', 60000);
  const cursor = stopped.workers.map(w => w.cursor); await runtime.scan();
  assert.deepEqual(runtime.status().workers.map(w => w.cursor), cursor);
  assert.equal(board.board().tasks.length, 1); assert.equal(board.board().resources.length, 0);
  snapshots.push({ phase: 'completed', pool: stopped.pool });
  writeFileSync(join(root, 'evidence.json'), JSON.stringify({ passed: true, snapshots, limitations: 'Three actual Codex peers, separate Git checkouts, one synthetic goal. CI provider is controlled; proves real models resume original sessions on shared CI evidence, not real GitLab availability, business/production delivery or exhaustive crash recovery.' }, null, 2));
  console.log(JSON.stringify({ passed: true, root, workers: snapshots[0].workers, stopped: stopped.pool.state }));
} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ error: error.message, runtime: runtime.status(), board: board.board(), snapshots }, null, 2));
  console.error(`Pool acceptance failed: ${error.message}. Evidence: ${root}`); process.exitCode = 1;
} finally { await runtime.close(); board.close(); /* Keep evidence and checkouts for inspection. */ }

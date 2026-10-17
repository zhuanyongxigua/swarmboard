// Exercise later human goals in a real peer organization without prescribing
// worker roles, goal ordering, or per-worker task quotas. Never use the live board.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../dist/server/store.js';
import { EventRuntime } from '../dist/server/event-runtime.js';
import { CodexSession } from '../dist/server/codex-session.js';

if (!process.argv.includes('--live')) throw new Error('Explicit --live required for three real model peers.');
const resumeAt = process.argv.indexOf('--resume');
const prior = resumeAt < 0 ? null : JSON.parse(readFileSync(join(process.argv[resumeAt + 1], 'evidence.json'), 'utf8'));
const root = realpathSync(prior?.root ?? mkdtempSync(join(tmpdir(), 'swarmboard-open-organization-')));
assert(root.startsWith(realpathSync(tmpdir()) + '/swarmboard-open-organization-'), 'Only this synthetic fixture can be resumed');
const project = join(root, 'project');
if (!prior) {
execFileSync('git', ['init', project], { stdio: 'ignore' });
writeFileSync(join(project, 'fixture.json'), JSON.stringify({ values: [4, -2, 6, 0], labels: ['a', 'b', 'a'] }));
writeFileSync(join(project, 'AGENTS.md'), '# Isolated organization acceptance\nOnly inspect fixture.json and use swarmboard_worker MCP to contribute to these synthetic human goals. Choose work and collaborators yourselves. No other projects, network services, credentials, deployments, external harnesses, file edits, or new human task/resource cards. Do not mark goals done: the human acceptance driver does that. Use in_review when evidence supports acceptance. End when no useful contribution remains; do not sleep or poll.\n');
const git = (...args) => execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' });
git('add', 'fixture.json', 'AGENTS.md');
git('-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic open organization fixture');
}
const path = join(root, 'board.sqlite');
const board = new Store(path);
const bindings = new Map(prior?.bindings.map(w => [w.id, w.threadId]) ?? []), turns = prior?.turns ?? [], closed = [], phases = prior?.phases ?? [];
let runtime;
const evidence = { root, passed: false, bindings: [], phases, turns, limitations: 'Real models and MCP in an isolated board. No centrally assigned roles or goal sequence; not production acceptance, Explorer visibility, or paper-scale replication.' };
const save = () => { evidence.bindings = [...bindings].map(([id, threadId]) => ({ id, threadId })); writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); };
runtime = new EventRuntime(board, { databasePath: path, serverEntry: resolve('dist/server/stdio.js'), keepAlive: true,
  adapter: worker => {
    const adapter = new CodexSession({ databasePath: path, serverEntry: resolve('dist/server/stdio.js'), workerId: worker.id, poolMember: true });
    return {
      open: async w => { const id = await adapter.open(w); bindings.set(w.id, id); save(); return id; },
      run: async (threadId, prompt, onStarted) => {
        const turn = { workerId: worker.id, threadId, goalIds: board.board().tasks.filter(t => prompt.includes(t.id)).map(t => t.id), started: false, completed: false };
        turns.push(turn); save();
        await adapter.run(threadId, prompt, turnId => { turn.turnId = turnId; turn.started = true; save(); onStarted(turnId); });
        turn.completed = true; save();
      },
      inspect: (...args) => adapter.inspect(...args),
      close: async () => { await adapter.close(); closed.push(worker.id); },
    };
  },
});
const wait = async (predicate, label, timeout = 600000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = runtime.status();
    if (state.error || state.workers.some(w => w.error || ['error', 'uncertain'].includes(w.status))) throw new Error(label + ': runtime failure');
    if (predicate(state)) return state;
    await delay(200);
  }
  throw new Error('Timeout: ' + label);
};
const create = (title, acceptanceCriteria) => board.createTask({ title, description: 'Inspect fixture.json. Choose useful scopes and collaborators yourselves across current goals, publish scoped CLAIM and verified shared evidence, resolve overlaps through messages where useful, and integrate evidence for acceptance. There are no assigned roles, task quotas or required goal order. Human acceptance marks done.', acceptanceCriteria });
try {
  let first, second, third;
  if (prior) {
    const pool = runtime.workers.pool();
    runtime.controlPool({ expectedVersion: pool.version, enabled: false });
    for (const w of runtime.workers.list()) if (w.status === 'uncertain') runtime.requestReconcile({ id: w.id, expectedVersion: w.version });
    await runtime.scan();
    const deadline = Date.now() + 60000;
    while (runtime.workers.list().some(w => w.status === 'uncertain') && Date.now() < deadline) await delay(200);
    assert(runtime.workers.list().every(w => ['error', 'idle'].includes(w.status)), 'Inspect unresolved synthetic turns before any retry');
    for (const w of runtime.workers.list()) if (w.status === 'error') runtime.update({ id: w.id, expectedVersion: w.version, enabled: true });
    runtime.controlPool({ expectedVersion: runtime.workers.pool().version, enabled: true });
    [first, second, third] = ['Synthetic numerical properties', 'Synthetic signed values', 'Synthetic label properties'].map(title => board.board().tasks.find(t => t.title === title));
    assert(first && second && third); phases.push({ phase: 'resumed-original-sessions-after-inspection', priorError: prior.error });
    runtime.start();
  } else {
  runtime.configurePool({ workspacePath: project, maxSize: 3 }); runtime.start();
  first = create('Synthetic numerical properties', 'Verify sum=8, count=4 and bounds [-2,6] against the actual fixture. Evidence may be assembled from independently chosen contributions.');
  await wait(() => new Set(turns.filter(t => t.started).map(t => t.workerId)).size === 3 && turns.some(t => t.started && !t.completed), 'initial real turns started');
  second = create('Synthetic signed values', 'Verify two positive values, one negative and one zero against the actual fixture.');
  third = create('Synthetic label properties', 'Verify three labels, two distinct labels and repeated label a against the actual fixture.');
  phases.push({ phase: 'goals-added-during-real-turns', activeTurns: turns.filter(t => t.started && !t.completed).length, firstStatus: board.board().tasks.find(t => t.id === first.id).status }); save();
  }
  const collaborated = await wait(s => s.workers.length === 3 && s.workers.every(w => w.status === 'idle') && board.board().tasks.every(t => t.status === 'in_review')
    && new Set(board.board().tasks.flatMap(t => t.participants)).size >= 2 && board.board().tasks.some(t => t.participants.length >= 2)
    && [first, second, third].every(g => board.board().entries.some(e => e.taskId === g.id && e.kind === 'FACT')), 'self-organized contributions across later goals');
  assert.equal(board.board().tasks.length, 3); assert.equal(board.board().resources.length, 0);
  for (const worker of collaborated.workers) for (const goal of [second, third]) assert(turns.some(t => t.workerId === worker.id && t.goalIds.includes(goal.id)), 'Every peer must receive each later goal');
  const original = [...bindings];
  phases.push({ phase: 'collaborated', tasks: board.board().tasks, entries: board.board().entries }); save();
  for (const goal of board.board().tasks) board.updateTask(goal.id, { expectedVersion: goal.version, status: 'done' });
  await wait(s => s.pool?.state === 'completed' && s.workers.every(w => w.status === 'idle') && closed.length >= 3, 'automatic stop after all goals');
  phases.push({ phase: 'completed', bindings: [...bindings] }); save();
  const fourth = create('Synthetic goal after completion', 'Re-check that fixture values sum to 8. Publish verified evidence and submit for human acceptance.');
  await wait(s => s.workers.every(w => w.status === 'idle') && board.board().tasks.find(t => t.id === fourth.id)?.status === 'in_review'
    && collaborated.workers.every(w => turns.some(t => t.workerId === w.id && t.goalIds.includes(fourth.id))), 'new goal reuses every existing peer');
  assert.deepEqual([...bindings], original); assert.equal(board.board().tasks.length, 4); assert.equal(board.board().resources.length, 0);
  const latest = board.board().tasks.find(t => t.id === fourth.id); board.updateTask(fourth.id, { expectedVersion: latest.version, status: 'done' });
  await wait(s => s.pool?.state === 'completed' && s.workers.every(w => w.status === 'idle'), 'final completion');
  evidence.passed = true; phases.push({ phase: 'reused-and-stopped', tasks: board.board().tasks }); save();
  console.log(JSON.stringify({ root, passed: true, bindings: evidence.bindings, goals: 4, phases: phases.map(p => p.phase) }));
} catch (error) {
  evidence.error = error.message; save();
  console.error(JSON.stringify({ root, passed: false, error: error.message, bindings: evidence.bindings })); process.exitCode = 1;
} finally { await runtime.close(); board.close(); save(); }

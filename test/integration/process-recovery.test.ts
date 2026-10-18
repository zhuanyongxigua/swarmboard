// Kill independent runtime processes at execution boundaries and compare their
// durable checkpoints with a separate, non-deduplicating side-effect ledger.
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { WorkerStore, type Worker } from '../../src/worker-store.js';
import { WorkerPool } from '../../src/worker-pool.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until<T>(read: () => T, accept: (value: T) => boolean, label: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms; let value = read();
  while (!accept(value) && Date.now() < end) { await delay(15); value = read(); }
  if (!accept(value)) throw new Error(`${label}: ${JSON.stringify(value)}`);
  return value;
}
class ProcessPeer {
  child: ChildProcess;
  events: any[] = [];
  stderr = '';
  sequence = 0;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(path: string, ledger: string, batchMs?: number) {
    this.child = fork(resolve('test/fixtures/runtime-process.ts'), [path, ledger], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SWARMBOARD_DISABLE_RUNTIME: '1', ...(batchMs === undefined ? {} : { SWARMBOARD_TEST_BATCH_MS: String(batchMs) }) },
    });
    this.child.stderr!.on('data', chunk => { this.stderr += chunk.toString(); });
    this.child.on('message', (message: any) => {
      this.events.push(message); const pending = this.pending.get(message.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result); }
    });
    this.child.on('exit', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Fixture exited: ' + this.stderr)); } this.pending.clear(); });
  }
  async ready() { await until(() => this.events, xs => xs.some(e => e.ready), 'fixture ready: ' + this.stderr); return this; }
  request(command: string, args: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Fixture ${command} timed out: ${this.stderr}`)); }, 8000);
      this.pending.set(id, { resolve, reject, timer }); this.child.send({ id, command, ...args });
    });
  }
  async kill() {
    if (this.child.exitCode !== null || this.child.signalCode) return;
    const exited = once(this.child, 'exit'); this.child.kill('SIGKILL'); await exited;
    expect(this.child.signalCode).toBe('SIGKILL');
  }
}
function fixture(pool = false) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-process-recovery-'));
  const path = join(dir, 'board.sqlite'), ledgerPath = join(dir, 'external.sqlite');
  const board = new Store(path), workers = new WorkerStore(path + '.runtime.sqlite'), ledger = new DatabaseSync(ledgerPath);
  ledger.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE submissions(deliveryId TEXT,workerId TEXT,threadId TEXT,turnId TEXT,status TEXT,pid INTEGER);
    CREATE TABLE effects(workerId TEXT,eventId INTEGER,deliveryId TEXT,pid INTEGER);`);
  const organization = new WorkerPool(workers, board, path);
  if (pool) organization.configure({ workspacePath: dir });
  else { const w = workers.register({ name: 'Synthetic worker', workspacePath: dir }); board.registerAgent({ agentId: w.id, name: w.name }); }
  board.registerAgent({ agentId: 'synthetic-peer', name: 'Synthetic peer' });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => { ledger.close(); workers.close(); board.close(); });
  const spawn = async (batchMs?: number) => { const peer = new ProcessPeer(path, ledgerPath, batchMs); cleanups.push(() => peer.kill()); return peer.ready(); };
  const effects = () => ledger.prepare('SELECT workerId,eventId,deliveryId,pid FROM effects ORDER BY rowid').all();
  const count = () => Number(ledger.prepare('SELECT count(*) AS n FROM submissions').get()!.n);
  const idle = () => workers.list().every(w => w.status === 'idle');
  const message = (worker: Worker, summary = 'same payload') => board.publishEntry({ agentId: 'synthetic-peer', recipientId: worker.id, kind: 'MESSAGE', summary });
  return { dir, path, board, workers, ledger, organization, spawn, effects, count, idle, message };
}

describe.skipIf(process.platform === 'win32')('real process fault recovery', () => {
  it('survives actual SIGKILL during a notification window and delivers each queued event once to every original peer', async () => {
    const f = fixture(true), goal = f.board.createTask({ title: 'Goal for notification recovery' });
    const first = await f.spawn(1500); await first.request('start');
    await until(f.count, n => n === 3, 'initial peers'); await until(f.idle, Boolean, 'initial idle');
    const original = f.workers.list().map(w => [w.id, w.threadId, w.cursor]);
    const event = f.board.publishEntry({ agentId: 'synthetic-peer', taskId: goal.id, kind: 'FACT', summary: 'Evidence before a real crash' });
    await first.request('scan');
    expect((await first.request('stats')).notifications.nextWakeAt).not.toBeNull();
    expect(f.count()).toBe(3);
    await first.kill();
    expect(f.workers.list().map(w => [w.id, w.threadId, w.cursor])).toEqual(original);
    const second = await f.spawn(1500); await second.request('start');
    await until(f.count, n => n === 6, 'recovered batch'); await until(f.idle, Boolean, 'recovered idle');
    expect(f.effects().filter(e => e.eventId === event.id).map(e => e.workerId).sort()).toEqual(original.map(w => w[0]).sort());
    expect(f.workers.list().map(w => [w.id, w.threadId])).toEqual(original.map(w => w.slice(0, 2)));
    await second.request('scan'); expect(f.count()).toBe(6);
  });
  it('recovers an actual SIGKILL during resume without advancing events or duplicating a model submission', async () => {
    const f = fixture(); f.board.createTask({ title: 'Synthetic goal' });
    const original = f.workers.list()[0]!;
    f.workers.save({ ...original, threadId: 'original-thread' });
    const first = await f.spawn(); await first.request('start', { gate: 'during-resume' });
    await until(() => first.events, xs => xs.some(e => e.phase === 'during-resume'), 'resume reached');
    expect(f.workers.get(original.id).deliveryPhase).toBe('opening');
    await first.kill(); const second = await f.spawn(); await second.request('start');
    const recovered = await until(() => f.workers.get(original.id), w => w.status === 'error', 'pre-submission failure recovered');
    expect(recovered).toMatchObject({ threadId: 'original-thread', cursor: 0, turnId: null });
    expect(f.count()).toBe(0); expect(f.effects()).toHaveLength(0);
    f.workers.update({ id: original.id, expectedVersion: recovered.version, enabled: true });
    await until(() => f.count() === 1 && f.idle(), Boolean, 'explicit continuation completes');
    expect(f.workers.get(original.id).threadId).toBe('original-thread');
    expect(f.workers.get(original.id).deliveryPhase).toBeUndefined();
    expect(f.effects()).toHaveLength(1);
  });
  it.each(['before-signal', 'after-signal'])('recovers one CI result after SIGKILL at %s and wakes every original peer once', async gate => {
    const f = fixture(true);
    execFileSync('git',['init',f.dir],{stdio:'ignore'});execFileSync('git',['-C',f.dir,'remote','add','origin','https://gitlab.example.invalid/group/project.git']);
    f.board.createTask({title:'CI-gated synthetic goal'});
    const first=await f.spawn();await first.request('start',{gate});
    await until(()=>f.count()===3&&f.idle(),Boolean,'initial peers idle');
    const identities=f.workers.list().map(w=>[w.id,w.threadId]);
    await first.request('watch-ci');await until(()=>existsSync(f.ledger.location()+'.signal-gate'),Boolean,'CI outbox boundary');
    await first.kill();const second=await f.spawn();await second.request('start');
    await until(()=>f.count()===6&&f.idle(),Boolean,'all peers receive CI result');
    const signals=f.board.board().entries.filter(e=>e.summary.startsWith('PIPELINE_RESULT'));
    expect(signals).toHaveLength(1);expect(f.effects().filter(e=>e.eventId===signals[0]!.id)).toHaveLength(3);
    expect(f.workers.list().map(w=>[w.id,w.threadId])).toEqual(identities);
    await second.request('scan');expect(f.count()).toBe(6);expect(f.board.board().tasks[0]!.status).toBe('todo');
  });
  it.each(['before-signal', 'after-signal'])('recovers one idle wakeup after SIGKILL at %s without creating new sessions or duplicate messages', async gate => {
    const f = fixture(true); f.board.createTask({ title: 'Stranded human goal' });
    const first = await f.spawn(); await first.request('start', { gate });
    await until(() => f.count() === 3 && f.idle() && f.workers.liveness()?.idleSince === 1000, Boolean, 'initial peers idle');
    const identities = f.workers.list().map(w => [w.id, w.threadId]);
    await first.request('advance');
    await until(() => existsSync(f.ledger.location() + '.signal-gate'), Boolean, 'durable signal boundary');
    expect(f.workers.liveness()?.pending).toBeTruthy();
    await first.kill(); const second = await f.spawn(); await second.request('start');
    await until(() => f.count() === 4 && f.idle(), Boolean, 'one recovery turn');
    await until(() => f.workers.liveness()?.pending === null, Boolean, 'outbox acknowledged');
    const signals = f.board.board().entries.filter(e => e.summary.startsWith('IDLE_RECOVERY'));
    expect(signals).toHaveLength(1);
    expect(f.effects().filter(e => e.eventId === signals[0]!.id)).toHaveLength(1);
    expect(f.workers.list().map(w => [w.id, w.threadId])).toEqual(identities);
    expect(f.board.board().tasks).toHaveLength(1); expect(f.board.board().resources).toHaveLength(0);
  });
  it.each(['before-ack', 'after-ack'])('recovers completed effects after SIGKILL at %s without executing them twice', async gate => {
    const f = fixture(); const goal = f.board.createTask({ title: 'Synthetic goal' });
    const first = await f.spawn(); await first.request('start', { gate });
    await until(f.count, n => n === 1, 'external effect committed');
    await until(() => first.events, xs => xs.some(e => e.phase === (gate === 'before-ack' ? 'before-ack' : 'effect')), 'acknowledgement boundary');
    const pending = f.workers.list()[0]!;
    expect(pending).toMatchObject({ status: 'running', cursor: 0 });
    expect(pending.turnId === null).toBe(gate === 'before-ack');
    await first.kill(); const second = await f.spawn(); await second.request('start');
    await until(() => f.workers.get(pending.id), w => w.status === 'idle' && !w.deliveryId, 'completed receipt reconciled');
    expect(f.count()).toBe(1); expect(f.effects().map(e => e.eventId)).toContain(f.board.board().entries.find(e => e.taskId === goal.id)!.id);
    expect(f.workers.get(pending.id)).toMatchObject({ cursor: pending.deliveryCursor, threadId: pending.threadId });
    const later = f.message(pending); await until(f.effects, xs => xs.some(e => e.eventId === later.id), 'later event delivered');
    expect(f.count()).toBe(2); expect(new Set(f.ledger.prepare('SELECT threadId FROM submissions').all().map(r => r.threadId)).size).toBe(1);
  });

  it('keeps a pre-execution crash uncertain and never invents a successful result', async () => {
    const f = fixture(); f.board.createTask({ title: 'Synthetic goal' });
    const first = await f.spawn(); await first.request('start', { gate: 'before-effect' });
    await until(() => first.events, xs => xs.some(e => e.phase === 'before-effect'), 'before execution gate');
    await first.kill(); const second = await f.spawn(); await second.request('start');
    await until(() => f.workers.list()[0]!, w => w.status === 'uncertain', 'ambiguous delivery retained');
    const w = f.workers.list()[0]!; f.message(w); await second.request('scan');
    expect(f.count()).toBe(0); expect(f.effects()).toHaveLength(0); expect(w.cursor).toBe(0);
    expect(() => f.workers.update({ id: w.id, expectedVersion: w.version, enabled: true })).toThrow(/Inspect/);
    expect(f.board.board().tasks[0]!.status).toBe('todo');
  });

  it('retains active and unavailable receipts until explicit reconciliation proves completion', async () => {
    const f = fixture(); f.board.createTask({ title: 'Synthetic goal' });
    const first = await f.spawn(); await first.request('start', { gate: 'after-ack', outcome: 'active' });
    await until(f.count, n => n === 1, 'accepted turn'); await first.kill();
    const second = await f.spawn(); await second.request('start');
    await until(() => f.workers.list()[0]!, w => w.status === 'uncertain', 'active execution remains uncertain');
    let w = f.workers.list()[0]!;
    f.ledger.prepare("UPDATE submissions SET status='unknown'").run();
    f.workers.requestReconcile({ id: w.id, expectedVersion: w.version }); await second.request('scan');
    await until(() => f.workers.get(w.id), s => !s.reconcileRequested, 'unknown receipt inspected');
    expect(f.workers.get(w.id).status).toBe('uncertain'); expect(f.count()).toBe(1);
    f.ledger.prepare("UPDATE submissions SET status='completed'").run(); w = f.workers.get(w.id);
    f.workers.requestReconcile({ id: w.id, expectedVersion: w.version }); await second.request('scan');
    await until(f.idle, Boolean, 'later confirmed completion'); expect(f.count()).toBe(1);
  });

  it('arbitrates independent runtime processes and hands over after the owner dies', async () => {
    const f = fixture(); f.board.createTask({ title: 'Synthetic goal' });
    const peers = await Promise.all([f.spawn(), f.spawn(), f.spawn()]);
    await Promise.all(peers.map(p => p.request('start', { gate: 'after-ack' })));
    await until(f.count, n => n === 1, 'one owner submits');
    const pid = Number(f.workers.owner()!.pid), owner = peers.find(p => p.child.pid === pid)!;
    expect(owner).toBeDefined();
    await Promise.all(peers.map(p => p.request('scan'))); expect(f.count()).toBe(1);
    const survivors = peers.filter(p => p !== owner);
    await owner.request('suspend');
    await Promise.all(survivors.map(p => p.request('scan')));
    expect(f.workers.owner()!.pid).toBe(pid); expect(f.count()).toBe(1);
    await owner.kill();
    await until(f.idle, Boolean, 'surviving runtime reconciles'); expect(f.count()).toBe(1);
    await Promise.all(survivors.map(p => p.request('drain')));
    const message = f.message(f.workers.list()[0]!);
    await until(f.effects, xs => xs.some(e => e.eventId === message.id), 'new owner continues');
    expect(f.count()).toBe(2);
    expect(f.effects().filter(e => e.eventId === message.id)).toHaveLength(1);
    expect(f.workers.owner()!.pid).not.toBe(pid);
  });

  it('does not automatically retry a failed turn that has already produced partial effects', async () => {
    const f = fixture(); f.board.createTask({ title: 'Synthetic goal' });
    const first = await f.spawn(); await first.request('start', { gate: 'after-ack', outcome: 'failed' });
    await until(f.count, n => n === 1, 'partial effect committed'); await first.kill();
    const second = await f.spawn(); await second.request('start');
    await until(() => f.workers.list()[0]!, w => w.status === 'error', 'failure requires inspection');
    f.message(f.workers.list()[0]!); await second.request('scan');
    expect(f.count()).toBe(1); expect(f.workers.list()[0]!.error).toContain('inspect');
    expect(f.board.board().tasks[0]!.status).toBe('todo');
  });

  it.each(['completed', 'active'])('preserves an approval pause with %s receipt through death, reconciliation and resume', async outcome => {
    const f = fixture(); f.board.createTask({ title: 'Synthetic goal' });
    const first = await f.spawn(); await first.request('start', { gate: 'approval', outcome });
    await until(() => f.workers.list()[0]!, w => !w.enabled, 'approval pauses worker');
    await first.kill(); const second = await f.spawn(); await second.request('start');
    if (outcome === 'active') {
      const uncertain = await until(() => f.workers.list()[0]!, w => w.status === 'uncertain' && w.error.includes('Prior delivery'), 'active paused execution inspected');
      expect(uncertain.error).toContain('Human approval');
      f.ledger.prepare("UPDATE submissions SET status='completed'").run();
      f.workers.requestReconcile({ id: uncertain.id, expectedVersion: uncertain.version }); await second.request('scan');
    }
    await until(f.idle, Boolean, 'completed paused turn reconciled');
    const paused = f.workers.list()[0]!; expect(paused.enabled).toBe(false);
    expect(paused.error).toContain('Human approval');
    expect(paused.error).not.toContain('Prior delivery');
    const message = f.message(paused); await second.request('scan'); expect(f.count()).toBe(1);
    f.workers.update({ id: paused.id, expectedVersion: paused.version, enabled: true });
    await until(f.effects, xs => xs.some(e => e.eventId === message.id), 'explicitly resumed');
    expect(f.count()).toBe(2); expect(f.workers.list()[0]!.threadId).toBe(paused.threadId);
  });

  it.each(['human-stop', 'all-done'])('retains %s across three active peer crashes and ignores late messages', async reason => {
    const f = fixture(true); const goal = f.board.createTask({ title: 'Shared human goal' });
    const first = await f.spawn(); await first.request('start', { gate: 'after-ack' });
    await until(f.count, n => n === 3, 'three peers accepted');
    const peers = f.workers.list(), ids = peers.map(w => [w.id, w.threadId]);
    if (reason === 'human-stop') f.organization.control({ expectedVersion: 1, enabled: false });
    else f.board.updateTask(goal.id, { expectedVersion: 1, status: 'done' });
    for (const w of peers) f.message(w, 'Late queued message must not revive stopped peers');
    await first.kill(); const second = await f.spawn(); await second.request('start');
    await until(() => f.workers.pool()!, p => p.state === (reason === 'human-stop' ? 'stopped' : 'completed'), 'organization settles after recovery');
    for (const w of peers) f.message(w, 'Another event after the organization stopped');
    await second.request('scan');
    expect(f.count()).toBe(3); expect(f.workers.list().map(w => [w.id, w.threadId])).toEqual(ids);
    if (reason === 'human-stop') f.organization.control({ expectedVersion: 2, enabled: true });
    else f.board.createTask({ title: 'Next human goal' });
    await until(f.count, n => n > 3, 'same peers resume new work');
    await until(f.idle, Boolean, 'resumed peers finish');
    expect(f.workers.list().map(w => [w.id, w.threadId])).toEqual(ids);
    expect(f.board.board().resources).toHaveLength(0); expect(f.board.board().tasks).toHaveLength(reason === 'human-stop' ? 1 : 2);
  });

  it('does not turn idle filesystem notifications into a self-waking scan loop', async () => {
    const f = fixture(); f.board.createTask({ title: 'Synthetic goal' });
    const peer = await f.spawn(); await peer.request('start');
    await until(() => f.count() === 1 && f.idle(), Boolean, 'initial turn finished');
    const before = await peer.request('stats'); await delay(350); const after = await peer.request('stats');
    expect(after.scans - before.scans).toBeLessThan(12); expect(f.count()).toBe(1);
  });

  it('does not report fully stopped while a crashed peer still has an unresolved active execution', async () => {
    const f = fixture(true); f.board.createTask({ title: 'Shared human goal' });
    const first = await f.spawn(); await first.request('start', { gate: 'after-ack', outcome: 'active' });
    await until(f.count, n => n === 3, 'three active external executions');
    f.organization.control({ expectedVersion: 1, enabled: false }); await first.kill();
    const second = await f.spawn(); await second.request('start');
    await until(() => f.workers.list(), ws => ws.every(w => w.status === 'uncertain'), 'unresolved peers inspected');
    expect(f.workers.pool()!.state).toBe('stopping');
    const last = f.workers.list()[0]!;
    f.ledger.prepare("UPDATE submissions SET status='completed' WHERE workerId<>?").run(last.id);
    for (const w of f.workers.list()) f.workers.requestReconcile({ id: w.id, expectedVersion: w.version });
    await second.request('scan');
    await until(() => f.workers.list(), ws => ws.filter(w => w.status === 'idle').length === 2, 'two peers settled');
    expect(f.workers.pool()!.state).toBe('stopping'); expect(f.count()).toBe(3);
    f.ledger.prepare("UPDATE submissions SET status='completed' WHERE workerId=?").run(last.id);
    const unresolved = f.workers.get(last.id);
    f.workers.requestReconcile({ id: unresolved.id, expectedVersion: unresolved.version }); await second.request('scan');
    await until(() => f.workers.pool()!.state, s => s === 'stopped', 'last peer settled');
    expect(f.count()).toBe(3);
  });

  it('survives a bounded fault sequence with multiple peers, repeated notifications and paged event bursts', async () => {
    const rounds = Number(process.env.SWARMBOARD_FAULT_ROUNDS ?? 5);
    if (!Number.isInteger(rounds) || rounds < 3 || rounds > 100) throw new Error('SWARMBOARD_FAULT_ROUNDS must be 3..100');
    const f = fixture(true); f.board.createTask({ title: 'Shared human goal' });
    let processes: ProcessPeer[] = await Promise.all([f.spawn(), f.spawn()]); await Promise.all(processes.map(p => p.request('start')));
    await until(() => f.workers.list(), ws => ws.length === 3 && f.idle() && f.count() === 3, 'initial peers completed');
    const ids = f.workers.list().map(w => [w.id, w.threadId]);
    const expected: { workerId: string; eventId: number }[] = [];
    for (let round = 0; round < rounds; round++) {
      const before = f.count();
      await Promise.all(processes.map(p => p.request('start', { gate: 'after-ack' })));
      for (let n = 0; n < 160; n++) {
        const w = f.workers.list()[(n + round) % 3]!;
        const entry = f.message(w, 'Repeated payload with distinct durable IDs'); expected.push({ workerId: w.id, eventId: entry.id });
      }
      for (const kind of ['FACT', 'FAIL'] as const) {
        const entry = f.board.publishEntry({ agentId: 'synthetic-peer', kind, summary: 'Reusable burst finding ' + round });
        for (const w of f.workers.list()) expected.push({ workerId: w.id, eventId: entry.id });
      }
      await Promise.all(processes.map(p => p.request('notify')));
      await until(f.count, n => n === before + 3, 'all peers reach the durable fault boundary');
      const owner = processes.find(p => p.child.pid === Number(f.workers.owner()!.pid))!;
      await owner.kill(); processes = processes.filter(p => p !== owner);
      await Promise.all(processes.map(p => p.request('drain')));
      const next = await f.spawn(); processes.push(next); await next.request('start');
      // Completion receipts permit safe reconciliation; each event must occur
      // once per intended recipient, regardless of duplicated wake notifications.
      await until(() => {
        const seen = new Set(f.effects().map(e => `${e.workerId}:${e.eventId}`));
        return expected.filter(x => !seen.has(`${x.workerId}:${x.eventId}`)).length;
      }, n => n === 0, 'all burst events delivered', 15000);
      await until(f.idle, Boolean, 'burst drained');
      expect(f.ledger.prepare('SELECT workerId,eventId,count(*) AS n FROM effects GROUP BY workerId,eventId HAVING count(*)<>1').all()).toEqual([]);
      expect(f.workers.list().map(w => [w.id, w.threadId])).toEqual(ids);
      expect(f.board.board().tasks).toHaveLength(1); expect(f.board.board().resources).toHaveLength(0);
    }
    expect(expected).toHaveLength(rounds * 166);
    expect(f.effects()).toHaveLength(3 + expected.length);
  }, 120000);
});

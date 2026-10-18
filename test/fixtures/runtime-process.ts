// Exercise the real runtime in a killable OS process. The synthetic external
// ledger survives SIGKILL and deliberately counts duplicate execution attempts.
import { DatabaseSync } from 'node:sqlite';
import { EventRuntime } from '../../src/event-runtime.js';
import { Store, type Entry } from '../../src/store.js';
import type { Worker } from '../../src/worker-store.js';
import { writeFileSync } from 'node:fs';

const [databasePath, ledgerPath] = process.argv.slice(2) as [string, string];
const board = new Store(databasePath);
const ledger = new DatabaseSync(ledgerPath);
ledger.exec('PRAGMA busy_timeout=5000;');
type Gate = 'none' | 'during-resume' | 'before-effect' | 'before-ack' | 'after-ack' | 'approval' | 'before-signal' | 'after-signal';
let gate: Gate = 'none', outcome = 'completed', scans = 0, now = 1000;
const publishSignal = board.publishSystemEntryOnce.bind(board);
board.publishSystemEntryOnce = input => {
  const crashBoundary = () => {
    writeFileSync(ledgerPath + '.signal-gate', gate);
    // Block exactly inside this synchronous commit boundary. The parent really
    // kills the process; no graceful teardown can fill in the missing receipt.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  };
  if (gate === 'before-signal') crashBoundary();
  const event = publishSignal(input);
  if (gate === 'after-signal') crashBoundary();
  return event;
};
const waiting = new Map<string, () => void>();
const send = (value: unknown) => process.send?.(value);
const wait = (key: string) => new Promise<void>(resolve => { waiting.set(key, resolve); });
const runtime = new EventRuntime(board, { notificationBatchMs: Number(process.env.SWARMBOARD_TEST_BATCH_MS ?? 0),
  databasePath, serverEntry: 'never-start-a-real-model', keepAlive: true, fallbackMs: 100, debounceMs: 5,
  now: process.env.SWARMBOARD_TEST_BATCH_MS ? () => Date.now() : () => now, idleMs: process.env.SWARMBOARD_TEST_BATCH_MS ? 60000 : 100,
  pipelineReader: async watch => ({ sha: watch.sha, status: 'success' }),
  adapter: worker => ({
    open: async (w: Worker) => {
      if (gate === 'during-resume') { send({ phase: 'during-resume', workerId: worker.id }); await wait('resume-' + worker.id); }
      return w.threadId ?? 'synthetic-thread-' + w.id;
    },
    run: async (threadId, prompt, started) => {
      const deliveryId = /Swarmboard delivery ([^. ]+)\./.exec(prompt)![1]!;
      const turnId = 'synthetic-turn-' + deliveryId;
      const events = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)) as Entry[];
      if (gate === 'before-effect') { send({ phase: 'before-effect', workerId: worker.id, deliveryId }); await wait(deliveryId); }
      // Model one atomic external operation: its receipt may only report
      // completion when every counted effect is durable in the independent DB.
      ledger.exec('BEGIN IMMEDIATE');
      try {
        ledger.prepare('INSERT INTO submissions(deliveryId,workerId,threadId,turnId,status,pid) VALUES(?,?,?,?,?,?)')
          .run(deliveryId, worker.id, threadId, turnId, outcome, process.pid);
        for (const event of events) ledger.prepare('INSERT INTO effects(workerId,eventId,deliveryId,pid) VALUES(?,?,?,?)').run(worker.id, event.id, deliveryId, process.pid);
        ledger.exec('COMMIT');
      } catch (error) { ledger.exec('ROLLBACK'); throw error; }
      if (gate === 'before-ack') { send({ phase: 'before-ack', workerId: worker.id, deliveryId }); await wait(deliveryId); }
      started(turnId);
      if (gate === 'approval') runtime.workers.pauseForApproval(worker.id);
      send({ phase: 'effect', workerId: worker.id, deliveryId });
      if (gate === 'after-ack' || gate === 'approval') await wait(deliveryId);
    },
    inspect: async (threadId, turnId, deliveryId) => {
      const row = ledger.prepare('SELECT status FROM submissions WHERE deliveryId=? AND threadId=? AND (? IS NULL OR turnId=?) ORDER BY rowid DESC LIMIT 1').get(deliveryId, threadId, turnId, turnId);
      send({ phase: 'inspect', workerId: worker.id, deliveryId });
      return (row?.status ?? 'unknown') as 'completed' | 'failed' | 'active' | 'unknown';
    },
    close: async () => { for (const finish of waiting.values()) finish(); waiting.clear(); },
  }),
});
const scan = runtime.scan.bind(runtime);
runtime.scan = async () => { scans++; await scan(); };
let started = false;
process.on('message', (message: { id: number; command: string; gate?: Gate; outcome?: string; ms?: number }) => {
  void (async () => {
    if (message.command === 'suspend') {
      // Stop between callbacks, never while holding a SQLite transaction.
      process.send?.({ id: message.id, result: true }, () => { process.kill(process.pid, 'SIGSTOP'); });
      return;
    }
    if (message.command === 'start') {
      gate = message.gate ?? 'none'; outcome = message.outcome ?? 'completed';
      if (!started) { runtime.start(); started = true; }
    } else if (message.command === 'watch-ci') {
      runtime.ci.register({ taskId: board.board().tasks[0]!.id, pipelineId: 100, sha: 'a'.repeat(40) }); runtime.notify();
    } else if (message.command === 'advance') { now += message.ms ?? 100; runtime.notify(); }
    else if (message.command === 'notify') { for (let n = 0; n < 30; n++) runtime.notify(); }
    else if (message.command === 'drain') { gate = 'none'; for (const finish of waiting.values()) finish(); waiting.clear(); }
    else if (message.command === 'scan') await runtime.scan();
    else if (message.command === 'close') { await runtime.close(); ledger.close(); board.close(); }
    send({ id: message.id, result: message.command === 'stats' ? { scans, notifications: runtime.status().notifications } : true });
    if (message.command === 'close') process.disconnect?.();
  })().catch(error => send({ id: message.id, error: String(error) }));
});
send({ ready: true, pid: process.pid });

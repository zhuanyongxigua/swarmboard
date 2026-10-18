// Measure the real adapter's concurrent session startup on an explicitly
// paused organization without submitting model turns or editing checkpoints.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { CodexSession } from '../dist/server/codex-session.js';

const [flag, databasePath, entry] = process.argv.slice(2);
assert.equal(flag, '--live', 'Explicit --live and database/server paths are required');
assert(databasePath && entry, 'Pass the authorized board database and built worker MCP entry');
const database = resolve(databasePath), serverEntry = resolve(entry);
const db = new DatabaseSync(database + '.runtime.sqlite', { readOnly: true });
const pool = JSON.parse(db.prepare('SELECT data FROM worker_pool WHERE id=1').get().data);
assert.equal(pool.enabled, false, 'Pause the organization before opening connections');
const workers = pool.memberIds.map(id => JSON.parse(db.prepare('SELECT data FROM workers WHERE id=?').get(id).data));
assert(workers.length > 0 && workers.every(w => w.threadId && !w.turnId && ['idle', 'error'].includes(w.status)), 'Resolve pending deliveries before the startup experiment');
db.close();
const adapters = workers.map(worker => new CodexSession({ databasePath: database, serverEntry, workerId: worker.id, poolMember: true }));
try {
  const results = await Promise.allSettled(workers.map(async (worker, i) => {
    const started = Date.now();
    const id = await adapters[i].open(worker);
    assert.equal(id, worker.threadId);
    return { member: worker.name, elapsedMs: Date.now() - started, originalThreadRetained: true };
  }));
  console.log(JSON.stringify(results.map(result => result.status === 'fulfilled' ? result.value : { error: String(result.reason) })));
  assert(results.every(result => result.status === 'fulfilled'), 'Every original member must resume with its required coordination MCP');
  console.log('PASS: all original sessions resumed concurrently; no turn/start or checkpoint update was issued');
} finally { await Promise.all(adapters.map(adapter => adapter.close())); }

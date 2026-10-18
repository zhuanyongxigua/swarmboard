// A deterministic reference backend: it executes no model and exists to prove
// the extension boundary (contract, durable identity, restart reconciliation,
// assembly) without any vendor branch in the collaboration core. Select it only
// through explicit configuration; never report it as a real harness.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UncertainDelivery, type HarnessBackend, type SessionAdapter, type SessionContext } from './contract.js';

function turnDurationMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.SWARMBOARD_ECHO_TURN_MS?.trim();
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 60000 ? value : 25;
}

// Turns are journaled in the runtime sidecar before completion is reported, so
// an interrupted process leaves honest 'active' rows and a restart reconciles
// completed deliveries without a replay. This mirrors the real transport's
// submission/receipt boundaries deterministically.
class EchoSession implements SessionAdapter {
  private db?: DatabaseSync;
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }>();
  constructor(private context: SessionContext, private turnMs: number) {}
  private connect() {
    if (this.db) return this.db;
    if (this.context.statePath !== ':memory:') mkdirSync(dirname(this.context.statePath), { recursive: true });
    const db = new DatabaseSync(this.context.statePath);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS echo_sessions(workerId TEXT PRIMARY KEY, threadId TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS echo_turns(id INTEGER PRIMARY KEY AUTOINCREMENT, workerId TEXT NOT NULL, threadId TEXT NOT NULL, turnId TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL);`);
    this.db = db; return db;
  }
  private thread(workerId: string) {
    const row = this.connect().prepare('SELECT threadId FROM echo_sessions WHERE workerId=?').get(workerId) as { threadId: string } | undefined;
    return row?.threadId ?? `echo-thread-${workerId}`;
  }
  async open(worker: SessionContext['worker']) {
    const threadId = worker.threadId ?? this.thread(worker.id);
    this.connect().prepare('INSERT INTO echo_sessions VALUES(?,?,?) ON CONFLICT(workerId) DO UPDATE SET threadId=excluded.threadId').run(worker.id, threadId, new Date().toISOString());
    return threadId;
  }
  async run(threadId: string, prompt: string, onStarted: (turnId: string) => void) {
    const turnId = `echo-turn-${randomUUID()}`;
    this.connect().prepare('INSERT INTO echo_turns(workerId,threadId,turnId,prompt,status,createdAt) VALUES(?,?,?,?,?,?)')
      .run(this.context.worker.id, threadId, turnId, prompt, 'active', new Date().toISOString());
    onStarted(turnId);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(turnId); resolve(); }, this.turnMs);
      this.pending.set(turnId, { timer, reject });
    });
    // Completion is durable before the run resolves, so a kill in between still
    // reconciles as completed and never invents success for an unfinished turn.
    this.connect().prepare('UPDATE echo_turns SET status=? WHERE turnId=?').run('completed', turnId);
  }
  async inspect(threadId: string, turnId: string | null, deliveryId: string) {
    const db = this.connect();
    const row = (turnId
      ? db.prepare('SELECT status FROM echo_turns WHERE threadId=? AND turnId=?').get(threadId, turnId)
      : db.prepare('SELECT status FROM echo_turns WHERE threadId=? AND instr(prompt, ?) > 0 ORDER BY id DESC LIMIT 1').get(threadId, deliveryId)) as { status: string } | undefined;
    return row?.status === 'completed' ? 'completed' : row?.status === 'active' ? 'active' : 'unknown';
  }
  async close() {
    for (const [turnId, { timer, reject }] of this.pending) { clearTimeout(timer); this.pending.delete(turnId); reject(new UncertainDelivery('Echo session closed before the turn finished; delivery outcome is unknown')); }
    this.db?.close(); this.db = undefined;
  }
}

export function createEchoBackend(options: { turnMs?: number } = {}, env: NodeJS.ProcessEnv = process.env): HarnessBackend {
  const turnMs = options.turnMs ?? turnDurationMs(env);
  return {
    id: 'echo',
    displayName: 'Echo reference backend (deterministic, no model)',
    capabilities: { inspection: true, approvalSignals: false },
    deterministic: true,
    sessionIntro: worker => `You are ${worker.id}, a persistent Swarmboard worker attached to the deterministic echo reference backend; no model executes this turn. Keep this stable agentId. Authorized execution workspace ${JSON.stringify(worker.workspacePath)}. Register this identity if absent, otherwise heartbeat it.`,
    createSession: context => new EchoSession(context, turnMs),
  };
}
export const echoBackend = createEchoBackend();

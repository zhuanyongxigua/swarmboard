// Use the documented local App Server protocol and the CLI's existing login;
// never read token files or inject private desktop RPCs.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import type { Worker } from './worker-store.js';
import { UncertainDelivery, type HarnessBackend, type SessionAdapter } from './harness/contract.js';
export { UncertainDelivery, type SessionAdapter } from './harness/contract.js';
export class CodexSession implements SessionAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private turns = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private early = new Map<string, any>();
  private initialized?: Promise<void>;
  constructor(private options: { databasePath: string; serverEntry: string; workerId?: string; poolMember?: boolean; binary?: string; requestTimeoutMs?: number; openTimeoutMs?: number; onApproval?: () => void }) {}
  private start() {
    return this.initialized ??= (async () => {
      const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
      const binary = this.options.binary ?? process.env.SWARMBOARD_CODEX ?? (existsSync(bundled) ? bundled : 'codex');
      const config = (key: string, value: unknown) => ['-c', `${key}=${JSON.stringify(value)}`];
      this.child = spawn(binary, ['app-server', '--stdio',
        ...config('plugins."swarmboard@swarmboard-local".enabled', false),
        // A disabled, previously absent MCP entry still needs a valid stdio
        // transport in the host configuration schema.
        ...config('mcp_servers.swarmboard.command', process.execPath),
        ...config('mcp_servers.swarmboard.enabled', false),
        ...config('mcp_servers.swarmboard_worker.command', process.execPath),
        ...config('mcp_servers.swarmboard_worker.required', true),
        ...config('mcp_servers.swarmboard_worker.args', [this.options.serverEntry]),
        ...config('mcp_servers.swarmboard_worker.env.SWARMBOARD_DB_PATH', this.options.databasePath),
        ...config('mcp_servers.swarmboard_worker.env.SWARMBOARD_DISABLE_RUNTIME', '1'),
        ...config('mcp_servers.swarmboard_worker.env.SWARMBOARD_WORKER_ID', this.options.workerId ?? ''),
        ...config('mcp_servers.swarmboard_worker.env.SWARMBOARD_POOL_MEMBER', this.options.poolMember ? '1' : '0'),
      ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SWARMBOARD_DISABLE_RUNTIME: '1' } });
      // stderr can include command output; drain it without recording credentials or task data.
      this.child.stderr.resume();
      const lines = createInterface({ input: this.child.stdout });
      lines.on('line', line => { try { this.receive(JSON.parse(line)); } catch { /* Ignore non-protocol diagnostics. */ } });
      const failed = () => this.fail(new Error('Codex App Server disconnected; inspect the bound session before retrying'));
      this.child.once('error', failed); this.child.once('exit', failed); this.child.stdin.on('error', failed); this.child.stdout.on('error', failed);
      await this.request('initialize', { clientInfo: { name: 'swarmboard-event-worker', title: 'Swarmboard event worker', version: '0.8.4' }, capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized' });
    })();
  }
  private send(message: unknown) { this.child!.stdin.write(JSON.stringify(message) + '\n'); }
  private request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 30000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Only mutating submissions can have an unacknowledged outcome. A
        // resume or read timeout must not imply that a model turn was started.
        reject(['turn/start', 'thread/start'].includes(method)
          ? new UncertainDelivery(`${method} timed out; delivery outcome is unknown`)
          : new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  private receive(message: any) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) {
        // Report a recognized ownership conflict without copying arbitrary
        // server diagnostics, which may contain private task data or secrets.
        const diagnostic = typeof message.error.message === 'string' && message.error.message.includes('already has an active writer')
          ? 'Codex session already has an active writer in another connection; release that connection before resuming this worker'
          : `Codex request rejected: ${message.error.code ?? 'unknown'}`;
        pending.reject(new Error(diagnostic));
      } else pending.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      // Approval remains a human decision; this background transport never grants it.
      this.options.onApproval?.();
      this.send({ id: message.id, error: { code: -32000, message: 'Human approval or input is required; Swarmboard cannot grant it automatically.' } });
    } else if (message.method === 'turn/completed') {
      const turn = message.params?.turn;
      if (!turn?.id) return;
      const waiter = this.turns.get(turn.id);
      if (waiter) { this.turns.delete(turn.id); this.complete(waiter, turn); }
      else { if (this.early.size >= 32) this.early.delete(this.early.keys().next().value!); this.early.set(turn.id, turn); }
    }
  }
  private complete(waiter: {resolve: () => void; reject: (error: Error) => void}, turn: any) {
    if (turn.status === 'completed') waiter.resolve(); else waiter.reject(new Error(`Codex turn ${turn.status ?? 'failed'}`));
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear();
    for (const p of this.turns.values()) p.reject(new UncertainDelivery(error.message)); this.turns.clear();
  }
  async open(worker: Worker) {
    await this.start();
    const response = await this.request(worker.threadId ? 'thread/resume' : 'thread/start', {
      ...(worker.threadId ? { threadId: worker.threadId, excludeTurns: true } : {}), cwd: worker.workspacePath,
      sandbox: 'workspace-write', approvalPolicy: 'on-request',
    // Resuming also initializes MCP dependencies. Six real concurrent resumes
    // took 42-50s, so startup has its own bounded budget; turn/start keeps the
    // shorter acknowledgement timeout and its uncertainty protection.
    }, this.options.openTimeoutMs ?? 90000);
    if (!response.thread?.id || response.thread.cwd !== worker.workspacePath || worker.threadId && response.thread.id !== worker.threadId) throw new Error('Codex did not bind the expected workspace');
    return response.thread.id as string;
  }
  async run(threadId: string, prompt: string, onStarted: (turnId: string) => void) {
    const response = await this.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
    const id = response.turn?.id;
    if (!id) throw new UncertainDelivery('Missing turn identity; inspect the session');
    onStarted(id);
    await new Promise<void>((resolve, reject) => {
      const early = this.early.get(id);
      if (early) { this.early.delete(id); this.complete({ resolve, reject }, early); }
      else this.turns.set(id, { resolve, reject });
    });
  }
  async inspect(threadId: string, turnId: string | null, deliveryId: string) {
    await this.start();
    const response = await this.request('thread/read', { threadId, includeTurns: true });
    const turns = response.thread?.turns ?? [];
    const turn = turns.find((turn: any) => turnId ? turn.id === turnId : turn.items?.some((item: any) => item.type === 'userMessage' && JSON.stringify(item).includes(deliveryId)));
    if (turn?.status === 'completed') return 'completed' as const;
    if (turn?.status === 'failed' || turn?.status === 'interrupted') return 'failed' as const;
    if (turn?.status === 'inProgress') return 'active' as const;
    return 'unknown' as const;
  }
  async close() {
    const child = this.child;
    if (!child) return;
    this.fail(new UncertainDelivery('Runtime stopped; delivery may be unfinished'));
    child.stdin.end(); child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode) { resolve(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export const codexBackend: HarnessBackend = {
  id: 'codex',
  displayName: 'Official Codex App Server (ChatGPT Desktop CLI login)',
  capabilities: { inspection: true, approvalSignals: true },
  sessionIntro: worker => `You are ${worker.id}, a persistent Swarmboard worker in your existing official Codex session. Keep this stable agentId. Read the applicable AGENTS.md in your authorized execution workspace ${JSON.stringify(worker.workspacePath)}. Use swarmboard_worker MCP; register this identity if absent, otherwise heartbeat it.`,
  createSession: context => new CodexSession({
    databasePath: context.databasePath, serverEntry: context.serverEntry,
    workerId: context.worker.id, poolMember: !!context.worker.poolId,
    onApproval: context.onApproval,
  }),
};

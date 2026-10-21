// Keep DSH registry ownership outside the scheduler: attaching must never
// create a replacement session, dispose a healthy agent, or replay a mutation.
import { isAbsolute } from 'node:path';

/** The public DSH Agent fields used by this boundary. */
export interface DshAgent {
  readonly id: string;
  readonly session: { readonly id: string; readonly header: { readonly cwd?: string } };
  status: 'idle' | 'running';
}

/** Trusted composition wraps ctx.agents; it retains every returned AgentHandle.
 * create/resume below return handle.agent, never transfer its disposer here.
 * Model, permission, setup and instruction choices belong to those closures. */
export interface DshRegistryPort {
  get(sessionId: string): DshAgent | undefined;
  create(options: { sessionId: string; meta: { cwd: string } }): Promise<DshAgent>;
  resume(options: { resumeSessionId: string }): Promise<DshAgent>;
}

export interface DshLifecycleIntent {
  operation: 'start' | 'resume';
  sessionId: string;
  cwd: string;
}

/** One host-owned durable slot per session; write must commit before returning.
 * This is a lifecycle intent, separate from notification receipts/unknowns.
 * A production host must enforce its existing cross-process single-owner lease. */
export interface DshLifecycleJournal {
  read(): DshLifecycleIntent | null;
  write(intent: DshLifecycleIntent | null): void;
}

export interface DshLifecycleOptions {
  sessionId: string;
  cwd: string;
  registry: DshRegistryPort;
  journal: DshLifecycleJournal;
}

// Protect separately constructed boundaries sharing the same trusted port.
// This is an in-process guard, not a substitute for the host's durable lease.
const opening = new WeakMap<DshRegistryPort, Set<string>>();

/** Session creation/attachment/reconstruction only. No model input, process
 * spawn, timer, approval, cancellation, instruction injection or disposal. */
export class DshLifecycle {
  private readonly options: Readonly<DshLifecycleOptions>;
  private binding?: DshAgent;
  private paused = false;

  constructor(options: DshLifecycleOptions) {
    if (!options.sessionId?.trim() || !isAbsolute(options.cwd)) throw new Error('DSH_INVALID_CONFIG');
    this.options = Object.freeze({ ...options });
    this.intent();
  }

  private intent(): DshLifecycleIntent | null {
    const intent = this.options.journal.read();
    if (intent && (intent.sessionId !== this.options.sessionId || intent.cwd !== this.options.cwd
      || !['start', 'resume'].includes(intent.operation))) throw new Error('DSH_JOURNAL_CONFLICT');
    return intent;
  }

  private validate(agent: DshAgent): DshAgent {
    const { sessionId, cwd, registry } = this.options;
    if (agent.id !== sessionId || agent.session.id !== sessionId || agent.session.header.cwd !== cwd
      || !['idle', 'running'].includes(agent.status) || registry.get(sessionId) !== agent) {
      throw new Error('DSH_SESSION_CONFLICT');
    }
    return agent;
  }

  async connect(mode: 'start' | 'attach' | 'resume'): Promise<DshAgent> {
    const { sessionId, cwd, registry, journal } = this.options;
    if (!['start', 'attach', 'resume'].includes(mode)) throw new Error('DSH_INVALID_MODE');
    if (this.paused) throw new Error('DSH_PAUSED');
    const locks = opening.get(registry) ?? new Set<string>();
    if (locks.has(sessionId)) throw new Error('DSH_OPERATION_PENDING');
    if (this.intent() && mode !== 'attach') throw new Error('DSH_RECONCILIATION_REQUIRED');
    opening.set(registry, locks); locks.add(sessionId);
    try {
      const existing = registry.get(sessionId);
      if (existing) {
        if (mode === 'start') throw new Error('DSH_SESSION_EXISTS');
        this.binding = this.validate(existing);
      } else {
        if (mode === 'attach') throw new Error('DSH_SESSION_MISSING');
        journal.write({ operation: mode, sessionId, cwd });
        // Any rejection after this commit remains uncertain. An attach may
        // reconcile the original registry binding; create/resume never retries.
        const agent = mode === 'start'
          ? await registry.create({ sessionId, meta: { cwd } })
          : await registry.resume({ resumeSessionId: sessionId });
        this.binding = this.validate(agent);
      }
      journal.write(null);
      return this.binding;
    } finally {
      locks.delete(sessionId);
    }
  }

  status(): 'paused' | 'opening' | 'unknown' | 'ready' | 'busy' | 'disconnected' {
    if (this.paused) return 'paused';
    if (opening.get(this.options.registry)?.has(this.options.sessionId)) return 'opening';
    if (this.intent()) return 'unknown';
    if (!this.binding || this.options.registry.get(this.options.sessionId) !== this.binding) return 'disconnected';
    this.validate(this.binding);
    return this.binding.status === 'running' ? 'busy' : 'ready';
  }

  /** Stop new connections locally, without aborting healthy in-flight work.
   * The host separately persists disable/revoke and unregisters notifications. */
  pause(): void { this.paused = true; }
  unpause(): void { this.paused = false; }

  /** Release only our reference at an idle boundary. The host retains agent,
   * history, disposer and delivery ledger. Host shutdown is not implemented. */
  detach(): void {
    if (opening.get(this.options.registry)?.has(this.options.sessionId)) throw new Error('DSH_OPERATION_PENDING');
    if (this.binding?.status === 'running') throw new Error('DSH_BUSY');
    this.binding = undefined;
  }
}

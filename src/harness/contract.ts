// Harness-independent session contracts for the collaboration core. The core
// never imports a vendor adapter; backends register through the assembly seam.
import type { Worker } from '../worker-store.js';

/** A current, host-authored session instruction snapshot. The revision is
 *  scoped to its board, and text must explicitly supersede earlier versions,
 *  including when the human clears preferences. Never append this as user data. */
export interface SessionInstructions {
  revision: string;
  text: string;
}

/** One persistent model session per worker. Implementations must never grant
 *  tool approvals themselves; surface them through onApproval instead. */
export interface SessionAdapter {
  /** Report a verified thread binding before any further asynchronous
   *  instruction preparation, so its identity survives preparation failures. */
  open(worker: Worker, instructions?: SessionInstructions, onOpened?: (threadId: string) => void): Promise<string>;
  run(threadId: string, prompt: string, onStarted: (turnId: string) => void): Promise<void>;
  inspect?(threadId: string, turnId: string | null, deliveryId: string): Promise<'completed' | 'failed' | 'active' | 'unknown'>;
  close(): Promise<void>;
}
/** The outcome of a mutating submission is unknown (timeout, disconnect,
 *  shutdown). Callers must reconcile before any replay; never blind-resend. */
export class UncertainDelivery extends Error {}

/** What a backend honestly supports. Absent capabilities must degrade or fail
 *  visibly; they never get emulated silently by the core. */
export interface HarnessCapabilities {
  /** Turn/session state can be re-read after a crash to resolve an uncertain
   *  delivery. If false, inspect stays absent and uncertain deliveries require
   *  human resolution; the core never replays them. */
  inspection: boolean;
  /** The harness surfaces approval requests to this service so the runtime can
   *  pause the worker for a human decision. If false, approvals are handled
   *  entirely inside the harness or are unsupported for this backend. */
  approvalSignals: boolean;
  /** Explicit current host-authored session instructions are applied during
   *  preparation, before model submission. Missing support must not silently
   *  become user input. */
  sessionInstructions?: boolean;
}

/** Everything a backend may need to drive one worker's session. databasePath
 *  and serverEntry identify this Swarmboard installation; statePath is the
 *  runtime sidecar SQLite file for backend-owned durable state. */
export interface SessionContext {
  databasePath: string;
  statePath: string;
  serverEntry: string;
  worker: Worker;
  /** Durable human-approval pause hook; implementations must call it instead of
   *  answering any approval request themselves. */
  onApproval(): void;
}

export interface HarnessBackend {
  /** Stable identity persisted with worker sessions; switching it never
   *  silently reuses another backend's session/turn identifiers. */
  id: string;
  displayName: string;
  capabilities: HarnessCapabilities;
  /** Set for backends that execute no real model; used to label reference
   *  adapters honestly in status output and documentation. */
  deterministic?: boolean;
  /** Harness-specific opening paragraph of the worker prompt; the cooperation
   *  protocol itself is harness-independent. */
  sessionIntro(worker: Worker): string;
  createSession(context: SessionContext): SessionAdapter;
}

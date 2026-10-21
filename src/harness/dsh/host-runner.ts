// Drain existing host events through the audited driver without another scheduler.
// Ownership lasts across passes and is released only after explicit quiescent shutdown.
import { driveOnce, type DriveOptions, type DriveResult, type Journal, type PendingPort, type SessionPort } from './notification-driver.js';
import type { DshHostLease } from './host-lease.js';

export interface DshHostRunnerOptions {
  lease: DshHostLease;
  ports: { pending: PendingPort; session: SessionPort; journal: Journal };
  /** Synchronous live SDK check: agent idle, inbox empty and no in-flight host mutation.
   * Unknown delivery journals remain preserved; quiescence never licenses replay. */
  canRelease(): boolean;
  drive?: DriveOptions;
}

/** Existing notification/turn events call pass(); there is no timer or model poll.
 * The SDK SessionPort's synchronous isAuthorized callback must ALSO check lease.owns()
 * at its final send boundary. This runner cannot make an asynchronous port atomic. */
export function createDshHostRunner(options: DshHostRunnerOptions) {
  const { lease, ports } = options;
  let running: Promise<DriveResult> | undefined;
  let again = false;
  let stopping = false;
  let released = false;
  const fence = () => { if (lease.owns() !== true) throw new Error('DSH_HOST_LEASE_LOST'); };
  const guarded = {
    pending: {
      list: async () => { fence(); const batch = await ports.pending.list(); fence(); return batch; },
      confirm: async (...args: Parameters<PendingPort['confirm']>) => { fence(); await ports.pending.confirm(...args); },
      release: async (...args: Parameters<PendingPort['release']>) => { fence(); await ports.pending.release(...args); },
    },
    journal: {
      get: async (...args: Parameters<Journal['get']>) => { fence(); const intent = await ports.journal.get(...args); fence(); return intent; },
      put: async (...args: Parameters<Journal['put']>) => { fence(); await ports.journal.put(...args); fence(); },
      del: async (...args: Parameters<Journal['del']>) => { fence(); await ports.journal.del(...args); },
    },
    session: {
      isCurrent: async (...args: Parameters<SessionPort['isCurrent']>) => { fence(); const current = await ports.session.isCurrent(...args); fence(); return current; },
      isBusy: async (...args: Parameters<SessionPort['isBusy']>) => { fence(); const busy = await ports.session.isBusy(...args); fence(); return busy; },
      submit: (...args: Parameters<SessionPort['submit']>) => { fence(); return ports.session.submit(...args); },
      settlement: async (...args: Parameters<SessionPort['settlement']>) => { fence(); const settled = await ports.session.settlement(...args); fence(); return settled; },
    },
  };
  return Object.freeze({
    pass(): Promise<DriveResult> {
      if (stopping) return Promise.reject(new Error('DSH_HOST_STOPPING'));
      if (running) { again = true; return running; }
      if (lease.acquire() !== true) return Promise.reject(new Error('DSH_HOST_OWNED'));
      running = (async () => {
        let result: DriveResult | undefined;
        do {
          again = false;
          const next = await driveOnce(guarded, options.drive);
          if (!result) result = next;
          else for (const field of Object.keys(next) as (keyof DriveResult)[]) result[field].push(...next[field]);
        } while (again && !stopping);
        return result;
      })().finally(() => { running = undefined; });
      return running;
    },
    async stop(): Promise<void> {
      stopping = true;
      // Never cancel an accepted SDK operation. A failed pass can leave unknown
      // state; it does not turn the subsequent quiescence check into success.
      try { await running; } catch { /* The journal and lease remain intact. */ }
      if (released) return;
      if (options.canRelease() !== true) throw new Error('DSH_HOST_NOT_QUIESCENT');
      lease.release(); released = true;
    },
  });
}

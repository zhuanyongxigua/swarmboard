// Core wiring: publish one reminder/event to every channel that is registered
// and in scope, by recording a durable intent per member before delivery.
//
// This only touches the board database. It deliberately does not import any
// harness, spawn a process or start a model turn: registered adapters consume
// their own intents, and the core never assumes delivery happened.
import type { Entry } from './store.js';
import type { Store } from './store.js';
import type { CollaboratorStore } from './collaborators.js';
import { NotificationAdapterStore } from './notification-adapter-store.js';
import {
  isIdleReminder,
  resolveNotificationTargets,
  resolveReminderTargets,
  type DeliveryResolution,
  type NotificationAdapterRegistration,
} from './notification-adapters.js';

export interface NotificationDispatcher {
  /** Record durable intents for one published entry and report the resolution. */
  dispatch(entry: Entry): DeliveryResolution;
  /** Offer each channel the entries after its own floor (bounded). */
  dispatchPending(limit?: number): number;
  /** Currently registered channels, for status output. */
  adapters(): ReturnType<NotificationAdapterStore['list']>;
}

export function createNotificationDispatcher(board: Store, collaborators?: CollaboratorStore): NotificationDispatcher {
  const store = new NotificationAdapterStore(board.db);

  const admitted = (memberId: string): boolean => {
    if (!collaborators) return true;
    try {
      const record = collaborators.get(memberId);
      return record.enabled && !record.revokedAt;
    } catch { return false; }
  };

  /**
   * Record the intent for one target. A claim is persisted first for idempotency
   * and released again if recording fails, so a transient failure cannot wedge
   * the entry as claimed-but-undeliverable.
   */
  const recordTarget = (
    entry: Entry,
    target: { adapterId: string; memberId: string },
    resolution: DeliveryResolution,
  ): void => {
    if (!admitted(target.memberId)) {
      resolution.skipped.push({ adapterId: target.adapterId, memberId: target.memberId, reason: 'collaborator-inactive' });
      return;
    }
    if (entry.taskId !== undefined) {
      const task = (() => { try { return board.readTask(entry.taskId!); } catch { return undefined; } })();
      if (!task || ['done', 'canceled'].includes(task.status)) {
        resolution.skipped.push({ adapterId: target.adapterId, memberId: target.memberId, reason: 'goal-terminal' });
        return;
      }
    }
    // Idempotent per (entry, channel, member): a re-scan cannot duplicate it.
    if (!store.claimDispatch(entry.id, target.adapterId, target.memberId)) return;
    try {
      const pending = store.pendingIntent(target.adapterId, target.memberId);
      if (pending) {
        // Busy merge: batch into the unconfirmed delivery rather than opening a
        // second sequence, which the cross-sequence fence would reject.
        store.appendEntries(target.adapterId, target.memberId, pending.sequence, [entry.id]);
        return;
      }
      store.recordIntent({
        adapterId: target.adapterId,
        memberId: target.memberId,
        sequence: store.nextSequence(target.adapterId, target.memberId),
        entryIds: [entry.id],
        createdAt: entry.createdAt,
      });
    } catch {
      // Roll the claim back so the entry is retried later instead of being lost,
      // and keep the failure inside this channel (acceptance-4 isolation).
      store.releaseDispatch(entry.id, target.adapterId, target.memberId);
      resolution.skipped.push({ adapterId: target.adapterId, memberId: target.memberId, reason: 'dispatch-failed' });
    }
  };

  const applyTargets = (
    entry: Entry,
    resolution: DeliveryResolution,
    filter?: (adapterId: string) => boolean,
  ): DeliveryResolution => {
    for (const target of resolution.targets) {
      if (filter && !filter(target.adapterId)) continue;
      recordTarget(entry, target, resolution);
    }
    return resolution;
  };

  const resolveAll = (entry: Entry, adapters: readonly NotificationAdapterRegistration[]): DeliveryResolution =>
    // An idle reminder is a public board signal: its recipientId only rotates the
    // internal wake-up, so every registered member is an applicable target.
    isIdleReminder(entry)
      ? resolveReminderTargets(entry, adapters)
      : resolveNotificationTargets(entry, adapters);

  /** Dispatch one entry to one adapter; true when a target could not be recorded. */
  const dispatchTo = (adapter: NotificationAdapterRegistration, entry: Entry): { resolution: DeliveryResolution; failed: boolean } => {
    const resolution = resolveAll(entry, [adapter]);
    applyTargets(entry, resolution, adapterId => adapterId === adapter.id);
    return { resolution, failed: resolution.skipped.some(item => item.reason === 'dispatch-failed') };
  };

  return {
    adapters: () => store.list(),
    dispatchPending(limit = 200): number {
      const adapters = store.list();
      if (!adapters.length) return 0;
      let scanned = 0;
      for (const adapter of adapters) {
        // Each channel has its own floor, so a newly registered member starts at
        // the current board position instead of receiving the whole history.
        const start = store.adapterFloor(adapter.id);
        const page = board.readEntries({ after: start, limit });
        let advanced = start;
        for (const entry of page.items) {
          const { failed } = dispatchTo(adapter, entry);
          // Never move the floor past an entry this channel could not record:
          // otherwise a failed event would sit below the floor and never be
          // retried after the operator reconciles the frozen sequence.
          if (failed) break;
          advanced = entry.id;
        }
        if (advanced !== start) store.advanceAdapterFloor(adapter.id, advanced);
        scanned += page.items.length;
      }
      return scanned;
    },
    dispatch(entry: Entry): DeliveryResolution {
      const resolution = resolveAll(entry, store.list());
      return applyTargets(entry, resolution);
    },
  };
}

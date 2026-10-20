// Core wiring: publish one reminder/event to every channel that is registered
// and in scope, by recording a durable intent per member before delivery.
//
// This only touches the board database. It deliberately does not import any
// harness, spawn a process or start a model turn: registered adapters consume
// their own intents, and the core never assumes delivery happened.
import type { Entry } from './store.js';
import type { Store } from './store.js';
import { NotificationAdapterStore } from './notification-adapter-store.js';
import { resolveNotificationTargets, type DeliveryResolution } from './notification-adapters.js';

export interface NotificationDispatcher {
  /** Record durable intents for one published entry and report the resolution.
   *  Each board entry is offered at most once, so a re-scan cannot duplicate it. */
  dispatch(entry: Entry): DeliveryResolution;
  /** Offer every entry after the last dispatched one (bounded). */
  dispatchPending(limit?: number): number;
  /** Currently registered channels, for status output. */
  adapters(): ReturnType<NotificationAdapterStore['list']>;
}

export function createNotificationDispatcher(board: Store): NotificationDispatcher {
  const store = new NotificationAdapterStore(board.db);
  return {
    adapters: () => store.list(),
    dispatchPending(limit = 200): number {
      if (!store.list().length) return 0;
      const after = store.dispatchedThrough();
      const page = board.readEntries({ after, limit });
      for (const entry of page.items) this.dispatch(entry);
      const highest = page.items.at(-1)?.id;
      if (highest !== undefined) store.advanceDispatch(highest);
      return page.items.length;
    },
    dispatch(entry: Entry): DeliveryResolution {
      const resolution = resolveNotificationTargets(entry, store.list());
      for (const target of resolution.targets) {
        // Idempotent per (entry, channel, member): a re-scan cannot duplicate it.
        if (!store.claimDispatch(entry.id, target.adapterId, target.memberId)) continue;
        const pending = store.pendingIntent(target.adapterId, target.memberId);
        if (pending) {
          // Busy merge: batch into the unconfirmed delivery rather than opening
          // a second sequence, which the cross-sequence fence would reject.
          store.appendEntries(target.adapterId, target.memberId, pending.sequence, [entry.id]);
          continue;
        }
        store.recordIntent({
          adapterId: target.adapterId,
          memberId: target.memberId,
          sequence: store.nextSequence(target.adapterId, target.memberId),
          entryIds: [entry.id],
          createdAt: entry.createdAt,
        });
      }
      return resolution;
    },
  };
}

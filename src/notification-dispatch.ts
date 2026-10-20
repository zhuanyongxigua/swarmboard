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
  /** Record durable intents for one published entry and report the resolution. */
  dispatch(entry: Entry): DeliveryResolution;
  /** Currently registered channels, for status output. */
  adapters(): ReturnType<NotificationAdapterStore['list']>;
}

export function createNotificationDispatcher(board: Store): NotificationDispatcher {
  const store = new NotificationAdapterStore(board.db);
  return {
    adapters: () => store.list(),
    dispatch(entry: Entry): DeliveryResolution {
      const resolution = resolveNotificationTargets(entry, store.list());
      for (const target of resolution.targets) {
        const sequence = store.nextSequence(target.adapterId, target.memberId);
        store.recordIntent({
          adapterId: target.adapterId,
          memberId: target.memberId,
          sequence,
          entryIds: [entry.id],
          createdAt: entry.createdAt,
        });
      }
      return resolution;
    },
  };
}

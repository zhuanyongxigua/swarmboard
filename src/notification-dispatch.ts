// Core wiring: publish one reminder/event to every channel that is registered
// and in scope, by recording a durable intent per member before delivery.
//
// This only touches the board database. It deliberately does not import any
// harness, spawn a process or start a model turn: registered adapters consume
// their own intents, and the core never assumes delivery happened.
import type { Entry } from './store.js';
import type { Store } from './store.js';
import { collaboratorTaskIds, type CollaboratorStore } from './collaborators.js';
import type { WorkerStore } from './worker-store.js';
import { NotificationAdapterStore } from './notification-adapter-store.js';
import {
  isIdleReminder,
  isSessionTaskCheck,
  readSessionTaskCheck,
  resolveSessionTaskCheckTargets,
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
  /** Cancel a member's unsettled deliveries after revocation/disable. */
  cancelMember(memberId: string, note: string): number;
  /** Currently registered channels, for status output. */
  adapters(): ReturnType<NotificationAdapterStore['list']>;
}

export function createNotificationDispatcher(board: Store, collaborators?: CollaboratorStore, workers?: WorkerStore): NotificationDispatcher {
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
    target: { adapterId: string; memberId: string; sessionRef: string },
    resolution: DeliveryResolution,
  ): void => {
    const check = readSessionTaskCheck(entry);
    if (isSessionTaskCheck(entry)) {
      const adapter = store.list().find(adapter => adapter.id === target.adapterId);
      const current = check && collaborators ? (() => { try { return collaborators.get(target.memberId); } catch { return undefined; } })() : undefined;
      const ids = current ? collaboratorTaskIds(current, workers) : [];
      const declared = adapter?.members.find(member => member.memberId === target.memberId);
      const applicable = check?.goalIds.some(id => (ids === undefined || ids.includes(id)) && declared?.taskIds.includes(id)
        && (() => { try { return ['todo', 'in_progress', 'in_review'].includes(board.readTask(id).status); } catch { return false; } })());
      if (!check || !current?.enabled || current.revokedAt || current.sessionRef !== check.sessionRef
        || adapter?.enabled !== true || adapter.version !== check.registrationVersion
        || declared?.sessionRef !== check.sessionRef || !applicable) {
        resolution.skipped.push({ adapterId: target.adapterId, memberId: target.memberId, reason: 'out-of-scope' });
        return;
      }
    }
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
    // Persist the period claim and its intent together: failure must leave the
    // same due period retryable, while a crash after commit cannot duplicate it.
    if (check) board.db.exec('SAVEPOINT notification_session_check');
    try {
      if (!store.claimDispatch(entry.id, target.adapterId, target.memberId)
        || (check && !store.claimSessionCheck(check.memberId, check.sessionRef, check.dueAt, entry.id))) {
        if (check) board.db.exec('RELEASE notification_session_check');
        return;
      }
      const pending = store.pendingIntent(target.adapterId, target.memberId);
      if (pending) {
        if (check && (pending.sessionRef !== check.sessionRef || pending.registrationVersion !== check.registrationVersion))
          throw new Error('Reconcile the earlier session delivery before recording a check');
        // Busy merge: batch into the unconfirmed delivery rather than opening a
        // second sequence, which the cross-sequence fence would reject.
        store.appendEntries(target.adapterId, target.memberId, pending.sequence, [entry.id]);
        if (check) board.db.exec('RELEASE notification_session_check');
        return;
      }
      store.recordIntent({
        adapterId: target.adapterId,
        memberId: target.memberId,
        sequence: store.nextSequence(target.adapterId, target.memberId),
        entryIds: [entry.id],
        createdAt: entry.createdAt,
        ...(check ? { sessionRef: check.sessionRef, registrationVersion: check.registrationVersion } : {}),
      });
      if (check) board.db.exec('RELEASE notification_session_check');
    } catch {
      // Roll the claim back so the entry is retried later instead of being lost,
      // and keep the failure inside this channel (acceptance-4 isolation).
      if (check) board.db.exec('ROLLBACK TO notification_session_check; RELEASE notification_session_check');
      else store.releaseDispatch(entry.id, target.adapterId, target.memberId);
      resolution.skipped.push({ adapterId: target.adapterId, memberId: target.memberId, reason: 'dispatch-failed' });
    }
  };

  /** Cancel queued deliveries whose entries all belong to a finished goal. */
  const cancelTerminalDeliveries = (): number => {
    let cancelled = 0;
    for (const item of store.unsettled()) {
      const tasks = store.entryTaskIds(item.intent.entryIds);
      if (!tasks.length || tasks.some(taskId => taskId === null)) continue;
      const terminal = tasks.every(taskId => {
        try {
          const task = board.readTask(taskId!);
          return ['done', 'canceled'].includes(task.status);
        } catch { return true; }
      });
      if (!terminal) continue;
      store.cancelSequence(item.intent.adapterId, item.intent.memberId, item.intent.sequence, 'goal-terminal');
      cancelled += 1;
    }
    return cancelled;
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
    isSessionTaskCheck(entry) ? resolveSessionTaskCheckTargets(entry, adapters) :
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
    cancelMember: (memberId: string, note: string) => store.cancelMember(memberId, note),
    dispatchPending(limit = 200): number {
      const adapters = store.list();
      if (!adapters.length) return 0;
      // A goal that reached a terminal state must not wake anyone afterwards.
      cancelTerminalDeliveries();
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

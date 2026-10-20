// Durable side of notification channels: registrations, delivery intents and
// receipts live in the board SQLite file so a restart cannot lose a pending
// wake-up or silently re-send one whose outcome is unknown.
//
// Registration is still not a startup and a receipt is still not execution:
// this store only remembers declarations and evidence, it never contacts a
// harness.
import type { DatabaseSync } from 'node:sqlite';
import {
  isSettled,
  reconcileDelivery,
  validateRegistration,
  type AdapterReceipt,
  type DeliveryIntent,
  type DeliveryState,
  type NotificationAdapterRegistration,
} from './notification-adapters.js';

interface AdapterRow { id: string; data: string }
interface DeliveryRow { intent: string; receipt: string | null }

export class NotificationAdapterStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_adapters(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, data TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_deliveries(adapterId TEXT NOT NULL, memberId TEXT NOT NULL, sequence INTEGER NOT NULL, intent TEXT NOT NULL, receipt TEXT, PRIMARY KEY(adapterId, memberId, sequence));
      CREATE TABLE IF NOT EXISTS notification_dispatched(entryId INTEGER NOT NULL, adapterId TEXT NOT NULL, memberId TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(entryId, adapterId, memberId));
      CREATE TABLE IF NOT EXISTS notification_adapter_floor(adapterId TEXT PRIMARY KEY, through INTEGER NOT NULL);
    `);
  }

  /**
   * Register or replace one channel declaration. Validation matches the pure
   * registry, and a replacement must strictly increase `version` so a stale
   * declaration can never overwrite a newer one after a scope change.
   */
  save(adapter: NotificationAdapterRegistration, now = new Date().toISOString()): NotificationAdapterRegistration {
    validateRegistration(adapter);
    const existing = this.db.prepare('SELECT data FROM notification_adapters WHERE id=?').get(adapter.id) as unknown as { data: string } | undefined;
    if (existing) {
      const prior = JSON.parse(existing.data) as NotificationAdapterRegistration;
      if (adapter.version <= prior.version) throw new Error(`Notification adapter ${JSON.stringify(adapter.id)} replacement must increase version`);
    }
    this.db.prepare('INSERT INTO notification_adapters(id, enabled, data, updatedAt) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, data=excluded.data, updatedAt=excluded.updatedAt')
      .run(adapter.id, adapter.enabled ? 1 : 0, JSON.stringify(adapter), now);
    // Pin the dispatch floor at registration: a channel starts from the board
    // position it was declared at, never from the beginning of history.
    this.adapterFloor(adapter.id);
    return adapter;
  }

  list(): NotificationAdapterRegistration[] {
    return (this.db.prepare('SELECT id, data FROM notification_adapters ORDER BY id').all() as unknown as AdapterRow[])
      .map(row => JSON.parse(row.data) as NotificationAdapterRegistration);
  }

  /** Record the durable intent before any adapter is asked to deliver. Idempotent per sequence. */
  recordIntent(intent: DeliveryIntent): DeliveryIntent {
    const existing = this.db.prepare('SELECT intent, receipt FROM notification_deliveries WHERE adapterId=? AND memberId=? AND sequence=?')
      .get(intent.adapterId, intent.memberId, intent.sequence) as unknown as DeliveryRow | undefined;
    if (existing) {
      const prior = JSON.parse(existing.intent) as DeliveryIntent;
      // A different payload under the same sequence means the caller lost track
      // of an earlier attempt: refuse instead of overwriting evidence.
      if (JSON.stringify(prior.entryIds) !== JSON.stringify(intent.entryIds)) {
        throw new Error('Notification delivery intent already recorded with different entries');
      }
      return prior;
    }
    const expected = this.nextSequence(intent.adapterId, intent.memberId);
    if (intent.sequence !== expected) {
      throw new Error(`Notification delivery sequence ${intent.sequence} is not the next settled sequence ${expected}; resolve the earlier delivery first`);
    }
    this.db.prepare('INSERT INTO notification_deliveries(adapterId, memberId, sequence, intent, receipt) VALUES(?,?,?,?,NULL)')
      .run(intent.adapterId, intent.memberId, intent.sequence, JSON.stringify(intent));
    return intent;
  }

  /**
   * Settle an intent as abandoned after a trusted operator reconciled it. This
   * unblocks the sequence fence without pretending the delivery succeeded.
   */
  recordAbandoned(adapterId: string, memberId: string, sequence: number, note: string): void {
    const row = this.db.prepare('SELECT intent FROM notification_deliveries WHERE adapterId=? AND memberId=? AND sequence=?')
      .get(adapterId, memberId, sequence) as unknown as { intent: string } | undefined;
    if (!row) throw new Error('Notification abandonment without a recorded intent');
    const receipt: AdapterReceipt & { note?: string } = { sequence, consumed: false, abandoned: true, note };
    this.db.prepare('UPDATE notification_deliveries SET receipt=? WHERE adapterId=? AND memberId=? AND sequence=?')
      .run(JSON.stringify(receipt), adapterId, memberId, sequence);
  }

  /** Record what the adapter confirmed. A receipt never advances another sequence. */
  recordReceipt(adapterId: string, memberId: string, receipt: AdapterReceipt): void {
    const row = this.db.prepare('SELECT intent, receipt FROM notification_deliveries WHERE adapterId=? AND memberId=? AND sequence=?')
      .get(adapterId, memberId, receipt.sequence) as unknown as DeliveryRow | undefined;
    if (!row) throw new Error('Notification receipt without a recorded intent');
    this.db.prepare('UPDATE notification_deliveries SET receipt=? WHERE adapterId=? AND memberId=? AND sequence=?')
      .run(JSON.stringify(receipt), adapterId, memberId, receipt.sequence);
  }

  /**
   * Next sequence number for one channel member: the highest settled sequence
   * plus one. An unsettled (pending/unknown) sequence keeps this value fixed so
   * a caller cannot quietly advance past an unresolved delivery.
   */
  /**
   * Per-adapter scan floor. A channel starts at the board high-water mark of its
   * registration, so a newly registered member never receives board history.
   */
  adapterFloor(adapterId: string): number {
    const row = this.db.prepare('SELECT through FROM notification_adapter_floor WHERE adapterId=?').get(adapterId) as unknown as { through: number } | undefined;
    if (row) return row.through;
    // A bare database without the board schema simply starts at zero.
    let highest: number;
    try { highest = (this.db.prepare('SELECT COALESCE(MAX(id),0) AS value FROM entries').get() as unknown as { value: number }).value; } catch { highest = 0; }
    this.db.prepare('INSERT OR IGNORE INTO notification_adapter_floor(adapterId, through) VALUES(?,?)').run(adapterId, highest);
    return highest;
  }

  /** Advance one adapter floor; never moves backwards. */
  advanceAdapterFloor(adapterId: string, through: number): void {
    this.db.prepare('INSERT INTO notification_adapter_floor(adapterId, through) VALUES(?,?) ON CONFLICT(adapterId) DO UPDATE SET through=MAX(through, excluded.through)').run(adapterId, through);
  }

  /** Drop a claim so a failed dispatch can be retried instead of wedging it. */
  releaseDispatch(entryId: number, adapterId: string, memberId: string): void {
    this.db.prepare('DELETE FROM notification_dispatched WHERE entryId=? AND adapterId=? AND memberId=?').run(entryId, adapterId, memberId);
  }

  /** Claim one entry for one channel member. False means it was already claimed. */
  claimDispatch(entryId: number, adapterId: string, memberId: string, at = new Date().toISOString()): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO notification_dispatched(entryId, adapterId, memberId, at) VALUES(?,?,?,?)')
      .run(entryId, adapterId, memberId, at);
    return result.changes > 0;
  }

  /** The still-pending (unconfirmed) intent for one channel member, if any. */
  pendingIntent(adapterId: string, memberId: string): DeliveryIntent | null {
    const row = this.db.prepare('SELECT intent FROM notification_deliveries WHERE adapterId=? AND memberId=? AND receipt IS NULL ORDER BY sequence DESC LIMIT 1')
      .get(adapterId, memberId) as unknown as { intent: string } | undefined;
    return row ? JSON.parse(row.intent) as DeliveryIntent : null;
  }

  /**
   * Merge more entries into a delivery that has not been confirmed yet, so busy
   * channels batch instead of failing the sequence fence. A settled or unknown
   * delivery is never extended: it must be reconciled first.
   */
  appendEntries(adapterId: string, memberId: string, sequence: number, entryIds: readonly number[]): DeliveryIntent {
    const row = this.db.prepare('SELECT intent, receipt FROM notification_deliveries WHERE adapterId=? AND memberId=? AND sequence=?')
      .get(adapterId, memberId, sequence) as unknown as { intent: string; receipt: string | null } | undefined;
    if (!row) throw new Error('Notification merge without a recorded intent');
    if (row.receipt !== null) throw new Error('Cannot merge into a settled or unknown delivery');
    const intent = JSON.parse(row.intent) as DeliveryIntent;
    const merged = [...intent.entryIds];
    for (const id of entryIds) if (!merged.includes(id)) merged.push(id);
    const next = { ...intent, entryIds: merged };
    this.db.prepare('UPDATE notification_deliveries SET intent=? WHERE adapterId=? AND memberId=? AND sequence=?')
      .run(JSON.stringify(next), adapterId, memberId, sequence);
    return next;
  }

  nextSequence(adapterId: string, memberId: string): number {
    return this.settledSequence(adapterId, memberId) + 1;
  }

  /** Highest delivery sequence that can no longer change (delivered or abandoned). */
  settledSequence(adapterId: string, memberId: string): number {
    const rows = this.db.prepare('SELECT sequence, intent, receipt FROM notification_deliveries WHERE adapterId=? AND memberId=? ORDER BY sequence')
      .all(adapterId, memberId) as unknown as { sequence: number; intent: string; receipt: string | null }[];
    let settled = 0;
    for (const row of rows) {
      const state = reconcileDelivery(JSON.parse(row.intent) as DeliveryIntent, row.receipt === null ? null : JSON.parse(row.receipt) as AdapterReceipt);
      // Ordering is strict: a gap above an unsettled sequence is not settled.
      if (row.sequence !== settled + 1 || !isSettled(state)) break;
      settled = row.sequence;
    }
    return settled;
  }

  /** Latest intent for one channel member, and how it reconciles with its receipt. */
  reconcile(adapterId: string, memberId: string): { intent: DeliveryIntent | null; state: DeliveryState | null } {
    const row = this.db.prepare('SELECT intent, receipt FROM notification_deliveries WHERE adapterId=? AND memberId=? ORDER BY sequence DESC LIMIT 1')
      .get(adapterId, memberId) as unknown as DeliveryRow | undefined;
    if (!row) return { intent: null, state: null };
    const intent = JSON.parse(row.intent) as DeliveryIntent;
    const receipt = row.receipt === null ? null : JSON.parse(row.receipt) as AdapterReceipt;
    return { intent, state: reconcileDelivery(intent, receipt) };
  }

  /**
   * Intents that are not yet confirmed delivered. Unknown deliveries are
   * included on purpose: a restart must surface them for reconciliation, and
   * the caller is responsible for never replaying them automatically.
   */
  unsettled(adapterId?: string): { intent: DeliveryIntent; state: DeliveryState }[] {
    const rows = (adapterId === undefined
      ? this.db.prepare('SELECT intent, receipt FROM notification_deliveries ORDER BY sequence').all()
      : this.db.prepare('SELECT intent, receipt FROM notification_deliveries WHERE adapterId=? ORDER BY sequence').all(adapterId)) as unknown as DeliveryRow[];
    const all: { intent: DeliveryIntent; state: DeliveryState }[] = [];
    for (const row of rows) {
      const intent = JSON.parse(row.intent) as DeliveryIntent;
      const receipt = row.receipt === null ? null : JSON.parse(row.receipt) as AdapterReceipt;
      const state = reconcileDelivery(intent, receipt);
      // Settled sequences (delivered or explicitly abandoned) need no action;
      // pending and unknown ones must stay visible for reconciliation.
      if (!isSettled(state)) all.push({ intent, state });
    }
    return all;
  }
}

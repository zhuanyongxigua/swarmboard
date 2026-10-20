// Durable side of notification channels: registrations, delivery intents and
// receipts live in the board SQLite file so a restart cannot lose a pending
// wake-up or silently re-send one whose outcome is unknown.
//
// Registration is still not a startup and a receipt is still not execution:
// this store only remembers declarations and evidence, it never contacts a
// harness.
import type { DatabaseSync } from 'node:sqlite';
import {
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
    `);
  }

  /** Register or replace one channel declaration. Validation matches the pure registry. */
  save(adapter: NotificationAdapterRegistration, now = new Date().toISOString()): NotificationAdapterRegistration {
    validateRegistration(adapter);
    this.db.prepare('INSERT INTO notification_adapters(id, enabled, data, updatedAt) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, data=excluded.data, updatedAt=excluded.updatedAt')
      .run(adapter.id, adapter.enabled ? 1 : 0, JSON.stringify(adapter), now);
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
    this.db.prepare('INSERT INTO notification_deliveries(adapterId, memberId, sequence, intent, receipt) VALUES(?,?,?,?,NULL)')
      .run(intent.adapterId, intent.memberId, intent.sequence, JSON.stringify(intent));
    return intent;
  }

  /** Record what the adapter confirmed. A receipt never advances another sequence. */
  recordReceipt(adapterId: string, memberId: string, receipt: AdapterReceipt): void {
    const row = this.db.prepare('SELECT intent, receipt FROM notification_deliveries WHERE adapterId=? AND memberId=? AND sequence=?')
      .get(adapterId, memberId, receipt.sequence) as unknown as DeliveryRow | undefined;
    if (!row) throw new Error('Notification receipt without a recorded intent');
    this.db.prepare('UPDATE notification_deliveries SET receipt=? WHERE adapterId=? AND memberId=? AND sequence=?')
      .run(JSON.stringify(receipt), adapterId, memberId, receipt.sequence);
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
      if (state.state !== 'delivered') all.push({ intent, state });
    }
    return all;
  }
}

// Registration seam for notification channels: which adapters exist, which
// stable members/sessions they serve, and which shared events should reach them.
//
// Deliberately separate from src/harness/registry.ts. A harness backend is
// selected once at startup to *execute* one session; a notification adapter is
// a delivery channel that may exist alongside others. Merging the two would
// confuse "which backend runs work" with "which channels hear about it".
//
// Registration is not a startup, and delivery is not execution: nothing here
// spawns a process, starts a model turn, or claims a member is online.
import type { Entry } from './store.js';
import { actionableWake } from './wake-policy.js';

/** Capability bits an adapter must be able to honour when it asks for work. */
export const adapterCapabilities = [
  'durableDelivery',
  'receipt',
  'sameSessionContinuation',
  'approvalSignals',
  'timedReminder',
] as const;
export type AdapterCapability = (typeof adapterCapabilities)[number];

/** One persistent model session owned by one stable member identity. */
export interface AdapterMember {
  memberId: string;
  sessionRef: string;
  /** Tasks whose scoped events this member accepts. Empty means it hears only directed messages. */
  taskIds: readonly string[];
}

/** A channel declaration. `harness` is a free-form label: the core never branches on it. */
export interface NotificationAdapterRegistration {
  /** Stable id, unique across the process. */
  id: string;
  displayName: string;
  harness: string;
  enabled: boolean;
  capabilities: readonly AdapterCapability[];
  members: readonly AdapterMember[];
}

export type DeliverySkipReason =
  | 'invalid-registration'
  | 'disabled'
  | 'no-members'
  | 'reference-only'
  | 'out-of-scope'
  | 'self-authored'
  | 'no-capability';

export interface DeliveryTarget {
  adapterId: string;
  memberId: string;
  sessionRef: string;
}

export interface DeliverySkip {
  adapterId: string;
  memberId: string | null;
  reason: DeliverySkipReason;
}

export interface DeliveryResolution {
  targets: DeliveryTarget[];
  skipped: DeliverySkip[];
}

export interface ResolveOptions {
  /** Required capability for this delivery, e.g. 'timedReminder' for a scheduled nudge. */
  capability?: AdapterCapability;
}

const capabilitySet = new Set<string>(adapterCapabilities);

function nonEmpty(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Reject declarations that would only look like a working channel. */
export function validateRegistration(adapter: NotificationAdapterRegistration): void {
  if (!adapter || !nonEmpty(adapter.id)) throw new Error('Notification adapter id is required');
  if (!nonEmpty(adapter.displayName)) throw new Error('Notification adapter displayName is required');
  if (!nonEmpty(adapter.harness)) throw new Error('Notification adapter harness label is required');
  if (typeof adapter.enabled !== 'boolean') throw new Error('Notification adapter enabled flag is required');
  if (!Array.isArray(adapter.capabilities)) throw new Error('Notification adapter capabilities are required');
  for (const capability of adapter.capabilities) {
    // Unknown bits are an error: a channel must not advertise what callers cannot rely on.
    if (!capabilitySet.has(capability)) throw new Error(`Unknown notification capability ${JSON.stringify(capability)}`);
  }
  if (!Array.isArray(adapter.members) || adapter.members.length === 0) {
    throw new Error('Notification adapter must declare at least one member/session; identity alone is not a channel');
  }
  const members = new Set<string>();
  for (const member of adapter.members) {
    if (!member || !nonEmpty(member.memberId) || !nonEmpty(member.sessionRef)) throw new Error('Notification adapter member requires memberId and sessionRef');
    const taskIds: readonly unknown[] = Array.isArray(member.taskIds) ? member.taskIds : [];
    if (!Array.isArray(member.taskIds) || taskIds.some(id => typeof id !== 'string' || !nonEmpty(id))) {
      throw new Error('Notification adapter member scope must be a list of task ids');
    }
    if (members.has(member.memberId)) throw new Error(`Duplicate notification member ${JSON.stringify(member.memberId)}`);
    members.add(member.memberId);
  }
}

export interface NotificationRegistry {
  /** Register one channel. Duplicate ids and invalid declarations throw. */
  register(adapter: NotificationAdapterRegistration): Readonly<NotificationAdapterRegistration>;
  list(): readonly NotificationAdapterRegistration[];
  get(id: string): Readonly<NotificationAdapterRegistration> | undefined;
}

export function createNotificationRegistry(initial: readonly NotificationAdapterRegistration[] = []): NotificationRegistry {
  const byId = new Map<string, Readonly<NotificationAdapterRegistration>>();
  const register = (adapter: NotificationAdapterRegistration) => {
    validateRegistration(adapter);
    if (byId.has(adapter.id)) throw new Error(`Duplicate notification adapter ${JSON.stringify(adapter.id)}`);
    const frozen = Object.freeze({
      ...adapter,
      capabilities: Object.freeze([...adapter.capabilities]),
      members: Object.freeze(adapter.members.map(member => Object.freeze({ ...member, taskIds: Object.freeze([...member.taskIds]) }))),
    });
    byId.set(adapter.id, frozen);
    return frozen;
  };
  for (const adapter of initial) register(adapter);
  return { register, list: () => [...byId.values()], get: id => byId.get(id) };
}

/** Collapse a page of entries to its first appearance of each id, keeping order. */
export function dedupeEntries(entries: readonly Entry[]): Entry[] {
  const seen = new Set<number>();
  const unique: Entry[] = [];
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

function memberAccepts(member: AdapterMember, entry: Entry): 'accept' | 'out-of-scope' | 'directed' {
  if (entry.recipientId === member.memberId) return 'directed';
  if (entry.taskId !== undefined) return member.taskIds.includes(entry.taskId) ? 'accept' : 'out-of-scope';
  // A board-level entry with no task and no recipient is shared context, not a
  // directed wake: it must not reach a member that never subscribed to it.
  return 'out-of-scope';
}

/**
 * Decide which registered channels should receive one shared entry.
 *
 * Wake eligibility is delegated to the existing wake policy so notification
 * delivery and model wake-up cannot drift apart: peer evidence stays readable
 * reference context, explicit messages and handoffs stay actionable.
 */
export function resolveNotificationTargets(entry: Entry, adapters: readonly NotificationAdapterRegistration[], options: ResolveOptions = {}): DeliveryResolution {
  const resolution: DeliveryResolution = { targets: [], skipped: [] };
  const required = options.capability;
  const actionable = actionableWake(entry);
  for (const adapter of adapters) {
    let candidates: readonly AdapterMember[];
    try {
      validateRegistration(adapter);
      candidates = adapter.members;
    } catch {
      // One malformed channel must not stop the others from being notified.
      resolution.skipped.push({ adapterId: adapter?.id ?? '(unnamed)', memberId: null, reason: 'invalid-registration' });
      continue;
    }
    if (!actionable) {
      resolution.skipped.push({ adapterId: adapter.id, memberId: null, reason: 'reference-only' });
      continue;
    }
    if (!adapter.enabled) {
      resolution.skipped.push({ adapterId: adapter.id, memberId: null, reason: 'disabled' });
      continue;
    }
    if (required !== undefined && !adapter.capabilities.includes(required)) {
      resolution.skipped.push({ adapterId: adapter.id, memberId: null, reason: 'no-capability' });
      continue;
    }
    for (const member of candidates) {
      if (member.memberId === entry.agentId) {
        resolution.skipped.push({ adapterId: adapter.id, memberId: member.memberId, reason: 'self-authored' });
        continue;
      }
      const scope = memberAccepts(member, entry);
      if (scope === 'out-of-scope') {
        resolution.skipped.push({ adapterId: adapter.id, memberId: member.memberId, reason: 'out-of-scope' });
        continue;
      }
      resolution.targets.push({ adapterId: adapter.id, memberId: member.memberId, sessionRef: member.sessionRef });
    }
  }
  return resolution;
}

/** Durable intent recorded before any adapter is asked to deliver. */
export interface DeliveryIntent {
  adapterId: string;
  memberId: string;
  sequence: number;
  entryIds: readonly number[];
  createdAt: string;
}

export interface AdapterReceipt {
  sequence: number;
  consumed: boolean;
}

export type DeliveryState =
  | { state: 'delivered'; sequence: number }
  | { state: 'pending'; sequence: number }
  | { state: 'unknown'; sequence: number; reason: 'unconfirmed' | 'stale-receipt' };

/**
 * Reconcile a recorded intent with what the adapter actually confirmed.
 *
 * Only an explicit, in-order consumption receipt advances the watermark.
 * Anything else is `unknown`, which callers must reconcile with the adapter —
 * never re-send. This mirrors UncertainDelivery in the execution seam.
 */
export function reconcileDelivery(intent: DeliveryIntent, receipt: AdapterReceipt | null | undefined): DeliveryState {
  if (!receipt) return { state: 'pending', sequence: intent.sequence };
  if (!Number.isSafeInteger(receipt.sequence)) return { state: 'unknown', sequence: intent.sequence, reason: 'unconfirmed' };
  if (receipt.sequence < intent.sequence) return { state: 'unknown', sequence: intent.sequence, reason: 'stale-receipt' };
  if (receipt.sequence > intent.sequence) return { state: 'unknown', sequence: intent.sequence, reason: 'unconfirmed' };
  if (!receipt.consumed) return { state: 'unknown', sequence: intent.sequence, reason: 'unconfirmed' };
  return { state: 'delivered', sequence: intent.sequence };
}

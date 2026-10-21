// Vendor-isolated turn driver for per-session checks (anti-corruption layer).
//
// The core publishes a directed SESSION_TASK_CHECK and records delivery state; this
// module decides, for one pending check, whether the original session may be asked to
// work — and it never guesses. It owns no timer, starts no process and knows nothing
// about identities, credentials or ledgers: the trusted host injects three ports.
//
// Safety rules (each is covered by a synthetic test):
//  1. a busy session is left alone (the check stays pending; the next scan retries);
//  2. before submitting, the session must still be the one the check was addressed to;
//  3. a durable intent is written BEFORE submitting, so a crash cannot lose the attempt;
//  4. an inconclusive submission keeps the intent and is never replayed blindly;
//  5. an authoritative completion whose receipt failed only retries the receipt;
//  6. the idempotency key is (memberId, sessionRef, dueAt).

/**
 * A check carries the identity of the delivery it belongs to. Receipts are settled per
 * DELIVERY (one immutable `sequence` plus the exact `entryIds` echoed back), never per
 * check: a batch can grow by later merges, and confirming a single check would settle
 * entries that were never consumed (p2 7132).
 */
export interface DeliveryRef {
  sequence: number;
  entryIds: readonly number[];
}

export interface PendingCheck {
  memberId: string;
  sessionRef: string;
  dueAt: number;
  goalIds: readonly string[];
  adapterId?: string;
  registrationVersion?: number;
  delivery?: DeliveryRef;
}

/**
 * `enqueued` only means the official session accepted the prompt into its durable queue.
 * Per docs/harness-adapters.md an accepted prompt is NOT a model result: the delivery is
 * settled only when the host observes authoritative turn completion for that same delivery.
 */
export type SubmitOutcome =
  | { status: 'enqueued'; detail?: string }
  | { status: 'completed'; turnId: string; detail?: string }
  | { status: 'unknown'; detail?: string }
  | { status: 'rejected'; detail?: string };

export type DeliverySettlement = { settled: true } | { settled: false; detail?: string };

export interface PendingPort {
  list(): Promise<readonly PendingCheck[]>;
  /** Settle one delivery: the exact immutable sequence and the full entryIds snapshot. */
  confirm(delivery: DeliveryRef, check: PendingCheck): Promise<void>;
  release(check: PendingCheck, reason: 'stale-session' | 'rejected' | 'scope-empty' | 'stale-delivery-view'): Promise<void>;
}

export interface SessionPort {
  isCurrent(check: PendingCheck): Promise<boolean>;
  isBusy(check: PendingCheck): Promise<boolean>;
  submit(check: PendingCheck, text: string): Promise<SubmitOutcome>;
  /** Authoritative completion check for a turn submitted for this delivery. */
  settlement(check: PendingCheck, turnId: string): Promise<DeliverySettlement>;
}

export type IntentState = 'submitting' | 'unknown' | 'enqueued' | 'completedUnacked' | 'acceptedUnacked';

export interface Intent {
  key: string;
  state: IntentState;
  check: PendingCheck;
  detail?: string;
}

export interface Journal {
  get(key: string): Promise<Intent | undefined>;
  put(intent: Intent): Promise<void>;
  del(key: string): Promise<void>;
}

export interface DriveOptions {
  /** Rendered instruction for one check. Kept injectable so the wording stays in the adapter. */
  text?: (check: PendingCheck) => string;
}

export interface DriveResult {
  submitted: string[];
  merged: string[];
  skipped: string[];
  rejected: string[];
  unknown: string[];
  receiptPending: string[];
  receiptsConfirmed: string[];
  /** Accepted into the official queue but no authoritative completion seen yet. */
  awaitingCompletion: string[];
}

export const intentKey = (check: Pick<PendingCheck, 'memberId' | 'sessionRef' | 'dueAt'>) =>
  `${check.memberId}|${check.sessionRef}|${check.dueAt}`;


/** A check is addressable only with a real dueAt and at least one scoped goal. */
export const isAddressable = (check: Pick<PendingCheck, 'dueAt' | 'goalIds'>): boolean =>
  Number.isSafeInteger(check.dueAt) && check.dueAt >= 0
  && Array.isArray(check.goalIds) && check.goalIds.length > 0;

export const defaultCheckText = (check: PendingCheck) =>
  'Check your authorized goal list. If any goal is unclaimed, in progress or awaiting review, '
  + 'continue useful work with peers and then look again; blocked and finished goals need nothing.';

/** Drive exactly one pass over the pending checks. Callers own the single-flight guarantee. */
export async function driveOnce(
  ports: { pending: PendingPort; session: SessionPort; journal: Journal },
  options: DriveOptions = {},
): Promise<DriveResult> {
  const result: DriveResult = {
    submitted: [], merged: [], skipped: [], rejected: [], unknown: [],
    receiptPending: [], receiptsConfirmed: [], awaitingCompletion: [],
  };
  const render = options.text ?? defaultCheckText;

  for (const check of await ports.pending.list()) {
    const key = intentKey(check);

    // The envelope the dispatcher parsed must stay a valid idempotency key: a check with
    // no scoped goal, or without a non-negative integer dueAt, must never reach a model
    // turn (p2 7039 / e51d 7137). This is a guard, not a re-parse.
    if (!isAddressable(check)) {
      await ports.pending.release(check, 'scope-empty');
      result.skipped.push(key);
      continue;
    }

    const intent = await ports.journal.get(key);

    // A delivery whose authoritative completion was seen but whose receipt failed: retry
    // ONLY the receipt (idempotent, delivery-scoped) and never run the model again.
    if (intent?.state === 'completedUnacked' || intent?.state === 'acceptedUnacked') {
      // The receipt retry must echo the delivery that was actually submitted. Re-reading
      // the pending list can hand us a batch enlarged by a later merge; settling that
      // would acknowledge entries no model turn ever consumed (p2 7144/7145).
      const original = intent.check;
      if (!original.delivery) { result.receiptPending.push(key); continue; }
      try {
        await ports.pending.confirm(original.delivery, original);
        await ports.journal.del(key);
        result.receiptsConfirmed.push(key);
      } catch {
        result.receiptPending.push(key);
      }
      continue;
    }

    // An inconclusive submission is never replayed; the caller reconciles it out of band.
    if (intent?.state === 'unknown') {
      result.unknown.push(key);
      continue;
    }

    // A prompt already accepted into the official queue is NOT a completed turn: keep the
    // delivery unresolved until the host reports authoritative completion for it.
    if (intent?.state === 'enqueued') {
      const settlement = await ports.session.settlement(check, intent.detail ?? '');
      if (!settlement.settled) {
        result.awaitingCompletion.push(key);
        continue;
      }
      const submitted = intent.check;
      if (!submitted.delivery) { result.receiptPending.push(key); continue; }
      try {
        await ports.pending.confirm(submitted.delivery, submitted);
        await ports.journal.del(key);
        result.receiptsConfirmed.push(key);
      } catch {
        await ports.journal.put({ key, state: 'completedUnacked', check: submitted, detail: intent.detail });
        result.receiptPending.push(key);
      }
      continue;
    }

    // A leftover 'submitting' intent means a crash mid-submit: keep it unknown, never replay.
    if (intent?.state === 'submitting') {
      await ports.journal.put({ ...intent, state: 'unknown' });
      result.unknown.push(key);
      continue;
    }

    if (!(await ports.session.isCurrent(check))) {
      await ports.pending.release(check, 'stale-session');
      result.skipped.push(key);
      continue;
    }

    if (await ports.session.isBusy(check)) {
      result.merged.push(key);
      continue;
    }

    await ports.journal.put({ key, state: 'submitting', check });

    // Committing fence: the durable intent write is asynchronous, so the binding that was
    // current before it may already be gone. Re-check immediately before the side effect;
    // nothing has been sent yet, so the safest action is to drop the intent and skip
    // (p8 7140/7141). A submit port must still verify its own lease atomically.
    if (!(await ports.session.isCurrent(check))) {
      await ports.journal.del(key);
      await ports.pending.release(check, 'stale-session');
      result.skipped.push(key);
      continue;
    }

    let outcome: SubmitOutcome;
    try {
      outcome = await ports.session.submit(check, render(check));
    } catch (error) {
      outcome = { status: 'unknown', detail: String((error as Error)?.message ?? error) };
    }

    if (outcome.status === 'unknown') {
      await ports.journal.put({ key, state: 'unknown', check, detail: outcome.detail });
      result.unknown.push(key);
      continue;
    }
    if (outcome.status === 'rejected') {
      await ports.journal.del(key);
      await ports.pending.release(check, 'rejected');
      result.rejected.push(key);
      continue;
    }

    if (outcome.status === 'enqueued') {
      await ports.journal.put({ key, state: 'enqueued', check, detail: outcome.detail });
      result.awaitingCompletion.push(key);
      continue;
    }

    // Authoritative completion reported with the submission itself.
    result.submitted.push(key);
    await ports.journal.put({ key, state: 'completedUnacked', check, detail: outcome.turnId });
    await settleCompleted(ports, result, key, check, outcome.turnId);
  }

  return result;
}

async function settleCompleted(
  ports: { pending: PendingPort; journal: Journal },
  result: DriveResult,
  key: string,
  check: PendingCheck,
  turnId: string,
): Promise<void> {
  if (!check.delivery) { result.receiptPending.push(key); return; }
  try {
    await ports.pending.confirm(check.delivery, check);
    await ports.journal.del(key);
    result.receiptsConfirmed.push(key);
  } catch {
    await ports.journal.put({ key, state: 'completedUnacked', check, detail: turnId });
    result.receiptPending.push(key);
  }
}
